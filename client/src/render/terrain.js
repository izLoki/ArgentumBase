/**
 * Bakes the whole ground into one pixel-art canvas, Argentum style.
 *
 * The map arrives as fine tiles but terrain lives in 32 px blocks, so the bake
 * walks the block grid and paints each block with a deterministic painter:
 * mottled grass, rutted dirt roads, cobbled town streets, sand shores, cliff
 * rock and plank bridges. A second pass paints what happens BETWEEN materials —
 * ragged grass bites into roads, foam along water, cliff shadows — which is
 * what stops the world from reading as coloured rectangles.
 *
 * Blocked props (trees, walls, houses, boulders) are NOT painted here: they are
 * y-sorted sprites built in `props.js`, so this file only decides what ground
 * lies beneath them.
 */

import { TILE, TILE_SIZE, BLOCK_TILES } from '@shared/constants.js'
import { rngFor, noise2, makeCanvas, shade, pick, disc } from './pixelart.js'

const B = TILE_SIZE * BLOCK_TILES // 32 px: one block on screen

const BASE = {
  grass: '#3d6a2c',
  dirt: '#7a5a33',
  sand: '#c9ae72',
  water: '#1d4b74',
  cobbleGap: '#4b463b',
  rock: '#5d5a54',
  plank: '#8a6134',
}

/** Reads the block grid back out of the expanded tile map. */
export function blocksOf(map) {
  const step = map.block || BLOCK_TILES
  const bw = Math.floor(map.w / step)
  const bh = Math.floor(map.h / step)
  const blocks = new Uint8Array(bw * bh)
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      blocks[by * bw + bx] = map.tiles[by * step * map.w + bx * step]
    }
  }
  return { blocks, bw, bh }
}

function makeGrid(blocks, bw, bh) {
  return (x, y) => {
    if (x < 0 || y < 0 || x >= bw || y >= bh) return TILE.ROCK
    return blocks[y * bw + x]
  }
}

/** What ground lies under a block once props are lifted off it. */
function groundType(at, x, y) {
  const t = at(x, y)
  if (t === TILE.TREE) return TILE.GRASS
  if (t === TILE.HOUSE) return TILE.DIRT
  if (t === TILE.WALL) {
    const near = [at(x + 1, y), at(x - 1, y), at(x, y + 1), at(x, y - 1)]
    return near.includes(TILE.FLOOR) || near.includes(TILE.HOUSE) ? TILE.FLOOR : TILE.GRASS
  }
  return t
}

export function bakeTerrain(map) {
  const { blocks, bw, bh } = blocksOf(map)
  const at = makeGrid(blocks, bw, bh)
  const ground = (x, y) => groundType(at, x, y)
  const { canvas, ctx } = makeCanvas(bw * B, bh * B)

  const waterBlocks = []
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      paintBlock(ctx, at, ground, bx, by)
      if (at(bx, by) === TILE.WATER) waterBlocks.push({ bx, by })
    }
  }
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      paintTransitions(ctx, ground, bx, by)
    }
  }
  return { canvas, waterBlocks }
}

function paintBlock(ctx, at, ground, bx, by) {
  const g = ground(bx, by)
  const rng = rngFor(bx, by, g)
  const px = bx * B
  const py = by * B
  // Meadow-scale tint: neighbouring blocks shade together instead of dicing.
  let tint = (noise2(bx / 5, by / 5, 7) - 0.5) * 0.16
  if (at(bx, by) === TILE.TREE) tint -= 0.07 // forest floor sits in shade

  switch (g) {
    case TILE.GRASS: return paintGrass(ctx, px, py, rng, tint)
    case TILE.DIRT: return paintDirt(ctx, ground, bx, by, px, py, rng, tint)
    case TILE.SAND: return paintSand(ctx, px, py, rng, tint)
    case TILE.WATER: return paintWater(ctx, ground, bx, by, px, py, rng, tint)
    case TILE.FLOOR: return paintCobbles(ctx, px, py, rng)
    case TILE.ROCK: return paintRock(ctx, ground, bx, by, px, py, rng, tint)
    case TILE.BRIDGE: return paintBridge(ctx, ground, bx, by, px, py, rng)
  }
}

