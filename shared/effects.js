/**
 * EFFECTS TABLE — every durable state in the game, whatever produced it.
 *
 * Buffs, debuffs, gear bonuses, potions and spawn protection are one table,
 * one tick loop, one expiry path and one status-icon UI. Adding poison is a
 * row here, not code. Instant damage is NOT an effect: that is an event.
 *
 * DEFINITION VERSUS INSTANCE — the thing to get right (ARENA.md §3.3).
 *
 * The definition declares identity and behaviour; the APPLICATION SITE supplies
 * the magnitude; the instance stores the resolved numbers. Baking `hp: -4` into
 * `burning` would make every burn in the game identical, and two spells that
 * both burn — one harder than the other — could not be expressed at all.
 *
 *   definition   burning: { kind:'dot', everyMs:500, defaults:{ tick:{hp:-4} } }
 *   application  { type:'effect', effect:'burning', ms:5000, params:{ tick:{hp:-11} } }
 *   instance     { id:'burning', endsAt, params:{ tick:{hp:-11} }, sourceId, stacks }
 *
 * Params resolve ONCE, at application time, from the caster's stats as they
 * were at that moment. A DoT does not get weaker because its caster died or
 * swapped gear mid-burn — simpler to reason about and cheaper than re-reading
 * the caster every tick.
 *
 * Definition fields (only `name` and `stacking` are read everywhere):
 *
 *   name, icon   what the status UI shows
 *   kind         'dot' | 'aura' — which runtime path handles it
 *   everyMs      tick period, when `defaults.tick` exists
 *   stacking     see STACKING below
 *   maxStacks    ceiling for `stacking: 'stack'`
 *   school       what a tick's damage counts as, so `taken:{fire:+30}` bites
 *
 * Field meanings inside `defaults` (all optional):
 *
 *   stats  { damage:+8 }    folded into deriveStats via setModifier('effects')
 *   flags  { rooted:true }  booleans; modifiers cannot carry these
 *   taken  { all:+20 }      percent damage taken, read by the damage pipeline
 *   dealt  { melee:+15 }    percent damage dealt, read by the damage pipeline
 *   tick   { hp:+6 }        applied every `everyMs` while active
 *
 * `taken` and `dealt` buckets are read by key: `all` always, plus the hit's
 * school and `melee` when it was one. They add up, as percentages.
 */

/** Booleans a system may read with `hasFlag(player, flag)`. */
export const EFFECT_FLAGS = ['invulnerable', 'rooted', 'silenced', 'slowed']

/**
 * How a second application of the same effect behaves.
 *
 *   refresh    the newest replaces the old and brings its own params (controls)
 *   strongest  the bigger magnitude wins (DoTs, stat buffs)
 *   stack      independent instances, each ticking, up to `maxStacks`
 *   perSource  one instance per caster, each with its own params
 */
export const STACKING = ['refresh', 'strongest', 'stack', 'perSource']

export const EFFECTS = {
  burning: {
    name: 'Burning',
    icon: '🔥',
    kind: 'dot',
    everyMs: 500,
    stacking: 'strongest',
    school: 'fire',
    defaults: { tick: { hp: -4 } },
  },

  iceBlock: {
    name: 'Ice Block',
    icon: '🧊',
    kind: 'aura',
    everyMs: 500,
    stacking: 'refresh',
    defaults: {
      flags: { invulnerable: true, rooted: true, silenced: true },
      tick: { hp: +6 },
    },
  },

  marked: {
    name: 'Marked',
    icon: '🎯',
    kind: 'aura',
    stacking: 'refresh',
    defaults: { taken: { all: +20 } },
  },

  rooted: {
    name: 'Rooted',
    icon: '🪢',
    kind: 'aura',
    stacking: 'refresh',
    defaults: { flags: { rooted: true } },
  },

  stunned: {
    name: 'Stunned',
    icon: '💫',
    kind: 'aura',
    stacking: 'refresh',
    defaults: { flags: { rooted: true, silenced: true } },
  },

  rage: {
    name: 'Rage',
    icon: '⚗',
    kind: 'aura',
    stacking: 'strongest',
    defaults: { stats: { damage: +8 } },
  },

  swift: {
    name: 'Swift',
    icon: '🌀',
    kind: 'aura',
    stacking: 'strongest',
    defaults: { stats: { evasion: +6, moveSpeed: +8 } },
  },

  shielded: {
    name: 'Shield Wall',
    icon: '🛡',
    kind: 'aura',
    stacking: 'refresh',
    defaults: { taken: { all: -60 }, flags: { slowed: true } },
  },

  spawnProtected: {
    name: 'Spawn protection',
    icon: '✨',
    kind: 'aura',
    stacking: 'refresh',
    defaults: { flags: { invulnerable: true } },
  },
}

/** The definition, or null for an unknown id. Never throws on bad input. */
export function effectDef(id) {
  return EFFECTS[id] ?? null
}

/**
 * The numbers an instance will actually carry: the definition's `defaults`
 * with the application site's overrides merged over them.
 *
 * `overrides` may be a function, which is what lets a DoT scale with the
 * caster's stats at the moment it lands.
 *
 * @param {string} effectId
 * @param {Object|Function} [overrides]
 * @param {Object} [casterStats]
 */
export function resolveParams(effectId, overrides, casterStats) {
  const def = EFFECTS[effectId]
  if (!def) return null

  const extra = typeof overrides === 'function' ? overrides(casterStats) : overrides
  return mergeParams(def.defaults ?? {}, extra ?? {})
}

/** Two levels deep is all the params shape ever is: `{ stats: { damage: 4 } }`. */
function mergeParams(base, extra) {
  const out = {}
  for (const key of new Set([...Object.keys(base), ...Object.keys(extra)])) {
    out[key] = { ...(base[key] ?? {}), ...(extra[key] ?? {}) }
  }
  return out
}

/**
 * Sums the `stats` contribution of active INSTANCES — `{ id, params, stacks }`
 * — not of definitions. This is what `effects` publishes as its single
 * `setModifier(ctx, player, 'effects', sum)`.
 */
export function sumEffectStats(instances) {
  const total = {}
  for (const entry of instances ?? []) {
    const stats = entry?.params?.stats
    if (!stats) continue
    const stacks = entry.stacks ?? 1
    for (const [key, value] of Object.entries(stats)) {
      total[key] = (total[key] ?? 0) + value * stacks
    }
  }
  return total
}
