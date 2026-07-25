/**
 * In-memory world state.
 *
 * Systems keep their own state in `world.ext[systemId]` (global) and
 * `player.ext[systemId]` (per player) so this file rarely needs to change.
 */

import { PLAYER_DEFAULTS, DIR, CLASSES } from '../../shared/constants.js'
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
 * @property {number} mana
 * @property {number} maxMana
 * @property {boolean} dead
 * @property {number} lastMoveAt
 * @property {Object} ext  per-system scratch space
 */

/** @type {Array<(x:number,y:number,exceptId:string|null)=>boolean>} */
const blockers = []

/**
 * Lets a system declare that its entities occupy tiles, without touching the
 * core. Call it from your `init(ctx)`.
 */
export function registerBlocker(fn) {
  blockers.push(fn)
}

export function isTileOccupied(x, y, exceptId = null) {
  for (const p of world.players.values()) {
    if (p.id === exceptId || p.dead) continue
    if (p.x === x && p.y === y) return true
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
    mana: PLAYER_DEFAULTS.mana,
    maxMana: PLAYER_DEFAULTS.maxMana,
    dead: false,
    lastMoveAt: 0,
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

export function playerAt(x, y) {
  for (const p of world.players.values()) {
    if (!p.dead && p.x === x && p.y === y) return p
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
  }
}
