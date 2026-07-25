/**
 * SPELLS SYSTEM (server) — the one executor every caster goes through.
 *
 * A dragon's fireball is literally `SPELLS.fireball`. `castSpell` takes a
 * CASTER HANDLE, not a player, which is what stops mob casting from becoming
 * a second copy of the projectile code.
 *
 * Adding a spell is one row in shared/spells.js. Adding a new KIND of spell is
 * one entry in the `ACTIONS` registry below.
 *
 * Projectiles travel in the snapshot (`snapshot.ext.spells.proj`), not only in
 * a one-shot event: the base's contract is "snapshots are full state", which
 * makes late joiners and packet loss self-healing. `SPELL_CAST_FX` starts the
 * animation locally so the caster sees zero latency.
 *
 * The spellbook and cooldowns are PRIVATE — `ctx.sendTo`, never the snapshot.
 *
 * ---------------------------------------------------------------------------
 * STATUS: contract frozen, behaviour not implemented (M0).
 * ---------------------------------------------------------------------------
 */

import { C2S } from '../../shared/protocol.js'

/**
 * What a spell is cast BY. Players and mobs both wear this shape, which is the
 * whole trick: the executor never asks which one it has.
 *
 * @typedef {Object} CasterHandle
 * @property {'players'|'npc'} providerId
 * @property {any} ref                   the player or mob behind the handle
 * @property {number} x
 * @property {number} y
 * @property {number} dir
 * @property {string} team
 * @property {Object} stats              derived stats: spellPower, cdr, damage...
 * @property {Object} [attributes]       players only; mobs scale on spellPower alone
 * @property {Map<string, number>} cdUntil  spellId -> timestamp
 */

/**
 * Where a cast is aimed. Which fields matter depends on `def.targeting`.
 *
 * @typedef {Object} CastTarget
 * @property {number} [tx]
 * @property {number} [ty]
 * @property {number} [dir]
 */

/**
 * Action resolvers, keyed by `action.type`. Extend it with `registerAction`
 * rather than editing this object, so a new action never conflicts.
 *
 * @type {Record<string, (ctx:Object, caster:CasterHandle, action:Object, targets:Array, at:{x:number,y:number}) => void>}
 */
const ACTIONS = Object.create(null)

export default {
  id: 'spells',
  enabled: false,

  init(ctx) {
    // B2: fill ACTIONS with damage, heal, effect, teleport, dash, knockback,
    // spawnZone and dispel, then resolve the six targeting shapes.
    ctx.world.ext.spells = { projectiles: [], zones: [], nextId: 1 }
    ctx.log('spells: contract frozen, not implemented yet')
  },

  onPlayerJoin(ctx, player) {
    player.ext.spells = {
      /** Spell ids this player may cast, in slot order. */
      known: [],
      /** spellId -> timestamp the cooldown ends. */
      cdUntil: new Map(),
    }
  },

  onPlayerLeave(ctx, player) {},

  /** Advances projectiles and zones. */
  onTick(ctx, dtMs) {},

  /** Projectiles and visible zones ride here as terse integer arrays. */
  collectSnapshot(ctx) {
    return undefined
  },

  handlers: {
    [C2S.SPELL_CAST](ctx, player, payload) {},
  },
}

/* ---------- API for other systems ---------- */

/**
 * Casts a spell from any caster. Validates cooldown, unlock, range, line of
 * sight and `silenced`, then resolves the targeting shape and runs every
 * action in order.
 *
 * @param {Object} ctx
 * @param {CasterHandle} caster
 * @param {string} spellId
 * @param {CastTarget} [target]
 * @returns {boolean} true when the cast actually went off
 */
export function castSpell(ctx, caster, spellId, target = {}) {
  return false
}

/** Spell ids this player has unlocked, in slot order. */
export function knownSpells(player) {
  return []
}

/**
 * Registers a new action type. Call it from your own system's `init` to teach
 * the executor a trick without editing this file.
 *
 * @param {string} type
 * @param {(ctx:Object, caster:CasterHandle, action:Object, targets:Array, at:{x:number,y:number}) => void} fn
 */
export function registerAction(type, fn) {
  ACTIONS[type] = fn
}

/** Wraps a player in the caster handle shape. Mobs build their own in `npc`. */
export function casterFromPlayer(ctx, player) {
  return null
}

/** Remaining cooldown in ms, or 0 when ready. */
export function cooldownLeft(caster, spellId) {
  return 0
}
