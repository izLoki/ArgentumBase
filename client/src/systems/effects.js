/**
 * EFFECTS SYSTEM (client) — status icons above heads.
 *
 * Two sources, on purpose: the public icon list rides the snapshot so everyone
 * can see who is frozen, while exact remaining durations are private and only
 * reach their owner over EFFECTS_SELF.
 *
 * Owns a Container in `layers.overlay`. Anchors to players through
 * `viewPosition(id)` and to mobs through `npc`'s `mobViewPosition(id)`.
 *
 * ---------------------------------------------------------------------------
 * STATUS: contract frozen, behaviour not implemented (M0).
 * ---------------------------------------------------------------------------
 */

import { S2C } from '@shared/protocol.js'

export default {
  id: 'effects',

  init(ctx) {},

  onSnapshot(ctx, snapshot) {},

  onUpdate(ctx, dtMs) {},

  handlers: {
    [S2C.EFFECTS_SELF](ctx, payload) {},
  },
}

/* ---------- API for other client systems ---------- */

/** Active effects on the local player: `{ id, endsAt, stacks }[]`. */
export function myEffects() {
  return []
}

/** True when the local player currently has this effect. */
export function hasEffect(effectId) {
  return false
}
