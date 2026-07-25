/**
 * Map generation and queries.
 *
 * The map is a flat array of `MAP_WIDTH * MAP_HEIGHT` tile ids, generated
 * from a fixed seed so every run produces the same world.
 */

import { MAP_WIDTH, MAP_HEIGHT, TILE, TILE_META } from '../../shared/constants.js'

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

function idx(x, y) {
  return y * MAP_WIDTH + x
}

function carveRect(tiles, x0, y0, w, h, tile) {
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      if (x < 0 || y < 0 || x >= MAP_WIDTH || y >= MAP_HEIGHT) continue
      tiles[idx(x, y)] = tile
    }
  }
}

function generateTiles() {
  const rng = makeRng(SEED)
  const tiles = new Array(MAP_WIDTH * MAP_HEIGHT).fill(TILE.GRASS)

  // Rock border: the world is closed.
  for (let x = 0; x < MAP_WIDTH; x++) {
    tiles[idx(x, 0)] = TILE.ROCK
    tiles[idx(x, MAP_HEIGHT - 1)] = TILE.ROCK
  }
  for (let y = 0; y < MAP_HEIGHT; y++) {
    tiles[idx(0, y)] = TILE.ROCK
    tiles[idx(MAP_WIDTH - 1, y)] = TILE.ROCK
  }

  // Lake to the north west.
  carveRect(tiles, 6, 5, 10, 6, TILE.WATER)
  carveRect(tiles, 8, 4, 6, 1, TILE.WATER)

  // Scattered forest.
  for (let i = 0; i < 260; i++) {
    const x = 1 + Math.floor(rng() * (MAP_WIDTH - 2))
    const y = 1 + Math.floor(rng() * (MAP_HEIGHT - 2))
    if (tiles[idx(x, y)] === TILE.GRASS) tiles[idx(x, y)] = TILE.TREE
  }

  // Central town: floor surrounded by walls with four gates.
  const cx = Math.floor(MAP_WIDTH / 2) - 8
  const cy = Math.floor(MAP_HEIGHT / 2) - 6
  carveRect(tiles, cx, cy, 17, 13, TILE.WALL)
  carveRect(tiles, cx + 1, cy + 1, 15, 11, TILE.FLOOR)
  tiles[idx(cx + 8, cy)] = TILE.FLOOR
  tiles[idx(cx + 8, cy + 12)] = TILE.FLOOR
  tiles[idx(cx, cy + 6)] = TILE.FLOOR
  tiles[idx(cx + 16, cy + 6)] = TILE.FLOOR

  // Dirt roads leaving town.
  carveRect(tiles, cx + 8, cy + 13, 1, MAP_HEIGHT - (cy + 14), TILE.DIRT)
  carveRect(tiles, cx + 17, cy + 6, MAP_WIDTH - (cx + 18), 1, TILE.DIRT)

  return tiles
}

const tiles = generateTiles()

/** Spawn point: town centre. */
export const SPAWN = {
  x: Math.floor(MAP_WIDTH / 2),
  y: Math.floor(MAP_HEIGHT / 2),
}

export const map = {
  w: MAP_WIDTH,
  h: MAP_HEIGHT,
  tiles,
}

export function tileAt(x, y) {
  if (x < 0 || y < 0 || x >= MAP_WIDTH || y >= MAP_HEIGHT) return TILE.ROCK
  return tiles[idx(x, y)]
}

/** True when the terrain is walkable (entities are not considered). */
export function isWalkable(x, y) {
  const meta = TILE_META[tileAt(x, y)]
  return !!meta && !meta.blocked
}

/** Nearest free tile around (x, y), searched in growing rings. */
export function findFreeTile(x, y, isOccupied = () => false, maxRadius = 12) {
  if (isWalkable(x, y) && !isOccupied(x, y)) return { x, y }
  for (let r = 1; r <= maxRadius; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue
        const nx = x + dx
        const ny = y + dy
        if (isWalkable(nx, ny) && !isOccupied(nx, ny)) return { x: nx, y: ny }
      }
    }
  }
  return { x, y }
}
