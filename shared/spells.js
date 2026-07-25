/**
 * SPELL TABLE — pure data and pure functions, mirroring shared/profile.js.
 *
 * The client genuinely needs this table: icons, cooldowns, ranges, unlock
 * levels and the cooldown-sweep maths all live on the client too, and a second
 * copy would drift. The client never executes `actions` — the server is the
 * only place that resolves them.
 *
 * **Adding a spell is one row.** Adding a new *kind* of spell is one entry in
 * the `ACTIONS` registry inside server/systems/spells.js.
 *
 * Row shape:
 *
 *   cls, slot          which class shows it, and in which rail slot (1..5)
 *   cooldownMs         before cooldown reduction
 *   intScaling         how hard cdr cuts THIS cooldown, 0..1
 *   targeting          'self'|'tile'|'ray'|'aoe'|'projectile'|'dash'
 *   range, radius      BLOCKS (Chebyshev) — see the note on units below
 *   speedTps           blocks per second, projectiles only
 *   pierce             keep going after the first target
 *   phasing            dash passes through entities
 *   width              ray width in blocks, for cones
 *   requiresLos        Bresenham line of sight over ctx.isWalkable
 *   fx                 client-side look; the server never reads it
 *   actions            resolved in order by the server executor
 *
 * Action `target` values: 'self' | 'hit' (whatever was struck) | 'area'
 * (everything in radius) | 'tile' (the destination itself).
 *
 * UNITS. Distances here are in BLOCKS, the human scale of the world — "range
 * 8" means eight of the squares terrain is built from, the same reach it read
 * as before the movement grid was subdivided. Coordinates are in TILES, which
 * are `BLOCK_TILES` times finer. The executor converts once, where a range
 * meets a coordinate:
 *
 *   import { blocksToTiles } from './constants.js'
 *   const reach = blocksToTiles(def.range)
 *
 * Forgetting the conversion makes every spell a quarter of its intended reach.
 */

import { CDR_MAX } from './profile.js'

