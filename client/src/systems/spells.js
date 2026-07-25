/**
 * SPELLS SYSTEM (client) — six rail buttons, cooldown sweeps and cast FX.
 *
 * TARGETING WITHOUT A SECOND TAP is what makes this playable on a phone:
 *   - `self`, `ray`, `dash` and `melee` need no aim at all: they use the
 *     caster's facing, which the stick is already setting
 *   - everything else taps at the AUTO-TARGET: the nearest enemy in range
 *     inside the facing half. The client only proposes; the server
 *     re-validates, clamps and may pick its own. Server-authoritative, always.
 *   - long-press (250 ms) opens manual aim: a reticle follows the finger,
 *     release casts. Sliding back onto the button cancels.
 *
 * On desktop the mouse IS the aim — holding a key and dragging would be worse
 * than the pointer that is already there — so a keyboard cast simply fires at
 * whatever tile the cursor is over. Same events, same server validation.
 *
 * The cooldown sweep is a `conic-gradient` driven by ONE CSS custom property
 * updated in `onUpdate`. No extra DOM, no Pixi.
 *
 * Owns a Container in `layers.fx` (projectiles, beams, impacts) and one in
 * `layers.floor` (zone markers, the aim reticle).
 */

import { Container, Graphics } from 'pixi.js'
import { S2C, C2S } from '@shared/protocol.js'
import { TILE_SIZE, blocksToTiles } from '@shared/constants.js'
import { spellDef, spellFromIndex } from '@shared/spells.js'

/** Hold this long on a spell button to enter manual aim. */
export const AIM_HOLD_MS = 250

/** Shapes that read the caster's facing and never need a coordinate. */
const AIMLESS = new Set(['self', 'ray', 'dash', 'melee'])

/** How long a beam, a flash or an impact ring stays on screen. */
const RAY_MS = 220
const IMPACT_MS = 320
const FLASH_MS = 180

/** @type {Array<{id:string, slot:number, unlocked:boolean}>} */
let slots = []
/** spellId -> { readyAt, totalMs } in `performance.now()` time. */
const cooldowns = new Map()

/** projId -> { g, x, y, tx, ty } — server truth plus local interpolation. */
const projViews = new Map()
/** zoneId -> Graphics */
const zoneViews = new Map()
/** Short-lived graphics: beams, rings, flashes. */
const transients = []

let fxLayer = null
let floorLayer = null
let reticle = null
/** Tile the desktop pointer is over, or the touch reticle is placed on. */
let aimTile = null
/** The slot being long-pressed, while manual aim is open. */
let aiming = null
/** Desktop spell bar. On touch the rail already exists, so this stays null. */
let bar = null
/**
 * The context, stashed once. The render helpers run from the frame loop and
 * from event handlers where it is not threaded through.
 */
let ctxRef = null

