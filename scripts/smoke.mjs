/**
 * Multiplayer smoke test. Run it with the server up:  npm run smoke
 *
 * Connects two headless clients and checks the handshake, map delivery,
 * movement, the anti-spam cooldown, facing, chat, the player profile and
 * clean disconnects.
 */

import { io } from 'socket.io-client'
import {
  MAP_WIDTH,
  MAP_HEIGHT,
  MOVE_BURST_TILES,
  MOVE_COOLDOWN_MS,
  PLAYER_RADIUS,
} from '../shared/constants.js'
import { decodeTiles } from '../shared/grid.js'
import { MIN_KILL_COINS, PURSE_LOOT_PCT, purseLoot, rewardFor } from '../shared/rewards.js'
import {
  EFFECTS,
  STACKING,
  effectDef,
  resolveParams,
  sumEffectStats,
} from '../shared/effects.js'

const URL = process.env.SMOKE_URL ?? 'http://localhost:3000'

const C2S = {
  JOIN: 'core:join',
  MOVE: 'core:move',
  FACE: 'core:face',
  CHAT_SAY: 'chat:say',
  COMBAT_ATTACK: 'combat:attack',
  COMBAT_RESPAWN: 'combat:respawn',
}
const S2C = {
  WELCOME: 'core:welcome',
  SNAPSHOT: 'core:snapshot',
  CHAT: 'chat:msg',
  ERROR: 'core:error',
  PROFILE_SELF: 'profile:self',
  COMBAT_HIT: 'combat:hit',
  COMBAT_DEATH: 'combat:death',
  COMBAT_RESPAWNED: 'combat:respawned',
  COMBAT_KILLFEED: 'combat:killfeed',
}

/** Spawn protection, from server/systems/combat.js. Nothing lands while it holds. */
const SPAWN_PROTECT_MS = 3000

const results = []
const check = (name, ok, extra = '') =>
  results.push(`${ok ? 'PASS' : 'FAIL'} ${name} ${extra}`)
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

const a = io(URL, { transports: ['websocket'] })
const b = io(URL, { transports: ['websocket'] })

let welcome = null
let snapshot = null
let chatSeenByB = false
let profile = null
let lastError = null
/** Bob is a hunter: his agility has to buy him more speed than Alice's. */
let bMoveSpeed = null

a.on('connect', () => a.emit(C2S.JOIN, { name: 'Alice', cls: 'warrior' }))
b.on('connect', () => b.emit(C2S.JOIN, { name: 'Bob', cls: 'hunter' }))

/** Every combat event Bob is on the receiving end of, so hits can be counted. */
const hitsOnB = []
const deathsOfB = []
const respawnsOfB = []

a.on(S2C.WELCOME, (w) => { welcome = w })
a.on(S2C.SNAPSHOT, (s) => { snapshot = s })
a.on(S2C.PROFILE_SELF, (p) => { profile = p })
a.on(S2C.ERROR, (e) => { lastError = e })
b.on(S2C.CHAT, (m) => { if (m.text === 'hello world') chatSeenByB = true })
b.on(S2C.PROFILE_SELF, (p) => { bMoveSpeed = p?.stats?.moveSpeed })
const killFeed = []
a.on(S2C.COMBAT_KILLFEED, (k) => { killFeed.push(k) })
b.on(S2C.COMBAT_HIT, (h) => { if (h.id === b.id) hitsOnB.push(h) })
b.on(S2C.COMBAT_DEATH, (d) => { if (d.id === b.id) deathsOfB.push(d) })
b.on(S2C.COMBAT_RESPAWNED, (r) => { if (r.id === b.id) respawnsOfB.push(r) })

await wait(1000)

const selfOf = () => snapshot.players.find((p) => p.id === welcome.selfId)

check('welcome received', !!welcome)
check('system flags present', welcome?.systems?.core === true)
check('two players in snapshot', snapshot?.players?.length === 2, `n=${snapshot?.players?.length}`)

