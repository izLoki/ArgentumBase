/**
 * EFFECTS SYSTEM (server) — the one timed layer for buffs, debuffs and gear.
 *
 * Every DURABLE state in the game lives here, whatever produced it: a spell
 * buff, a potion, a gear tier, spawn protection. Instant damage does not —
 * that is an event, not a state.
 *
 * The payoff is that freezing, potions and spawn protection share one tick
 * loop, one expiry path, one status-icon UI and one network shape. Adding
 * poison is a row in shared/effects.js, not code.
 *
 * HOW IT REACHES THE REST OF THE GAME
 *
 *   stats  -> summed and published as ONE setModifier(ctx, player, 'effects', sum)
 *   flags  -> player.ext.effects.flags, read with hasFlag(); modifiers drop booleans
 *   taken  -> a damage-pipeline stage registered with combat
 *   tick   -> heal()/applyDamage() through combat, never a direct hp write
 *
 * THE CHANGE GATE IS MANDATORY. `setModifier` triggers `recompute()` which
 * marks the profile dirty, and `profile.onTick` turns that into a private
 * packet. Republishing an unchanged sum is 15 packets per player per second.
 *
 * DEFINITION VERSUS INSTANCE. The definition in shared/effects.js declares
 * identity and behaviour; the APPLICATION SITE supplies the magnitude; the
 * instance stored here carries the resolved numbers, worked out ONCE from the
 * caster's stats as they were at that moment. A burn does not get weaker
 * because its caster died or swapped gear halfway through.
 *
 * ANYTHING CAN CARRY EFFECTS, not just players. The slot lives on the target
 * itself (`ref.ext.effects`) and this system remembers every carrier in
 * `world.ext.effects.holders`, so a mob burns without `effects` ever importing
 * `npc`. What a mob does NOT get is `stats`: those fold into a profile, and a
 * mob has none — its flags, `taken`/`dealt` buckets and ticks all work.
 *
 * SPAWN PROTECTION IS NOT ROUTED THROUGH HERE. `combat` owns its own, because
 * it is timed AND conditional (attacking spends it) and cancelling it would
 * mean `combat` importing this file — the circular import the whole registry
 * pattern exists to avoid. The `invulnerable` flag below is the same rule by a
 * second, independent road: whichever is active cancels the hit.
 */

import { S2C } from '../../shared/protocol.js'
import { effectDef, resolveParams, sumEffectStats } from '../../shared/effects.js'
import { registerMoveGate } from '../game/state.js'
import {
  applyDamage,
  handleOf,
  heal,
  isAlive,
  onKill,
  registerDamagePipeline,
} from './combat.js'
import { setModifier } from './profile.js'

/** Pipeline slot. Lower runs first: effects before inventory's gear multipliers. */
const PIPELINE_PRIORITY = 10

/** Tick period for a definition that carries `tick` but names no `everyMs`. */
const DEFAULT_TICK_MS = 500

/** Ceiling for `stacking: 'stack'` when the definition does not name one. */
const DEFAULT_MAX_STACKS = 5

/** What a tick counts as when its definition does not say. */
const DEFAULT_SCHOOL = 'physical'

/** The params keys that carry magnitude, which is what `strongest` compares. */
const MAGNITUDE_KEYS = ['stats', 'tick', 'taken', 'dealt']

