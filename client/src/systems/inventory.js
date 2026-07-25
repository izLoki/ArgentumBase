/**
 * INVENTORY SYSTEM (client) — gear tiers, surfaced in the HUD's Equipment tab.
 *
 * There is no standalone shop modal any more: upgrading gear lives inside the
 * character sidebar, one full-width row per slot. This system stays the owner
 * of the STATE and the WIRE — it receives INVENTORY_SELF, pushes tiers and
 * authoritative prices into the HUD, and hands the HUD the callback that
 * actually sends C2S.INVENTORY_BUY. The HUD owns the pixels; this file owns
 * the numbers, which is what keeps the lanes mergeable.
 *
 * The 🛒 button goes in the utility column (`slot: 'utility'`), never the
 * thumb rail: that space belongs to things used mid-fight. On desktop it
 * switches the (already open) sidebar to the Equipment tab; on a phone it
 * opens the sheet directly on it.
 *
 * STATE. Tiers and prices are private and arrive over INVENTORY_SELF. Until
 * the first packet lands the HUD renders from the shared gear table — tier 0
 * everywhere is not a guess, it is what a new player is.
 */

import { C2S, S2C } from '@shared/protocol.js'

let tiers = null

export default {
  id: 'inventory',

  init(ctx) {
    // The buy wire is registered once; prices merge in with every update.
    ctx.hud.setGearMarket({ buy: (slot) => ctx.net.send(C2S.INVENTORY_BUY, { slot }) })

    ctx.action({
      id: 'shop',
      label: '🛒',
      key: 'KeyB',
      slot: 'utility', // a panel toggle, not something used mid-fight
      onPress: () => ctx.hud.openEquipment(),
    })
  },

  handlers: {
    [S2C.INVENTORY_SELF](ctx, payload) {
      tiers = payload?.tiers ?? tiers
      ctx.hud.setGear(tiers ?? {})
      ctx.hud.setGearMarket({ nextCosts: payload?.nextCosts ?? null })
    },
  },
}

/* ---------- API for other client systems ---------- */

/** Owned tier per slot for the local player: `{ weapon, armor, focus, boots }`. */
export function myTiers() {
  return tiers
}
