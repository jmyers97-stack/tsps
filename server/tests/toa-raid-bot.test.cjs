// The Tombs of Amascut raid bot's pure parts: config, state machine, planner and the room solvers.
// Run after `yarn build`: node --test tests/toa-raid-bot.test.cjs
const assert = require("node:assert/strict");
const { test } = require("node:test");

require("../dist/Server").Server.installProductionPathResolver();

const BotConfig = require("../plugins/minigames/toa/BotConfig.TombsOfAmascut");
const Machine = require("../plugins/minigames/toa/BotStateMachine.TombsOfAmascut");
const Planner = require("../plugins/minigames/toa/BotPlanner.TombsOfAmascut");
const Crondis = require("../plugins/minigames/toa/BotCrondis.TombsOfAmascut");
const Zebak = require("../plugins/minigames/toa/BotZebak.TombsOfAmascut");

const { STATES } = Machine;
const config = BotConfig.normalize({}).config;

/** An observation with nothing going on, `fields` over it. */
function obs(fields = {}) {
  return {
    inRaid: true, roomKey: "MAIN_HALL", room: null, ghost: false, pathsCompleted: [],
    raidsDone: 0, deaths: 0, minutesPlayed: 1, outOfSupplies: false, purpleSeen: false, stopRequested: false,
    ...fields,
  };
}

// ------------------------------------------------------------------ config

test("the config falls back to Entry mode on the Path of Crondis with a ranged set", () => {
  const { config: defaults, notes } = BotConfig.normalize(undefined);
  assert.deepEqual(notes, []);
  assert.deepEqual(defaults.pathOrder, ["CRONDIS"]);
  assert.deepEqual(defaults.invocations, []);
  assert.equal(defaults.prayer.mode, "hold");
  assert.equal(defaults.stop.maxRaids, 1);
  assert.ok(defaults.gear.equipment.some((entry) => entry.name === "Rune crossbow"));
  assert.deepEqual(defaults.gear.equipment.find((entry) => entry.name === "Runite bolts"), { name: "Runite bolts", amount: 1000 });
});

test("the config drops what the bot can't play and says so", () => {
  const { config: checked, notes } = BotConfig.normalize({
    pathOrder: ["het", "Crondis", "nowhere", "CRONDIS"], prayer: { mode: "spin" }, eatBelow: 2, invocations: [" walk_the_path "],
    stop: { maxRaids: -4, onPurple: "yes" }, gear: { equipment: ["Coif", { name: "Rune arrow", amount: 0 }, 7] },
  });
  assert.deepEqual(checked.pathOrder, ["CRONDIS"]);
  assert.ok(notes.some((note) => note.includes("NOWHERE")));
  assert.ok(notes.some((note) => note.includes("not playable yet") && note.includes("HET")));
  assert.equal(checked.prayer.mode, "hold");
  assert.ok(notes.some((note) => note.includes("spin")));
  assert.equal(checked.eatBelow, 0.95);
  assert.deepEqual(checked.invocations, ["WALK_THE_PATH"]);
  assert.equal(checked.stop.maxRaids, 0);
  assert.equal(checked.stop.onPurple, true);
  assert.deepEqual(checked.gear.equipment, [{ name: "Coif", amount: 1 }, { name: "Rune arrow", amount: 1 }]);
  assert.ok(BotConfig.normalize({ pathOrder: ["HET"] }).notes.some((note) => note.includes("no playable path left")));
  assert.ok(BotConfig.normalize("nonsense").notes.some((note) => note.includes("isn't an object")));
});

// ------------------------------------------------------------------ state machine

