/**
 * Draws players with primitives plus movement interpolation.
 *
 * Sprites are drawn centred on the tile: the container origin sits exactly on
 * the tile centre and every shape is symmetric around it.
 *
 * The local player is drawn from the PREDICTED position (see movement.js), not
 * from the last snapshot. That is the difference between a keypress that moves
 * you now and one that moves you a round trip from now.
 */

import { Container, Graphics, Text } from 'pixi.js'
import { TILE_SIZE, BLOCK_PX, CLASSES, DIR_VEC, PLAYER_RADIUS } from '@shared/constants.js'
import { state } from '../state.js'
import { movement } from '../movement.js'

/**
 * Smoothing per 60 Hz frame (0 = frozen, 1 = teleport). The local player is
 * pulled harder: its target is already the truth it asked for, so any lag added
 * here is lag the player feels in their own hands.
 */
const LERP = 0.22
const SELF_LERP = 0.4
/** Past this gap a move is not a walk — a respawn or a teleport. Snap instead. */
const SNAP_PX = BLOCK_PX * 2

/** Body size, in screen pixels: it matches the 3x3 tile footprint that collides. */
const BODY_W = (PLAYER_RADIUS * 2 + 1) * TILE_SIZE - 4
const BODY_H = (PLAYER_RADIUS * 2 + 1) * TILE_SIZE

/** @type {Map<string, Container>} playerId -> view */
const views = new Map()

function makeView(player) {
  const view = new Container()

  const body = new Graphics()
  body
    .roundRect(-BODY_W / 2, -BODY_H / 2, BODY_W, BODY_H, 4)
    .fill(CLASSES[player.cls]?.color ?? 0xcccccc)
    .stroke({ width: 1, color: 0x000000, alpha: 0.5 })
  view.addChild(body)

  // Facing marker, so directional actions are readable.
  const facing = new Graphics()
  view.addChild(facing)

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
  label.y = -BODY_H / 2 - 8
  view.addChild(label)

  view.__facing = facing
  view.__bar = bar
  view.__label = label
  return view
}

function drawHpBar(bar, hp, maxHp) {
  const pct = maxHp > 0 ? Math.max(0, hp / maxHp) : 0
  bar.clear()
  if (pct >= 1) return // full bar: hide it, less visual noise
  const y = -BODY_H / 2 - 6
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

    if (Math.abs(tx - view.x) > SNAP_PX || Math.abs(ty - view.y) > SNAP_PX) {
      view.x = tx
      view.y = ty
    } else {
      view.x += (tx - view.x) * k
      view.y += (ty - view.y) * k
    }
    view.zIndex = view.y

    view.alpha = player.dead ? 0.3 : 1
    drawHpBar(view.__bar, player.hp, player.maxHp)
    drawFacing(view.__facing, from.dir)
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
