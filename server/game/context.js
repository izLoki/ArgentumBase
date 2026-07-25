/**
 * `ctx` — the only part of the core a system needs to know about.
 *
 * If your system needs something that is not here, adding it is safe: it is
 * purely additive and breaks nobody.
 */

import { S2C } from '../../shared/protocol.js'
import { world } from './state.js'
import { map, tileAt, isWalkable, canStand, findFreeTile, SPAWN } from '../world/map.js'

export function createContext(io) {
  return {
    io,
    world,
    map,
    SPAWN,
    tileAt,
    isWalkable,
    /** Whether a whole body fits here. Use it to place anything wider than a tile. */
    canStand,
    findFreeTile,

    /** Send an event to every connected client. */
    broadcast(event, payload) {
      io.emit(event, payload)
    },

    /** Send an event to a single socket. */
    sendTo(socketId, event, payload) {
      io.to(socketId).emit(event, payload)
    },

    /** Typed error back to whoever triggered the action. */
    fail(player, code, message) {
      io.to(player.id).emit(S2C.ERROR, { code, message })
    },

    /** System message in everyone's chat. */
    announce(text) {
      io.emit(S2C.CHAT_MSG, { from: 'System', text, channel: 'system' })
    },

    log(...args) {
      console.log('[game]', ...args)
    },
  }
}
