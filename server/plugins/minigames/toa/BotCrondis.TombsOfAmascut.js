"use strict";

const Shared = require("./Shared.TombsOfAmascut");
const Senses = require("./BotSenses.TombsOfAmascut");
const Planner = require("./BotPlanner.TombsOfAmascut");

/**
 * Tombs of Amascut raid bot: the Path of Crondis puzzle (Test of Resourcefulness).
 *
 * The job: take a water container, fill it at a waterfall at the end of a trapped corridor, carry
 * it back and water the Palm of Resourcefulness, until the palm is grown. Wiki (Tombs of Amascut/
 * Strategies, Path of Crondis): avoid the spear statues and acid trails, since a hit spills half
 * the water; keep the crocodiles off the palm.
 *
 * What the bot knows, as a player learns it:
 * - Spears: each of the 20 statues along a corridor fires on its own beat of a 10 tick cycle
 *   counted from "Challenge started", and a spear sweeps its whole row (the corridor's 5 tiles)
 *   for 3 ticks. A player learns the beats by watching; the bot carries them.
 * - Acid: an orb appears at a corridor's mouth and its cloud runs 10 tiles down the corridor,
 *   one tile per third of a tick after a 4 tick wind-up. The bot sees the orb (a loc) the tick it
 *   lands, and so knows when each tile of that column is dangerous.
 * - Crocodiles: NPCs it can see; it keeps a tile away from them while carrying water.
 *
 * The planner searches tiles and ticks together (where can I be at each tick without a trap
 * catching me) and returns the next tile on the earliest safe route to the goal. It re-plans
 * every tick, so a new acid trail just changes the route.
 *
 * Order within a tick: the room checks traps against where players stood at the end of the last
 * tick, before anyone moves. So the tile the bot moves to at tick t is checked at tick t + 1.
 */

const SPEAR_CYCLE = 10;
/** Corridor rows: the west statue's x and the first row's y. Rows alternate west and east statues. */
const SPEAR_ROWS = [{ x: 3925, y: 5293 }, { x: 3939, y: 5293 }, { x: 3925, y: 5258 }, { x: 3939, y: 5258 }];
/** Each statue's beat in the cycle: five west then five east, south to north (as the spears fire). */
const SPEAR_PHASES = [[3, 5, 7, 9, 1, 3, 5, 7, 9, 1], [5, 8, 1, 4, 7, 5, 8, 1, 4, 7], [5, 4, 4, 3, 3, 5, 5, 4, 4, 3], [4, 5, 6, 7, 8, 8, 7, 6, 5, 4]];
/** A spear is out (and hurts) this many ticks after its statue's beat. */
const SPEAR_OUT = [4, 5, 6];
const SPEAR_REACH = { FROM: 2, TO: 6 };

/** Acid: a cloud reaches `along` tiles down the corridor HIT_BASE + floor(along / 3) ticks after its orb. */
const ACID = { HIT_BASE: 4, TILES: 10, TILES_PER_TICK: 3, ORB: 45403 };
/** The orbs' rows: the north corridors' clouds run south, the south ones' north. */
const ACID_ROWS = { NORTH: 5303, SOUTH: 5257 };

const PALM_TILE = { x: 3934, y: 5278 };
const PALM_SIZE = 5;
const CONTAINER = 27295;
const WATERFALL = { FULL: 45398, EMPTY: 45399 };
/**
 * The waterfalls (7 x 5 locs) by the tile of their south-west corner, and the row of tiles along
 * their open side to fill from (the statues stand on that row too, so not every tile of it).
 */
const WATERFALLS = [
  { x: 3926, y: 5250, row: 5255 },
  { x: 3940, y: 5250, row: 5255 },
  { x: 3926, y: 5306, row: 5305 },
  { x: 3940, y: 5306, row: 5305 },
];
const WATERFALL_WIDTH = 7;
const FLOOR = { minX: 3923, maxX: 3949, minY: 5250, maxY: 5311 };
/** Crocodiles go for anyone carrying water within 3 tiles of them (Wiki); keep that far off. */
const CROCODILE_KEEP_AWAY = 3;
const PLAN_HORIZON_TICKS = 40;

// ------------------------------------------------------------------ hazards

/** Ticks into the challenge (since "Challenge started") at which the room tick at `cycle` runs. */
function phaseOf(cycle, startCycle) {
  return ((cycle - startCycle) % SPEAR_CYCLE + SPEAR_CYCLE) % SPEAR_CYCLE;
}

