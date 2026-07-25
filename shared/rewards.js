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
  // A bat is worth roughly a quarter of a dragon, which is about the ratio of
  // effort: the dragon is the only monster that can actually kill a healthy
  // player, and the bat is a mosquito that flees on contact.
  npc: { bat: 22, skeleton: 30, golem: 55, dragon: 95 },
}

/**
 * Coins MINTED by a kill. Monsters only: they carry no purse, so their coins
 * have to come from somewhere.
 *
 * A player pays their killer out of their own gold instead — see
 * `PURSE_LOOT_PCT`. That is why there is no `player` row here.
 */
export const COIN_REWARD = {
  npc: { bat: 7, skeleton: 10, golem: 14, dragon: 26 },
}

/**
 * How much of a victim's purse their killer takes. It is a TRANSFER: the
 * victim loses exactly what the killer gains, so player-versus-player coins
 * can never inflate the economy the shop is priced against.
 *
 * This is also the sharpest anti-snowball lever in the game, and the only one
 * that makes dying cost something. Killing the same broke player twice pays
 * nothing the second time without any decay rule having to say so, and a rich
 * leader is worth hunting — which is precisely the bounty effect §1.5 wanted.
 */
export const PURSE_LOOT_PCT = 50

/** What a killer takes from a purse of `gold`. Never more than is there. */
export function purseLoot(gold) {
  const purse = Math.max(0, Math.floor(gold ?? 0))
  return Math.floor(purse * (PURSE_LOOT_PCT / 100))
}

/**
 * Floor under a player kill, so beating someone who happens to be broke is
 * never worth literally nothing.
 *
 * Unlike the looted part this IS minted, which is exactly why it goes through
 * the levers: at level 20 it is worth 5, and spawn-camping the same corpse
 * decays it to 1 within three kills. Small enough that farming the poor can
 * never compete with taking half of somebody rich.
 */
export const MIN_KILL_COINS = 8

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
 * `coins` is 0 for a player: their killer loots the purse instead, which
 * `rewardFor` resolves because only it knows how much gold the victim had.
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
  return { exp: Math.round(exp * scale), coins: 0 }
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
 * The numbers `combat` actually hands to `addExp` and `addGold`.
 *
 * Experience and monster coins are minted, so both go through the levers.
 * Coins looted from a player do NOT: they are moving between two purses, not
 * appearing from nothing, and shrinking the killer's cut would simply delete
 * the difference. The purse is its own limiter.
 *
 * @param {Object} kill
 * @param {'player'|'npc'} kill.victimKind
 * @param {string} kill.victimType
 * @param {number} [kill.victimLevel]
 * @param {number} [kill.victimGold]   the purse, for a player victim
 * @param {number} [kill.killerLevel]
 * @param {number} [kill.repeats]      kills of this victim inside the window
 * @param {number} [kill.levelsAhead]  how far the victim leads the pack
 * @returns {{exp:number, coins:number, fromPurse:number}} `coins` is what the
 *   killer receives; `fromPurse` is how much of it must be charged to the
 *   victim. The difference is minted, so the caller never takes gold a player
 *   did not have.
 */
export function rewardFor(kill) {
  const base = baseReward(kill?.victimKind, kill?.victimType, kill?.victimLevel ?? 1)
  const mult = rewardMultiplier(kill ?? {})
  const exp = Math.round(base.exp * mult)

  if (kill?.victimKind !== 'player') {
    return { exp, coins: Math.round(base.coins * mult), fromPurse: 0 }
  }

  // The purse is the reward; the floor only shows up when the purse is thin,
  // and being minted it is the only part the levers can touch.
  const fromPurse = purseLoot(kill?.victimGold)
  const floor = Math.round(MIN_KILL_COINS * mult)
  return { exp, coins: Math.max(fromPurse, floor), fromPurse }
}
