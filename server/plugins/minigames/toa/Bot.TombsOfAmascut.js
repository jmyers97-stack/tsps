"use strict";

/**
 * Tombs of Amascut raid bot: spawning, the tick that drives every bot, and the bot itself.
 *
 * `::toabot` (developer) spawns a bot at the lobby with the configured stats and gear; it makes
 * its own party, enters, and plays the raid as the state machine says, one room module at a
 * time. `::toabot stop` takes your bots out of the world, `::toabot status` says what each is
 * doing. Settings: pluginConfig "TombsOfAmascut:bot" (BotConfig.TombsOfAmascut.js).
 *
 * One task runs every tick while any bot exists. It first ticks the raids that hold bots, then
 * lets each bot think: so a bot always sees the room as it stands this tick, and the tile it
 * walks to is the one the room checks next tick, as for a player whose client shows the tick.
 * Rooms otherwise tick from their occupants' processing, which an unwatched bot only does every
 * few ticks; and NPCs in regions no client watches aren't processed, so the task keeps the
 * NPCs of a bot's room awake while they have something to do.
 */

const Shared = require("./Shared.TombsOfAmascut");
const Raid = require("./RaidState.TombsOfAmascut");
const Parties = require("./Parties.TombsOfAmascut");
const BotConfig = require("./BotConfig.TombsOfAmascut");
const Machine = require("./BotStateMachine.TombsOfAmascut");
const Senses = require("./BotSenses.TombsOfAmascut");
const { BotBody } = require("./BotBody.TombsOfAmascut");
const { CrondisPlayer } = require("./BotCrondis.TombsOfAmascut");
const { ZebakPlayer } = require("./BotZebak.TombsOfAmascut");

const CONFIG_KEY = "TombsOfAmascut:bot";
const ATTR_BOT = "toa:raid-bot";
const { ATTR_SKIP_PERSISTENCE } = require("../../bots/runtime/PersistenceConstants.PlayerBots");
const NAME_PREFIX = "ToaBot";
const MAX_BOTS = 8;
const LOBBY_ENTRY = { x: 3357, y: 9112, z: 0, id: 46089 };
const LOBBY_REACH = 32;
const NEXUS_EXIT = { x: 3549, y: 5163, z: 0 };
const { STATES } = Machine;

/** The room modules: a puzzle's by its path, a boss's by its path. */
const PUZZLES = { CRONDIS: CrondisPlayer };
const BOSSES = { CRONDIS: ZebakPlayer };

/** Answers the bot gives, by what it is doing: options are matched by their start. */
const ANSWERS = {
  [STATES.LEAVE]: ["Yes, abandon", "Yes."],
  default: ["Yes."],
};

/** Every bot, by its player. */
const bots = new Map();
let api = null;
let task = null;

// ------------------------------------------------------------------ the bot

class ToaBot {
  constructor(player, owner, config) {
    this.player = player;
    this.owner = owner;
    this.config = config;
    this.body = new BotBody(player);
    this.state = null;
    this.reason = null;
    this.startedAt = Date.now();
    this.raidsDone = 0;
    this.deaths = 0;
    this.wasInRaid = false;
    this.wasGhost = false;
    this.stopRequested = false;
    this.stopped = false;
    this.module = null;
    this.moduleRoom = null;
    this.history = [];
  }

  /** A line for the owner (and the server log). */
  say(text) {
    this.history.push({ cycle: Shared.cycle(), text });
    if (this.history.length > 200) this.history.shift();
    if (this.owner?.isRegistered?.()) this.owner.sendMessage(`<col=7f0000>[${this.player.getUsername()}]</col> ${text}`);
    api?.log?.(`[ToaBot ${this.player.getUsername()}] ${text}`);
  }

  observe(view) {
    return {
      ...view,
      stopped: this.stopped,
      stopReason: this.reason,
      raidsDone: this.raidsDone,
      deaths: this.deaths,
      minutesPlayed: (Date.now() - this.startedAt) / 60000,
      outOfSupplies: !this.body.hasFood() || !this.body.hasPrayerRestore(),
      purpleSeen: false,
      stopRequested: this.stopRequested,
    };
  }

