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
 * ---------------------------------------------------------------------------
 * STATUS: contract frozen, behaviour not implemented (M0).
 * ---------------------------------------------------------------------------
 */

export default {
  id: 'effects',
  enabled: false,

  init(ctx) {
    // A1: registerMoveGate for `rooted`, and registerDamagePipeline for
    // `invulnerable` plus the `taken` multipliers.
    ctx.log('effects: contract frozen, not implemented yet')
  },

  onPlayerJoin(ctx, player) {
    player.ext.effects = {
      /** effectId -> { id, endsAt, stacks, nextTickAt, sourceId } */
      active: new Map(),
      /** Cached booleans, rebuilt whenever `active` changes. */
      flags: Object.create(null),
      /** Signature of the last published modifier sum. The change gate. */
      sig: '',
    }
  },

  onPlayerLeave(ctx, player) {},

  onTick(ctx, dtMs) {},

  /** Public status icons only — durations are private and ride EFFECTS_SELF. */
  collectSnapshot(ctx) {
    return undefined
  },

  handlers: {},
}

/* ---------- API for other systems ---------- */

/**
 * Applies (or refreshes) a timed effect.
 *
 * `opts.params` is the whole point of the definition/instance split (ARENA.md
 * §3.3): the TABLE declares what `burning` is, the CALLER says how hard this
 * particular burn hurts. Without it every burn in the game would be identical
 * and two spells could not burn at different rates. Pass it straight to
 * `resolveParams(effectId, opts.params, casterStats)` from shared/effects.js.
 *
 * @param {Object} ctx
 * @param {Object} target          a player, or a target handle from combat
 * @param {string} effectId        a key of EFFECTS in shared/effects.js
 * @param {number} durationMs      0 or less means permanent until removed
 * @param {Object} [opts]
 * @param {string} [opts.sourceId] who applied it, for attribution
 * @param {number} [opts.stacks]
 * @param {Object|Function} [opts.params]  magnitude overrides, merged over the
 *   effect's `defaults`. A function receives the caster's stats, which is what
 *   lets a DoT scale with intelligence at the moment it lands.
 * @param {Object} [opts.casterStats]      passed to `opts.params` when it is a function
 * @returns {boolean} false when the id is unknown or the target cannot hold effects
 */
export function applyEffect(ctx, target, effectId, durationMs, opts = {}) {
  return false
}

/** Removes an effect early. Returns false when it was not active. */
export function removeEffect(ctx, target, effectId) {
  return false
}

/**
 * Reads a boolean state: 'invulnerable' | 'rooted' | 'silenced' | 'slowed'.
 * Booleans never travel as modifiers — `pickStats` drops them.
 */
export function hasFlag(target, flag) {
  return false
}

/** Active entries as `{ id, endsAt, stacks }[]`, for UI and for the pipeline. */
export function activeOf(target) {
  return []
}

/** Percent damage-taken modifier contributed by the active effects. */
export function takenMultiplier(target, school) {
  return 0
}
