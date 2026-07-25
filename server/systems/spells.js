/**
 * SPELLS SYSTEM (server) — the one executor every caster goes through.
 *
 * A dragon's fireball is literally `SPELLS.fireball`. `castSpell` takes a
 * CASTER HANDLE, not a player, which is what stops mob casting from becoming
 * a second copy of the projectile code.
 *
 * Adding a spell is one row in shared/spells.js. Adding a new KIND of spell is
 * one entry in the `ACTIONS` registry below.
 *
 * Projectiles travel in the snapshot (`snapshot.ext.spells.proj`), not only in
 * a one-shot event: the base's contract is "snapshots are full state", which
 * makes late joiners and packet loss self-healing. `SPELL_CAST_FX` starts the
 * animation locally so the caster sees zero latency.
 *
 * The spellbook and cooldowns are PRIVATE — `ctx.sendTo`, never the snapshot.
 *
 * UNITS. Every distance in shared/spells.js is in BLOCKS; every coordinate is
 * in TILES. This file is where the two meet, so it converts once per read with
 * `blocksToTiles()`. Forgetting it makes every spell a quarter of its reach.
 *
 * WHO OWNS WHAT. This system never writes hp — `combat.applyDamage` does. It
 * never writes a mob's position — `npc` does. The only foreign state it touches
 * is a PLAYER's x/y, for Blink and Charge, which is the core's own field and
 * has no other writer during a cast.
 */

import { C2S, S2C } from '../../shared/protocol.js'
import { DIR_VEC, PLAYER_RADIUS, blocksToTiles } from '../../shared/constants.js'
import {
  spellDef,
  spellIndex,
  spellsForClass,
  unlockLevel,
  knownFor,
  railForClass,
  effectiveCooldown,
  spellDamage,
} from '../../shared/spells.js'
import { isWalkable, canStand } from '../world/map.js'
import { isTileOccupied } from '../game/state.js'
import { profileOf, statsOf } from './profile.js'
import { applyEffect, hasFlag } from './effects.js'
import {
  applyDamage,
  heal,
  handleOf,
  teamOf,
  posOf,
  targetAt,
  targetsInRadius,
} from './combat.js'

/**
 * What a spell is cast BY. Players and mobs both wear this shape, which is the
 * whole trick: the executor never asks which one it has.
 *
 * @typedef {Object} CasterHandle
 * @property {'players'|'npc'} providerId
 * @property {any} ref                   the player or mob behind the handle
 * @property {number} x
 * @property {number} y
 * @property {number} dir
 * @property {string} team
 * @property {Object} stats              derived stats: cdr, damage, defense...
 * @property {Object} attrs              attributes on the [0, ATTR_MAX] scale;
 *                                       mobs author theirs, players derive them
 * @property {Map<string, number>} cdUntil  spellId -> timestamp
 */

/**
 * Where a cast is aimed. Which fields matter depends on `def.targeting`.
 *
 * @typedef {Object} CastTarget
 * @property {number} [tx]
 * @property {number} [ty]
 * @property {number} [dir]
 */

/**
 * Action resolvers, keyed by `action.type`. Extend it with `registerAction`
 * rather than editing this object, so a new action never conflicts.
 *
 * @type {Record<string, (ctx:Object, caster:CasterHandle, action:Object, targets:Array, at:{x:number,y:number}, def:Object) => void>}
 */
const ACTIONS = Object.create(null)

/**
 * How finely a projectile is sampled along its path, in tiles.
 *
 * A fast projectile covers ~4 tiles per tick. Moving it in one jump would let
 * it pass straight through a body, so it advances in sub-tile steps and tests
 * every tile it enters. Half a tile is under the 3-tile body width by a wide
 * margin and still cheap: a full-length Piercing Shot is ~72 samples.
 */
const PROJECTILE_STEP_TILES = 0.5

