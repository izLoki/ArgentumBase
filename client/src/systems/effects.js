/**
 * EFFECTS SYSTEM (client) — status icons above heads.
 *
 * Two sources, on purpose: the public icon list rides the snapshot so everyone
 * can see who is frozen, while exact remaining durations are private and only
 * reach their owner over EFFECTS_SELF. So every head shows WHAT it is carrying
 * and only your own head shows FOR HOW LONG.
 *
 * Owns a Container in `layers.overlay`. Anchors to players through
 * `viewPosition(id)` and to mobs through `npc`'s `mobViewPosition(id)`, so a
 * badge follows the interpolated drawing rather than the last snapshot tile.
 *
 * CLOCKS. `endsAt` is a server timestamp and two machines do not agree on what
 * time it is, so the packet carries the server's `now` alongside it and every
 * deadline is rebased onto `performance.now()` the moment it arrives.
 */

import { Container, Text } from 'pixi.js'
import { S2C } from '@shared/protocol.js'
import { EFFECTS } from '@shared/effects.js'
import { viewPosition, viewHeadY } from '../render/entities.js'
import { mobViewPosition } from './npc.js'

/** Gap between the top of a drawing and the icon row: the nameplate sits there. */
const ICON_LIFT = 22
/** Mobs have no `viewHeadY` until B5 lands, so their row hangs off a constant. */
const MOB_HEAD_Y = -14

const ICON_SIZE = 11
const ICON_GAP = 13

/** Blink the local player's icons over the last second of their duration. */
const EXPIRING_MS = 1000
const BLINK_MS = 250

let root = null

/** `${providerId}:${entityId}` -> badge */
const badges = new Map()

/** The local player's private view: durations, rebased onto the local clock. */
let mine = []

export default {
  id: 'effects',

  init(ctx) {
    root = new Container()
    ctx.layers.overlay.addChild(root)
  },

  onSnapshot(ctx, snapshot) {
    const incoming = snapshot.ext?.effects
    const seen = new Set()

    for (const [providerId, entities] of Object.entries(incoming ?? {})) {
      for (const [entityId, ids] of Object.entries(entities)) {
        const key = `${providerId}:${entityId}`
        seen.add(key)
        syncBadge(key, providerId, entityId, ids, ctx.state.selfId)
      }
    }

    for (const [key, badge] of badges) {
      if (seen.has(key)) continue
      badge.view.destroy({ children: true })
      badges.delete(key)
    }
  },

  /**
   * Badges follow the drawing every frame — a snapshot arrives 15 times a
   * second and an icon that only moved that often would visibly lag the head
   * it belongs to.
   */
  onUpdate(ctx, dtMs) {
    const now = performance.now()
    if (mine.length > 0) mine = mine.filter((entry) => entry.endsAtLocal > now)

    for (const badge of badges.values()) {
      const pos = anchorOf(badge)
      badge.view.visible = pos !== null
      if (!pos) continue

      badge.view.x = pos.x
      badge.view.y = pos.y
      if (badge.isSelf) countdown(badge, now)
    }
  },

  handlers: {
    [S2C.EFFECTS_SELF](ctx, payload) {
      const serverNow = payload?.now ?? Date.now()
      const base = performance.now()

      mine = (payload?.active ?? []).map((entry) => ({
        id: entry.id,
        endsAt: entry.endsAt,
        stacks: entry.stacks ?? 1,
        // Permanent effects never run out, so they never blink or count down.
        endsAtLocal: entry.endsAt > 0 ? base + (entry.endsAt - serverNow) : Infinity,
      }))
    },
  },
}

/* ---------- API for other client systems ---------- */

/**
 * Active effects on the local player: `{ id, endsAt, stacks, endsAtLocal }[]`.
 * `endsAt` is the server's timestamp; `endsAtLocal` is the same instant on
 * `performance.now()`, which is the one to compare against.
 */
export function myEffects() {
  return mine
}

/** True when the local player currently has this effect. */
export function hasEffect(effectId) {
  const now = performance.now()
  return mine.some((entry) => entry.id === effectId && entry.endsAtLocal > now)
}

/** Milliseconds left on the local player's effect: 0 when it is not running. */
export function remainingOf(effectId) {
  const entry = mine.find((e) => e.id === effectId)
  if (!entry) return 0
  if (entry.endsAtLocal === Infinity) return Infinity
  return Math.max(0, entry.endsAtLocal - performance.now())
}

/* ---------- badges ---------- */

/**
 * Rebuilds a row only when its icons actually changed. The snapshot repeats the
 * same list 15 times a second, and re-laying out unchanged Text objects would
 * be the most expensive thing this file does.
 */
function syncBadge(key, providerId, entityId, ids, selfId) {
  const sig = ids.join(',')
  let badge = badges.get(key)

  if (badge && badge.sig === sig) return

  if (!badge) {
    badge = {
      view: new Container(),
      providerId,
      entityId,
      isSelf: providerId === 'players' && entityId === selfId,
      sig: '',
      icons: [],
    }
    root.addChild(badge.view)
    badges.set(key, badge)
  }

  badge.sig = sig
  badge.view.removeChildren().forEach((child) => child.destroy())
  badge.icons = []

  ids.forEach((id, index) => {
    const glyph = EFFECTS[id]?.icon
    if (!glyph) return // an effect this client's table does not know: skip it

    const text = new Text({
      text: glyph,
      style: { fontFamily: 'Segoe UI Emoji, Segoe UI, sans-serif', fontSize: ICON_SIZE },
    })
    text.anchor.set(0.5, 1)
    text.x = (index - (ids.length - 1) / 2) * ICON_GAP
    badge.view.addChild(text)
    badge.icons.push({ id, text, glyph })
  })
}

/** Where the row hangs, in world pixels, or null while the drawing is gone. */
function anchorOf(badge) {
  if (badge.providerId !== 'players') {
    const pos = mobViewPosition(badge.entityId)
    return pos ? { x: pos.x, y: pos.y + MOB_HEAD_Y - ICON_LIFT } : null
  }

  const pos = viewPosition(badge.entityId)
  if (!pos) return null
  return { x: pos.x, y: pos.y + (viewHeadY(badge.entityId) ?? 0) - ICON_LIFT }
}

/**
 * The one thing the private packet buys: your own icons dim and blink as they
 * run out, so Ice Block ending is something you see rather than discover.
 */
function countdown(badge, now) {
  for (const icon of badge.icons) {
    const entry = mine.find((e) => e.id === icon.id)
    const left = entry ? entry.endsAtLocal - now : Infinity

    if (!Number.isFinite(left) || left > EXPIRING_MS) {
      icon.text.alpha = 1
      continue
    }
    icon.text.alpha = Math.floor(left / BLINK_MS) % 2 === 0 ? 0.35 : 1
  }
}
