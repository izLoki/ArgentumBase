/**
 * DOM HUD: the character sidebar, the compact touch strip and the debug line.
 *
 * DOM instead of Pixi on purpose — UI work and render work stay in separate
 * files, so two people can touch them without conflicting.
 *
 * On desktop the sidebar is permanent and the world canvas ends where it
 * begins: `--hud-right` is the sidebar's width and `#game` is inset by it, so
 * the camera keeps centring the player inside the visible world instead of
 * behind the panel. On a phone that budget does not exist — 248 px of a 740 px
 * landscape screen is a third of the world, and the right edge is reserved for
 * the action rail — so the same panel becomes a 🎒 overlay and `--hud-right`
 * stays 0.
 *
 * The body of the sidebar is two tabs, like a character sheet:
 *
 *   Character — attributes and the TOTAL derived stats of the player.
 *   Equipment — one full-width row per gear slot, with what it grants now,
 *               what the next tier adds, and the Upgrade button.
 *
 * There is no mana in this world, so the second bar is experience. HP comes
 * from the snapshot every frame; everything else is private and pushed here by
 * its owning system:
 *
 *   profile   -> setStats({ exp, expToNext, level, gold })
 *             -> setCharacter({ attributes, stats })
 *   combat    -> setStats({ kills, deaths })
 *   inventory -> setGear({ weapon: 2, ... })
 *             -> setGearMarket({ nextCosts, buy })
 *
 * Systems never reach into the elements. That is what keeps `combat`,
 * `profile` and `inventory` off each other's toes: the HUD owns the pixels,
 * the systems own the numbers and the wire.
 */

import { CLASSES } from '@shared/constants.js'
import { GEAR, GEAR_SLOTS, canUseSlot, nextTierCost } from '@shared/gear.js'
import { ATTRIBUTES, STAT_KEYS, STAT_LABELS } from '@shared/profile.js'
import { state, self } from '../state.js'
import { net } from '../net.js'
import { movement } from '../movement.js'
import { viewport } from '../viewport.js'
import { action } from './touch.js'

/** Sidebar width on desktop, in CSS px. The world canvas is inset by this. */
const SIDEBAR_W = 248

/** The portrait is a glyph until the game has art. */
const CLASS_GLYPH = { warrior: '⚔', mage: '🔮', hunter: '🏹' }

/** Keydown repeats while the key is held; one toggle per press is enough. */
const TOGGLE_COOLDOWN_MS = 200
let lastToggleAt = 0

/** How the equipment rows spell a stat bonus. A `%` prefix reads as percent. */
const MOD_LABELS = {
  damage: 'damage',
  defense: 'defense',
  maxHp: 'max HP',
  evasion: '% evasion',
  cdr: '% cdr',
  moveSpeed: '% speed',
}

/** Derived stats that read as percentages in the Character tab. */
const PCT_STATS = new Set(['evasion', 'cdr', 'moveSpeed'])

let els = null
let sidebar = null
/** Last width published as `--hud-right`; guards against a resize loop. */
let publishedRight = -1
/** Whether the last layout pass had the sidebar as an overlay. */
let wasFloating = null

/** Everything pushed by a system, so a partial update never blanks the rest. */
const readout = { level: 1, exp: 0, expToNext: 0, gold: 0, kills: 0, deaths: 0 }
/** Pushed by `profile`: attributes and total derived stats. */
const character = { attributes: null, stats: null }
/** Pushed by `inventory`: owned tier per slot, prices and the buy wire. */
let gearTiers = {}
const market = { nextCosts: null, buy: null }