function speckle(ctx, px, py, rng, colors, count, size = 2) {
  for (let i = 0; i < count; i++) {
    ctx.fillStyle = pick(rng, colors)
    const w = 1 + Math.floor(rng() * size)
    ctx.fillRect(px + Math.floor(rng() * (B - w)), py + Math.floor(rng() * (B - 1)), w, 1)
  }
}

function paintGrass(ctx, px, py, rng, tint) {
  const base = shade(BASE.grass, tint)
  ctx.fillStyle = base
  ctx.fillRect(px, py, B, B)
  speckle(ctx, px, py, rng, [shade(base, -0.18), shade(base, -0.3), shade(base, 0.1)], 46)
  // A few upright blades and the odd wildflower.
  for (let i = 0; i < 5; i++) {
    ctx.fillStyle = shade(base, 0.22)
    ctx.fillRect(px + Math.floor(rng() * (B - 1)), py + Math.floor(rng() * (B - 2)), 1, 2)
  }
  if (rng() < 0.07) {
    const fx = px + 4 + Math.floor(rng() * (B - 8))
    const fy = py + 4 + Math.floor(rng() * (B - 8))
    ctx.fillStyle = pick(rng, ['#d9c956', '#c9d0d8', '#c77f9e'])
    ctx.fillRect(fx, fy, 2, 2)
    ctx.fillStyle = shade(base, -0.25)
    ctx.fillRect(fx, fy + 2, 1, 1)
  }
}

/** Dirt roads: mottled earth with cart ruts running the way the road does. */
function paintDirt(ctx, ground, bx, by, px, py, rng, tint) {
  const base = shade(BASE.dirt, tint)
  ctx.fillStyle = base
  ctx.fillRect(px, py, B, B)
  speckle(ctx, px, py, rng, [shade(base, -0.16), shade(base, 0.12), shade(base, -0.28)], 40)
  for (let i = 0; i < 4; i++) {
    const sx = px + 2 + Math.floor(rng() * (B - 6))
    const sy = py + 2 + Math.floor(rng() * (B - 5))
    ctx.fillStyle = pick(rng, ['#8d795c', '#96825f'])
    ctx.fillRect(sx, sy, 2, 2)
    ctx.fillStyle = shade(base, -0.35)
    ctx.fillRect(sx, sy + 2, 2, 1)
  }

  const roadish = (t) => t === TILE.DIRT || t === TILE.BRIDGE
  const vertical = roadish(ground(bx, by - 1)) && roadish(ground(bx, by + 1))
  const horizontal = roadish(ground(bx - 1, by)) && roadish(ground(bx + 1, by))
  ctx.fillStyle = shade(base, -0.22)
  if (vertical && !horizontal) {
    for (let y = 0; y < B; y += 1 + Math.floor(rng() * 3)) {
      ctx.fillRect(px + 8, py + y, 2, 1)
      ctx.fillRect(px + 22, py + y, 2, 1)
    }
  } else if (horizontal && !vertical) {
    for (let x = 0; x < B; x += 1 + Math.floor(rng() * 3)) {
      ctx.fillRect(px + x, py + 8, 1, 2)
      ctx.fillRect(px + x, py + 22, 1, 2)
    }
  }
}

function paintSand(ctx, px, py, rng, tint) {
  const base = shade(BASE.sand, tint * 0.6)
  ctx.fillStyle = base
  ctx.fillRect(px, py, B, B)
  speckle(ctx, px, py, rng, [shade(base, -0.12), shade(base, 0.1), shade(base, -0.22)], 34)
  if (rng() < 0.2) {
    ctx.fillStyle = '#a08a68' // pebble
    ctx.fillRect(px + Math.floor(rng() * (B - 2)), py + Math.floor(rng() * (B - 2)), 2, 1)
  }
}

