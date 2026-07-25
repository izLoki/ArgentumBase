/**
 * Client system registry.
 *
 * A client system starts only when the server reports its counterpart as
 * enabled (that flag arrives in WELCOME), so a half-built feature never runs
 * against a server that cannot answer it.
 *
 * Contract (everything optional except `id`):
 *
 *   export default {
 *     id: 'combat',
 *     init(ctx) {},                  // once, when the world is ready
 *     onSnapshot(ctx, snapshot) {},  // every server snapshot
 *     onUpdate(ctx, dtMs) {},        // every frame
 *     handlers: { [S2C.MY_EVENT]: (ctx, payload) => {} },
 *   }
 *
 * See CLAUDE.md for the full guide.
 */

import combat from './combat.js'
import npc from './npc.js'
import inventory from './inventory.js'
import spells from './spells.js'

export const clientSystems = [combat, npc, inventory, spells]

const isLive = (ctx, system) => ctx.state.systems[system.id] === true

export function initSystems(ctx) {
  for (const system of clientSystems) {
    if (!isLive(ctx, system)) continue

    try {
      system.init?.(ctx)
    } catch (err) {
      console.error(`[systems] ${system.id}.init threw:`, err)
    }

    for (const [event, handler] of Object.entries(system.handlers ?? {})) {
      ctx.net.on(event, (payload) => {
        try {
          handler(ctx, payload)
        } catch (err) {
          console.error(`[systems] ${system.id} threw on "${event}":`, err)
        }
      })
    }
  }
}

export function invokeClient(hook, ctx, ...args) {
  for (const system of clientSystems) {
    if (!isLive(ctx, system)) continue
    const fn = system[hook]
    if (typeof fn !== 'function') continue
    try {
      fn(ctx, ...args)
    } catch (err) {
      console.error(`[systems] ${system.id}.${hook} threw:`, err)
    }
  }
}
