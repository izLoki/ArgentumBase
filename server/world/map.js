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

/** Distance from a block to the nearest map edge, in blocks. */
function edgeDistance(x, y) {
  return Math.min(x, y, MAP_BLOCKS_W - 1 - x, MAP_BLOCKS_H - 1 - y)
}

/**
 * Everything here is in BLOCKS.
 *
 * The layout is a classic Argentum valley: a jagged mountain range closes the
 * map, a lake with a sand beach sits to the north west and drains into a river
 * that cuts the western plain, and a walled town with cobbled streets and
 * timber houses holds the centre. Dirt roads leave through the four gates; the
 * west road crosses the river on a wooden bridge.
 */
function generateBlocks() {
  const rng = makeRng(SEED)
  const blocks = new Uint8Array(MAP_BLOCKS_W * MAP_BLOCKS_H).fill(TILE.GRASS)

  // Jagged mountain border: a solid outer ring plus two rings of random
  // foothills, so the world edge reads as a range instead of a fence.
  for (let y = 0; y < MAP_BLOCKS_H; y++) {
    for (let x = 0; x < MAP_BLOCKS_W; x++) {
      const d = edgeDistance(x, y)
      if (d === 0) blocks[blockIdx(x, y)] = TILE.ROCK
      else if (d === 1 && rng() < 0.45) blocks[blockIdx(x, y)] = TILE.ROCK
      else if (d === 2 && rng() < 0.15) blocks[blockIdx(x, y)] = TILE.ROCK
    }
  }

  // Lake tucked into the north west, and the river that drains it south.
  carveRect(blocks, 3, 3, 7, 6, TILE.WATER)
  carveRect(blocks, 4, 2, 4, 1, TILE.WATER)
  carveRect(blocks, 5, 9, 2, MAP_BLOCKS_H - 10, TILE.WATER)

  // Central city: 45 x 31 blocks of wall around cobbled streets, centred so the
  // plaza crossing is the spawn point.
  const cx = Math.floor(MAP_BLOCKS_W / 2) - 22
  const cy = Math.floor(MAP_BLOCKS_H / 2) - 15

  // Dirt roads leaving each gate, two blocks wide so a body never squeezes.
  // Carved before the town so the walls cut them cleanly at the gates, and
  // after the river so the west road fords it (the bridge covers the ford).
  carveRect(blocks, cx + 22, 3, 2, cy - 3, TILE.DIRT)
  carveRect(blocks, cx + 22, cy + 31, 2, MAP_BLOCKS_H - (cy + 31) - 1, TILE.DIRT)
  carveRect(blocks, 1, cy + 14, cx - 1, 2, TILE.DIRT)
  carveRect(blocks, cx + 45, cy + 14, MAP_BLOCKS_W - (cx + 45) - 1, 2, TILE.DIRT)

  // Wooden bridge where the west road meets the river.
  carveRect(blocks, 5, cy + 14, 2, 2, TILE.BRIDGE)

  carveRect(blocks, cx, cy, 45, 31, TILE.WALL)
  carveRect(blocks, cx + 1, cy + 1, 43, 29, TILE.FLOOR)

  // City blocks: rows of timber houses in the four quadrants, split by the
  // central cross of streets that meets at the plaza. Every lane a body has to
  // walk is at least two blocks wide. A few lots stay empty as small squares.
  const houseRows = [1, 6, 11, 17, 22, 27]
  const houseCols = [1, 7, 13, 25, 31, 37]
  for (const hy of houseRows) {
    for (const hx of houseCols) {
      if (rng() < 0.15) continue // empty lot: a little market square
      const w = rng() < 0.4 ? 3 : 4
      carveRect(blocks, cx + hx, cy + hy, w, 3, TILE.HOUSE)
    }
  }

  // Two blocks of clearance per gate, never one. A body is 5 tiles wide and a
  // single block is 4, so a one block opening is not a tight gate — it is a
  // wall. The north and south gates are 2 blocks wide; the east and west ones
  // are 1 block deep (the wall's own thickness) but 2 blocks tall, which is the
  // dimension a body crossing them has to fit through.
  carveRect(blocks, cx + 22, cy, 2, 1, TILE.FLOOR)
  carveRect(blocks, cx + 22, cy + 30, 2, 1, TILE.FLOOR)
  carveRect(blocks, cx, cy + 14, 1, 2, TILE.FLOOR)
  carveRect(blocks, cx + 44, cy + 14, 1, 2, TILE.FLOOR)

  // The outer ring is absolute: roads and foothill jitter never breach it.
  for (let x = 0; x < MAP_BLOCKS_W; x++) {
    blocks[blockIdx(x, 0)] = TILE.ROCK
    blocks[blockIdx(x, MAP_BLOCKS_H - 1)] = TILE.ROCK
  }
  for (let y = 0; y < MAP_BLOCKS_H; y++) {
    blocks[blockIdx(0, y)] = TILE.ROCK
    blocks[blockIdx(MAP_BLOCKS_W - 1, y)] = TILE.ROCK
  }

  // Sand beach around the lake (not the river): grass touching lake water
  // becomes shore.
  const isLakeWater = (x, y) =>
    x >= 0 && y >= 0 && x < MAP_BLOCKS_W && y < MAP_BLOCKS_H &&
    y <= 11 && blocks[blockIdx(x, y)] === TILE.WATER
  const shore = []
  for (let y = 1; y < MAP_BLOCKS_H - 1; y++) {
    for (let x = 1; x < MAP_BLOCKS_W - 1; x++) {
      if (blocks[blockIdx(x, y)] !== TILE.GRASS) continue
      const touchesLake = [-1, 0, 1].some((dy) =>
        [-1, 0, 1].some((dx) => isLakeWater(x + dx, y + dy)),
      )
      if (touchesLake) shore.push(blockIdx(x, y))
    }
  }
  for (const idx of shore) blocks[idx] = TILE.SAND

  // Forest: six dense groves grown by random walk, then scattered singles.
  const plantTree = (x, y) => {
    if (x < 1 || y < 1 || x >= MAP_BLOCKS_W - 1 || y >= MAP_BLOCKS_H - 1) return
    if (blocks[blockIdx(x, y)] === TILE.GRASS) blocks[blockIdx(x, y)] = TILE.TREE
  }
  for (let grove = 0; grove < 6; grove++) {
    let x = 3 + Math.floor(rng() * (MAP_BLOCKS_W - 6))
    let y = 3 + Math.floor(rng() * (MAP_BLOCKS_H - 6))
    const steps = 30 + Math.floor(rng() * 20)
    for (let i = 0; i < steps; i++) {
      plantTree(x, y)
      x += Math.floor(rng() * 3) - 1
      y += Math.floor(rng() * 3) - 1
    }
  }
  for (let i = 0; i < 150; i++) {
    plantTree(
      1 + Math.floor(rng() * (MAP_BLOCKS_W - 2)),
      1 + Math.floor(rng() * (MAP_BLOCKS_H - 2)),
    )
  }

  // A handful of rock outcrops on the plains.
  for (let cluster = 0; cluster < 6; cluster++) {
    const x = 4 + Math.floor(rng() * (MAP_BLOCKS_W - 8))
    const y = 4 + Math.floor(rng() * (MAP_BLOCKS_H - 8))
    const size = 2 + Math.floor(rng() * 3)
    let px = x
    let py = y
    for (let i = 0; i < size; i++) {
      if (blocks[blockIdx(px, py)] === TILE.GRASS) blocks[blockIdx(px, py)] = TILE.ROCK
      px += Math.floor(rng() * 3) - 1
      py += Math.floor(rng() * 3) - 1
      px = Math.max(1, Math.min(MAP_BLOCKS_W - 2, px))
      py = Math.max(1, Math.min(MAP_BLOCKS_H - 2, py))
    }
  }

  // Perimeter trail: keep a two block band clear of trees and stray rocks just
  // inside the foothills, so no random cluster can seal off a corner of the
  // map. The river still crosses it — that detour is what the bridge is for.
  for (let y = 0; y < MAP_BLOCKS_H; y++) {
    for (let x = 0; x < MAP_BLOCKS_W; x++) {
      const d = edgeDistance(x, y)
      if (d < 3 || d > 4) continue
      const t = blocks[blockIdx(x, y)]
      if (t === TILE.TREE || t === TILE.ROCK) blocks[blockIdx(x, y)] = TILE.GRASS
    }
  }

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
