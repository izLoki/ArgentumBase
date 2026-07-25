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
 *   cls, slot          which class shows it, and in which rail slot (0..5)
 *   cooldownMs         before cooldown reduction, which is GLOBAL — there is
 *                      no per-spell cooldown scaling
 *   targeting          'melee'|'nearest'|'self'|'tile'|'ray'|'aoe'|
 *                      'projectile'|'dash'
 *   range, radius      BLOCKS (Chebyshev) — see the note on units below
 *   speedTps           blocks per second, projectiles only
 *   pierce             keep going after the first target
 *   phasing            dash passes through entities
 *   sweeps             dash damages everything it travelled through
 *   width              ray width in blocks, for cones
 *   requiresLos        Bresenham line of sight over ctx.isWalkable
 *   fx                 client-side look; the server never reads it
 *   actions            resolved in order by the server executor
 *
 * Action `target` values: 'self' | 'hit' (whatever was struck) | 'area'
 * (everything in radius) | 'tile' (the destination itself).
 *
 * A damaging action carries exactly two balance knobs, `base` and `scaling`,
 * plus the `attr` they read — see §4.2 of ARENA.md and `spellDamage` below.
 * An effect action carries `params` when it wants a magnitude other than the
 * effect's own defaults, because the table must not bake one in (§3.3).
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

import { ATTR_MAX, CDR_MAX_PCT } from './profile.js'

/** The basic attack. Slot 0, every class, a spell like any other. */
export const ATTACK_ID = 'attack'

