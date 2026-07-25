/**
 * Draws players with primitives plus movement interpolation.
 *
 * Sprites are drawn centred on the tile: the container origin sits exactly on
 * the tile centre and every shape is symmetric around it.
 */

import { Container, Graphics, Text } from 'pixi.js'
import { TILE_SIZE, CLASSES, DIR_VEC } from '@shared/constants.js'
import { state } from '../state.js'

const LERP = 0.22 // movement smoothing (0 = frozen, 1 = teleport)
const BODY_W = 18
const BODY_H = 22

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

export function syncEntities(layer) {
  const alive = new Set()

  for (const player of state.players.values()) {
    alive.add(player.id)

    let view = views.get(player.id)
    if (!view) {
      view = makeView(player)
      views.set(player.id, view)
      layer.addChild(view)
      view.x = tileCentre(player.x)
      view.y = tileCentre(player.y)
    }

    view.x += (tileCentre(player.x) - view.x) * LERP
    view.y += (tileCentre(player.y) - view.y) * LERP
    view.zIndex = view.y

    view.alpha = player.dead ? 0.3 : 1
    drawHpBar(view.__bar, player.hp, player.maxHp)
    drawFacing(view.__facing, player.dir)
  }

  for (const [id, view] of views) {
    if (alive.has(id)) continue
    view.destroy({ children: true })
    views.delete(id)
  }
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
