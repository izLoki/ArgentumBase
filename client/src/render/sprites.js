/**
 * Character sprite atlases.
 *
 * One PNG per class in `render/sprites/`, cut into a 3 x 4 grid: three walk
 * frames across, one row per direction DOWN / LEFT / RIGHT / UP — the same
 * order as `DIR`, so a row index is just `player.dir`.
 *
 * Frames are pre-aligned in the atlas: every cell has its feet on `FEET_Y` and
 * its body centred on the cell, so a view sets one anchor once and swapping the
 * texture never makes the character slide or bob. Whatever you drop in here has
 * to keep that promise — a sheet aligned by bounding box instead of by feet
 * jitters horizontally whenever an arm swings.
 *
 * A class with no sheet is not an error: `sheetFor()` answers null and
 * `render/entities.js` falls back to the primitive body it always drew. That is
 * what lets the classes get their art one at a time.
 */

import { Assets, Rectangle, Texture } from 'pixi.js'
import warriorUrl from './sprites/warrior.png'
import mageUrl from './sprites/mage.png'
import hunterUrl from './sprites/hunter.png'

/** Class id -> atlas URL. One line per class; nothing else has to change. */
const SHEETS = {
  warrior: warriorUrl,
  mage: mageUrl,
  hunter: hunterUrl,
}

/** Atlas geometry, in source pixels. Every sheet must match it. */
export const CELL_W = 144
export const CELL_H = 192
export const WALK_FRAMES = 3
const DIRECTIONS = 4

/**
 * Height of the feet inside a cell. Sprites are anchored here rather than at
 * the cell bottom, so the character stands on its tile instead of floating
 * above the few pixels of padding the atlas leaves for a shadow.
 */
export const FEET_Y = 186

/** @type {Map<string, Texture[][]>} cls -> textures[dir][frame] */
const sheets = new Map()

/**
 * Loads every atlas. Called once from `createStage`, before the first view is
 * built, so a class either has its textures from the start or never gets them.
 *
 * A sheet that fails to load is logged and skipped: a missing PNG must cost the
 * class its art, not the whole renderer.
 */
export async function loadSprites() {
  await Promise.all(
    Object.entries(SHEETS).map(async ([cls, url]) => {
      try {
        sheets.set(cls, slice(await Assets.load(url)))
      } catch (err) {
        console.error(`[sprites] ${cls} sheet failed to load, falling back:`, err)
      }
    }),
  )
}

/**
 * @returns {Texture[][]|null} textures[dir][frame], or null when the class has
 *   no atlas yet.
 */
export function sheetFor(cls) {
  return sheets.get(cls) ?? null
}

function slice(atlas) {
  const rows = []
  for (let dir = 0; dir < DIRECTIONS; dir++) {
    const frames = []
    for (let frame = 0; frame < WALK_FRAMES; frame++) {
      frames.push(
        new Texture({
          source: atlas.source,
          frame: new Rectangle(frame * CELL_W, dir * CELL_H, CELL_W, CELL_H),
        }),
      )
    }
    rows.push(frames)
  }
  return rows
}
