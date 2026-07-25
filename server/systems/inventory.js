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
 */

import { C2S, S2C, ERROR_CODE } from '../../shared/protocol.js'
import {
  GEAR_SLOTS,
  canUseSlot,
  emptyTiers,
  nextTierCost,
  sumGearMods,
  sumGearMults,
} from '../../shared/gear.js'
import { registerDamagePipeline } from './combat.js'
import { setModifier, spendGold } from './profile.js'

/** Pipeline slot: after `effects` (10), so gear scales what buffs left over. */
const PIPELINE_PRIORITY = 20

const NO_MULTS = Object.freeze({ taken: 0, dealt: 0, meleeDealt: 0 })

export default {
  id: 'inventory',
  enabled: true,

  init(ctx) {
    registerDamagePipeline(PIPELINE_PRIORITY, damageStage)
    ctx.log('inventory ready: gear tiers, the shop and the damage stage')
  },

  onPlayerJoin(ctx, player) {
    player.ext.inventory = {
      tiers: emptyTiers(),
      /** `sumGearMults` cached at buy time — the pipeline runs on every hit. */
      mults: NO_MULTS,
    }
    sendSelf(ctx, player)
  },

  onPlayerLeave(ctx, player) {},

  /** Tiers are private: they go out over INVENTORY_SELF, never the snapshot. */
  collectSnapshot(ctx) {
    return undefined
  },

  handlers: {
    /**
     * Buys the NEXT tier of one slot, and nothing else — there is no skipping
     * ahead and no choosing, so the payload cannot express an invalid state.
     */
    [C2S.INVENTORY_BUY](ctx, player, payload) {
      const slot = payload?.slot
      if (!GEAR_SLOTS.includes(slot)) {
        return ctx.fail(player, ERROR_CODE.BAD_PAYLOAD, 'unknown gear slot')
      }
      if (!canUseSlot(slot, player.cls)) {
        return ctx.fail(player, ERROR_CODE.BAD_PAYLOAD, 'your class cannot use that')
      }

      const inv = player.ext.inventory
      const cost = nextTierCost(slot, inv.tiers[slot], player.cls)
      if (cost === null) {
        return ctx.fail(player, ERROR_CODE.BAD_PAYLOAD, 'already at max tier')
      }

      // The atomic step: nothing below runs unless the coins actually moved.
      if (!spendGold(ctx, player, cost)) {
        return ctx.fail(player, ERROR_CODE.BAD_PAYLOAD, 'not enough gold')
      }

      inv.tiers = { ...inv.tiers, [slot]: inv.tiers[slot] + 1 }
      republish(ctx, player)
    },
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
  return player?.ext?.inventory?.mults ?? NO_MULTS
}

/* ---------- the damage pipeline stage ---------- */

/**
 * Gear percentages on a single hit: what the victim's armor absorbs and what
 * the attacker's weapon adds. Mobs have no gear, so a side that is not a
 * player contributes nothing and costs one property read.
 */
function damageStage(ctx, dmg) {
  const taken = dmg.target.providerId === 'players' ? multsOf(dmg.target.ref).taken : 0

  const source = dmg.source?.providerId === 'players' ? multsOf(dmg.source.ref) : null
  const dealt = source ? source.dealt + (dmg.melee ? source.meleeDealt : 0) : 0

  if (taken === 0 && dealt === 0) return dmg

  // Rounding stays in combat: it owns the final number.
  dmg.amount = dmg.amount * percentScale(taken) * percentScale(dealt)
  return dmg
}

/** `-4` -> 0.96, floored at zero so stacked reductions cannot go negative. */
function percentScale(pct) {
  return Math.max(0, 1 + pct / 100)
}

/* ---------- internals ---------- */

/** Everything a purchase changes, in one place: stats, pipeline cache, owner. */
function republish(ctx, player) {
  const inv = player.ext.inventory
  setModifier(ctx, player, 'inventory', sumGearMods(inv.tiers))
  inv.mults = sumGearMults(inv.tiers)
  sendSelf(ctx, player)
}

/** Tiers and next prices are private: pushed to their owner, never broadcast. */
function sendSelf(ctx, player) {
  const inv = player.ext.inventory
  const nextCosts = {}
  for (const slot of GEAR_SLOTS) {
    nextCosts[slot] = nextTierCost(slot, inv.tiers[slot], player.cls)
  }
  ctx.sendTo(player.id, S2C.INVENTORY_SELF, { tiers: inv.tiers, nextCosts })
}