test("the state machine walks lobby, Nexus, puzzle, boss and back", () => {
  assert.deepEqual(Machine.decide(obs({ inRaid: false, roomKey: null }), config), { state: STATES.LOBBY });
  assert.deepEqual(Machine.decide(obs(), config), { state: STATES.NEXUS, path: "CRONDIS" });
  const puzzle = { puzzle: true, boss: false, path: "CRONDIS", started: true, completed: false };
  assert.deepEqual(Machine.decide(obs({ roomKey: "CRONDIS_PUZZLE", room: puzzle }), config), { state: STATES.PUZZLE, path: "CRONDIS" });
  assert.equal(Machine.decide(obs({ roomKey: "CRONDIS_PUZZLE", room: { ...puzzle, completed: true } }), config).state, STATES.PROCEED);
  const boss = { puzzle: false, boss: true, path: "CRONDIS", started: true, completed: false };
  assert.equal(Machine.decide(obs({ roomKey: "CRONDIS_BOSS", room: boss }), config).state, STATES.BOSS);
  assert.equal(Machine.decide(obs({ roomKey: "CRONDIS_BOSS", room: { ...boss, completed: true } }), config).state, STATES.RETURN);
  const done = Machine.decide(obs({ pathsCompleted: ["CRONDIS"] }), config);
  assert.equal(done.state, STATES.LEAVE);
  assert.equal(done.finished, true);
  assert.equal(Machine.decide(obs({ pathsCompleted: ["CRONDIS", "HET", "APMEKEN", "SCABARAS"] }), config).reason, "the Wardens aren't playable yet");
});

test("the state machine follows the configured path order", () => {
  const order = { ...config, pathOrder: ["HET", "CRONDIS", "APMEKEN"] };
  assert.equal(Machine.nextPath(order.pathOrder, []), "HET");
  assert.equal(Machine.nextPath(order.pathOrder, ["HET"]), "CRONDIS");
  assert.equal(Machine.nextPath(order.pathOrder, ["HET", "CRONDIS", "APMEKEN"]), null);
  assert.deepEqual(Machine.decide(obs({ pathsCompleted: ["HET"] }), order), { state: STATES.NEXUS, path: "CRONDIS" });
});

test("stop conditions wait for the challenge to end, then leave; outside a raid they stop", () => {
  const puzzle = { puzzle: true, boss: false, path: "CRONDIS", started: true, completed: false };
  const tired = { minutesPlayed: config.stop.maxMinutes + 1 };
  assert.equal(Machine.decide(obs({ ...tired, roomKey: "CRONDIS_PUZZLE", room: puzzle }), config).state, STATES.PUZZLE);
  const leaving = Machine.decide(obs({ ...tired, roomKey: "CRONDIS_PUZZLE", room: { ...puzzle, completed: true } }), config);
  assert.equal(leaving.state, STATES.LEAVE);
  assert.match(leaving.reason, /played for \d+ minutes/);
  assert.deepEqual(Machine.decide(obs({ inRaid: false, raidsDone: 1 }), config), { state: STATES.STOPPED, reason: "played 1 raid" });
  assert.equal(Machine.decide(obs({ inRaid: false, deaths: 3 }), config).reason, "died 3 times");
  assert.equal(Machine.decide(obs({ inRaid: false, outOfSupplies: true }), config).reason, "out of supplies");
  assert.equal(Machine.decide(obs({ inRaid: false, purpleSeen: true }), config).reason, "a purple chest");
  assert.equal(Machine.decide(obs({ stopRequested: true }), config).reason, "asked to stop");
  assert.equal(Machine.decide(obs({ inRaid: false, raidsDone: 5 }), { ...config, stop: { ...config.stop, maxRaids: 0 } }).state, STATES.LOBBY);
  assert.equal(Machine.decide(obs({ ghost: true, stopRequested: true }), config).state, STATES.DEAD);
  assert.equal(Machine.decide(obs({ stopped: true, stopReason: "done" }), config).state, STATES.STOPPED);
  assert.equal(Machine.decide(obs({ roomKey: "WARDENS_P1", room: { boss: true, path: null } }), config).state, STATES.LEAVE);
});

// ------------------------------------------------------------------ planner

