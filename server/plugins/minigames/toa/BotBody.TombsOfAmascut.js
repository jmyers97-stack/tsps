"use strict";

/**
 * Tombs of Amascut raid bot: how it acts. Everything goes through the paths a player's clicks
 * take, so the raid's rules apply to the bot as they do to anyone:
 *
 * - a loc or an NPC option walks there with the movement queue's own reach rules
 *   (walkToObject / walkToEntity), then runs the option's handlers;
 * - a ground item is taken with ItemOnGroundManager.pickup, after walking onto it;
 * - eating and drinking are inventory clicks (ItemActionPacketListener);
 * - prayers go through PrayerHandler, which checks levels, points and the raid's invocations;
 * - attacking asks CombatFactory for permission first, as the attack option does;
 * - dialogues are answered with the same calls the chatbox's buttons make.
 *
 * A walk is re-asked at most every WALK_RETRY_TICKS and counts as stuck after STUCK_TICKS
 * without progress, as the Pest Control bots do.
 */

const Shared = require("./Shared.TombsOfAmascut");

const WALK_RETRY_TICKS = 1;
const STUCK_TICKS = 12;
const CLICK_COOLDOWN_TICKS = 2;
const EAT_COOLDOWN_TICKS = 3;
const DRINK_COOLDOWN_TICKS = 2;

/** Potions that restore prayer, best first, by name prefix. */
const PRAYER_RESTORES = ["Tears of Elidinis", "Super restore", "Prayer potion", "Sanfew serum"];
/** Things that heal besides food, by name prefix. */
const HEALING_DRINKS = ["Nectar", "Saradomin brew"];
/** Combat boosts drunk once at the start of a fight, by name prefix. */
const BOOSTS = { ranged: ["Ranging potion", "Bastion potion", "Divine ranging potion"], magic: ["Magic potion", "Forgotten brew"], melee: ["Super combat potion", "Combat potion"] };

class BotBody {
  constructor(player) {
    this.player = player;
    this.walk = { key: null, lastTile: null, lastMovedAt: 0, nextAt: 0 };
    this.nextClickAt = 0;
    this.nextEatAt = 0;
    this.nextDrinkAt = 0;
  }

  get core() {
    return Shared.core();
  }

  now() {
    return Shared.cycle();
  }

  here() {
    const at = this.player.getLocation();
    return { x: at.getX(), y: at.getY(), z: at.getZ() };
  }

  // ------------------------------------------------------------------ walking

  /**
   * Walks to (x, y). Returns "arrived" within `within` tiles, "walking", or "stuck" when it has
   * made no progress for a while (the caller picks another tile).
   */
  walkTo(x, y, { within = 0 } = {}) {
    const { player } = this;
    const here = this.here();
    if (Math.max(Math.abs(here.x - x), Math.abs(here.y - y)) <= within) {
      this.walk.key = null;
      return "arrived";
    }
    if (player.isNeedsPlacement?.() === true || player.getForceMovement?.()) return "walking";
    const now = this.now();
    const key = `${x},${y}`;
    const tile = `${here.x},${here.y}`;
    if (this.walk.key !== key) {
      this.walk = { key, lastTile: tile, lastMovedAt: now, nextAt: 0 };
    } else if (this.walk.lastTile !== tile) {
      this.walk.lastTile = tile;
      this.walk.lastMovedAt = now;
    } else if (now - this.walk.lastMovedAt > STUCK_TICKS) {
      this.walk.lastMovedAt = now;
      return "stuck";
    }
    const moving = player.getMovementQueue().size() > 0;
    if ((!moving || this.walk.routedTo !== key) && now >= this.walk.nextAt) {
      this.core.PathFinder.calculateWalkRoute(player, x, y);
      this.walk.routedTo = key;
      this.walk.nextAt = now + WALK_RETRY_TICKS;
    }
    return "walking";
  }

  /**
   * Walks to a tile at most a tick away (one step, two running), now: the planner's next tile.
   * The route is asked afresh each call, as clicking the tile again would.
   */
  stepTo(x, y) {
    const movement = this.player.getMovementQueue();
    movement.reset();
    this.core.PathFinder.calculateWalkRoute(this.player, x, y);
    this.walk.key = null;
  }

