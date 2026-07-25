/**
 * Client bootstrap.
 *
 * Flow: login -> connect -> WELCOME -> draw map -> start systems -> frame loop.
 * Adding a feature never requires touching this file: use client/src/systems/.
 */

import { S2C, C2S } from '@shared/protocol.js'
import { net } from './net.js'
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

const { app, layers } = await createStage(document.getElementById('game'))

/** Context handed to every client system. */
const ctx = {
  app,
  layers,
  state,
  net,
  chat,
  hud,
  input,
  self,
}

document.getElementById('login-form').addEventListener('submit', (e) => {
  e.preventDefault()
  const name = document.getElementById('login-name').value.trim()
  const cls = document.getElementById('login-class').value
  connect(name, cls)
})

function connect(name, cls) {
  net.connect()

  net.on('connect', () => net.send(C2S.JOIN, { name, cls }))
  net.on('connect_error', () =>
    chat.log('No server on :3000 — run <b>npm run dev</b>.', 'err'),
  )

  net.on(S2C.WELCOME, (welcome) => {
    state.selfId = welcome.selfId
    state.map = welcome.map
    state.systems = welcome.systems

    document.getElementById('login').classList.add('hidden')
    drawTilemap(layers.ground, welcome.map)
    hud.mount()
    chat.mount()
    input.start()
    initSystems(ctx)

    chat.log('WASD to move · Enter to chat.', 'system')

    startPing()
    app.ticker.add(onFrame)
  })

  net.on(S2C.SNAPSHOT, (snapshot) => {
    applySnapshot(snapshot)
    invokeClient('onSnapshot', ctx, snapshot)
  })

  net.on(S2C.CHAT_MSG, (msg) => chat.message(msg))
  net.on(S2C.ERROR, (err) => chat.log(`⚠ ${err.message}`, 'err'))
  net.on('disconnect', () => chat.log('Connection lost.', 'err'))
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
