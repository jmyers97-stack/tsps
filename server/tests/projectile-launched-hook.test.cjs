// Run after `yarn build`: node --test tests/projectile-launched-hook.test.cjs
// onProjectileLaunched: every projectile sent is reported to observing plugins with its tiles,
// target, instance and landing tick, whether or not any client is there to be sent it. Bots get
// no packets, so this is how they see what a player's client draws.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { Server } = require("../dist/Server");
Server.installProductionPathResolver();
const { Projectile } = require("../dist/game/model/Projectile");
const { Location } = require("../dist/game/model/Location");
const { World } = require("../dist/game/World");
const { PluginManager } = require("../dist/plugins/PluginManager");

const mobile = (index, isPlayer, x = 3205) => ({
  getIndex: () => index,
  isPlayer: () => isPlayer,
  getLocation: () => new Location(x, 3200, 0),
  getSize: () => 1,
  getPrivateArea: () => null,
});

/** Runs `send` with `recipients` as the only network players. */
function withNetworkPlayers(recipients, send) {
  const original = World.forEachNetworkPlayer;
  World.forEachNetworkPlayer = (visit) => recipients.forEach(visit);
  try {
    send();
  } finally {
    World.forEachNetworkPlayer = original;
  }
}

const seen = [];

test("nothing is built while no plugin observes projectiles", () => {
  assert.equal(PluginManager.hasProjectileLaunchedHooks(), false);
  withNetworkPlayers([], () => {
    new Projectile(new Location(3200, 3200, 0), new Location(3205, 3200, 0), null, 2176, 30, 120, 50, 0, null).sendProjectile();
  });
  assert.deepEqual(seen, []);
});

test("a launch is reported with its tiles, target, instance and landing tick, with nobody to send it to", () => {
  PluginManager.createApi("ProjectileLaunchedTest").onProjectileLaunched((event) => seen.push(event));
  assert.equal(PluginManager.hasProjectileLaunchedHooks(), true);
  const area = { name: "instance" };
  const victim = mobile(12, true);
  withNetworkPlayers([], () => {
    new Projectile(new Location(3200, 3200, 0), new Location(3205, 3200, 0), victim, 2178, 60, 120, 50, 22, area).sendProjectile();
    new Projectile(new Location(3200, 3201, 1), new Location(3203, 3204, 1), null, 2181, 0, 90, 175, 22, null).sendProjectile();
  });
  assert.equal(seen.length, 2);
  const [homing, tile] = seen;
  assert.equal(homing.projectileId, 2178);
  assert.deepEqual(homing.start, { x: 3200, y: 3200, z: 0 });
  assert.deepEqual(homing.end, { x: 3205, y: 3200, z: 0 });
  assert.equal(homing.target, victim);
  assert.equal(homing.privateArea, area);
  assert.equal(homing.startCycleOffset, 60);
  assert.equal(homing.endCycleOffset, 120);
  assert.equal(homing.launchCycle, World.getProcessCycle());
  assert.equal(homing.landingCycle, homing.launchCycle + 4, "120 cycles is four ticks");
  assert.equal(tile.target, null, "a tile shot has no target");
  assert.equal(tile.privateArea, null, "the open world");
  assert.deepEqual(tile.end, { x: 3203, y: 3204, z: 1 });
  assert.equal(tile.landingCycle, tile.launchCycle + 3, "90 cycles is three ticks");
});

test("the legacy magic shape is reported with the cycles it is sent with", () => {
  seen.length = 0;
  withNetworkPlayers([], () => {
    new Projectile(new Location(3200, 3200, 0), new Location(3205, 3200, 0), null, 91, 0, 20, 43, 31, null).sendProjectile();
  });
  assert.equal(seen[0].startCycleOffset, 51);
  assert.equal(seen[0].endCycleOffset, Projectile.LEGACY_MAGIC_END_BASE + 5 * 10);
});

test("an observer that throws doesn't stop the packet reaching clients", () => {
  seen.length = 0;
  PluginManager.createApi("ProjectileLaunchedThrows").onProjectileLaunched(() => { throw new Error("observer bug"); });
  const calls = [];
  const recipient = {
    getPrivateArea: () => null,
    getLocation: () => new Location(3201, 3201, 0),
    getNpcViewDistance: () => 15,
    getPacketSender: () => ({ sendProjectile: (...args) => calls.push(args) }),
  };
  const error = console.error;
  console.error = () => {};
  try {
    withNetworkPlayers([recipient], () => {
      new Projectile(new Location(3200, 3200, 0), new Location(3205, 3200, 0), null, 2176, 30, 120, 50, 0, null).sendProjectile();
    });
  } finally {
    console.error = error;
  }
  assert.equal(calls.length, 1, "the client still gets it");
  assert.equal(seen.length, 1, "and the other observer still hears of it");
});
