/**
 * NPC SYSTEM (server) — monsters that spawn, chase and cast.
 *
 * Mobs own their own hp. `combat` never touches it directly: it reaches them
 * through the target provider registered here, which is what keeps the two
 * systems free of circular imports. This system imports `combat`, `spells` and
 * `effects`; none of them imports this one.
 *
 * TICK BUDGET AT 15 Hz. Every mob carries a `nextThinkAt` with a randomised
 * 200-400 ms think interval, so roughly 10-14 of the population think per tick
 * rather than all of them. Movement is greedy single-tile stepping — dominant
 * axis first, fall back to the other, random unstick after three blocked
 * attempts. NO PATHFINDING: the arena is open, and A* on two dozen mobs at
 * 15 Hz is exactly where this would fall over.
 *
 * THE POPULATION RULES ARE GLOBAL, not per-type rows: a cap per type, one
 * refill clock per type, a spawn exclusion circle around every player, and an
 * aggro circle of the same ten body widths. `SPAWNABLE_TYPES` is the switch for
 * which types the world actually mints — everything else here is written for
 * all four, so re-enabling one is adding its name back to that list.
 *
 * WITH NO TARGET A MOB WANDERS: three seconds walking a random heading at half
 * speed, two seconds still, alternating. A player entering its circle turns it
 * into a chase at full speed, and leaving only ends it three seconds later.
 *
 * ABILITY CHOICE IS A DATA QUESTION, not a decision tree: `spells` is in
 * priority order and the mob casts the first entry that is off cooldown and
 * whose range covers the target. That is why the dragon lists
 * `['fireBreath', 'tailSweep', 'clawSwipe']` — the long-cooldown abilities get
 * first refusal and the claw is what is left over.
 *
 * DROPS ARE NOT SPAWNED HERE. `loot` listens to `combat.onKill`, which fires
 * for every victim kind, so this system never imports it (see `ROADMAP.md`).
 */

import { PLAYER_RADIUS, BLOCK_TILES, blocksToTiles, DIR } from '../../shared/constants.js'
import { MOB_TYPES, MOB_TYPE_IDS, mobIndex } from '../../shared/mobs.js'
import { spellDef } from '../../shared/spells.js'
import { registerBlocker, isTileOccupied } from '../game/state.js'
import { map, canStand, findFreeTile } from '../world/map.js'
import { registerTargetProvider } from './combat.js'
import { castSpell, cooldownLeft } from './spells.js'
import { hasFlag } from './effects.js'

export { MOB_TYPES, MOB_TYPE_IDS }

/**
 * A body's width in tiles — the unit both global mob rules are written in.
 * Every body is `PLAYER_RADIUS` wide, so a mob's width and a player's are the
 * same number and "ten times the character's width" is one constant.
 */
const BODY_TILES = PLAYER_RADIUS * 2 + 1

/**
 * WHICH TYPES THE WORLD CURRENTLY MINTS.
 *
 * A type missing from here never spawns; the rest of the system (caps, timers,
 * AI) is written for all four, so re-enabling one is adding its name back.
 */
const SPAWNABLE_TYPES = ['dragon']

/** Hard population cap PER TYPE. Nothing spawns past its own row. */
const MOB_CAPS = { dragon: 2, bat: 10, golem: 5, skeleton: 5 }

/** Every type refills on its own clock: one attempt per interval while short. */
export const SPAWN_INTERVAL_MS = 10_000

/**
 * Nothing materialises inside a circle of ten body widths around any player,
 * plus the spawning body's own half-width so the footprint does not overlap it
 * either. Measured as a real radius, not a box: the rule is a circle.
 */
const SPAWN_CLEAR_TILES = BODY_TILES * 10 + PLAYER_RADIUS

/** How many random picks the spawner tries before giving up for this interval. */
const SPAWN_TRIES = 12

/** A player inside this radius becomes the mob's target. Ten body widths. */
const AGGRO_TILES = BODY_TILES * 10

/** A mob keeps chasing this long after its target leaves the aggro radius. */
const CHASE_GRACE_MS = 3000

/** Idle routine: walk a random direction, stand still, repeat. */
const WANDER_WALK_MS = 3000
const WANDER_PAUSE_MS = 2000

/** Randomised think interval, so the population does not think in lockstep. */
const THINK_MIN_MS = 200
const THINK_MAX_MS = 400

