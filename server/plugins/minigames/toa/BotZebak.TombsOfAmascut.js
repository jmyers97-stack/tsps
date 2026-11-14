"use strict";

/**
 * Tombs of Amascut raid bot: Zebak (Jaws of Gluttony), the Path of Crondis boss.
 *
 * What the bot knows, as a player learns it (Wiki: Zebak, and Zebak/Strategies):
 * - The volley: Zebak rears up and sends one projectile high over the island, which bursts into
 *   a fragment for each player. Its colour is its style (magic or ranged); it lands 8 ticks after
 *   it goes up. The bot sees the rising projectile (its id says the style) and prays against it:
 *   "hold" keeps that protection on, "flick" turns it on for the tick before and the tick of the
 *   hit only.
 * - The bite: only reaches a player beside his head; the bot never stands there.
 * - Acid pools: thrown as projectiles, then lie on the floor. The bot knows where each lands from
 *   its projectile and keeps off them.
 * - Waves: rows of water roll across the island a tile a tick, with a gap of a few tiles. The bot
 *   sees the wave NPCs, and so where each row will be on every coming tick and where its gap is;
 *   it waits for a row in the gap's columns and never steps through the water.
 * - The roar: he throws boulders, then screams three times and pushes everyone not sheltered
 *   behind one (the three tiles east of a boulder, in its row). While boulders stand, the bot
 *   waits in a boulder's shelter.
 * - Being washed into the water: climb out by the rock steps.
 *
 * The planner (BotPlanner) does the moving: hazards by tile and tick, a place to stand that stays
 * safe a while, and from there the bot shoots Zebak whenever he is in reach of its weapon.
 */

const Shared = require("./Shared.TombsOfAmascut");
const Senses = require("./BotSenses.TombsOfAmascut");
const Planner = require("./BotPlanner.TombsOfAmascut");

const GROUND = { minX: 3926, maxX: 3942, minY: 5398, maxY: 5418 };
/** Searched tiles: the island and the strip by the barrier the bot comes in from. */
const SEARCH = { minX: 3926, maxX: 3956, minY: 5398, maxY: 5418 };
/** The rising volley, by id, and its style. */
const VOLLEY = { 2176: "magic", 2177: "magic", 2178: "ranged", 2179: "ranged" };
/** The volley's hit lands this many ticks after it goes up (4 rising, 4 for the fragments). */
const VOLLEY_HIT_TICKS = 8;
/** Projectiles that leave an acid pool where they land, a boulder, a jug. */
const POOL_PROJECTILES = new Set([1555, 2194]);
const BOULDER_PROJECTILE = 2172;
const JUG_PROJECTILE = 2173;
const POISON_IDS = [45570, 45571, 45572, 45573, 45574, 45575];
const SHELTER_TILES = 3;
/** A place to stand must stay safe this long (a wave row crosses the island in about 21). */
const DWELL_TICKS = 8;
const PLAN_HORIZON_TICKS = 30;
const ZEBAK_NAMES = new Set(["Zebak"]);
const WAVE_NAMES = new Set(["<col=00ffff>Wave</col>", "<col=00ffff>Bloody Wave</col>"]);
const BOULDER_NAME = "<col=00ffff>Boulder</col>";

// ------------------------------------------------------------------ prayer

/**
 * The protection to have on now. `volleys`: [{ style, hitAt }] seen so far. A volley's hit comes
 * after the bot thinks on its tick, but a player's click on that tick would be too late, so the
 * protection goes up a tick before. Returns "magic", "ranged" or null.
 */
function protectionFor(volleys, now, mode, current = null) {
  const pending = volleys.filter((volley) => volley.hitAt >= now).sort((a, b) => a.hitAt - b.hitAt);
  const next = pending[0] ?? null;
  if (mode === "flick") return next && next.hitAt - now <= 1 ? next.style : null;
  if (next) return next.style;
  // Holding: keep praying against the last style seen.
  const last = volleys.slice().sort((a, b) => b.hitAt - a.hitAt)[0];
  return last?.style ?? current;
}

/** The volleys among `projectiles` (BotSenses' list), as { style, hitAt, key }. */
function volleysFrom(projectiles) {
  return projectiles.filter((projectile) => VOLLEY[projectile.id]).map((projectile) => ({
    style: VOLLEY[projectile.id],
    hitAt: projectile.launchCycle + VOLLEY_HIT_TICKS,
    key: `${projectile.id}@${projectile.launchCycle}`,
  }));
}

// ------------------------------------------------------------------ the island

function onGround(x, y) {
  return x >= GROUND.minX && x <= GROUND.maxX && y >= GROUND.minY && y <= GROUND.maxY;
}

function inSearch(x, y) {
  return x >= SEARCH.minX && x <= SEARCH.maxX && y >= SEARCH.minY && y <= SEARCH.maxY;
}

