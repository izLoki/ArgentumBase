/**
 * Server system registry.
 *
 * Every gameplay feature lives in its own module under this folder and is
 * plugged in here. Adding a feature means creating one file and adding one
 * import plus one array entry — the core never changes.
 *
 * System contract (everything optional except `id`):
 *
 *   export default {
 *     id: 'combat',
 *     enabled: false,                       // false = the system does not run
 *     init(ctx) {},                         // once, at startup
 *     onPlayerJoin(ctx, player) {},
 *     onPlayerLeave(ctx, player) {},
 *     onTick(ctx, dtMs) {},                 // every server tick
 *     collectSnapshot(ctx) { return {} },   // sent as snapshot.ext[id]
 *     handlers: {                           // C2S events this system owns
 *       [C2S.ATTACK]: (ctx, player, payload) => {},
 *     },
 *   }
 *
 * See CLAUDE.md for the full guide.
 */

import core from './core.js'
import chat from './chat.js'
import combat from './combat.js'
import npc from './npc.js'
import inventory from './inventory.js'
import spells from './spells.js'

/** Order matters: `core` runs first (movement and base state). */
export const systems = [core, chat, combat, npc, inventory, spells]

/**
 * Event -> { system, handler } table, built at startup.
 * Only enabled systems are registered; events belonging to a disabled system
 * answer NOT_IMPLEMENTED instead of silently doing nothing.
 */
export function buildHandlerTable() {
  const table = new Map()
  for (const system of systems) {
    if (!system.enabled) continue
    for (const [event, handler] of Object.entries(system.handlers ?? {})) {
      if (table.has(event)) {
        console.warn(
          `[systems] duplicate event "${event}": ${table.get(event).system.id} vs ${system.id}. First one wins.`,
        )
        continue
      }
      table.set(event, { system, handler })
    }
  }
  return table
}

/** Calls a hook on every enabled system, isolating failures. */
export function invoke(hook, ctx, ...args) {
  for (const system of systems) {
    if (!system.enabled) continue
    const fn = system[hook]
    if (typeof fn !== 'function') continue
    try {
      fn(ctx, ...args)
    } catch (err) {
      console.error(`[systems] ${system.id}.${hook} threw:`, err)
    }
  }
}

/** Merges every system's `collectSnapshot` into `snapshot.ext`. */
export function collectExt(ctx) {
  const ext = {}
  for (const system of systems) {
    if (!system.enabled || typeof system.collectSnapshot !== 'function') continue
    try {
      const data = system.collectSnapshot(ctx)
      if (data !== undefined) ext[system.id] = data
    } catch (err) {
      console.error(`[systems] ${system.id}.collectSnapshot threw:`, err)
    }
  }
  return ext
}

/** Sent in WELCOME so client systems know whether their server half is live. */
export function systemFlags() {
  return Object.fromEntries(systems.map((s) => [s.id, s.enabled]))
}