export default {
  id: 'spells',
  enabled: true,

  init(ctx) {
    ctx.world.ext.spells = { projectiles: [], zones: [], nextId: 1 }
    registerBuiltinActions()
    ctx.log('spells ready: one executor, eight targeting shapes')
  },

  onPlayerJoin(ctx, player) {
    const profile = profileOf(player)
    player.ext.spells = {
      /** Spell ids this player may cast, in slot order. */
      known: knownFor(player.cls, profile?.level ?? 1),
      /** spellId -> timestamp the cooldown ends. */
      cdUntil: new Map(),
      /** Last level the spellbook was built for, so unlocks are pushed once. */
      bookLevel: profile?.level ?? 1,
    }
    sendBook(ctx, player)
  },

  onPlayerLeave(ctx, player) {
    // Anything this player left behind stops belonging to anyone.
    const ext = ctx.world.ext.spells
    if (!ext) return
    ext.projectiles = ext.projectiles.filter((p) => p.ownerId !== player.id)
    ext.zones = ext.zones.filter((z) => z.ownerId !== player.id)
  },

  onTick(ctx, dtMs) {
    const now = Date.now()
    advanceProjectiles(ctx, dtMs)
    advanceZones(ctx, now)
    refreshBooks(ctx)
  },

  /**
   * Projectiles and VISIBLE zones only. A hidden zone (a hunter's trap) would
   * be revealed by the snapshot, so it is sent to its owner alone at cast time
   * and never published again until it triggers.
   */
  collectSnapshot(ctx) {
    const ext = ctx.world.ext.spells
    if (!ext) return undefined

    const proj = ext.projectiles.map((p) => [
      p.id,
      spellIndex(p.spellId),
      Math.round(p.x * 10),
      Math.round(p.y * 10),
    ])
    const zones = ext.zones
      .filter((z) => !z.hidden)
      .map((z) => [z.id, spellIndex(z.spellId), z.x, z.y, z.radius])

    if (proj.length === 0 && zones.length === 0) return undefined
    return { proj, zones }
  },

  handlers: {
    /**
     * The client proposes; the server decides. Coordinates are re-validated
     * against range, terrain and line of sight, so a tampered payload buys
     * nothing that a legitimate one could not have asked for.
     */
    [C2S.SPELL_CAST](ctx, player, payload) {
      const id = typeof payload?.id === 'string' ? payload.id : null
      if (!id) return

      const caster = casterFromPlayer(ctx, player)
      if (!caster) return

      castSpell(ctx, caster, id, {
        tx: numberOr(payload?.tx, null),
        ty: numberOr(payload?.ty, null),
        dir: numberOr(payload?.dir, null),
      })
    },
  },
}

/* ---------- API for other systems ---------- */

/**
 * Casts a spell from any caster. Validates cooldown, unlock, range, line of
 * sight and `silenced`, then resolves the targeting shape and runs every
 * action in order.
 *
 * @param {Object} ctx
 * @param {CasterHandle} caster
 * @param {string} spellId
 * @param {CastTarget} [target]
 * @returns {boolean} true when the cast actually went off
 */
export function castSpell(ctx, caster, spellId, target = {}) {
  const def = spellDef(spellId)
  if (!caster || !def) return refuse(ctx, caster, spellId, 'unknown')

  if (caster.ref?.dead) return refuse(ctx, caster, spellId, 'dead')
  if (!mayCast(caster, spellId)) return refuse(ctx, caster, spellId, 'locked')
  if (hasFlag(caster.ref, 'silenced')) return refuse(ctx, caster, spellId, 'silenced')
  if (cooldownLeft(caster, spellId) > 0) return refuse(ctx, caster, spellId, 'cooldown')

  // Aiming is free, so a cast that is going nowhere is refused before it costs
  // a cooldown. Everything past this point is committed.
  const shape = SHAPES[def.targeting]
  if (!shape) return refuse(ctx, caster, spellId, 'unknown')

  const resolved = shape(ctx, caster, def, target)
  if (resolved?.error) return refuse(ctx, caster, spellId, resolved.error)

  startCooldown(ctx, caster, def)
  emitCastFx(ctx, caster, def, resolved)

  // A projectile has not hit anything yet: its actions run when it lands.
  if (!resolved.deferred) runActions(ctx, caster, def, resolved.at, resolved.hits)
  return true
}

/** Spell ids this player has unlocked, in slot order. */
export function knownSpells(player) {
  return player?.ext?.spells?.known ?? []
}

/**
 * Registers a new action type. Call it from your own system's `init` to teach
 * the executor a trick without editing this file.
 *
 * @param {string} type
 * @param {(ctx:Object, caster:CasterHandle, action:Object, targets:Array, at:{x:number,y:number}, def:Object) => void} fn
 */