/** After this many blocked steps a mob sidesteps instead of shoving the wall. */
const UNSTICK_AFTER = 3

/** How long a `hitAndRun` mob backs off after landing its ability. */
const RETREAT_MS = 2600

/** Centre distance at which two bodies are touching: nothing closes past it. */
const CONTACT_TILES = PLAYER_RADIUS * 2 + 1

/** A corpse is gone on the next tick; it lives only long enough to pay out. */
const CORPSE_MS = 0

/** Everyone is hostile to everyone, and every monster is on one side of that. */
const MOB_TEAM = 'monsters'

/** Total population cap, the sum of the per-type rows. */
export const MAX_MOBS = Object.values(MOB_CAPS).reduce((sum, n) => sum + n, 0)

/** @type {Map<number, Object>} live mobs, by id. The single writer is this file. */
const mobs = new Map()

export default {
  id: 'npc',
  enabled: true,

  init(ctx) {
    // One refill clock per type, so a missing dragon does not wait behind bats.
    ctx.world.ext.npc = { mobs, nextId: 1, nextSpawnAt: new Map(), cap: MAX_MOBS }

    // Mobs occupy tiles like players do, so nothing walks through a golem.
    registerBlocker((x, y, exceptId) => mobAt(x, y, exceptId) !== null)
    // ...and can be hit like players are, without `combat` importing this file.
    registerTargetProvider(NPC_PROVIDER)

    ctx.log(`npc ready: spawning ${SPAWNABLE_TYPES.join(', ')} every ${SPAWN_INTERVAL_MS} ms, up to ${MAX_MOBS} mobs`)
  },

  onTick(ctx, dtMs) {
    const now = Date.now()

    sweepCorpses(ctx, now)
    trySpawn(ctx, now)

    for (const mob of mobs.values()) {
      if (mob.hp <= 0) continue
      if (now >= mob.nextThinkAt) think(ctx, mob, now)
      if (now >= mob.nextMoveAt) step(ctx, mob, now)
    }
  },

  /** Terse: `{ m: [[id, typeIdx, x, y, dir, hp, maxHp], ...] }`. */
  collectSnapshot(ctx) {
    if (mobs.size === 0) return undefined

    const m = []
    for (const mob of mobs.values()) {
      if (mob.hp <= 0) continue
      m.push([mob.id, mob.typeIdx, mob.x, mob.y, mob.dir, mob.hp, mob.maxHp])
    }
    return m.length > 0 ? { m } : undefined
  },

  handlers: {},
}

/* ---------- the mob provider ---------- */

/**
 * Mobs seen through the same handle as everything else, so a spell never asks
 * whether it is hitting a player or a dragon.
 *
 * `all()` is the optional fast path `combat.refsNear` looks for: without it an
 * area query scans its whole box tile by tile through `at()`.
 *
 * @type {import('./combat.js').TargetProvider}
 */
const NPC_PROVIDER = {
  id: 'npc',
  at: (x, y) => mobAt(x, y),
  byId: (id) => mobById(id),
  all: () => mobs.values(),
  posOf: (ref) => ({ x: ref.x, y: ref.y }),
  isAlive: (ref) => ref.hp > 0,
  kindOf: (ref) => ({ kind: 'npc', type: ref.type }),
  // Real teams later means returning something else here and nothing changes.
  teamOf: () => MOB_TEAM,
  statsFor: (ref) => ref.stats,

  /** The single writer of a mob's hp. Nothing else in the repo may do this. */
  applyDamage(ctx, ref, amount) {
    const before = ref.hp
    ref.hp = Math.max(0, ref.hp - amount)
    // Death itself is confirmed by `combat`; this only remembers when the body
    // may be swept, so `onKill` listeners still find it where it fell.
    if (ref.hp === 0) ref.removeAt = Date.now() + CORPSE_MS
    return before - ref.hp
  },

  applyHeal(ctx, ref, amount) {
    const before = ref.hp
    ref.hp = Math.min(ref.maxHp, ref.hp + amount)
    return ref.hp - before
  },
}

/* ---------- API for other systems ---------- */

