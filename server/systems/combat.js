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
 */

import { C2S, S2C, ERROR_CODE } from '../../shared/protocol.js'
import { DIR_VEC, blocksToTiles } from '../../shared/constants.js'
import { SPELLS, ATTACK_ID, effectiveCooldown, spellDamage } from '../../shared/spells.js'
import { world, playerAt, isTileOccupied } from '../game/state.js'
import { findFreeTile, SPAWN } from '../world/map.js'
import { profileOf, statsOf } from './profile.js'

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

/**
 * What the pipeline rewrites. A stage receives it, mutates or replaces it, and
 * returns it. Every field is already resolved when the first stage runs.
 *
 * @typedef {Object} DamagePacket
 * @property {TargetHandle} target
 * @property {TargetHandle|null} source
 * @property {number} amount       damage so far; a stage may scale or zero it
 * @property {string} school
 * @property {boolean} melee
 * @property {string|null} spellId
 * @property {boolean} crit
 * @property {boolean} cancelled   set by a stage to drop the hit entirely
 */

/** How long a corpse waits before COMBAT_RESPAWN is allowed. */
const RESPAWN_DELAY_MS = 3000
/** ...and when it happens on its own, for a player who never taps. */
const AUTO_RESPAWN_MS = 8000

/**
 * Invulnerability granted on respawn. Timed AND conditional: it ends the
 * moment the protected player deals damage, so it cannot be used to open a
 * fight for free. When `effects` lands (A1) its `invulnerable` flag cancels
 * damage through the pipeline; this is the same rule, owned by combat so
 * respawning works while `effects` is still disabled.
 */
const SPAWN_PROTECT_MS = 3000

/**
 * Defense and evasion are gear-and-effect stats — no attribute feeds them — so
 * combat is the only place that can consume them.
 *
 * Defense mitigates by ratio rather than flat subtraction: `K / (K + defense)`
 * never reaches zero, so stacking armor has diminishing returns and no spell
 * is ever fully negated. At the tier 3 ceiling (~22 defense) a hit lands at
 * about 82%.
 */
const DEFENSE_SOFTNESS = 100
/** Evasion is a percentage chance to take nothing at all, hard capped. */
const EVASION_MAX_PCT = 40

/** @type {TargetProvider[]} */
const providers = []
/** @type {Array<{ priority:number, fn:(ctx:Object, dmg:DamagePacket) => DamagePacket }>} */
const pipeline = []
/** @type {Array<(ctx:Object, kill:Object) => void>} */
const killListeners = []

export default {
  id: 'combat',
  enabled: true,

  init(ctx) {
    registerTargetProvider(PLAYERS_PROVIDER)
    ctx.log('combat ready: damage pipeline, melee, death and respawn')
  },

  onPlayerJoin(ctx, player) {
    player.ext.combat = {
      kills: 0,
      deaths: 0,
      /** Earliest COMBAT_RESPAWN, and when it happens by itself. */
      respawnAt: 0,
      autoRespawnAt: 0,
      /** Spawn protection deadline; 0 once it has been spent or expired. */
      protectedUntil: Date.now() + SPAWN_PROTECT_MS,
      /** Melee cooldown, the same shape spells will use for slot 0. */
      nextAttackAt: 0,
      lastHitBy: null,
    }
  },

  onPlayerLeave(ctx, player) {},

  /** Nothing here decides an outcome: it only lets time pass. */
  onTick(ctx, dtMs) {
    const now = Date.now()
    for (const player of ctx.world.players.values()) {
      const slot = player.ext.combat
      if (!slot || !player.dead) continue
      if (now >= slot.autoRespawnAt) respawn(ctx, player)
    }
  },

  collectSnapshot(ctx) {
    // A4 publishes the scoreboard here. A3 has nothing continuous to say:
    // hp and `dead` already ride the core PlayerView.
    return undefined
  },

  handlers: {
    /**
     * The basic attack. It reads `SPELLS.attack` rather than carrying its own
     * numbers, so when the spell executor lands (B2) the ⚔ button moves onto
     * the same code path without the damage changing.
     */
    [C2S.COMBAT_ATTACK](ctx, player, payload) {
      if (player.dead) return

      const def = SPELLS[ATTACK_ID]
      const slot = player.ext.combat
      const now = Date.now()
      if (now < slot.nextAttackAt) return

      slot.nextAttackAt = now + effectiveCooldown(def, statsOf(player))

      const target = meleeTargetOf(ctx, player, def)
      if (!target) return

      const attacker = handleOf(player)
      for (const action of def.actions) {
        if (action.type !== 'damage') continue
        const amount = spellDamage(action, profileOf(player)?.attributes, statsOf(player))
        applyDamage(ctx, target, amount, {
          source: attacker,
          school: action.school,
          melee: true,
          spellId: def.id,
        })
      }
    },

    /** Respawn early, once the minimum wait has passed. */
    [C2S.COMBAT_RESPAWN](ctx, player, payload) {
      const slot = player.ext.combat
      if (!player.dead) return
      if (Date.now() < slot.respawnAt) {
        return ctx.fail(player, ERROR_CODE.RATE_LIMIT, 'still respawning')
      }
      respawn(ctx, player)
    },
  },
}

