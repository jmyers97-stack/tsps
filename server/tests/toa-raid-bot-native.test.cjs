// A Tombs of Amascut raid bot plays a real raid: ::toabot, the lobby, the Nexus, the Path of
// Crondis puzzle and Zebak, then leaves. Run after `yarn build`: node --test tests/toa-raid-bot-native.test.cjs
const assert = require("node:assert/strict");
const path = require("node:path");
const { test } = require("node:test");
require("../dist/Server").Server.installProductionPathResolver();
const { CachePipeline } = require("../dist/game/cache/CachePipeline");
const { PluginManager: PM } = require("../dist/plugins/PluginManager");
const { Player } = require("../dist/game/entity/impl/player/Player");
const { CommandPacketListener } = require("../dist/net/packet/impl/CommandPacketListener");

const MAX_TICKS = 2500;

/** Corridor tiles, and the rows just outside them, for the trap cross-check. */
function probeTiles() {
  const tiles = [];
  for (const xs of [[3927, 3931], [3941, 3945]]) {
    for (const [fromY, toY] of [[5257, 5268], [5292, 5303]]) {
      for (let x = xs[0]; x <= xs[1]; x++) for (let y = fromY; y <= toY; y++) tiles.push({ x, y });
    }
  }
  return tiles;
}

test("a raid bot clears the Path of Crondis and Zebak in Entry mode, then stops", async (t) => {
  const core = PM.getCoreApi();
  const { World, RegionManager, TaskManager, Location, PlayerRights } = core;
  const oldBots = process.env.DISABLE_PLAYER_BOTS, oldSubmit = TaskManager.submit, oldError = console.error;
  const tasks = new Set(), errors = [];
  let started = false;
  let bot = null;
  process.env.DISABLE_PLAYER_BOTS = "1";
  TaskManager.submit = function (task, ...args) { tasks.add(task); return oldSubmit.call(this, task, ...args); };
  console.error = (...args) => { errors.push(args.map(String).join(" ")); oldError(...args); };
  t.after(() => {
    const failures = [], safely = (fn) => { try { fn(); } catch (error) { failures.push(String(error)); } };
    try {
      if (bot?.player.isRegistered()) safely(() => World.getPlayers().removes(bot.player));
      if (started) safely(() => PM.emitServerShutdown({}));
      for (const task of tasks) safely(() => { if (task.isRunning()) task.stop(); });
      safely(() => World.process());
      for (const task of tasks) safely(() => { if (task.isRunning()) task.stop(); });
    } finally {
      TaskManager.submit = oldSubmit; console.error = oldError;
      if (oldBots === undefined) delete process.env.DISABLE_PLAYER_BOTS; else process.env.DISABLE_PLAYER_BOTS = oldBots;
    }
    assert.deepEqual(failures, []);
    assert.deepEqual(errors, []);
  });

  await CachePipeline.initialize(path.resolve(__dirname, ".."));
  PM.loadFromDirectory(path.resolve(__dirname, "../plugins"));
  RegionManager.init();
  PM.emitServerStartup({});
  started = true;

  const Bot = require("../plugins/minigames/toa/Bot.TombsOfAmascut");
  const Raid = require("../plugins/minigames/toa/RaidState.TombsOfAmascut");
  const Shared = require("../plugins/minigames/toa/Shared.TombsOfAmascut");
  const Crondis = require("../plugins/minigames/toa/BotCrondis.TombsOfAmascut");

  // The developer who types the command (not logged in: the command only needs their rank).
  const owner = new Player(null);
  owner.setUsername("ToaBotOwner");
  owner.setRights(PlayerRights.DEVELOPER);
  const told = [];
  owner.sendMessage = (text) => told.push(text);
  const nobody = new Player(null);
  nobody.setUsername("NotADeveloper");
  nobody.sendMessage = (text) => told.push(`nobody: ${text}`);
  CommandPacketListener.execute(nobody, "toabot");
  assert.equal(Bot.bots.size, 0, "below developer, no bot");

  CommandPacketListener.execute(owner, "toabot");
  assert.match(told.at(-1), /^Spawned ToaBot1 at the Tombs of Amascut lobby/);
  bot = [...Bot.bots.values()].find((each) => each.owner === owner);
  assert.ok(bot);

  // The trap cross-check: probes stand on every corridor tile; each room tick, what the bot's
  // model says should catch them must be exactly what the room catches.
  const probes = probeTiles().map((tile) => ({ tile, location: new Location(tile.x, tile.y, 0) }));
  for (const probe of probes) probe.getLocation = () => probe.location;
  const probeSet = new Set(probes);
  const mismatches = [];
  let probeHits = 0;
  let botTrapHits = 0;
  let wired = null;
  function wire(room) {
    wired = room;
    const challenge = room.challengePlayers.bind(room);
    room.challengePlayers = () => (room.isStarted() && !room.isCompleted() ? [...challenge(), ...probes] : challenge());
    const trapHit = room.trapHit.bind(room);
    let caught = null;
    room.trapHit = (player, kind) => {
      if (probeSet.has(player)) {
        caught?.add(`${player.tile.x},${player.tile.y}`);
        return;
      }
      if (player === bot.player) botTrapHits++;
      return trapHit(player, kind);
    };
    const tick = room.tick.bind(room);
    room.tick = () => {
      const live = room.isStarted() && !room.isCompleted() && bot.module instanceof Crondis.CrondisPlayer;
      if (!live) return tick();
      const now = Shared.cycle();
      const model = { startCycle: room.startCycle, trails: bot.module.trails };
      const expected = new Set(probes.filter(({ tile }) => Crondis.hazardAt(model, now, tile.x, tile.y)).map(({ tile }) => `${tile.x},${tile.y}`));
      caught = new Set();
      tick();
      probeHits += caught.size;
      const missed = [...expected].filter((key) => !caught.has(key));
      const extra = [...caught].filter((key) => !expected.has(key));
      if (missed.length || extra.length) mismatches.push({ cycle: now, missed, extra });
      caught = null;
    };
  }

  const seen = { puzzleDone: false, zebakDone: false, zebakStartHp: null };
  for (let tick = 0; tick < MAX_TICKS && bot.state !== "STOPPED"; tick++) {
    World.process();
    const room = Raid.roomOf(bot.player);
    if (room?.key === "CRONDIS_PUZZLE" && wired !== room) wire(room);
    if (room?.key === "CRONDIS_PUZZLE" && room.isCompleted()) seen.puzzleDone = true;
    if (room?.key === "CRONDIS_BOSS" && room.isStarted() && seen.zebakStartHp === null) seen.zebakStartHp = room.zebak.getMaxHitpoints();
    if (room?.key === "CRONDIS_BOSS" && room.isCompleted()) seen.zebakDone = true;
  }

  const story = bot.history.map((line) => line.text);
  assert.equal(bot.state, "STOPPED", story.join("\n"));
  assert.equal(bot.reason, "played 1 raid");
  assert.ok(seen.puzzleDone, "the palm was grown");
  assert.ok(seen.zebakDone, "Zebak was killed");
  assert.equal(bot.deaths, 0);
  assert.equal(bot.raidsDone, 1);
  for (const step of ["made a party at raid level 0", "in the Nexus: off to the Path of Crondis", "taking a container", "fetching water",
    "carrying water", "puzzle done: on to the boss", "fighting Zebak", "boss down: back to the Nexus"]) {
    assert.ok(story.includes(step), `${step}\n${story.join("\n")}`);
  }
  // The model of the traps is the room's: every probe the room caught was predicted, and no other.
  assert.ok(probeHits > 100, `the probes were caught ${probeHits} times`);
  assert.deepEqual(mismatches.slice(0, 5), []);
  assert.equal(botTrapHits, 0, "the bot itself never stood in a trap");

  // It reports, and the developer can take it away.
  CommandPacketListener.execute(owner, "toabot status");
  assert.match(told.at(-1), /^ToaBot1: STOPPED, 1 raid\(s\), 0 death\(s\)/);
  CommandPacketListener.execute(owner, "toabot stop");
  assert.equal(told.at(-1), "Removed 1 raid bot.");
  for (let tick = 0; tick < 5; tick++) World.process();
  assert.equal(Bot.bots.size, 0);
  assert.equal(bot.player.isRegistered(), false);
});
