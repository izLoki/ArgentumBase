/**
 * Camera: keeps the local player centred, clamped to the map bounds.
 *
 * Positions are rounded to whole pixels so tiles and sprites never land on a
 * half pixel, which is what makes a grid look subtly misaligned.
 */

import { TILE_SIZE } from '@shared/constants.js'
import { state } from '../state.js'
import { viewPosition } from './entities.js'

export function updateCamera(app, camera) {
  const pos = viewPosition(state.selfId)
  if (!pos) return

  const targetX = app.screen.width / 2 - pos.x
  const targetY = app.screen.height / 2 - pos.y

  const worldW = (state.map?.w ?? 0) * TILE_SIZE
  const worldH = (state.map?.h ?? 0) * TILE_SIZE

  const x =
    worldW <= app.screen.width
      ? (app.screen.width - worldW) / 2
      : Math.min(0, Math.max(app.screen.width - worldW, targetX))
  const y =
    worldH <= app.screen.height
      ? (app.screen.height - worldH) / 2
      : Math.min(0, Math.max(app.screen.height - worldH, targetY))

  camera.x = Math.round(x)
  camera.y = Math.round(y)
}