export default {
  id: 'spells',

  init(ctx) {
    ctxRef = ctx
    fxLayer = new Container()
    floorLayer = new Container()
    ctx.layers.fx.addChild(fxLayer)
    ctx.layers.floor.addChild(floorLayer)

    reticle = new Graphics()
    floorLayer.addChild(reticle)

    trackPointer(ctx)
    // The rail is built from the first SPELL_BOOK, not here: the class is not
    // known until the server says so, and the book already carries the ids.
  },

  onSnapshot(ctx, snapshot) {
    syncProjectiles(ctx, snapshot.ext?.spells?.proj ?? [])
    syncZones(ctx, snapshot.ext?.spells?.zones ?? [])
  },

  onUpdate(ctx, dtMs) {
    advanceProjectiles(dtMs)
    advanceTransients(dtMs)
    drawReticle(ctx)
    renderCooldowns()
  },

  handlers: {
    [S2C.SPELL_BOOK](ctx, payload) {
      const known = Array.isArray(payload?.known) ? payload.known : []
      const isFirst = slots.length === 0
      slots = known

      if (isFirst) buildRail(ctx)
      renderLocks()
    },

    [S2C.SPELL_COOLDOWN](ctx, payload) {
      const ms = Number(payload?.ms)
      if (!payload?.id || !Number.isFinite(ms)) return
      cooldowns.set(payload.id, { readyAt: performance.now() + ms, totalMs: Math.max(1, ms) })
    },

    [S2C.SPELL_CAST_FX](ctx, payload) {
      const def = spellDef(payload?.id)
      if (!def) return

      // A projectile gets its sprite the moment it is fired rather than on the
      // next snapshot: the caster must not see their own bolt appear late.
      if (payload.projId != null && !projViews.has(payload.projId)) {
        addProjectile(payload.projId, def, payload.x0, payload.y0)
      }
      if (def.targeting !== 'projectile') flash(def, payload.x0, payload.y0)
    },

    [S2C.SPELL_RAY](ctx, payload) {
      const def = spellDef(payload?.id)
      if (!def) return
      addTransient(RAY_MS, (g, t) => {
        g.clear()
        g.moveTo(worldPos(payload.x0), worldPos(payload.y0))
          .lineTo(worldPos(payload.x1), worldPos(payload.y1))
          .stroke({ width: 3 + 3 * t, color: def.fx?.color ?? 0xffffff, alpha: t })
      })
    },

    [S2C.SPELL_IMPACT](ctx, payload) {
      const def = spellDef(payload?.id)
      if (!def) return
      const radius = Math.max(TILE_SIZE, (payload.radius ?? 0) * TILE_SIZE)
      addTransient(IMPACT_MS, (g, t) => {
        g.clear()
        g.circle(worldPos(payload.x), worldPos(payload.y), radius * (1.2 - t * 0.4)).stroke({
          width: 2,
          color: def.fx?.color ?? 0xffffff,
          alpha: t,
        })
      })
    },

    [S2C.SPELL_FAILED](ctx, payload) {
      // Cooldown is the common case and the button already shows it; saying so
      // in chat on every mistimed tap would drown the log.
      if (!payload || payload.reason === 'cooldown') return
      const name = spellDef(payload.id)?.name ?? payload.id
      ctx.chat.log(`${name}: ${REASONS[payload.reason] ?? payload.reason}`, 'err')
    },
  },
}

const REASONS = {
  locked: 'not learned yet',
  range: 'out of range',
  blocked: 'no line of sight',
  silenced: 'you are silenced',
  dead: 'you are dead',
  unknown: 'unknown spell',
}

/* ---------- the rail ---------- */

/**
 * One `ctx.action` per slot, which is a keyboard binding and a thumb button in
 * the same call. Slot 0 is the basic attack: it is `SPELLS.attack` and goes
 * through the same executor, so there is nothing special about it here.
 */
function buildRail(ctx) {
  for (const entry of slots) {
    const def = spellDef(entry.id)
    if (!def) continue

    ctx.action({
      id: `spell-${entry.slot}`,
      label: def.icon,
      key: `Digit${entry.slot + 1}`,
      onPress: () => cast(ctx, entry.slot),
    })

    const el = ctx.touch.buttonOf(`spell-${entry.slot}`)
    if (el) bindLongPress(ctx, el, entry.slot)
  }

  if (!ctx.viewport.isTouch) buildDesktopBar(ctx)
  injectStyles()
  renderLocks()
}

function slotAt(slot) {
  return slots.find((s) => s.slot === slot) ?? null
}

/** Every element that represents a slot, on whichever surface exists. */
function elementsFor(ctx, slot) {
  const out = []
  const railed = ctx?.touch?.buttonOf?.(`spell-${slot}`)
  if (railed) out.push(railed)
  const desktop = bar?.querySelector(`[data-slot="${slot}"]`)
  if (desktop) out.push(desktop)
  return out
}

function cast(ctx, slot) {
  const entry = slotAt(slot)
  const def = entry && spellDef(entry.id)
  if (!def || !entry.unlocked) return

  const payload = { id: def.id }
  if (!AIMLESS.has(def.targeting) && def.range > 0) {
    const aim = aimFor(ctx, def)
    // No target and no cursor: the server fires straight ahead, which is the
    // right answer for a keyboard player who never aimed.
    if (aim) {
      payload.tx = aim.x
      payload.ty = aim.y
    }
  }
  ctx.net.send(C2S.SPELL_CAST, payload)
}

