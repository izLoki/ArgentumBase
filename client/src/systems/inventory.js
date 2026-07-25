/**
 * INVENTORY SYSTEM (client) — the shop.
 *
 * A centred modal, built in JS from this file so `client/index.html` stays
 * untouched. One row per gear slot, 44 px buy buttons, digit keys 1-4 on
 * desktop. The world keeps running while it is open — there is no backdrop and
 * no confirm step, so every purchase is a single tap.
 *
 * The 🛒 button goes in the utility column (`slot: 'utility'`), never the
 * thumb rail: that space belongs to things used mid-fight.
 *
 * KEYS. The digit keys belong to the SPELL rail (B3); the shop only borrows
 * them while it is open. That is why they are a scoped listener attached on
 * open and removed on close, not a global `ctx.input.onKey` binding — the
 * global map holds one owner per key, and the shop must not be it.
 *
 * STATE. Tiers and prices are private and arrive over INVENTORY_SELF. Until
 * the first packet lands this renders from the shared table directly — tier 0
 * everywhere is not a guess, it is what a new player is.
 */

import { C2S, S2C } from '@shared/protocol.js'
import { GEAR, GEAR_SLOTS, canUseSlot, nextTierCost } from '@shared/gear.js'
import { myProfile, onProfileChange } from './profile.js'

/** Keydown repeats while the key is held; one toggle per press is enough. */
const TOGGLE_COOLDOWN_MS = 200

/** Digit key -> gear slot, in table order: 1 sword, 2 armor, 3 staff, 4 boots. */
const KEY_SLOTS = Object.fromEntries(GEAR_SLOTS.map((slot, i) => [`Digit${i + 1}`, slot]))

/** How the shop spells a stat bonus. Percent stats read as percent. */
const MOD_LABELS = {
  damage: 'dmg',
  defense: 'def',
  maxHp: 'hp',
  evasion: '% eva',
  cdr: '% cdr',
  moveSpeed: '% spd',
}

let tiers = null
let nextCosts = null
let gold = 0

let modal = null
let rowEls = null
let goldEl = null
let lastToggleAt = 0
let sendBuy = null

export default {
  id: 'inventory',

  init(ctx) {
    injectStyles()
    buildModal(ctx)

    sendBuy = (slot) => ctx.net.send(C2S.INVENTORY_BUY, { slot })

    ctx.action({
      id: 'shop',
      label: '🛒',
      key: 'KeyB',
      slot: 'utility', // a panel toggle, not something used mid-fight
      onPress: () => toggle(ctx),
    })

    gold = myProfile()?.gold ?? 0
    onProfileChange((profile) => {
      gold = profile?.gold ?? 0
      render(ctx)
    })
  },

  handlers: {
    [S2C.INVENTORY_SELF](ctx, payload) {
      tiers = payload?.tiers ?? tiers
      nextCosts = payload?.nextCosts ?? nextCosts
      ctx.hud.setGear(tiers ?? {})
      render(ctx)
    },
  },
}

/* ---------- API for other client systems ---------- */

/** Owned tier per slot for the local player: `{ weapon, armor, focus, boots }`. */
export function myTiers() {
  return tiers
}

/* ---------- the modal ---------- */

function toggle(ctx, force) {
  const now = performance.now()
  if (force === undefined && now - lastToggleAt < TOGGLE_COOLDOWN_MS) return
  lastToggleAt = now

  const open = force ?? modal.classList.contains('hidden')
  modal.classList.toggle('hidden', !open)

  // Scoped, not global: the digit keys are only the shop's while it is open.
  if (open) {
    document.addEventListener('keydown', onShopKey, true)
    render(ctx)
  } else {
    document.removeEventListener('keydown', onShopKey, true)
  }
}

function onShopKey(e) {
  const el = document.activeElement
  if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return

  if (e.code === 'Escape') {
    e.preventDefault()
    e.stopPropagation()
    return toggle(null, false)
  }

  const slot = KEY_SLOTS[e.code]
  if (!slot) return
  e.preventDefault()
  e.stopPropagation()
  sendBuy?.(slot)
}

function buildModal(ctx) {
  modal = document.createElement('div')
  modal.id = 'shop-modal'
  modal.className = 'panel compact hidden'
  modal.innerHTML = `
    <div class="shop-head">
      <b class="shop-title">🛒 Shop</b>
      <span class="shop-gold">🪙 <b>0</b></span>
      <button type="button" class="shop-close" title="Close">✕</button>
    </div>
    <div class="shop-rows"></div>
  `
  document.getElementById('hud').appendChild(modal)

  goldEl = modal.querySelector('.shop-gold b')
  modal.querySelector('.shop-close').addEventListener('click', () => toggle(ctx, false))

  const rows = modal.querySelector('.shop-rows')
  rowEls = {}

  GEAR_SLOTS.forEach((slot, index) => {
    const def = GEAR[slot]
    const row = document.createElement('div')
    row.className = 'shop-row'
    row.innerHTML = `
      <span class="shop-icon">${def.icon}</span>
      <div class="shop-info">
        <b>${def.label} <i class="shop-tier"></i></b>
        <span class="shop-mods muted"></span>
      </div>
      <button type="button" class="shop-buy" data-slot="${slot}">
        <span class="shop-key">${index + 1}</span><span class="shop-price"></span>
      </button>
    `
    rows.appendChild(row)

    const buy = row.querySelector('.shop-buy')
    buy.addEventListener('click', () => sendBuy?.(slot))

    rowEls[slot] = {
      tier: row.querySelector('.shop-tier'),
      mods: row.querySelector('.shop-mods'),
      buy,
      price: row.querySelector('.shop-price'),
    }
  })
}