let activeTab = 'character'

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
   * The Character tab's numbers, pushed by `profile`: the attribute block and
   * the TOTAL derived stats (base + gear + effects), exactly as the server
   * computed them. Pass only what changed.
   */
  setCharacter({ attributes, stats } = {}) {
    if (attributes !== undefined) character.attributes = attributes
    if (stats !== undefined) character.stats = stats
    renderCharacter()
  },

  /**
   * Owned tier per gear slot, pushed by `inventory`: `{ weapon: 2, boots: 0 }`.
   * Gear is a tier counter, not an item — there is nothing to drag or equip.
   */
  setGear(tiers = {}) {
    gearTiers = tiers
    renderEquipment()
  },

  /**
   * The Equipment tab's market half, pushed by `inventory`: the authoritative
   * next-tier prices and the callback that actually buys. Fields merge, so the
   * wire can arrive at init and the prices with each INVENTORY_SELF.
   */
  setGearMarket({ nextCosts, buy } = {}) {
    if (nextCosts !== undefined) market.nextCosts = nextCosts
    if (buy !== undefined) market.buy = buy
    renderEquipment()
  },

  /** Opens the sidebar (if closed) already switched to the Equipment tab. */
  openEquipment() {
    selectTab('equipment')
    if (sidebar?.classList.contains('hidden')) hud.toggleSidebar(true)
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

  // Gold moved: what was affordable may not be any more.
  renderEquipment()
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

function renderCharacter() {
  if (!els) return

  for (const key of ATTRIBUTES) {
    els.attrs[key].textContent = character.attributes?.[key] ?? '—'
  }
  for (const key of STAT_KEYS) {
    const value = character.stats?.[key]
    els.stats[key].textContent =
      value === undefined || value === null ? '—' : PCT_STATS.has(key) ? `${value}%` : `${value}`
  }
}

function renderEquipment() {
  if (!els) return

  const cls = self()?.cls ?? null

  for (const slot of GEAR_SLOTS) {
    const row = els.gear[slot]
    const def = GEAR[slot]
    const owned = gearTiers?.[slot] ?? 0
    const maxTier = def.tiers.length - 1

    row.root.classList.toggle('owned', owned > 0)
    row.tier.textContent = '◆'.repeat(owned) + '◇'.repeat(Math.max(0, maxTier - owned))

    // The restriction reads from the table, not the player: with the class
    // still unknown a restricted slot shows who it is for, not a false MAX.
    if (def.restrict && !(cls && canUseSlot(slot, cls))) {
      row.now.textContent = `${def.restrict.map(capitalize).join(', ')} only`
      row.next.textContent = ''
      setBuy(row, { label: 'Restricted', cost: '', disabled: true })
      continue
    }

    row.now.textContent = owned > 0 ? describeSpan(slot, owned) : 'Not equipped'

    // Until the first private packet lands the shared table answers: tier 0
    // everywhere is not a guess, it is what a new player is.
    const cost = market.nextCosts ? market.nextCosts[slot] : nextTierCost(slot, owned, cls)
    if (cost === null || cost === undefined || owned >= maxTier) {
      row.next.textContent = 'Fully upgraded'
      setBuy(row, { label: 'MAX', cost: '', disabled: true })
      continue
    }

    row.next.textContent = `Next: ${describeTier(slot, owned + 1)}`
    const poor = readout.gold < cost
    setBuy(row, {
      label: 'Upgrade',
      cost: `🪙 ${cost}`,
      disabled: poor || !market.buy,
      poor,
    })
  }
}

function setBuy(row, { label, cost, disabled, poor = false }) {
  row.buyLabel.textContent = label
  row.buyCost.textContent = cost
  row.buy.disabled = disabled
  row.buy.classList.toggle('poor', poor)
}

/** Everything the owned tiers of one slot add up to: `+13 damage · -4% taken`. */
function describeSpan(slot, owned) {
  const mods = {}
  let taken = 0
  let dealt = 0
  let melee = 0

  for (let tier = 1; tier <= owned; tier++) {
    const def = GEAR[slot].tiers[tier]
    if (!def) continue
    for (const [key, value] of Object.entries(def.mods ?? {})) {
      mods[key] = (mods[key] ?? 0) + value
    }
    if (def.mult?.taken) taken += def.mult.taken
    if (def.mult?.dealt) def.mult.meleeOnly ? (melee += def.mult.dealt) : (dealt += def.mult.dealt)
  }

  return formatParts(mods, { taken, dealt, melee })
}

/** What ONE tier adds — the upgrade diff, straight from the table. */
function describeTier(slot, tier) {
  const def = GEAR[slot].tiers[tier]
  if (!def) return ''

  const mult = def.mult ?? {}
  return formatParts(def.mods ?? {}, {
    taken: mult.taken ?? 0,
    dealt: mult.meleeOnly ? 0 : (mult.dealt ?? 0),
    melee: mult.meleeOnly ? (mult.dealt ?? 0) : 0,
  })
}

function formatParts(mods, { taken, dealt, melee }) {
  const parts = []
  for (const [key, value] of Object.entries(mods)) {
    const label = MOD_LABELS[key] ?? key
    const sign = value > 0 ? '+' : ''
    parts.push(label.startsWith('%') ? `${sign}${value}${label}` : `${sign}${value} ${label}`)
  }
  if (taken) parts.push(`${taken}% dmg taken`)
  if (dealt) parts.push(`+${dealt}% dmg dealt`)
  if (melee) parts.push(`+${melee}% melee dmg`)
  return parts.join(' · ')
}

function capitalize(word) {
  return word.charAt(0).toUpperCase() + word.slice(1)
}

/* ---------- tabs ---------- */

function selectTab(tab) {
  activeTab = tab
  if (!sidebar) return
  for (const btn of sidebar.querySelectorAll('.sb-tab')) {
    btn.classList.toggle('active', btn.dataset.tab === tab)
  }
  for (const page of sidebar.querySelectorAll('.sb-page')) {
    page.classList.toggle('hidden', page.dataset.page !== tab)
  }
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
      <span class="sb-level-badge">⚜ Lv <b class="sb-level">1</b></span>
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

    <nav class="sb-tabs">
      <button type="button" class="sb-tab active" data-tab="character">Character</button>
      <button type="button" class="sb-tab" data-tab="equipment">Equipment</button>
    </nav>

    <div class="sb-body">
      <section class="sb-page" data-page="character">
        <div class="sb-attrs"></div>
        <h2 class="sb-title">Combat stats</h2>
        <div class="sb-stats"></div>
      </section>
      <section class="sb-page hidden" data-page="equipment">
        <div class="sb-gear-list"></div>
      </section>
    </div>
  `
  root.appendChild(sidebar)

  for (const btn of sidebar.querySelectorAll('.sb-tab')) {
    btn.addEventListener('click', () => selectTab(btn.dataset.tab))
  }

  // Character tab: the four attributes as stone cells, then every derived
  // stat as a ledger row with a dotted leader — the totals, not the pieces.
  const attrsBox = sidebar.querySelector('.sb-attrs')
  const attrs = {}
  for (const key of ATTRIBUTES) {
    const cell = document.createElement('div')
    cell.className = 'sb-attr'
    cell.innerHTML = `<span>${key.toUpperCase()}</span><b>—</b>`
    attrsBox.appendChild(cell)
    attrs[key] = cell.querySelector('b')
  }

  const statsBox = sidebar.querySelector('.sb-stats')
  const stats = {}
  for (const key of STAT_KEYS) {
    const row = document.createElement('div')
    row.className = 'sb-stat'
    row.innerHTML = `<span>${STAT_LABELS[key]}</span><i class="sb-lead"></i><b>—</b>`
    statsBox.appendChild(row)
    stats[key] = row.querySelector('b')
  }

  // Equipment tab: one full-width row per slot, stacked as a column.
  const gearList = sidebar.querySelector('.sb-gear-list')
  const gear = {}
  for (const slot of GEAR_SLOTS) {
    const def = GEAR[slot]
    const row = document.createElement('article')
    row.className = 'sb-item'
    row.innerHTML = `
      <div class="sb-item-head">
        <span class="sb-item-icon">${def.icon}</span>
        <b class="sb-item-name">${def.label}</b>
        <span class="sb-item-tier"></span>
      </div>
      <p class="sb-item-now"></p>
      <p class="sb-item-next"></p>
      <button type="button" class="sb-item-buy">
        <span class="sb-buy-label">Upgrade</span>
        <span class="sb-buy-cost"></span>
      </button>
    `
    gearList.appendChild(row)

    const buy = row.querySelector('.sb-item-buy')
    buy.addEventListener('click', () => market.buy?.(slot))

    gear[slot] = {
      root: row,
      tier: row.querySelector('.sb-item-tier'),
      now: row.querySelector('.sb-item-now'),
      next: row.querySelector('.sb-item-next'),
      buy,
      buyLabel: row.querySelector('.sb-buy-label'),
      buyCost: row.querySelector('.sb-buy-cost'),
    }
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
    attrs,
    stats,
    gear,
  }
}

/**
 * Styles live here rather than in styles.css: the sidebar is the HUD's own
 * chrome, and one owner per file is what keeps the lanes mergeable.
 *
 * The look is old-school MMORPG: dark timber, a bronze inner frame, parchment
 * text and gold accents. Everything is CSS — no image assets, so `render/`
 * stays the only place art lives.
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
      padding: calc(10px + var(--safe-t)) calc(10px + var(--safe-r)) calc(10px + var(--safe-b)) 12px;
      display: flex;
      flex-direction: column;
      gap: 8px;
      background:
        linear-gradient(180deg, rgba(255, 220, 140, 0.05), rgba(0, 0, 0, 0) 120px),
        repeating-linear-gradient(90deg, rgba(0, 0, 0, 0.14) 0 2px, rgba(0, 0, 0, 0) 2px 5px),
        linear-gradient(#241a10, #170f08 55%, #0d0905);
      border-left: 3px solid #060402;
      box-shadow:
        inset 3px 0 0 #6b5426,
        inset 4px 0 0 rgba(0, 0, 0, 0.65),
        inset 0 0 26px rgba(0, 0, 0, 0.55);
      font-size: 12px;
      z-index: 13;
    }

    #sidebar .sb-head {
      display: flex;
      align-items: center;
      gap: 9px;
      padding-bottom: 7px;
      border-bottom: 1px solid #4a3a1e;
      box-shadow: 0 1px 0 rgba(0, 0, 0, 0.6);
    }
    #sidebar .sb-portrait {
      display: grid;
      place-items: center;
      width: 46px;
      height: 46px;
      font-size: 24px;
      border: 1px solid #060402;
      box-shadow: inset 0 0 0 2px #6b5426, inset 0 0 10px rgba(0, 0, 0, 0.8);
      background: radial-gradient(circle at 50% 32%, #33261490, #0b08048c), #14100a;
    }
    #sidebar .sb-id { display: flex; flex-direction: column; min-width: 0; }
    #sidebar .sb-name {
      font-size: 15px;
      color: var(--accent);
      text-shadow: 0 1px 2px #000;
      letter-spacing: 0.4px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    #sidebar .sb-class {
      font-size: 11px;
      font-variant: small-caps;
      letter-spacing: 1px;
    }

    #sidebar .sb-level-row { display: flex; justify-content: space-between; align-items: baseline; }
    #sidebar .sb-level-badge {
      padding: 2px 8px;
      border: 1px solid #060402;
      box-shadow: inset 0 0 0 1px #6b5426;
      background: linear-gradient(#2a1f11, #171008);
      font-size: 11px;
      letter-spacing: 0.5px;
    }
    #sidebar .sb-level-badge b { color: var(--accent); }

    #sidebar .sb-bars { display: flex; flex-direction: column; gap: 5px; }

    #sidebar .sb-tally {
      display: flex;
      justify-content: space-between;
      padding: 5px 8px;
      border: 1px solid #060402;
      box-shadow: inset 0 0 0 1px #4a3a1e, inset 0 2px 6px rgba(0, 0, 0, 0.6);
      background: rgba(0, 0, 0, 0.4);
      font-size: 11px;
      color: var(--muted);
    }
    #sidebar .sb-tally b { color: var(--text); }
    #sidebar .sb-gold b { color: var(--accent); }

    /* ----- tabs: two metal plates, the active one lit ----- */
    #sidebar .sb-tabs { display: flex; gap: 4px; }
    #sidebar .sb-tab {
      flex: 1;
      padding: 7px 4px 6px;
      border: 1px solid #060402;
      border-radius: 0;
      box-shadow: inset 0 0 0 1px #4a3a1e, inset 0 -3px 6px rgba(0, 0, 0, 0.5);
      background: linear-gradient(#221808, #140d06);
      color: var(--muted);
      font: inherit;
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 1.2px;
      text-transform: uppercase;
      cursor: pointer;
    }
    #sidebar .sb-tab.active {
      color: var(--accent);
      text-shadow: 0 1px 2px #000;
      box-shadow: inset 0 0 0 1px #8a6a2f, inset 0 1px 0 rgba(255, 226, 150, 0.25);
      background: linear-gradient(#3a2b14, #241808);
    }
    #sidebar .sb-tab:hover:not(.active) { color: var(--text); }

    #sidebar .sb-body {
      flex: 1;
      min-height: 0;
      overflow-y: auto;
      scrollbar-width: thin;
      scrollbar-color: #5a4522 transparent;
      display: flex;
      flex-direction: column;
    }
    #sidebar .sb-body::-webkit-scrollbar { width: 6px; }
    #sidebar .sb-body::-webkit-scrollbar-thumb { background: #5a4522; }
    #sidebar .sb-page { display: flex; flex-direction: column; gap: 8px; }

    #sidebar .sb-title {
      margin: 4px 0 0;
      display: flex;
      align-items: center;
      gap: 8px;
      color: var(--accent);
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 1.6px;
      text-transform: uppercase;
      text-shadow: 0 1px 2px #000;
    }
    #sidebar .sb-title::before, #sidebar .sb-title::after {
      content: '';
      flex: 1;
      height: 1px;
      background: linear-gradient(90deg, transparent, #6b5426, transparent);
    }

    /* ----- Character tab ----- */
    #sidebar .sb-attrs { display: grid; grid-template-columns: 1fr 1fr; gap: 5px; }
    #sidebar .sb-attr {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      padding: 5px 8px;
      border: 1px solid #060402;
      box-shadow: inset 0 0 0 1px #4a3a1e, inset 0 2px 6px rgba(0, 0, 0, 0.55);
      background: rgba(0, 0, 0, 0.35);
    }
    #sidebar .sb-attr span { font-size: 10px; letter-spacing: 1px; color: var(--muted); }
    #sidebar .sb-attr b { font-size: 13px; color: var(--text); }

    #sidebar .sb-stats { display: flex; flex-direction: column; }
    #sidebar .sb-stat {
      display: flex;
      align-items: baseline;
      gap: 6px;
      padding: 3px 1px;
      line-height: 1.5;
    }
    #sidebar .sb-stat span { color: var(--muted); }
    #sidebar .sb-stat .sb-lead {
      flex: 1;
      border-bottom: 1px dotted #4a3a1e;
      transform: translateY(-3px);
    }
    #sidebar .sb-stat b { color: var(--text); font-size: 12px; }

    /* ----- Equipment tab: full-width rows stacked as a column ----- */
    #sidebar .sb-item {
      display: flex;
      flex-direction: column;
      gap: 3px;
      padding: 7px 8px 8px;
      border: 1px solid #060402;
      box-shadow: inset 0 0 0 1px #4a3a1e, inset 0 2px 8px rgba(0, 0, 0, 0.5);
      background: rgba(0, 0, 0, 0.32);
    }
    #sidebar .sb-item-head { display: flex; align-items: center; gap: 7px; }
    #sidebar .sb-item-icon {
      display: grid;
      place-items: center;
      width: 26px;
      height: 26px;
      font-size: 16px;
      border: 1px solid #4a3a1e;
      background: radial-gradient(circle at 50% 35%, #2a2014, #0e0a06);
      opacity: 0.55;
    }
    #sidebar .sb-item.owned .sb-item-icon { opacity: 1; }
    #sidebar .sb-item-name {
      flex: 1;
      font-size: 13px;
      color: var(--text);
      font-variant: small-caps;
      letter-spacing: 0.6px;
    }
    #sidebar .sb-item.owned .sb-item-name { color: var(--accent); }
    #sidebar .sb-item-tier { font-size: 11px; letter-spacing: 2px; color: var(--accent); }

    #sidebar .sb-item-now { margin: 0; font-size: 11px; color: var(--muted); }
    #sidebar .sb-item-next { margin: 0; font-size: 11px; color: #b9d08a; min-height: 14px; }

    #sidebar .sb-item-buy {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 8px;
      margin-top: 3px;
      height: 34px;
      padding: 0 10px;
      border: 1px solid #060402;
      border-radius: 0;
      box-shadow: inset 0 0 0 1px #8a6a2f, inset 0 1px 0 rgba(255, 226, 150, 0.3), inset 0 -3px 6px rgba(0, 0, 0, 0.45);
      background: linear-gradient(#7a5a26, #573e14 55%, #3d2a0c);
      color: #f2e4bd;
      text-shadow: 0 1px 1px rgba(0, 0, 0, 0.7);
      font: inherit;
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.6px;
      cursor: pointer;
    }
    #sidebar .sb-item-buy:hover:not(:disabled) { filter: brightness(1.15); }
    #sidebar .sb-item-buy:active:not(:disabled) {
      box-shadow: inset 0 0 0 1px #8a6a2f, inset 0 3px 6px rgba(0, 0, 0, 0.6);
      filter: brightness(0.95);
    }
    #sidebar .sb-item-buy .sb-buy-cost { color: var(--accent); font-weight: 700; }
    #sidebar .sb-item-buy:disabled {
      box-shadow: inset 0 0 0 1px #3a2d16, inset 0 -3px 6px rgba(0, 0, 0, 0.45);
      background: linear-gradient(#241b0e, #170f08);
      color: var(--muted);
      cursor: default;
      opacity: 1;
    }
    /* Not enough gold: the price itself is what says no. */
    #sidebar .sb-item-buy.poor .sb-buy-cost { color: #d97070; }

    /* The sidebar carries the bars on desktop, so the top-left strip goes. */
    body:not(.touch) #stats { display: none; }

    /* A phone has no room for a permanent panel: it becomes a 🎒 overlay. The
       right offset clears the utility column — otherwise the panel covers the
       very button that closes it — and the height clears the thumb rail. */
    #sidebar.floating {
      top: calc(26px + var(--safe-t));
      right: calc(60px + var(--safe-r));
      width: min(272px, 66vw);
      height: auto;
      /* It is a sheet you open and close, so covering the thumb rail while it
         is up costs nothing — covering the button that closes it would. */
      max-height: calc(var(--app-h) - 40px - var(--safe-t) - var(--safe-b));
      padding: 8px;
      border: 1px solid #060402;
      box-shadow:
        inset 0 0 0 1px #6b5426,
        inset 0 0 26px rgba(0, 0, 0, 0.55),
        0 8px 28px rgba(0, 0, 0, 0.65);
    }
    /* The compact strip already carries the bars, the level and the name on
       touch, so the sheet spends its 380 px on what is only here. */
    #sidebar.floating .sb-level-row,
    #sidebar.floating .sb-bars { display: none; }
    #sidebar.floating .sb-tally { font-size: 12px; }
    /* Tap targets: a finger needs 44 px where a mouse needs 34. */
    #sidebar.floating .sb-item-buy { height: 44px; }
    #sidebar.floating .sb-tab { padding: 10px 4px; }
  `
  document.head.appendChild(style)
}