export function registerAction(type, fn) {
  ACTIONS[type] = fn
}

/** Wraps a player in the caster handle shape. Mobs build their own in `npc`. */
export function casterFromPlayer(ctx, player) {
  const slot = player?.ext?.spells
  if (!slot) return null

  return {
    providerId: 'players',
    ref: player,
    x: player.x,
    y: player.y,
    dir: player.dir,
    // Everyone is hostile to everyone, so a player is their own team. Real
    // teams later means returning a shared id here and nothing else changes.
    team: player.id,
    stats: statsOf(player) ?? {},
    attrs: profileOf(player)?.attributes ?? {},
    cdUntil: slot.cdUntil,
  }
}

/** Remaining cooldown in ms, or 0 when ready. */
export function cooldownLeft(caster, spellId) {
  const until = caster?.cdUntil?.get(spellId) ?? 0
  return Math.max(0, until - Date.now())
}

/* ---------- targeting shapes ---------- */

/**
 * Each resolver answers one question: what does this cast touch, and where?
 *
 * It returns `{ at, hits }`, or `{ error }` to refuse the cast before it costs
 * a cooldown, or `{ deferred: true }` when the answer arrives later (a
 * projectile still in flight).
 *
 * `hits` is only what the shape struck directly. An action with
 * `target: 'area'` recomputes from `at` and the spell's radius, so Fireball
 * splashing and Lightning Ray piercing come from the same two fields.
 */
