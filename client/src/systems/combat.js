/**
 * COMBAT SYSTEM (client) — the attack action and everything a hit looks like.
 *
 * Pairs with server/systems/combat.js and only runs once that half is enabled.
 * The client never decides an outcome: it draws what the server reports.
 *
 * Owns, in `layers.fx`: floating damage numbers and hit flashes.
 * Owns, in `layers.overlay`: the kill feed.
 *
 * HUD: write through `ctx.hud.setStats` — never reach into the HUD's elements.
 * That is the one place this system and `profile` could collide.
 *
 * ---------------------------------------------------------------------------
 * STATUS: contract frozen, behaviour not implemented (M0).
 * ---------------------------------------------------------------------------
 */

import { S2C, C2S } from '@shared/protocol.js'

export default {
  id: 'combat',

  init(ctx) {
    // A5: own Container in ctx.layers.fx.
    //
    // The attack is `SPELLS.attack`, slot 0 of the rail, and `spells` owns the
    // whole rail once it is live — binding it here too would put two ⚔ buttons
    // on a phone and run two independent cooldowns. This binding is the
    // fallback for a world running combat without spells.
    if (ctx.state.systems.spells) return

    ctx.action({
      id: 'attack',
      label: '⚔',
      key: 'Space',
      onPress: () => ctx.net.send(C2S.COMBAT_ATTACK, {}),
    })
  },

  onSnapshot(ctx, snapshot) {},

  onUpdate(ctx, dtMs) {},

  handlers: {
    [S2C.COMBAT_HIT](ctx, payload) {},
    [S2C.COMBAT_DEATH](ctx, payload) {},
    [S2C.COMBAT_RESPAWNED](ctx, payload) {},
    [S2C.COMBAT_KILLFEED](ctx, payload) {},
  },
}

/* ---------- API for other client systems ---------- */

/**
 * Floating world-space text: damage numbers, misses, "immune". Other systems
 * use it so every number in the game rises and fades the same way.
 *
 * @param {Object} ctx
 * @param {number} x       world pixels
 * @param {number} y       world pixels
 * @param {string} text
 * @param {Object} [opts]
 * @param {number} [opts.color]
 * @param {number} [opts.ms]
 */
export function floatText(ctx, x, y, text, opts = {}) {}