  tick() {
    const { player } = this;
    if (!player.isRegistered?.() || this.stopped && this.state === STATES.STOPPED) return;
    if (!this.dressed) {
      // Once in the world: equipping needs a player who is alive there.
      this.dressed = true;
      const { missing, unworn } = outfit(player, this.config);
      if (missing.length) this.say(`no such item, skipped: ${missing.join(", ")}`);
      if (unworn.length) this.say(`couldn't wear: ${unworn.join(", ")}`);
    }
    const view = Senses.raidView(player);
    this.count(view);
    const verdict = Machine.decide(this.observe(view), this.config);
    if (verdict.state !== this.state || verdict.path !== this.path) {
      this.say(describe(verdict));
      this.state = verdict.state;
      this.path = verdict.path;
      if (verdict.state === STATES.STOPPED) {
        this.stopped = true;
        this.reason = verdict.reason;
        this.body.halt();
        this.body.allPrayersOff();
        return;
      }
    }
    if (verdict.reason) this.reason = verdict.reason;
    if (player.getHitpoints() <= 0) return;
    this.survive(verdict.state);
    if (this.answerDialogue(verdict.state)) return;
    this.act(verdict, view);
  }

  /** Raids finished, and deaths, from what the bot sees happen to it. */
  count(view) {
    if (this.wasInRaid && !view.inRaid) {
      this.raidsDone++;
      this.module = null;
      this.moduleRoom = null;
    }
    if (view.ghost && !this.wasGhost) this.deaths++;
    this.wasInRaid = view.inRaid;
    this.wasGhost = view.ghost;
  }

  /** Eats and drinks between and during rooms, as the config says. */
  survive(state) {
    const self = Senses.selfView(this.player);
    if (self.hitpoints < self.maxHitpoints * this.config.eatBelow) this.body.eat();
    const praying = state === STATES.BOSS || state === STATES.WARDENS;
    if (praying && self.prayer < Math.min(this.config.restorePrayerBelow, self.maxPrayer)) this.body.restorePrayer();
  }

  /** An open chatbox gets answered before anything else, as a player would. */
  answerDialogue(state) {
    const open = this.body.dialogue();
    if (!open) return false;
    if (open.kind === "action") return false;
    const answer = this.body.answer(ANSWERS[state] ?? ANSWERS.default, { fallback: () => -1 });
    if (answer === null) this.body.dismiss();
    return true;
  }

  act(verdict, view) {
    switch (verdict.state) {
      case STATES.LOBBY:
        return this.lobby();
      case STATES.NEXUS:
        return this.nexus(verdict.path);
      case STATES.PUZZLE:
        return this.playRoom(PUZZLES[verdict.path], view);
      case STATES.BOSS:
        return this.playRoom(BOSSES[verdict.path], view);
      case STATES.PROCEED:
        return this.proceed();
      case STATES.RETURN:
        return this.returnToNexus(view);
      case STATES.LEAVE:
        return this.leave(view);
      default:
        return undefined;
    }
  }

  // ---------------------------------------------------------------- states

  /** Makes a party with the configured invocations and goes in. */
  lobby() {
    const { player, body } = this;
    // Just out of a raid, the bot is still on its way back to the lobby.
    if (Senses.chebyshev(body.here(), LOBBY_ENTRY) > LOBBY_REACH) return;
    let party = Parties.currentParty(player);
    if (!party) {
      party = Parties.createParty(player);
      if (!party) return;
      party.settings.clear?.();
      for (const key of this.config.invocations) {
        const refusal = party.settings.toggle(key);
        if (refusal) this.say(`couldn't take ${key}: ${String(refusal).replace(/<[^>]+>/g, "")}`);
      }
      this.say(`made a party at raid level ${party.settings.raidLevel}`);
    }
    const entry = Senses.locAt(player, LOBBY_ENTRY.x, LOBBY_ENTRY.y, LOBBY_ENTRY.z);
    if (entry) body.clickObject(entry, "Enter");
  }