/** The tiles beside his head that his bite reaches (along a side, not a corner). */
function biteReach(zebak, x, y) {
  if (!zebak) return false;
  const dx = x < zebak.x ? zebak.x - x : Math.max(0, x - (zebak.x + zebak.size - 1));
  const dy = y < zebak.y ? zebak.y - y : Math.max(0, y - (zebak.y + zebak.size - 1));
  return Math.max(dx, dy) <= 1 && !(dx === 1 && dy === 1);
}

/** Chebyshev distance from a tile to his footprint. */
function distanceTo(zebak, x, y) {
  const dx = x < zebak.x ? zebak.x - x : Math.max(0, x - (zebak.x + zebak.size - 1));
  const dy = y < zebak.y ? zebak.y - y : Math.max(0, y - (zebak.y + zebak.size - 1));
  return Math.max(dx, dy);
}

/** The three tiles east of a boulder in its row are out of the roar. */
function sheltered(boulders, x, y) {
  return boulders.some((boulder) => y === boulder.y && x > boulder.x && x <= boulder.x + SHELTER_TILES);
}

/**
 * Wave rows as the bot sees them: each wave NPC's tile now and which way it rolls. Rolls north
 * from the south side and south from the north (a row rises on the side it comes from); once
 * seen moving, by how it moved. Returns rows: { y, step, columns: Set of x the row covers }.
 */
function waveRows(waves) {
  const rows = new Map();
  for (const wave of waves) {
    const key = `${wave.y},${wave.step}`;
    if (!rows.has(key)) rows.set(key, { y: wave.y, step: wave.step, columns: new Set() });
    rows.get(key).columns.add(wave.x);
  }
  return [...rows.values()];
}

/** A row's y on the room tick at `cycle`, from where it stands at `now` (before it moves this tick). */
function rowAt(row, now, cycle) {
  return row.y + row.step * (cycle - now);
}

/**
 * The hazards on the island for the planner. state: { now, zebak, pools: Set "x,y", landing:
 * [{ x, y, at, kind }], rows }.
 */
function zebakModel(state, step) {
  const { now, zebak, pools, landing, rows } = state;
  const hazard = (cycle, x, y) => {
    if (pools.has(`${x},${y}`) || biteReach(zebak, x, y)) return true;
    for (const drop of landing) {
      if (drop.x !== x || drop.y !== y) continue;
      if (drop.kind === "pool" ? cycle >= drop.at : cycle >= drop.at && cycle <= drop.at + 1) return true;
    }
    for (const row of rows) {
      if (row.columns.has(x) && rowAt(row, now, cycle) === y) return true;
    }
    return false;
  };
  // A row can't be passed through: the bot crosses one only by its gap.
  const forbidMove = (from, to, cycle) => rows.some((row) => {
    const before = from.y - rowAt(row, now, cycle - 1);
    const after = to.y - rowAt(row, now, cycle);
    if (before * after >= 0) return false;
    return row.columns.has(from.x) || row.columns.has(to.x);
  });
  return { hazard, forbidMove, step, inBounds: inSearch };
}

// ------------------------------------------------------------------ playing

class ZebakPlayer {
  constructor(bot) {
    this.bot = bot;
    this.volleys = new Map();
    this.waves = new Map();
    this.landing = [];
    this.boosted = false;
  }

  get player() {
    return this.bot.player;
  }

  get body() {
    return this.bot.body;
  }

  /** Volleys, and where acid, jugs and boulders will land, from the projectiles in the room. */
  watchProjectiles(room, now) {
    const projectiles = Senses.projectilesIn(room.area, now);
    for (const volley of volleysFrom(projectiles)) this.volleys.set(volley.key, volley);
    for (const [key, volley] of this.volleys) if (volley.hitAt < now - 2) this.volleys.delete(key);
    this.landing = this.landing.filter((drop) => now - drop.at < (drop.kind === "pool" ? 2 : 3));
    for (const projectile of projectiles) {
      const kind = POOL_PROJECTILES.has(projectile.id) ? "pool" : projectile.id === BOULDER_PROJECTILE ? "boulder"
        : projectile.id === JUG_PROJECTILE ? "jug" : null;
      if (!kind || projectile.landingCycle + 2 < now) continue;
      const { x, y } = projectile.end;
      if (!this.landing.some((drop) => drop.x === x && drop.y === y && drop.kind === kind)) {
        this.landing.push({ x, y, at: projectile.landingCycle, kind });
      }
    }
  }

  /** Tracks each wave NPC's tile across ticks, to know which way it rolls. */
  watchWaves(npcs) {
    const seen = new Set();
    const waves = [];
    for (const view of npcs) {
      if (!WAVE_NAMES.has(view.npc.getDefinition?.()?.getName?.())) continue;
      seen.add(view.npc);
      const before = this.waves.get(view.npc);
      let step = before?.step ?? (view.y < (GROUND.minY + GROUND.maxY) / 2 ? 1 : -1);
      if (before && before.y !== view.y) step = Math.sign(view.y - before.y);
      this.waves.set(view.npc, { y: view.y, step });
      waves.push({ x: view.x, y: view.y, step });
    }
    for (const npc of [...this.waves.keys()]) if (!seen.has(npc)) this.waves.delete(npc);
    return waveRows(waves);
  }