function paintWater(ctx, ground, bx, by, px, py, rng, tint) {
  const base = shade(BASE.water, tint * 0.5)
  ctx.fillStyle = base
  ctx.fillRect(px, py, B, B)

  let openWater = true
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (ground(bx + dx, by + dy) !== TILE.WATER) openWater = false
    }
  }
  if (openWater) {
    disc(ctx, px + 10 + rng() * 12, py + 10 + rng() * 12, 8, shade(base, -0.22))
  }
  ctx.fillStyle = shade(base, 0.18)
  for (let i = 0; i < 5; i++) {
    ctx.fillRect(px + Math.floor(rng() * (B - 5)), py + Math.floor(rng() * (B - 1)), 3 + Math.floor(rng() * 3), 1)
  }
}

/** Town streets: flagstones with dark mortar, each stone lit from the top left. */
function paintCobbles(ctx, px, py, rng) {
  ctx.fillStyle = BASE.cobbleGap
  ctx.fillRect(px, py, B, B)
  const tones = ['#7c7567', '#847c6d', '#6f695c', '#78705f', '#807668']
  let y = 0
  while (y < B) {
    const rowH = 6 + Math.floor(rng() * 3)
    let x = -Math.floor(rng() * 4)
    while (x < B) {
      const w = 7 + Math.floor(rng() * 5)
      const tone = pick(rng, tones)
      const sx = px + Math.max(0, x)
      const sw = Math.min(B, x + w - 1) - Math.max(0, x)
      const sh = Math.min(B, y + rowH - 1) - y
      if (sw > 0 && sh > 0) {
        ctx.fillStyle = tone
        ctx.fillRect(sx, py + y, sw, sh)
        ctx.fillStyle = shade(tone, 0.14)
        ctx.fillRect(sx, py + y, sw, 1)
        ctx.fillStyle = shade(tone, -0.2)
        ctx.fillRect(sx, py + y + sh - 1, sw, 1)
      }
      x += w
    }
    y += rowH
  }
}

/** Border mountains and outcrop bases: cracked cliff rock. */
function paintRock(ctx, ground, bx, by, px, py, rng, tint) {
  const base = shade(BASE.rock, tint)
  ctx.fillStyle = base
  ctx.fillRect(px, py, B, B)
  for (let i = 0; i < 7; i++) {
    ctx.fillStyle = shade(base, rng() < 0.5 ? 0.1 : -0.14)
    ctx.fillRect(
      px + Math.floor(rng() * (B - 8)),
      py + Math.floor(rng() * (B - 6)),
      4 + Math.floor(rng() * 6),
      3 + Math.floor(rng() * 4),
    )
  }
  ctx.fillStyle = shade(base, -0.4)
  for (let c = 0; c < 3; c++) {
    let cx = Math.floor(rng() * B)
    let cy = Math.floor(rng() * B)
    for (let s = 0; s < 9; s++) {
      ctx.fillRect(px + ((cx % B) + B) % B, py + ((cy % B) + B) % B, 1, 1)
      cx += Math.floor(rng() * 3) - 1
      cy += rng() < 0.7 ? 1 : 0
    }
  }
  if (ground(bx, by - 1) !== TILE.ROCK) {
    ctx.fillStyle = shade(base, 0.2)
    ctx.fillRect(px, py, B, 2)
  }
  if (ground(bx, by + 1) !== TILE.ROCK) {
    ctx.fillStyle = shade(base, -0.35)
    ctx.fillRect(px, py + B - 3, B, 3)
  }
}

/** The river bridge: worn planks laid across the walking direction. */
function paintBridge(ctx, ground, bx, by, px, py, rng) {
  ctx.fillStyle = '#53381e'
  ctx.fillRect(px, py, B, B)
  let y = 0
  while (y < B) {
    const h = 5 + Math.floor(rng() * 2)
    const tone = shade(BASE.plank, (rng() - 0.5) * 0.16)
    ctx.fillStyle = tone
    ctx.fillRect(px, py + y, B, Math.min(h - 1, B - y))
    ctx.fillStyle = shade(tone, -0.2)
    for (let i = 0; i < 3; i++) {
      ctx.fillRect(px + Math.floor(rng() * (B - 6)), py + y + Math.floor(rng() * (h - 2)), 4 + Math.floor(rng() * 3), 1)
    }
    ctx.fillStyle = '#3e2a12'
    ctx.fillRect(px + 2, py + y + 1, 1, 1)
    ctx.fillRect(px + B - 3, py + y + 1, 1, 1)
    y += h
  }
  if (ground(bx, by - 1) !== TILE.BRIDGE) {
    ctx.fillStyle = '#4a3018'
    ctx.fillRect(px, py, B, 3)
  }
  if (ground(bx, by + 1) !== TILE.BRIDGE) {
    ctx.fillStyle = '#4a3018'
    ctx.fillRect(px, py + B - 3, B, 3)
  }
}

