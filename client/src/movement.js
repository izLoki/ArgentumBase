/**
 * CLIENT PREDICTION for the local player.
 *
 * Walking used to be a request: press a key, wait a round trip, watch yourself
 * move. On a server hosted far away that is unplayable. Here the client walks
 * immediately and the server corrects it afterwards:
 *
 *   1. `step()` runs the SAME rules the server runs (shared/grid.js) against
 *      the predicted position, moves it, and sends `{ dir, seq }`.
 *   2. The step is kept in `pending` until a snapshot comes back carrying a
 *      `seq` greater or equal to it.
 *   3. `reconcile()` throws away the predicted position, takes the server's,
 *      and replays whatever is still pending on top of it.
 *
 * When both sides agree — which is the normal case, since the rules are the
 * same code — the replay lands exactly where the prediction already was and
 * nothing moves on screen. When they disagree, the server wins on the next
 * snapshot. That is the whole trade: authority stays on the server, latency
 * stops being visible.
 *
 * Prediction covers terrain and other bodies. It cannot know about server-only
 * state (a root effect, a mob that just stepped in the way), so those correct
 * themselves with a small snap. Anything a system adds that blocks movement is
 * expected to be rare enough for that to be acceptable.
 */

import { C2S } from '@shared/protocol.js'
import { DIR_VEC, MOVE_COOLDOWN_MS } from '@shared/constants.js'
import { canStand, bodiesOverlap } from '@shared/grid.js'
import { state, self } from './state.js'
import { net } from './net.js'

/**
 * Stop predicting past this many unacknowledged steps. Reaching it means the
 * server went quiet: keep walking and the correction, when it lands, would be
 * a teleport across half the map.
 */
const MAX_PENDING = 24

/** @type {Array<{ seq:number, dir:number }>} steps the server has not confirmed */
const pending = []

const predicted = { x: 0, y: 0, dir: 0, ready: false }

let seq = 0
/**
 * Step budget, the same shape the server uses — but only two tiles deep.
 *
 * A plain "wait MOVE_COOLDOWN_MS since the last step" would quantise the walk
 * speed to the frame rate: a 35 ms cooldown checked every 16.7 ms only lets a
 * step through every other frame, so a 60 Hz screen would walk a third slower
 * than the server allows. Carrying the remainder fixes that.
 *
 * The server banks up to `MOVE_BURST_TILES` because it has network jitter to
 * absorb; the client has none of that and a deep bucket would only make the
 * first frame after a pause lurch. Two tiles is enough to keep the remainder.
 */
const CARRY_TILES = 2

let tokens = 1
let tokensAt = 0

/**
 * Effective ms per tile. Agility shortens it, so the profile pushes the value
 * here whenever stats change — exactly as it pushes readouts into the HUD.
 * Prediction has to use the same number the server does or the player either
 * under-walks (and never feels the bonus) or over-walks (and rubber-bands).
 */
let cooldownMs = MOVE_COOLDOWN_MS

export const movement = {
  /**
   * Called every frame with the held direction, or null when nothing is held.
   * Turning is free and instant; walking obeys the same cooldown as the server.
   */
  step(dir) {
    if (dir === null || dir === undefined) return

    const me = self()
    if (!me || !predicted.ready || me.dead) return

    const turned = dir !== predicted.dir
    predicted.dir = dir

    // A frame can be long enough to owe more than one step. The budget is what
    // caps it, exactly as it does on the server.
    let walked = 0
    const now = performance.now()
    while (pending.length < MAX_PENDING && canStepTo(dir) && spendToken(now)) {
      commitStep(dir)
      walked++
    }
    if (walked > 0) return

    // Standing still: the server still has to learn where we are looking, or a
    // tap against a wall would never turn the sprite for anyone else.
    if (turned) net.send(C2S.FACE, { dir })
  },

  /** Called after every snapshot. Re-bases the prediction on the server truth. */
  reconcile() {
    const me = self()
    if (!me) return

    if (!predicted.ready) {
      predicted.ready = true
      predicted.dir = me.dir
    }

    const acked = me.seq ?? 0
    while (pending.length && pending[0].seq <= acked) pending.shift()

    let x = me.x
    let y = me.y
    for (const step of pending) {
      const vec = DIR_VEC[step.dir]
      if (isStepFree(x + vec.x, y + vec.y)) {
        x += vec.x
        y += vec.y
      }
    }

    predicted.x = x
    predicted.y = y
  },

  /**
   * Where the local player actually is, one round trip ahead of the last
   * snapshot. Read this instead of `self().x` when a system needs the position
   * the player can see.
   *
   * @returns {{x:number, y:number, dir:number}|null}
   */
  selfTile() {
    return predicted.ready ? predicted : null
  },

  /**
   * Mirrors the server's `player.moveCooldownMs`. Called by the `profile`
   * system when derived stats change; ignored if the value is nonsense, since
   * walking must never stop because a packet was malformed.
   */
  setCooldown(ms) {
    if (Number.isFinite(ms) && ms > 0) cooldownMs = ms
  },

  /** A reconnect brings a brand new player, with its sequence back at zero. */
  reset() {
    pending.length = 0
    seq = 0
    tokens = 1
    tokensAt = 0
    cooldownMs = MOVE_COOLDOWN_MS
    predicted.ready = false
  },
}

/** Refills the budget and takes one step out of it, or refuses. */
function spendToken(now) {
  // First step of a session: there is no elapsed time to refill from, and
  // measuring it from zero would bank a full bucket and lurch two tiles.
  const elapsed = tokensAt === 0 ? 0 : now - tokensAt
  tokensAt = now
  tokens = Math.min(CARRY_TILES, tokens + elapsed / cooldownMs)

  if (tokens < 1) return false
  tokens -= 1
  return true
}

function commitStep(dir) {
  const vec = DIR_VEC[dir]
  predicted.x += vec.x
  predicted.y += vec.y

  seq += 1
  pending.push({ seq, dir })
  net.send(C2S.MOVE, { dir, seq })
}

function canStepTo(dir) {
  const vec = DIR_VEC[dir]
  return isStepFree(predicted.x + vec.x, predicted.y + vec.y)
}

/** The server's two movement rules, minus the ones only it can know about. */
function isStepFree(x, y) {
  if (!state.map || !canStand(state.map, x, y)) return false

  for (const other of state.players.values()) {
    if (other.id === state.selfId || other.dead) continue
    if (bodiesOverlap(other.x, other.y, x, y)) return false
  }
  return true
}
