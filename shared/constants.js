/**
 * Shared constants used by both the client and the server.
 *
 * This is core infrastructure. Prefer declaring constants that only your
 * system needs inside your own system module — that keeps merges clean.
 * Only add things here when two or more systems read the same value.
 */

export const TICK_RATE = 15 // server ticks per second
export const TICK_MS = 1000 / TICK_RATE

export const TILE_SIZE = 32 // pixels per tile on the client

export const MAP_WIDTH = 64 // tiles
export const MAP_HEIGHT = 48 // tiles

/** Tile ids. Any tile whose meta has `blocked: true` stops movement. */
export const TILE = {
  GRASS: 0,
  DIRT: 1,
  WATER: 2,
  TREE: 3,
  ROCK: 4,
  FLOOR: 5,
  WALL: 6,
}

export const TILE_META = {
  [TILE.GRASS]: { name: 'grass', color: 0x2f6b33, blocked: false },
  [TILE.DIRT]: { name: 'dirt', color: 0x6b5433, blocked: false },
  [TILE.WATER]: { name: 'water', color: 0x1d3f7a, blocked: true },
  [TILE.TREE]: { name: 'tree', color: 0x1c4020, blocked: true },
  [TILE.ROCK]: { name: 'rock', color: 0x555555, blocked: true },
  [TILE.FLOOR]: { name: 'floor', color: 0x8a7a5c, blocked: false },
  [TILE.WALL]: { name: 'wall', color: 0x3a3128, blocked: true },
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

/** Movement cooldown (ms). Enforced by the server — never trust the client. */
export const MOVE_COOLDOWN_MS = 140

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