function render(ctx) {
  if (!modal || modal.classList.contains('hidden')) return

  goldEl.textContent = gold.toLocaleString()

  const cls = ctx?.self?.()?.cls ?? myProfile()?.cls ?? null
  for (const slot of GEAR_SLOTS) {
    renderRow(slot, cls)
  }
}

function renderRow(slot, cls) {
  const els = rowEls[slot]
  const owned = tiers?.[slot] ?? 0
  const maxTier = GEAR[slot].tiers.length - 1

  els.tier.textContent = owned > 0 ? `T${owned}` : ''

  // Until the first private packet lands the shared table answers: a class this
  // slot refuses stays refused, and a new player's next tier costs `tiers[1]`.
  const cost = nextCosts ? nextCosts[slot] : nextTierCost(slot, owned, cls)

  // The restriction reads from the table, not the player: with the class still
  // unknown a restricted slot shows who it is for instead of a false "MAX".
  if (GEAR[slot].restrict && !(cls && canUseSlot(slot, cls))) {
    els.mods.textContent = `${GEAR[slot].restrict.join(', ')} only`
    setBuy(els, '—', true)
    return
  }
  if (cost === null || owned >= maxTier) {
    els.mods.textContent = describeTier(slot, owned)
    setBuy(els, 'MAX', true)
    return
  }

  els.mods.textContent = describeTier(slot, owned + 1)
  setBuy(els, `🪙 ${cost}`, gold < cost)
}

function setBuy(els, text, disabled) {
  els.price.textContent = text
  els.buy.disabled = disabled
}

/** What one tier adds, spelled out: `+9 dmg · -4% taken`. */
function describeTier(slot, tier) {
  const def = GEAR[slot].tiers[tier]
  if (!def) return ''

  const parts = []
  for (const [key, value] of Object.entries(def.mods ?? {})) {
    const label = MOD_LABELS[key] ?? key
    parts.push(`${value > 0 ? '+' : ''}${value}${label.startsWith('%') ? label : ` ${label}`}`)
  }
  if (def.mult?.taken) parts.push(`${def.mult.taken}% taken`)
  if (def.mult?.dealt) {
    parts.push(`+${def.mult.dealt}% ${def.mult.meleeOnly ? 'melee' : 'dealt'}`)
  }
  return parts.join(' · ')
}

/**
 * Styles live with the system, not in styles.css, so the feature stays one
 * file per side. Centred as a modal — the reserved zones (stick, rail,
 * utility column) all hug the edges, so the centre is the one safe place.
 */
function injectStyles() {
  const style = document.createElement('style')
  style.textContent = `
    #shop-modal {
      position: absolute;
      left: 50%;
      top: 50%;
      transform: translate(-50%, -50%);
      width: min(520px, 92vw);
      max-height: min(300px, calc(var(--app-h) - 60px));
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 6px;
      font-size: 12px;
      z-index: 15;
    }
    /* On desktop the world is inset by the sidebar: centre on what is visible. */
    body:not(.touch) #shop-modal { left: calc((100% - var(--hud-right)) / 2); }

    #shop-modal .shop-head {
      display: flex;
      align-items: center;
      gap: 10px;
      padding-bottom: 5px;
      border-bottom: 1px solid #2b2a24;
    }
    #shop-modal .shop-title { font-size: 14px; color: var(--accent); }
    #shop-modal .shop-gold { margin-left: auto; }
    #shop-modal .shop-gold b { color: var(--accent); }
    /* 44px like every other tap target: missing "close" on a phone hurts. */
    #shop-modal .shop-close {
      width: 44px;
      height: 44px;
      margin: -8px -8px -8px 0;
      padding: 0;
      border: 1px solid var(--border);
      border-radius: 4px;
      background: transparent;
      color: var(--muted);
      font-size: 15px;
      cursor: pointer;
    }

    #shop-modal .shop-row {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 3px 0;
    }
    #shop-modal .shop-icon { font-size: 20px; width: 26px; text-align: center; }
    #shop-modal .shop-info {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
      line-height: 1.35;
    }
    #shop-modal .shop-tier { font-style: normal; font-size: 10px; color: var(--accent); }
    #shop-modal .shop-mods {
      font-size: 11px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    /* 44px tall: the smallest thing a finger can be trusted to hit. */
    #shop-modal .shop-buy {
      position: relative;
      min-width: 86px;
      height: 44px;
      padding: 0 10px;
      border: 1px solid var(--accent);
      border-radius: 6px;
      background: rgba(217, 177, 79, 0.12);
      color: var(--text);
      font-size: 13px;
      cursor: pointer;
    }
    #shop-modal .shop-buy:disabled {
      border-color: var(--border);
      background: transparent;
      color: var(--muted);
      cursor: default;
    }
    #shop-modal .shop-key {
      position: absolute;
      left: 4px;
      top: 2px;
      font-size: 9px;
      color: var(--muted);
    }
    /* The key hint teaches desktop bindings; a phone has no keys to teach. */
    body.touch #shop-modal .shop-key { display: none; }

    /* On a phone the centre of the screen belongs to the stick and the rail.
       Hang the shop from the top strip instead: it clears both thumb zones,
       and the rows scroll if the height gets tight. */
    body.touch #shop-modal {
      top: calc(34px + var(--safe-t));
      transform: translateX(-50%);
      width: min(480px, 86vw);
      max-height: calc(var(--app-h) - 150px - var(--safe-t) - var(--safe-b));
    }
    body.touch #shop-modal .shop-row { padding: 1px 0; }
  `
  document.head.appendChild(style)
}
