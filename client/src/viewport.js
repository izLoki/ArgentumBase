/**
 * Viewport: device class, world zoom and landscape enforcement.
 *
 * Core infrastructure. A system that needs a different affordance on a phone
 * reads `ctx.viewport.isMobile` — it never measures the window itself, so the
 * whole client agrees on what "mobile" means.
 */

import { TILE_SIZE } from '@shared/constants.js'

/** Vertical tiles we try to keep on screen on a phone. */
const TARGET_TILES_V = 12
const MAX_ZOOM = 2
/** Short-edge size, in CSS px, below which a touch device counts as a phone. */
const SMALL_EDGE_PX = 820

const listeners = new Set()
let zoom = 1

/**
 * Touch-*primary* device, not merely touch-capable: a laptop with a touch
 * screen must keep the desktop HUD, or the stick would eat its mouse clicks.
 * `?touch=1` forces it on so the mobile layout can be tested on a desktop.
 */
function detectTouch() {
  if (new URLSearchParams(location.search).has('touch')) return true
  if (matchMedia('(pointer: fine)').matches) return false
  return matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0
}

export const viewport = {
  /** Drives every mobile affordance in the client. */
  isTouch: detectTouch(),

  get isMobile() {
    return viewport.isTouch && Math.min(window.innerWidth, window.innerHeight) <= SMALL_EDGE_PX
  },

  get isPortrait() {
    return window.innerHeight > window.innerWidth
  },

  /** World scale. Only the camera applies it. */
  get zoom() {
    return zoom
  },

  mount() {
    document.body.classList.toggle('touch', viewport.isTouch)
    sync()
    window.addEventListener('resize', sync)
    window.addEventListener('orientationchange', sync)
    window.visualViewport?.addEventListener('resize', syncKeyboard)
    window.visualViewport?.addEventListener('scroll', syncKeyboard)
  },

  /**
   * Best effort landscape. Must be called from inside a user gesture: browsers
   * only grant fullscreen and an orientation lock while one is being handled.
   * iOS Safari grants neither, which is why the rotate overlay also exists.
   */
  async requestLandscape() {
    if (!viewport.isMobile) return
    try {
      await document.documentElement.requestFullscreen?.({ navigationUI: 'hide' })
    } catch {
      // fullscreen refused: the rotate overlay covers this case
    }
    try {
      await screen.orientation?.lock?.('landscape')
    } catch {
      // lock unsupported (iOS, desktop): same fallback
    }
  },

  /** Fires on resize, rotation and zoom changes. Returns an unsubscribe fn. */
  onChange(fn) {
    listeners.add(fn)
    return () => listeners.delete(fn)
  },
}

function sync() {
  document.body.classList.toggle('portrait', viewport.isPortrait)

  zoom = viewport.isMobile
    ? Math.min(MAX_ZOOM, Math.max(1, window.innerHeight / (TARGET_TILES_V * TILE_SIZE)))
    : 1

  setVar('--app-h', `${window.innerHeight}px`)
  syncKeyboard()

  for (const fn of listeners) {
    try {
      fn(viewport)
    } catch (err) {
      console.error('[viewport] listener threw:', err)
    }
  }
}

/**
 * The soft keyboard shrinks the visual viewport without resizing the layout
 * one, so anything anchored to the bottom ends up underneath it. `--kb` is how
 * far up those elements have to move.
 */
function syncKeyboard() {
  const vv = window.visualViewport
  const overlap = vv ? Math.max(0, window.innerHeight - vv.height - vv.offsetTop) : 0
  setVar('--kb', `${Math.round(overlap)}px`)
}

function setVar(name, value) {
  document.documentElement.style.setProperty(name, value)
}
