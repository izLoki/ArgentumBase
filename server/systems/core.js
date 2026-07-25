/**
 * CORE SYSTEM — grid movement and facing.
 *
 * Also the reference implementation of a system: copy its shape when you
 * write your own.
 */

import { C2S, S2C, ERROR_CODE } from '../../shared/protocol.js'
import { DIR_VEC, MOVE_COOLDOWN_MS } from '../../shared/constants.js'
import { isWalkable } from '../world/map.js'
import { canMove, isTileOccupied } from '../game/state.js'

function isValidDir(dir) {
  return dir === 0 || dir === 1 || dir === 2 || dir === 3
}

export default {
  id: 'core',
  enabled: true,

  init(ctx) {
    ctx.log('core ready: authoritative grid movement')
  },

  handlers: {
    /** The client asks to move one tile. The server decides. */
    [C2S.MOVE](ctx, player, payload) {
      const dir = payload?.dir
      if (!isValidDir(dir)) {
        return ctx.fail(player, ERROR_CODE.BAD_PAYLOAD, 'invalid dir')
      }
      if (player.dead) return

      // Turning is always free; walking is rate limited.
      player.dir = dir

      // Effects (rooted, stunned) veto the step through this hook, so no
      // system has to reach into the core to freeze someone in place.
      if (!canMove(player)) return

      const now = Date.now()
      if (now - player.lastMoveAt < MOVE_COOLDOWN_MS) return

      const vec = DIR_VEC[dir]
      const nx = player.x + vec.x
      const ny = player.y + vec.y

      if (!isWalkable(nx, ny)) return
      if (isTileOccupied(nx, ny, player.id)) return

      player.x = nx
      player.y = ny
      player.lastMoveAt = now
    },

    /** Turn without walking. */
    [C2S.FACE](ctx, player, payload) {
      if (!isValidDir(payload?.dir)) return
      player.dir = payload.dir
    },

    [C2S.PING](ctx, player, payload) {
      ctx.sendTo(player.id, S2C.PONG, { t: payload?.t ?? 0 })
    },
  },
}
