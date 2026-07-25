/**
 * Client bootstrap.
 *
 * Flow: login -> connect -> WELCOME -> draw map -> start systems -> frame loop.
 * Adding a feature never requires touching this file: use client/src/systems/.
 *
 * The login handler is registered synchronously, before the renderer finishes
 * initialising. Otherwise a slow or failing init would let the browser submit
 * the form natively and reload the page.
 */

import { S2C, C2S } from '@shared/protocol.js'
import { net, SERVER_URL } from './net.js'
import { state, applySnapshot, self } from './state.js'
import { createStage } from './render/stage.js'
import { drawTilemap } from './render/tilemap.js'
import { syncEntities } from './render/entities.js'
import { updateCamera } from './render/camera.js'
import { input } from './input.js'
import { hud } from './ui/hud.js'
import { chat } from './ui/chat.js'
import { initSystems, invokeClient } from './systems/index.js'

const PING_INTERVAL_MS = 2000

const loginEl = document.getElementById('login')
const formEl = document.getElementById('login-form')
const errorEl = document.getElementById('login-error')
const submitEl = formEl.querySelector('button[type="submit"]')

/** Renderer init runs in the background; the form works from the first frame. */
let app = null
let layers = null
/** Context handed to every client system. Filled in once the stage is ready. */
let ctx = null

const stageReady = createStage(document.getElementById('game'))
  .then((stage) => {
    app = stage.app
    layers = stage.layers
    ctx = { app, layers, state, net, chat, hud, input, self }
    return stage
  })
  .catch((err) => {
    showError(`Could not start the renderer: ${err?.message ?? err}`)
    throw err
  })

formEl.addEventListener('submit', (e) => {
  e.preventDefault() // never let the browser navigate away
  clearError()
  submitEl.disabled = true
  connect(
    document.getElementById('login-name').value.trim(),
    document.getElementById('login-class').value,
  )
})

function connect(name, cls) {
  const socket = net.connect()

  socket.on('connect', () => net.send(C2S.JOIN, { name, cls }))

  socket.on('connect_error', (err) => {
    submitEl.disabled = false
    showError(`Cannot reach the game server at ${SERVER_URL} (${err.message}).`)
  })

  socket.on(S2C.WELCOME, async (welcome) => {
    state.selfId = welcome.selfId
    state.map = welcome.map
    state.systems = welcome.systems

    try {
      await stageReady
    } catch {
      return // the renderer failed; the error is already on screen
    }

    loginEl.classList.add('hidden')
    drawTilemap(layers.ground, welcome.map)
    hud.mount()
    chat.mount()
    input.start()
    initSystems(ctx)

    chat.log('WASD to move · Enter to chat.', 'system')

    startPing()
    app.ticker.add(onFrame)
  })

  socket.on(S2C.SNAPSHOT, (snapshot) => {
    applySnapshot(snapshot)
    if (ctx) invokeClient('onSnapshot', ctx, snapshot)
  })

  socket.on(S2C.CHAT_MSG, (msg) => chat.message(msg))
  socket.on(S2C.ERROR, (err) => chat.log(`⚠ ${err.message}`, 'err'))
  socket.on('disconnect', (reason) => {
    chat.log(`Connection lost (${reason}).`, 'err')
  })
}

function onFrame(ticker) {
  input.update()
  syncEntities(layers.entities)
  updateCamera(app, layers.camera)
  hud.update()
  invokeClient('onUpdate', ctx, ticker.deltaMS)
}

function startPing() {
  net.on(S2C.PONG, (payload) => {
    net.latency = Math.round(performance.now() - payload.t)
  })
  setInterval(() => net.send(C2S.PING, { t: performance.now() }), PING_INTERVAL_MS)
}

/** Errors before the world loads must be visible on the login panel. */
function showError(message) {
  errorEl.textContent = message
  errorEl.classList.remove('hidden')
  console.error('[client]', message)
}

function clearError() {
  errorEl.textContent = ''
  errorEl.classList.add('hidden')
}
