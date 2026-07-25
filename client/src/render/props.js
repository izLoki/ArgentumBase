/**
 * Blocked terrain drawn as things instead of tiles: trees with canopies, town
 * walls with battlements, timber houses with shingle roofs, boulders.
 *
 * Every prop is a feet-anchored sprite whose zIndex is the pixel row its base
 * sits on. Dropped into `layers.entities` (which y-sorts), a player walking
 * north of a tree disappears behind its canopy and one walking south passes in
 * front — the whole reason the world stops feeling flat.
 *
 * All art is baked once into small canvases with the same deterministic RNG the
 * terrain uses, so the forest looks varied but never changes between sessions.
 */

import { Sprite, Texture } from 'pixi.js'
import { TILE, TILE_SIZE, BLOCK_TILES } from '@shared/constants.js'
import { rngFor, makeCanvas, shade, pick, disc } from './pixelart.js'
import { blocksOf } from './terrain.js'

const B = TILE_SIZE * BLOCK_TILES // 32
/** How far a wall's top surface is lifted above its footprint. */
const WALL_LIFT = 16

function textureOf(canvas) {
  const texture = Texture.from(canvas)
  texture.source.scaleMode = 'nearest'
  return texture
}

function ellipse(ctx, cx, cy, rx, ry, color) {
  ctx.fillStyle = color
  for (let y = -ry; y <= ry; y++) {
    const half = Math.floor(rx * Math.sqrt(1 - (y * y) / (ry * ry || 1)))
    ctx.fillRect(Math.round(cx - half), Math.round(cy + y), half * 2 + 1, 1)
  }
}

// --- Trees -----------------------------------------------------------------

function makeTreeTexture(variant) {
  const W = 64
  const H = 84
  const FOOT = 78
  const { canvas, ctx } = makeCanvas(W, H)
  const rng = rngFor(500, variant)

  ellipse(ctx, 32, FOOT, 15, 4, 'rgba(0, 0, 0, 0.25)')

  const trunkTop = 46
  for (let y = FOOT; y >= trunkTop; y--) {
    const t = (FOOT - y) / (FOOT - trunkTop)
    const w = Math.round(10 - 4 * t)
    ctx.fillStyle = '#5a3d22'
    ctx.fillRect(Math.round(32 - w / 2), y, w, 1)
  }
  ctx.fillStyle = '#4a3119'
  ctx.fillRect(30, trunkTop + 4, 1, FOOT - trunkTop - 8)
  ctx.fillRect(34, trunkTop + 8, 1, FOOT - trunkTop - 12)
  ctx.fillRect(26, FOOT - 1, 3, 1)
  ctx.fillRect(35, FOOT - 1, 3, 1)

  const blobs = []
  for (let i = 0; i < 7; i++) {
    blobs.push({
      x: 32 + (rng() - 0.5) * 28,
      y: 30 + (rng() - 0.5) * 20,
      r: 9 + Math.floor(rng() * 5),
    })
  }
  for (const b of blobs) disc(ctx, b.x, b.y + 2, b.r, '#1e3b18')
  for (const b of blobs) disc(ctx, b.x, b.y, b.r, '#2a5121')
  for (const b of blobs) disc(ctx, b.x - 2, b.y - 3, Math.max(3, b.r - 4), '#356628')
  for (const b of blobs) {
    if (rng() < 0.8) disc(ctx, b.x - 3, b.y - 4, Math.max(2, b.r - 7), '#417a31')
  }
  ctx.fillStyle = '#4f8a3c'
  for (let i = 0; i < 22; i++) {
    const b = blobs[i % blobs.length]
    ctx.fillRect(Math.round(b.x + (rng() - 0.6) * b.r), Math.round(b.y + (rng() - 0.65) * b.r), 2, 1)
  }
  return { texture: textureOf(canvas), footRatio: FOOT / H }
}

// --- Boulders --------------------------------------------------------------

