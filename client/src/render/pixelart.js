/**
 * Small toolbox for procedural pixel art.
 *
 * Everything the terrain and prop painters share: a deterministic RNG seeded by
 * coordinates (the same block always paints the same), smooth value noise for
 * large scale tinting, and canvas helpers that keep the art crisp.
 */

/** Deterministic 32-bit hash of up to three integers. */
function hash(x, y = 0, z = 0) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(z | 0, 2246822519)
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return (h ^ (h >>> 16)) >>> 0
}

/** Mulberry32 stream seeded from coordinates: one rng per block or prop. */
export function rngFor(x, y = 0, z = 0) {
  let a = hash(x, y, z)
  return function rng() {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Smooth value noise in [0, 1]. Low frequency input gives meadow-scale tint. */
export function noise2(x, y, seed = 0) {
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  const fx = x - x0
  const fy = y - y0
  const sx = fx * fx * (3 - 2 * fx)
  const sy = fy * fy * (3 - 2 * fy)
  const at = (ix, iy) => hash(ix, iy, seed) / 4294967296
  const top = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * sx
  const bot = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * sx
  return top + (bot - top) * sy
}

export function makeCanvas(w, h) {
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  ctx.imageSmoothingEnabled = false
  return { canvas, ctx }
}

/**
 * Shift a '#rrggbb' colour towards black (amt < 0) or white (amt > 0).
 * The workhorse of every painter: one base tone per material, shaded per pixel.
 */
export function shade(hex, amt) {
  const n = parseInt(hex.slice(1), 16)
  const ch = (v) => {
    const moved = amt < 0 ? v * (1 + amt) : v + (255 - v) * amt
    return Math.max(0, Math.min(255, Math.round(moved)))
  }
  const r = ch((n >> 16) & 0xff)
  const g = ch((n >> 8) & 0xff)
  const b = ch(n & 0xff)
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`
}

export function pick(rng, arr) {
  return arr[Math.floor(rng() * arr.length)]
}

/** Filled disc out of whole pixels: the primitive every blobby shape is built from. */
export function disc(ctx, cx, cy, r, color) {
  ctx.fillStyle = color
  for (let y = -r; y <= r; y++) {
    const half = Math.floor(Math.sqrt(r * r - y * y))
    ctx.fillRect(Math.round(cx - half), Math.round(cy + y), half * 2 + 1, 1)
  }
}