export const SPELLS = {
  /* ---------- mage ---------- */
  fireball: {
    id: 'fireball',
    name: 'Fireball',
    icon: '🔥',
    cls: 'mage',
    slot: 1,
    cooldownMs: 2400,
    intScaling: 0.9,
    targeting: 'projectile',
    range: 8,
    radius: 1,
    speedTps: 9,
    pierce: false,
    stopsOnTerrain: true,
    requiresLos: true,
    fx: { color: 0xff7a3c, shape: 'orb', trail: true, impact: 'burst' },
    actions: [
      { type: 'damage', base: 18, scale: { int: 1.6 }, school: 'fire', target: 'area' },
      { type: 'effect', effect: 'burning', ms: 3000, target: 'area' },
    ],
  },

  lightningRay: {
    id: 'lightningRay',
    name: 'Lightning Ray',
    icon: '⚡',
    cls: 'mage',
    slot: 2,
    cooldownMs: 5200,
    intScaling: 0.8,
    targeting: 'ray',
    range: 7,
    radius: 0,
    pierce: true,
    stopsOnTerrain: true,
    requiresLos: true,
    fx: { color: 0x9ad7ff, shape: 'beam', trail: false, impact: 'spark' },
    actions: [{ type: 'damage', base: 22, scale: { int: 1.4 }, school: 'lightning', target: 'hit' }],
  },

  blink: {
    id: 'blink',
    name: 'Blink',
    icon: '✨',
    cls: 'mage',
    slot: 3,
    cooldownMs: 6500,
    intScaling: 0.6,
    targeting: 'tile',
    range: 5,
    radius: 0,
    requiresLos: true,
    fx: { color: 0xc79bff, shape: 'flash', trail: false, impact: 'flash' },
    actions: [{ type: 'teleport', target: 'tile' }],
  },

  frostNova: {
    id: 'frostNova',
    name: 'Frost Nova',
    icon: '❄',
    cls: 'mage',
    slot: 4,
    cooldownMs: 9000,
    intScaling: 0.7,
    targeting: 'aoe',
    range: 0,
    radius: 2,
    fx: { color: 0x7fd4ff, shape: 'ring', trail: false, impact: 'ring' },
    actions: [
      { type: 'damage', base: 10, scale: { int: 0.6 }, school: 'frost', target: 'area' },
      { type: 'effect', effect: 'rooted', ms: 1500, target: 'area' },
    ],
  },

  iceBlock: {
    id: 'iceBlock',
    name: 'Ice Block',
    icon: '🧊',
    cls: 'mage',
    slot: 5,
    cooldownMs: 26000,
    intScaling: 0.5,
    targeting: 'self',
    range: 0,
    radius: 0,
    fx: { color: 0xbfeaff, shape: 'shell', trail: false, impact: 'none' },
    actions: [{ type: 'effect', effect: 'iceBlock', ms: 4000, target: 'self' }],
  },

  /* ---------- warrior ---------- */
  cleave: {
    id: 'cleave',
    name: 'Cleave',
    icon: '🪓',
    cls: 'warrior',
    slot: 1,
    cooldownMs: 1800,
    intScaling: 0.2,
    targeting: 'ray',
    range: 1,
    radius: 0,
    width: 3, // a cone: the tile ahead plus its two neighbours
    pierce: true,
    stopsOnTerrain: false,
    fx: { color: 0xffd27f, shape: 'arc', trail: false, impact: 'slash' },
    actions: [{ type: 'damage', base: 16, scale: { str: 1.4 }, school: 'physical', target: 'hit' }],
  },

  charge: {
    id: 'charge',
    name: 'Charge',
    icon: '🐎',
    cls: 'warrior',
    slot: 2,
    cooldownMs: 7000,
    intScaling: 0.3,
    targeting: 'dash',
    range: 4,
    radius: 0,
    phasing: false,
    fx: { color: 0xffb35c, shape: 'streak', trail: true, impact: 'slam' },
    actions: [
      { type: 'damage', base: 14, scale: { str: 1.0 }, school: 'physical', target: 'hit' },
      { type: 'effect', effect: 'stunned', ms: 800, target: 'hit' },
    ],
  },

  warCry: {
    id: 'warCry',
    name: 'War Cry',
    icon: '📣',
    cls: 'warrior',
    slot: 3,
    cooldownMs: 12000,
    intScaling: 0.4,
    targeting: 'self',
    range: 0,
    radius: 0,
    fx: { color: 0xff8a5c, shape: 'ring', trail: false, impact: 'ring' },
    actions: [{ type: 'effect', effect: 'rage', ms: 6000, target: 'self' }],
  },

  shieldWall: {
    id: 'shieldWall',
    name: 'Shield Wall',
    icon: '🛡',
    cls: 'warrior',
    slot: 4,
    cooldownMs: 16000,
    intScaling: 0.4,
    targeting: 'self',
    range: 0,
    radius: 0,
    fx: { color: 0x9fb6d4, shape: 'shell', trail: false, impact: 'none' },
    // One effect carrying a buff and a debuff at once.
    actions: [{ type: 'effect', effect: 'shielded', ms: 4000, target: 'self' }],
  },

  whirlwind: {
    id: 'whirlwind',
    name: 'Whirlwind',
    icon: '🌪',
    cls: 'warrior',
    slot: 5,
    cooldownMs: 4000,
    intScaling: 0.5,
    targeting: 'aoe',
    range: 0,
    radius: 1,
    fx: { color: 0xffe0a3, shape: 'ring', trail: false, impact: 'ring' },
    actions: [{ type: 'damage', base: 15, scale: { str: 1.2 }, school: 'physical', target: 'area' }],
  },

  /* ---------- hunter ---------- */
  piercingShot: {
    id: 'piercingShot',
    name: 'Piercing Shot',
    icon: '🏹',
    cls: 'hunter',
    slot: 1,
    cooldownMs: 2000,
    intScaling: 0.8,
    targeting: 'projectile',
    range: 9,
    radius: 0,
    speedTps: 14,
    pierce: true,
    stopsOnTerrain: true,
    requiresLos: true,
    fx: { color: 0xbdf7a0, shape: 'bolt', trail: true, impact: 'spark' },
    actions: [{ type: 'damage', base: 15, scale: { agi: 1.5 }, school: 'physical', target: 'hit' }],
  },

  trap: {
    id: 'trap',
    name: 'Trap',
    icon: '🕳',
    cls: 'hunter',
    slot: 2,
    cooldownMs: 10000,
    intScaling: 0.6,
    targeting: 'tile',
    range: 2,
    radius: 0,
    fx: { color: 0x8fbf6a, shape: 'marker', trail: false, impact: 'none' },
    actions: [
      {
        type: 'spawnZone',
        target: 'tile',
        // Invisible to enemies; the first one to step in is rooted.
        zone: { hidden: true, ttlMs: 20000, radius: 0, triggers: 1, effect: 'rooted', ms: 2000 },
      },
    ],
  },

  huntersMark: {
    id: 'huntersMark',
    name: "Hunter's Mark",
    icon: '🎯',
    cls: 'hunter',
    slot: 3,
    cooldownMs: 9000,
    intScaling: 0.7,
    targeting: 'tile',
    range: 8,
    radius: 0,
    requiresLos: true,
    fx: { color: 0xff6b6b, shape: 'marker', trail: false, impact: 'flash' },
    actions: [{ type: 'effect', effect: 'marked', ms: 8000, target: 'hit' }],
  },

  roll: {
    id: 'roll',
    name: 'Roll',
    icon: '🤸',
    cls: 'hunter',
    slot: 4,
    cooldownMs: 6000,
    intScaling: 0.6,
    targeting: 'dash',
    range: 3,
    radius: 0,
    phasing: true, // passes through entities, unlike Charge
    fx: { color: 0xd7f7a0, shape: 'streak', trail: true, impact: 'none' },
    actions: [{ type: 'effect', effect: 'swift', ms: 1500, target: 'self' }],
  },

  volley: {
    id: 'volley',
    name: 'Volley',
    icon: '🌧',
    cls: 'hunter',
    slot: 5,
    cooldownMs: 11000,
    intScaling: 0.7,
    targeting: 'tile',
    range: 7,
    radius: 1,
    requiresLos: true,
    fx: { color: 0xa0e0f7, shape: 'rain', trail: false, impact: 'ring' },
    actions: [
      {
        type: 'spawnZone',
        target: 'tile',
        zone: {
          hidden: false,
          ttlMs: 2000,
          radius: 1,
          everyMs: 500,
          damage: { base: 7, scale: { agi: 0.5 }, school: 'physical' },
        },
      },
    ],
  },
}

