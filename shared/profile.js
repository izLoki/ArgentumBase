/**
 * PLAYER PROFILE — the shared shape of "who a player is".
 *
 * Identity, progression, attributes and the stats derived from them live here
 * so that inventory, combat, stats panels and any data feature all read the
 * same numbers instead of inventing their own.
 *
 * This file is pure data and pure functions: no sockets, no Pixi, no state.
 * The server owns the profile (server/systems/profile.js); the client only
 * mirrors it (client/src/systems/profile.js).
 */

/** Attribute keys, in display order. */
export const ATTRIBUTES = ['str', 'agi', 'int', 'con']

export const ATTRIBUTE_LABELS = {
  str: 'Strength',
  agi: 'Agility',
  int: 'Intellect',
  con: 'Constitution',
}

/**
 * Derived stat keys. A modifier may only touch these.
 *
 * There is no mana: cooldown is the only limit on spells, so intelligence
 * lands on `spellPower` and `cdr` instead. Both are integer percentages —
 * `deriveStats` rounds every key, so fractional stats do not survive.
 */
export const STAT_KEYS = ['maxHp', 'damage', 'defense', 'evasion', 'spellPower', 'cdr']

export const STAT_LABELS = {
  maxHp: 'Max HP',
  damage: 'Damage',
  defense: 'Defense',
  evasion: 'Evasion',
  spellPower: 'Spell power',
  cdr: 'Cooldown red.',
}

/** Cooldown reduction ceiling, in percent. Clamped again at the use site. */
export const CDR_MAX = 45

/** Starting attributes per class. */
export const BASE_ATTRIBUTES = {
  warrior: { str: 12, agi: 7, int: 4, con: 12 },
  mage: { str: 4, agi: 8, int: 14, con: 6 },
  hunter: { str: 8, agi: 14, int: 6, con: 8 },
}

/**
 * Attributes grow only on level up, toward a fixed per-class target reached
 * at `MAX_LEVEL` — the same cap for every class. There is no manual point
 * spending, which is why `POINTS_PER_LEVEL` is zero.
 */
export const MAX_LEVEL = 20

/** Total attribute points gained between level 1 and `MAX_LEVEL`, per class. */
export const GROWTH_TOTAL = {
  warrior: { str: 38, agi: 19, int: 0, con: 38 },
  mage: { str: 0, agi: 19, int: 57, con: 19 },
  hunter: { str: 19, agi: 57, int: 19, con: 19 },
}

export const POINTS_PER_LEVEL = 0

/**
 * The class's attributes at `level`, linearly interpolated between
 * `BASE_ATTRIBUTES` at level 1 and `BASE_ATTRIBUTES + GROWTH_TOTAL` at
 * `MAX_LEVEL`. Recomputing from `level` rather than accumulating a per-level
 * delta guarantees the total lands exactly on target with no rounding drift.
 */
export function attributesAtLevel(cls, level) {
  const base = BASE_ATTRIBUTES[cls] ?? BASE_ATTRIBUTES.warrior
  const total = GROWTH_TOTAL[cls] ?? {}
  const t = (Math.min(level, MAX_LEVEL) - 1) / (MAX_LEVEL - 1)

  const out = {}
  for (const attr of ATTRIBUTES) out[attr] = base[attr] + Math.round((total[attr] ?? 0) * t)
  return out
}

/** Experience needed to go from `level` to `level + 1`. */
export function expForLevel(level) {
  return 50 * level * (level + 1)
}

/**
 * @typedef {Object} Profile
 * @property {string} id
 * @property {string} name
 * @property {string} cls
 * @property {number} level
 * @property {number} exp        progress inside the current level
 * @property {number} expToNext
 * @property {number} gold
 * @property {number} points     unspent attribute points
 * @property {Record<string, number>} attributes
 * @property {Object} ext        per-system profile data: ext.<systemId>
 */

/** @returns {Profile} */
export function createProfile({ id, name, cls }) {
  const klass = BASE_ATTRIBUTES[cls] ? cls : 'warrior'

  return {
    id,
    name,
    cls: klass,
    level: 1,
    exp: 0,
    expToNext: expForLevel(1),
    gold: 0,
    points: 0,
    attributes: { ...BASE_ATTRIBUTES[klass] },
    // Namespace for other systems. Write only your own key: profile.ext.trade
    ext: {},
  }
}

/**
 * Derived stats = class/level/attribute baseline + every registered modifier.
 *
 * Modifiers are how another system contributes bonuses (equipped gear, a buff)
 * without ever writing the profile itself.
 *
 * @param {Profile} profile
 * @param {Array<Record<string, number>>} modifiers
 */
export function deriveStats(profile, modifiers = []) {
  const a = profile.attributes
  const level = profile.level

  const stats = {
    maxHp: 40 + level * 6 + a.con * 4,
    damage: 2 + Math.floor(level / 2) + Math.floor(a.str * 0.8),
    defense: Math.floor(a.con * 0.4) + Math.floor(a.agi * 0.2),
    evasion: Math.floor(a.agi * 0.6),
    spellPower: 100 + a.int * 4, // 100 = neutral
    cdr: Math.min(CDR_MAX, a.int * 1.2), // percent
  }

  for (const mod of modifiers) {
    if (!mod) continue
    for (const key of STAT_KEYS) {
      if (typeof mod[key] === 'number') stats[key] += mod[key]
    }
  }

  for (const key of STAT_KEYS) stats[key] = Math.max(0, Math.round(stats[key]))
  stats.maxHp = Math.max(1, stats.maxHp) // a zero ceiling would kill on sight

  return stats
}

/** Keeps only known numeric stat keys, so a bad modifier cannot inject fields. */
export function pickStats(mods) {
  const clean = {}
  for (const key of STAT_KEYS) {
    if (typeof mods?.[key] === 'number' && Number.isFinite(mods[key])) clean[key] = mods[key]
  }
  return clean
}

/**
 * What every client may know about a player. The rest (gold, exp, attributes)
 * is private and only ever sent to its owner.
 */
export function toPublicProfile(profile) {
  return {
    id: profile.id,
    name: profile.name,
    cls: profile.cls,
    level: profile.level,
  }
}
