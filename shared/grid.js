/**
 * Grid geometry, shared on purpose.
 *
 * The client predicts its own movement instead of waiting for the server to
 * answer (see `client/src/movement.js`). Prediction is only invisible while
 * both sides reach the same verdict for the same tile, so the rules live here
 * once and both sides import them. A copy on either side would drift and show
 * up as rubber-banding.
 *
 * Every function takes the map explicitly: the server has one, the client has
 * a decoded mirror of it.
 *
 * @typedef {{ w:number, h:number, tiles:ArrayLike<number> }} GridMap
 */

import { TILE, TILE_META, PLAYER_RADIUS } from './constants.js'

/** Tile id at a coordinate. Outside the map counts as solid rock. */
export function tileAt(map, x, y) {
  if (x < 0 || y < 0 || x >= map.w || y >= map.h) return TILE.ROCK
  return map.tiles[y * map.w + x]
}

/** True when the terrain of a single tile is walkable. Entities are not considered. */
export function isWalkable(map, x, y) {
  const meta = TILE_META[tileAt(map, x, y)]
  return !!meta && !meta.blocked
}

/**
 * True when a body centred on (x, y) fits: every tile under its footprint has
 * to be walkable, otherwise a player would sink half a body into a wall.
 */
export function canStand(map, x, y, radius = PLAYER_RADIUS) {
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      if (!isWalkable(map, x + dx, y + dy)) return false
    }
  }
  return true
}

/** True when two footprints overlap — the collision test between entities. */
export function bodiesOverlap(ax, ay, bx, by, ra = PLAYER_RADIUS, rb = PLAYER_RADIUS) {
  return Math.abs(ax - bx) <= ra + rb && Math.abs(ay - by) <= ra + rb
}

/**
 * Run-length encodes a tile array for the wire.
 *
 * At 8 px tiles the map is 49k cells; as raw JSON that is a ~100 KB WELCOME
 * before a player can even see the world. Terrain comes in blocks, so runs are
 * long and this collapses it to a few KB.
 *
 * @returns {number[]} flat [tileId, count, tileId, count, ...]
 */
export function encodeTiles(tiles) {
  const rle = []
  let run = 0
  for (let i = 0; i < tiles.length; i++) {
    run++
    if (i + 1 < tiles.length && tiles[i + 1] === tiles[i]) continue
    rle.push(tiles[i], run)
    run = 0
  }
  return rle
}

/**
 * Rebuilds a tile array from `encodeTiles`. Never trust the wire: a truncated
 * or oversized payload throws here rather than corrupting the world silently.
 *
 * @returns {Uint8Array}
 */
export function decodeTiles(rle, length) {
  const tiles = new Uint8Array(length)
  let at = 0
  for (let i = 0; i < rle.length; i += 2) {
    const count = rle[i + 1]
    if (!Number.isInteger(count) || count < 1 || at + count > length) {
      throw new Error(`bad map run at ${i}`)
    }
    tiles.fill(rle[i], at, at + count)
    at += count
  }
  if (at !== length) throw new Error(`map is ${at} tiles, expected ${length}`)
  return tiles
}
