/**
 * Bridge between Socket.IO and the systems.
 *
 * Every event declared in shared/protocol.js is dispatched to the system that
 * owns it. Events whose system is disabled answer NOT_IMPLEMENTED, so a
 * half-finished feature never crashes the server.
 */

import { C2S, S2C, ERROR_CODE } from '../../shared/protocol.js'
import { NAME_MAX_LEN, CLASSES } from '../../shared/constants.js'
import { createPlayer, removePlayer, getPlayer, toPlayerView } from '../game/state.js'
import { buildHandlerTable, invoke, systemFlags } from '../systems/index.js'
import { map } from '../world/map.js'

const KNOWN_EVENTS = Object.values(C2S)

export function attachConnectionHandlers(io, ctx) {
  const handlers = buildHandlerTable()

  io.on('connection', (socket) => {
    ctx.log(`connection ${socket.id}`)

    socket.on(C2S.JOIN, (payload) => {
      if (getPlayer(socket.id)) return

      const name = sanitizeName(payload?.name) || `Anon${socket.id.slice(0, 4)}`
      const cls = CLASSES[payload?.cls] ? payload.cls : 'warrior'
      const player = createPlayer(socket.id, name, cls)

      socket.emit(S2C.WELCOME, {
        selfId: player.id,
        map,
        systems: systemFlags(),
        self: toPlayerView(player),
      })

      invoke('onPlayerJoin', ctx, player)
      ctx.announce(`${player.name} joined the world.`)
    })

    // One dispatcher for every protocol event.
    for (const event of KNOWN_EVENTS) {
      if (event === C2S.JOIN) continue
      socket.on(event, (payload) => {
        const player = getPlayer(socket.id)
        if (!player) {
          return socket.emit(S2C.ERROR, {
            code: ERROR_CODE.NOT_JOINED,
            message: 'you have not joined the world yet',
          })
        }
        const entry = handlers.get(event)
        if (!entry) {
          return socket.emit(S2C.ERROR, {
            code: ERROR_CODE.NOT_IMPLEMENTED,
            message: `"${event}" is not implemented (system disabled)`,
          })
        }
        try {
          entry.handler(ctx, player, payload)
        } catch (err) {
          console.error(`[net] ${entry.system.id} threw on "${event}":`, err)
        }
      })
    }

    socket.on('disconnect', () => {
      const player = removePlayer(socket.id)
      if (!player) return
      invoke('onPlayerLeave', ctx, player)
      ctx.announce(`${player.name} left.`)
    })
  })
}

function sanitizeName(value) {
  if (typeof value !== 'string') return ''
  return value.replace(/[^\p{L}\p{N} _-]/gu, '').trim().slice(0, NAME_MAX_LEN)
}
