/**
 * PROFILE SYSTEM (server) — the authoritative player profile.
 *
 * Every feature that deals with who a player is (inventory, stats, combat,
 * quests, any data panel) reads and writes it through the functions exported
 * here instead of keeping a parallel copy of level, gold or stats.
 *
 *   import { profileOf, statsOf, addExp, setModifier } from './profile.js'
 *
 * Contributing bonuses: a system never edits the profile's numbers. It
 * registers a modifier under its own id and the profile folds it into the
 * derived stats:
 *
 *   setModifier(ctx, player, 'inventory', { damage: 4, defense: 2 })
 *   clearModifier(ctx, player, 'inventory')
 *
 * Only the public part travels in the snapshot (`snapshot.ext.profile`). Gold,
 * exp and attributes are private and pushed to their owner alone.
 */

import { C2S, S2C, ERROR_CODE } from '../../shared/protocol.js'
import {
  ATTRIBUTES,
  LEVEL_MAX,
  POINTS_PER_LEVEL,
  createProfile,
  deriveStats,
  expForLevel,
  pickStats,
  toPublicProfile,
} from '../../shared/profile.js'

/** Free points on join, so the demo has something to spend on the spot. */
const STARTING_POINTS = 5

export default {
  id: 'profile',
  enabled: true,

  init(ctx) {
    ctx.log('profile ready: shared identity, progression and derived stats')
  },

  onPlayerJoin(ctx, player) {
    player.ext.profile = {
      data: createProfile(player),
      /** sourceId -> flat stat bonuses. Each system owns its own entry. */
      modifiers: new Map(),
      /** Derived stats cache, rebuilt whenever anything that feeds it changes. */
      stats: null,
      dirty: true,
    }
    player.ext.profile.data.points = STARTING_POINTS

    recompute(ctx, player)
    player.hp = player.maxHp
    player.mana = player.maxMana
  },

  /** Private data cannot ride the snapshot, so it is pushed to its owner. */
  onTick(ctx) {
    for (const player of ctx.world.players.values()) {
      const slot = player.ext.profile
      if (!slot?.dirty) continue
      slot.dirty = false
      ctx.sendTo(player.id, S2C.PROFILE_SELF, privatePacket(player))
    }
  },

  collectSnapshot(ctx) {
    const out = {}
    for (const player of ctx.world.players.values()) {
      const slot = player.ext.profile
      if (slot) out[player.id] = toPublicProfile(slot.data)
    }
    return out
  },

  handlers: {
    [C2S.PROFILE_SPEND_POINT](ctx, player, payload) {
      const attr = payload?.attr
      if (!ATTRIBUTES.includes(attr)) {
        return ctx.fail(player, ERROR_CODE.BAD_PAYLOAD, 'unknown attribute')
      }

      const profile = profileOf(player)
      if (!profile) return
      if (profile.points <= 0) {
        return ctx.fail(player, ERROR_CODE.BAD_PAYLOAD, 'no attribute points left')
      }

      profile.attributes[attr] += 1
      profile.points -= 1
      recompute(ctx, player)
    },
  },
}

/* ---------- API for other systems ---------- */

/** The player's profile, or null before it exists. Read freely; write via the helpers. */
export function profileOf(player) {
  return player?.ext?.profile?.data ?? null
}

/** Derived stats (maxHp, damage, defense, ...) including every modifier. */
export function statsOf(player) {
  return player?.ext?.profile?.stats ?? null
}

/** Grants experience and levels up as many times as the amount allows. */
export function addExp(ctx, player, amount) {
  const profile = profileOf(player)
  if (!profile || !(amount > 0)) return 0

  profile.exp += Math.floor(amount)

  let gained = 0
  while (profile.level < LEVEL_MAX && profile.exp >= profile.expToNext) {
    profile.exp -= profile.expToNext
    profile.level += 1
    profile.points += POINTS_PER_LEVEL
    profile.expToNext = expForLevel(profile.level)
    gained += 1
  }
  if (profile.level >= LEVEL_MAX) profile.exp = 0

  if (gained > 0) {
    ctx.broadcast(S2C.PROFILE_LEVEL_UP, { id: player.id, level: profile.level })
    ctx.announce(`${profile.name} reached level ${profile.level}.`)
  }

  recompute(ctx, player)
  return gained
}

export function addGold(ctx, player, amount) {
  const profile = profileOf(player)
  if (!profile || !Number.isFinite(amount)) return 0
  profile.gold = Math.max(0, profile.gold + Math.floor(amount))
  markDirty(player)
  return profile.gold
}

/** Charges the player. Returns false and changes nothing when they cannot pay. */
export function spendGold(ctx, player, amount) {
  const profile = profileOf(player)
  const cost = Math.floor(amount)
  if (!profile || !(cost > 0) || profile.gold < cost) return false
  profile.gold -= cost
  markDirty(player)
  return true
}

/**
 * Declares this system's contribution to the player's stats. Calling it again
 * replaces the previous contribution from the same source.
 */
export function setModifier(ctx, player, sourceId, mods) {
  const slot = player?.ext?.profile
  if (!slot || !sourceId) return
  slot.modifiers.set(sourceId, pickStats(mods))
  recompute(ctx, player)
}

export function clearModifier(ctx, player, sourceId) {
  const slot = player?.ext?.profile
  if (!slot || !slot.modifiers.delete(sourceId)) return
  recompute(ctx, player)
}

/**
 * Call after writing your own block in `profile.ext.<systemId>` so the owner
 * gets the update on the next tick.
 */
export function markDirty(player) {
  const slot = player?.ext?.profile
  if (slot) slot.dirty = true
}

/* ---------- internals ---------- */

function recompute(ctx, player) {
  const slot = player.ext.profile
  if (!slot) return
  slot.stats = deriveStats(slot.data, [...slot.modifiers.values()])
  applyVitals(player, slot.stats)
  slot.dirty = true
}

/** The profile owns the ceilings; the core keeps the current values. */
function applyVitals(player, stats) {
  player.maxHp = stats.maxHp
  player.maxMana = stats.maxMana
  player.hp = Math.min(player.hp, player.maxHp)
  player.mana = Math.min(player.mana, player.maxMana)
}

function privatePacket(player) {
  const slot = player.ext.profile
  return {
    profile: slot.data,
    stats: slot.stats,
    vitals: { mana: player.mana, maxMana: player.maxMana },
  }
}