test("the planner never ends a tick on a dangerous tile, and runs two tiles a tick", () => {
  const walkable = (x, y) => x >= 0 && x < 12 && y >= 0 && y < 3;
  // Column 6 is dangerous except on ticks divisible by 4.
  const model = { hazard: (cycle, x) => x === 6 && cycle % 4 !== 0, step: Planner.gridStep(walkable) };
  const plan = Planner.plan(model, { x: 0, y: 1 }, (x) => x === 11, 1, { maxSteps: 2 });
  assert.ok(plan);
  plan.path.forEach((tile, index) => assert.ok(!model.hazard(1 + index, tile.x, tile.y), `tick ${index} on ${tile.x}`));
  for (let i = 1; i < plan.path.length; i++) {
    assert.ok(Math.max(Math.abs(plan.path[i].x - plan.path[i - 1].x), Math.abs(plan.path[i].y - plan.path[i - 1].y)) <= 2);
  }
  assert.ok(plan.path.some((tile, index) => tile.x === 6 && (1 + index) % 4 === 0), "it crosses on a safe tick");
  const walking = Planner.plan(model, { x: 0, y: 1 }, (x) => x === 11, 1, { maxSteps: 1 });
  assert.ok(walking.eta > plan.eta);
  // Standing still is a move too: already there and safe.
  assert.equal(Planner.plan(model, { x: 11, y: 1 }, (x) => x === 11, 1).eta, 0);
  // Nowhere safe to go.
  assert.equal(Planner.plan({ hazard: () => true, step: model.step }, { x: 0, y: 1 }, (x) => x === 11, 1), null);
});

test("a goal with a dwell must stay safe after the bot gets there", () => {
  const walkable = (x, y) => x >= 0 && x < 6 && y === 0;
  // Tile 3 turns dangerous on tick 5 for good; tile 5 never does.
  const model = { hazard: (cycle, x) => x === 3 && cycle >= 5, step: Planner.gridStep(walkable) };
  const near = Planner.plan(model, { x: 0, y: 0 }, (x) => x >= 3, 0, { maxSteps: 1 });
  assert.equal(near.path[near.path.length - 1].x, 3);
  const lasting = Planner.plan(model, { x: 0, y: 0 }, (x) => x >= 3, 0, { maxSteps: 1, dwell: 6 });
  assert.equal(lasting.path[lasting.path.length - 1].x, 4);
});

// ------------------------------------------------------------------ Crondis

test("Crondis spears: each statue's row, out for three ticks of the ten after its beat", () => {
  // North-west corridor, the first west statue (row y 5293, beat 3): out at 7, 8 and 9.
  for (let phase = 0; phase < Crondis.SPEAR_CYCLE; phase++) {
    assert.equal(Crondis.spearAt(phase, 3929, 5293), [7, 8, 9].includes(phase), `phase ${phase}`);
  }
  // The row's reach is the corridor's five tiles.
  assert.equal(Crondis.spearAt(8, 3927, 5293), true);
  assert.equal(Crondis.spearAt(8, 3931, 5293), true);
  assert.equal(Crondis.spearAt(8, 3926, 5293), false);
  assert.equal(Crondis.spearAt(8, 3932, 5293), false);
  // The first east statue (row y 5294) shares the beat; the north-east corridor has its own.
  assert.equal(Crondis.spearAt(8, 3929, 5294), true);
  assert.equal(Crondis.spearAt(9, 3943, 5293), true);
  assert.equal(Crondis.spearAt(8, 3943, 5293), false);
  // Off the corridors, nothing.
  for (let phase = 0; phase < Crondis.SPEAR_CYCLE; phase++) assert.equal(Crondis.spearAt(phase, 3936, 5280), false);
  assert.equal(Crondis.phaseOf(105, 100), 5);
  assert.equal(Crondis.phaseOf(99, 100), 9);
});