export default {
  id: 'effects',
  enabled: true,

  init(ctx) {
    ctx.world.ext.effects = {
      /** ref -> TargetHandle, for everything carrying at least one effect. */
      holders: new Map(),
    }

    // `rooted` and `stunned` stop a step without the core learning this file
    // exists. Facing stays free, so a rooted player can still aim.
    registerMoveGate((player) => !hasFlag(player, 'rooted'))

    // `invulnerable` cancels the hit; `taken` and `dealt` rewrite its size.
    registerDamagePipeline(PIPELINE_PRIORITY, damageStage)

    // Death ends every durable state: a corpse does not keep burning, and a
    // respawn must not start under someone else's debuff.
    onKill((killCtx, kill) => clearEffects(killCtx, kill.victim))

    ctx.log('effects ready: timed states, flags, ticks and the damage pipeline')
  },

  onPlayerJoin(ctx, player) {
    player.ext.effects = newSlot()
  },

  onPlayerLeave(ctx, player) {
    ctx.world.ext.effects?.holders.delete(player)
  },

  /**
   * Expiry and ticks. Only carriers are walked, not every player: a world where
   * nobody is burning costs one empty Map iteration per tick.
   */
  onTick(ctx, dtMs) {
    const holders = ctx.world.ext.effects?.holders
    if (!holders?.size) return

    const now = Date.now()

    for (const [ref, handle] of holders) {
      const slot = slotOf(ref)
      if (!slot) {
        holders.delete(ref)
        continue
      }

      // Anything that died without going through a kill — a suicide, a mob
      // despawn — still drops what it was carrying.
      if (!isAlive(handle)) {
        clearEffects(ctx, handle)
        continue
      }

      let expired = false
      // A copy: a tick can kill, and a kill clears the map underneath us.
      for (const instance of [...slot.active.values()]) {
        if (instance.endsAt > 0 && now >= instance.endsAt) {
          slot.active.delete(instance.key)
          expired = true
          continue
        }
        if (now < instance.nextTickAt) continue

        instance.nextTickAt = now + instance.everyMs
        runTick(ctx, handle, instance)
        if (!isAlive(handle)) break
      }

      if (expired) refresh(ctx, handle, slot)
      if (slot.active.size === 0) holders.delete(ref)
    }
  },

  /**
   * Public status icons only — durations are private and ride EFFECTS_SELF.
   *
   * Keyed by provider so the client knows what to anchor each row to:
   * `{ players: { <playerId>: ['burning'] }, npc: { <mobId>: [...] } }`. Effect
   * ids, not icons: the client has the same table and would only be reading a
   * glyph it already owns.
   */
  collectSnapshot(ctx) {
    const holders = ctx.world.ext.effects?.holders
    if (!holders?.size) return undefined

    const out = {}
    for (const [ref, handle] of holders) {
      const active = slotOf(ref)?.active
      if (!active?.size) continue

      const ids = []
      for (const instance of active.values()) {
        if (!ids.includes(instance.id)) ids.push(instance.id)
      }

      const bucket = (out[handle.providerId] ??= {})
      bucket[ref.id] = ids
    }
    return Object.keys(out).length > 0 ? out : undefined
  },

  // No handlers: a client never asks for an effect, it is told about one.
  handlers: {},
}

/* ---------- API for other systems ---------- */

/**
 * Applies (or refreshes) a timed effect.
 *
 * The magnitude comes from the CALLER, never from the table: `opts.params` is
 * merged over the definition's `defaults` and resolved once, here. Pass a
 * function to scale it with the caster:
 *
 *   applyEffect(ctx, target, 'burning', 5000, {
 *     sourceId: caster.id,
 *     source: casterHandle,
 *     params: (stats) => ({ tick: { hp: -(7 + Math.round(stats.damage / 2)) } }),
 *     casterStats: statsOf(caster),
 *   })
 *
 * @param {Object} ctx
 * @param {Object} target             a player, or a target handle from combat
 * @param {string} effectId           a key of EFFECTS in shared/effects.js
 * @param {number} durationMs         0 or less means permanent until removed
 * @param {Object} [opts]
 * @param {string} [opts.sourceId]    who applied it: attribution, and the
 *                                    instance key for `stack` / `perSource`
 * @param {Object} [opts.source]      the caster's handle, so a lethal tick is
 *                                    credited to whoever cast it
 * @param {Object|Function} [opts.params]  magnitude overrides
 * @param {Object} [opts.casterStats] what a function override is handed
 * @param {number} [opts.stacks]
 * @returns {boolean} false when the id is unknown, the target cannot hold
 *   effects, or a `strongest` application lost to the instance already there
 */
export function applyEffect(ctx, target, effectId, durationMs = 0, opts = {}) {
  const def = effectDef(effectId)
  const handle = asHandle(target)
  const slot = handle ? ensureSlot(handle.ref) : null
  if (!def || !slot) return false

  const params = resolveParams(effectId, opts.params, opts.casterStats)
  const sourceId = opts.sourceId ?? null
  const key = instanceKey(effectId, def.stacking, sourceId)
  const existing = slot.active.get(key)

  let stacks = Math.max(1, Math.round(opts.stacks ?? 1))
  if (def.stacking === 'stack' && existing) {
    stacks = Math.min(def.maxStacks ?? DEFAULT_MAX_STACKS, existing.stacks + stacks)
  }

  // `strongest`: the bigger magnitude wins and the weaker application is
  // dropped. That is what makes tuning one spell to burn harder than another
  // mean anything. Equal magnitude replaces, so re-casting still refreshes.
  if (
    def.stacking === 'strongest' &&
    existing &&
    magnitudeOf(existing.params, existing.stacks) > magnitudeOf(params, stacks)
  ) {
    return false
  }

  const now = Date.now()
  const everyMs = def.everyMs ?? DEFAULT_TICK_MS
  const ticking = !!params?.tick

  slot.active.set(key, {
    key,
    id: effectId,
    endsAt: durationMs > 0 ? now + durationMs : 0,
    params,
    stacks,
    sourceId,
    source: opts.source ?? null,
    school: def.school ?? DEFAULT_SCHOOL,
    everyMs,
    // A refresh keeps the rhythm it already had, so re-applying a DoT every
    // second cannot delay its damage forever. The first tick of a new instance
    // lands one period in, so a 3 s burn at 500 ms burns six times.
    nextTickAt: ticking ? inheritedTickAt(existing, now + everyMs) : Infinity,
  })

  ctx.world.ext.effects.holders.set(handle.ref, handle)
  refresh(ctx, handle, slot)
  return true
}

