/**
 * SPELLS SYSTEM (client) — five rail buttons, cooldown sweeps and cast FX.
 *
 * TARGETING WITHOUT A SECOND TAP is what makes this playable on a phone:
 *   - `self` casts immediately
 *   - `ray` and `dash` use the stick's current facing — nothing to aim
 *   - everything else taps at the AUTO-TARGET: the nearest enemy in range
 *     inside the facing cone. The client only proposes; the server
 *     re-validates and may pick its own. Server-authoritative, always.
 *   - long-press (250 ms) opens manual aim: a reticle, drag to place, release
 *     to cast. Dragging back onto the button cancels.
 *
 * The cooldown sweep is a `conic-gradient` driven by ONE CSS custom property
 * updated in `onUpdate`. No extra DOM, no Pixi.
 *
 * Owns a Container in `layers.fx` (projectiles, beams, impacts) and one in
 * `layers.floor` (trap markers, AoE telegraphs).
 *
 * ---------------------------------------------------------------------------
 * STATUS: contract frozen, behaviour not implemented (M0).
 * ---------------------------------------------------------------------------
 */

import { S2C } from '@shared/protocol.js'

/** Hold this long on a spell button to enter manual aim. */
export const AIM_HOLD_MS = 250

export default {
  id: 'spells',

  init(ctx) {
    // B3: one ctx.action per class spell, labelled from SPELLS[id].icon.
    // Locked slots render at opacity .35 with a lock glyph until their level.
  },

  onSnapshot(ctx, snapshot) {},

  /** Advances projectile interpolation and the cooldown sweeps. */
  onUpdate(ctx, dtMs) {},

  handlers: {
    [S2C.SPELL_BOOK](ctx, payload) {},
    [S2C.SPELL_COOLDOWN](ctx, payload) {},
    [S2C.SPELL_CAST_FX](ctx, payload) {},
    [S2C.SPELL_RAY](ctx, payload) {},
    [S2C.SPELL_IMPACT](ctx, payload) {},
    [S2C.SPELL_FAILED](ctx, payload) {},
  },
}
