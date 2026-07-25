/**
 * Multiplayer smoke test. Run it with the server up:  npm run smoke
 *
 * Connects two headless clients and checks the handshake, map delivery,
 * movement, the anti-spam cooldown, facing, chat, the player profile and
 * clean disconnects.
 */

import { io } from 'socket.io-client'

const URL = process.env.SMOKE_URL ?? 'http://localhost:3000'

const C2S = {
  JOIN: 'core:join',
  MOVE: 'core:move',
  FACE: 'core:face',
  CHAT_SAY: 'chat:say',
  PROFILE_SPEND_POINT: 'profile:spendPoint',
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

a.on('connect', () => a.emit(C2S.JOIN, { name: 'Alice', cls: 'warrior' }))
b.on('connect', () => b.emit(C2S.JOIN, { name: 'Bob', cls: 'hunter' }))

a.on(S2C.WELCOME, (w) => { welcome = w })
a.on(S2C.SNAPSHOT, (s) => { snapshot = s })
a.on(S2C.PROFILE_SELF, (p) => { profile = p })
a.on(S2C.ERROR, (e) => { lastError = e })
b.on(S2C.CHAT, (m) => { if (m.text === 'hello world') chatSeenByB = true })

await wait(1000)

const selfOf = () => snapshot.players.find((p) => p.id === welcome.selfId)

check('welcome received', !!welcome)
check('map delivered', welcome?.map?.tiles?.length === 64 * 48, `len=${welcome?.map?.tiles?.length}`)
check('system flags present', welcome?.systems?.core === true)
check('two players in snapshot', snapshot?.players?.length === 2, `n=${snapshot?.players?.length}`)

const before = selfOf()
for (let i = 0; i < 5; i++) {
  a.emit(C2S.MOVE, { dir: 2 }) // right
  await wait(180)
}
await wait(200)
const after = selfOf()
check('movement applied', after.x > before.x, `${before.x},${before.y} -> ${after.x},${after.y}`)

const preSpam = { ...after }
for (let i = 0; i < 20; i++) a.emit(C2S.MOVE, { dir: 1 }) // spam left
await wait(250)
const postSpam = selfOf()
check('move cooldown enforced', Math.abs(postSpam.x - preSpam.x) <= 1, `dx=${postSpam.x - preSpam.x}`)

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

// --- arena foundation: no mana, intelligence lands on spellPower and cdr ---
check('mana is gone from the derived stats', profile?.stats?.maxMana === undefined,
  JSON.stringify(profile?.stats))
check('spellPower derived', typeof profile?.stats?.spellPower === 'number',
  `spellPower=${profile?.stats?.spellPower}`)
check('cdr derived and capped', profile?.stats?.cdr >= 0 && profile?.stats?.cdr <= 45,
  `cdr=${profile?.stats?.cdr}`)

// Attributes now follow the class curve, so nobody has points to spend.
check('no attribute points to spend', profile?.profile?.points === 0,
  `points=${profile?.profile?.points}`)

lastError = null
a.emit(C2S.PROFILE_SPEND_POINT, { attr: 'con' })
await wait(250)
check('manual point spending refused', lastError?.code === 'BAD_PAYLOAD', JSON.stringify(lastError))

lastError = null
a.emit(C2S.PROFILE_SPEND_POINT, { attr: 'nonsense' })
await wait(200)
check('unknown attribute rejected', lastError?.code === 'BAD_PAYLOAD', JSON.stringify(lastError))

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