const SHAPES = {
  self(ctx, caster) {
    return { at: { x: caster.x, y: caster.y }, hits: [] }
  },

  /** The first living body in front of the caster, within reach. */
  melee(ctx, caster, def) {
    const vec = DIR_VEC[caster.dir]
    const reach = blocksToTiles(def.range)

    for (let step = 1; step <= reach; step++) {
      const x = caster.x + vec.x * step
      const y = caster.y + vec.y * step
      const hit = targetAt(ctx, x, y)
      if (isEnemy(caster, hit)) return { at: { x, y }, hits: [hit] }
    }
    // A whiff still costs the cooldown: swinging at air is a decision.
    return { at: aheadOf(caster, reach), hits: [] }
  },

  /**
   * The closest enemy within reach, whatever the caster is facing.
   *
   * `melee` asks the player to line a body up on an 8 px grid while the stick
   * is still turning them; a class's basic strike cannot lose swings to that.
   * The client sends no coordinates for this shape — the server picks, so
   * there is nothing to tamper with.
   */
  nearest(ctx, caster, def) {
    const reach = blocksToTiles(def.range)
    const found = bodiesInRadius(ctx, caster.x, caster.y, reach, {
      exclude: casterTargetHandle(caster),
      team: caster.team,
    })

    const hit = closestTo(caster, found)
    if (!hit) return { at: aheadOf(caster, reach), hits: [] }

    const at = posOf(hit) ?? { x: caster.x, y: caster.y }
    return { at, hits: [hit] }
  },

  /** A point the caster picked. Blink, Hunter's Mark, Trap, Volley. */
  tile(ctx, caster, def, target) {
    const at = aimPoint(caster, def, target)
    const error = checkAim(caster, def, at)
    if (error) return { error }

    const hit = targetAt(ctx, at.x, at.y)
    return { at, hits: hit && hit.ref !== caster.ref ? [hit] : [] }
  },

  /** Centred on the caster when `range` is 0, otherwise on the aim point. */
  aoe(ctx, caster, def, target) {
    if (def.range <= 0) return { at: { x: caster.x, y: caster.y }, hits: [] }

    const at = aimPoint(caster, def, target)
    const error = checkAim(caster, def, at)
    return error ? { error } : { at, hits: [] }
  },

  /**
   * A band running out from the caster: a beam at width 1, a cone above it.
   * Lightning Ray pierces the whole length; Cleave stops at nothing but does
   * not care about walls either (`stopsOnTerrain: false`).
   */
  ray(ctx, caster, def) {
    const vec = DIR_VEC[caster.dir]
    const perp = { x: -vec.y, y: vec.x }
    const reach = blocksToTiles(def.range)
    const half = Math.floor(blocksToTiles(def.width ?? 1) / 2)

    const hits = []
    const seen = new Set()
    let end = { x: caster.x, y: caster.y }

    for (let step = 1; step <= reach; step++) {
      const cx = caster.x + vec.x * step
      const cy = caster.y + vec.y * step

      if (def.stopsOnTerrain !== false && !isWalkable(cx, cy)) break
      end = { x: cx, y: cy }

      for (let off = -half; off <= half; off++) {
        const hit = targetAt(ctx, cx + perp.x * off, cy + perp.y * off)
        if (!isEnemy(caster, hit) || seen.has(hit.ref)) continue
        seen.add(hit.ref)
        hits.push(hit)
      }

      if (hits.length > 0 && !def.pierce) break
    }

    return { at: end, hits, ray: { x0: caster.x, y0: caster.y, x1: end.x, y1: end.y } }
  },

  /**
   * Spawns an entity and answers later. The cast is committed here — cooldown
   * and FX go out now — but nothing is damaged until `advanceProjectiles`
   * decides what it ran into.
   */
  projectile(ctx, caster, def, target) {
    const at = aimPoint(caster, def, target)
    const error = checkAim(caster, def, at)
    if (error) return { error }

    const dx = at.x - caster.x
    const dy = at.y - caster.y
    const len = Math.hypot(dx, dy)
    if (len < 1) return { error: 'range' }

    const projectile = spawnProjectile(ctx, caster, def, dx / len, dy / len)
    return { at, hits: [], deferred: true, projId: projectile.id }
  },

  /**
   * Moves the caster instead of reaching out.
   *
   * Three knobs, and every dash in the table is a combination of them: a
   * non-phasing dash stops at the first body and that body is the hit; a
   * `sweeps` dash cuts down everything its path crossed; Roll sets neither and
   * simply travels.
   */
  dash(ctx, caster, def) {
    const vec = DIR_VEC[caster.dir]
    const reach = blocksToTiles(def.range)
    const self = casterTargetHandle(caster)

    let x = caster.x
    let y = caster.y
    let blocker = null
    /** ref -> handle: one body crossed twice is still one hit. */
    const swept = new Map()

    for (let step = 1; step <= reach; step++) {
      const nx = caster.x + vec.x * step
      const ny = caster.y + vec.y * step
      if (!canStand(nx, ny)) break

      if (!def.phasing) {
        const hit = targetAt(ctx, nx, ny)
        if (isEnemy(caster, hit)) {
          blocker = hit
          break
        }
      }
      x = nx
      y = ny

      // Bodies are wider than the line the caster walks, so the sweep asks who
      // TOUCHED the path rather than who stood exactly on it.
      if (def.sweeps) {
        for (const hit of bodiesInRadius(ctx, nx, ny, 0, { exclude: self, team: caster.team })) {
          swept.set(hit.ref, hit)
        }
      }
    }

    // Phasing passes THROUGH bodies, not INTO one: if the landing spot is
    // taken, back up until it is not.
    if (def.phasing) {
      while ((x !== caster.x || y !== caster.y) && isTileOccupied(x, y, idOf(caster))) {
        x -= vec.x
        y -= vec.y
      }
    }

    if (blocker) swept.set(blocker.ref, blocker)

    moveCaster(ctx, caster, x, y)
    return { at: { x, y }, hits: [...swept.values()] }
  },
}

/* ---------- actions ---------- */

/**
 * Registered from `init` rather than declared inline, so `registerAction` and
 * the built-ins go through exactly the same door.
 */