/**
 * Removes an effect early, every instance of it whatever the source.
 * Returns false when it was not active.
 */
export function removeEffect(ctx, target, effectId) {
  const handle = asHandle(target)
  const slot = handle ? slotOf(handle.ref) : null
  if (!slot) return false

  let removed = false
  for (const [key, instance] of slot.active) {
    if (instance.id !== effectId) continue
    slot.active.delete(key)
    removed = true
  }
  if (!removed) return false

  refresh(ctx, handle, slot)
  if (slot.active.size === 0) ctx.world.ext.effects?.holders.delete(handle.ref)
  return true
}

/**
 * Drops everything at once: death, a full dispel, leaving the world.
 * Returns false when there was nothing to drop.
 */
export function clearEffects(ctx, target) {
  const handle = asHandle(target)
  const slot = handle ? slotOf(handle.ref) : null
  if (!slot || slot.active.size === 0) return false

  slot.active.clear()
  ctx.world.ext.effects?.holders.delete(handle.ref)
  refresh(ctx, handle, slot)
  return true
}

/**
 * Reads a boolean state: 'invulnerable' | 'rooted' | 'silenced' | 'slowed'.
 * Booleans never travel as modifiers — `pickStats` drops them.
 */
export function hasFlag(target, flag) {
  return slotOf(refOf(target))?.flags[flag] === true
}

/**
 * Active entries as `{ id, endsAt, stacks, params }[]`, for UI and for the
 * pipeline. Copies, so a reader cannot rewrite the instance it was handed —
 * `params` is shared and must be treated as read-only.
 */
export function activeOf(target) {
  const slot = slotOf(refOf(target))
  if (!slot) return []

  const out = []
  for (const instance of slot.active.values()) {
    out.push({
      id: instance.id,
      endsAt: instance.endsAt,
      stacks: instance.stacks,
      params: instance.params,
    })
  }
  return out
}

/**
 * Percent damage-taken modifier contributed by the active effects: `+20` means
 * this target takes 20% more. The pipeline stage below consumes it; a caller
 * wanting to preview a hit can read it too.
 */
export function takenMultiplier(target, school, melee = false) {
  return sumBucket(refOf(target), 'taken', school, melee)
}

/** The same, for what a source DEALS. Gear's `dealt` is inventory's, not this. */
export function dealtMultiplier(target, school, melee = false) {
  return sumBucket(refOf(target), 'dealt', school, melee)
}

/* ---------- the damage pipeline stage ---------- */

/**
 * Runs before every other stage: an invulnerable target ends the hit outright,
 * and what survives is scaled by both sides' percent buckets.
 *
 * @param {Object} ctx
 * @param {Object} dmg  the packet combat is carrying
 */
function damageStage(ctx, dmg) {
  if (hasFlag(dmg.target, 'invulnerable')) {
    dmg.cancelled = true
    return dmg
  }

  const taken = takenMultiplier(dmg.target, dmg.school, dmg.melee)
  const dealt = dmg.source ? dealtMultiplier(dmg.source, dmg.school, dmg.melee) : 0
  if (taken === 0 && dealt === 0) return dmg

  // Rounding stays in combat: it owns the final number, and rounding twice
  // would let two stacked -1% debuffs eat a whole point.
  dmg.amount = dmg.amount * percentScale(taken) * percentScale(dealt)
  return dmg
}

/** `-60` -> 0.4, and never below zero: a big enough reduction is immunity. */
function percentScale(pct) {
  return Math.max(0, 1 + pct / 100)
}

/* ---------- internals ---------- */

function newSlot() {
  return {
    /** instanceKey -> instance. The key is the effect id, plus the source for
     *  `stack` and `perSource`, which is what lets two casters coexist. */
    active: new Map(),
    /** Cached booleans, rebuilt whenever `active` changes. */
    flags: Object.create(null),
    /** Signature of the last published modifier sum. The change gate. */
    sig: '{}',
    /** Signature of the last EFFECTS_SELF packet. The same gate, for the wire. */
    pubSig: '',
  }
}