export const SPELLS = {
  /* ---------- universal ---------- */
  attack: {
    id: 'attack',
    name: 'Attack',
    icon: '⚔',
    cls: null, // every class
    slot: 0,
    cooldownMs: 700,
    targeting: 'melee',
    range: 1,
    radius: 0,
    fx: { color: 0xffffff, shape: 'slash', trail: false, impact: 'slash' },
    actions: [{ type: 'damage', base: 12, attr: 'str', scaling: 1, school: 'physical', target: 'hit' }],
  },

  /* ---------- mage ---------- */
  fireball: {
    id: 'fireball',
    name: 'Fireball',
    icon: '🔥',
    cls: 'mage',
    slot: 1,
    cooldownMs: 2400,
    targeting: 'projectile',
    range: 8,
    radius: 1,
    speedTps: 9,
    pierce: false,
    stopsOnTerrain: true,
    requiresLos: true,
    fx: { color: 0xff7a3c, shape: 'orb', trail: true, impact: 'burst' },
    actions: [
      { type: 'damage', base: 30, attr: 'int', scaling: 1.2, school: 'fire', target: 'area' },
      { type: 'effect', effect: 'burning', ms: 3000, params: { tick: { hp: -7 } }, target: 'area' },
    ],
  },

  lightningRay: {
    id: 'lightningRay',
    name: 'Lightning Ray',
    icon: '⚡',
    cls: 'mage',
    slot: 2,
    cooldownMs: 5200,
    targeting: 'ray',
    range: 7,
    radius: 0,
    pierce: true,
    stopsOnTerrain: true,
    requiresLos: true,
    fx: { color: 0x9ad7ff, shape: 'beam', trail: false, impact: 'spark' },
    actions: [
      { type: 'damage', base: 34, attr: 'int', scaling: 1.1, school: 'lightning', target: 'hit' },
    ],
  },

  blink: {
    id: 'blink',
    name: 'Blink',
    icon: '✨',
    cls: 'mage',
    slot: 3,
    cooldownMs: 6500,
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
    targeting: 'aoe',
    range: 0,
    radius: 2,
    fx: { color: 0x7fd4ff, shape: 'ring', trail: false, impact: 'ring' },
    actions: [
      { type: 'damage', base: 14, attr: 'int', scaling: 0.6, school: 'frost', target: 'area' },
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
    targeting: 'self',
    range: 0,
    radius: 0,
    fx: { color: 0xbfeaff, shape: 'shell', trail: false, impact: 'none' },
    actions: [{ type: 'effect', effect: 'iceBlock', ms: 4000, target: 'self' }],
  },

  /* ---------- warrior ---------- */
  /**
   * The warrior's own strike, on slot 1.
   *
   * `nearest` because a melee class pressing its bread-and-butter key must
   * connect: facing is an 8 px decision the stick is making constantly, and
   * losing a swing to it reads as the game being broken, not as a miss. It
   * costs a longer cooldown than `attack` for a bigger, aim-free hit.
   */
  bash: {
    id: 'bash',
    name: 'Bash',
    icon: '🗡',
    cls: 'warrior',
    slot: 1,
    cooldownMs: 1100,
    targeting: 'nearest',
    range: 2, // one block of reach beyond the plain attack
    radius: 0,
    fx: { color: 0xffd27f, shape: 'slash', trail: false, impact: 'slash' },
    actions: [
      { type: 'damage', base: 18, attr: 'str', scaling: 1.1, school: 'physical', target: 'hit' },
    ],
  },

  /**
   * A run with the sword out: it phases through bodies and `sweeps` cuts down
   * everything it passed, rather than stopping dead on the first one.
   */
  charge: {
    id: 'charge',
    name: 'Charge',
    icon: '🐎',
    cls: 'warrior',
    slot: 2,
    cooldownMs: 7000,
    targeting: 'dash',
    range: 4,
    radius: 0,
    phasing: true,
    sweeps: true,
    fx: { color: 0xffb35c, shape: 'streak', trail: true, impact: 'slam' },
    actions: [
      { type: 'damage', base: 22, attr: 'str', scaling: 0.9, school: 'physical', target: 'hit' },
      // Shorter than a single-target slam would be: a good charge stuns a line.
      { type: 'effect', effect: 'stunned', ms: 600, target: 'hit' },
    ],
  },

  whirlwind: {
    id: 'whirlwind',
    name: 'Whirlwind',
    icon: '🌪',
    cls: 'warrior',
    slot: 3,
    cooldownMs: 4500,
    targeting: 'aoe',
    range: 0,
    radius: 1,
    fx: { color: 0xffe0a3, shape: 'ring', trail: false, impact: 'ring' },
    actions: [
      { type: 'damage', base: 24, attr: 'str', scaling: 1, school: 'physical', target: 'area' },
    ],
  },

  warCry: {
    id: 'warCry',
    name: 'War Cry',
    icon: '📣',
    cls: 'warrior',
    slot: 4,
    cooldownMs: 12000,
    targeting: 'self',
    range: 0,
    radius: 0,
    fx: { color: 0xff8a5c, shape: 'ring', trail: false, impact: 'ring' },
    actions: [
      { type: 'effect', effect: 'rage', ms: 6000, params: { stats: { damage: +8, defense: +6 } }, target: 'self' },
    ],
  },

  shieldWall: {
    id: 'shieldWall',
    name: 'Shield Wall',
    icon: '🛡',
    cls: 'warrior',
    slot: 5,
    cooldownMs: 16000,
    targeting: 'self',
    range: 0,
    radius: 0,
    fx: { color: 0x9fb6d4, shape: 'shell', trail: false, impact: 'none' },
    // One effect carrying a buff and a debuff at once.
    actions: [{ type: 'effect', effect: 'shielded', ms: 4000, target: 'self' }],
  },

  /* ---------- hunter ---------- */
  piercingShot: {
    id: 'piercingShot',
    name: 'Piercing Shot',
    icon: '🏹',
    cls: 'hunter',
    slot: 1,
    cooldownMs: 2000,
    targeting: 'projectile',
    range: 9,
    radius: 0,
    speedTps: 14,
    pierce: true,
    stopsOnTerrain: true,
    requiresLos: true,
    fx: { color: 0xbdf7a0, shape: 'bolt', trail: true, impact: 'spark' },
    actions: [
      { type: 'damage', base: 26, attr: 'agi', scaling: 1.2, school: 'physical', target: 'hit' },
    ],
  },

  trap: {
    id: 'trap',
    name: 'Trap',
    icon: '🕳',
    cls: 'hunter',
    slot: 2,
    cooldownMs: 10000,
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
          damage: { base: 10, attr: 'agi', scaling: 0.8, school: 'physical' },
        },
      },
    ],
  },

  /* ---------- monsters (ARENA.md §5.1) ----------
   *
   * Ordinary rows with `cls: 'npc'`, which is the whole point of mobs casting
   * through the same executor: a dragon's fire breath is resolved by the very
   * code that resolves Lightning Ray. Nothing here needs a new `targeting`
   * shape or a new action.
   *
   * A mob never has a rail, so `slot` is meaningless and stays 0. Ability
   * CHOICE is a data question: `MOB_TYPES[type].spells` is in priority order
   * and the mob casts the first entry that is off cooldown and whose range
   * covers its target. Retuning a monster means reordering that list.
   */

  /** Dragon filler. Short cooldown, `str`-scaling: what is left over. */
  clawSwipe: {
    id: 'clawSwipe',
    name: 'Claw Swipe',
    icon: '🐾',
    cls: 'npc',
    slot: 0,
    cooldownMs: 1400,
    targeting: 'melee',
    range: 1,
    radius: 0,
    fx: { color: 0xffb27f, shape: 'slash', trail: false, impact: 'slash' },
    actions: [
      { type: 'damage', base: 16, attr: 'str', scaling: 1, school: 'physical', target: 'hit' },
    ],
  },

  /** Occasional. Hits everything around it and knocks it back — the one user
   *  of the `knockback` action. */
  tailSweep: {
    id: 'tailSweep',
    name: 'Tail Sweep',
    icon: '🦎',
    cls: 'npc',
    slot: 0,
    cooldownMs: 6500,
    targeting: 'aoe',
    range: 0,
    radius: 1,
    fx: { color: 0xd9a05c, shape: 'ring', trail: false, impact: 'ring' },
    actions: [
      { type: 'damage', base: 20, attr: 'str', scaling: 0.9, school: 'physical', target: 'area' },
      { type: 'knockback', blocks: 1, target: 'area' },
    ],
  },

  /** The real threat. Long cooldown, `int`-scaling, burns the whole cone. */
  fireBreath: {
    id: 'fireBreath',
    name: 'Fire Breath',
    icon: '🔥',
    cls: 'npc',
    slot: 0,
    cooldownMs: 9500,
    targeting: 'ray',
    range: 4,
    radius: 0,
    width: 3,
    pierce: true,
    stopsOnTerrain: true,
    fx: { color: 0xff5a2c, shape: 'beam', trail: true, impact: 'burst' },
    actions: [
      { type: 'damage', base: 30, attr: 'int', scaling: 1.1, school: 'fire', target: 'hit' },
      { type: 'effect', effect: 'burning', ms: 4000, params: { tick: { hp: -8 } }, target: 'hit' },
    ],
  },

  /** Golem melee: slow and very heavy. */
  stoneFist: {
    id: 'stoneFist',
    name: 'Stone Fist',
    icon: '👊',
    cls: 'npc',
    slot: 0,
    cooldownMs: 2600,
    targeting: 'melee',
    range: 1,
    radius: 0,
    fx: { color: 0xb0a894, shape: 'slash', trail: false, impact: 'slam' },
    actions: [
      { type: 'damage', base: 28, attr: 'str', scaling: 1, school: 'physical', target: 'hit' },
    ],
  },

  /** A lobbed rock, telegraphed by how slowly it travels. */
  boulder: {
    id: 'boulder',
    name: 'Boulder',
    icon: '🪨',
    cls: 'npc',
    slot: 0,
    cooldownMs: 7000,
    targeting: 'projectile',
    range: 6,
    radius: 1,
    speedTps: 5,
    pierce: false,
    stopsOnTerrain: true,
    requiresLos: true,
    fx: { color: 0x8d8375, shape: 'orb', trail: false, impact: 'slam' },
    actions: [
      { type: 'damage', base: 24, attr: 'str', scaling: 0.9, school: 'physical', target: 'area' },
    ],
  },

  /**
   * The skeleton's only ability, and it is an OBSTACLE, not a threat.
   *
   * `base: 2, scaling: 0` ignores the caster's attributes entirely, so it deals
   * the same trivial damage forever and cannot scale into relevance. The point
   * is the root: it interrupts a chase, not a life bar. It is deliberately not
   * zero — `spellDamage` floors at 1, and a skeleton finishing off someone who
   * was already nearly dead is a good story rather than a bug.
   */
  chill: {
    id: 'chill',
    name: 'Chill',
    icon: '🥶',
    cls: 'npc',
    slot: 0,
    cooldownMs: 4500,
    targeting: 'tile',
    range: 4,
    radius: 0,
    requiresLos: true,
    fx: { color: 0xbfe9ff, shape: 'flash', trail: false, impact: 'ring' },
    actions: [
      { type: 'damage', base: 2, attr: 'int', scaling: 0, school: 'frost', target: 'hit' },
      { type: 'effect', effect: 'rooted', ms: 1200, target: 'hit' },
    ],
  },

  /**
   * The bat's only ability. Its damage is ENTIRELY in the DoT, which is why
   * there is no `damage` action here: it bites, poisons and leaves.
   */
  venomBite: {
    id: 'venomBite',
    name: 'Venom Bite',
    icon: '🧪',
    cls: 'npc',
    slot: 0,
    cooldownMs: 5000,
    targeting: 'melee',
    range: 1,
    radius: 0,
    fx: { color: 0x9ad96b, shape: 'slash', trail: false, impact: 'spark' },
    actions: [
      { type: 'effect', effect: 'poisoned', ms: 6000, params: { tick: { hp: -3 } }, target: 'hit' },
    ],
  },
}