/**
 * Where the cast is pointed: the manual reticle if one is up, otherwise the
 * desktop cursor, otherwise the nearest enemy in range.
 */
function aimFor(ctx, def) {
  if (aimTile) return aimTile
  return autoTarget(ctx, def)
}

/**
 * Nearest living enemy whose body is inside the spell's reach.
 *
 * Only a proposal — the server re-runs range and line of sight — so being
 * approximate here is free, and being wrong only costs a refusal the player
 * would have earned by aiming badly themselves.
 */
function autoTarget(ctx, def) {
  const me = ctx.movement.selfTile()
  if (!me) return null

  const reach = blocksToTiles(def.range)
  let best = null
  let bestDist = Infinity

  for (const player of ctx.state.players.values()) {
    if (player.id === ctx.state.selfId || player.dead) continue
    const dist = Math.max(Math.abs(player.x - me.x), Math.abs(player.y - me.y))
    if (dist > reach || dist >= bestDist) continue
    best = { x: player.x, y: player.y }
    bestDist = dist
  }
  return best
}

/* ---------- aiming ---------- */

/**
 * Desktop aims with the cursor; touch aims by holding a button.
 *
 * Both end up writing `aimTile`, so `cast()` never has to know which device it
 * is on.
 */
function trackPointer(ctx) {
  const canvas = ctx.app.canvas

  const toTile = (clientX, clientY) => {
    const rect = canvas.getBoundingClientRect()
    const local = ctx.layers.camera.toLocal({ x: clientX - rect.left, y: clientY - rect.top })
    return { x: Math.floor(local.x / TILE_SIZE), y: Math.floor(local.y / TILE_SIZE) }
  }

  if (!ctx.viewport.isTouch) {
    canvas.addEventListener('pointermove', (e) => {
      aimTile = toTile(e.clientX, e.clientY)
    })
    canvas.addEventListener('pointerleave', () => {
      aimTile = null
    })
    return
  }

  // Touch: the reticle only exists while a button is held, and the pointer that
  // opened it is the one that moves it.
  document.addEventListener(
    'pointermove',
    (e) => {
      if (!aiming) return
      aimTile = toTile(e.clientX, e.clientY)
    },
    { passive: true },
  )
}

/**
 * A tap casts at the auto-target; a hold opens the reticle and casts where it
 * is released. The button's own `onPress` already fired on tap, so the hold
 * path has to suppress it — hence the flag rather than a second binding.
 */
function bindLongPress(ctx, el, slot) {
  let timer = null

  el.addEventListener('pointerdown', () => {
    const entry = slotAt(slot)
    const def = entry && spellDef(entry.id)
    if (!def || AIMLESS.has(def.targeting) || def.range <= 0) return

    timer = setTimeout(() => {
      aiming = { slot }
      aimTile = null
      el.classList.add('aiming')
    }, AIM_HOLD_MS)
  })

  const release = () => {
    clearTimeout(timer)
    if (!aiming) return
    el.classList.remove('aiming')

    // Released without ever moving: the player changed their mind.
    if (aimTile) cast(ctx, aiming.slot)
    aiming = null
    aimTile = null
  }
  el.addEventListener('pointerup', release)
  el.addEventListener('pointercancel', release)
}

function drawReticle(ctx) {
  reticle.clear()
  if (!aimTile || (ctx.viewport.isTouch && !aiming)) return

  const slot = aiming ? slotAt(aiming.slot) : null
  const def = slot ? spellDef(slot.id) : null
  const colour = def?.fx?.color ?? 0xffffff

  reticle
    .rect(aimTile.x * TILE_SIZE - 6, aimTile.y * TILE_SIZE - 6, TILE_SIZE + 12, TILE_SIZE + 12)
    .stroke({ width: 1.5, color: colour, alpha: 0.85 })

  if (def?.radius > 0) {
    reticle
      .circle(worldPos(aimTile.x), worldPos(aimTile.y), blocksToTiles(def.radius) * TILE_SIZE)
      .stroke({ width: 1, color: colour, alpha: 0.4 })
  }
}