  /** Stops walking where it stands. */
  halt() {
    this.player.getMovementQueue().reset();
    this.walk.key = null;
  }

  ensureRunning() {
    if (!this.player.isRunningReturn?.() && this.player.getRunEnergy() > 5) this.player.setRunning(true);
  }

  // ------------------------------------------------------------------ clicks

  clickReady() {
    return this.now() >= this.nextClickAt;
  }

  spendClick() {
    this.nextClickAt = this.now() + CLICK_COOLDOWN_TICKS;
  }

  /** Clicks `option` on a loc: walks to it and runs its handlers on arrival, as a click does. */
  clickObject(object, option) {
    if (!object || !this.clickReady()) return false;
    const { ObjectDefinition, PluginManager } = this.core;
    const { player } = this;
    const definition = ObjectDefinition.forPlayer(object.getId(), player);
    const options = definition?.getInteractions?.() ?? [];
    const clickType = options.findIndex((entry) => entry?.toLowerCase() === option.toLowerCase()) + 1;
    if (clickType < 1) return false;
    this.spendClick();
    const execute = () => {
      const from = player.getLocation().clone();
      player.getMovementQueue().reset();
      player.setPositionToFace(object.getLocation());
      const at = object.getLocation();
      PluginManager.emitObjectInteraction({
        player, object, definition, objectId: object.getId(), clickType, option: options[clickType - 1]?.toLowerCase(),
        location: { x: at.getX(), y: at.getY(), z: at.getZ() },
        sourceLocation: { x: from.getX(), y: from.getY(), z: from.getZ() },
        handled: false,
      });
    };
    player.getMovementQueue().walkToObject(object, { execute }, clickType);
    this.walk.key = null;
    return true;
  }

  /** Clicks `option` on an NPC: walks into reach and runs its handlers, as a click does. */
  clickNpc(npc, option) {
    if (!npc || !this.clickReady()) return false;
    const { PluginManager } = this.core;
    const { player } = this;
    const definition = npc.getCurrentDefinition?.(player) ?? npc.getDefinition?.();
    const options = definition?.getActions?.() ?? [];
    const clickType = options.findIndex((entry) => entry?.toLowerCase() === option.toLowerCase()) + 1;
    if (clickType < 1) return false;
    this.spendClick();
    player.getMovementQueue().walkToEntity(npc, () => {
      const at = npc.getLocation();
      PluginManager.emitNpcInteraction({
        player, npc, definition, npcId: npc.getContentId?.(player) ?? npc.getId(), npcIndex: npc.getIndex(), clickType,
        location: { x: at.getX(), y: at.getY(), z: at.getZ() }, handled: false,
      });
    });
    this.walk.key = null;
    return true;
  }

  /** Walks onto a ground item and takes it. */
  pickUp(groundItem) {
    if (!groundItem || !this.clickReady()) return false;
    const { ItemOnGroundManager } = this.core;
    this.spendClick();
    const position = groundItem.getPosition();
    this.player.getMovementQueue().walkToGroundItem(position, () => ItemOnGroundManager.pickup(this.player, groundItem));
    this.walk.key = null;
    return true;
  }

  /** Uses an inventory item's first option (Eat, Drink), as clicking it does. */
  useItem(slot) {
    const { ItemActionPacketListener, Inventory } = this.core;
    const item = this.player.getInventory().getItems()[slot];
    if (!item || item.getId() < 0) return false;
    ItemActionPacketListener.handleAction(this.player, Inventory.INTERFACE_ID, item.getId(), slot, 1);
    return true;
  }

  // ------------------------------------------------------------------ supplies

  /** Inventory slots whose item's name starts with one of `prefixes`, in that order of preference. */
  slotsNamed(prefixes) {
    const { ItemDefinition } = this.core;
    const items = this.player.getInventory().getItems();
    const slots = [];
    for (const prefix of prefixes) {
      items.forEach((item, slot) => {
        if (!item || item.getId() < 0) return;
        const name = ItemDefinition.forId(item.getId())?.getName?.() ?? "";
        if (name.startsWith(prefix) && !slots.includes(slot)) slots.push(slot);
      });
    }
    return slots;
  }