/**
 * The living mob whose body covers a tile, or null.
 *
 * A body is `PLAYER_RADIUS` wide, exactly like a player's: on the fine grid a
 * single-tile test would let two monsters stand inside each other.
 *
 * @param {number} x
 * @param {number} y
 * @param {number|string|null} [exceptId]  ignore this mob, for its own step test
 * @returns {Object|null}
 */
export function mobAt(x, y, exceptId = null) {
  for (const mob of mobs.values()) {
    if (mob.hp <= 0 || mob.id === exceptId) continue
    if (Math.abs(mob.x - x) <= PLAYER_RADIUS && Math.abs(mob.y - y) <= PLAYER_RADIUS) return mob
  }
  return null
}

/** @returns {Object|null} */
export function mobById(id) {
  const mob = mobs.get(Number(id))
  return mob && mob.hp > 0 ? mob : null
}

/** Every living mob. Read-only — mob hp has exactly one writer, this system. */
export function allMobs() {
  return [...mobs.values()].filter((mob) => mob.hp > 0)
}

/* ---------- spawning ---------- */

/**
 * One refill pass per type, each on its own `SPAWN_INTERVAL_MS` clock.
 *
 * The clock advances whether or not the attempt lands, so a type that is at its
 * cap — or whose picks all fell inside a player's circle — simply waits out the
 * next interval rather than retrying every tick.
 */
function trySpawn(ctx, now) {
  const state = ctx.world.ext.npc

  for (const type of SPAWNABLE_TYPES) {
    if (now < (state.nextSpawnAt.get(type) ?? 0)) continue
    state.nextSpawnAt.set(type, now + SPAWN_INTERVAL_MS)
    if (countOfType(type) >= (MOB_CAPS[type] ?? 0)) continue

    const spot = pickSpawnSpot(ctx)
    if (spot) spawnMob(ctx, type, spot.x, spot.y)
  }
}

function countOfType(type) {
  let count = 0
  for (const mob of mobs.values()) {
    if (mob.hp > 0 && mob.type === type) count++
  }
  return count
}

/**
 * A random walkable spot outside every player's exclusion circle.
 *
 * Rejection sampling rather than a scan: the map is mostly open, so a handful
 * of picks finds a spot, and the interval simply skips when they all fail —
 * which is the correct behaviour when the players happen to cover the map.
 */
function pickSpawnSpot(ctx) {
  for (let attempt = 0; attempt < SPAWN_TRIES; attempt++) {
    const x = 1 + Math.floor(Math.random() * (map.w - 2))
    const y = 1 + Math.floor(Math.random() * (map.h - 2))
    if (!canStand(x, y) || isTileOccupied(x, y)) continue
    if (nearestPlayerDist(ctx, x, y) < SPAWN_CLEAR_TILES) continue
    return { x, y }
  }
  return null
}

/** Euclidean, because the exclusion zone is a circle rather than a box. */
function nearestPlayerDist(ctx, x, y) {
  let best = Infinity
  for (const player of ctx.world.players.values()) {
    if (player.dead) continue
    best = Math.min(best, Math.hypot(player.x - x, player.y - y))
  }
  return best
}

function spawnMob(ctx, type, x, y) {
  const def = MOB_TYPES[type]
  if (!def) return null

  const state = ctx.world.ext.npc
  const now = Date.now()
  const mob = {
    id: state.nextId++,
    type,
    typeIdx: mobIndex(type),
    x,
    y,
    dir: DIR.DOWN,
    hp: def.hp,
    maxHp: def.hp,
    /** Same [0, ATTR_MAX] scale players use, which is what lets a mob cast. */
    attrs: { ...def.attrs },
    stats: { ...def.stats },
    spells: def.spells,
    behaviour: def.behaviour,
    /** Per-tile cadence: `moveMs` is authored per BLOCK. */
    stepMs: Math.max(1, Math.round(def.moveMs / BLOCK_TILES)),
    /** One global rule now, not a per-type row: ten body widths. */
    aggroTiles: AGGRO_TILES,
    /** spellId -> timestamp, the shape `spells.castSpell` expects. */
    cdUntil: new Map(),
    targetId: null,
    /** When the current target stops counting, after it left the aggro circle. */
    loseTargetAt: 0,
    retreatUntil: 0,
    blockedSteps: 0,
    /** Idle routine: a heading, and when the current walk/pause phase ends. */
    wanderDir: randomSidestep(),
    wanderWalking: true,
    wanderUntil: now + WANDER_WALK_MS,
    nextThinkAt: now + thinkDelay(),
    nextMoveAt: now,
    removeAt: 0,
    /** Effects hang here, exactly like a player's — see `effects.js`. */
    ext: Object.create(null),
  }

  mobs.set(mob.id, mob)
  return mob
}

