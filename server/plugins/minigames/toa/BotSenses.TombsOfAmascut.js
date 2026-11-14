"use strict";

/**
 * Tombs of Amascut raid bot: what the bot can see. The line it keeps is what a player's client is
 * shown, plus what the player knows about themselves:
 *
 * - NPCs in the room: id (after transformations), tile, size, hitpoints, the animation they last
 *   started and when, as the client draws them.
 * - Objects: map locs and the room's own (acid orbs, poison pools, rocks), as the client has them.
 * - Projectiles: every one launched in the bot's raid, from `onProjectileLaunched` (bots get no
 *   packets, so the core reports them), with where they land and when.
 * - The bot itself: hitpoints, prayer, run energy, inventory, location; and what its interfaces
 *   say (a puzzle's "Challenge started" line, the water container's Check).
 *
 * It never reads a room's private decisions: which style Zebak picks next, his attack timer, the
 * specials he has queued. Those it works out from the animations and projectiles, as a player does.
 */

const Shared = require("./Shared.TombsOfAmascut");
const Raid = require("./RaidState.TombsOfAmascut");

/** How long a projectile stays in memory after it lands, in ticks. */
const PROJECTILE_MEMORY_TICKS = 2;

/** Raid area -> projectiles launched in it, oldest first. */
const projectilesByArea = new WeakMap();

/** onProjectileLaunched: keep the launches inside a raid that a bot is in. */
function recordProjectile(event) {
  const area = event.privateArea;
  if (!area?.raid || !area.raid.__toaBots?.size) return;
  let list = projectilesByArea.get(area);
  if (!list) projectilesByArea.set(area, list = []);
  list.push({
    id: event.projectileId,
    start: event.start,
    end: event.end,
    target: event.target ?? null,
    launchCycle: event.launchCycle,
    landingCycle: event.landingCycle,
  });
  prune(list, event.launchCycle);
}

function prune(list, now) {
  let drop = 0;
  while (drop < list.length && list[drop].landingCycle + PROJECTILE_MEMORY_TICKS < now) drop++;
  if (drop > 0) list.splice(0, drop);
}

/** The projectiles in `area` that are in flight or landed in the last couple of ticks. */
function projectilesIn(area, now = Shared.cycle()) {
  const list = projectilesByArea.get(area);
  if (!list) return [];
  prune(list, now);
  return list.slice();
}

function tileOf(entity) {
  const at = entity.getLocation();
  return { x: at.getX(), y: at.getY(), z: at.getZ() };
}

/** An NPC as the client draws it. */
function npcView(npc) {
  const animation = npc.getAnimation?.();
  const transformed = npc.getNpcTransformationId?.() ?? -1;
  return {
    npc,
    id: transformed >= 0 ? transformed : npc.getId(),
    ...tileOf(npc),
    size: Math.max(1, npc.getSize?.() ?? 1),
    hitpoints: npc.getHitpoints(),
    maxHitpoints: npc.getMaxHitpoints?.() ?? npc.getHitpoints(),
    animation: animation?.getId?.() ?? -1,
    animationGeneration: npc.getAnimationGeneration?.() ?? 0,
    dead: npc.getHitpoints() <= 0 || npc.isRegistered?.() === false,
  };
}

/** The room's NPCs, as views. */
function roomNpcs(room) {
  if (!room) return [];
  return [...room.npcs].filter((npc) => npc.isRegistered?.() !== false).map(npcView);
}

/** The room's own objects (setObject) by id, as `{ id, x, y, z, type, face }`. */
function roomObjects(room, ids = null) {
  if (!room) return [];
  const wanted = ids ? new Set([].concat(ids)) : null;
  const objects = [];
  for (const object of room.area.getObjects()) {
    const id = object.getId();
    if (id < 0 || (wanted && !wanted.has(id))) continue;
    const at = object.getLocation();
    objects.push({ object, id, x: at.getX(), y: at.getY(), z: at.getZ(), type: object.getType(), face: object.getFace() });
  }
  return objects;
}

/**
 * The nearest object called `name` within `radius` of `near` ({x, y, z}) that the bot's client
 * would show: the room's own first, then the map's, minus any the raid has removed.
 */
