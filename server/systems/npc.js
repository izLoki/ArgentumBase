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

/** Mob roster. `weight` drives the spawn roll; `spells` go through the executor. */
export const MOB_TYPES = {
  golem: {
    hp: 160,
    stats: { damage: 14, defense: 8, spellPower: 100, cdr: 0 },
    moveMs: 520,
    aggro: 7,
    spells: ['stoneSlam'],
    weight: 3,
  },
  dragon: {
    hp: 220,
    stats: { damage: 11, defense: 5, spellPower: 150, cdr: 20 },
    moveMs: 400,
    aggro: 10,
    spells: ['fireball', 'fireBreath'],
    weight: 1,
  },
  wisp: {
    hp: 60,
    stats: { damage: 7, defense: 2, spellPower: 110, cdr: 10 },
    moveMs: 240,
    aggro: 8,
    spells: ['spark'],
    weight: 4,
  },
  imp: {
    hp: 90,
    stats: { damage: 9, defense: 3, spellPower: 120, cdr: 15 },
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
