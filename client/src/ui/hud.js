/**
 * DOM HUD: the character sidebar, the compact touch strip and the debug line.
 *
 * DOM instead of Pixi on purpose — UI work and render work stay in separate
 * files, so two people can touch them without conflicting.
 *
 * On desktop the sidebar is permanent and the world canvas ends where it
 * begins: `--hud-right` is the sidebar's width and `#game` is inset by it, so
 * the camera keeps centring the player inside the visible world instead of
 * behind the panel. On a phone that budget does not exist — 232 px of a 740 px
 * landscape screen is a third of the world, and the right edge is reserved for
 * the action rail — so the same panel becomes a 🎒 overlay and `--hud-right`
 * stays 0.
 *
 * There is no mana in this world, so the second bar is experience. HP comes
 * from the snapshot every frame; everything else is private and pushed here by
 * its owning system:
 *
 *   profile   -> setStats({ exp, expToNext, level, gold })
 *   combat    -> setStats({ kills, deaths })
 *   inventory -> setGear({ weapon, armor, ... })
 *
 * Systems never reach into the elements. That is what keeps `combat`,
 * `profile` and `inventory` off each other's toes.
 */

import { CLASSES } from '@shared/constants.js'
import { GEAR, GEAR_SLOTS } from '@shared/gear.js'
import { railForClass, spellDef, unlockLevel } from '@shared/spells.js'
import { state, self } from '../state.js'
import { net } from '../net.js'
import { movement } from '../movement.js'
import { viewport } from '../viewport.js'
import { action } from './touch.js'

/** Sidebar width on desktop, in CSS px. The world canvas is inset by this. */
const SIDEBAR_W = 232

/** The portrait is a glyph until the game has art. */
const CLASS_GLYPH = { warrior: '⚔', mage: '🔮', hunter: '🏹' }

/** Keydown repeats while the key is held; one toggle per press is enough. */
const TOGGLE_COOLDOWN_MS = 200
let lastToggleAt = 0

let els = null
let sidebar = null
/** Last width published as `--hud-right`; guards against a resize loop. */
let publishedRight = -1
/** Whether the last layout pass had the sidebar as an overlay. */
let wasFloating = null

/** spellId -> cell, so a level up only has to relock what changed. */
const spellCells = new Map()
/** What the spell rail was last built and locked for. */
let railCls = null
let railLevel = -1

/** Everything pushed by a system, so a partial update never blanks the rest. */
const readout = { level: 1, exp: 0, expToNext: 0, gold: 0, kills: 0, deaths: 0 }

export const hud = {
  mount() {
    const root = document.getElementById('hud')
    root.classList.remove('hidden')

    injectStyles()

    els = {
      // The compact top-left strip, kept for touch where the sidebar hides.
      hpFill: document.getElementById('hp-fill'),
      hpText: document.getElementById('hp-text'),
      xpFill: document.getElementById('xp-fill'),
      xpText: document.getElementById('xp-text'),
      name: document.getElementById('hud-name'),
      level: document.getElementById('hud-level'),
      debug: document.getElementById('debug'),
      ...buildSidebar(root),
    }

    // A phone cannot afford a permanent panel, so it gets a toggle. The key
    // binding comes for free on desktop, where the panel is already open.
    action({
      id: 'sheet',
      label: '🎒',
      key: 'KeyI',
      slot: 'utility',
      onPress: () => hud.toggleSidebar(),
    })

    viewport.onChange(applyLayout)
    applyLayout()
    render()
  },

  /**
   * Systems push authoritative readouts here rather than reaching into the
   * HUD's elements. Every field is optional: pass only what you own.
   */
  setStats({ hp, maxHp, exp, expToNext, level, gold, kills, deaths } = {}) {
    if (!els) return

    if (hp !== undefined) renderHp(hp, maxHp)
    if (exp !== undefined) readout.exp = exp
    if (expToNext !== undefined) readout.expToNext = expToNext
    if (level !== undefined) readout.level = level
    if (gold !== undefined) readout.gold = gold
    if (kills !== undefined) readout.kills = kills
    if (deaths !== undefined) readout.deaths = deaths

    render()
  },

  /**
   * Owned tier per gear slot, pushed by `inventory`: `{ weapon: 2, boots: 0 }`.
   * Gear is a tier counter, not an item — there is nothing to drag or equip.
   */
  setGear(tiers = {}) {
    if (!els) return
    for (const slot of GEAR_SLOTS) {
      const cell = els.gear[slot]
      if (!cell) continue
      const tier = tiers[slot] ?? 0
      cell.classList.toggle('empty', tier <= 0)
      cell.querySelector('.sb-tier').textContent = tier > 0 ? `T${tier}` : ''
    }
  },

  /** Opens or closes the sidebar. Permanent on desktop, an overlay on touch. */
  toggleSidebar(force) {
    if (!sidebar) return

    // Keydown repeats while the key is held; one toggle per press is enough.
    const now = performance.now()
    if (force === undefined && now - lastToggleAt < TOGGLE_COOLDOWN_MS) return
    lastToggleAt = now

    const open = force ?? sidebar.classList.contains('hidden')
    sidebar.classList.toggle('hidden', !open)
    applyLayout()
  },

  update() {
    const me = self()
    if (!me || !els) return

    renderHp(me.hp, me.maxHp)
    els.name.textContent = me.name
    els.sbName.textContent = me.name
    els.sbPortrait.textContent = CLASS_GLYPH[me.cls] ?? '🗡'
    els.sbClass.textContent = CLASSES[me.cls]?.label ?? me.cls
    syncSpells(me.cls, readout.level)

    // The predicted tile is the one on screen. When it disagrees with the
    // server's, that gap IS the bug worth seeing, so show both.
    const at = movement.selfTile() ?? me
    const drift = at.x !== me.x || at.y !== me.y ? ` (server ${me.x},${me.y})` : ''
    els.debug.textContent = `tile ${at.x},${at.y}${drift} · tick ${state.serverTick} · ping ${net.latency}ms · ${state.players.size} online`
  },
}

