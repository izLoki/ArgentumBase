/**
 * NPC SYSTEM (server) — monsters that spawn, chase and cast.
 *
 * Mobs own their own hp. `combat` never touches it directly: it reaches them
 * through the target provider registered here, which is what keeps the two
 * systems free of circular imports.
 *
 * TICK BUDGET AT 15 Hz. Every mob carries a `nextThinkAt` with a randomised
 * 200-400 ms think interval, so roughly 10-14 of the 24 think per tick rather
 * than all of them. Movement is greedy single-tile stepping — dominant axis
 * first, fall back to the other, random unstick after three blocked attempts.
 * NO PATHFINDING: the arena is open, and A* on 24 mobs at 15 Hz is exactly
 * where this would fall over.
 *
 * ---------------------------------------------------------------------------
 * STATUS: contract frozen, behaviour not implemented (M0).
 * ---------------------------------------------------------------------------
 */

/**
 * Mob roster. `weight` drives the spawn roll; `spells` go through the executor.
 *
 * Mobs carry an `attrs` block on the same [0, 150] scale as players, so
 * `spellDamage()` and `effectiveCooldown()` work on them unchanged — a mob is
 * just another caster handle. `hp` is authored rather than derived, because a
 * mob has no level curve to interpolate.
 *
 * `aggro` and `MIN_SPAWN_DIST` are in BLOCKS, like every gameplay distance in
 * this project. Convert with `blocksToTiles()` before comparing them against
 * coordinates, which are in the finer tile grid. `moveMs` is per BLOCK too:
 * a mob stepping one tile at a time moves every `moveMs / BLOCK_TILES`, and it
 * is authored rather than derived from `agi` — mob movement does not go
 * through the player `MOVE` handler.
 */
export const MOB_TYPES = {
  golem: {
    hp: 220,
    attrs: { str: 110, agi: 15, int: 10, con: 120 },
    stats: { damage: +6, defense: 10 },
    moveMs: 520,
    aggro: 7,
    spells: ['stoneSlam'],
    weight: 3,
  },
  dragon: {
    hp: 260,
    attrs: { str: 60, agi: 45, int: 120, con: 90 },
    stats: { damage: +4, defense: 6 },
    moveMs: 400,
    aggro: 10,
    spells: ['fireball', 'fireBreath'],
    weight: 1,
  },
  wisp: {
    hp: 70,
    attrs: { str: 10, agi: 100, int: 40, con: 20 },
    stats: { damage: +1, defense: 2 },
    moveMs: 240,
    aggro: 8,
    spells: ['spark'],
    weight: 4,
  },
  imp: {
    hp: 110,
    attrs: { str: 25, agi: 50, int: 70, con: 35 },
    stats: { damage: +2, defense: 3 },
    moveMs: 320,
    aggro: 9,
    spells: ['hex'],
    weight: 3,
  },
}

/** Stable order, so the snapshot can send a type index instead of a string. */
export const MOB_TYPE_IDS = Object.keys(MOB_TYPES)

export const MAX_MOBS = 24
export const SPAWN_INTERVAL_MS = 2500
export const MIN_SPAWN_DIST = 10

export default {
  id: 'npc',
  enabled: false,

  init(ctx) {
    // B4: registerBlocker((x, y) => mobAt(x, y) !== null) so mobs occupy
    // tiles, plus registerTargetProvider so combat can hit them.
    ctx.world.ext.npc = { mobs: new Map(), nextId: 1, nextSpawnAt: 0 }
    ctx.log('npc: contract frozen, not implemented yet')
  },

  onTick(ctx, dtMs) {},

  /** Terse: `{ m: [[id, typeIdx, x, y, dir, hp, maxHp], ...] }`. */
  collectSnapshot(ctx) {
    return undefined
  },

  handlers: {},
}

/* ---------- API for other systems ---------- */

/**
 * The living mob standing on a tile, or null.
 * @returns {Object|null}
 */
export function mobAt(x, y) {
  return null
}

/** @returns {Object|null} */
export function mobById(id) {
  return null
}

/** Every living mob. Read-only — mob hp has exactly one writer, this system. */
export function allMobs() {
  return []
}