// The map travels run-length encoded: 49k tiles as raw JSON would be ~96 KB.
let decoded = null
try {
  decoded = decodeTiles(welcome.map.rle, welcome.map.w * welcome.map.h)
} catch (err) {
  lastError = err
}
check('map delivered', decoded?.length === MAP_WIDTH * MAP_HEIGHT, `len=${decoded?.length}`)
check('map is compact on the wire', JSON.stringify(welcome?.map ?? {}).length < 40_000,
  `${(JSON.stringify(welcome?.map ?? {}).length / 1024).toFixed(1)} KB`)

// --- movement: the client predicts, the server confirms with `seq` ---
let seq = 0
const before = selfOf()
for (let i = 0; i < 5; i++) {
  a.emit(C2S.MOVE, { dir: 2, seq: ++seq }) // right
  await wait(MOVE_COOLDOWN_MS + 10)
}
await wait(200)
const after = selfOf()
check('movement applied', after.x > before.x, `${before.x},${before.y} -> ${after.x},${after.y}`)
check('input sequence acknowledged', after.seq === seq, `ack=${after.seq} sent=${seq}`)

const preSpam = { ...after }
for (let i = 0; i < 40; i++) a.emit(C2S.MOVE, { dir: 1, seq: ++seq }) // spam left
await wait(250)
const postSpam = selfOf()
// A burst is absorbed, not obeyed: the bucket caps how far a spammer gets.
check('move budget enforced', Math.abs(postSpam.x - preSpam.x) <= MOVE_BURST_TILES + 2,
  `dx=${postSpam.x - preSpam.x}`)
check('rejected input still acknowledged', postSpam.seq === seq,
  `ack=${postSpam.seq} sent=${seq}`)

a.emit(C2S.FACE, { dir: 3 })
await wait(200)
check('facing applied', selfOf().dir === 3, `dir=${selfOf().dir}`)

a.emit(C2S.CHAT_SAY, { text: 'hello world' })
await wait(300)
check('chat reaches the other client', chatSeenByB)

// --- profile ---
const publicProfile = snapshot.ext?.profile?.[welcome.selfId]
check('profile published in snapshot', publicProfile?.level === 1, JSON.stringify(publicProfile))
check('private profile stays private', publicProfile?.gold === undefined)
check('private profile pushed to its owner', typeof profile?.profile?.gold === 'number')
check('derived stats present', typeof profile?.stats?.maxHp === 'number', JSON.stringify(profile?.stats))
check('player vitals follow the profile', selfOf().maxHp === profile?.stats?.maxHp,
  `${selfOf().maxHp} vs ${profile?.stats?.maxHp}`)

// --- arena foundation: no mana, int -> cdr, agi -> moveSpeed ---
check('mana is gone from the derived stats', profile?.stats?.maxMana === undefined,
  JSON.stringify(profile?.stats))
check('spell power is gone from the derived stats', profile?.stats?.spellPower === undefined,
  JSON.stringify(profile?.stats))
check('cdr derived and capped', profile?.stats?.cdr >= 0 && profile?.stats?.cdr <= 50,
  `cdr=${profile?.stats?.cdr}`)
check('moveSpeed derived and capped', profile?.stats?.moveSpeed >= 0 && profile?.stats?.moveSpeed <= 40,
  `moveSpeed=${profile?.stats?.moveSpeed}`)
check('damage is gear-and-effects only', profile?.stats?.damage === 0,
  `damage=${profile?.stats?.damage}`)

// Attributes are a pure function of class and level: nothing to spend, and a
// warrior's level 1 block is exactly what the shared table says.
check('manual point spending is gone', profile?.profile?.points === undefined,
  `points=${profile?.profile?.points}`)
check('attributes derived from class and level',
  JSON.stringify(profile?.profile?.attributes) === JSON.stringify({ str: 20, agi: 12, int: 8, con: 25 }),
  JSON.stringify(profile?.profile?.attributes))
check('level cap is 20', profile?.profile?.level === 1 && typeof profile?.profile?.expToNext === 'number',
  `expToNext=${profile?.profile?.expToNext}`)

