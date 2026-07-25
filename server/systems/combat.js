/**
 * COMBAT SYSTEM (server) — damage, death, respawn and kill rewards.
 *
 * STATE OWNERSHIP — the rule that matters most:
 *
 *   maxHp        -> profile   (deriveStats -> applyVitals). Change it ONLY via setModifier.
 *   hp / dead    -> combat    (single writer). Everyone else calls combat's API.
 *   mob hp       -> npc       (combat reaches it only through the registered target provider)
 *
 * Two systems subtracting `hp` independently produces two death events and two
 * rewards. That is the single most likely bug in this design.
 *
 * NO CIRCULAR IMPORTS: `combat` imports nobody downstream. `npc`, `effects`
 * and `inventory` register INTO combat from their own `init(ctx)`, the same
 * way `registerBlocker` already works in the core.
 *
 * ---------------------------------------------------------------------------
 * STATUS: contract frozen, behaviour not implemented (M0). Lane owner fills
 * the bodies in without changing a single signature.
 * ---------------------------------------------------------------------------
 */

import { C2S } from '../../shared/protocol.js'

/**
 * A uniform handle to anything that can be hit. Spells, mob AI and bombs use
 * it without knowing whether they are hitting a player or a dragon.
 *
 * @typedef {Object} TargetHandle
 * @property {string} providerId  'players' | 'npc' | ...
 * @property {any} ref            the provider's own entity
 */

/**
 * @typedef {Object} TargetProvider
 * @property {string} id
 * @property {(x:number, y:number) => any|null} at
 * @property {(id:string) => any|null} byId
 * @property {(ref:any) => {x:number, y:number}} posOf
 * @property {(ref:any) => boolean} isAlive
 * @property {(ref:any) => {kind:string, type:string}} kindOf
 * @property {(ref:any) => string} teamOf
 * @property {(ref:any) => Object} statsFor
 * @property {(ctx:Object, ref:any, amount:number, meta:Object) => number} applyDamage
 * @property {(ctx:Object, ref:any, amount:number) => number} applyHeal
 */

/**
 * @typedef {Object} DamageMeta
 * @property {TargetHandle} [source]   who caused it, when there is one
 * @property {string} [school]         'physical'|'fire'|'frost'|'lightning'
 * @property {boolean} [melee]
 * @property {string} [spellId]
 * @property {boolean} [crit]
 */

/** @type {TargetProvider[]} */
const providers = []
/** @type {Array<{ priority:number, fn:(ctx:Object, dmg:Object) => Object }>} */
const pipeline = []
/** @type {Array<(ctx:Object, kill:Object) => void>} */
const killListeners = []

export default {
  id: 'combat',
  enabled: false,

  init(ctx) {
    // A3: register the 'players' provider here, so combat treats players and
    // mobs through the exact same handle.
    ctx.log('combat: contract frozen, not implemented yet')
  },

  onPlayerJoin(ctx, player) {
    player.ext.combat = { kills: 0, deaths: 0, respawnAt: 0, lastHitBy: null }
  },

  onPlayerLeave(ctx, player) {},

  onTick(ctx, dtMs) {},

  collectSnapshot(ctx) {
    return undefined
  },

  handlers: {
    [C2S.COMBAT_ATTACK](ctx, player, payload) {},
    [C2S.COMBAT_RESPAWN](ctx, player, payload) {},
  },
}

/* ---------- registries: downstream systems plug in here ---------- */

/**
 * Declares a family of targetable entities. Call it from your `init(ctx)`.
 * `npc` registers mobs this way; `combat` registers players itself.
 */
export function registerTargetProvider(provider) {
  providers.push(provider)
}

/**
 * A stage that rewrites a damage packet before it lands. Lower priority runs
 * first: `effects` (invulnerable, damage-taken multipliers) then `inventory`
 * (gear multipliers and limiters).
 *
 * @param {number} priority
 * @param {(ctx:Object, dmg:Object) => Object} fn
 */
export function registerDamagePipeline(priority, fn) {
  pipeline.push({ priority, fn })
  pipeline.sort((a, b) => a.priority - b.priority)
}

/**
 * Runs after a kill is confirmed, exactly once.
 * `loot` spawns drops here; anything that reacts to a death belongs here too.
 *
 * @param {(ctx:Object, kill:{killer:TargetHandle|null, victim:TargetHandle, victimKind:string, victimType:string}) => void} fn
 */
export function onKill(fn) {
  killListeners.push(fn)
}

/* ---------- API for other systems ---------- */

/**
 * The only way to reduce anything's hp. Runs the damage pipeline, applies the
 * result through the target's provider, emits COMBAT_HIT and handles death.
 *
 * @param {Object} ctx
 * @param {TargetHandle|Object} target  a handle, or a player object
 * @param {number} amount               positive; the pipeline may change it
 * @param {DamageMeta} [meta]
 * @returns {number} damage actually dealt
 */
export function applyDamage(ctx, target, amount, meta = {}) {
  return 0
}

/**
 * The only way to increase anything's hp. Clamps at maxHp and never revives.
 *
 * @returns {number} hp actually restored
 */
export function heal(ctx, target, amount) {
  return 0
}

/**
 * The first living target standing on a tile, across every provider.
 * @returns {TargetHandle|null}
 */
export function targetAt(ctx, x, y) {
  return null
}

/**
 * Every living target within `radius` TILES (Chebyshev) of a tile.
 *
 * Tiles, not blocks: this takes coordinates, so callers holding a range from a
 * data table convert it with `blocksToTiles()` first.
 *
 * @param {Object} [opts]
 * @param {TargetHandle} [opts.exclude]  usually the caster
 * @param {string} [opts.team]           only targets NOT on this team
 * @returns {TargetHandle[]}
 */
export function targetsInRadius(ctx, x, y, radius, opts = {}) {
  return []
}

/** Looks a target up by provider and id, for handles that must survive a tick. */
export function targetById(ctx, providerId, id) {
  return null
}

/** @returns {{x:number, y:number}|null} */
export function posOf(handle) {
  return null
}

export function isAlive(handle) {
  return false
}

/** @returns {{kind:string, type:string}|null} — `{kind:'player', type:'mage'}` */
export function kindOf(handle) {
  return null
}

/** Everyone is hostile to everyone today; this is what lets teams exist later. */
export function teamOf(handle) {
  return null
}

/** Derived stats of whatever the handle points at. */
export function statsFor(handle) {
  return null
}

/** Wraps a player object in the handle shape the rest of the API expects. */
export function handleOf(player) {
  return null
}

/** Read-only view of the scoreboard: `{ id, name, kills, deaths }[]`. */
export function scoreboard(ctx) {
  return []
}
