/**
 * INVENTORY SYSTEM (server) — gear tiers and the shop.
 *
 * Not items: one monotonically increasing tier counter per slot, bought with
 * coins. Coins reuse `profile.gold`, which is already private and already has
 * a HUD readout.
 *
 * Buying charges through `spendGold` — already atomic, it returns false and
 * changes nothing when the player cannot pay — then publishes exactly ONE
 * `setModifier(ctx, player, 'inventory', sum)`.
 *
 * The non-stat `mult` fields are NOT modifiers. `pickStats` would drop them
 * anyway. They are read by the damage-pipeline stage this system registers
 * with `combat`, which is where percentage multipliers belong.
 *
 * ---------------------------------------------------------------------------
 * STATUS: contract frozen, behaviour not implemented (M0).
 * ---------------------------------------------------------------------------
 */

import { C2S } from '../../shared/protocol.js'
import { emptyTiers } from '../../shared/gear.js'

export default {
  id: 'inventory',
  enabled: false,

  init(ctx) {
    // C2: registerDamagePipeline(20, ...) — after effects (priority 10) — to
    // apply the gear `mult` fields.
    ctx.log('inventory: contract frozen, not implemented yet')
  },

  onPlayerJoin(ctx, player) {
    player.ext.inventory = { tiers: emptyTiers() }
  },

  onPlayerLeave(ctx, player) {},

  /** Tiers are private: they go out over INVENTORY_SELF, never the snapshot. */
  collectSnapshot(ctx) {
    return undefined
  },

  handlers: {
    [C2S.INVENTORY_BUY](ctx, player, payload) {},
  },
}

/* ---------- API for other systems ---------- */

/**
 * Owned tier per slot: `{ weapon: 2, armor: 0, focus: 0, boots: 1 }`.
 * Read freely; only this system writes it.
 */
export function tiersOf(player) {
  return player?.ext?.inventory?.tiers ?? null
}

/** The `mult` totals the damage pipeline consumes: `{ taken, dealt, meleeDealt }`. */
export function multsOf(player) {
  return { taken: 0, dealt: 0, meleeDealt: 0 }
}