/* ---------- rendering ---------- */

function render() {
  if (!els) return

  const { exp, expToNext, level, gold, kills, deaths } = readout
  // At the level cap there is no next level to fill towards, so the bar is full.
  const ratio = expToNext > 0 ? Math.min(1, exp / expToNext) : 1
  const text = expToNext > 0 ? `${exp}/${expToNext} xp` : 'max'

  setBar(els.xpFill, els.xpText, ratio, text)
  setBar(els.sbXpFill, els.sbXpText, ratio, text)
  els.level.textContent = `Lv ${level}`
  els.sbLevel.textContent = level
  els.sbXpPct.textContent = expToNext > 0 ? `${Math.round(ratio * 100)}%` : 'max'
  els.sbGold.textContent = gold.toLocaleString()
  els.sbKills.textContent = kills
  els.sbDeaths.textContent = deaths
}

/** Both surfaces at once: the sidebar on desktop, the compact strip on touch. */
function renderHp(hp, maxHp) {
  const ratio = maxHp > 0 ? Math.min(1, hp / maxHp) : 0
  setBar(els.hpFill, els.hpText, ratio, `${hp}/${maxHp}`)
  setBar(els.sbHpFill, els.sbHpText, ratio, `${hp}/${maxHp}`)
}

function setBar(fill, textEl, ratio, text) {
  if (!fill) return
  fill.style.transform = `scaleX(${ratio})`
  textEl.textContent = text
}

/* ---------- layout ---------- */

/**
 * Publishes the width the world canvas has to give up. Pixi resizes to `#game`
 * and only listens to `resize`, so the event is what makes the canvas and the
 * camera follow — and it is only dispatched on a real change, or the viewport
 * listener that calls this would loop.
 */
function applyLayout() {
  if (!sidebar) return

  const floating = viewport.isTouch
  sidebar.classList.toggle('floating', floating)
  if (floating !== wasFloating) {
    wasFloating = floating
    sidebar.classList.toggle('hidden', floating) // a phone opens it on demand
  }

  const right = floating || sidebar.classList.contains('hidden') ? 0 : SIDEBAR_W
  if (right === publishedRight) return
  publishedRight = right

  document.documentElement.style.setProperty('--hud-right', `${right}px`)
  window.dispatchEvent(new Event('resize'))
}

/* ---------- construction ---------- */