/** Would a spear catch a player standing on (x, y) at the room tick of challenge phase `phase`? */
function spearAt(phase, x, y) {
  for (let index = 0; index < SPEAR_ROWS.length; index++) {
    const row = SPEAR_ROWS[index];
    if (x < row.x + SPEAR_REACH.FROM || x > row.x + SPEAR_REACH.TO) continue;
    const offset = y - row.y;
    if (offset < 0 || offset > 9) continue;
    const east = offset % 2 === 1;
    const statue = Math.floor(offset / 2) + (east ? 5 : 0);
    const since = (phase - SPEAR_PHASES[index][statue] + SPEAR_CYCLE) % SPEAR_CYCLE;
    if (SPEAR_OUT.includes(since)) return true;
  }
  return false;
}

/** Would one of the seen acid `trails` ({ x, y, north, born }) catch a player on (x, y) at `cycle`? */
function acidAt(trails, cycle, x, y) {
  for (const trail of trails) {
    if (trail.x !== x) continue;
    const along = trail.north ? y - trail.y : trail.y - y;
    if (along < 1 || along > ACID.TILES) continue;
    if (cycle - trail.born === ACID.HIT_BASE + Math.floor(along / ACID.TILES_PER_TICK)) return true;
  }
  return false;
}

/** An acid trail from an orb seen at (x, y) on `cycle`: the north corridors' run south. */
function trailFromOrb(x, y, cycle) {
  return { x, y, north: y === ACID_ROWS.SOUTH, born: cycle };
}

function hazardAt(model, cycle, x, y) {
  return spearAt(phaseOf(cycle, model.startCycle), x, y) || acidAt(model.trails, cycle, x, y);
}

// ------------------------------------------------------------------ planning

/** A king's step that doesn't cut a blocked corner, on a map of walkable tiles (the tests' floor). */
function canStep(walkable, x, y, dx, dy) {
  return Planner.gridStep(walkable)(x, y, dx, dy);
}

/**
 * The next tile on the earliest route from `from` to any tile `isGoal` accepts, where no tile the
 * bot ends a tick on is caught by a spear or acid the tick after (BotPlanner).
 *
 * model: { startCycle, trails, step(x, y, dx, dy) or walkable(x, y), avoid(x, y) }.
 * Returns { next, eta, path } (path: one tile per tick, `from` first), or null.
 */
function planStep(model, from, isGoal, now, options = {}) {
  return Planner.plan({
    hazard: (cycle, x, y) => hazardAt(model, cycle, x, y),
    step: model.step ?? Planner.gridStep(model.walkable),
    inBounds: inFloor,
    avoid: model.avoid ?? null,
  }, from, isGoal, now, { horizon: PLAN_HORIZON_TICKS, ...options });
}

/** Inside the puzzle's floor, and not on a loc the floor check knows. */
function inFloor(x, y) {
  return x >= FLOOR.minX && x <= FLOOR.maxX && y >= FLOOR.minY && y <= FLOOR.maxY;
}

/** The waterfall to use: a full one, nearest by straight distance; null while all are dry. */
function chooseWaterfall(from, fullWaterfalls) {
  const ranked = WATERFALLS.filter((fall) => fullWaterfalls.some((full) => full.x === fall.x && full.y === fall.y))
    .sort((a, b) => distance(from, fillTile(a)) - distance(from, fillTile(b)));
  return ranked[0] ?? null;
}

/** The middle of a waterfall's fill row, to rank waterfalls by. */
function fillTile(fall) {
  return { x: fall.x + Math.floor(WATERFALL_WIDTH / 2), y: fall.row };
}

/** Can the bot fill at `fall` from (x, y)? On its fill row, under it. */
function atWaterfall(fall, x, y) {
  return y === fall.row && x >= fall.x && x < fall.x + WATERFALL_WIDTH;
}

/** Beside the palm's 5 x 5 footprint along a side (its Water option's reach). */
function besidePalm(x, y) {
  const minX = PALM_TILE.x;
  const maxX = PALM_TILE.x + PALM_SIZE - 1;
  const minY = PALM_TILE.y;
  const maxY = PALM_TILE.y + PALM_SIZE - 1;
  const alongX = x >= minX && x <= maxX;
  const alongY = y >= minY && y <= maxY;
  return (alongX && (y === minY - 1 || y === maxY + 1)) || (alongY && (x === minX - 1 || x === maxX + 1));
}