  nexus(path) {
    const name = Shared.PATH_BY_KEY[path]?.name;
    const entrance = Shared.PATH_BY_KEY[path]?.entrance;
    if (!name) return;
    const object = Senses.locAt(this.player, entrance.x, entrance.y, 0)
      ?? Senses.findObject(this.player, `Path of ${name}`, this.body.here(), 24);
    this.body.clickObject(object, "Enter");
  }

  /** Runs the room's module, made afresh for each room the bot enters. */
  playRoom(Module, view) {
    const room = view.roomObject;
    if (!Module || !room) return;
    if (this.moduleRoom !== room) {
      this.module = new Module(this);
      this.moduleRoom = room;
    }
    const doing = this.module.tick({ room, view });
    if (doing && doing !== this.doing) {
      this.doing = doing;
      this.say(doing);
    }
  }

  /** A finished puzzle's Entry, on to its boss. */
  proceed() {
    this.body.allPrayersOff();
    const entry = Senses.findObject(this.player, "Entry", this.body.here(), 48);
    if (entry) this.body.clickObject(entry, "Enter");
  }

  /** Osmumten takes the bot back to the Nexus once the boss is down. */
  returnToNexus(view) {
    this.body.allPrayersOff();
    const osmumten = Senses.roomNpcs(view.roomObject).find((npc) => npc.npc.getDefinition?.()?.getName?.() === "Osmumten");
    if (osmumten) this.body.clickNpc(osmumten.npc, "Talk-to");
  }

  /** Out through the Nexus exit, abandoning the raid; from any other room, back to the Nexus first. */
  leave(view) {
    this.body.allPrayersOff();
    if (view.roomKey === "MAIN_HALL") {
      const exit = Senses.locAt(this.player, NEXUS_EXIT.x, NEXUS_EXIT.y, NEXUS_EXIT.z)
        ?? Senses.findObject(this.player, "Exit", this.body.here(), 24);
      const { ObjectDefinition } = Shared.core();
      const option = exit ? ObjectDefinition.forPlayer(exit.getId(), this.player)?.getInteractions?.()?.find(Boolean) : null;
      if (option) this.body.clickObject(exit, option);
      return;
    }
    const osmumten = Senses.roomNpcs(view.roomObject).find((npc) => npc.npc.getDefinition?.()?.getName?.() === "Osmumten");
    if (osmumten) {
      this.body.clickNpc(osmumten.npc, "Talk-to");
      return;
    }
    const exit = Senses.findObject(this.player, "Exit", this.body.here(), 48);
    const { ObjectDefinition } = Shared.core();
    const option = exit ? ObjectDefinition.forPlayer(exit.getId(), this.player)?.getInteractions?.()?.find(Boolean) : null;
    if (option) this.body.clickObject(exit, option);
  }
}

function describe(verdict) {
  const what = {
    LOBBY: "in the lobby: making a party",
    NEXUS: `in the Nexus: off to the Path of ${Shared.PATH_BY_KEY[verdict.path]?.name ?? verdict.path}`,
    PUZZLE: "at the puzzle",
    PROCEED: "puzzle done: on to the boss",
    BOSS: "at the boss",
    RETURN: "boss down: back to the Nexus",
    WARDENS: "at the Wardens",
    LOOT: "at the chest",
    DEAD: "dead: waiting to be revived",
    LEAVE: "leaving the raid",
    STOPPED: "stopped",
  }[verdict.state] ?? verdict.state;
  return verdict.reason ? `${what} (${verdict.reason})` : what;
}

// ------------------------------------------------------------------ the tick