function registerBuiltinActions() {
  registerAction('damage', (ctx, caster, action, targets, at, def) => {
    const amount = spellDamage(action, caster.attrs, caster.stats)
    const source = casterTargetHandle(caster)

    for (const target of targets) {
      applyDamage(ctx, target, amount, {
        source,
        school: action.school ?? 'physical',
        melee: def.targeting === 'melee',
        spellId: def.id,
      })
    }
  })

  registerAction('heal', (ctx, caster, action, targets) => {
    const amount = spellDamage(action, caster.attrs, caster.stats)
    for (const target of targets) heal(ctx, target, amount)
  })

  /**
   * The magnitude comes from the ACTION, never from the effect table: that is
   * what lets two spells apply `burning` at different rates (ARENA.md §3.3).
   */
  registerAction('effect', (ctx, caster, action, targets) => {
    if (!action.effect) return
    for (const target of targets) {
      applyEffect(ctx, target.ref ?? target, action.effect, action.ms ?? 0, {
        sourceId: idOf(caster),
        params: action.params,
        casterStats: caster.stats,
      })
    }
  })

  registerAction('teleport', (ctx, caster, action, targets, at) => {
    if (!canStand(at.x, at.y)) return
    if (isTileOccupied(at.x, at.y, idOf(caster))) return
    moveCaster(ctx, caster, at.x, at.y)
  })

  registerAction('knockback', (ctx, caster, action, targets) => {
    const vec = DIR_VEC[caster.dir]
    const distance = blocksToTiles(action.blocks ?? 1)

    for (const target of targets) {
      if (target.providerId !== 'players') continue // mob positions belong to `npc`
      const ref = target.ref
      for (let step = 0; step < distance; step++) {
        const nx = ref.x + vec.x
        const ny = ref.y + vec.y
        if (!canStand(nx, ny) || isTileOccupied(nx, ny, ref.id)) break
        ref.x = nx
        ref.y = ny
      }
    }
  })

  /** Traps and lingering rain: an entity that outlives the cast. */
  registerAction('spawnZone', (ctx, caster, action, targets, at, def) => {
    const zone = action.zone
    if (!zone) return

    const now = Date.now()
    const ext = ctx.world.ext.spells
    const entry = {
      id: ext.nextId++,
      spellId: def.id,
      x: at.x,
      y: at.y,
      radius: blocksToTiles(zone.radius ?? 0),
      hidden: zone.hidden === true,
      expiresAt: now + (zone.ttlMs ?? 5000),
      // A trap waits for someone; rain ticks on its own. A zone may do either.
      triggers: zone.triggers ?? 0,
      everyMs: zone.everyMs ?? 0,
      nextTickAt: now + (zone.everyMs ?? 0),
      effect: zone.effect ?? null,
      effectMs: zone.ms ?? 0,
      effectParams: zone.params ?? null,
      damage: zone.damage ?? null,
      ownerId: idOf(caster),
      ownerProvider: caster.providerId,
      team: caster.team,
      attrs: caster.attrs,
      stats: caster.stats,
    }
    ext.zones.push(entry)

    // A hidden zone cannot ride the snapshot without revealing itself, so its
    // owner is told once, privately, and everyone else finds out the hard way.
    if (entry.hidden && caster.providerId === 'players') {
      ctx.sendTo(entry.ownerId, S2C.SPELL_IMPACT, {
        id: def.id,
        x: entry.x,
        y: entry.y,
        radius: entry.radius,
      })
    }
  })

  registerAction('dispel', (ctx, caster, action, targets) => {
    // Left to `effects` to own: removeEffect is its API, and dispelling
    // everything at once needs a policy this system should not invent.
  })
}

/**
 * Runs every action of a cast in order.
 *
 * `action.target` decides who each one lands on:
 *   'self'  the caster
 *   'hit'   whatever the targeting shape struck
 *   'area'  everything within the spell's radius of the impact point
 *   'tile'  nobody — the action uses `at` itself (teleport, spawnZone)
 */
function runActions(ctx, caster, def, at, hits) {
  let area = null

  for (const action of def.actions ?? []) {
    const fn = ACTIONS[action.type]
    if (!fn) continue

    let targets = []
    if (action.target === 'self') targets = [casterTargetHandle(caster)]
    else if (action.target === 'hit') targets = hits
    else if (action.target === 'area') {
      // Computed once per cast, not once per action: two actions splashing the
      // same crater must agree on who was in it.
      area ??= bodiesInRadius(ctx, at.x, at.y, blocksToTiles(def.radius ?? 0), {
        exclude: casterTargetHandle(caster),
        team: caster.team,
      })
      targets = area
    }

    try {
      fn(ctx, caster, action, targets, at, def)
    } catch (err) {
      console.error(`[spells] action "${action.type}" of ${def.id} threw:`, err)
    }
  }
}

/* ---------- projectiles ---------- */

