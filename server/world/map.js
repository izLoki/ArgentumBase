/**
 * Map generation and queries.
 *
 * The world is DESIGNED IN BLOCKS and STORED IN TILES. Generation works on a
 * 64x48 block grid — a lake is 10x6 blocks, a wall is one block thick — and
 * the result is expanded by `BLOCK_TILES` into the fine tile grid the game
 * actually moves on. That is what keeps the world the same physical size while
 * a step became four times smaller.
 *
 * Design terrain in blocks. Never hand-place single tiles: a one tile wide gap
 * is 8 px and no body fits through it.
 */

import {
  MAP_WIDTH,
  MAP_HEIGHT,
  MAP_BLOCKS_W,
  MAP_BLOCKS_H,
  BLOCK_TILES,
  PLAYER_RADIUS,
  TILE,
} from '../../shared/constants.js'
import {
  tileAt as tileOf,
  isWalkable as isWalkableOn,
  canStand as canStandOn,
  encodeTiles,
} from '../../shared/grid.js'

const SEED = 1337

/** Deterministic PRNG (mulberry32). */
function makeRng(seed) {
  let a = seed >>> 0
  return function rng() {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function blockIdx(x, y) {
  return y * MAP_BLOCKS_W + x
}

function carveRect(blocks, x0, y0, w, h, tile) {
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      if (x < 0 || y < 0 || x >= MAP_BLOCKS_W || y >= MAP_BLOCKS_H) continue
      blocks[blockIdx(x, y)] = tile
    }
  }
}

/** Everything here is in BLOCKS. */
function generateBlocks() {
  const rng = makeRng(SEED)
  const blocks = new Uint8Array(MAP_BLOCKS_W * MAP_BLOCKS_H).fill(TILE.GRASS)

  // Rock border: the world is closed.
  for (let x = 0; x < MAP_BLOCKS_W; x++) {
    blocks[blockIdx(x, 0)] = TILE.ROCK
    blocks[blockIdx(x, MAP_BLOCKS_H - 1)] = TILE.ROCK
  }
  for (let y = 0; y < MAP_BLOCKS_H; y++) {
    blocks[blockIdx(0, y)] = TILE.ROCK
    blocks[blockIdx(MAP_BLOCKS_W - 1, y)] = TILE.ROCK
  }

  // Lake to the north west.
  carveRect(blocks, 6, 5, 10, 6, TILE.WATER)
  carveRect(blocks, 8, 4, 6, 1, TILE.WATER)

  // Scattered forest.
  for (let i = 0; i < 260; i++) {
    const x = 1 + Math.floor(rng() * (MAP_BLOCKS_W - 2))
    const y = 1 + Math.floor(rng() * (MAP_BLOCKS_H - 2))
    if (blocks[blockIdx(x, y)] === TILE.GRASS) blocks[blockIdx(x, y)] = TILE.TREE
  }

  // Central town: floor surrounded by walls with four gates.
  const cx = Math.floor(MAP_BLOCKS_W / 2) - 8
  const cy = Math.floor(MAP_BLOCKS_H / 2) - 6
  carveRect(blocks, cx, cy, 17, 13, TILE.WALL)
  carveRect(blocks, cx + 1, cy + 1, 15, 11, TILE.FLOOR)

  // Two blocks per gate, not one. A one block gate is 4 tiles and a body is 3,
  // so half the approaches would bounce off the frame — passable, but it reads
  // as a bug to whoever is walking into it.
  carveRect(blocks, cx + 8, cy, 2, 1, TILE.FLOOR)
  carveRect(blocks, cx + 8, cy + 12, 2, 1, TILE.FLOOR)
  carveRect(blocks, cx, cy + 6, 1, 2, TILE.FLOOR)
  carveRect(blocks, cx + 16, cy + 6, 1, 2, TILE.FLOOR)

  // Dirt roads leaving town.
  carveRect(blocks, cx + 8, cy + 13, 1, MAP_BLOCKS_H - (cy + 14), TILE.DIRT)
  carveRect(blocks, cx + 17, cy + 6, MAP_BLOCKS_W - (cx + 18), 1, TILE.DIRT)

  return blocks
}

/** One block becomes a BLOCK_TILES x BLOCK_TILES patch of identical tiles. */
function expand(blocks) {
  const tiles = new Uint8Array(MAP_WIDTH * MAP_HEIGHT)
  for (let y = 0; y < MAP_HEIGHT; y++) {
    const row = Math.floor(y / BLOCK_TILES) * MAP_BLOCKS_W
    for (let x = 0; x < MAP_WIDTH; x++) {
      tiles[y * MAP_WIDTH + x] = blocks[row + Math.floor(x / BLOCK_TILES)]
    }
  }
  return tiles
}

export const map = {
  w: MAP_WIDTH,
  h: MAP_HEIGHT,
  tiles: expand(generateBlocks()),
}

/** Spawn point: town centre. */
export const SPAWN = {
  x: Math.floor(MAP_WIDTH / 2),
  y: Math.floor(MAP_HEIGHT / 2),
}

/** What travels in WELCOME. Built once — the map never changes. */
export const mapWire = {
  w: map.w,
  h: map.h,
  block: BLOCK_TILES,
  rle: encodeTiles(map.tiles),
}

export function tileAt(x, y) {
  return tileOf(map, x, y)
}

/** True when the terrain of one tile is walkable (entities are not considered). */
export function isWalkable(x, y) {
  return isWalkableOn(map, x, y)
}

/** True when a whole body fits, centred on the tile. Use this to place anything. */
export function canStand(x, y, radius = PLAYER_RADIUS) {
  return canStandOn(map, x, y, radius)
}

/**
 * Nearest tile a body fits on around (x, y), searched in growing rings.
 *
 * `maxRadius` is in tiles, so it shrank by `BLOCK_TILES` when the grid got
 * finer: the default covers the same ground it used to.
 */
export function findFreeTile(x, y, isOccupied = () => false, maxRadius = 12 * BLOCK_TILES) {
  if (canStand(x, y) && !isOccupied(x, y)) return { x, y }
  for (let r = 1; r <= maxRadius; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue
        const nx = x + dx
        const ny = y + dy
        if (canStand(nx, ny) && !isOccupied(nx, ny)) return { x: nx, y: ny }
      }
    }
  }
  return { x, y }
}
