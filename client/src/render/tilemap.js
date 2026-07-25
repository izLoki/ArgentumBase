/**
 * Draws the map once using primitives, so the project needs no assets.
 *
 * There is no grid overlay any more: a tile is 8 px and a movement step, not
 * something a player should be able to see. Terrain reads through the shape of
 * the blocks it is made of.
 *
 * Swapping in a real tileset only touches this file.
 */

import { Graphics } from 'pixi.js'
import { TILE_SIZE, TILE_META } from '@shared/constants.js'

export function drawTilemap(layer, map) {
  layer.removeChildren()

  const g = new Graphics()

  // Horizontal runs of one colour become a single rect. The fine grid holds
  // ~49k tiles but terrain comes in blocks, so this collapses the geometry by
  // an order of magnitude and keeps the one-off build cheap.
  for (let y = 0; y < map.h; y++) {
    const row = y * map.w
    let x = 0
    while (x < map.w) {
      const id = map.tiles[row + x]
      let run = 1
      while (x + run < map.w && map.tiles[row + x + run] === id) run++

      const meta = TILE_META[id]
      if (meta) {
        g.rect(x * TILE_SIZE, y * TILE_SIZE, run * TILE_SIZE, TILE_SIZE).fill(meta.color)
      }
      x += run
    }
  }

  layer.addChild(g)
}