export const CLASS_SPELLS = {
  mage: ['fireball', 'lightningRay', 'blink', 'frostNova', 'iceBlock'],
  warrior: ['cleave', 'charge', 'warCry', 'shieldWall', 'whirlwind'],
  hunter: ['piercingShot', 'trap', 'huntersMark', 'roll', 'volley'],
}

/** Level required for each slot index (0-based). */
export const UNLOCK_LEVELS = [1, 1, 1, 8, 14]

/** Every targeting shape the executor must handle. Keeps the registry honest. */
export const TARGETING = ['self', 'tile', 'ray', 'aoe', 'projectile', 'dash']

/** The definition, or null for an unknown id. Never throws on bad input. */
export function spellDef(id) {
  return SPELLS[id] ?? null
}

/** The five spell ids of a class, in slot order. */
export function spellsForClass(cls) {
  return CLASS_SPELLS[cls] ?? []
}

/** Level at which a slot index unlocks. Unknown slots need level 1. */
export function unlockLevel(slotIndex) {
  return UNLOCK_LEVELS[slotIndex] ?? 1
}

/** Which of a class's spells this level may cast. */
export function knownFor(cls, level) {
  return spellsForClass(cls).filter((_, i) => level >= unlockLevel(i))
}

/**
 * Cooldown after intelligence. `intScaling` decides how much cdr this
 * particular spell gets — a 26 s Ice Block should not become spammable.
 */
export function effectiveCooldown(def, stats) {
  const cdr = Math.min(CDR_MAX, (stats?.cdr ?? 0) * (def?.intScaling ?? 0)) / 100
  return Math.max(0, Math.round((def?.cooldownMs ?? 0) * (1 - cdr)))
}

/**
 * Damage of one `damage` action.
 *
 * Attributes scale the raw number and `spellPower` multiplies the result, so
 * a mob with no attributes still scales through its spellPower alone — that is
 * what lets a dragon cast the very same `SPELLS.fireball`.
 *
 * @param {Object} action  one entry of `def.actions`
 * @param {{ stats?: Object, attributes?: Object }} caster  caster handle
 */
export function spellDamage(action, caster) {
  let raw = action?.base ?? 0

  const attributes = caster?.attributes ?? {}
  for (const [key, factor] of Object.entries(action?.scale ?? {})) {
    raw += (attributes[key] ?? 0) * factor
  }

  const power = caster?.stats?.spellPower ?? 100
  return Math.max(1, Math.round(raw * (power / 100)))
}