test("Crondis acid: a cloud runs ten tiles from its orb, a tile a third of a tick after four", () => {
  const north = Crondis.trailFromOrb(3929, Crondis.ACID_ROWS.SOUTH, 100);
  assert.equal(north.north, true, "the south orbs' clouds run north");
  assert.equal(Crondis.trailFromOrb(3929, Crondis.ACID_ROWS.NORTH, 100).north, false);
  const at = (cycle, y) => Crondis.acidAt([north], cycle, 3929, y);
  assert.equal(at(104, 5258), true);
  assert.equal(at(103, 5258), false);
  assert.equal(at(105, 5258), false);
  assert.equal(at(105, 5260), true);
  assert.equal(at(107, 5267), true);
  assert.equal(at(107, 5268), false, "past ten tiles");
  assert.equal(at(104, 5257), false, "not on the orb's own tile");
  assert.equal(Crondis.acidAt([north], 104, 3930, 5258), false, "only its own column");
  const south = Crondis.trailFromOrb(3943, 5303, 200);
  assert.equal(Crondis.acidAt([south], 204, 3943, 5302), true);
  assert.equal(Crondis.acidAt([south], 207, 3943, 5293), true);
});

test("Crondis routes go through a corridor without a spear or cloud catching the bot", () => {
  // The south-west corridor and the open floor either end of it.
  const walkable = (x, y) => (y >= 5255 && y <= 5257 && x >= 3926 && x <= 3932)
    || (y >= 5258 && y <= 5267 && x >= 3927 && x <= 3931)
    || (y >= 5268 && y <= 5272 && x >= 3926 && x <= 3940);
  const trails = [Crondis.trailFromOrb(3929, 5257, 10), Crondis.trailFromOrb(3931, 5257, 10), Crondis.trailFromOrb(3928, 5257, 15)];
  const model = { startCycle: 3, trails, walkable };
  // Running: walking a tile a tick, the spears' sweep never leaves a way through this one.
  for (let now = 10; now < 20; now++) {
    for (const maxSteps of [2]) {
      const plan = Crondis.planStep(model, { x: 3929, y: 5256 }, (x, y) => y >= 5270, now, { maxSteps });
      assert.ok(plan, `a route at ${now}, ${maxSteps} steps`);
      plan.path.forEach((tile, index) => {
        if (index === 0) return;
        assert.equal(Crondis.hazardAt(model, now + index, tile.x, tile.y), false, `start ${now}: tick ${index} on ${tile.x},${tile.y}`);
      });
    }
  }
});

test("Crondis: where to fill, where to water, and which waterfall", () => {
  const [southWest] = Crondis.WATERFALLS;
  assert.equal(Crondis.atWaterfall(southWest, 3928, 5255), true);
  assert.equal(Crondis.atWaterfall(southWest, 3928, 5256), false);
  assert.equal(Crondis.atWaterfall(southWest, 3933, 5255), false);
  // The palm is 5x5 from (3934, 5278): its sides, not its corners.
  assert.equal(Crondis.besidePalm(3936, 5277), true);
  assert.equal(Crondis.besidePalm(3939, 5280), true);
  assert.equal(Crondis.besidePalm(3933, 5277), false);
  assert.equal(Crondis.besidePalm(3936, 5280), false);
  assert.equal(Crondis.chooseWaterfall({ x: 3944, y: 5300 }, Crondis.WATERFALLS), Crondis.WATERFALLS[3]);
  assert.equal(Crondis.chooseWaterfall({ x: 3944, y: 5300 }, [Crondis.WATERFALLS[0]]), Crondis.WATERFALLS[0]);
  assert.equal(Crondis.chooseWaterfall({ x: 3944, y: 5300 }, []), null);
  const keepAway = Crondis.crocodileAvoidance([{ x: 3930, y: 5280, size: 2 }]);
  assert.equal(keepAway(3934, 5282), true);
  assert.equal(keepAway(3935, 5280), false);
});

// ------------------------------------------------------------------ Zebak

