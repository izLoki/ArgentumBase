/**
 * Draws the map once using primitives, so the project needs no assets.
 *
 * Swapping in a real tileset only touches this file.
 */

import { Graphics } from 'pixi.js'
import { TILE_SIZE, TILE_META } from '@shared/constants.js'

export function drawTilemap(layer, map) {
  layer.removeChildren()

  const g = new Graphics()
  for (let y = 0; y < map.h; y++) {
    for (let x = 0; x < map.w; x++) {
      const meta = TILE_META[map.tiles[y * map.w + x]]
      if (!meta) continue
      g.rect(x * TILE_SIZE, y * TILE_SIZE, TILE_SIZE, TILE_SIZE).fill(meta.color)
    }
  }

  // Subtle grid: makes tile alignment obvious while developing.
  const grid = new Graphics()
  for (let x = 0; x <= map.w; x++) {
    grid.moveTo(x * TILE_SIZE, 0).lineTo(x * TILE_SIZE, map.h * TILE_SIZE)
  }
  for (let y = 0; y <= map.h; y++) {
    grid.moveTo(0, y * TILE_SIZE).lineTo(map.w * TILE_SIZE, y * TILE_SIZE)
  }
  grid.stroke({ width: 1, color: 0x000000, alpha: 0.12 })

  layer.addChild(g, grid)
}
