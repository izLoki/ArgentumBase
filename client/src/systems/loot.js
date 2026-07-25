/**
 * LOOT SYSTEM (client) — drops on the ground, pickups and explosions.
 *
 * Owns a Container in `layers.floor`, under the entities, so a drop never
 * hides the player standing on it.
 *
 * Drops ride the snapshot because they are continuous world state; the pickup
 * and explosion flashes ride one-shot events.
 *
 * ---------------------------------------------------------------------------
 * STATUS: contract frozen, behaviour not implemented (M0).
 * ---------------------------------------------------------------------------
 */

import { S2C } from '@shared/protocol.js'

export default {
  id: 'loot',

  init(ctx) {},

  onSnapshot(ctx, snapshot) {},

  onUpdate(ctx, dtMs) {},

  handlers: {
    [S2C.LOOT_PICKED](ctx, payload) {},
    [S2C.LOOT_EXPLODE](ctx, payload) {},
  },
}