  foodSlots() {
    const { isFoodItem } = require("../../items/Food.plugin");
    const items = this.player.getInventory().getItems();
    const slots = [];
    items.forEach((item, slot) => {
      if (item && item.getId() >= 0 && isFoodItem(item.getId())) slots.push(slot);
    });
    return slots.concat(this.slotsNamed(HEALING_DRINKS));
  }

  hasFood() {
    return this.foodSlots().length > 0;
  }

  hasPrayerRestore() {
    return this.slotsNamed(PRAYER_RESTORES).length > 0;
  }

  /** Eats (or drinks a healing potion) once its delay allows. */
  eat() {
    if (this.now() < this.nextEatAt) return false;
    const slot = this.foodSlots()[0];
    if (slot === undefined) return false;
    this.nextEatAt = this.now() + EAT_COOLDOWN_TICKS;
    return this.useItem(slot);
  }

  restorePrayer() {
    if (this.now() < this.nextDrinkAt) return false;
    const slot = this.slotsNamed(PRAYER_RESTORES)[0];
    if (slot === undefined) return false;
    this.nextDrinkAt = this.now() + DRINK_COOLDOWN_TICKS;
    return this.useItem(slot);
  }

  /** Drinks a boost for `style` once, returning whether it did. */
  boost(style) {
    if (this.now() < this.nextDrinkAt) return false;
    const slot = this.slotsNamed(BOOSTS[style] ?? [])[0];
    if (slot === undefined) return false;
    this.nextDrinkAt = this.now() + DRINK_COOLDOWN_TICKS;
    return this.useItem(slot);
  }

  // ------------------------------------------------------------------ prayer

  prayerOn(prayerId) {
    const { PrayerHandler, PrayerData, Skill } = this.core;
    const { player } = this;
    if (PrayerHandler.isActivated(player, prayerId)) return true;
    if (player.getSkillManager().getCurrentLevel(Skill.PRAYER) <= 0) return false;
    const data = PrayerData.prayerData.get(prayerId);
    if (!data || !PrayerHandler.canUse(player, data, false)) return false;
    PrayerHandler.activatePrayerPrayerId(player, prayerId);
    return PrayerHandler.isActivated(player, prayerId);
  }

  prayerOff(prayerId) {
    const { PrayerHandler } = this.core;
    if (PrayerHandler.isActivated(this.player, prayerId)) PrayerHandler.deactivatePrayer(this.player, prayerId);
  }

  /** Protection against `style` ("melee", "ranged", "magic"), or none for null. */
  protect(style) {
    const { PrayerHandler } = this.core;
    const wanted = style === "magic" ? PrayerHandler.PROTECT_FROM_MAGIC
      : style === "ranged" ? PrayerHandler.PROTECT_FROM_MISSILES
        : style === "melee" ? PrayerHandler.PROTECT_FROM_MELEE : null;
    for (const prayer of [PrayerHandler.PROTECT_FROM_MAGIC, PrayerHandler.PROTECT_FROM_MISSILES, PrayerHandler.PROTECT_FROM_MELEE]) {
      if (prayer !== wanted) this.prayerOff(prayer);
    }
    return wanted === null ? true : this.prayerOn(wanted);
  }

  protecting() {
    const { PrayerHandler } = this.core;
    if (PrayerHandler.isActivated(this.player, PrayerHandler.PROTECT_FROM_MAGIC)) return "magic";
    if (PrayerHandler.isActivated(this.player, PrayerHandler.PROTECT_FROM_MISSILES)) return "ranged";
    if (PrayerHandler.isActivated(this.player, PrayerHandler.PROTECT_FROM_MELEE)) return "melee";
    return null;
  }

