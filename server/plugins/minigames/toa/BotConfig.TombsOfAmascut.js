"use strict";

/**
 * Tombs of Amascut raid bot: its settings. They come from `pluginConfig["TombsOfAmascut:bot"]`
 * in world.local.json, and `::toabot` can override them for one bot. Anything missing or wrong
 * falls back to the defaults below; `normalize` reports what it dropped.
 *
 * Paths the bot can't play yet are dropped from `pathOrder` with a note, so a config written
 * for later phases still runs today.
 */

const PATH_KEYS = ["APMEKEN", "SCABARAS", "HET", "CRONDIS"];

/** The paths with a puzzle solver and a boss module (phase 1: Crondis). */
const SUPPORTED_PATHS = new Set(["CRONDIS"]);

const PRAYER_MODES = ["hold", "flick"];

/** A ranged set any account with 99s can use, and supplies for an Entry-mode path. */
const DEFAULT_GEAR = Object.freeze({
  equipment: [
    "Coif", "Black d'hide body", "Black d'hide chaps", "Black d'hide vambraces", "Snakeskin boots",
    "Amulet of glory", "Archers ring", "Ava's accumulator", "Rune crossbow", "Black d'hide shield",
    { name: "Runite bolts", amount: 1000 },
  ],
  inventory: [
    { name: "Prayer potion(4)", amount: 6 },
    { name: "Ranging potion(4)", amount: 1 },
    { name: "Shark", amount: 18 },
  ],
});

const DEFAULTS = Object.freeze({
  /** Invocation keys (Invocations.TombsOfAmascut.js); none is Entry mode, raid level 0. */
  invocations: [],
  pathOrder: ["CRONDIS"],
  gear: DEFAULT_GEAR,
  /** Every skill's level for a bot spawned with `::toabot` (0 keeps the account's own). */
  statLevel: 99,
  prayer: { mode: "hold", offensive: true },
  /** Eat below this share of hitpoints; drink a prayer potion below this many prayer points. */
  eatBelow: 0.55,
  restorePrayerBelow: 25,
  stop: {
    /** Raids to play before stopping; 0 is no limit. */
    maxRaids: 1,
    /** Deaths over all raids before stopping. */
    maxDeaths: 3,
    /** Minutes of play before stopping; 0 is no limit. */
    maxMinutes: 120,
    /** Stop once a raid's chest shows purple. */
    onPurple: true,
    /** Stop when the bot has no food or no prayer restores left between rooms. */
    whenOutOfSupplies: true,
  },
});

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function number(value, fallback, { min = -Infinity, max = Infinity, integer = false } = {}) {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const bounded = Math.max(min, Math.min(max, value));
  return integer ? Math.trunc(bounded) : bounded;
}

function gearEntries(list) {
  if (!Array.isArray(list)) return null;
  const entries = [];
  for (const entry of list) {
    if (typeof entry === "string" && entry.trim()) entries.push({ name: entry.trim(), amount: 1 });
    else if (isObject(entry) && typeof entry.name === "string" && entry.name.trim()) {
      entries.push({ name: entry.name.trim(), amount: number(entry.amount, 1, { min: 1, integer: true }) });
    }
  }
  return entries;
}

/**
 * The settings to run with: `raw` over the defaults, every field checked. Returns
 * `{ config, notes }`, where notes say what was dropped or replaced.
 */
function normalize(raw = {}) {
  const notes = [];
  const source = isObject(raw) ? raw : {};
  if (!isObject(raw) && raw !== undefined && raw !== null) notes.push("the bot config isn't an object; using the defaults");

  const invocations = Array.isArray(source.invocations)
    ? source.invocations.filter((key) => typeof key === "string" && key.trim()).map((key) => key.trim().toUpperCase())
    : [...DEFAULTS.invocations];

  let pathOrder = Array.isArray(source.pathOrder)
    ? source.pathOrder.map((key) => String(key).trim().toUpperCase()).filter((key, index, all) => all.indexOf(key) === index)
    : [...DEFAULTS.pathOrder];
  const unknown = pathOrder.filter((key) => !PATH_KEYS.includes(key));
  if (unknown.length) notes.push(`unknown paths ignored: ${unknown.join(", ")}`);
  const unsupported = pathOrder.filter((key) => PATH_KEYS.includes(key) && !SUPPORTED_PATHS.has(key));
  if (unsupported.length) notes.push(`not playable yet, skipped: ${unsupported.join(", ")}`);
  pathOrder = pathOrder.filter((key) => SUPPORTED_PATHS.has(key));
  if (pathOrder.length === 0) {
    pathOrder = [...DEFAULTS.pathOrder];
    notes.push(`no playable path left; using ${pathOrder.join(", ")}`);
  }

  const rawGear = isObject(source.gear) ? source.gear : {};
  const equipment = gearEntries(rawGear.equipment) ?? DEFAULT_GEAR.equipment.map((entry) => gearEntries([entry])[0]);
  const inventory = gearEntries(rawGear.inventory) ?? DEFAULT_GEAR.inventory.map((entry) => gearEntries([entry])[0]);

  const rawPrayer = isObject(source.prayer) ? source.prayer : {};
  let mode = typeof rawPrayer.mode === "string" ? rawPrayer.mode.toLowerCase() : DEFAULTS.prayer.mode;
  if (!PRAYER_MODES.includes(mode)) {
    notes.push(`prayer mode "${rawPrayer.mode}" isn't one of ${PRAYER_MODES.join(", ")}; using ${DEFAULTS.prayer.mode}`);
    mode = DEFAULTS.prayer.mode;
  }

  const rawStop = isObject(source.stop) ? source.stop : {};
  const stop = {
    maxRaids: number(rawStop.maxRaids, DEFAULTS.stop.maxRaids, { min: 0, integer: true }),
    maxDeaths: number(rawStop.maxDeaths, DEFAULTS.stop.maxDeaths, { min: 0, integer: true }),
    maxMinutes: number(rawStop.maxMinutes, DEFAULTS.stop.maxMinutes, { min: 0 }),
    onPurple: typeof rawStop.onPurple === "boolean" ? rawStop.onPurple : DEFAULTS.stop.onPurple,
    whenOutOfSupplies: typeof rawStop.whenOutOfSupplies === "boolean" ? rawStop.whenOutOfSupplies : DEFAULTS.stop.whenOutOfSupplies,
  };

  const config = {
    invocations,
    pathOrder,
    gear: { equipment, inventory },
    statLevel: number(source.statLevel, DEFAULTS.statLevel, { min: 0, max: 99, integer: true }),
    prayer: { mode, offensive: typeof rawPrayer.offensive === "boolean" ? rawPrayer.offensive : DEFAULTS.prayer.offensive },
    eatBelow: number(source.eatBelow, DEFAULTS.eatBelow, { min: 0.05, max: 0.95 }),
    restorePrayerBelow: number(source.restorePrayerBelow, DEFAULTS.restorePrayerBelow, { min: 1, max: 99, integer: true }),
    stop,
  };
  return { config, notes };
}

module.exports = {
  DEFAULTS,
  PATH_KEYS,
  SUPPORTED_PATHS,
  PRAYER_MODES,
  normalize,
};
