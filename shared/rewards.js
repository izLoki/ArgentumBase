/**
 * KILL REWARDS — flat per victim, plus the anti-snowball levers.
 *
 * Who you killed decides how much you get, never which attribute grows: the
 * class curve in shared/profile.js owns that.
 *
 * Death costs nothing in this arena, so without the levers below whoever gets
 * ahead stays ahead. At least two must be on before the arena is playable.
 */

export const XP_REWARD = {
  player: { warrior: 130, mage: 140, hunter: 135 },
  npc: { wisp: 28, imp: 30, golem: 45, dragon: 80 },
}

export const COIN_REWARD = {
  player: { warrior: 45, mage: 45, hunter: 45 },
  npc: { wisp: 9, imp: 10, golem: 14, dragon: 26 },
}

/** Killing the same victim again inside this window pays less each time. */
export const REPEAT_KILL_WINDOW_MS = 45_000

/**
 * Anti-snowball levers. Two are on, which is the documented minimum;
 * `bounty` needs a leaderboard, so it waits until `combat` publishes one.
 */
export const SNOWBALL = {
  /** Reward shrinks as the KILLER levels: `1 - lvl * step`, floored. */
  diminishing: { enabled: true, step: 0.02, floor: 0.25 },
  /** Nth kill of the same victim inside the window pays `decay ** (n - 1)`. */
  repeatDecay: { enabled: true, decay: 0.45, floor: 0.1 },
  /** The current leader is worth more to everyone else. */
  bounty: { enabled: false, perLevelAhead: 0.08, cap: 1.6 },
}

/**
 * Base reward for a victim, before any lever.
 *
 * @param {'player'|'npc'} kind
 * @param {string} type  class name for players, mob type for npcs
 * @param {number} level victim level; players scale with it, mobs do not
 */
export function baseReward(kind, type, level = 1) {
  const exp = XP_REWARD[kind]?.[type] ?? 0
  const coins = COIN_REWARD[kind]?.[type] ?? 0
  if (kind !== 'player') return { exp, coins }

  // A level 20 victim is worth more than a fresh one, or farming spawns wins.
  const scale = 1 + (Math.max(1, level) - 1) * 0.06
  return { exp: Math.round(exp * scale), coins: Math.round(coins * scale) }
}

/** Combined multiplier of every enabled lever. Always > 0. */
export function rewardMultiplier({ killerLevel = 1, repeats = 0, levelsAhead = 0 } = {}) {
  let mult = 1

  const dim = SNOWBALL.diminishing
  if (dim.enabled) {
    mult *= Math.max(dim.floor, 1 - Math.max(0, killerLevel - 1) * dim.step)
  }

  const rep = SNOWBALL.repeatDecay
  if (rep.enabled && repeats > 0) {
    mult *= Math.max(rep.floor, rep.decay ** repeats)
  }

  const bounty = SNOWBALL.bounty
  if (bounty.enabled && levelsAhead > 0) {
    mult *= Math.min(bounty.cap, 1 + levelsAhead * bounty.perLevelAhead)
  }

  return mult
}

/**
 * The number `combat` actually hands to `addExp` and `addGold`.
 *
 * @param {Object} kill
 * @param {'player'|'npc'} kill.victimKind
 * @param {string} kill.victimType
 * @param {number} [kill.victimLevel]
 * @param {number} [kill.killerLevel]
 * @param {number} [kill.repeats]      kills of this victim inside the window
 * @param {number} [kill.levelsAhead]  how far the victim leads the pack
 */
export function rewardFor(kill) {
  const base = baseReward(kill?.victimKind, kill?.victimType, kill?.victimLevel ?? 1)
  const mult = rewardMultiplier(kill ?? {})
  return { exp: Math.round(base.exp * mult), coins: Math.round(base.coins * mult) }
}