/* ---------- projectiles and zones ---------- */

/**
 * The snapshot is the truth; the frame loop is the smoothing.
 *
 * A projectile arrives 15 times a second and is drawn 60, so each view keeps
 * where the server last put it and eases towards it — the same trade
 * `render/entities.js` makes for players.
 */
function syncProjectiles(ctx, wire) {
  const alive = new Set()

  for (const [id, spellIdx, x10, y10] of wire) {
    alive.add(id)
    const def = spellDef(spellFromIndex(spellIdx))
    if (!def) continue

    const view = projViews.get(id) ?? addProjectile(id, def, x10 / 10, y10 / 10)
    view.tx = x10 / 10
    view.ty = y10 / 10
  }

  for (const [id, view] of projViews) {
    if (alive.has(id)) continue
    view.g.destroy()
    projViews.delete(id)
  }
}

function addProjectile(id, def, tx, ty) {
  const g = new Graphics()
  const colour = def.fx?.color ?? 0xffffff
  const size = def.fx?.shape === 'bolt' ? 2 : 3
  g.circle(0, 0, size).fill(colour).stroke({ width: 1, color: 0x000000, alpha: 0.4 })

  const view = { g, x: tx, y: ty, tx, ty }
  g.x = worldPos(tx)
  g.y = worldPos(ty)
  fxLayer.addChild(g)
  projViews.set(id, view)
  return view
}

function advanceProjectiles(dtMs) {
  const k = 1 - Math.pow(1 - 0.5, Math.min(4, dtMs / 16.67))
  for (const view of projViews.values()) {
    view.x += (view.tx - view.x) * k
    view.y += (view.ty - view.y) * k
    view.g.x = worldPos(view.x)
    view.g.y = worldPos(view.y)
  }
}

function syncZones(ctx, wire) {
  const alive = new Set()

  for (const [id, spellIdx, x, y, radius] of wire) {
    alive.add(id)
    if (zoneViews.has(id)) continue

    const def = spellDef(spellFromIndex(spellIdx))
    const g = new Graphics()
    g.circle(worldPos(x), worldPos(y), Math.max(TILE_SIZE, radius * TILE_SIZE)).fill({
      color: def?.fx?.color ?? 0xffffff,
      alpha: 0.18,
    })
    floorLayer.addChild(g)
    zoneViews.set(id, g)
  }

  for (const [id, g] of zoneViews) {
    if (alive.has(id)) continue
    g.destroy()
    zoneViews.delete(id)
  }
}

/* ---------- transient FX ---------- */

/** @param {(g:Graphics, t:number) => void} draw  `t` runs 1 -> 0 over the life. */
function addTransient(ttlMs, draw) {
  const g = new Graphics()
  fxLayer.addChild(g)
  transients.push({ g, draw, life: ttlMs, ttl: ttlMs })
}

function flash(def, x, y) {
  addTransient(FLASH_MS, (g, t) => {
    g.clear()
    g.circle(worldPos(x), worldPos(y), TILE_SIZE * 2 * (1.4 - t)).stroke({
      width: 2,
      color: def.fx?.color ?? 0xffffff,
      alpha: t * 0.8,
    })
  })
}

function advanceTransients(dtMs) {
  for (let i = transients.length - 1; i >= 0; i--) {
    const fx = transients[i]
    fx.life -= dtMs
    if (fx.life <= 0) {
      fx.g.destroy()
      transients.splice(i, 1)
      continue
    }
    fx.draw(fx.g, fx.life / fx.ttl)
  }
}

/* ---------- cooldowns and locks ---------- */

/**
 * One CSS custom property per button, read by a `conic-gradient` in the
 * injected stylesheet. Writing a number is cheaper than touching the DOM tree,
 * and this runs every frame.
 */