function spawnProjectile(ctx, caster, def, dx, dy) {
  const ext = ctx.world.ext.spells
  const projectile = {
    id: ext.nextId++,
    spellId: def.id,
    x: caster.x,
    y: caster.y,
    dx,
    dy,
    /** Blocks per second in the table; tiles per second on the grid. */
    speed: blocksToTiles(def.speedTps ?? 8),
    remaining: blocksToTiles(def.range),
    pierce: def.pierce === true,
    stopsOnTerrain: def.stopsOnTerrain !== false,
    ownerId: idOf(caster),
    ownerProvider: caster.providerId,
    team: caster.team,
    // Snapshotted at launch: a bolt does not get weaker because its caster died
    // or lost a buff while it was in the air.
    attrs: caster.attrs,
    stats: caster.stats,
    hit: new Set(),
  }
  ext.projectiles.push(projectile)
  return projectile
}

function advanceProjectiles(ctx, dtMs) {
  const ext = ctx.world.ext.spells
  if (!ext?.projectiles.length) return

  ext.projectiles = ext.projectiles.filter((p) => stepProjectile(ctx, p, dtMs))
}

/** @returns {boolean} true while the projectile is still flying. */
function stepProjectile(ctx, p, dtMs) {
  const def = spellDef(p.spellId)
  if (!def) return false

  let budget = (p.speed * dtMs) / 1000

  while (budget > 0) {
    const step = Math.min(PROJECTILE_STEP_TILES, budget)
    budget -= step
    p.x += p.dx * step
    p.y += p.dy * step
    p.remaining -= step

    const tx = Math.round(p.x)
    const ty = Math.round(p.y)

    if (p.stopsOnTerrain && !isWalkable(tx, ty)) {
      detonate(ctx, p, def, { x: tx, y: ty }, [])
      return false
    }

    // The caster's own body is three tiles wide and the bolt starts inside it.
    // The team check is what walks it out, with no grace distance to tune.
    const target = targetAt(ctx, tx, ty)
    if (target && !p.hit.has(target.ref) && teamOf(target) !== p.team) {
      p.hit.add(target.ref)
      detonate(ctx, p, def, { x: tx, y: ty }, [target])
      if (!p.pierce) return false
    }

    if (p.remaining <= 0) {
      detonate(ctx, p, def, { x: tx, y: ty }, [])
      return false
    }
  }
  return true
}

/** Runs the projectile's actions where it stopped, as if it had been cast there. */
function detonate(ctx, p, def, at, hits) {
  const caster = casterFromProjectile(ctx, p)
  runActions(ctx, caster, def, at, hits)

  ctx.broadcast(S2C.SPELL_IMPACT, {
    id: def.id,
    x: at.x,
    y: at.y,
    radius: blocksToTiles(def.radius ?? 0),
  })
}

/**
 * Rebuilds a caster handle from a projectile in flight.
 *
 * The owner may have died, disconnected or moved since launch, so the handle
 * carries the snapshotted numbers and only looks up `ref` for attribution.
 */
function casterFromProjectile(ctx, p) {
  return {
    providerId: p.ownerProvider,
    ref: ownerRef(ctx, p),
    x: p.x,
    y: p.y,
    dir: 0,
    team: p.team,
    stats: p.stats,
    attrs: p.attrs,
    cdUntil: new Map(),
  }
}

function ownerRef(ctx, p) {
  return p.ownerProvider === 'players' ? ctx.world.players.get(p.ownerId) ?? null : null
}

/* ---------- zones ---------- */

function advanceZones(ctx, now) {
  const ext = ctx.world.ext.spells
  if (!ext?.zones.length) return

  ext.zones = ext.zones.filter((zone) => stepZone(ctx, zone, now))
}

/** @returns {boolean} true while the zone is still alive. */
function stepZone(ctx, zone, now) {
  if (now >= zone.expiresAt) return false

  const inside = () => bodiesInRadius(ctx, zone.x, zone.y, zone.radius, { team: zone.team })

  // A trap: waits for the first body, spends a trigger, dies when it runs out.
  if (zone.triggers > 0) {
    const caught = inside()
    if (caught.length === 0) return true

    for (const target of caught) {
      if (zone.effect) {
        applyEffect(ctx, target.ref, zone.effect, zone.effectMs, {
          sourceId: zone.ownerId,
          params: zone.effectParams,
          casterStats: zone.stats,
        })
      }
      zone.triggers -= 1
      if (zone.triggers <= 0) break
    }

    ctx.broadcast(S2C.SPELL_IMPACT, {
      id: zone.spellId,
      x: zone.x,
      y: zone.y,
      radius: zone.radius,
    })
    return zone.triggers > 0
  }

  // Lingering rain: ticks on its own schedule for as long as it lasts.
  if (zone.everyMs > 0 && now >= zone.nextTickAt) {
    zone.nextTickAt = now + zone.everyMs

    if (zone.damage) {
      const amount = spellDamage(zone.damage, zone.attrs, zone.stats)
      const source = zoneSource(ctx, zone)
      for (const target of inside()) {
        applyDamage(ctx, target, amount, {
          source,
          school: zone.damage.school ?? 'physical',
          spellId: zone.spellId,
        })
      }
    }

    ctx.broadcast(S2C.SPELL_IMPACT, {
      id: zone.spellId,
      x: zone.x,
      y: zone.y,
      radius: zone.radius,
    })
  }
  return true
}