  pray(now) {
    const { body } = this;
    const mode = this.bot.config.prayer.mode;
    const wanted = protectionFor([...this.volleys.values()], now, mode, body.protecting());
    if (wanted !== body.protecting()) body.protect(wanted);
    if (this.bot.config.prayer.offensive) body.offensive(body.attackStyle());
  }

  enter(room) {
    const here = this.body.here();
    const barrier = Senses.findObject(this.player, "Barrier", here, 20);
    if (barrier) {
      this.body.clickObject(barrier, "Pass");
      return;
    }
    const crystal = Senses.findObject(this.player, "Teleport crystal", here, 20);
    if (crystal) this.body.clickObject(crystal, "Use");
  }

  tick({ room }) {
    const { player, body } = this;
    const now = Shared.cycle();
    if (room.isCompleted()) return "done";
    if (!room.isStarted() || !room.inChallenge?.(player)) {
      this.enter(room);
      return "starting the fight";
    }
    if (!this.boosted) {
      body.boost(body.attackStyle());
      this.boosted = true;
    }
    const here = body.here();
    this.watchProjectiles(room, now);
    const npcs = Senses.roomNpcs(room);
    const rows = this.watchWaves(npcs);
    this.pray(now);
    if (!onGround(here.x, here.y) && (here.y < GROUND.minY || here.y > GROUND.maxY)) {
      body.stopAttacking();
      const steps = Senses.findObject(player, "Rock steps", here, 12);
      const { ObjectDefinition } = Shared.core();
      const option = steps ? ObjectDefinition.forPlayer(steps.getId(), player)?.getInteractions?.()?.find(Boolean) : null;
      if (option) body.clickObject(steps, option);
      return "climbing out of the water";
    }
    const zebakView = npcs.find((npc) => ZEBAK_NAMES.has(npc.npc.getDefinition?.()?.getName?.()) && !npc.dead);
    if (!zebakView) return "waiting for Zebak";
    const pools = new Set(Senses.roomObjects(room, POISON_IDS).map((pool) => `${pool.x},${pool.y}`));
    const boulders = npcs.filter((npc) => npc.npc.getDefinition?.()?.getName?.() === BOULDER_NAME && !npc.dead)
      .map((npc) => ({ x: npc.x, y: npc.y }));
    // Boulders on their way count as boulders: shelter is where they will be.
    for (const drop of this.landing) if (drop.kind === "boulder" && !boulders.some((b) => b.x === drop.x && b.y === drop.y)) boulders.push({ x: drop.x, y: drop.y });
    const { RegionManager, CombatFactory } = Shared.core();
    const step = (x, y, dx, dy) => RegionManager.canMove(x, y, x + dx, y + dy, 0, 1, 1, room.area);
    const model = zebakModel({ now, zebak: zebakView, pools, landing: this.landing, rows }, step);
    const range = CombatFactory.getMethod(player)?.attackDistance?.(player) ?? 7;
    const inRange = (x, y) => onGround(x, y) && distanceTo(zebakView, x, y) <= range;
    const shelter = boulders.length > 0;
    const running = player.isRunningReturn?.() && player.getRunEnergy() > 0;
    const options = { maxSteps: running ? 2 : 1, horizon: PLAN_HORIZON_TICKS, dwell: DWELL_TICKS };
    const goals = shelter
      ? [(x, y) => sheltered(boulders, x, y) && inRange(x, y), (x, y) => sheltered(boulders, x, y)]
      : [inRange, onGround];
    let plan = null;
    for (const goal of goals) {
      plan = Planner.plan(model, here, goal, now, options);
      if (plan) break;
    }
    if (!plan) plan = Planner.plan(model, here, onGround, now, { ...options, dwell: 0 });
    const doing = shelter ? "sheltering from the roar" : rows.length ? "dodging the waves" : "fighting Zebak";
    if (!plan || plan.eta === 0) {
      if (inRange(here.x, here.y)) body.attack(zebakView.npc);
      else body.stopAttacking();
      if (!plan) body.halt();
      return doing;
    }
    body.stopAttacking();
    body.stepTo(plan.next.x, plan.next.y);
    return doing;
  }
}

module.exports = {
  GROUND,
  VOLLEY,
  VOLLEY_HIT_TICKS,
  SHELTER_TILES,
  DWELL_TICKS,
  protectionFor,
  volleysFrom,
  onGround,
  biteReach,
  distanceTo,
  sheltered,
  waveRows,
  rowAt,
  zebakModel,
  ZebakPlayer,
};
