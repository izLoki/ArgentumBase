/**
 * Touch controls: a floating movement stick and a rail of action buttons.
 *
 * Systems must not build their own touch widgets. Call `ctx.action(...)` once
 * and the feature gets a keyboard binding on desktop and a thumb button on a
 * phone — otherwise it is simply unreachable on mobile.
 */

import { DIR } from '@shared/constants.js'
import { input } from '../input.js'
import { viewport } from '../viewport.js'

/** Travel before a direction is emitted, and the knob's full throw. */
const DEAD_ZONE_PX = 14
const STICK_RADIUS_PX = 46

let root = null
let base = null
let knob = null
let rail = null
let pointerId = null
let originX = 0
let originY = 0

/** id -> button element. Populated before mount if a system registers early. */
const buttons = new Map()

export const touch = {
  /** Safe to call on desktop: it does nothing there. */
  mount() {
    if (!viewport.isTouch || root) return

    root = document.getElementById('touch')
    if (!root) return
    root.classList.remove('hidden')

    base = root.querySelector('#stick')
    knob = root.querySelector('#stick-knob')
    rail = root.querySelector('#actions')

    const zone = root.querySelector('#stick-zone')
    zone.addEventListener('pointerdown', onDown)
    zone.addEventListener('pointermove', onMove)
    zone.addEventListener('pointerup', onUp)
    zone.addEventListener('pointercancel', onUp)

    for (const el of buttons.values()) rail.appendChild(el)
  },

  /** Prefer `action()` below: this only covers the mobile half. */
  addButton({ id, label, onPress, onRelease }) {
    if (!viewport.isTouch || buttons.has(id)) return

    const el = document.createElement('button')
    el.type = 'button'
    el.className = 'action-btn'
    el.dataset.action = id
    el.textContent = label

    el.addEventListener('pointerdown', (e) => {
      e.preventDefault() // keep the tap from focusing or scrolling anything
      el.classList.add('down')
      onPress?.()
    })
    const release = () => {
      el.classList.remove('down')
      onRelease?.()
    }
    el.addEventListener('pointerup', release)
    el.addEventListener('pointercancel', release)
    el.addEventListener('pointerleave', release)

    buttons.set(id, el)
    rail?.appendChild(el)
  },

  removeButton(id) {
    buttons.get(id)?.remove()
    buttons.delete(id)
  },
}

/**
 * One call, both input methods. Use this from a system instead of binding a
 * key directly.
 *
 *   ctx.action({ id: 'attack', label: '⚔', key: 'ControlLeft', onPress: fn })
 */
export function action({ id, label, key, onPress, onRelease }) {
  if (key) input.onKey(key, () => onPress?.())
  touch.addButton({ id, label, onPress, onRelease })
}

function onDown(e) {
  if (pointerId !== null) return
  pointerId = e.pointerId
  e.currentTarget.setPointerCapture?.(e.pointerId)

  originX = e.clientX
  originY = e.clientY
  base.style.left = `${originX}px`
  base.style.top = `${originY}px`
  base.classList.remove('hidden')

  // Typing and walking are mutually exclusive; the stick wins.
  document.activeElement?.blur?.()
  moveKnob(0, 0)
}

function onMove(e) {
  if (e.pointerId !== pointerId) return

  const dx = e.clientX - originX
  const dy = e.clientY - originY
  const dist = Math.hypot(dx, dy)
  const scale = dist > STICK_RADIUS_PX ? STICK_RADIUS_PX / dist : 1

  moveKnob(dx * scale, dy * scale)
  input.setVirtualDir(dist < DEAD_ZONE_PX ? null : dominantDir(dx, dy))
}

function onUp(e) {
  if (e.pointerId !== pointerId) return
  pointerId = null
  base.classList.add('hidden')
  moveKnob(0, 0)
  input.setVirtualDir(null)
}

function moveKnob(x, y) {
  knob.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`
}

/** The server only accepts the four cardinals, so a diagonal picks an axis. */
function dominantDir(dx, dy) {
  if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? DIR.RIGHT : DIR.LEFT
  return dy > 0 ? DIR.DOWN : DIR.UP
}