function buildSidebar(root) {
  sidebar = document.createElement('aside')
  sidebar.id = 'sidebar'
  sidebar.innerHTML = `
    <header class="sb-head">
      <div class="sb-portrait"></div>
      <div class="sb-id">
        <b class="sb-name">—</b>
        <span class="sb-class muted"></span>
      </div>
    </header>

    <div class="sb-level-row">
      <span class="sb-level-badge">Lv <b class="sb-level">1</b></span>
      <span class="sb-xp-pct muted">0%</span>
    </div>

    <div class="sb-bars">
      <div class="bar"><span class="fill hp sb-hp-fill"></span><b class="sb-hp-text">0/0</b></div>
      <div class="bar"><span class="fill xp sb-xp-fill"></span><b class="sb-xp-text">0 xp</b></div>
    </div>

    <div class="sb-tally">
      <span class="sb-gold" title="Gold">🪙 <b>0</b></span>
      <span title="Kills">⚔ <b class="sb-kills">0</b></span>
      <span title="Deaths">☠ <b class="sb-deaths">0</b></span>
    </div>

    <div class="sb-body">
      <section class="sb-panel">
        <h2 class="sb-title">Equipment</h2>
        <div class="sb-grid"></div>
      </section>
      <section class="sb-panel">
        <h2 class="sb-title">Spells</h2>
        <div class="sb-spells"></div>
      </section>
    </div>
  `
  root.appendChild(sidebar)

  const grid = sidebar.querySelector('.sb-grid')
  const gear = {}
  for (const slot of GEAR_SLOTS) {
    const cell = document.createElement('div')
    cell.className = 'sb-cell empty'
    cell.title = GEAR[slot].label
    cell.innerHTML = `<span class="sb-icon">${GEAR[slot].icon}</span><b class="sb-tier"></b>`
    grid.appendChild(cell)
    gear[slot] = cell
  }

  return {
    sbName: sidebar.querySelector('.sb-name'),
    sbClass: sidebar.querySelector('.sb-class'),
    sbPortrait: sidebar.querySelector('.sb-portrait'),
    sbLevel: sidebar.querySelector('.sb-level'),
    sbXpPct: sidebar.querySelector('.sb-xp-pct'),
    sbHpFill: sidebar.querySelector('.sb-hp-fill'),
    sbHpText: sidebar.querySelector('.sb-hp-text'),
    sbXpFill: sidebar.querySelector('.sb-xp-fill'),
    sbXpText: sidebar.querySelector('.sb-xp-text'),
    sbGold: sidebar.querySelector('.sb-gold b'),
    sbKills: sidebar.querySelector('.sb-kills'),
    sbDeaths: sidebar.querySelector('.sb-deaths'),
    spells: sidebar.querySelector('.sb-spells'),
    gear,
  }
}

/** Rebuilds on a class change, relocks on a level up, does nothing otherwise. */
function syncSpells(cls, level) {
  if (!els?.spells || !cls) return

  if (cls !== railCls) {
    railCls = cls
    railLevel = -1
    buildSpellCells(cls)
  }
  if (level !== railLevel) {
    railLevel = level
    renderSpellLocks(cls, level)
  }
}

/**
 * The class's rail, slot 0 first, straight from the shared table: icon, key
 * hint and the level that unlocks it. Nothing here is state.
 */
function buildSpellCells(cls) {
  els.spells.replaceChildren()
  spellCells.clear()

  railForClass(cls).forEach((id, index) => {
    const def = spellDef(id)
    if (!def) return

    const cell = document.createElement('div')
    cell.className = 'sb-spell'
    cell.dataset.spell = id
    cell.title = def.name
    cell.innerHTML = `
      <span class="sb-key">${index + 1}</span>
      <span class="sb-icon">${def.icon}</span>
      <span class="sb-lock"></span>
    `
    els.spells.appendChild(cell)
    spellCells.set(id, cell)
  })
}

/** Locks whatever this level cannot cast yet. Slot 0, the attack, never locks. */
function renderSpellLocks(cls, level) {
  const rail = railForClass(cls)
  rail.forEach((id, index) => {
    const cell = spellCells.get(id)
    if (!cell) return
    const need = index === 0 ? 1 : unlockLevel(index - 1)
    const locked = level < need
    cell.classList.toggle('locked', locked)
    cell.querySelector('.sb-lock').textContent = locked ? `L${need}` : ''
  })
}

/**
 * Styles live here rather than in styles.css: the sidebar is the HUD's own
 * chrome, and one owner per file is what keeps the lanes mergeable.
 */
