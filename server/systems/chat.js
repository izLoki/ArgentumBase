/**
 * CHAT SYSTEM — global "say" channel with a basic rate limit.
 *
 * Second reference implementation: shows per-system state living in
 * `ctx.world.ext.chat` instead of anywhere in the core.
 */

import { C2S, S2C, ERROR_CODE } from '../../shared/protocol.js'
import { CHAT_MAX_LEN } from '../../shared/constants.js'

const RATE_MS = 400

export default {
  id: 'chat',
  enabled: true,

  init(ctx) {
    ctx.world.ext.chat = { lastSaidAt: new Map() }
  },

  onPlayerLeave(ctx, player) {
    ctx.world.ext.chat.lastSaidAt.delete(player.id)
  },

  handlers: {
    [C2S.CHAT_SAY](ctx, player, payload) {
      const raw = typeof payload?.text === 'string' ? payload.text.trim() : ''
      if (!raw) return

      const state = ctx.world.ext.chat
      const now = Date.now()
      const last = state.lastSaidAt.get(player.id) ?? 0
      if (now - last < RATE_MS) {
        return ctx.fail(player, ERROR_CODE.RATE_LIMIT, 'slow down')
      }
      state.lastSaidAt.set(player.id, now)

      ctx.broadcast(S2C.CHAT_MSG, {
        from: player.name,
        fromId: player.id,
        text: raw.slice(0, CHAT_MAX_LEN),
        channel: 'say',
      })
    },
  },
}
