/**
 * PROFILE SYSTEM (client) — mirror of the shared player profile.
 *
 * Other client systems read the profile from here instead of digging through
 * snapshots:
 *
 *   import { myProfile, myStats, profileOf, onProfileChange } from './profile.js'
 *
 * The public half (name, class, level of everyone) arrives in
 * `snapshot.ext.profile`; the private half (gold, exp, attributes, stats) only
 * ever arrives for the local player, over S2C.PROFILE_SELF.
 */

import { S2C } from '@shared/protocol.js'
import {
  ATTRIBUTES,
  ATTRIBUTE_LABELS,
  MOVE_MAX_PCT,
  STAT_KEYS,
  STAT_LABELS,
} from '@shared/profile.js'
import { CLASSES, MOVE_COOLDOWN_MS } from '@shared/constants.js'
import { movement } from '../movement.js'

/** Keydown repeats while the key is held; one toggle per press is enough. */
const TOGGLE_COOLDOWN_MS = 200

/** playerId -> public profile */
const publicProfiles = new Map()
const listeners = new Set()

let mine = null
let myDerivedStats = null
let panel = null
let els = null
let lastToggleAt = 0

export default {
  id: 'profile',

  init(ctx) {
    buildPanel(ctx)
    ctx.action({
      id: 'profile',
      label: '👤',
      key: 'KeyP',
      slot: 'utility', // a panel toggle, not something used mid-fight
      onPress: () => togglePanel(),
    })
  },

  onSnapshot(ctx, snapshot) {
    const incoming = snapshot.ext?.profile
    if (!incoming) return

    publicProfiles.clear()
    for (const [id, view] of Object.entries(incoming)) publicProfiles.set(id, view)
  },

  handlers: {
    [S2C.PROFILE_SELF](ctx, payload) {
      mine = payload?.profile ?? null
      myDerivedStats = payload?.stats ?? null

      // Experience, level and gold are private, so the snapshot cannot carry
      // them: the profile is the only thing that can feed those HUD readouts.
      if (mine) {
        ctx.hud.setStats({
          exp: mine.exp,
          expToNext: mine.expToNext,
          level: mine.level,
          gold: mine.gold,
        })
      }

      // The sidebar's Character tab shows the TOTALS the server derived —
      // attributes plus every modifier already folded in.
      ctx.hud.setCharacter({
        attributes: mine?.attributes ?? null,
        stats: myDerivedStats,
      })

      // Prediction has to walk at the same rate the server allows, or agility
      // would be a number in a panel and nothing else.
      if (myDerivedStats) {
        const pct = Math.min(MOVE_MAX_PCT, myDerivedStats.moveSpeed ?? 0)
        movement.setCooldown(MOVE_COOLDOWN_MS * (1 - pct / 100))
      }

      render()
      for (const fn of listeners) {
        try {
          fn(mine, myDerivedStats)
        } catch (err) {
          console.error('[profile] listener threw:', err)
        }
      }
    },

    [S2C.PROFILE_LEVEL_UP](ctx, payload) {
      if (payload?.id === ctx.state.selfId) {
        ctx.chat.log(`You reached level ${payload.level}.`, 'system')
      }
    },
  },
}

/* ---------- API for other client systems ---------- */

/** The local player's full profile, or null before the first update. */
export function myProfile() {
  return mine
}

/** The local player's derived stats (maxHp, damage, ...), or null. */
export function myStats() {
  return myDerivedStats
}

/** Public profile of any player: { id, name, cls, level }. */
export function profileOf(playerId) {
  return publicProfiles.get(playerId) ?? null
}

