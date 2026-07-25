/**
 * INVENTORY SYSTEM (client) — the shop.
 *
 * A centred modal, built in JS from this file so `client/index.html` stays
 * untouched. Mobile budget:
 *
 *   width: min(520px, 92vw)
 *   max-height: min(300px, calc(var(--app-h) - 60px))
 *
 * One row per slot, 44 px buy buttons, digit keys 1-4 on desktop. The world
 * keeps running while the shop is open, so every purchase must be a single
 * tap — no confirm step.
 *
 * The 🛒 button goes in the utility column (`slot: 'utility'`), never the
 * thumb rail: that space belongs to things used mid-fight.
 *
 * ---------------------------------------------------------------------------
 * STATUS: contract frozen, behaviour not implemented (M0).
 * ---------------------------------------------------------------------------
 */

import { S2C } from '@shared/protocol.js'

export default {
  id: 'inventory',

  init(ctx) {
    // C3: build the modal, then
    // ctx.action({ id: 'shop', label: '🛒', key: 'KeyB', slot: 'utility', ... })
  },

  handlers: {
    [S2C.INVENTORY_SELF](ctx, payload) {},
  },
}

/* ---------- API for other client systems ---------- */

/** Owned tier per slot for the local player: `{ weapon, armor, focus, boots }`. */
export function myTiers() {
  return null
}
