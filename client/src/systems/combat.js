/**
 * COMBAT SYSTEM (client) — the attack action and everything a hit looks like.
 *
 * Pairs with server/systems/combat.js and only runs once that half is enabled.
 * The client never decides an outcome: it draws what the server reports.
 *
 * Owns, in `layers.fx`: floating damage numbers and hit flashes.
 * Owns, in the DOM: the kill feed (top centre) and the death overlay. Both are
 * screen-space UI, and DOM is where screen-space UI lives in this client — the
 * Pixi layers scroll with the camera.
 *
 * HUD: write through `ctx.hud.setStats` — never reach into the HUD's elements.
 * That is the one place this system and `profile` could collide.
 *
 * THE ⚔ BUTTON IS TWO BUTTONS. Alive it attacks; dead it respawns. On a phone
 * that is the difference between a respawn button somewhere new and the thumb
 * already being where the answer is.
 */

import { Container, Graphics, Text } from 'pixi.js'
import { S2C, C2S } from '@shared/protocol.js'
import { tileCentre, viewPosition, viewHeadY } from '../render/entities.js'

/**
 * Mirror of RESPAWN_DELAY_MS in server/systems/combat.js — keep them in sync.
 * For the countdown label alone: the server stays the authority, and
 * respawning early just answers RATE_LIMIT.
 */
const RESPAWN_DELAY_MS = 3000

/** Floating numbers: how far they rise and how long they live. */
const FLOAT_RISE_PX = 34
const FLOAT_MS = 900
/** The last part of a float's life is spent fading. */
const FLOAT_FADE_FROM = 0.55

/** Hit flash: a burst that grows to this radius and is gone. */
const FLASH_R_PX = 14
const FLASH_MS = 170

const FEED_TTL_MS = 6000
const FEED_MAX_ROWS = 5

/** What each school of damage looks like. Heals are their own colour. */
const SCHOOL_COLORS = {
  physical: 0xffffff,
  fire: 0xff7a3c,
  frost: 0x9ad7ff,
  lightning: 0xffe066,
  heal: 0x6fe08a,
}
const DODGE_COLOR = 0xa9b2c3

/** Where a number hangs when the target has no drawing to anchor to (mobs). */
const BARE_HEAD_Y = -18

let fxRoot = null
/** { view, ageMs, ms, fromY } — numbers rising through `layers.fx`. */
let floats = []
/** { view, ageMs } — hit bursts, same layer. */
let flashes = []

let feedEl = null
let overlayEl = null
let overlayEls = null
/** When the respawn button unlocks; 0 while alive. */
let respawnReadyAt = 0

/** Last score pushed to the HUD, so a snapshot 15 times a second is free. */
let shown = { kills: -1, deaths: -1 }

export default {
  id: 'combat',

  init(ctx) {
    fxRoot = new Container()
    ctx.layers.fx.addChild(fxRoot)
    floats = []
    flashes = []

    injectStyles()
    buildFeed()
    buildOverlay(ctx)

    shown = { kills: -1, deaths: -1 } // a reconnect starts a new player

    // The attack is `SPELLS.attack`, slot 0 of the rail, and `spells` owns the
    // whole rail once it is live — binding it here too would put two ⚔ buttons
    // on a phone and run two independent cooldowns. This binding is the
    // fallback for a world running combat without spells; while it is off, the
    // death overlay's own button is what respawns.
    if (ctx.state.systems.spells) return

    ctx.action({
      id: 'attack',
      label: '⚔',
      key: 'Space',
      onPress: () => {
        if (ctx.self()?.dead) ctx.net.send(C2S.COMBAT_RESPAWN, {})
        else ctx.net.send(C2S.COMBAT_ATTACK, {})
      },
    })
  },

  /**
   * The scoreboard rides the snapshot as `{ score: { id: [kills, deaths] } }`.
   * Only the local player's row reaches the HUD, and only when it changes.
   */
  onSnapshot(ctx, snapshot) {
    // One-shot events can be lost; the snapshot is full state and cannot be.
    // Whatever the death and respawn events said, the snapshot has the truth.
    const me = ctx.self()
    if (me) {
      const overlayUp = !overlayEl.classList.contains('hidden')
      if (me.dead && !overlayUp) showOverlay(null)
      if (!me.dead && overlayUp) hideOverlay()
    }

    const row = snapshot.ext?.combat?.score?.[ctx.state.selfId]
    if (!row) return

    const [kills, deaths] = row
    if (kills === shown.kills && deaths === shown.deaths) return

    shown = { kills, deaths }
    ctx.hud.setStats({ kills, deaths })
  },

  onUpdate(ctx, dtMs) {
    updateFloats(dtMs)
    updateFlashes(dtMs)
    updateOverlay()
  },

  handlers: {
    /** One hit, one number. Negative amounts are heals; zero is a dodge. */
    [S2C.COMBAT_HIT](ctx, payload) {
      const pos = anchorOf(payload.kind, payload.id, payload.x, payload.y)
      if (!pos) return

      if (payload.amount === 0) {
        floatText(ctx, pos.x, pos.y, 'dodge', { color: DODGE_COLOR })
        return
      }
      if (payload.amount < 0) {
        floatText(ctx, pos.x, pos.y, `+${-payload.amount}`, { color: SCHOOL_COLORS.heal })
        return
      }

      const color = SCHOOL_COLORS[payload.school] ?? SCHOOL_COLORS.physical
      floatText(ctx, pos.x, pos.y, `${payload.amount}`, { color, crit: payload.crit })
      spawnFlash(pos.x, pos.y + FLASH_R_PX, color)
    },

    [S2C.COMBAT_DEATH](ctx, payload) {
      if (payload.kind === 'player' && payload.id === ctx.state.selfId) {
        showOverlay(payload.killerName)
        return
      }
      // Someone else's death still reads at a glance, wherever it happened.
      const pos = payload.kind === 'player' ? headAnchor(payload.id) : null
      if (pos) floatText(ctx, pos.x, pos.y, '☠', { ms: 1400 })
    },

    [S2C.COMBAT_RESPAWNED](ctx, payload) {
      if (payload.id !== ctx.state.selfId) return
      hideOverlay()
      floatText(ctx, tileCentre(payload.x), tileCentre(payload.y) + BARE_HEAD_Y, 'protected', {
        color: SCHOOL_COLORS.heal,
        ms: payload.protectedMs ?? 1500,
      })
    },

    [S2C.COMBAT_KILLFEED](ctx, payload) {
      pushFeedRow(payload)
    },
  },
}