function makeBoulderTexture(variant) {
  const W = 40
  const H = 30
  const FOOT = 27
  const { canvas, ctx } = makeCanvas(W, H)
  const rng = rngFor(600, variant)

  ellipse(ctx, 20, FOOT, 14, 3, 'rgba(0, 0, 0, 0.22)')
  const lumps = 2 + Math.floor(rng() * 2)
  for (let i = 0; i < lumps; i++) {
    const cx = 12 + rng() * 16
    const cy = 16 + rng() * 6
    const r = 7 + Math.floor(rng() * 4)
    disc(ctx, cx, cy + 2, r, '#4f4b45')
    disc(ctx, cx, cy, r, '#6b675f')
    disc(ctx, cx - 2, cy - 3, Math.max(2, r - 4), '#7e7a71')
  }
  ctx.fillStyle = '#413e39'
  for (let i = 0; i < 6; i++) {
    ctx.fillRect(8 + Math.floor(rng() * 24), 12 + Math.floor(rng() * 12), 1 + Math.floor(rng() * 2), 1)
  }
  return { texture: textureOf(canvas), footRatio: FOOT / H }
}

// --- Town walls ------------------------------------------------------------

const wallCache = new Map()

function wallTexture(hasFace, merlonN, variant) {
  const key = `${hasFace}:${merlonN}:${variant}`
  if (wallCache.has(key)) return wallCache.get(key)

  const H = hasFace ? B + WALL_LIFT : B
  const { canvas, ctx } = makeCanvas(B, H)
  const rng = rngFor(700, variant, (hasFace ? 2 : 0) + (merlonN ? 1 : 0))

  // Cap: the walkway on top of the wall, seen from above.
  const cap = '#6b675f'
  ctx.fillStyle = cap
  ctx.fillRect(0, 0, B, B)
  for (let i = 0; i < 6; i++) {
    ctx.fillStyle = shade(cap, rng() < 0.5 ? 0.08 : -0.1)
    ctx.fillRect(Math.floor(rng() * (B - 8)), Math.floor(rng() * (B - 6)), 4 + Math.floor(rng() * 5), 3 + Math.floor(rng() * 3))
  }
  ctx.fillStyle = shade(cap, -0.32)
  for (let i = 0; i < 5; i++) {
    ctx.fillRect(Math.floor(rng() * (B - 4)), Math.floor(rng() * (B - 1)), 3 + Math.floor(rng() * 3), 1)
  }
  ctx.fillStyle = shade(cap, 0.16)
  ctx.fillRect(0, 0, B, 1)

  const teeth = (y, h) => {
    for (const x of [2, 13, 24]) {
      ctx.fillStyle = '#767268'
      ctx.fillRect(x, y, 6, h)
      ctx.fillStyle = shade('#767268', 0.15)
      ctx.fillRect(x, y, 6, 1)
      ctx.fillStyle = '#3f3c37'
      ctx.fillRect(x, y + h - 1, 6, 1)
    }
  }
  if (merlonN) teeth(0, 6)

  if (hasFace) {
    teeth(B - 7, 6) // south parapet, standing on the edge above the face
    // Face: coursed stone, seen from the front.
    const mortar = '#45413b'
    ctx.fillStyle = mortar
    ctx.fillRect(0, B, B, WALL_LIFT)
    const tones = ['#6e6a62', '#75716a', '#67635b']
    for (let row = 0; row < 3; row++) {
      const y = B + row * 5
      let x = row % 2 === 0 ? 0 : -5
      while (x < B) {
        const w = 9 + Math.floor(rng() * 3)
        ctx.fillStyle = pick(rng, tones)
        ctx.fillRect(Math.max(0, x), y, Math.min(B, x + w - 1) - Math.max(0, x), 4)
        x += w
      }
    }
    ctx.fillStyle = '#38352f'
    ctx.fillRect(0, B + WALL_LIFT - 2, B, 2)
  }

  const result = textureOf(canvas)
  wallCache.set(key, result)
  return result
}

// --- Houses ----------------------------------------------------------------

const EAVE = 6
const ROOF_RISE = 18
const FACE_H = 30

