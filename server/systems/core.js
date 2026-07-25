/**
 * CORE SYSTEM — grid movement and facing.
 *
 * Also the reference implementation of a system: copy its shape when you
 * write your own.
 *
 * MOVEMENT IS PREDICTED, NOT REQUESTED. The client walks the instant the key
 * goes down and tells the server afterwards, tagging every step with a
 * sequence number. This handler is still the only authority — it re-runs the
 * same rules and the snapshot carries back the last sequence it accepted, so a
 * client that predicted wrong gets corrected on the next snapshot. Two things
 * make that correction rare enough to be invisible:
 *
 *   - the rules both sides run live in shared/grid.js, so they cannot drift;
 *   - the step budget (MOVE_BURST_TILES) absorbs network jitter instead of
 *     rejecting the burst it arrives in.
 *
 * `player.seq` advances even when the step is refused. It acknowledges "I saw
 * this input", not "I allowed it" — otherwise a client would replay a rejected
 * step forever and stay permanently ahead of the server.
 */

import { C2S, S2C, ERROR_CODE } from '../../shared/protocol.js'
import { DIR_VEC, MOVE_COOLDOWN_MS, MOVE_BURST_TILES } from '../../shared/constants.js'
import { canStand } from '../world/map.js'
import { canMove, isTileOccupied } from '../game/state.js'

function isValidDir(dir) {
  return dir === 0 || dir === 1 || dir === 2 || dir === 3
}

/**
 * Takes one step out of the player's budget, refilling it first.
 *
 * @returns {boolean} false when the client is asking to walk faster than the
 *   server allows — the step is dropped, never slowed down.
 */
function spendMoveToken(player, now) {
  const elapsed = now - player.moveTokensAt
  player.moveTokensAt = now
  player.moveTokens = Math.min(MOVE_BURST_TILES, player.moveTokens + elapsed / MOVE_COOLDOWN_MS)

  if (player.moveTokens < 1) return false
  player.moveTokens -= 1
  return true
}

export default {
  id: 'core',
  enabled: true,

  init(ctx) {
    ctx.log('core ready: authoritative grid movement')
  },

  handlers: {
    /**
     * The client reports a step it has already taken locally. The server
     * re-runs it and its verdict wins.
     *
     * @param {{ dir: 0|1|2|3, seq?: number }} payload
     */
    [C2S.MOVE](ctx, player, payload) {
      const dir = payload?.dir
      if (!isValidDir(dir)) {
        return ctx.fail(player, ERROR_CODE.BAD_PAYLOAD, 'invalid dir')
      }

      // Acknowledge before deciding: every early return below still has to
      // free the client from replaying this input.
      const seq = payload?.seq
      if (Number.isInteger(seq) && seq > player.seq) player.seq = seq

      if (player.dead) return

      // Turning is always free; walking is rate limited.
      player.dir = dir

      // Effects (rooted, stunned) veto the step through this hook, so no
      // system has to reach into the core to freeze someone in place.
      if (!canMove(player)) return

      const vec = DIR_VEC[dir]
      const nx = player.x + vec.x
      const ny = player.y + vec.y

      // The whole body has to fit, not just the centre tile.
      if (!canStand(nx, ny)) return
      if (isTileOccupied(nx, ny, player.id)) return

      // Last gate, so walking into a wall never costs a step of budget.
      const now = Date.now()
      if (!spendMoveToken(player, now)) return

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