/* ---------- API for other client systems ---------- */

/**
 * Floating world-space text: damage numbers, misses, "immune". Other systems
 * use it so every number in the game rises and fades the same way.
 *
 * @param {Object} ctx
 * @param {number} x       world pixels
 * @param {number} y       world pixels
 * @param {string} text
 * @param {Object} [opts]
 * @param {number} [opts.color]
 * @param {number} [opts.ms]
 * @param {boolean} [opts.crit]  bigger and louder
 */
export function floatText(ctx, x, y, text, opts = {}) {
  if (!fxRoot) return

  const view = new Text({
    text,
    style: {
      fontFamily: 'Segoe UI, sans-serif',
      fontSize: opts.crit ? 17 : 12,
      fontWeight: 'bold',
      fill: opts.color ?? 0xffffff,
      stroke: { color: 0x000000, width: 3 },
    },
  })
  view.anchor.set(0.5, 1)
  // A small horizontal scatter, so two hits in one tick do not print on top of
  // each other and read as one.
  view.x = x + (Math.random() - 0.5) * 10
  view.y = y
  fxRoot.addChild(view)

  floats.push({ view, ageMs: 0, ms: opts.ms ?? FLOAT_MS, fromY: view.y })
}

/* ---------- fx ---------- */

function updateFloats(dtMs) {
  for (let i = floats.length - 1; i >= 0; i--) {
    const f = floats[i]
    f.ageMs += dtMs
    const t = f.ageMs / f.ms

    if (t >= 1) {
      f.view.destroy()
      floats.splice(i, 1)
      continue
    }
    f.view.y = f.fromY - FLOAT_RISE_PX * t
    f.view.alpha = t < FLOAT_FADE_FROM ? 1 : 1 - (t - FLOAT_FADE_FROM) / (1 - FLOAT_FADE_FROM)
  }
}

function spawnFlash(x, y, color) {
  const view = new Graphics()
  view.circle(0, 0, FLASH_R_PX).fill({ color, alpha: 0.55 })
  view.x = x
  view.y = y
  view.scale.set(0.3)
  fxRoot.addChild(view)
  flashes.push({ view, ageMs: 0 })
}

function updateFlashes(dtMs) {
  for (let i = flashes.length - 1; i >= 0; i--) {
    const f = flashes[i]
    f.ageMs += dtMs
    const t = f.ageMs / FLASH_MS

    if (t >= 1) {
      f.view.destroy()
      flashes.splice(i, 1)
      continue
    }
    f.view.scale.set(0.3 + 0.7 * t)
    f.view.alpha = 1 - t
  }
}

/**
 * Where a hit's number starts, in world pixels. A player's drawing is the
 * anchor when there is one — it is interpolated, the snapshot tile is not.
 * Anything else falls back to the tile the server named.
 */
function anchorOf(kind, id, tx, ty) {
  if (kind === 'player') {
    const head = headAnchor(id)
    if (head) return head
  }
  return { x: tileCentre(tx), y: tileCentre(ty) + BARE_HEAD_Y }
}

function headAnchor(id) {
  const pos = viewPosition(id)
  if (!pos) return null
  return { x: pos.x, y: pos.y + (viewHeadY(id) ?? 0) - 2 }
}

/* ---------- kill feed ---------- */

function buildFeed() {
  feedEl = document.createElement('div')
  feedEl.id = 'killfeed'
  document.getElementById('hud').appendChild(feedEl)
}