function findObject(player, name, near, radius = 16) {
  const { MapObjects, ObjectDefinition, RegionManager, World } = Shared.core();
  const area = player.getPrivateArea?.() ?? null;
  const z = near.z ?? player.getLocation().getZ();
  const inBox = (at) => at.getZ() === z && Math.abs(at.getX() - near.x) <= radius && Math.abs(at.getY() - near.y) <= radius;
  const named = (object) => object.getId() >= 0 && ObjectDefinition.forPlayer(object.getId(), player)?.getName?.() === name;
  const removed = new Set();
  for (const object of World.getRemovedObjects?.() ?? []) {
    if (object.getPrivateArea?.() !== area) continue;
    const at = object.getLocation();
    removed.add(`${at.getX()},${at.getY()},${at.getZ()},${object.getType()}`);
  }
  const keyOf = (object) => {
    const at = object.getLocation();
    return `${at.getX()},${at.getY()},${at.getZ()},${object.getType()}`;
  };
  const candidates = [];
  for (const object of area?.getObjects?.() ?? []) if (inBox(object.getLocation()) && named(object)) candidates.push(object);
  const overlaid = new Set((area?.getObjects?.() ?? []).map(keyOf));
  RegionManager.loadMapFiles(near.x, near.y);
  for (let x = near.x - radius; x <= near.x + radius; x++) {
    for (let y = near.y - radius; y <= near.y + radius; y++) {
      for (const object of MapObjects.mapObjects.get(MapObjects.getHash(x, y, z)) ?? []) {
        const key = keyOf(object);
        if (removed.has(key) || overlaid.has(key) || !inBox(object.getLocation()) || !named(object)) continue;
        candidates.push(object);
      }
    }
  }
  const here = player.getLocation();
  const distance = (object) => Math.max(Math.abs(object.getLocation().getX() - here.getX()), Math.abs(object.getLocation().getY() - here.getY()));
  return candidates.sort((a, b) => distance(a) - distance(b))[0] ?? null;
}

/**
 * The loc of `type` the bot's client shows on (x, y): the raid's own change to that tile if it
 * made one (nothing, when it removed the loc), else the map's.
 */
function locAt(player, x, y, z = 0, type = 10) {
  const { MapObjects, RegionManager } = Shared.core();
  const area = player.getPrivateArea?.() ?? null;
  for (const object of area?.getObjects?.() ?? []) {
    const at = object.getLocation();
    if (at.getX() === x && at.getY() === y && at.getZ() === z && object.getType() === type) return object.getId() >= 0 ? object : null;
  }
  RegionManager.loadMapFiles(x, y);
  return (MapObjects.mapObjects.get(MapObjects.getHash(x, y, z)) ?? []).find((object) => object.getType() === type) ?? null;
}

/** Ground items the bot can see near it with this id. */
function groundItems(player, itemId, radius = 32) {
  const { World, ItemOnGroundManager } = Shared.core();
  const here = player.getLocation();
  return World.getItems().filter((item) => {
    const at = item.getPosition();
    return item.getItem().getId() === itemId && at.getZ() === here.getZ()
      && item.getPrivateArea?.() === player.getPrivateArea?.()
      && Math.max(Math.abs(at.getX() - here.getX()), Math.abs(at.getY() - here.getY())) <= radius
      && !item.isPendingRemoval?.() && ItemOnGroundManager.canSee?.(player, item) !== false;
  });
}

/** The bot itself. */
function selfView(player) {
  const { Skill } = Shared.core();
  const skills = player.getSkillManager();
  return {
    ...tileOf(player),
    hitpoints: player.getHitpoints(),
    maxHitpoints: skills.getMaxLevel(Skill.HITPOINTS),
    prayer: skills.getCurrentLevel(Skill.PRAYER),
    maxPrayer: skills.getMaxLevel(Skill.PRAYER),
    runEnergy: player.getRunEnergy(),
    moving: player.getMovementQueue().size() > 0,
  };
}

/** Where the bot is in the raid, for the state machine. */
function raidView(player) {
  const raid = Raid.raidOf(player);
  if (!raid || !Shared.inTombs(player.getLocation())) return { inRaid: false, raid: null, room: null };
  const room = raid.roomFor(player);
  const member = raid.member(player);
  return {
    inRaid: true,
    raid,
    roomObject: room,
    roomKey: room?.key ?? null,
    room: room ? {
      puzzle: !!room.def.puzzle,
      boss: !!room.def.boss,
      path: room.def.path ?? null,
      started: room.isStarted(),
      completed: room.isCompleted(),
      startCycle: room.startCycle,
    } : null,
    ghost: !!member?.ghost,
    pathsCompleted: [...raid.pathsCompleted],
  };
}

function chebyshev(a, b) {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

module.exports = {
  PROJECTILE_MEMORY_TICKS,
  recordProjectile,
  projectilesIn,
  npcView,
  roomNpcs,
  roomObjects,
  findObject,
  locAt,
  groundItems,
  selfView,
  raidView,
  chebyshev,
};
