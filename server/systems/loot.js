/**
 * LOOT SYSTEM (server) — ground drops, walk-over pickup and the fused bomb.
 *
 * Potions are consumed by WALKING OVER them: no extra button, no inventory
 * screen, which is the only version of this that works on a phone. The bomb is
 * the exception — it arms where it lands and detonates on a timer, so it is
 * area denial rather than a pickup.
 *
 * Drops spawn from `combat.onKill` at the victim's tile, or the nearest free
 * tile when it is taken. Pickup is one `byTile` lookup per player in `onTick`
 * — O(players), not O(drops).
 *
 * ---------------------------------------------------------------------------
 * STATUS: contract frozen, behaviour not implemented (M0).
 * ---------------------------------------------------------------------------
 */

/**
 * `onPickup` runs with the player who stepped on it. Effects and healing go
 * through the owning system's API — loot never writes hp or stats itself.
 */
export const DROP_TYPES = {
  healPotion: { icon: '🧪', heal: 45 },
  ragePotion: { icon: '⚗', effect: 'rage', ms: 8000 },
  swiftPotion: { icon: '🌀', effect: 'swift', ms: 8000 },
  coins: { icon: '🪙', gold: 25 },
  /** Arms on drop, never picked up. */
  bomb: { icon: '💣', fuseMs: 3000, radius: 2, damage: 55 },
}

export const DROP_TTL_MS = 45_000

export default {
  id: 'loot',
  enabled: false,

  init(ctx) {
    // C4: onKill(...) from combat, to spawn drops where the victim fell.
    ctx.world.ext.loot = {
      /** dropId -> drop */
      drops: new Map(),
      /** `${x},${y}` -> dropId, so pickup stays O(players). */
      byTile: new Map(),
      nextId: 1,
    }
    ctx.log('loot: contract frozen, not implemented yet')
  },

  /** Pickup, TTL expiry and bomb fuses. */
  onTick(ctx, dtMs) {},

  /** Drops ride the snapshot: they are continuous, visible world state. */
  collectSnapshot(ctx) {
    return undefined
  },

  handlers: {},
}

/* ---------- API for other systems ---------- */

/**
 * Drops an item on the ground, or on the nearest free tile when that one is
 * taken. `npc` calls this for mob drops; `combat` for player deaths.
 *
 * @param {Object} ctx
 * @param {number} x
 * @param {number} y
 * @param {string} type      a key of DROP_TYPES
 * @param {Object} [opts]
 * @param {string} [opts.ownerId]  who dropped it, for attribution
 * @param {number} [opts.ttlMs]
 * @returns {Object|null} the drop, or null when there was nowhere to put it
 */
export function spawnDrop(ctx, x, y, type, opts = {}) {
  return null
}

/** The drop lying on a tile, or null. */
export function dropAt(x, y) {
  return null
}
