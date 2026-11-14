"use strict";

/**
 * Tombs of Amascut raid bot: what the bot should be doing, decided from where it is.
 *
 *   LOBBY -> NEXUS (pick a path) -> PUZZLE -> PROCEED -> BOSS -> RETURN -> NEXUS ...
 *         -> WARDENS -> LOOT -> LEAVE -> LOBBY (another raid) or STOPPED
 *
 * DEAD (a ghost, waiting to be revived) and LEAVE (a stop condition, or nothing left it can
 * play) can come from anywhere in a raid. The state is worked out afresh every tick from an
 * observation of the bot's situation, so a teleport, a death or a team wipe never leaves the
 * bot following a stale plan. Pure: no game objects, so the tests can drive it directly.
 *
 * Observation fields:
 *   inRaid, roomKey, room: { puzzle, boss, path, started, completed }, ghost, pathsCompleted,
 *   raidsDone, deaths, minutesPlayed, outOfSupplies, purpleSeen, stopRequested.
 */

const STATES = Object.freeze({
  LOBBY: "LOBBY",
  NEXUS: "NEXUS",
  PUZZLE: "PUZZLE",
  PROCEED: "PROCEED",
  BOSS: "BOSS",
  RETURN: "RETURN",
  WARDENS: "WARDENS",
  LOOT: "LOOT",
  DEAD: "DEAD",
  LEAVE: "LEAVE",
  STOPPED: "STOPPED",
});

const ALL_PATHS = 4;

/** Rooms the bot can play past the paths. None yet: the Wardens and the vault come in phase 5. */
const PLAYABLE_LATE_ROOMS = new Set();

/** The first path in the configured order that the raid hasn't completed. */
function nextPath(pathOrder, pathsCompleted) {
  return pathOrder.find((key) => !pathsCompleted.includes(key)) ?? null;
}

/** Why the bot should stop, or null. Supplies only count between rooms (the caller says when). */
function stopReason(obs, config) {
  const { stop } = config;
  if (obs.stopRequested) return "asked to stop";
  if (stop.maxRaids > 0 && obs.raidsDone >= stop.maxRaids) return `played ${obs.raidsDone} raid${obs.raidsDone === 1 ? "" : "s"}`;
  if (obs.deaths >= stop.maxDeaths && stop.maxDeaths > 0) return `died ${obs.deaths} times`;
  if (stop.maxMinutes > 0 && obs.minutesPlayed >= stop.maxMinutes) return `played for ${Math.floor(obs.minutesPlayed)} minutes`;
  if (stop.onPurple && obs.purpleSeen) return "a purple chest";
  if (stop.whenOutOfSupplies && obs.outOfSupplies) return "out of supplies";
  return null;
}

/** Mid-challenge: a started room that isn't done. Leaving then would abandon the party. */
function midChallenge(obs) {
  return !!obs.room && obs.room.started && !obs.room.completed;
}

/** The state for this observation: `{ state, path?, reason? }`. */
function decide(obs, config) {
  if (obs.stopped) return { state: STATES.STOPPED, reason: obs.stopReason ?? "stopped" };
  const reason = stopReason(obs, config);
  if (!obs.inRaid) {
    return reason ? { state: STATES.STOPPED, reason } : { state: STATES.LOBBY };
  }
  if (obs.ghost) return { state: STATES.DEAD };
  if (reason && !midChallenge(obs)) return { state: STATES.LEAVE, reason };

  const room = obs.room ?? {};
  if (obs.roomKey === "MAIN_HALL") {
    const path = nextPath(config.pathOrder, obs.pathsCompleted);
    if (path) return { state: STATES.NEXUS, path };
    if (obs.pathsCompleted.length >= ALL_PATHS && PLAYABLE_LATE_ROOMS.has("WARDENS_P1")) return { state: STATES.WARDENS };
    return {
      state: STATES.LEAVE,
      reason: obs.pathsCompleted.length >= ALL_PATHS ? "the Wardens aren't playable yet" : "every configured path is done",
      finished: true,
    };
  }
  if (room.puzzle) return { state: room.completed ? STATES.PROCEED : STATES.PUZZLE, path: room.path };
  if (room.boss && room.path) return { state: room.completed ? STATES.RETURN : STATES.BOSS, path: room.path };
  if (PLAYABLE_LATE_ROOMS.has(obs.roomKey)) return { state: obs.roomKey === "REWARD" ? STATES.LOOT : STATES.WARDENS };
  return { state: STATES.LEAVE, reason: `${obs.roomKey ?? "this room"} isn't playable yet` };
}

module.exports = {
  STATES,
  decide,
  nextPath,
  stopReason,
};
