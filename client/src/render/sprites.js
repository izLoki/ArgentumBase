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
import warriorWhirlwindUrl from './sprites/warrior-whirlwind.png'
import warriorChargeUrl from './sprites/warrior-charge.png'
import mobDragonUrl from './sprites/mob-dragon.png'

/** Class id -> atlas URL. One line per class; nothing else has to change. */
const SHEETS = {
  warrior: warriorUrl,
  mage: mageUrl,
  hunter: hunterUrl,
}

/**
 * `<cls>:<spellId>` -> atlas URL: an ability that animates the CASTER.
 *
 * Keyed by the spell so the art is tied to the thing that triggers it. A spell
 * with no entry simply keeps the generic FX `systems/spells.js` draws — this is
 * an upgrade for a specific cast, never a requirement.
 *
 * Rows and frames are read off the image rather than declared, because abilities
 * disagree about both: ONE row means the animation ignores facing (a spin looks
 * the same from anywhere), FOUR means it is drawn per direction like a walk
 * sheet — a lunge has to point where the caster is going.
 */
const ACTIONS = {
  'warrior:whirlwind': warriorWhirlwindUrl,
  'warrior:charge': warriorChargeUrl,
}

/**
 * Mob type -> atlas URL, cut exactly like a class walk sheet.
 *
 * A monster with no entry keeps the coloured blob and emoji `systems/npc.js`
 * draws, so the roster gets its art one creature at a time.
 */
const MOB_SHEETS = {
  dragon: mobDragonUrl,
}

/** Atlas geometry, in source pixels. Every sheet must match it. */
export const CELL_W = 144
export const CELL_H = 192
export const WALK_FRAMES = 3
const DIRECTIONS = 4

/**
 * Action cells are WIDER, and only wider.
 *
 * A sword sweep reaches about a body's height to each side, but never above the
 * head or below the feet, so the cell keeps `CELL_H` and `FEET_Y`. That is what
 * lets a view swap between a walk frame and an action frame without the
 * character jumping: same baseline, same body scale, just more room for light.
 */
export const ACTION_CELL_W = 352

/**
 * Height of the feet inside a cell. Sprites are anchored here rather than at
 * the cell bottom, so the character stands on its tile instead of floating
 * above the few pixels of padding the atlas leaves for a shadow.
 */
export const FEET_Y = 186

/** @type {Map<string, Texture[][]>} cls -> textures[dir][frame] */
const sheets = new Map()
/** @type {Map<string, Texture[][]>} `<cls>:<spellId>` -> textures[row][frame] */
const actions = new Map()
/** @type {Map<string, Texture[][]>} mob type -> textures[dir][frame] */
const mobSheets = new Map()

/**
 * Loads every atlas. Called once from `createStage`, before the first view is
 * built, so a class either has its textures from the start or never gets them.
 *
 * A sheet that fails to load is logged and skipped: a missing PNG must cost the
 * class its art, not the whole renderer.
 */
export async function loadSprites() {
  await Promise.all([
    ...Object.entries(SHEETS).map(([cls, url]) =>
      load(url, `${cls} sheet`, (atlas) => sheets.set(cls, sliceWalk(atlas))),
    ),
    ...Object.entries(ACTIONS).map(([key, url]) =>
      load(url, `${key} action`, (atlas) => actions.set(key, sliceAction(atlas))),
    ),
    ...Object.entries(MOB_SHEETS).map(([type, url]) =>
      load(url, `${type} mob sheet`, (atlas) => mobSheets.set(type, sliceWalk(atlas))),
    ),
  ])
}

async function load(url, what, onLoaded) {
  try {
    onLoaded(await Assets.load(url))
  } catch (err) {
    console.error(`[sprites] ${what} failed to load, falling back:`, err)
  }
}

/**
 * @returns {Texture[][]|null} textures[dir][frame], or null when the class has
 *   no atlas yet.
 */
export function sheetFor(cls) {
  return sheets.get(cls) ?? null
}

/**
 * @returns {Texture[][]|null} textures[dir][frame] for a monster, or null when
 *   that type has no atlas yet.
 */
export function mobSheetFor(type) {
  return mobSheets.get(type) ?? null
}

/**
 * @returns {Texture[][]|null} textures[row][frame] for a cast, or null when this
 *   class casts the spell without an animation. One row means "any direction".
 */
export function actionFor(cls, spellId) {
  return actions.get(`${cls}:${spellId}`) ?? null
}

function sliceWalk(atlas) {
  const rows = []
  for (let dir = 0; dir < DIRECTIONS; dir++) {
    const frames = []
    for (let frame = 0; frame < WALK_FRAMES; frame++) {
      frames.push(cut(atlas, frame * CELL_W, dir * CELL_H, CELL_W))
    }
    rows.push(frames)
  }
  return rows
}

function sliceAction(atlas) {
  const rowCount = Math.max(1, Math.round(atlas.height / CELL_H))
  const frameCount = Math.max(1, Math.round(atlas.width / ACTION_CELL_W))

  const rows = []
  for (let row = 0; row < rowCount; row++) {
    const frames = []
    for (let frame = 0; frame < frameCount; frame++) {
      frames.push(cut(atlas, frame * ACTION_CELL_W, row * CELL_H, ACTION_CELL_W))
    }
    rows.push(frames)
  }
  return rows
}

function cut(atlas, x, y, width) {
  return new Texture({
    source: atlas.source,
    frame: new Rectangle(x, y, width, CELL_H),
  })
}