/** Runs whenever the local profile changes. Returns an unsubscribe function. */
export function onProfileChange(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/* ---------- panel ---------- */

function togglePanel() {
  const now = performance.now()
  if (now - lastToggleAt < TOGGLE_COOLDOWN_MS) return
  lastToggleAt = now
  panel.classList.toggle('hidden')
  render()
}

function buildPanel(ctx) {
  injectStyles()

  panel = document.createElement('div')
  panel.id = 'profile-panel'
  panel.className = 'panel compact hidden'
  panel.innerHTML = `
    <div class="pf-head">
      <b class="pf-name"></b>
      <span class="pf-cls muted"></span>
    </div>
    <div class="pf-level muted"></div>
    <div class="bar"><i class="fill pf-exp"></i><b class="pf-exp-text"></b></div>
    <div class="pf-gold"></div>
    <div class="pf-section muted">Attributes</div>
    <div class="pf-attrs"></div>
    <div class="pf-section muted">Stats</div>
    <div class="pf-stats"></div>
  `
  document.getElementById('hud').appendChild(panel)

  els = {
    name: panel.querySelector('.pf-name'),
    cls: panel.querySelector('.pf-cls'),
    level: panel.querySelector('.pf-level'),
    exp: panel.querySelector('.pf-exp'),
    expText: panel.querySelector('.pf-exp-text'),
    gold: panel.querySelector('.pf-gold'),
    attrs: panel.querySelector('.pf-attrs'),
    stats: panel.querySelector('.pf-stats'),
  }

  // Read-only: attributes are a pure function of class and level, so there is
  // nothing to spend and no button to press.
  for (const key of ATTRIBUTES) {
    const row = document.createElement('div')
    row.className = 'pf-row'
    row.innerHTML = `<span>${ATTRIBUTE_LABELS[key]}</span><b data-attr="${key}">0</b>`
    els.attrs.appendChild(row)
  }

  for (const key of STAT_KEYS) {
    const row = document.createElement('div')
    row.className = 'pf-row'
    row.innerHTML = `<span>${STAT_LABELS[key]}</span><b data-stat="${key}">0</b>`
    els.stats.appendChild(row)
  }
}

function render() {
  if (!mine || !els || panel.classList.contains('hidden')) return

  els.name.textContent = mine.name
  els.cls.textContent = CLASSES[mine.cls]?.label ?? mine.cls
  els.level.textContent = `Level ${mine.level}`
  els.gold.textContent = `🪙 ${mine.gold} gold`

  const ratio = mine.expToNext > 0 ? mine.exp / mine.expToNext : 0
  els.exp.style.transform = `scaleX(${Math.min(1, ratio)})`
  els.expText.textContent = `${mine.exp}/${mine.expToNext} xp`

  for (const key of ATTRIBUTES) {
    panel.querySelector(`[data-attr="${key}"]`).textContent = mine.attributes[key]
  }

  if (!myDerivedStats) return
  for (const key of STAT_KEYS) {
    panel.querySelector(`[data-stat="${key}"]`).textContent = myDerivedStats[key]
  }
}

/**
 * Styles live with the system, not in styles.css, so the feature stays one
 * file per side. Top-right anchored: the stick owns the bottom-left quadrant
 * and the action rail the bottom-right corner.
 */
function injectStyles() {
  const style = document.createElement('style')
  style.textContent = `
    #profile-panel {
      position: absolute;
      top: calc(12px + var(--safe-t));
      /* --hud-right is what the HUD sidebar takes from the world: without it
         this panel would open underneath the sidebar on desktop. */
      right: calc(12px + var(--safe-r) + var(--hud-right));
      width: min(260px, 62vw);
      max-height: calc(var(--app-h) - 90px - var(--safe-t) - var(--safe-b));
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 5px;
      font-size: 12px;
      z-index: 14;
    }
    #profile-panel .pf-head { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
    #profile-panel .pf-name { font-size: 14px; }
    #profile-panel .fill.pf-exp { background: var(--accent); }
    #profile-panel .pf-gold { color: var(--accent); }
    #profile-panel .pf-section {
      margin-top: 4px;
      text-transform: uppercase;
      letter-spacing: 1.4px;
      font-size: 10px;
      font-weight: 700;
      color: var(--accent);
      text-shadow: 0 1px 2px #000;
    }
    #profile-panel .pf-row {
      display: grid;
      grid-template-columns: 1fr auto;
      align-items: center;
      gap: 6px;
      line-height: 1.5;
      border-bottom: 1px dotted #3a2d16;
    }
    /* The panel has to leave the action rail alone. */
    body.touch #profile-panel {
      top: calc(34px + var(--safe-t));
      width: min(280px, 74vw);
      max-height: calc(var(--app-h) * 0.62);
    }
    body.touch #profile-panel .pf-row { line-height: 1.8; }
  `
  document.head.appendChild(style)
}