function zoneSource(ctx, zone) {
  if (zone.ownerProvider !== 'players') return null
  const owner = ctx.world.players.get(zone.ownerId)
  return owner ? handleOf(owner) : null
}

/* ---------- spellbook ---------- */

/**
 * Pushes newly unlocked spells after a level up.
 *
 * Polled rather than driven by an event: `profile` broadcasts a level-up but
 * this system would still have to rebuild the list, and a level comparison
 * across at most a few dozen players is cheaper than the wiring.
 */
function refreshBooks(ctx) {
  for (const player of ctx.world.players.values()) {
    const slot = player.ext.spells
    const level = profileOf(player)?.level ?? 1
    if (!slot || slot.bookLevel === level) continue

    slot.bookLevel = level
    slot.known = knownFor(player.cls, level)
    sendBook(ctx, player)
  }
}

/**
 * The whole rail, locked slots included: the client needs to draw a greyed
 * button with a lock on it, which it cannot do from a list of what is allowed.
 */
function sendBook(ctx, player) {
  const level = profileOf(player)?.level ?? 1
  const classSpells = spellsForClass(player.cls)

  const known = railForClass(player.cls).map((id, slot) => ({
    id,
    slot,
    unlocked: slot === 0 || level >= unlockLevel(classSpells.indexOf(id)),
  }))

  ctx.sendTo(player.id, S2C.SPELL_BOOK, { known })
}

/* ---------- helpers ---------- */

/**
 * Everything whose BODY overlaps a circle, rather than whose centre does.
 *
 * `combat.targetsInRadius` compares centres, which is the right primitive but
 * the wrong question here: a body is `PLAYER_RADIUS` tiles wide, so a trap at
 * radius 0 would only ever fire on a player standing dead centre on it — which
 * on an 8 px grid is close to never. Inflating by the body radius asks "did
 * anyone touch this", which is what every area effect in the game means.
 */
function bodiesInRadius(ctx, x, y, radius, opts) {
  return targetsInRadius(ctx, x, y, radius + PLAYER_RADIUS, opts)
}

/**
 * The closest of a set of targets, by Chebyshev distance — the same metric
 * every range in this file uses, so "in reach" and "nearest" never disagree.
 *
 * @returns {Object|null} the handle, or null for an empty set
 */
function closestTo(caster, targets) {
  let best = null
  let bestDistance = Infinity

  for (const target of targets) {
    const pos = posOf(target)
    if (!pos) continue

    const distance = Math.max(Math.abs(pos.x - caster.x), Math.abs(pos.y - caster.y))
    if (distance >= bestDistance) continue
    best = target
    bestDistance = distance
  }
  return best
}

/**
 * Where the cast is pointed.
 *
 * A client that sends coordinates gets them clamped to the spell's reach
 * rather than refused: an aim that overshoots by a tile is a fat thumb, not an
 * exploit. A client that sends nothing at all — a keyboard player who pressed
 * the key without aiming — fires straight ahead at maximum range.
 */
function aimPoint(caster, def, target) {
  const reach = blocksToTiles(def.range)
  if (target?.tx === null || target?.tx === undefined) return aheadOf(caster, reach)

  const dx = target.tx - caster.x
  const dy = target.ty - caster.y
  const distance = Math.max(Math.abs(dx), Math.abs(dy))
  if (distance <= reach) return { x: Math.round(target.tx), y: Math.round(target.ty) }

  const k = reach / distance
  return { x: Math.round(caster.x + dx * k), y: Math.round(caster.y + dy * k) }
}

