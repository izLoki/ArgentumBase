/**
 * NPC SYSTEM (client) — draws the monsters.
 *
 * Owns a Container in `layers.entities`, with `zIndex = worldY` so mobs sort
 * against players correctly (the layer is already `sortableChildren`).
 *
 * The snapshot is deliberately terse — `{ m: [[id, typeIdx, x, y, dir, hp,
 * maxHp], ...] }` — so this file is where those arrays become views. Nothing
 * else should have to know the tuple layout, and nothing else should read
 * `shared/mobs.js` to find out what a type index means.
 *
 * Mobs are drawn from PIXI PRIMITIVES, the way terrain and effects still are:
 * a body in the type's colour with its glyph on top. When a monster gets an
 * atlas it moves to `render/`, exactly like the class sprites did, and nothing
 * outside that directory learns that images exist.
 *
 * Positions are INTERPOLATED. A snapshot lands 15 times a second and a mob
 * drawn straight from it would step rather than walk, so the view eases towards
 * the server's tile and snaps only when the gap is too big to be a step.
 */

import { Container, Graphics, Sprite, Text } from 'pixi.js'
import { TILE_SIZE, BLOCK_PX, PLAYER_RADIUS } from '@shared/constants.js'
import { mobFromIndex, mobDef } from '@shared/mobs.js'
import { tileCentre } from '../render/entities.js'
import { mobSheetFor, CELL_W, CELL_H, FEET_Y } from '../render/sprites.js'

/** Smoothing per 60 Hz frame, matching the players' own interpolation. */
const LERP = 0.22
/** Past this gap it is a spawn or a teleport, not a walk. */
const SNAP_PX = BLOCK_PX * 2

/** Body size in screen pixels: the footprint that actually collides. */
const BODY = (PLAYER_RADIUS * 2 + 1) * TILE_SIZE

/** Health bar geometry, above the drawing. */
const BAR_W = 22
const BAR_H = 3

/**
 * Sprite height for a mob at `look.scale` 1, matching what a player gets. A
 * monster is drawn taller than the ground it stands on, exactly like a player —
 * `BODY` is still the only thing that collides.
 */
const SPRITE_H = 76
/** World pixels a mob walks per animation frame; the players' own stride. */
const STRIDE_PX = 16
const WALK_CYCLE = [0, 1, 2, 1]
/** Below this a frame's movement is interpolation settling, not a step. */
const MOVING_EPSILON = 0.05
const IDLE_AFTER_MS = 120

/** @type {Map<string, Container>} mobId -> view */
const views = new Map()

/** @type {Map<string, {id:string, type:string, x:number, y:number, dir:number, hp:number, maxHp:number}>} */
const mobs = new Map()

let root = null

export default {
  id: 'npc',

  init(ctx) {
    root = new Container()
    ctx.layers.entities.addChild(root)
  },

  onSnapshot(ctx, snapshot) {
    const rows = snapshot.ext?.npc?.m ?? []
    const seen = new Set()

    for (const row of rows) {
      const [id, typeIdx, x, y, dir, hp, maxHp] = row
      const key = String(id)
      const type = mobFromIndex(typeIdx)
      if (!type) continue // a monster this client's table does not know

      seen.add(key)
      mobs.set(key, { id: key, type, x, y, dir, hp, maxHp })
    }

    for (const key of [...mobs.keys()]) {
      if (seen.has(key)) continue
      mobs.delete(key)
      views.get(key)?.destroy({ children: true })
      views.delete(key)
    }
  },

  /**
   * Views follow the snapshot every frame rather than every packet: a mob that
   * only moved 15 times a second would visibly stutter next to a player whose
   * own drawing is interpolated.
   */
  onUpdate(ctx, dtMs) {
    for (const mob of mobs.values()) {
      let view = views.get(mob.id)
      if (!view) {
        view = makeView(mob)
        views.set(mob.id, view)
        root.addChild(view)
        view.x = tileCentre(mob.x)
        view.y = tileCentre(mob.y)
      }

      const tx = tileCentre(mob.x)
      const ty = tileCentre(mob.y)
      const wasX = view.x
      const wasY = view.y

      if (Math.abs(tx - view.x) > SNAP_PX || Math.abs(ty - view.y) > SNAP_PX) {
        view.x = tx
        view.y = ty
      } else {
        const k = smoothing(LERP, dtMs)
        view.x += (tx - view.x) * k
        view.y += (ty - view.y) * k
      }

      view.zIndex = view.y
      drawHpBar(view.__bar, mob.hp, mob.maxHp, view.__headY)
      if (view.__sprite) {
        animate(view, Math.hypot(view.x - wasX, view.y - wasY), mob.dir, dtMs)
      }
    }
  },

  handlers: {},
}