/** Corpses leave once `combat` has confirmed the kill and paid it out. */
function sweepCorpses(ctx, now) {
  for (const [id, mob] of mobs) {
    if (mob.hp <= 0 && now >= mob.removeAt) mobs.delete(id)
  }
}

function thinkDelay() {
  return THINK_MIN_MS + Math.random() * (THINK_MAX_MS - THINK_MIN_MS)
}

/* ---------- AI ---------- */

/**
 * One think: pick a target, face it, and cast the first ability that reaches.
 * Movement is not decided here — it runs on the mob's own step cadence.
 */
function think(ctx, mob, now) {
  mob.nextThinkAt = now + thinkDelay()

  const target = updateTarget(ctx, mob, now)
  if (!target) return

  mob.dir = dirToward(mob, target)

  // A retreating bat is not looking for another opening yet.
  if (now < mob.retreatUntil) return
  if (hasFlag(mob, 'silenced')) return

  if (castFirstReady(ctx, mob, target) && mob.behaviour === 'hitAndRun') {
    // It approached, it bit, it leaves. Its damage is in the DoT, so a bat that
    // never fights again has already done its whole job.
    mob.retreatUntil = now + RETREAT_MS
  }
}

/**
 * Who the mob is chasing this think, and for how much longer.
 *
 * Losing sight is not losing the target: once the player leaves the circle the
 * mob keeps coming for `CHASE_GRACE_MS`, so stepping one tile out of range is
 * not an escape. Re-entering the circle clears the countdown.
 */
function updateTarget(ctx, mob, now) {
  const found = acquireTarget(ctx, mob)
  if (found) {
    mob.targetId = found.id
    mob.loseTargetAt = 0
    return found
  }

  const current = mob.targetId ? ctx.world.players.get(mob.targetId) : null
  if (!current || current.dead) return dropTarget(mob)

  if (mob.loseTargetAt === 0) mob.loseTargetAt = now + CHASE_GRACE_MS
  return now >= mob.loseTargetAt ? dropTarget(mob) : current
}

/** Back to the idle routine, starting on a fresh walk phase. */
function dropTarget(mob) {
  mob.targetId = null
  mob.loseTargetAt = 0
  mob.wanderWalking = false
  mob.wanderUntil = 0
  return null
}

/** Nearest living player inside `aggro`, or null. */
function acquireTarget(ctx, mob) {
  let best = null
  let bestDist = Infinity

  for (const player of ctx.world.players.values()) {
    if (player.dead) continue
    // A circle, like the spawn exclusion zone — not the box `chebyshev` gives.
    const dist = Math.hypot(mob.x - player.x, mob.y - player.y)
    if (dist > mob.aggroTiles || dist >= bestDist) continue
    best = player
    bestDist = dist
  }
  return best
}

/**
 * The first ability that is off cooldown and whose range covers the target.
 *
 * Range is compared with a body's worth of slack, the same question every area
 * effect asks: a melee reach of one block is four tiles, and two touching
 * bodies are five tiles apart centre to centre, so a bare comparison would mean
 * nothing in this game ever reaches anything.
 *
 * @returns {boolean} whether something was actually cast
 */
function castFirstReady(ctx, mob, target) {
  const caster = casterFromMob(mob)

  for (const spellId of mob.spells) {
    const def = spellDef(spellId)
    if (!def) continue
    if (cooldownLeft(caster, spellId) > 0) continue

    const reach = blocksToTiles(def.range) + PLAYER_RADIUS
    // A self-centred ability (Tail Sweep) reaches its own radius instead.
    const bound = def.range > 0 ? reach : blocksToTiles(def.radius ?? 0) + PLAYER_RADIUS
    if (chebyshev(mob, target) > bound) continue

    if (castSpell(ctx, caster, spellId, { tx: target.x, ty: target.y, dir: mob.dir })) return true
  }
  return false
}

/**
 * The caster handle shape `spells` expects. A mob wears exactly what a player
 * wears, which is why a dragon's fireball is not a second implementation.
 */