/* ---------- the players provider ---------- */

/**
 * Players seen through the same handle as everything else. Registered by
 * combat itself; `npc` registers mobs from its own `init`.
 *
 * `teamOf` returns the player's own id: everyone is hostile to everyone today,
 * so each player is their own team and `opts.team` filters correctly for PvP.
 * Real teams later means returning a shared id here and nothing else changes.
 *
 * @type {TargetProvider}
 */
const PLAYERS_PROVIDER = {
  id: 'players',
  at: (x, y) => playerAt(x, y),
  byId: (id) => world.players.get(id) ?? null,
  posOf: (ref) => ({ x: ref.x, y: ref.y }),
  isAlive: (ref) => !ref.dead && ref.hp > 0,
  kindOf: (ref) => ({ kind: 'player', type: ref.cls }),
  teamOf: (ref) => ref.id,
  statsFor: (ref) => statsOf(ref),

  /** The single writer of `player.hp`. Nothing else in the repo may do this. */
  applyDamage(ctx, ref, amount, meta) {
    const before = ref.hp
    ref.hp = Math.max(0, ref.hp - amount)
    return before - ref.hp
  },

  applyHeal(ctx, ref, amount) {
    const before = ref.hp
    ref.hp = Math.min(ref.maxHp, ref.hp + amount)
    return ref.hp - before
  },
}

/* ---------- registries: downstream systems plug in here ---------- */

/**
 * Declares a family of targetable entities. Call it from your `init(ctx)`.
 * `npc` registers mobs this way; `combat` registers players itself.
 */
export function registerTargetProvider(provider) {
  if (!provider?.id || providers.some((p) => p.id === provider.id)) return
  providers.push(provider)
}

/**
 * A stage that rewrites a damage packet before it lands. Lower priority runs
 * first: `effects` (invulnerable, damage-taken multipliers) then `inventory`
 * (gear multipliers and limiters).
 *
 * @param {number} priority
 * @param {(ctx:Object, dmg:DamagePacket) => DamagePacket} fn
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
  const handle = asHandle(target)
  if (!handle || !isAlive(handle) || !(amount > 0)) return 0

  const provider = providerOf(handle)

  // Attacking spends spawn protection: it is a shield to get out of the spawn
  // with, not a free opening move.
  spendProtection(meta.source)

  /** @type {DamagePacket} */
  let dmg = {
    target: handle,
    source: meta.source ?? null,
    amount,
    school: meta.school ?? 'physical',
    melee: meta.melee === true,
    spellId: meta.spellId ?? null,
    crit: meta.crit === true,
    cancelled: isProtected(handle),
  }

  for (const stage of pipeline) {
    if (dmg.cancelled) break
    dmg = stage.fn(ctx, dmg) ?? dmg
  }
  if (dmg.cancelled || !(dmg.amount > 0)) return 0

  const stats = provider.statsFor(handle.ref) ?? {}
  if (rollEvasion(stats)) {
    emitHit(ctx, handle, 0, dmg)
    return 0
  }

  const final = Math.max(1, Math.round(dmg.amount * mitigation(stats)))
  const dealt = provider.applyDamage(ctx, handle.ref, final, dmg)
  if (!(dealt > 0)) return 0

  rememberAttacker(handle, dmg.source)
  emitHit(ctx, handle, dealt, dmg)

  // Death is decided here and nowhere else, which is what keeps one hit from
  // producing two kill rewards.
  if (!provider.isAlive(handle.ref)) confirmKill(ctx, handle, dmg.source)

  return dealt
}