/**
 * The second pass: everything that happens where two materials meet.
 * Painted over the finished base so it can reach into both blocks.
 */
function paintTransitions(ctx, ground, bx, by) {
  const g = ground(bx, by)
  const px = bx * B
  const py = by * B
  const rng = rngFor(bx, by, 101)

  // Grass eats ragged bites out of roads, sand and shores.
  if (g === TILE.DIRT || g === TILE.SAND) {
    const grassAt = (x, y) => ground(x, y) === TILE.GRASS
    const bite = (ex, ey) => {
      const tint = (noise2(bx / 5, by / 5, 7) - 0.5) * 0.16
      disc(ctx, ex, ey, 1 + Math.floor(rng() * 2), shade(BASE.grass, tint))
    }
    for (let i = 0; i < 6; i++) {
      const t = Math.floor(rng() * B)
      if (grassAt(bx, by - 1)) bite(px + t, py + Math.floor(rng() * 2))
      if (grassAt(bx, by + 1)) bite(px + t, py + B - 1 - Math.floor(rng() * 2))
      if (grassAt(bx - 1, by)) bite(px + Math.floor(rng() * 2), py + t)
      if (grassAt(bx + 1, by)) bite(px + B - 1 - Math.floor(rng() * 2), py + t)
    }
  }

  // Water edges: wet sand against the beach, pale foam against everything else.
  if (g === TILE.WATER) {
    const edge = (dx, dy) => {
      const n = ground(bx + dx, by + dy)
      if (n === TILE.WATER) return
      const sandy = n === TILE.SAND
      const inner = sandy ? '#a8905e' : '#3f7396'
      const foam = sandy ? '#8fb6c9' : '#9cc4d8'
      for (let t = 0; t < B; t++) {
        const depth = 1 + ((rng() * 2) | 0)
        for (let d = 0; d < depth; d++) {
          const fx = dx === 0 ? px + t : dx < 0 ? px + d : px + B - 1 - d
          const fy = dy === 0 ? py + t : dy < 0 ? py + d : py + B - 1 - d
          ctx.fillStyle = d === 0 ? foam : inner
          if ((t + d) % 3 !== 0) ctx.fillRect(fx, fy, 1, 1)
        }
      }
    }
    edge(0, -1)
    edge(0, 1)
    edge(-1, 0)
    edge(1, 0)
  }

  // Cliffs throw a soft shadow onto whatever lies south of them.
  if (g !== TILE.ROCK && ground(bx, by - 1) === TILE.ROCK) {
    ctx.fillStyle = 'rgba(0, 0, 0, 0.18)'
    ctx.fillRect(px, py, B, 3)
    ctx.fillStyle = 'rgba(0, 0, 0, 0.09)'
    ctx.fillRect(px, py + 3, B, 3)
  }
}

/** Three 32 px frames of drifting ripple, overlaid on every water block. */
export function makeWaterFrames() {
  const frames = []
  for (let f = 0; f < 3; f++) {
    const { canvas, ctx } = makeCanvas(B, B)
    const rng = rngFor(9000, f)
    for (let i = 0; i < 5; i++) {
      const x = Math.floor(rng() * (B - 8))
      const y = Math.floor(rng() * (B - 2))
      const w = 4 + Math.floor(rng() * 4)
      ctx.fillStyle = 'rgba(120, 170, 205, 0.5)'
      ctx.fillRect((x + f * 3) % (B - w), y, w, 1)
    }
    ctx.fillStyle = 'rgba(200, 228, 242, 0.7)'
    ctx.fillRect(Math.floor(rng() * B), Math.floor(rng() * B), 1, 1)
    frames.push(canvas)
  }
  return frames
}