/* ---------- API for other client systems ---------- */

/**
 * Interpolated pixel position of a mob — the mob twin of `viewPosition(id)` in
 * render/entities.js. `spells` and `effects` anchor their FX with it.
 *
 * @returns {{x:number, y:number}|null}
 */
export function mobViewPosition(id) {
  const view = views.get(String(id))
  return view ? { x: view.x, y: view.y } : null
}

/** The local mirror of a mob: `{ id, type, x, y, dir, hp, maxHp }`. */
export function mobState(id) {
  return mobs.get(String(id)) ?? null
}

/** Every mob this client knows about, for auto-targeting and minimaps. */
export function allMobStates() {
  return mobs.values()
}

/* ---------- drawing ---------- */

function makeView(mob) {
  const def = mobDef(mob.type)
  const view = new Container()
  const scale = def?.look?.scale ?? 1
  const w = BODY * scale
  const h = BODY * scale

  const textures = mobSheetFor(mob.type)
  if (textures) {
    const spriteH = SPRITE_H * scale
    const sprite = new Sprite(textures[0][0])
    // Feet on the atlas baseline, standing at the bottom of the footprint —
    // the same arrangement players use, so the two sort against each other.
    sprite.anchor.set(0.5, FEET_Y / CELL_H)
    sprite.setSize((spriteH * CELL_W) / CELL_H, spriteH)
    sprite.y = h / 2
    view.addChild(sprite)

    const bar = new Graphics()
    view.addChild(bar)

    view.__bar = bar
    view.__sprite = sprite
    view.__textures = textures
    view.__walk = { dist: 0, stillMs: 0 }
    view.__headY = h / 2 - spriteH * (FEET_Y / CELL_H)
    return view
  }

  const body = new Graphics()
  body
    .ellipse(0, 0, w / 2, h / 2)
    .fill({ color: def?.look?.color ?? 0x888888, alpha: 0.85 })
    .stroke({ width: 1, color: 0x000000, alpha: 0.6 })
  view.addChild(body)

  const glyph = new Text({
    text: def?.look?.glyph ?? '👾',
    style: { fontFamily: 'Segoe UI Emoji, Segoe UI, sans-serif', fontSize: 13 * scale },
  })
  glyph.anchor.set(0.5)
  view.addChild(glyph)

  const bar = new Graphics()
  view.addChild(bar)

  view.__bar = bar
  // Where anything hung over this monster's head belongs, the same contract
  // `viewHeadY` gives for players.
  view.__headY = -h / 2
  return view
}

/**
 * Walk cycle for a mob with an atlas, driven by DISTANCE like the players' —
 * mobs step on their own `moveMs`, so a timer would drift out of phase with the
 * feet at every speed but one.
 */
function animate(view, movedPx, dir, dtMs) {
  const walk = view.__walk
  if (movedPx > MOVING_EPSILON) {
    walk.dist += movedPx
    walk.stillMs = 0
  } else {
    walk.stillMs += dtMs
    if (walk.stillMs >= IDLE_AFTER_MS) walk.dist = 0
  }

  const step = walk.stillMs >= IDLE_AFTER_MS ? 0 : Math.floor(walk.dist / STRIDE_PX)
  const row = view.__textures[dir] ?? view.__textures[0]
  view.__sprite.texture = row[WALK_CYCLE[step % WALK_CYCLE.length]]
}

/**
 * Hidden at full health, like a player's: a screen full of permanent bars is
 * noise, and the bar appearing IS the feedback that a hit landed.
 */
function drawHpBar(bar, hp, maxHp, headY) {
  const pct = maxHp > 0 ? Math.max(0, hp / maxHp) : 0
  bar.clear()
  if (pct >= 1) return

  const y = headY - 5
  bar.rect(-BAR_W / 2, y, BAR_W, BAR_H).fill(0x000000)
  bar.rect(-BAR_W / 2, y, BAR_W * pct, BAR_H).fill(pct > 0.35 ? 0xd98f4f : 0xd94f4f)
}

/** Frame-rate independent exponential smoothing, as in render/entities.js. */
function smoothing(perFrame, dtMs) {
  return 1 - Math.pow(1 - perFrame, Math.min(4, dtMs / 16.67))
}
