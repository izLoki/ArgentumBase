/**
 * Draws players, with movement interpolation and a walk cycle.
 *
 * A class with an atlas (see `render/sprites.js`) is drawn as a feet-anchored
 * sprite; one without falls back to the coloured body this file always drew, so
 * the classes can get their art one at a time.
 *
 * THE SPRITE IS BIGGER THAN THE BODY. The container origin sits on the tile
 * centre, the same point the server collides against, and the sprite hangs off
 * it: feet at the bottom of the footprint, head well above it. That is the
 * usual top-down arrangement — a character that reads as tall while occupying
 * only the ground it stands on — and it means nothing here may be used to
 * measure anything. `PLAYER_RADIUS` is the body; this is a picture of it.
 *
 * The local player is drawn from the PREDICTED position (see movement.js), not
 * from the last snapshot. That is the difference between a keypress that moves
 * you now and one that moves you a round trip from now.
 */

import { Container, Graphics, Sprite, Text } from 'pixi.js'
import { TILE_SIZE, BLOCK_PX, CLASSES, DIR_VEC, PLAYER_RADIUS } from '@shared/constants.js'
import { state } from '../state.js'
import { movement } from '../movement.js'
import { sheetFor, actionFor, CELL_W, CELL_H, FEET_Y, ACTION_CELL_W } from './sprites.js'

/**
 * Smoothing per 60 Hz frame (0 = frozen, 1 = teleport). The local player is
 * pulled harder: its target is already the truth it asked for, so any lag added
 * here is lag the player feels in their own hands.
 */
const LERP = 0.22
const SELF_LERP = 0.4
/** Past this gap a move is not a walk — a respawn or a teleport. Snap instead. */
const SNAP_PX = BLOCK_PX * 2

/** Body size, in screen pixels: it matches the tile footprint that collides. */
const BODY_W = (PLAYER_RADIUS * 2 + 1) * TILE_SIZE - 4
const BODY_H = (PLAYER_RADIUS * 2 + 1) * TILE_SIZE

/** On-screen height of one atlas cell. The width follows the cell's ratio. */
const SPRITE_H = 76
const SPRITE_W = (SPRITE_H * CELL_W) / CELL_H

/**
 * World pixels walked per animation frame.
 *
 * The cycle is driven by DISTANCE, not by a timer: the legs then match the feet
 * at any speed, and a player slowed by a root or hurried by agility never
 * moonwalks. One frame every 16 px is a stride of roughly half a block.
 */
const STRIDE_PX = 16
/** Frame order of the three-frame cycle: contact, pass, contact, pass. */
const WALK_CYCLE = [0, 1, 2, 1]
/** How long a view must hold still before it drops back to the idle pose. */
const IDLE_AFTER_MS = 120
/** Below this a frame's movement is interpolation settling, not a step. */
const MOVING_EPSILON = 0.05

/**
 * Caster animations (see `playAction`). The cell is wider than a walk cell and
 * exactly as tall, so the same anchor puts the body in the same place.
 */
const ACTION_W = (SPRITE_H * ACTION_CELL_W) / CELL_H
/** Per frame. Six frames of a sword spin want to be over in under half a second. */
const ACTION_FRAME_MS = 70

/** @type {Map<string, Container>} playerId -> view */
const views = new Map()

function makeView(player) {
  const view = new Container()
  const textures = sheetFor(player.cls)

  if (textures) {
    const sprite = new Sprite(textures[0][0])
    // Anchored on the feet, which every cell of the atlas aligns to.
    sprite.anchor.set(0.5, FEET_Y / CELL_H)
    sprite.setSize(SPRITE_W, SPRITE_H)
    // Standing at the bottom of the footprint, so the body reads as ground.
    sprite.y = BODY_H / 2
    view.addChild(sprite)
    view.__sprite = sprite
    view.__textures = textures
    view.__headY = BODY_H / 2 - SPRITE_H * (FEET_Y / CELL_H)
  } else {
    const body = new Graphics()
    body
      .roundRect(-BODY_W / 2, -BODY_H / 2, BODY_W, BODY_H, 4)
      .fill(CLASSES[player.cls]?.color ?? 0xcccccc)
      .stroke({ width: 1, color: 0x000000, alpha: 0.5 })
    view.addChild(body)

    // Facing marker: a rectangle cannot show where it is looking. A sprite can,
    // so this only exists for the fallback.
    const facing = new Graphics()
    view.addChild(facing)
    view.__facing = facing
    view.__headY = -BODY_H / 2
  }

  const bar = new Graphics()
  view.addChild(bar)

  const label = new Text({
    text: player.name,
    style: {
      fontFamily: 'Segoe UI, sans-serif',
      fontSize: 11,
      fill: 0xffffff,
      stroke: { color: 0x000000, width: 3 },
    },
  })
  label.anchor.set(0.5, 1)
  label.y = view.__headY - 8
  view.addChild(label)

  view.__bar = bar
  view.__cls = player.cls
  view.__walk = { dist: 0, stillMs: 0 }
  // Kept current by `syncEntities`, so `playAction` can pick a facing without
  // the caller having to thread one through from the network payload.
  view.__dir = player.dir ?? 0
  return view
}

/**
 * Plays a class's own animation for a cast, once, on top of the walk sprite.
 *
 * Called by `systems/spells.js` when the server announces a cast. The caller
 * uses the return value to decide whether to also draw the generic spell FX:
 * a class that has its art does not need a placeholder ring on top of it.
 *
 * @returns {boolean} whether an animation actually started
 */