function makeHouseTexture(blocksW, blocksH, seed) {
  const W = blocksW * B + EAVE * 2
  const H = blocksH * B + ROOF_RISE
  const { canvas, ctx } = makeCanvas(W, H)
  const rng = rngFor(800, seed)
  const faceTop = H - FACE_H

  // Front wall: plaster over a stone base, framed in dark timber.
  const plaster = shade('#c9b691', (rng() - 0.5) * 0.1)
  ctx.fillStyle = plaster
  ctx.fillRect(EAVE, faceTop, W - EAVE * 2, FACE_H)
  ctx.fillStyle = shade(plaster, -0.08)
  for (let i = 0; i < blocksW * 14; i++) {
    ctx.fillRect(EAVE + Math.floor(rng() * (W - EAVE * 2 - 2)), faceTop + Math.floor(rng() * (FACE_H - 8)), 2, 1)
  }
  ctx.fillStyle = '#7b7266'
  ctx.fillRect(EAVE, H - 5, W - EAVE * 2, 5)
  ctx.fillStyle = '#5f574c'
  for (let x = EAVE; x < W - EAVE; x += 6 + Math.floor(rng() * 3)) {
    ctx.fillRect(x, H - 5, 1, 5)
  }

  const timber = '#5d422a'
  ctx.fillStyle = timber
  ctx.fillRect(EAVE, faceTop, 3, FACE_H)
  ctx.fillRect(W - EAVE - 3, faceTop, 3, FACE_H)
  ctx.fillRect(EAVE, faceTop, W - EAVE * 2, 3)

  // One 32 px module gets the door; the others get windows.
  const doorModule = Math.floor(blocksW / 2)
  for (let m = 0; m < blocksW; m++) {
    const mx = EAVE + m * B
    if (m === doorModule) {
      const dx = mx + B / 2 - 7
      const dy = H - 24
      ctx.fillStyle = '#3a2a18'
      ctx.fillRect(dx - 1, dy - 1, 16, 24)
      ctx.fillStyle = '#57402a'
      ctx.fillRect(dx, dy, 14, 23)
      ctx.fillStyle = '#3a2a18'
      for (let px = dx + 3; px < dx + 14; px += 4) ctx.fillRect(px, dy, 1, 23)
      ctx.fillRect(dx, dy + 2, 14, 1)
      ctx.fillStyle = '#c9a227'
      ctx.fillRect(dx + 11, dy + 12, 2, 2)
    } else {
      const wx = mx + B / 2 - 5
      const wy = faceTop + 8
      ctx.fillStyle = timber
      ctx.fillRect(wx - 1, wy - 1, 12, 12)
      ctx.fillStyle = rng() < 0.5 ? '#d99a3c' : '#33302c'
      ctx.fillRect(wx, wy, 10, 10)
      ctx.fillStyle = timber
      ctx.fillRect(wx + 4, wy, 2, 10)
      ctx.fillRect(wx, wy + 4, 10, 2)
      ctx.fillStyle = shade(plaster, -0.2)
      ctx.fillRect(wx - 2, wy + 11, 14, 1)
    }
  }
  if (blocksW >= 4 && rng() < 0.8) {
    // A diagonal brace on wide facades, the timber-frame signature.
    ctx.fillStyle = timber
    const bx = EAVE + 6
    for (let i = 0; i < 12; i++) ctx.fillRect(bx + i, faceTop + 4 + i, 3, 1)
  }

  // Roof: rows of shingles sloping toward the viewer, over the eaves.
  const roofH = H - FACE_H
  const tones = ['#8b3e2b', '#7c3526', '#94452f', '#833a29']
  for (let y = 0; y < roofH; y += 5) {
    const tone = pick(rng, tones)
    ctx.fillStyle = tone
    ctx.fillRect(0, y, W, Math.min(5, roofH - y) - 1)
    ctx.fillStyle = '#4f1f16'
    ctx.fillRect(0, y + 4, W, 1)
    const offset = (y / 5) % 2 === 0 ? 0 : 3
    for (let x = offset; x < W; x += 6) {
      ctx.fillRect(x, y, 1, 4)
    }
  }
  ctx.fillStyle = '#a35a40'
  ctx.fillRect(0, 0, W, 3)
  ctx.fillStyle = '#b56a4c'
  ctx.fillRect(0, 0, W, 1)
  ctx.fillStyle = '#5e2817'
  ctx.fillRect(0, 0, 3, roofH)
  ctx.fillRect(W - 3, 0, 3, roofH)
  ctx.fillRect(0, roofH - 2, W, 2)
  ctx.fillStyle = 'rgba(0, 0, 0, 0.25)'
  ctx.fillRect(EAVE, roofH, W - EAVE * 2, 3)

  // Chimney.
  const chx = EAVE + 8 + Math.floor(rng() * (W - EAVE * 2 - 26))
  ctx.fillStyle = '#6e6a62'
  ctx.fillRect(chx, 2, 10, 12)
  ctx.fillStyle = '#57534d'
  ctx.fillRect(chx - 1, 2, 12, 3)
  ctx.fillStyle = '#222220'
  ctx.fillRect(chx + 2, 3, 6, 1)

  return textureOf(canvas)
}