/**
 * The only way to increase anything's hp. Clamps at maxHp and never revives.
 *
 * @returns {number} hp actually restored
 */
export function heal(ctx, target, amount) {
  const handle = asHandle(target)
  if (!handle || !isAlive(handle) || !(amount > 0)) return 0

  const restored = providerOf(handle).applyHeal(ctx, handle.ref, Math.round(amount))
  if (!(restored > 0)) return 0

  // A heal is a hit with a negative amount, so every number in the game rises
  // and fades through the same client path.
  emitHit(ctx, handle, -restored, { school: 'heal', crit: false, source: null })
  return restored
}

/**
 * The first living target standing on a tile, across every provider.
 * @returns {TargetHandle|null}
 */
export function targetAt(ctx, x, y) {
  for (const provider of providers) {
    const ref = provider.at(x, y)
    if (ref && provider.isAlive(ref)) return { providerId: provider.id, ref }
  }
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
  const out = []
  for (const provider of providers) {
    for (const ref of refsNear(provider, x, y, radius)) {
      if (!provider.isAlive(ref)) continue
      if (opts.exclude && opts.exclude.ref === ref) continue
      if (opts.team !== undefined && provider.teamOf(ref) === opts.team) continue

      const pos = provider.posOf(ref)
      if (Math.abs(pos.x - x) > radius || Math.abs(pos.y - y) > radius) continue
      out.push({ providerId: provider.id, ref })
    }
  }
  return out
}

/** Looks a target up by provider and id, for handles that must survive a tick. */
export function targetById(ctx, providerId, id) {
  const provider = providers.find((p) => p.id === providerId)
  const ref = provider?.byId(id)
  return ref ? { providerId, ref } : null
}

/** @returns {{x:number, y:number}|null} */
export function posOf(handle) {
  const provider = providerOf(handle)
  return provider ? provider.posOf(handle.ref) : null
}

export function isAlive(handle) {
  const provider = providerOf(handle)
  return provider ? provider.isAlive(handle.ref) === true : false
}

/** @returns {{kind:string, type:string}|null} — `{kind:'player', type:'mage'}` */
export function kindOf(handle) {
  const provider = providerOf(handle)
  return provider ? provider.kindOf(handle.ref) : null
}

/** Everyone is hostile to everyone today; this is what lets teams exist later. */
export function teamOf(handle) {
  const provider = providerOf(handle)
  return provider ? provider.teamOf(handle.ref) : null
}

/** Derived stats of whatever the handle points at. */
export function statsFor(handle) {
  const provider = providerOf(handle)
  return provider ? provider.statsFor(handle.ref) : null
}

/** Wraps a player object in the handle shape the rest of the API expects. */
export function handleOf(player) {
  return player ? { providerId: 'players', ref: player } : null
}

/** Read-only view of the scoreboard: `{ id, name, kills, deaths }[]`. */
export function scoreboard(ctx) {
  const rows = []
  for (const player of (ctx?.world ?? world).players.values()) {
    const slot = player.ext.combat
    if (!slot) continue
    rows.push({ id: player.id, name: player.name, kills: slot.kills, deaths: slot.deaths })
  }
  return rows.sort((a, b) => b.kills - a.kills || a.deaths - b.deaths)
}

/* ---------- internals ---------- */

function providerOf(handle) {
  return handle ? providers.find((p) => p.id === handle.providerId) ?? null : null
}

/** Accepts a handle or a bare player, so callers never have to wrap by hand. */
function asHandle(target) {
  if (!target) return null
  return target.providerId ? target : handleOf(target)
}

/**
 * The distinct refs a provider has anywhere near a tile.
 *
 * The frozen provider contract exposes lookups, not iteration, so this scans
 * the box with `at()` and dedupes — a body covers several tiles and would
 * otherwise be returned once per tile. Combat walks its own players directly
 * because it owns them, and a provider may offer an optional `all()` to skip
 * the scan; `npc` works either way, which is why the contract did not change.
 */
function refsNear(provider, x, y, radius) {
  if (provider.id === 'players') return world.players.values()
  if (typeof provider.all === 'function') return provider.all()

  const found = new Set()
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const ref = provider.at(x + dx, y + dy)
      if (ref) found.add(ref)
    }
  }
  return found
}

