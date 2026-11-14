"use strict";

/**
 * Tombs of Amascut raid bot: route planning over tiles and ticks together. Pure: the rooms'
 * modules give it a model of what is dangerous where and when, so the tests can drive it.
 *
 * A room checks its traps against where each player stands when it ticks, so a route is a tile
 * per tick: the bot may pass over a dangerous tile mid-tick (running takes two steps a tick) but
 * mustn't end a tick on one. The bot ticks after its room, so the tile it moves to on tick t is
 * checked on tick t + 1.
 *
 * model:
 *   hazard(cycle, x, y)        would standing on (x, y) when the room ticks at `cycle` hurt?
 *   step(x, y, dx, dy)          can one step go from (x, y) by (dx, dy)? (walls, corners)
 *   inBounds(x, y)              tiles worth searching (a room's floor)
 *   avoid(x, y)                 tiles to keep off if there is any other way (optional)
 *   forbidMove(from, to, cycle) moves the room's rules allow but a player can't make (optional),
 *                               such as passing through a wave
 */

const STEPS = [[0, 1], [1, 0], [0, -1], [-1, 0], [1, 1], [1, -1], [-1, 1], [-1, -1]];
const HORIZON_TICKS = 40;

/** A king's step that doesn't cut a blocked corner, on a map of walkable tiles. */
function gridStep(walkable) {
  return (x, y, dx, dy) => {
    if (!walkable(x + dx, y + dy)) return false;
    if (dx !== 0 && dy !== 0 && (!walkable(x + dx, y) || !walkable(x, y + dy))) return false;
    return true;
  };
}

/** Is (x, y) safe from `from` through `to` (cycles, inclusive)? */
function safeThrough(model, x, y, from, to) {
  for (let cycle = from; cycle <= to; cycle++) if (model.hazard(cycle, x, y)) return false;
  return true;
}

/**
 * The next tile on the earliest route from `from` to a tile `isGoal` accepts. With `dwell`, a
 * goal must also stay safe that many ticks after the bot gets there (a place to stand, not just
 * pass). `maxSteps` is 2 when running, 1 walking.
 * Returns { next, eta, path } (path: one tile per tick, `from` first), or null.
 */
function plan(model, from, isGoal, now, { maxSteps = 2, horizon = HORIZON_TICKS, dwell = 0 } = {}) {
  const avoid = model.avoid ?? (() => false);
  const forbid = model.forbidMove ?? null;
  const inBounds = model.inBounds ?? (() => true);
  const stepCache = new Map();
  const step = (x, y, dx, dy) => {
    const k = `${x},${y},${dx},${dy}`;
    let ok = stepCache.get(k);
    if (ok === undefined) stepCache.set(k, ok = !!model.step(x, y, dx, dy));
    return ok;
  };
  const goal = (x, y, at) => isGoal(x, y) && (dwell <= 0 || safeThrough(model, x, y, at + 1, at + dwell));
  const key = (x, y) => (x << 16) | (y & 0xffff);
  if (goal(from.x, from.y, now + 1) && !model.hazard(now + 1, from.x, from.y) && !avoid(from.x, from.y)) {
    return { next: { x: from.x, y: from.y }, eta: 0, path: [{ x: from.x, y: from.y }] };
  }
  // Layer t: every tile the bot can stand on when the room ticks at now + t, and how it got there.
  let layer = new Map([[key(from.x, from.y), { x: from.x, y: from.y, parent: null }]]);
  for (let t = 1; t <= horizon; t++) {
    const check = now + t;
    const reach = new Map();
    for (const [k, node] of layer) reach.set(k, { x: node.x, y: node.y, origin: node });
    let edge = [...reach.values()];
    for (let s = 0; s < maxSteps; s++) {
      const grown = [];
      for (const tile of edge) {
        for (const [dx, dy] of STEPS) {
          const nx = tile.x + dx;
          const ny = tile.y + dy;
          const k = key(nx, ny);
          if (reach.has(k) || !inBounds(nx, ny) || !step(tile.x, tile.y, dx, dy)) continue;
          const entry = { x: nx, y: ny, origin: tile.origin };
          reach.set(k, entry);
          grown.push(entry);
        }
      }
      edge = grown;
    }
    const next = new Map();
    let found = null;
    for (const [k, tile] of reach) {
      if (model.hazard(check, tile.x, tile.y) || avoid(tile.x, tile.y)) continue;
      if (forbid && forbid(tile.origin, tile, check)) continue;
      const child = { x: tile.x, y: tile.y, parent: tile.origin };
      next.set(k, child);
      if (!found && goal(tile.x, tile.y, check)) found = child;
    }
    if (found) {
      const path = [];
      for (let at = found; at; at = at.parent) path.unshift({ x: at.x, y: at.y });
      return { next: path[1] ?? path[0], eta: t, path };
    }
    if (next.size === 0) return null;
    layer = next;
  }
  return null;
}

module.exports = {
  STEPS,
  HORIZON_TICKS,
  gridStep,
  safeThrough,
  plan,
};