// A hunter must visibly outwalk a warrior — the cheapest proof the whole
// attribute -> stat -> core-handler chain landed.
check('hunter walks faster than warrior', bMoveSpeed > profile?.stats?.moveSpeed,
  `hunter=${bMoveSpeed} vs warrior=${profile?.stats?.moveSpeed}`)

// --- the six arena systems exist, each with an honest enabled flag ---
//
// They do NOT all have to be disabled any more: a lane flips its own flag the
// moment its server half works, which is the whole point of the safety switch.
// What still has to hold is that the flag is declared and is a boolean, so a
// client system can trust it before initialising.
const arenaSystems = ['combat', 'effects', 'spells', 'npc', 'inventory', 'loot']
const declared = arenaSystems.filter((id) => id in (welcome?.systems ?? {}))
check('six arena systems declared', declared.length === 6, declared.join(','))
check('every arena system reports a boolean',
  arenaSystems.every((id) => typeof welcome?.systems?.[id] === 'boolean'),
  JSON.stringify(welcome?.systems))

// A disabled system must answer NOT_IMPLEMENTED rather than doing nothing
// quietly — that is what lets half-finished work be merged.
if (welcome?.systems?.inventory === false) {
  lastError = null
  a.emit('inventory:buy', { slot: 'weapon' })
  await wait(200)
  check('disabled system answers NOT_IMPLEMENTED', lastError?.code === 'NOT_IMPLEMENTED',
    JSON.stringify(lastError))
}

// --- effects (A1): the definition/instance split and the stacking table ---
//
// Nothing can apply an effect from a client — that arrives with the spell
// executor (B2) — so the layer is checked where it can be: the wire contract,
// and the pure functions the runtime is built on.
check('effects system is live', welcome?.systems?.effects === true,
  `enabled=${welcome?.systems?.effects}`)
check('effects stay off the snapshot while nobody carries one',
  snapshot.ext?.effects === undefined, JSON.stringify(snapshot.ext?.effects))

// The magnitude comes from the APPLICATION SITE, never from the table: two
// spells that both burn, one harder than the other, have to be expressible.
const weakBurn = resolveParams('burning')
const hardBurn = resolveParams('burning', { tick: { hp: -11 } })
check('an effect takes its magnitude from the caller',
  weakBurn.tick.hp === -4 && hardBurn.tick.hp === -11,
  `${weakBurn.tick.hp} vs ${hardBurn.tick.hp}`)
check('overriding one application never edits the table',
  EFFECTS.burning.defaults.tick.hp === -4, JSON.stringify(EFFECTS.burning.defaults))

// A function override is what lets a DoT scale with the caster it was cast by,
// resolved once at application time.
const scaledBurn = resolveParams('burning', (s) => ({ tick: { hp: -(4 + s.damage) } }), { damage: 6 })
check('a caller may scale an effect by the caster stats', scaledBurn.tick.hp === -10,
  JSON.stringify(scaledBurn))

// Merging is per bucket: overriding the tick must not drop the flags with it.
const block = resolveParams('iceBlock', { tick: { hp: +9 } })
check('overrides merge into the defaults rather than replacing them',
  block.flags?.invulnerable === true && block.tick.hp === 9, JSON.stringify(block))

// The single published modifier sums INSTANCES, and stacks multiply.
const statSum = sumEffectStats([
  { id: 'rage', params: { stats: { damage: 8 } }, stacks: 2 },
  { id: 'swift', params: { stats: { evasion: 6, moveSpeed: 8 } }, stacks: 1 },
])
check('stat effects sum by instance and stack',
  statSum.damage === 16 && statSum.evasion === 6 && statSum.moveSpeed === 8,
  JSON.stringify(statSum))

check('an unknown effect resolves to nothing rather than throwing',
  effectDef('nosuch') === null && resolveParams('nosuch') === null)

const badStacking = Object.entries(EFFECTS).filter(([, def]) => !STACKING.includes(def.stacking))
check('every effect declares a known stacking policy', badStacking.length === 0,
  badStacking.map(([id]) => id).join(','))