function pushFeedRow({ killerName, victimName, victimKind, reward }) {
  const row = document.createElement('div')
  row.className = 'kf-row'
  const skull = victimKind === 'player' ? '⚔' : '🗡'
  const coins = reward?.coins > 0 ? ` · 🪙${reward.coins}` : ''
  row.innerHTML = `<b>${escapeHtml(killerName)}</b> ${skull} ${escapeHtml(victimName)}<span class="kf-reward">+${reward?.exp ?? 0}xp${coins}</span>`
  feedEl.appendChild(row)

  while (feedEl.children.length > FEED_MAX_ROWS) feedEl.firstChild.remove()

  setTimeout(() => {
    row.classList.add('fading')
    setTimeout(() => row.remove(), 400)
  }, FEED_TTL_MS)
}

/** Names are player input; the feed writes HTML. */
function escapeHtml(text) {
  const el = document.createElement('span')
  el.textContent = text ?? ''
  return el.innerHTML
}

/* ---------- death overlay ---------- */

function buildOverlay(ctx) {
  overlayEl = document.createElement('div')
  overlayEl.id = 'death-overlay'
  overlayEl.className = 'hidden'
  overlayEl.innerHTML = `
    <div class="do-box">
      <h1>You died</h1>
      <p class="do-by muted"></p>
      <button type="button" class="do-respawn">Respawn</button>
      <p class="do-hint muted">or wait — you respawn on your own</p>
    </div>
  `
  document.getElementById('hud').appendChild(overlayEl)

  overlayEls = {
    by: overlayEl.querySelector('.do-by'),
    button: overlayEl.querySelector('.do-respawn'),
  }
  overlayEls.button.addEventListener('click', () => ctx.net.send(C2S.COMBAT_RESPAWN, {}))
}

function showOverlay(killerName) {
  respawnReadyAt = performance.now() + RESPAWN_DELAY_MS
  overlayEls.by.textContent = killerName ? `Slain by ${killerName}` : 'Slain'
  overlayEls.button.disabled = true
  overlayEl.classList.remove('hidden')
}

function hideOverlay() {
  respawnReadyAt = 0
  overlayEl.classList.add('hidden')
}

/** The countdown on the button, and nothing else: the server owns the timer. */
function updateOverlay() {
  if (!respawnReadyAt || overlayEl.classList.contains('hidden')) return

  const leftMs = respawnReadyAt - performance.now()
  if (leftMs > 0) {
    overlayEls.button.textContent = `Respawn (${Math.ceil(leftMs / 1000)})`
    return
  }
  overlayEls.button.textContent = 'Respawn'
  overlayEls.button.disabled = false
}

/* ---------- styles ---------- */

/**
 * Styles live with the system, not in styles.css. The feed hangs top centre —
 * the corners are all reserved — and the overlay is a vignette that blocks no
 * input: the box has pointer events, the veil does not, so the utility column
 * keeps working while dead.
 */
function injectStyles() {
  const style = document.createElement('style')
  style.textContent = `
    #killfeed {
      position: absolute;
      top: calc(8px + var(--safe-t));
      left: calc((100% - var(--hud-right)) / 2);
      transform: translateX(-50%);
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 2px;
      pointer-events: none;
      z-index: 12;
    }
    #killfeed .kf-row {
      padding: 2px 10px;
      border-radius: 10px;
      background: rgba(10, 11, 15, 0.65);
      font-size: 11px;
      white-space: nowrap;
      transition: opacity 0.4s;
    }
    #killfeed .kf-row b { color: var(--accent); }
    #killfeed .kf-row .kf-reward { margin-left: 8px; color: var(--muted); font-size: 10px; }
    #killfeed .kf-row.fading { opacity: 0; }

    #death-overlay {
      position: absolute;
      inset: 0;
      display: grid;
      place-items: center;
      background: radial-gradient(circle, rgba(40, 0, 0, 0.25), rgba(20, 0, 0, 0.55));
      pointer-events: none;
      z-index: 16;
    }
    #death-overlay .do-box {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 8px;
      text-align: center;
    }
    #death-overlay h1 {
      margin: 0;
      font-size: 26px;
      letter-spacing: 2px;
      color: #d94f4f;
      text-shadow: 0 2px 8px #000;
    }
    #death-overlay .do-by { margin: 0; font-size: 13px; }
    #death-overlay .do-hint { margin: 0; font-size: 11px; }
    #death-overlay .do-respawn {
      pointer-events: auto;
      min-width: 150px;
      height: 44px;
      border: 1px solid var(--accent);
      border-radius: 6px;
      background: rgba(217, 177, 79, 0.15);
      color: var(--text);
      font-size: 14px;
      cursor: pointer;
    }
    #death-overlay .do-respawn:disabled {
      border-color: var(--border);
      color: var(--muted);
      cursor: default;
    }
  `
  document.head.appendChild(style)
}