/** The five class spells, in slot order. The attack is slot 0 for everyone. */
export const CLASS_SPELLS = {
  mage: ['fireball', 'lightningRay', 'blink', 'frostNova', 'iceBlock'],
  warrior: ['bash', 'charge', 'whirlwind', 'warCry', 'shieldWall'],
  hunter: ['piercingShot', 'trap', 'huntersMark', 'roll', 'volley'],
}

/** Level required for each CLASS_SPELLS index, out of LEVEL_MAX 20. */
export const UNLOCK_LEVELS = [1, 1, 1, 8, 14]

/** Every targeting shape the executor must handle. Keeps the registry honest. */
export const TARGETING = [
  'melee',
  'nearest',
  'self',
  'tile',
  'ray',
  'aoe',
  'projectile',
  'dash',
]

/**
 * Stable id order, so the snapshot can send a small integer instead of a
 * string. Projectiles are the densest thing in `snapshot.ext.spells` and they
 * all carry a spell id — at 15 Hz the difference is worth the indirection.
 *
 * Append-only: a row inserted in the middle would renumber every id and a
 * client mid-flight would draw the wrong spell for one snapshot.
 */
export const SPELL_IDS = Object.keys(SPELLS)

/** The definition, or null for an unknown id. Never throws on bad input. */
export function spellDef(id) {
  return SPELLS[id] ?? null
}