export function playAction(playerId, spellId) {
  const view = views.get(playerId)
  if (!view?.__sprite) return false // fallback body: nothing to animate

  const rows = actionFor(view.__cls, spellId)
  if (!rows?.length) return false

  // A single row is direction-agnostic — a spin looks the same from anywhere.
  // Four rows are a walk sheet's layout, so the facing picks one, ONCE: a dash
  // that changed row halfway through would turn the caster mid-lunge.
  const frames = rows.length > 1 ? (rows[view.__dir] ?? rows[0]) : rows[0]
  if (!frames?.length) return false

  if (!view.__actionSprite) {
    const sprite = new Sprite(frames[0])
    sprite.anchor.set(0.5, FEET_Y / CELL_H)
    sprite.setSize(ACTION_W, SPRITE_H)
    sprite.y = BODY_H / 2
    // Under the bar and the nameplate, which were added before it.
    view.addChildAt(sprite, 1)
    view.__actionSprite = sprite
  }

  view.__action = { frames, elapsedMs: 0 }
  view.__actionSprite.texture = frames[0]
  view.__actionSprite.visible = true
  view.__sprite.visible = false
  return true
}

function drawHpBar(bar, hp, maxHp, headY) {
  const pct = maxHp > 0 ? Math.max(0, hp / maxHp) : 0
  bar.clear()
  if (pct >= 1) return // full bar: hide it, less visual noise
  const y = headY - 6
  bar.rect(-10, y, 20, 3).fill(0x000000)
  bar.rect(-10, y, 20 * pct, 3).fill(pct > 0.35 ? 0x4fbf63 : 0xd94f4f)
}

function drawFacing(facing, dir) {
  const vec = DIR_VEC[dir] ?? DIR_VEC[0]
  facing.clear()
  facing
    .circle(vec.x * (BODY_W / 2 + 3), vec.y * (BODY_H / 2 + 3), 2.5)
    .fill({ color: 0xffffff, alpha: 0.7 })
}

/**
 * Advances the walk cycle by how far the view actually travelled this frame,
 * and picks the row from the direction it is facing.
 */
function animate(view, movedPx, dir, dtMs) {
  const walk = view.__walk
  if (movedPx > MOVING_EPSILON) {
    walk.dist += movedPx
    walk.stillMs = 0
  } else {
    walk.stillMs += dtMs
    // Standing: reset so the next step always starts on the same foot.
    if (walk.stillMs >= IDLE_AFTER_MS) walk.dist = 0
  }

  const step = walk.stillMs >= IDLE_AFTER_MS ? 0 : Math.floor(walk.dist / STRIDE_PX)
  const row = view.__textures[dir] ?? view.__textures[0]
  view.__sprite.texture = row[WALK_CYCLE[step % WALK_CYCLE.length]]
}

/** Runs a cast animation to its last frame, then hands the body back. */
function advanceAction(view, dtMs) {
  const action = view.__action
  action.elapsedMs += dtMs

  const frame = Math.floor(action.elapsedMs / ACTION_FRAME_MS)
  if (frame >= action.frames.length) {
    view.__action = null
    view.__actionSprite.visible = false
    view.__sprite.visible = true
    return
  }
  view.__actionSprite.texture = action.frames[frame]
}

/**
 * @param {number} [dtMs] frame time. Smoothing is corrected for it, so a 30 fps
 *   phone and a 144 Hz monitor reach the target at the same speed.
 */
export function syncEntities(layer, dtMs = 16.67) {
  const alive = new Set()
  const self = movement.selfTile()

  for (const player of state.players.values()) {
    alive.add(player.id)
    const isSelf = player.id === state.selfId
    const from = isSelf && self ? self : player

    let view = views.get(player.id)
    if (!view) {
      view = makeView(player)
      views.set(player.id, view)
      layer.addChild(view)
      view.x = tileCentre(from.x)
      view.y = tileCentre(from.y)
    }

    const tx = tileCentre(from.x)
    const ty = tileCentre(from.y)
    const k = smoothing(isSelf ? SELF_LERP : LERP, dtMs)
    const wasX = view.x
    const wasY = view.y

    if (Math.abs(tx - view.x) > SNAP_PX || Math.abs(ty - view.y) > SNAP_PX) {
      view.x = tx
      view.y = ty
    } else {
      view.x += (tx - view.x) * k
      view.y += (ty - view.y) * k
    }
    view.zIndex = view.y

    view.alpha = player.dead ? 0.3 : 1
    drawHpBar(view.__bar, player.hp, player.maxHp, view.__headY)

    if (view.__sprite) {
      // The walk cycle keeps running under a cast, so the legs are in step
      // again the moment the animation hands the body back.
      view.__dir = from.dir
      animate(view, Math.hypot(view.x - wasX, view.y - wasY), from.dir, dtMs)
      if (view.__action) advanceAction(view, dtMs)
    } else {
      drawFacing(view.__facing, from.dir)
    }
  }

  for (const [id, view] of views) {
    if (alive.has(id)) continue
    view.destroy({ children: true })
    views.delete(id)
  }
}

/** Frame-rate independent exponential smoothing. */
function smoothing(perFrame, dtMs) {
  return 1 - Math.pow(1 - perFrame, Math.min(4, dtMs / 16.67))
}

/** Pixel centre of a tile coordinate. */
export function tileCentre(tile) {
  return tile * TILE_SIZE + TILE_SIZE / 2
}

/** Interpolated pixel position of a player: used by the camera and effects. */
export function viewPosition(id) {
  const view = views.get(id)
  return view ? { x: view.x, y: view.y } : null
}

/**
 * Where the top of a player's drawing sits, relative to `viewPosition`.
 *
 * A sprite and the fallback body do not end at the same height, and only this
 * file knows which one a class got. Anything that hangs something over a head —
 * status icons, floating numbers — anchors to this instead of guessing.
 */
export function viewHeadY(id) {
  const view = views.get(id)
  return view ? view.__headY : null
}