/** Ratio mitigation from defense: always < 1, never 0. */
function mitigation(stats) {
  const defense = Math.max(0, stats?.defense ?? 0)
  return DEFENSE_SOFTNESS / (DEFENSE_SOFTNESS + defense)
}

function rollEvasion(stats) {
  const pct = Math.min(EVASION_MAX_PCT, Math.max(0, stats?.evasion ?? 0))
  return pct > 0 && Math.random() * 100 < pct
}

function isProtected(handle) {
  const slot = handle.providerId === 'players' ? handle.ref.ext?.combat : null
  return !!slot && Date.now() < slot.protectedUntil
}

/** Protection is timed AND conditional: dealing damage ends it. */
function spendProtection(source) {
  const slot = source?.providerId === 'players' ? source.ref.ext?.combat : null
  if (slot) slot.protectedUntil = 0
}

function rememberAttacker(handle, source) {
  if (handle.providerId !== 'players') return
  const slot = handle.ref.ext?.combat
  if (slot) slot.lastHitBy = source ?? null
}

function emitHit(ctx, handle, amount, dmg) {
  const pos = posOf(handle)
  const what = kindOf(handle)
  ctx.broadcast(S2C.COMBAT_HIT, {
    x: pos.x,
    y: pos.y,
    kind: what.kind,
    id: idOf(handle),
    amount,
    crit: dmg.crit === true,
    school: dmg.school,
    byId: dmg.source ? idOf(dmg.source) : null,
  })
}

function idOf(handle) {
  return handle.ref.id ?? null
}

/**
 * Called exactly once per death, by `applyDamage` and nothing else.
 * Rewards and the kill feed land here in A4; A3 only records and announces.
 */
function confirmKill(ctx, victim, killer) {
  const what = kindOf(victim)

  if (victim.providerId === 'players') killPlayer(ctx, victim.ref)
  if (killer?.providerId === 'players') {
    const slot = killer.ref.ext?.combat
    if (slot && killer.ref !== victim.ref) slot.kills += 1
  }

  ctx.broadcast(S2C.COMBAT_DEATH, {
    kind: what.kind,
    id: idOf(victim),
    name: victim.ref.name ?? what.type,
    killerId: killer ? idOf(killer) : null,
    killerName: killer?.ref?.name ?? null,
  })

  for (const fn of killListeners) {
    try {
      fn(ctx, { killer: killer ?? null, victim, victimKind: what.kind, victimType: what.type })
    } catch (err) {
      console.error('[combat] onKill listener threw:', err)
    }
  }
}

/** The corpse state. `dead` has the same single writer as `hp`. */
function killPlayer(ctx, player) {
  const slot = player.ext.combat
  const now = Date.now()

  player.hp = 0
  player.dead = true
  slot.deaths += 1
  slot.respawnAt = now + RESPAWN_DELAY_MS
  slot.autoRespawnAt = now + AUTO_RESPAWN_MS
  slot.protectedUntil = 0
}

function respawn(ctx, player) {
  const slot = player.ext.combat
  const spot = findFreeTile(SPAWN.x, SPAWN.y, (x, y) => isTileOccupied(x, y, player.id))

  player.x = spot.x
  player.y = spot.y
  player.hp = player.maxHp
  player.dead = false
  slot.respawnAt = 0
  slot.autoRespawnAt = 0
  slot.protectedUntil = Date.now() + SPAWN_PROTECT_MS

  ctx.broadcast(S2C.COMBAT_RESPAWNED, {
    id: player.id,
    x: player.x,
    y: player.y,
    protectedMs: SPAWN_PROTECT_MS,
  })
}

/**
 * The first living body in front of the attacker, within the spell's reach.
 *
 * `def.range` is in BLOCKS, so it converts once here. Bodies are wider than a
 * tile, which is why this walks tile by tile instead of testing the end point.
 */
function meleeTargetOf(ctx, player, def) {
  const vec = DIR_VEC[player.dir]
  const reach = blocksToTiles(def.range)
  const self = handleOf(player)

  for (let step = 1; step <= reach; step++) {
    const target = targetAt(ctx, player.x + vec.x * step, player.y + vec.y * step)
    if (target && target.ref !== self.ref) return target
  }
  return null
}