function aheadOf(caster, tiles) {
  const vec = DIR_VEC[caster.dir] ?? DIR_VEC[0]
  return { x: caster.x + vec.x * tiles, y: caster.y + vec.y * tiles }
}

/** @returns {string|null} a refusal reason, or null when the aim is legal. */
function checkAim(caster, def, at) {
  const reach = blocksToTiles(def.range)
  if (Math.max(Math.abs(at.x - caster.x), Math.abs(at.y - caster.y)) > reach) return 'range'
  if (def.requiresLos && !hasLineOfSight(caster.x, caster.y, at.x, at.y)) return 'blocked'
  return null
}

/**
 * Bresenham over the terrain. Bodies do not block sight — only walls do, or
 * every crowded fight would become uncastable.
 */
function hasLineOfSight(x0, y0, x1, y1) {
  let x = x0
  let y = y0
  const dx = Math.abs(x1 - x0)
  const dy = -Math.abs(y1 - y0)
  const sx = x0 < x1 ? 1 : -1
  const sy = y0 < y1 ? 1 : -1
  let err = dx + dy

  while (x !== x1 || y !== y1) {
    const e2 = 2 * err
    if (e2 >= dy) {
      err += dy
      x += sx
    }
    if (e2 <= dx) {
      err += dx
      y += sy
    }
    if (!isWalkable(x, y)) return false
  }
  return true
}

/** Mobs cast whatever their table says; players only what they have unlocked. */
function mayCast(caster, spellId) {
  if (caster.providerId !== 'players') return true
  return caster.ref?.ext?.spells?.known?.includes(spellId) === true
}

function startCooldown(ctx, caster, def) {
  const ms = effectiveCooldown(def, caster.stats)
  caster.cdUntil.set(def.id, Date.now() + ms)

  if (caster.providerId === 'players') {
    ctx.sendTo(caster.ref.id, S2C.SPELL_COOLDOWN, { id: def.id, ms })
  }
}

/**
 * Positions have exactly one writer per entity kind. A player's x/y is the
 * core's field and nothing else moves it mid-cast; a mob's belongs to `npc`,
 * so a mob simply does not dash.
 */
function moveCaster(ctx, caster, x, y) {
  if (caster.providerId !== 'players') return
  caster.ref.x = x
  caster.ref.y = y
  caster.x = x
  caster.y = y
}

function emitCastFx(ctx, caster, def, resolved) {
  ctx.broadcast(S2C.SPELL_CAST_FX, {
    casterKind: caster.providerId === 'players' ? 'player' : 'npc',
    casterId: idOf(caster),
    id: def.id,
    x0: caster.x,
    y0: caster.y,
    tx: resolved.at?.x ?? caster.x,
    ty: resolved.at?.y ?? caster.y,
    dir: caster.dir,
    projId: resolved.projId ?? null,
  })

  if (resolved.ray) ctx.broadcast(S2C.SPELL_RAY, { id: def.id, ...resolved.ray })
}

/**
 * Tells the caster why nothing happened. Only players are told: a mob that
 * cannot cast simply tries again on its next think.
 *
 * @returns {false} so callers can `return refuse(...)`
 */
function refuse(ctx, caster, spellId, reason) {
  if (caster?.providerId === 'players' && caster.ref?.id) {
    ctx.sendTo(caster.ref.id, S2C.SPELL_FAILED, { id: spellId, reason })
  }
  return false
}

/**
 * Whether a struck target is something this caster is allowed to hit.
 *
 * The team check is what the projectile path already used to walk a bolt out of
 * its own caster's body; the direct shapes ask the same question so a pack of
 * monsters cannot cleave each other apart while chasing the same player. For
 * players nothing changes: everyone is their own team, so every other player is
 * an enemy and only the caster is excluded.
 */
function isEnemy(caster, hit) {
  return !!hit && hit.ref !== caster.ref && teamOf(hit) !== caster.team
}

/** The caster seen as something that can be hit, for self-targeted actions. */
function casterTargetHandle(caster) {
  return { providerId: caster.providerId, ref: caster.ref }
}

function idOf(caster) {
  return caster?.ref?.id ?? null
}

function numberOr(value, fallback) {
  return Number.isFinite(value) ? value : fallback
}