function casterFromMob(mob) {
  return {
    providerId: 'npc',
    ref: mob,
    x: mob.x,
    y: mob.y,
    dir: mob.dir,
    team: MOB_TEAM,
    stats: mob.stats,
    attrs: mob.attrs,
    cdUntil: mob.cdUntil,
  }
}

/* ---------- movement ---------- */

/**
 * One greedy tile step. Dominant axis first, the other as a fallback, and a
 * random sidestep once the mob has been blocked `UNSTICK_AFTER` times — which
 * is what walks it around a tree without any pathfinding at all.
 */
function step(ctx, mob, now) {
  mob.nextMoveAt = now + mob.stepMs
  if (hasFlag(mob, 'rooted')) return

  const target = mob.targetId ? ctx.world.players.get(mob.targetId) : null
  if (!target || target.dead) return wander(ctx, mob, now)

  const retreating = now < mob.retreatUntil
  const dist = chebyshev(mob, target)

  // A brawler closes and stays there; anything else would jitter on the spot.
  if (!retreating && dist <= CONTACT_TILES) return
  // A retreating mob stops backing off once it is out of the fight.
  if (retreating && dist >= mob.aggroTiles) return

  const sign = retreating ? -1 : 1
  const dx = Math.sign(target.x - mob.x) * sign
  const dy = Math.sign(target.y - mob.y) * sign
  const horizontal = Math.abs(target.x - mob.x) >= Math.abs(target.y - mob.y)

  const options = horizontal
    ? [{ x: dx, y: 0 }, { x: 0, y: dy }]
    : [{ x: 0, y: dy }, { x: dx, y: 0 }]

  if (mob.blockedSteps >= UNSTICK_AFTER) options.push(randomSidestep())

  for (const option of options) {
    if (option.x === 0 && option.y === 0) continue
    if (!moveTo(ctx, mob, mob.x + option.x, mob.y + option.y)) continue
    mob.blockedSteps = 0
    return
  }
  mob.blockedSteps += 1
}

/**
 * The idle routine: three seconds walking a random heading at HALF speed, two
 * seconds standing still, alternating forever until something aggros it.
 *
 * Half speed is a doubled step interval rather than a fraction of a tile —
 * positions are integers, so the only place slowness can live is the cadence.
 * A blocked step turns instead of retrying the wall, which is what keeps a
 * wandering mob from grinding against terrain for the rest of its phase.
 */
function wander(ctx, mob, now) {
  if (now >= mob.wanderUntil) {
    mob.wanderWalking = !mob.wanderWalking
    mob.wanderUntil = now + (mob.wanderWalking ? WANDER_WALK_MS : WANDER_PAUSE_MS)
    if (mob.wanderWalking) mob.wanderDir = randomSidestep()
  }

  if (!mob.wanderWalking) return

  mob.nextMoveAt = now + mob.stepMs * 2
  if (!moveTo(ctx, mob, mob.x + mob.wanderDir.x, mob.y + mob.wanderDir.y)) {
    mob.wanderDir = randomSidestep()
  }
}

function moveTo(ctx, mob, x, y) {
  if (!canStand(x, y)) return false
  if (isTileOccupied(x, y, mob.id)) return false

  mob.dir = dirOf(x - mob.x, y - mob.y, mob.dir)
  mob.x = x
  mob.y = y
  return true
}

function randomSidestep() {
  const options = [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }]
  return options[Math.floor(Math.random() * options.length)]
}

/* ---------- helpers ---------- */

function chebyshev(a, b) {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y))
}

function dirToward(mob, target) {
  return dirOf(target.x - mob.x, target.y - mob.y, mob.dir)
}

function dirOf(dx, dy, fallback) {
  if (dx === 0 && dy === 0) return fallback
  if (Math.abs(dx) >= Math.abs(dy)) return dx > 0 ? DIR.RIGHT : DIR.LEFT
  return dy > 0 ? DIR.DOWN : DIR.UP
}

/**
 * Somewhere a body fits near a point. Kept for callers that want to place a mob
 * deliberately — the spawner rolls its own spot instead, so a failed roll costs
 * nothing rather than dragging the monster to the nearest legal tile.
 */
export function freeSpotNear(x, y) {
  return findFreeTile(x, y, (tx, ty) => isTileOccupied(tx, ty))
}