function distance(a, b) {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

/** Crocodiles' footprints plus a tile around them, as tiles to keep off while carrying water. */
function crocodileAvoidance(crocodiles) {
  return (x, y) => crocodiles.some((croc) => x >= croc.x - CROCODILE_KEEP_AWAY && x < croc.x + croc.size + CROCODILE_KEEP_AWAY
    && y >= croc.y - CROCODILE_KEEP_AWAY && y < croc.y + croc.size + CROCODILE_KEEP_AWAY);
}

// ------------------------------------------------------------------ playing

/** How long after it lands an orb's trail can still hurt: its last tile's tick. */
const TRAIL_LIFE = ACID.HIT_BASE + Math.floor(ACID.TILES / ACID.TILES_PER_TICK);
const CROCODILE_NAME = "Crocodile";
const BARRIER_EAST = { x: 3950, y: 5280 };

/**
 * Plays the puzzle for one bot: `tick(view)` once a game tick, after the room has ticked.
 * view: { room } where room is the bot's CrondisPuzzleRoom.
 */
class CrondisPlayer {
  constructor(bot) {
    this.bot = bot;
    this.trails = [];
    this.seenOrbs = new WeakSet();
    this.fall = null;
  }

  get player() {
    return this.bot.player;
  }

  get body() {
    return this.bot.body;
  }

  /** Remembers the trail of each orb the tick it lands: a new orb is a new loc on its tile. */
  watchAcid(room, now) {
    this.trails = this.trails.filter((trail) => now - trail.born <= TRAIL_LIFE);
    for (const orb of Senses.roomObjects(room, ACID.ORB)) {
      if (this.seenOrbs.has(orb.object)) continue;
      this.seenOrbs.add(orb.object);
      this.trails.push(trailFromOrb(orb.x, orb.y, now));
    }
  }

  /** The full waterfalls, as the bot sees them (an empty one is a different loc). */
  fullWaterfalls() {
    return WATERFALLS.filter((fall) => Senses.locAt(this.player, fall.x, fall.y, 0)?.getId() === WATERFALL.FULL);
  }

  crocodiles(room) {
    return Senses.roomNpcs(room).filter((npc) => !npc.dead && npc.npc.getDefinition?.()?.getName?.() === CROCODILE_NAME);
  }

  /** The model of the room the planner works with. */
  model(room, avoid) {
    const { RegionManager } = Shared.core();
    const area = room.area;
    return {
      startCycle: room.startCycle,
      trails: this.trails,
      step: (x, y, dx, dy) => RegionManager.canMove(x, y, x + dx, y + dy, 0, 1, 1, area),
      avoid,
    };
  }

  /** Moves one tick along the safest earliest route to a tile `isGoal` accepts; true once on one. */
  goTowards(room, isGoal, avoid = null) {
    const here = this.body.here();
    const now = Shared.cycle();
    const running = this.player.isRunningReturn?.() && this.player.getRunEnergy() > 0;
    const options = { maxSteps: running ? 2 : 1 };
    let plan = avoid ? planStep(this.model(room, avoid), here, isGoal, now, options) : null;
    if (!plan) plan = planStep(this.model(room, null), here, isGoal, now, options);
    if (!plan) {
      // No safe way there within the horizon: stand still unless that is caught too.
      const stay = planStep(this.model(room, null), here, () => true, now, options);
      if (stay && (stay.next.x !== here.x || stay.next.y !== here.y)) this.body.stepTo(stay.next.x, stay.next.y);
      else this.body.halt();
      return false;
    }
    if (plan.eta === 0) return true;
    if (plan.next.x === here.x && plan.next.y === here.y) this.body.halt();
    else this.body.stepTo(plan.next.x, plan.next.y);
    return false;
  }

  /**
   * The waterfall to fill at: of the full ones, the one with the quickest way there and back to
   * the palm (a corridor's spears can make one way much slower than the other). Kept until it
   * runs dry or the bot fills up.
   */
  pickWaterfall(room) {
    const full = this.fullWaterfalls();
    if (this.fall && full.includes(this.fall)) return this.fall;
    const here = this.body.here();
    const now = Shared.cycle();
    const running = this.player.isRunningReturn?.() && this.player.getRunEnergy() > 0;
    const options = { maxSteps: running ? 2 : 1 };
    const model = this.model(room, null);
    let best = null;
    for (const fall of full) {
      const there = planStep(model, here, (x, y) => atWaterfall(fall, x, y), now, options);
      if (!there) continue;
      const at = there.path[there.path.length - 1];
      const back = planStep(model, at, besidePalm, now + there.eta + 1, options);
      const cost = there.eta + (back ? back.eta : PLAN_HORIZON_TICKS * 2);
      if (!best || cost < best.cost) best = { fall, cost };
    }
    this.fall = best?.fall ?? chooseWaterfall(here, full.length ? full : WATERFALLS);
    return this.fall;
  }

  tick({ room }) {
    const { player, body } = this;
    const now = Shared.cycle();
    if (room.isCompleted()) return "done";
    if (!room.isStarted()) {
      const barrier = Senses.locAt(player, BARRIER_EAST.x, BARRIER_EAST.y, 0);
      body.clickObject(barrier, "Pass");
      return "starting";
    }
    body.ensureRunning();
    this.watchAcid(room, now);
    const water = room.waterOf(player); // what the container's Check says
    const inventory = player.getInventory();
    if (!inventory.contains(CONTAINER)) {
      const here = body.here();
      const floor = Senses.groundItems(player, CONTAINER).sort((a, b) => distance(here, posOf(a)) - distance(here, posOf(b)))[0];
      if (floor) body.pickUp(floor);
      return "taking a container";
    }
    const crocodiles = this.crocodiles(room);
    if (water <= 0) {
      // Empty-handed, nothing wants the bot: shoot a crocodile drinking from the palm, from where it
      // stands in the middle of the room (chasing one could walk it into the traps).
      const here = body.here();
      const range = Shared.core().CombatFactory.getMethod(player)?.attackDistance?.(player) ?? 7;
      const drinking = crocodiles.find((croc) => nearPalm(croc) && distanceToNpc(here, croc) <= range);
      if (drinking && room.watered > 0 && inMiddle(here.x, here.y)) {
        body.attack(drinking.npc);
        return "shooting a crocodile";
      }
      body.stopAttacking();
      const fall = this.pickWaterfall(room);
      if (this.goTowards(room, (x, y) => atWaterfall(fall, x, y))) {
        body.clickObject(Senses.locAt(player, fall.x, fall.y, 0), "Fill");
      }
      return "fetching water";
    }
    body.stopAttacking();
    this.fall = null;
    const avoid = crocodiles.length ? crocodileAvoidance(crocodiles) : null;
    if (this.goTowards(room, besidePalm, avoid)) body.clickNpc(room.palm, "Water");
    return "carrying water";
  }
}

function posOf(groundItem) {
  const at = groundItem.getPosition();
  return { x: at.getX(), y: at.getY() };
}

/** Within the spear corridors' rows (where the traps are). */
function inCorridor(x, y) {
  return SPEAR_ROWS.some((row) => y >= row.y && y <= row.y + 9);
}

/** The open floor between the corridors, around the palm. */
function inMiddle(x, y) {
  return y > SPEAR_ROWS[2].y + 9 && y < SPEAR_ROWS[0].y;
}

function distanceToNpc(tile, npc) {
  const dx = tile.x < npc.x ? npc.x - tile.x : Math.max(0, tile.x - (npc.x + npc.size - 1));
  const dy = tile.y < npc.y ? npc.y - tile.y : Math.max(0, tile.y - (npc.y + npc.size - 1));
  return Math.max(dx, dy);
}

function nearPalm(croc) {
  return croc.x + croc.size >= PALM_TILE.x - 1 && croc.x <= PALM_TILE.x + PALM_SIZE
    && croc.y + croc.size >= PALM_TILE.y - 1 && croc.y <= PALM_TILE.y + PALM_SIZE;
}

module.exports = {
  SPEAR_CYCLE,
  SPEAR_ROWS,
  SPEAR_PHASES,
  ACID,
  ACID_ROWS,
  PALM_TILE,
  PALM_SIZE,
  CONTAINER,
  WATERFALL,
  WATERFALLS,
  FLOOR,
  phaseOf,
  spearAt,
  acidAt,
  trailFromOrb,
  hazardAt,
  canStep,
  planStep,
  inFloor,
  chooseWaterfall,
  atWaterfall,
  besidePalm,
  inCorridor,
  CrondisPlayer,
  crocodileAvoidance,
  distance,
};