function injectStyles() {
  const style = document.createElement('style')
  style.textContent = `
    #sidebar {
      position: absolute;
      top: 0;
      right: 0;
      width: ${SIDEBAR_W}px;
      height: var(--app-h);
      padding: calc(10px + var(--safe-t)) calc(10px + var(--safe-r)) calc(10px + var(--safe-b)) 10px;
      display: flex;
      flex-direction: column;
      gap: 8px;
      background: linear-gradient(#1a1814, #101014 60%, #0c0d10);
      border-left: 2px solid #3b3327;
      box-shadow: inset 1px 0 0 rgba(217, 177, 79, 0.18);
      font-size: 12px;
      z-index: 13;
    }

    #sidebar .sb-head { display: flex; align-items: center; gap: 8px; }
    #sidebar .sb-portrait {
      display: grid;
      place-items: center;
      width: 42px;
      height: 42px;
      font-size: 22px;
      border: 1px solid #4a3f2c;
      border-radius: 4px;
      background: radial-gradient(circle at 50% 30%, #26221a, #0e0f12);
    }
    #sidebar .sb-id { display: flex; flex-direction: column; min-width: 0; }
    #sidebar .sb-name {
      font-size: 14px;
      color: var(--accent);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    #sidebar .sb-class { font-size: 11px; }

    #sidebar .sb-level-row { display: flex; justify-content: space-between; align-items: baseline; }
    #sidebar .sb-level-badge {
      padding: 1px 6px;
      border: 1px solid #4a3f2c;
      border-radius: 3px;
      background: #16150f;
      font-size: 11px;
      letter-spacing: 0.5px;
    }
    #sidebar .sb-level-badge b { color: var(--accent); }

    #sidebar .sb-bars { display: flex; flex-direction: column; gap: 5px; }

    #sidebar .sb-tally {
      display: flex;
      justify-content: space-between;
      padding: 5px 7px;
      border: 1px solid #2b2a24;
      border-radius: 4px;
      background: rgba(0, 0, 0, 0.35);
      font-size: 11px;
      color: var(--muted);
    }
    #sidebar .sb-tally b { color: var(--text); }
    #sidebar .sb-gold b { color: var(--accent); }

    #sidebar .sb-body {
      flex: 1;
      min-height: 0;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    #sidebar .sb-panel {
      padding: 7px 8px 9px;
      border: 1px solid #2b2a24;
      border-radius: 4px;
      background: rgba(0, 0, 0, 0.3);
    }
    #sidebar .sb-title {
      margin: 0 0 7px;
      padding-bottom: 5px;
      border-bottom: 1px solid #2b2a24;
      color: var(--accent);
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 1.4px;
      text-transform: uppercase;
    }

    #sidebar .sb-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 5px; }
    #sidebar .sb-cell {
      position: relative;
      aspect-ratio: 1;
      display: grid;
      place-items: center;
      border: 1px solid #3a3529;
      border-radius: 3px;
      background: #14130f;
      font-size: 19px;
    }
    #sidebar .sb-cell.empty { opacity: 0.38; }
    #sidebar .sb-cell .sb-tier {
      position: absolute;
      right: 2px;
      bottom: 1px;
      font-size: 9px;
      color: var(--accent);
    }

    /* Six slots, the attack first — the same order as the thumb rail, so the
       panel teaches the key bindings instead of contradicting them. */
    #sidebar .sb-spells { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
    #sidebar .sb-spell {
      position: relative;
      aspect-ratio: 1;
      display: grid;
      place-items: center;
      border: 1px solid #4a3f2c;
      border-radius: 4px;
      background: radial-gradient(circle at 50% 25%, #2a2418, #12110d);
      box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.5);
      font-size: 21px;
    }
    #sidebar .sb-spell .sb-key {
      position: absolute;
      left: 3px;
      top: 2px;
      font-size: 9px;
      color: var(--muted);
    }
    #sidebar .sb-spell .sb-lock {
      position: absolute;
      right: 3px;
      bottom: 2px;
      font-size: 9px;
      color: #b06a5a;
    }
    #sidebar .sb-spell.locked { opacity: 0.35; filter: grayscale(1); }

    /* The sidebar carries the bars on desktop, so the top-left strip goes. */
    body:not(.touch) #stats { display: none; }

    /* A phone has no room for a permanent panel: it becomes a 🎒 overlay. The
       right offset clears the utility column — otherwise the panel covers the
       very button that closes it — and the height clears the thumb rail. */
    #sidebar.floating {
      top: calc(26px + var(--safe-t));
      right: calc(60px + var(--safe-r));
      width: min(258px, 62vw);
      height: auto;
      /* Both sections have to fit without scrolling on a 380 px screen. It is
         a sheet you open and close, so covering the thumb rail while it is up
         costs nothing — covering the button that closes it would. */
      max-height: calc(var(--app-h) - 40px - var(--safe-t) - var(--safe-b));
      padding: 8px;
      border: 1px solid #3b3327;
      border-radius: 6px;
      box-shadow: 0 6px 24px rgba(0, 0, 0, 0.55);
    }
    /* The compact strip already carries the bars, the level and the name on
       touch, so the sheet spends its 380 px on what is only here. */
    #sidebar.floating .sb-level-row,
    #sidebar.floating .sb-bars { display: none; }
    #sidebar.floating .sb-tally { font-size: 12px; }
    /* Square cells are too tall to fit both sections on a phone: fix the
       height instead, at the 44 px a finger needs. */
    #sidebar.floating .sb-cell { aspect-ratio: auto; height: 44px; }
    #sidebar.floating .sb-spell { aspect-ratio: auto; height: 50px; }
  `
  document.head.appendChild(style)
}