function renderCooldowns() {
  const now = performance.now()

  for (const entry of slots) {
    const cd = cooldowns.get(entry.id)
    const left = cd ? Math.max(0, cd.readyAt - now) : 0
    const fraction = cd && left > 0 ? left / cd.totalMs : 0

    for (const el of elementsFor(ctxRef, entry.slot)) {
      el.style.setProperty('--cd', fraction.toFixed(3))
      el.classList.toggle('cooling', fraction > 0)
    }
  }
}

function renderLocks() {
  for (const entry of slots) {
    for (const el of elementsFor(ctxRef, entry.slot)) {
      el.classList.toggle('locked', !entry.unlocked)
      el.title = lockLabel(entry)
    }
  }
}

function lockLabel(entry) {
  const def = spellDef(entry.id)
  if (!def) return ''
  if (entry.unlocked) return `${def.name} (${entry.slot + 1})`
  return `${def.name} — locked`
}

/* ---------- desktop bar ---------- */

/**
 * The action rail only exists on touch, so a desktop player would have no way
 * to see a cooldown or a locked slot. Same state, second surface — bottom
 * centre, which is not a reserved zone when the touch HUD is hidden.
 */
function buildDesktopBar(ctx) {
  bar = document.createElement('div')
  bar.id = 'spell-bar'

  for (const entry of slots) {
    const def = spellDef(entry.id)
    if (!def) continue

    const el = document.createElement('button')
    el.type = 'button'
    el.className = 'spell-slot'
    el.dataset.slot = String(entry.slot)
    el.innerHTML = `<span class="ic">${def.icon}</span><i class="key">${entry.slot + 1}</i>`
    el.addEventListener('click', () => cast(ctx, entry.slot))
    bar.appendChild(el)
  }

  document.getElementById('hud').appendChild(bar)
}

/* ---------- helpers ---------- */

/** Pixel centre of a tile coordinate, accepting fractions for projectiles. */
function worldPos(tile) {
  return tile * TILE_SIZE + TILE_SIZE / 2
}

/**
 * Styles live with the system, not in styles.css, so the feature stays one
 * file per side.
 */
function injectStyles() {
  const style = document.createElement('style')
  style.textContent = `
    /* The sweep: a dark wedge shrinking clockwise as the cooldown runs out.
       Both selectors carry their parent id on purpose. The rules that paint
       these buttons use the background shorthand, and the shorthand resets
       background-image to none, so a less specific sweep rule would be
       silently discarded rather than merged. */
    #actions .action-btn.cooling,
    #spell-bar .spell-slot.cooling {
      background-image: conic-gradient(
        rgba(0, 0, 0, 0.62) calc(var(--cd, 0) * 360deg),
        transparent 0
      );
    }
    /* The rail's buttons are not positioned by default and the lock glyph is. */
    .action-btn { position: relative; }
    .action-btn.locked, .spell-slot.locked { opacity: 0.35; }
    .action-btn.locked::after, .spell-slot.locked::after {
      content: '🔒';
      position: absolute;
      right: 2px;
      bottom: 0;
      font-size: 10px;
    }
    .action-btn.aiming { outline: 2px solid var(--accent); }

    #spell-bar {
      position: absolute;
      left: 50%;
      transform: translateX(-50%);
      bottom: calc(12px + var(--safe-b) + var(--kb));
      display: flex;
      gap: 6px;
      z-index: 12;
    }
    #spell-bar .spell-slot {
      position: relative;
      width: 44px;
      height: 44px;
      border: 1px solid rgba(255, 255, 255, 0.18);
      border-radius: 8px;
      background: rgba(16, 19, 26, 0.82);
      color: #fff;
      font-size: 18px;
      line-height: 1;
      cursor: pointer;
    }
    #spell-bar .spell-slot .key {
      position: absolute;
      left: 3px;
      top: 2px;
      font-size: 9px;
      font-style: normal;
      opacity: 0.55;
    }
    /* The rail owns the bottom-right corner on a phone; this bar is desktop only. */
    body.touch #spell-bar { display: none; }
  `
  document.head.appendChild(style)
}
