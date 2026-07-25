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
 * The reference ceiling every formula is anchored to: what the specialising
 * class reaches at `LEVEL_MAX`. Percent stats are expressed as a fraction of
 * it, so tuning a class means editing `MAX_ATTRIBUTES` and nothing else.
 */
export const ATTR_MAX = 150

/** Global ceilings. Applied again at the use site so gear cannot break them. */
export const CDR_MAX_PCT = 50
export const MOVE_MAX_PCT = 40

/**
 * Derived stat keys. A modifier may only touch these.
 *
 * There is no mana and no spell power: intelligence lands on `cdr` and
 * agility on `moveSpeed`. Both are integer percentages, because `deriveStats`
 * rounds every key and fractional stats would not survive the trip anyway.
 */
export const STAT_KEYS = ['maxHp', 'damage', 'defense', 'evasion', 'cdr', 'moveSpeed']

export const STAT_LABELS = {
  maxHp: 'Max HP',
  damage: 'Damage',
  defense: 'Defense',
  evasion: 'Evasion',
  cdr: 'Cooldown red.',
  moveSpeed: 'Move speed',
}

export const LEVEL_MAX = 20

/** Attributes at level 1. */
export const BASE_ATTRIBUTES = {
  warrior: { str: 20, agi: 12, int: 8, con: 25 },
  mage: { str: 8, agi: 14, int: 25, con: 12 },
  hunter: { str: 12, agi: 25, int: 12, con: 15 },
}

/**
 * Attributes at `LEVEL_MAX`. This is the table balance actually turns on:
 * `mage.int = 150` is what grants the mage the full cooldown reduction, and
 * `hunter.agi = 150` the full movement bonus.
 */
export const MAX_ATTRIBUTES = {
  warrior: { str: 130, agi: 60, int: 40, con: 150 },
  mage: { str: 40, agi: 70, int: 150, con: 70 },
  hunter: { str: 70, agi: 150, int: 75, con: 90 },
}

/**
 * A character's attributes are a PURE FUNCTION of class and level: linear
 * interpolation between the level 1 and level `LEVEL_MAX` blocks.
 *
 * This is why `profile.attributes` is derived rather than stored state —
 * nothing can ever desync them from the level, so there is no repair path to
 * write and no manual point spending to guard.
 */
export function attributesForLevel(cls, level) {
  const lo = BASE_ATTRIBUTES[cls] ?? BASE_ATTRIBUTES.warrior
  const hi = MAX_ATTRIBUTES[cls] ?? MAX_ATTRIBUTES.warrior
  const clamped = Math.min(Math.max(level ?? 1, 1), LEVEL_MAX)
  const t = (clamped - 1) / (LEVEL_MAX - 1)

  const out = {}
  for (const key of ATTRIBUTES) out[key] = Math.round(lo[key] + (hi[key] - lo[key]) * t)
  return out
}

/**
 * Experience needed to go from `level` to `level + 1`.
 *
 * Tuned for a 20-level curve, not the 50-level one this started as: the first
 * level costs about one player kill, and reaching `LEVEL_MAX` costs roughly
 * 17k — a long session, not a grind. A quadratic over only 20 levels would
 * have made the early ones round to nothing.
 */
const EXP_BASE = 120
const EXP_STEP = 90

export function expForLevel(level) {
  return EXP_BASE + EXP_STEP * (Math.max(1, level) - 1)
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
 * @property {Record<string, number>} attributes  derived from cls + level
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
    attributes: attributesForLevel(klass, 1),
    // Namespace for other systems. Write only your own key: profile.ext.trade
    ext: {},
  }
}

/**
 * Derived stats = the attribute baseline + every registered modifier.
 *
 * Note what is NOT derived from attributes: `damage`, `defense` and `evasion`
 * are zero here and come from gear and effects alone. That is deliberate — it
 * keeps the shop meaningful next to a level curve that is otherwise fully
 * determined by class.
 *
 * @param {Profile} profile
 * @param {Array<Record<string, number>>} modifiers
 */
export function deriveStats(profile, modifiers = []) {
  const a = profile.attributes

  const stats = {
    maxHp: 40 + a.con * 4 + Math.round(a.str * 1.5),
    damage: 0, // flat bonus: gear and effects only
    defense: 0, // gear and effects only
    evasion: 0, // gear and effects only
    cdr: Math.min(CDR_MAX_PCT, (a.int / ATTR_MAX) * CDR_MAX_PCT),
    moveSpeed: Math.min(MOVE_MAX_PCT, (a.agi / ATTR_MAX) * MOVE_MAX_PCT),
  }

  for (const mod of modifiers) {
    if (!mod) continue
    for (const key of STAT_KEYS) {
      if (typeof mod[key] === 'number') stats[key] += mod[key]
    }
  }

  for (const key of STAT_KEYS) stats[key] = Math.max(0, Math.round(stats[key]))
  stats.maxHp = Math.max(1, stats.maxHp) // a zero ceiling would kill on sight

  // Gear adds into the same stats, so the global ceilings are applied again
  // here: a tier 3 staff must not push a mage past the cap.
  stats.cdr = Math.min(CDR_MAX_PCT, stats.cdr)
  stats.moveSpeed = Math.min(MOVE_MAX_PCT, stats.moveSpeed)

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
