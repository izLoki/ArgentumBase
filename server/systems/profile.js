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

import { S2C } from '../../shared/protocol.js'
import { MOVE_COOLDOWN_MS } from '../../shared/constants.js'
import {
  LEVEL_MAX,
  MOVE_MAX_PCT,
  attributesForLevel,
  createProfile,
  deriveStats,
  expForLevel,
  pickStats,
  toPublicProfile,
} from '../../shared/profile.js'

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

    recompute(ctx, player)
    player.hp = player.maxHp
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

  // No handlers: attributes are derived from class and level, so there is
  // nothing a client can ask this system to change.
  handlers: {},
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

  // Attributes are derived, not stored: a level is the only input. Nothing can
  // desync them, so there is no repair path to write.
  slot.data.attributes = attributesForLevel(slot.data.cls, slot.data.level)

  slot.stats = deriveStats(slot.data, [...slot.modifiers.values()])
  applyVitals(player, slot.stats)
  slot.dirty = true
}

/**
 * The profile owns the ceilings; `combat` owns the current hp. Clamping down
 * is the one exception — a shrinking maxHp must not leave hp above it.
 */
function applyVitals(player, stats) {
  player.maxHp = stats.maxHp
  player.hp = Math.min(player.hp, player.maxHp)

  // Agility has to actually make you faster. The core MOVE handler reads this
  // instead of the constant; the client mirrors it so prediction agrees.
  const pct = Math.min(MOVE_MAX_PCT, stats.moveSpeed ?? 0)
  player.moveCooldownMs = Math.round(MOVE_COOLDOWN_MS * (1 - pct / 100))
}

function privatePacket(player) {
  const slot = player.ext.profile
  return { profile: slot.data, stats: slot.stats }
}
