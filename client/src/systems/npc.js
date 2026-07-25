/**
 * NPC SYSTEM (client) — draws the monsters.
 *
 * Owns a Container in `layers.entities`, with `zIndex = worldY` so mobs sort
 * against players correctly (the layer is already `sortableChildren`).
 *
 * The snapshot is deliberately terse — `{ m: [[id, typeIdx, x, y, dir, hp,
 * maxHp], ...] }` — so this file is where those arrays become views. Nothing
 * else should have to know the tuple layout.
 *
 * ---------------------------------------------------------------------------
 * STATUS: contract frozen, behaviour not implemented (M0).
 * ---------------------------------------------------------------------------
 */

export default {
  id: 'npc',

  init(ctx) {},

  onSnapshot(ctx, snapshot) {},

  onUpdate(ctx, dtMs) {},

  handlers: {},
}

/* ---------- API for other client systems ---------- */

/**
 * Interpolated pixel position of a mob — the mob twin of `viewPosition(id)` in
 * render/entities.js. `spells` and `effects` anchor their FX with it.
 *
 * @returns {{x:number, y:number}|null}
 */
export function mobViewPosition(id) {
  return null
}

/** The local mirror of a mob: `{ id, type, x, y, dir, hp, maxHp }`. */
export function mobState(id) {
  return null
}