/** Ticks the raids holding bots, then the bots. */
function tickBots() {
  const { World } = Shared.core();
  const raids = new Map();
  for (const [player, bot] of bots) {
    if (!player.isRegistered?.() && bot.registeredOnce) {
      bots.delete(player);
      continue;
    }
    if (player.isRegistered?.()) bot.registeredOnce = true;
    const raid = Raid.raidOf(player);
    if (!raid) continue;
    if (!raids.has(raid)) raids.set(raid, new Set());
    raids.get(raid).add(player);
  }
  for (const [raid, members] of raids) {
    raid.__toaBots = members;
    raid.processOnce();
    for (const player of members) {
      const room = raid.roomFor(player);
      for (const npc of room?.npcs ?? []) World.markNpcCombatActive(npc, true);
    }
  }
  for (const bot of [...bots.values()]) {
    try {
      bot.tick();
    } catch (error) {
      bot.say(`hit an error and stopped: ${error.message}`);
      console.error("[ToaBot]", error);
      bot.stopped = true;
      bot.state = STATES.STOPPED;
    }
  }
  if (bots.size === 0 && task) {
    task.stop();
    task = null;
  }
}

function ensureTask() {
  if (task) return;
  const { Task, TaskManager } = Shared.core();
  class ToaBotTask extends Task {
    constructor() {
      super(1, "toa-raid-bots", false);
    }

    execute() {
      tickBots();
    }
  }
  task = new ToaBotTask();
  TaskManager.submit(task);
}

// ------------------------------------------------------------------ spawning

/** The configured settings, with `overrides` (from the command) over them. */
function settings(overrides = {}) {
  const raw = api?.getPluginConfig?.(CONFIG_KEY, {}) ?? {};
  const merged = { ...(raw && typeof raw === "object" ? raw : {}), ...overrides };
  if (overrides.stop) merged.stop = { ...(raw?.stop ?? {}), ...overrides.stop };
  return BotConfig.normalize(merged);
}

