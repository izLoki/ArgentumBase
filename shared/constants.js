/**
 * Shared constants used by both the client and the server.
 *
 * This is core infrastructure. Prefer declaring constants that only your
 * system needs inside your own system module — that keeps merges clean.
 * Only add things here when two or more systems read the same value.
 */

export const TICK_RATE = 15 // server ticks per second
export const TICK_MS = 1000 / TICK_RATE

/**
 * THE GRID IS FINE, THE TERRAIN IS NOT.
 *
 * A tile is a movement step, not a terrain feature. `BLOCK_TILES` tiles make up
 * one terrain block — the size a tree, a wall or a road segment used to have
 * when a tile was 32 px. Terrain is generated in blocks and expanded, so the
 * world keeps its physical size while movement gained four times the
 * resolution and the grid stopped being visible.
 *
 * Gameplay tables (spell range, aggro radius, spawn distance) stay in BLOCK
 * units — they read the same as they always did. Convert with
 * `blocksToTiles()` where they meet coordinates.
 */
export const TILE_SIZE = 8 // pixels per tile on the client
export const BLOCK_TILES = 4 // tiles per terrain block
export const BLOCK_PX = TILE_SIZE * BLOCK_TILES // 32: a block on screen

/** Block distance -> tile distance. Every range in a data table needs this. */
export function blocksToTiles(n) {
  return n * BLOCK_TILES
}

export const MAP_BLOCKS_W = 64
export const MAP_BLOCKS_H = 48
export const MAP_WIDTH = MAP_BLOCKS_W * BLOCK_TILES // tiles
export const MAP_HEIGHT = MAP_BLOCKS_H * BLOCK_TILES // tiles

/** Tile ids. Any tile whose meta has `blocked: true` stops movement. */
export const TILE = {
  GRASS: 0,
  DIRT: 1,
  WATER: 2,
  TREE: 3,
  ROCK: 4,
  FLOOR: 5,
  WALL: 6,
  SAND: 7,
  BRIDGE: 8,
  HOUSE: 9,
}

export const TILE_META = {
  [TILE.GRASS]: { name: 'grass', color: 0x2f6b33, blocked: false },
  [TILE.DIRT]: { name: 'dirt', color: 0x6b5433, blocked: false },
  [TILE.WATER]: { name: 'water', color: 0x1d3f7a, blocked: true },
  [TILE.TREE]: { name: 'tree', color: 0x1c4020, blocked: true },
  [TILE.ROCK]: { name: 'rock', color: 0x555555, blocked: true },
  [TILE.FLOOR]: { name: 'floor', color: 0x8a7a5c, blocked: false },
  [TILE.WALL]: { name: 'wall', color: 0x3a3128, blocked: true },
  [TILE.SAND]: { name: 'sand', color: 0xc7ad6f, blocked: false },
  [TILE.BRIDGE]: { name: 'bridge', color: 0x8a6238, blocked: false },
  [TILE.HOUSE]: { name: 'house', color: 0x7a4a30, blocked: true },
}

export const DIR = {
  DOWN: 0,
  LEFT: 1,
  RIGHT: 2,
  UP: 3,
}

/** Tile delta per direction. */
export const DIR_VEC = {
  [DIR.DOWN]: { x: 0, y: 1 },
  [DIR.LEFT]: { x: -1, y: 0 },
  [DIR.RIGHT]: { x: 1, y: 0 },
  [DIR.UP]: { x: 0, y: -1 },
}

/**
 * Time to walk ONE TILE. 35 ms per 8 px is the same speed the world had at
 * 140 ms per 32 px block — only the step got smaller.
 *
 * The client predicts against this number too, so both sides agree on where a
 * player should be. The server still decides.
 */
export const MOVE_COOLDOWN_MS = 35

/**
 * How many steps the server lets a client bank.
 *
 * A distant client sends one step every `MOVE_COOLDOWN_MS`, but the network
 * delivers them in bursts. A hard cooldown would reject every step in a burst
 * and the predicted position would rubber-band back on every reconcile. The
 * bucket absorbs the jitter while still capping the average speed at exactly
 * one tile per cooldown.
 */
export const MOVE_BURST_TILES = 4

/**
 * Half-size of a player's body, in tiles: `2` means a 5x5 footprint (40 px).
 * Bodies collide when their footprints overlap, and a player only fits where
 * the whole footprint is walkable.
 *
 * This is the GROUND a character occupies, not how tall it looks: the sprite
 * hangs well above it (see `client/src/render/entities.js`). Raising it again
 * is not free — a body that no longer fits between two terrain blocks silently
 * cuts parts of the map off. At 2 the town gates still pass and only a handful
 * of pockets between adjacent trees become unreachable.
 */
export const PLAYER_RADIUS = 2

/**
 * Only used for the instant between `createPlayer` and the profile's first
 * `recompute`, which immediately replaces maxHp with the derived value.
 *
 * There is no mana in this world: cooldown is the only limit on spells.
 */
export const PLAYER_DEFAULTS = {
  maxHp: 100,
  hp: 100,
}

/** Playable classes. Drives colour, base attributes and the spell set. */
export const CLASSES = {
  warrior: { label: 'Warrior', color: 0xd94f4f },
  mage: { label: 'Mage', color: 0x4f7fd9 },
  hunter: { label: 'Hunter', color: 0x4fd97f },
}

export const CHAT_MAX_LEN = 120
export const NAME_MAX_LEN = 16