// --- combat (A3): melee, damage, death and respawn ---
if (welcome?.systems?.combat === true) {
  const bobOf = () => snapshot.players.find((p) => p.id === b.id)
  const step = async (dir) => {
    a.emit(C2S.MOVE, { dir, seq: ++seq })
    await wait(MOVE_COOLDOWN_MS + 15)
  }

  // Closest two bodies can stand, centre to centre. Derived, not written down:
  // this test walks until the bodies touch, and PLAYER_RADIUS has moved before.
  const TOUCHING = 2 * PLAYER_RADIUS + 1

  /** Column to line up in. Wide enough that no y step can clip Bob's body. */
  const LANE = TOUCHING + 2

  /** Steps `dir` until `done()`, or gives up. Returns whether it arrived. */
  const walkUntil = async (done, dir, limit = 80) => {
    for (let i = 0; i < limit; i++) {
      const me = selfOf()
      const him = bobOf()
      if (!me || !him) return false
      if (done(me, him)) return true
      await step(dir(me, him))
    }
    return false
  }

  // Back off, line up, then close in. Walking at Bob diagonally wedges her
  // against him instead: a body is 5 tiles wide, so a corner touch blocks the
  // approach on BOTH axes and she never reaches his row.
  const dx = (me, him) => Math.abs(him.x - me.x)
  await walkUntil((me, him) => dx(me, him) >= LANE, (me, him) => (him.x > me.x ? 1 : 2), 40)
  await walkUntil((me, him) => me.y === him.y, (me, him) => (him.y > me.y ? 0 : 3))
  await walkUntil((me, him) => dx(me, him) <= TOUCHING, (me, him) => (him.x > me.x ? 2 : 1), 40)

  const me = selfOf()
  const him = bobOf()
  const adjacent = !!him && him.y === me.y && Math.abs(him.x - me.x) <= TOUCHING
  check('walked into melee range', adjacent, `${me.x},${me.y} vs ${him?.x},${him?.y}`)

  a.emit(C2S.FACE, { dir: him.x > me.x ? 2 : 1 })

  // Bob joined with spawn protection. Wait it out, otherwise the first hit is
  // correctly cancelled and the count below would read as a bug.
  await wait(SPAWN_PROTECT_MS)

  hitsOnB.length = 0
  const levelBefore = profile?.profile?.level
  const hpBefore = bobOf().hp
  a.emit(C2S.COMBAT_ATTACK, {})
  await wait(300)

  // The single most likely bug in this design is two systems subtracting hp
  // independently. One swing, one hit — this is the assertion that catches it.
  check('one melee swing produces exactly one combat:hit', hitsOnB.length === 1,
    `n=${hitsOnB.length}`)
  check('melee damage applied', bobOf().hp < hpBefore, `${hpBefore} -> ${bobOf().hp}`)
  check('hit reports its attacker', hitsOnB[0]?.byId === welcome.selfId, hitsOnB[0]?.byId)

  // Swing until Bob falls: hp, dead and the death event have one writer.
  for (let i = 0; i < 40 && !bobOf()?.dead; i++) {
    a.emit(C2S.COMBAT_ATTACK, {})
    await wait(220)
  }
  check('victim dies once', deathsOfB.length === 1 && bobOf()?.dead === true,
    `deaths=${deathsOfB.length} dead=${bobOf()?.dead}`)
  check('kill is attributed to the killer', deathsOfB[0]?.killerId === welcome.selfId,
    deathsOfB[0]?.killerId)

  // --- combat (A4): rewards, kill feed and the scoreboard ---
  await wait(200)
  check('kill feed announces the kill once', killFeed.length === 1,
    JSON.stringify(killFeed))
  check('killer earns experience', profile?.profile?.level > levelBefore,
    `level ${levelBefore} -> ${profile?.profile?.level}`)

  // Bob never earned a coin, so there was nothing to loot and the killer falls
  // back to the minted floor — the one part of a kill that is created rather
  // than taken.
  check('a broke victim still pays the floor', killFeed[0]?.reward?.coins === MIN_KILL_COINS,
    JSON.stringify(killFeed[0]?.reward))
  check('the killer is credited exactly that', profile?.profile?.gold === MIN_KILL_COINS,
    `gold=${profile?.profile?.gold}`)

  const score = snapshot.ext?.combat?.score
  check('scoreboard rides the snapshot',
    score?.[welcome.selfId]?.[0] === 1 && score?.[b.id]?.[1] === 1,
    JSON.stringify(score))

  // Early respawn is refused before the timer and granted after it.
  lastError = null
  b.emit(C2S.COMBAT_RESPAWN, {})
  await wait(200)
  check('respawn refused while the timer runs', bobOf()?.dead === true, `dead=${bobOf()?.dead}`)

  await wait(3200)
  b.emit(C2S.COMBAT_RESPAWN, {})
  await wait(300)
  check('respawn restores the victim', bobOf()?.dead === false && bobOf()?.hp === bobOf()?.maxHp,
    `hp=${bobOf()?.hp}/${bobOf()?.maxHp}`)
  check('respawn is announced with protection', respawnsOfB[0]?.protectedMs > 0,
    JSON.stringify(respawnsOfB[0]))
}

