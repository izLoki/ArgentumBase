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

/** Derived stat keys. A modifier may only touch these. */
export const STAT_KEYS = ['maxHp', 'maxMana', 'damage', 'defense', 'evasion']

export const STAT_LABELS = {
  maxHp: 'Max HP',
  maxMana: 'Max mana',
  damage: 'Damage',
  defense: 'Defense',
  evasion: 'Evasion',
}

/** Starting attributes per class. */
export const BASE_ATTRIBUTES = {
  warrior: { str: 12, agi: 7, int: 4, con: 12 },
  mage: { str: 4, agi: 8, int: 14, con: 6 },
  archer: { str: 8, agi: 14, int: 6, con: 8 },
}

export const LEVEL_MAX = 50
export const POINTS_PER_LEVEL = 3

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
    maxMana: 10 + level * 4 + a.int * 5,
    damage: 2 + Math.floor(level / 2) + Math.floor(a.str * 0.8),
    defense: Math.floor(a.con * 0.4) + Math.floor(a.agi * 0.2),
    evasion: Math.floor(a.agi * 0.6),
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