/** The slot, or null for something that has never carried an effect. */
function slotOf(ref) {
  return ref?.ext?.effects ?? null
}

/** The slot, created on demand: mobs and drops are not born with one. */
function ensureSlot(ref) {
  if (!ref || typeof ref !== 'object') return null
  if (!ref.ext) ref.ext = Object.create(null)
  if (!ref.ext.effects) ref.ext.effects = newSlot()
  return ref.ext.effects
}

/** A handle stays a handle; a bare object is assumed to be a player. */
function asHandle(target) {
  if (!target) return null
  return target.providerId ? target : handleOf(target)
}

/** Readers only need the entity, so they accept either shape. */
function refOf(target) {
  if (!target) return null
  return target.providerId ? target.ref : target
}

function instanceKey(effectId, stacking, sourceId) {
  return stacking === 'stack' || stacking === 'perSource'
    ? `${effectId}#${sourceId ?? 'anon'}`
    : effectId
}

function inheritedTickAt(existing, fallback) {
  return existing && Number.isFinite(existing.nextTickAt) ? existing.nextTickAt : fallback
}

/** What `strongest` compares: every number the instance would apply. */
function magnitudeOf(params, stacks = 1) {
  let total = 0
  for (const key of MAGNITUDE_KEYS) {
    for (const value of Object.values(params?.[key] ?? {})) {
      if (typeof value === 'number') total += Math.abs(value)
    }
  }
  return total * stacks
}

function sumBucket(ref, field, school, melee) {
  const slot = slotOf(ref)
  if (!slot?.active.size) return 0

  let total = 0
  for (const instance of slot.active.values()) {
    const bucket = instance.params?.[field]
    if (!bucket) continue

    let pct = 0
    if (typeof bucket.all === 'number') pct += bucket.all
    if (school && typeof bucket[school] === 'number') pct += bucket[school]
    if (melee && typeof bucket.melee === 'number') pct += bucket.melee
    total += pct * instance.stacks
  }
  return total
}

/** Everything that has to happen after `active` changes, in one call. */
function refresh(ctx, handle, slot) {
  rebuildFlags(slot)
  republish(ctx, handle, slot)
  flushPrivate(ctx, handle, slot)
}

function rebuildFlags(slot) {
  const flags = Object.create(null)
  for (const instance of slot.active.values()) {
    for (const [flag, on] of Object.entries(instance.params?.flags ?? {})) {
      if (on) flags[flag] = true
    }
  }
  slot.flags = flags
}

/**
 * One modifier for the whole layer, and only when its sum actually moved.
 * Without the gate this is `recompute()` plus a private profile packet on
 * every tick a buff is running.
 */
function republish(ctx, handle, slot) {
  if (handle.providerId !== 'players') return // a mob has no profile to fold into

  const sum = sumEffectStats(slot.active.values())
  const sig = JSON.stringify(sum)
  if (sig === slot.sig) return

  slot.sig = sig
  setModifier(ctx, handle.ref, 'effects', sum)
}

/** Durations are private: they go to their owner alone, never in the snapshot. */
function flushPrivate(ctx, handle, slot) {
  if (handle.providerId !== 'players') return

  const active = []
  let sig = ''
  for (const instance of slot.active.values()) {
    active.push({ id: instance.id, endsAt: instance.endsAt, stacks: instance.stacks })
    sig += `${instance.key}:${instance.endsAt}:${instance.stacks}|`
  }
  if (sig === slot.pubSig) return

  slot.pubSig = sig
  // `now` rides along so the client can rebase the deadlines onto its own
  // clock instead of trusting two machines to agree on what time it is.
  ctx.sendTo(handle.ref.id, S2C.EFFECTS_SELF, { active, now: Date.now() })
}

/**
 * One period of a DoT or HoT. It goes through combat like any other damage, so
 * a lethal burn credits its caster, fires exactly one death and reaches the
 * same pipeline every other hit does.
 */
function runTick(ctx, handle, instance) {
  const hp = instance.params?.tick?.hp
  if (!hp) return

  const amount = Math.abs(hp) * instance.stacks
  if (hp > 0) {
    heal(ctx, handle, amount)
    return
  }

  applyDamage(ctx, handle, amount, {
    // A dead or departed caster still burns, it just stops being credited.
    source: instance.source && isAlive(instance.source) ? instance.source : null,
    school: instance.school,
    spellId: instance.id,
  })
}
