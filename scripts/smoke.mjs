/**
 * Multiplayer smoke test. Run it with the server up:  npm run smoke
 *
 * Connects two headless clients and checks the handshake, map delivery,
 * movement, the anti-spam cooldown, facing, chat and clean disconnects.
 */

import { io } from 'socket.io-client'

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

a.on('connect', () => a.emit(C2S.JOIN, { name: 'Alice', cls: 'warrior' }))
b.on('connect', () => b.emit(C2S.JOIN, { name: 'Bob', cls: 'mage' }))

a.on(S2C.WELCOME, (w) => { welcome = w })
a.on(S2C.SNAPSHOT, (s) => { snapshot = s })
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

b.close()
await wait(400)
check('player removed on disconnect', snapshot.players.length === 1, `n=${snapshot.players.length}`)

console.log(results.join('\n'))
a.close()
process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0)
