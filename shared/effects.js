/**
 * EFFECTS TABLE — every durable state in the game, whatever produced it.
 *
 * Buffs, debuffs, gear bonuses, potions and spawn protection are one table,
 * one tick loop, one expiry path and one status-icon UI. Adding poison is a
 * row here, not code.
 *
 * Instant damage is NOT an effect: that is an event, not a state.
 *
 * Pure data, imported by both sides. The client reads names and icons; the
 * server is the only place that applies them.
 *
 * Entry shape — every field optional except `name`:
 *
 *   stats: { damage: +8 }        folded into deriveStats via setModifier('effects')
 *   flags: { rooted: true }      booleans; modifiers cannot carry these
 *   taken: { all: +20 }          percent damage taken, read by the damage pipeline
 *   dealt: { melee: +15 }        percent damage dealt, read by the damage pipeline
 *   tick:  { hp: +6, everyMs: 500 }   periodic hp change while active
 *   stackable: true              a second application adds a stack instead of
 *                                refreshing the timer
 */

/** Booleans a system may read with `hasFlag(player, flag)`. */
export const EFFECT_FLAGS = ['invulnerable', 'rooted', 'silenced', 'slowed']

export const EFFECTS = {
  iceBlock: {
    name: 'Ice Block',
    icon: '🧊',
    flags: { invulnerable: true, rooted: true, silenced: true },
    tick: { hp: +6, everyMs: 500 },
  },
  burning: {
    name: 'Burning',
    icon: '🔥',
    tick: { hp: -4, everyMs: 500 },
  },
  marked: {
    name: 'Marked',
    icon: '🎯',
    taken: { all: +20 },
  },
  rooted: {
    name: 'Rooted',
    icon: '🪢',
    flags: { rooted: true },
  },
  stunned: {
    name: 'Stunned',
    icon: '💫',
    flags: { rooted: true, silenced: true },
  },
  rage: {
    name: 'Rage',
    icon: '⚗',
    stats: { damage: +8 },
  },
  swift: {
    name: 'Swift',
    icon: '🌀',
    stats: { evasion: +6 },
  },
  shielded: {
    name: 'Shield Wall',
    icon: '🛡',
    taken: { all: -60 },
    flags: { slowed: true },
  },
  spawnProtected: {
    name: 'Spawn protection',
    icon: '✨',
    flags: { invulnerable: true },
  },
}

/** The definition, or null for an unknown id. Never throws on bad input. */
export function effectDef(id) {
  return EFFECTS[id] ?? null
}

/** Sums the `stats` contribution of a list of `{ id, stacks }` entries. */
export function sumEffectStats(entries) {
  const total = {}
  for (const entry of entries ?? []) {
    const def = EFFECTS[entry?.id]
    if (!def?.stats) continue
    const stacks = entry.stacks ?? 1
    for (const [key, value] of Object.entries(def.stats)) {
      total[key] = (total[key] ?? 0) + value * stacks
    }
  }
  return total
}