  /** The best offensive prayer for `style` the bot can use, on; or every one off for null. */
  offensive(style) {
    const { PrayerHandler } = this.core;
    const ladders = {
      ranged: [PrayerHandler.RIGOUR, PrayerHandler.EAGLE_EYE, PrayerHandler.HAWK_EYE, PrayerHandler.SHARP_EYE],
      magic: [PrayerHandler.AUGURY, PrayerHandler.MYSTIC_MIGHT, PrayerHandler.MYSTIC_LORE, PrayerHandler.MYSTIC_WILL],
      melee: [PrayerHandler.PIETY, PrayerHandler.CHIVALRY, PrayerHandler.ULTIMATE_STRENGTH],
    };
    const ladder = ladders[style] ?? [];
    let chosen = null;
    for (const prayer of ladder) {
      if (prayer === undefined) continue;
      if (this.prayerOn(prayer)) {
        chosen = prayer;
        break;
      }
    }
    for (const list of Object.values(ladders)) {
      for (const prayer of list) if (prayer !== undefined && prayer !== chosen) this.prayerOff(prayer);
    }
    return chosen;
  }

  allPrayersOff() {
    this.core.PrayerHandler.deactivatePrayers(this.player, false);
  }

  // ------------------------------------------------------------------ combat

  attackStyle() {
    const { CombatFactory, CombatType } = this.core;
    const type = CombatFactory.getMethod(this.player)?.type?.();
    if (type === CombatType.RANGED) return "ranged";
    if (type === CombatType.MAGIC) return "magic";
    return "melee";
  }

  /** Attacks `npc` unless already on it; false when the game says no. */
  attack(npc) {
    const { CombatFactory, CanAttackResponse } = this.core;
    const combat = this.player.getCombat();
    if (combat.getTarget?.() === npc) return true;
    const permission = CombatFactory.canAttackPermission(this.player, npc, false, CombatFactory.getMethod(this.player));
    if (permission !== CanAttackResponse.CAN_ATTACK) return false;
    combat.attack(npc);
    return true;
  }

  stopAttacking() {
    if (this.player.getCombat().getTarget?.()) this.player.getCombat().reset();
  }

  // ------------------------------------------------------------------ dialogue

  /** The open chatbox, as the bot reads it: options, or a line to continue, or null. */
  dialogue() {
    const { MultiChatboxPrompt, OptionDialogue, ActionDialogue } = this.core;
    const pending = MultiChatboxPrompt.getPending(this.player);
    if (pending) return { kind: "prompt", title: pending.title, options: pending.options };
    const current = this.player.getDialogueManager().getCurrent();
    if (!current) return null;
    if (current instanceof OptionDialogue) return { kind: "options", options: current.getOptions() };
    if (current instanceof ActionDialogue) return { kind: "action" };
    return { kind: "line", text: current.getText?.() ?? "" };
  }

  /**
   * Answers the open chatbox: the first option starting with one of `prefer` (else `fallback`'s
   * choice, else none), or continues a line. Returns what it did, or null when nothing was open.
   */
  answer(prefer = [], { fallback = null } = {}) {
    const { MultiChatboxPrompt } = this.core;
    const open = this.dialogue();
    if (!open || open.kind === "action") return null;
    if (open.kind === "line") {
      this.player.getDialogueManager().advance();
      return "continue";
    }
    let index = -1;
    for (const wanted of prefer) {
      index = open.options.findIndex((option) => option.toLowerCase().startsWith(wanted.toLowerCase()));
      if (index >= 0) break;
    }
    if (index < 0 && fallback !== null) index = fallback(open.options);
    if (index < 0) return null;
    if (open.kind === "prompt") {
      MultiChatboxPrompt.handleInterfaceActionClick({
        player: this.player, buttonId: MultiChatboxPrompt.OPTIONS_WIDGET_ID, action: index + 1, groupId: MultiChatboxPrompt.OPTIONS_WIDGET_ID >>> 16,
        childId: MultiChatboxPrompt.OPTIONS_WIDGET_ID & 0xffff, handled: false,
      });
    } else {
      this.player.getDialogueManager().handleOption(index + 1);
    }
    return open.options[index];
  }

  /** Closes whatever chatbox is open without choosing anything. */
  dismiss() {
    this.player.getDialogueManager().reset();
  }
}

module.exports = {
  BotBody,
  PRAYER_RESTORES,
  HEALING_DRINKS,
  BOOSTS,
  STUCK_TICKS,
};