/** Wire index of a spell id, or -1. */
export function spellIndex(id) {
  return SPELL_IDS.indexOf(id)
}

/** The id behind a wire index, or null. */
export function spellFromIndex(index) {
  return SPELL_IDS[index] ?? null
}

/** The five class spells, in slot order. Does not include the attack. */
export function spellsForClass(cls) {
  return CLASS_SPELLS[cls] ?? []
}

/** The whole rail, slot 0 first: `[attack, s1, s2, s3, s4, s5]`. */
export function railForClass(cls) {
  return [ATTACK_ID, ...spellsForClass(cls)]
}

/** Level at which a class spell unlocks, by its index in CLASS_SPELLS. */
export function unlockLevel(index) {
  return UNLOCK_LEVELS[index] ?? 1
}

/** Which of a class's spells this level may cast, attack included. */
export function knownFor(cls, level) {
  const unlocked = spellsForClass(cls).filter((_, i) => level >= unlockLevel(i))
  return [ATTACK_ID, ...unlocked]
}

/**
 * Cooldown after intelligence.
 *
 * Reduction is GLOBAL and identical for every spell — there is no per-spell
 * cooldown scaling. A mage at `int` 150 fires everything at half its base;
 * a warrior at `int` 40 at about 87%.
 */
export function effectiveCooldown(def, stats) {
  const cdr = Math.min(CDR_MAX_PCT, stats?.cdr ?? 0) / 100
  return Math.max(0, Math.round((def?.cooldownMs ?? 0) * (1 - cdr)))
}

/**
 * Damage of one `damage` action.
 *
 * `base` is the floor the spell always delivers, and `scaling` reads directly
 * as a multiplier at `ATTR_MAX`: 0 ignores stats, 1 doubles at the ceiling, 2
 * triples. Gear and effects add their flat `damage` on top afterwards, so the
 * shop helps a level 1 character noticeably and a level 20 one marginally.
 *
 * A mob works unchanged: it carries an `attrs` block on the same [0, 150]
 * scale, which is what lets a dragon cast the very same `SPELLS.fireball`.
 *
 * @param {Object} action  one entry of `def.actions`
 * @param {Record<string, number>} attrs  the caster's attributes
 * @param {Object} [stats]  the caster's derived stats, for the flat bonus
 */
export function spellDamage(action, attrs, stats) {
  const base = action?.base ?? 0
  const a = attrs?.[action?.attr] ?? 0
  const scaled = base * (1 + (action?.scaling ?? 0) * (a / ATTR_MAX))
  return Math.max(1, Math.round(scaled + (stats?.damage ?? 0)))
}
