/**
 * In-memory world state.
 *
 * Systems keep their own state in `world.ext[systemId]` (global) and
 * `player.ext[systemId]` (per player) so this file rarely needs to change.
 */

import { PLAYER_DEFAULTS, DIR, CLASSES, MOVE_BURST_TILES } from '../../shared/constants.js'
import { bodiesOverlap } from '../../shared/grid.js'
import { SPAWN, findFreeTile } from '../world/map.js'

export const world = {
  /** @type {Map<string, Player>} socketId -> Player */
  players: new Map(),
  /** Per-system scratch space: world.ext.chat, world.ext.combat, ... */
  ext: Object.create(null),
  tick: 0,
  startedAt: Date.now(),
}

/**
 * @typedef {Object} Player
 * @property {string} id
 * @property {string} name
 * @property {string} cls
 * @property {number} x
 * @property {number} y
 * @property {number} dir
 * @property {number} hp
 * @property {number} maxHp
 * @property {boolean} dead
 * @property {number} lastMoveAt
 * @property {number} seq          last input sequence the core processed
 * @property {number} moveTokens   banked steps, see MOVE_BURST_TILES
 * @property {Object} ext  per-system scratch space
 */

/** @type {Array<(x:number,y:number,exceptId:string|null)=>boolean>} */
const blockers = []

/** @type {Array<(player:Player)=>boolean>} */
const moveGates = []

/**
 * Lets a system declare that its entities occupy tiles, without touching the
 * core. Call it from your `init(ctx)`.
 */
export function registerBlocker(fn) {
  blockers.push(fn)
}

/**
 * Lets a system veto a player's step — `rooted`, `stunned`, frozen in place.
 * Return `false` to block. Call it from your `init(ctx)`:
 *
 *   registerMoveGate((player) => !hasFlag(player, 'rooted'))
 *
 * Facing is deliberately not gated: turning stays free so a rooted player can
 * still aim.
 */
export function registerMoveGate(fn) {
  moveGates.push(fn)
}

/** True when every registered gate allows this player to step. */
export function canMove(player) {
  for (const fn of moveGates) {
    if (fn(player) === false) return false
  }
  return true
}

/**
 * True when a body centred on (x, y) would overlap another one.
 *
 * A body is `PLAYER_RADIUS` tiles wide in every direction, not a single tile:
 * on the fine grid two players standing one tile apart would be drawn on top of
 * each other.
 */
export function isTileOccupied(x, y, exceptId = null) {
  for (const p of world.players.values()) {
    if (p.id === exceptId || p.dead) continue
    if (bodiesOverlap(p.x, p.y, x, y)) return true
  }
  for (const fn of blockers) {
    if (fn(x, y, exceptId)) return true
  }
  return false
}

export function createPlayer(id, name, cls) {
  const klass = CLASSES[cls] ? cls : 'warrior'
  const spot = findFreeTile(SPAWN.x, SPAWN.y, (x, y) => isTileOccupied(x, y))

  /** @type {Player} */
  const player = {
    id,
    name,
    cls: klass,
    x: spot.x,
    y: spot.y,
    dir: DIR.DOWN,
    hp: PLAYER_DEFAULTS.hp,
    maxHp: PLAYER_DEFAULTS.maxHp,
    dead: false,
    lastMoveAt: 0,
    /** Last input sequence the core processed. Echoed back so the client reconciles. */
    seq: 0,
    /** Step budget: see MOVE_BURST_TILES. Owned by the core movement handler. */
    moveTokens: MOVE_BURST_TILES,
    moveTokensAt: Date.now(),
    ext: Object.create(null),
  }

  world.players.set(id, player)
  return player
}

export function removePlayer(id) {
  const player = world.players.get(id)
  world.players.delete(id)
  return player
}

export function getPlayer(id) {
  return world.players.get(id)
}

/** The living player whose body covers a tile, or null. */
export function playerAt(x, y) {
  for (const p of world.players.values()) {
    if (!p.dead && bodiesOverlap(p.x, p.y, x, y, undefined, 0)) return p
  }
  return null
}

/** Public view of a player: exactly what travels in every snapshot. */
export function toPlayerView(p) {
  return {
    id: p.id,
    name: p.name,
    cls: p.cls,
    x: p.x,
    y: p.y,
    dir: p.dir,
    hp: p.hp,
    maxHp: p.maxHp,
    dead: p.dead,
    // The client replays every input the server has not acknowledged yet.
    // Without this it cannot tell which of its predicted steps already landed.
    seq: p.seq,
  }
}