// --- Assembly --------------------------------------------------------------

function makeSprite(texture) {
  const sprite = new Sprite(texture)
  sprite.__mapProp = true
  return sprite
}

/** Builds every prop sprite for the map, positioned and z-sorted. */
export function buildProps(map) {
  const { blocks, bw, bh } = blocksOf(map)
  const at = (x, y) => (x < 0 || y < 0 || x >= bw || y >= bh ? TILE.ROCK : blocks[y * bw + x])
  const sprites = []

  const treeVariants = [0, 1, 2, 3].map(makeTreeTexture)
  const boulderVariants = [0, 1, 2].map(makeBoulderTexture)
  const houseSeen = new Set()

  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      const t = at(bx, by)

      if (t === TILE.TREE) {
        const rng = rngFor(bx, by, 42)
        const { texture, footRatio } = pick(rng, treeVariants)
        const sprite = makeSprite(texture)
        sprite.anchor.set(0.5, footRatio)
        sprite.x = bx * B + B / 2 + Math.floor((rng() - 0.5) * 7)
        sprite.y = by * B + 26 + Math.floor((rng() - 0.5) * 5)
        sprite.zIndex = sprite.y
        sprites.push(sprite)
        continue
      }

      if (t === TILE.ROCK && Math.min(bx, by, bw - 1 - bx, bh - 1 - by) > 3) {
        const rng = rngFor(bx, by, 43)
        const { texture, footRatio } = pick(rng, boulderVariants)
        const sprite = makeSprite(texture)
        sprite.anchor.set(0.5, footRatio)
        sprite.x = bx * B + B / 2
        sprite.y = by * B + 27
        sprite.zIndex = sprite.y
        sprites.push(sprite)
        continue
      }

      if (t === TILE.WALL) {
        const hasFace = at(bx, by + 1) !== TILE.WALL
        const merlonN = at(bx, by - 1) !== TILE.WALL
        const sprite = makeSprite(wallTexture(hasFace, merlonN, (bx + by) % 3))
        sprite.x = bx * B
        sprite.y = by * B - WALL_LIFT
        sprite.zIndex = (by + 1) * B
        sprites.push(sprite)
        continue
      }

      if (t === TILE.HOUSE && !houseSeen.has(by * bw + bx)) {
        // Houses are placed as solid rectangles: walk this one's extent.
        let w = 0
        while (at(bx + w, by) === TILE.HOUSE && !houseSeen.has(by * bw + bx + w)) w++
        let h = 0
        while (at(bx, by + h) === TILE.HOUSE) h++
        for (let dy = 0; dy < h; dy++) {
          for (let dx = 0; dx < w; dx++) houseSeen.add((by + dy) * bw + bx + dx)
        }
        const sprite = makeSprite(makeHouseTexture(w, h, bx * 100 + by))
        sprite.anchor.set(0, 1)
        sprite.x = bx * B - EAVE
        sprite.y = (by + h) * B
        sprite.zIndex = sprite.y - 1
        sprites.push(sprite)
      }
    }
  }
  return sprites
}