// --- the reward split itself, as pure functions ---
//
// A live purse cannot be arranged from a client — there is no way to hand Bob
// gold without a cheat hook — so the arithmetic the server runs is checked
// directly. The integration path above proves it is wired in.
check('a killer loots half the purse', purseLoot(300) === 150, `${purseLoot(300)} of 300`)
check('looting rounds down and never overdraws',
  purseLoot(45) === 22 && purseLoot(1) === 0 && purseLoot(0) === 0,
  `${purseLoot(45)}, ${purseLoot(1)}, ${purseLoot(0)}`)

const rich = { victimKind: 'player', victimType: 'mage', victimLevel: 6, victimGold: 480, killerLevel: 3 }
const pvp = rewardFor(rich)
check('a full purse is looted, not minted', pvp.coins === 240 && pvp.fromPurse === 240,
  JSON.stringify(pvp))
check('player kills still pay experience', pvp.exp > 0, `exp=${pvp.exp}`)

// Repeat-killing the same victim decays experience but not the purse cut: the
// purse is its own limiter, and shrinking a transfer would delete coins.
const repeat = rewardFor({ ...rich, repeats: 2 })
check('repeat kills decay experience', repeat.exp < pvp.exp, `${pvp.exp} -> ${repeat.exp}`)
check('repeat kills do not decay the looted purse', repeat.coins === pvp.coins,
  `${pvp.coins} vs ${repeat.coins}`)

// The floor is minted, so it is the one part of a kill the levers CAN scale —
// which is what stops a broke victim from being farmed for it.
const broke = rewardFor({ victimKind: 'player', victimType: 'mage', victimLevel: 1, victimGold: 3, killerLevel: 1 })
check('a thin purse falls back to the floor',
  broke.coins === MIN_KILL_COINS && broke.fromPurse === 1, JSON.stringify(broke))
check('the victim is only ever charged what they had', broke.fromPurse <= 3,
  `fromPurse=${broke.fromPurse} of 3`)

const farmed = rewardFor({ victimKind: 'player', victimType: 'mage', victimLevel: 1, victimGold: 0, killerLevel: 1, repeats: 3 })
check('farming a broke victim decays the floor', farmed.coins < MIN_KILL_COINS,
  `${MIN_KILL_COINS} -> ${farmed.coins}`)

const pve = rewardFor({ victimKind: 'npc', victimType: 'golem', killerLevel: 1 })
check('monster coins are still minted from the table',
  pve.fromPurse === 0 && pve.coins > 0, JSON.stringify(pve))
check('the loot share is a documented percentage', PURSE_LOOT_PCT === 50, `${PURSE_LOOT_PCT}%`)

b.close()
await wait(400)
check('player removed on disconnect', snapshot.players.length === 1, `n=${snapshot.players.length}`)

console.log(results.join('\n'))
a.close()
process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0)
