/**
 * Input -> network intents. Keyboard on desktop, virtual stick on touch.
 *
 * The core only binds movement and chat. Any other key belongs to a system,
 * and a system should bind it through `ctx.action(...)` (see ui/touch.js) so
 * it also gets a thumb button on mobile. `input.onKey('KeyQ', fn)` remains the
 * keyboard-only escape hatch. Either way, never edit this file to add a
 * binding — that is what keeps keybindings out of merge conflicts.
 */

import { DIR } from '@shared/constants.js'
import { movement } from './movement.js'

const MOVE_KEYS = {
  ArrowUp: DIR.UP,
  ArrowDown: DIR.DOWN,
  ArrowLeft: DIR.LEFT,
  ArrowRight: DIR.RIGHT,
  KeyW: DIR.UP,
  KeyS: DIR.DOWN,
  KeyA: DIR.LEFT,
  KeyD: DIR.RIGHT,
}

const pressed = new Set()
const customKeys = new Map()
let enabled = false
/** Direction held by the on-screen stick, or null. Owned by ui/touch.js. */
let virtualDir = null

export const input = {
  start() {
    enabled = true
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', release)
    // Backgrounding a phone browser never delivers keyup or pointerup.
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) release()
    })
  },

  /** Binds a key. `code` is a KeyboardEvent.code, e.g. 'KeyQ'. */
  onKey(code, fn) {
    customKeys.set(code, fn)
  },

  /** Called by the on-screen stick. Pass null when the thumb lifts. */
  setVirtualDir(dir) {
    virtualDir = dir ?? null
  },

  /**
   * Called every frame. Movement goes to the predictor, which walks the local
   * player immediately and rate limits itself — that is what makes holding a
   * key feel the same on a server two continents away.
   */
  update() {
    if (!enabled) return
    movement.step(virtualDir ?? heldDir())
  },

  get pressed() {
    return pressed
  },
}

/** First held movement key, ignoring the keyboard entirely while typing. */
function heldDir() {
  if (isTyping()) return null
  for (const code of pressed) {
    const dir = MOVE_KEYS[code]
    if (dir !== undefined) return dir
  }
  return null
}

function release() {
  pressed.clear()
  virtualDir = null
}

function isTyping() {
  const el = document.activeElement
  return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')
}

function onKeyDown(e) {
  if (isTyping()) return
  pressed.add(e.code)

  if (MOVE_KEYS[e.code] !== undefined) {
    e.preventDefault()
    return
  }

  const custom = customKeys.get(e.code)
  if (custom) {
    e.preventDefault()
    custom(e)
  }
}

function onKeyUp(e) {
  pressed.delete(e.code)
}