/** An item id by its name as the cache spells it ("Prayer potion(4)" is PRAYER_POTION_4_). */
function itemId(name) {
  const { ItemIdentifiers } = Shared.core();
  const key = name.toUpperCase().replace(/'/g, "").replace(/[^A-Z0-9]+/g, "_");
  const id = Number(ItemIdentifiers[key]);
  return Number.isInteger(id) && id > 0 ? id : -1;
}

/** Stats and gear for a spawned bot: every skill at `statLevel`, then the gear worn and packed. */
function outfit(player, config) {
  const { Skill, SkillManager, BonusManager, WeaponInterfaceManager, EquipPacketListener, Inventory } = Shared.core();
  const missing = [];
  const unworn = [];
  if (config.statLevel > 0) {
    const skills = player.getSkillManager();
    for (const skill of Skill.values()) {
      const level = Math.max(skill === Skill.HITPOINTS ? 10 : 1, config.statLevel);
      skills.setMaxLevels(skill, level, false).setCurrentLevel(skill, level, false);
      if (SkillManager?.getExperienceForLevel) skills.setExperiences?.(skill, SkillManager.getExperienceForLevel(level), false);
    }
    player.setHitpoints?.(skills.getMaxLevel(Skill.HITPOINTS));
  }
  const inventory = player.getInventory();
  for (const entry of config.gear.equipment) {
    const id = itemId(entry.name);
    if (id < 0) {
      missing.push(entry.name);
      continue;
    }
    inventory.adds(id, entry.amount);
    const slot = inventory.getSlotForItemId(id);
    if (slot >= 0) EquipPacketListener.equip(player, id, slot, Inventory.INTERFACE_ID);
    if (inventory.contains(id)) unworn.push(entry.name);
  }
  for (const entry of config.gear.inventory) {
    const id = itemId(entry.name);
    if (id < 0) {
      missing.push(entry.name);
      continue;
    }
    const stackable = Shared.core().ItemDefinition.forId(id)?.isStackable?.();
    if (stackable) inventory.adds(id, entry.amount);
    else for (let n = 0; n < entry.amount && inventory.getFreeSlots() > 0; n++) inventory.adds(id, 1);
  }
  BonusManager.update(player);
  WeaponInterfaceManager?.assign?.(player);
  return { missing, unworn };
}

function freeName() {
  const { World } = Shared.core();
  for (let n = 1; n <= 99; n++) {
    const name = `${NAME_PREFIX}${n}`;
    const taken = World.getPlayerByName(name) || World.getAddPlayerQueue().some((queued) => queued?.getUsername?.() === name);
    if (!taken) return name;
  }
  return null;
}

/** Spawns one bot at the lobby for `owner` (who hears what it does). Returns the ToaBot, or an error. */
function spawnBot(owner, overrides = {}) {
  if (!api) return { error: "the bot isn't set up yet" };
  if (bots.size >= MAX_BOTS) return { error: `there are already ${MAX_BOTS} raid bots` };
  const { config, notes } = settings(overrides);
  const name = freeName();
  if (!name) return { error: "no free bot name" };
  const { createBotPlayer } = require("../../bots/behaviours/spawn/PlayerFactory.PlayerBots");
  const player = createBotPlayer(name, Shared.loc(Shared.LOBBY_RETURN), { api, loadPersistence: false, saveRandomizedAppearance: false });
  if (!player) return { error: `couldn't create ${name}` };
  player.setPlayerBot(true);
  player.setAttribute(ATTR_SKIP_PERSISTENCE, true);
  player.setAttribute(ATTR_BOT, true);
  const bot = new ToaBot(player, owner, config);
  bots.set(player, bot);
  ensureTask();
  for (const note of notes) bot.say(`config: ${note}`);
  return { bot };
}

/** Takes a bot out of the world (a raid sees it log out, as for any player). */
function removeBot(bot) {
  bots.delete(bot.player);
  bot.player.requestLogout?.();
}

// ------------------------------------------------------------------ the command

/** `::toabot [raids] [path ...]`, `::toabot stop`, `::toabot status`. */
function command({ player, parts }) {
  const args = (parts ?? []).slice(1).map((part) => String(part).toLowerCase());
  const mine = [...bots.values()].filter((bot) => bot.owner === player);
  if (args[0] === "stop") {
    for (const bot of mine) removeBot(bot);
    player.sendMessage(mine.length ? `Removed ${mine.length} raid bot${mine.length === 1 ? "" : "s"}.` : "You have no raid bots.");
    return true;
  }
  if (args[0] === "status") {
    if (!mine.length) player.sendMessage("You have no raid bots.");
    for (const bot of mine) {
      const last = bot.history[bot.history.length - 1]?.text ?? "starting";
      player.sendMessage(`${bot.player.getUsername()}: ${bot.state ?? "starting"}, ${bot.raidsDone} raid(s), ${bot.deaths} death(s). ${last}`);
    }
    return true;
  }
  const overrides = {};
  const raids = args.find((arg) => /^\d+$/.test(arg));
  if (raids !== undefined) overrides.stop = { maxRaids: Number(raids) };
  const paths = args.filter((arg) => BotConfig.PATH_KEYS.includes(arg.toUpperCase())).map((arg) => arg.toUpperCase());
  if (paths.length) overrides.pathOrder = paths;
  const result = spawnBot(player, overrides);
  if (result.error) player.sendMessage(`Couldn't spawn a raid bot: ${result.error}.`);
  else player.sendMessage(`Spawned ${result.bot.player.getUsername()} at the Tombs of Amascut lobby. ::toabot stop removes it.`);
  return true;
}

function register(pluginApi) {
  api = pluginApi;
  api.onProjectileLaunched?.(Senses.recordProjectile);
  api.registerCommand("toabot", command, api.core.PlayerRights.DEVELOPER, "Spawn a Tombs of Amascut raid bot (::toabot stop, ::toabot status)");
}

module.exports = register;
Object.assign(module.exports, {
  CONFIG_KEY,
  ToaBot,
  spawnBot,
  removeBot,
  tickBots,
  itemId,
  outfit,
  bots,
});
