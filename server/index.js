/**
 * Server entrypoint.
 *
 *   npm run dev    server (3000) + Vite client (5173)
 *   npm start      server only, serving /dist when a production build exists
 */

import http from 'node:http'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import express from 'express'
import { Server } from 'socket.io'

import { createContext } from './game/context.js'
import { attachConnectionHandlers } from './net/connection.js'
import { startLoop } from './game/loop.js'
import { invoke, systems } from './systems/index.js'
import { TICK_RATE } from '../shared/constants.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const PORT = Number(process.env.PORT) || 3000

const app = express()

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    uptime: process.uptime(),
    systems: Object.fromEntries(systems.map((s) => [s.id, s.enabled])),
  })
})

// Production build is served by the server; in dev Vite serves the client.
const distDir = path.join(ROOT, 'dist')
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir))
  app.get('*', (_req, res) => res.sendFile(path.join(distDir, 'index.html')))
}

const server = http.createServer(app)
const io = new Server(server, {
  cors: { origin: true, credentials: true },
})

const ctx = createContext(io)

invoke('init', ctx)
attachConnectionHandlers(io, ctx)
startLoop(ctx)

server.listen(PORT, () => {
  const on = systems.filter((s) => s.enabled).map((s) => s.id)
  const off = systems.filter((s) => !s.enabled).map((s) => s.id)
  console.log(`\n  server   http://localhost:${PORT}  (${TICK_RATE} ticks/s)`)
  console.log(`  enabled  ${on.join(', ') || '(none)'}`)
  console.log(`  disabled ${off.join(', ') || '(none)'}`)
  console.log(`  client   http://localhost:5173\n`)
})
