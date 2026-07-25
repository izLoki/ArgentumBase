/**
 * Minimap radar: top-left, the local player always dead centre. Every other
 * living player within RADAR_RANGE tiles shows as a red dot; nothing else is
 * drawn — no terrain, no NPCs. It only reads state the snapshot already
 * carries, so it is pure display with no server counterpart to wire up.
 */

import { blocksToTiles } from '@shared/constants.js'
import { state, self } from '../state.js'
import { movement } from '../movement.js'

const SIZE = 128 // CSS px, desktop
const TOUCH_SIZE = 84 // smaller: the top-left corner is tight on a phone
const RADIUS = SIZE / 2
const TOUCH_RADIUS = TOUCH_SIZE / 2

/** "Nearby" cutoff — wider than one screen, well short of the whole map. */
const RADAR_RANGE_TILES = blocksToTiles(24)

const SELF_COLOR = '#d9b14f'
const OTHER_COLOR = '#e23b3b'

let canvas = null
let ctx2d = null
let radius = RADIUS

export const minimap = {
  mount() {
    injectStyles()

    canvas = document.createElement('canvas')
    canvas.id = 'minimap'
    document.getElementById('hud').appendChild(canvas)

    sizeCanvas()
    window.addEventListener('resize', sizeCanvas)
  },

  update() {
    if (!ctx2d) return
    const at = movement.selfTile() ?? self()
    if (!at) return

    ctx2d.clearRect(0, 0, radius * 2, radius * 2)
    drawFrame()

    for (const view of state.players.values()) {
      if (view.id === state.selfId || view.dead) continue

      const dx = view.x - at.x
      const dy = view.y - at.y
      if (Math.hypot(dx, dy) > RADAR_RANGE_TILES) continue

      const px = radius + (dx / RADAR_RANGE_TILES) * radius
      const py = radius + (dy / RADAR_RANGE_TILES) * radius
      drawDot(px, py, 3, OTHER_COLOR)
    }

    drawDot(radius, radius, 4, SELF_COLOR, true)
  },
}

function sizeCanvas() {
  if (!canvas) return
  const touch = document.body.classList.contains('touch')
  radius = touch ? TOUCH_RADIUS : RADIUS

  const dpr = window.devicePixelRatio || 1
  canvas.width = radius * 2 * dpr
  canvas.height = radius * 2 * dpr
  canvas.style.width = `${radius * 2}px`
  canvas.style.height = `${radius * 2}px`

  ctx2d = canvas.getContext('2d')
  ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0)
}

function drawFrame() {
  ctx2d.save()
  ctx2d.beginPath()
  ctx2d.arc(radius, radius, radius - 1, 0, Math.PI * 2)
  ctx2d.fillStyle = 'rgba(10, 8, 5, 0.72)'
  ctx2d.fill()
  ctx2d.lineWidth = 2
  ctx2d.strokeStyle = '#6b5426'
  ctx2d.stroke()

  ctx2d.clip()
  ctx2d.strokeStyle = 'rgba(217, 177, 79, 0.15)'
  ctx2d.lineWidth = 1
  ctx2d.beginPath()
  ctx2d.moveTo(radius, 0)
  ctx2d.lineTo(radius, radius * 2)
  ctx2d.moveTo(0, radius)
  ctx2d.lineTo(radius * 2, radius)
  ctx2d.stroke()
  ctx2d.restore()
}

function drawDot(x, y, r, color, ring = false) {
  ctx2d.beginPath()
  ctx2d.fillStyle = color
  ctx2d.arc(x, y, r, 0, Math.PI * 2)
  ctx2d.fill()
  if (ring) {
    ctx2d.lineWidth = 1
    ctx2d.strokeStyle = 'rgba(255, 255, 255, 0.65)'
    ctx2d.stroke()
  }
}

/**
 * Styles live with the module, like the sidebar and the profile panel. Sits
 * just under the stats bars on desktop; on touch it moves beside them,
 * shrunk to clear the stick zone and the chat log without touching either
 * file — see CLAUDE.md's mobile screen budget.
 */
function injectStyles() {
  const style = document.createElement('style')
  style.textContent = `
    #minimap {
      position: absolute;
      top: calc(104px + var(--safe-t));
      left: calc(12px + var(--safe-l));
      border-radius: 50%;
      pointer-events: none;
      z-index: 11;
    }
    body.touch #minimap {
      top: calc(8px + var(--safe-t));
      left: calc(164px + var(--safe-l));
    }
  `
  document.head.appendChild(style)
}
