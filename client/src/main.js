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
import { state, applySnapshot, setMap, self } from './state.js'
import { createStage } from './render/stage.js'
import { drawTilemap } from './render/tilemap.js'
import { syncEntities } from './render/entities.js'
import { updateCamera } from './render/camera.js'
import { input } from './input.js'
import { movement } from './movement.js'
import { viewport } from './viewport.js'
import { hud } from './ui/hud.js'
import { chat } from './ui/chat.js'
import { touch, action } from './ui/touch.js'
import { initSystems, invokeClient } from './systems/index.js'

const PING_INTERVAL_MS = 2000

// Device class and the sizing CSS variables must exist before anything paints.
viewport.mount()

const loginEl = document.getElementById('login')
const formEl = document.getElementById('login-form')
const errorEl = document.getElementById('login-error')
const submitEl = formEl.querySelector('button[type="submit"]')

/** Renderer init runs in the background; the form works from the first frame. */
let app = null
let layers = null
/** Context handed to every client system. Filled in once the stage is ready. */
let ctx = null
/** Guards the one-time bootstrap: WELCOME arrives again on every reconnect. */
let worldStarted = false

const stageReady = createStage(document.getElementById('game'))
  .then((stage) => {
    app = stage.app
    layers = stage.layers
    ctx = { app, layers, state, net, chat, hud, input, self, movement, viewport, touch, action }
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
  // Fullscreen and the orientation lock are only granted inside a gesture.
  viewport.requestLandscape()
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
    state.systems = welcome.systems
    // A reconnect hands out a new player whose input sequence starts at zero.
    movement.reset()

    let map
    try {
      map = setMap(welcome.map) // run-length encoded on the wire
    } catch (err) {
      submitEl.disabled = false // the login panel is still up: let them retry
      return showError(`The server sent a map this client cannot read: ${err.message}`)
    }

    try {
      await stageReady
    } catch {
      return // the renderer failed; the error is already on screen
    }

    loginEl.classList.add('hidden')
    drawTilemap(layers.ground, map)

    // Everything below binds listeners or timers exactly once. A reconnect
    // delivers a fresh WELCOME with a new player id, and re-running this
    // would duplicate input handlers, chat handlers and the frame loop.
    if (worldStarted) {
      chat.log('Reconnected.', 'system')
      return
    }
    worldStarted = true

    hud.mount()
    chat.mount()
    input.start()
    touch.mount() // before the systems, so their action buttons find the rail
    initSystems(ctx)

    chat.log(
      viewport.isTouch
        ? 'Drag the left side of the screen to move · 💬 to talk.'
        : 'WASD to move · Enter to chat.',
      'system',
    )

    startPing()
    app.ticker.add(onFrame)
  })

  socket.on(S2C.SNAPSHOT, (snapshot) => {
    applySnapshot(snapshot)
    // Before the systems see it: they read the local player's position, and it
    // is only correct once the unacknowledged steps have been replayed.
    movement.reconcile()
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
  syncEntities(layers.entities, ticker.deltaMS)
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
