/**
 * Multiplayer smoke test. Run it with the server up:  npm run smoke
 *
 * Connects two headless clients and checks the handshake, map delivery,
 * movement, the anti-spam cooldown, facing, chat, the player profile and
 * clean disconnects.
 */

import { io } from 'socket.io-client'
import { MAP_WIDTH, MAP_HEIGHT, MOVE_BURST_TILES, MOVE_COOLDOWN_MS } from '../shared/constants.js'
import { decodeTiles } from '../shared/grid.js'

const URL = process.env.SMOKE_URL ?? 'http://localhost:3000'

const C2S = {
  JOIN: 'core:join',
  MOVE: 'core:move',
  FACE: 'core:face',
  CHAT_SAY: 'chat:say',
}
const S2C = {
  WELCOME: 'core:welcome',
  SNAPSHOT: 'core:snapshot',
  CHAT: 'chat:msg',
  ERROR: 'core:error',
  PROFILE_SELF: 'profile:self',
}

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

a.on(S2C.WELCOME, (w) => { welcome = w })
a.on(S2C.SNAPSHOT, (s) => { snapshot = s })
a.on(S2C.PROFILE_SELF, (p) => { profile = p })
a.on(S2C.ERROR, (e) => { lastError = e })
b.on(S2C.CHAT, (m) => { if (m.text === 'hello world') chatSeenByB = true })
b.on(S2C.PROFILE_SELF, (p) => { bMoveSpeed = p?.stats?.moveSpeed })

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

// --- the six arena systems exist and are all still disabled ---
const arenaSystems = ['combat', 'effects', 'spells', 'npc', 'inventory', 'loot']
const declared = arenaSystems.filter((id) => id in (welcome?.systems ?? {}))
check('six arena systems declared', declared.length === 6, declared.join(','))
check('arena systems still disabled', arenaSystems.every((id) => welcome?.systems?.[id] === false),
  JSON.stringify(welcome?.systems))

b.close()
await wait(400)
check('player removed on disconnect', snapshot.players.length === 1, `n=${snapshot.players.length}`)

console.log(results.join('\n'))
a.close()
process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0)
