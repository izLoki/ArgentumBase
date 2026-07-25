/**
 * Assembles the world's look from the map: the baked ground canvas underneath
 * (`terrain.js`), animated water overlays, and y-sorted prop sprites for
 * everything that stands up out of the ground (`props.js`).
 *
 * The map never changes and reconnects deliver the identical one, so the build
 * runs exactly once; a second WELCOME finds the world already dressed.
 *
 * Swapping in a real tileset only touches the render/ painters.
 */

import { Sprite, Texture } from 'pixi.js'
import { TILE_SIZE, BLOCK_TILES } from '@shared/constants.js'
import { bakeTerrain, makeWaterFrames } from './terrain.js'
import { buildProps } from './props.js'

const B = TILE_SIZE * BLOCK_TILES
const WATER_FRAME_MS = 420

let built = false

function crisp(canvas) {
  const texture = Texture.from(canvas)
  texture.source.scaleMode = 'nearest'
  return texture
}

export function drawTilemap(layers, map, app) {
  if (built) return
  built = true

  const { canvas, waterBlocks } = bakeTerrain(map)
  layers.ground.addChild(new Sprite(crisp(canvas)))

  // Rippling highlights over every water block, cycled by the ticker.
  const frames = makeWaterFrames().map(crisp)
  const waterSprites = []
  for (const { bx, by } of waterBlocks) {
    const sprite = new Sprite(frames[0])
    sprite.x = bx * B
    sprite.y = by * B
    sprite.alpha = 0.75
    layers.floor.addChild(sprite)
    waterSprites.push(sprite)
  }
  let elapsed = 0
  let frame = 0
  app.ticker.add((ticker) => {
    elapsed += ticker.deltaMS
    if (elapsed < WATER_FRAME_MS) return
    elapsed = 0
    frame = (frame + 1) % frames.length
    for (const sprite of waterSprites) sprite.texture = frames[frame]
  })

  // Trees, walls, houses and boulders y-sort against the players.
  for (const prop of buildProps(map)) layers.entities.addChild(prop)
}
