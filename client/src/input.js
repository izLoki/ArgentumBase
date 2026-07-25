/**
 * Keyboard input -> network intents.
 *
 * The core only binds movement and chat. Any other key belongs to a system:
 * call `input.onKey('KeyQ', fn)` from your own module instead of editing this
 * file, so keybindings never cause merge conflicts.
 */

import { C2S } from '@shared/protocol.js'
import { DIR } from '@shared/constants.js'
import { net } from './net.js'

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

const REPEAT_MS = 120

const pressed = new Set()
const customKeys = new Map()
let lastMoveSentAt = 0
let enabled = false

export const input = {
  start() {
    enabled = true
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', () => pressed.clear())
  },

  /** Binds a key. `code` is a KeyboardEvent.code, e.g. 'KeyQ'. */
  onKey(code, fn) {
    customKeys.set(code, fn)
  },

  /** Called every frame: sends held-down movement. */
  update() {
    if (!enabled || isTyping()) return
    const now = performance.now()
    if (now - lastMoveSentAt < REPEAT_MS) return

    for (const code of pressed) {
      const dir = MOVE_KEYS[code]
      if (dir === undefined) continue
      net.send(C2S.MOVE, { dir })
      lastMoveSentAt = now
      return
    }
  },

  get pressed() {
    return pressed
  },
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