test("Zebak: the volley's colour says which protection, up a tick before it lands", () => {
  const volleys = Zebak.volleysFrom([
    { id: 2176, launchCycle: 100 }, { id: 2179, launchCycle: 106 }, { id: 1555, launchCycle: 101 },
  ]);
  assert.deepEqual(volleys.map(({ style, hitAt }) => [style, hitAt]), [["magic", 108], ["ranged", 114]]);
  // Holding: the next volley's style, and the last one's once nothing is coming.
  assert.equal(Zebak.protectionFor(volleys, 101, "hold"), "magic");
  assert.equal(Zebak.protectionFor(volleys, 108, "hold"), "magic");
  assert.equal(Zebak.protectionFor(volleys, 109, "hold"), "ranged");
  assert.equal(Zebak.protectionFor(volleys, 120, "hold"), "ranged");
  assert.equal(Zebak.protectionFor([], 5, "hold", "magic"), "magic");
  // Flicking: only the tick before the hit and the tick of it.
  assert.equal(Zebak.protectionFor(volleys, 106, "flick"), null);
  assert.equal(Zebak.protectionFor(volleys, 107, "flick"), "magic");
  assert.equal(Zebak.protectionFor(volleys, 108, "flick"), "magic");
  assert.equal(Zebak.protectionFor(volleys, 110, "flick"), null);
  assert.equal(Zebak.protectionFor(volleys, 113, "flick"), "ranged");
});

test("Zebak: his bite's reach, and a boulder's shelter", () => {
  const zebak = { x: 3918, y: 5404, size: 7 };
  assert.equal(Zebak.biteReach(zebak, 3925, 5406), true);
  assert.equal(Zebak.biteReach(zebak, 3925, 5403), false, "a corner");
  assert.equal(Zebak.biteReach(zebak, 3926, 5406), false);
  assert.equal(Zebak.distanceTo(zebak, 3930, 5408), 6);
  const boulders = [{ x: 3928, y: 5407 }];
  assert.deepEqual([3928, 3929, 3930, 3931, 3932].map((x) => Zebak.sheltered(boulders, x, 5407)), [false, true, true, true, false]);
  assert.equal(Zebak.sheltered(boulders, 3929, 5408), false);
});

test("Zebak: a wave row rolls a tile a tick and is crossed only through its gap", () => {
  const gap = [3931, 3932, 3933];
  const columns = [];
  for (let x = 3923; x <= 3943; x++) if (!gap.includes(x)) columns.push({ x, y: 5400, step: 1 });
  const rows = Zebak.waveRows(columns);
  assert.equal(rows.length, 1);
  assert.equal(Zebak.rowAt(rows[0], 50, 53), 5403);
  const walkable = (x, y) => Zebak.onGround(x, y);
  const model = Zebak.zebakModel({ now: 50, zebak: { x: 3918, y: 5404, size: 7 }, pools: new Set(["3936,5410"]), landing: [], rows },
    Planner.gridStep(walkable));
  assert.equal(model.hazard(53, 3936, 5403), true);
  assert.equal(model.hazard(53, 3932, 5403), false, "the gap");
  assert.equal(model.hazard(60, 3936, 5410), true, "acid stays");
  // Stepping south through the row in a covered column is ruled out; in the gap it isn't.
  assert.equal(model.forbidMove({ x: 3936, y: 5404 }, { x: 3936, y: 5403 }, 54), true);
  assert.equal(model.forbidMove({ x: 3932, y: 5404 }, { x: 3932, y: 5403 }, 54), false);
  assert.equal(model.forbidMove({ x: 3936, y: 5410 }, { x: 3936, y: 5409 }, 54), false, "far ahead of it");
  // Standing in front of the row, the bot gets out of its way and stays safe after.
  const plan = Planner.plan(model, { x: 3938, y: 5404 }, Zebak.onGround, 50, { maxSteps: 2, dwell: 20 });
  assert.ok(plan);
  const end = plan.path[plan.path.length - 1];
  for (let cycle = 50 + plan.eta; cycle < 50 + plan.eta + 20; cycle++) assert.equal(model.hazard(cycle, end.x, end.y), false);
  plan.path.forEach((tile, index) => index > 0 && assert.equal(model.hazard(50 + index, tile.x, tile.y), false));
});
