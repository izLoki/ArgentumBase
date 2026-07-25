/**
 * Client network layer.
 *
 * From a system:
 *   net.send(C2S.MY_EVENT, payload)
 *   net.on(S2C.MY_EVENT, (payload) => { ... })
 */

import { io } from 'socket.io-client'

/**
 * Where the game server lives.
 *
 * Set VITE_SERVER_URL at build time when the client and the server are hosted
 * separately (for example a static client on a CDN and the server on a host
 * that supports WebSockets). Otherwise: same origin in production, :3000 in
 * development.
 */
export const SERVER_URL =
  import.meta.env.VITE_SERVER_URL ??
  (location.port === '5173' ? `http://${location.hostname}:3000` : location.origin)

export const net = {
  /** @type {import('socket.io-client').Socket | null} */
  socket: null,
  latency: 0,

  connect() {
    // Polling is kept as a fallback: some hosts and corporate proxies block a
    // direct WebSocket upgrade.
    this.socket = io(SERVER_URL, { transports: ['websocket', 'polling'] })
    return this.socket
  },

  send(event, payload) {
    this.socket?.emit(event, payload)
  },

  on(event, fn) {
    this.socket?.on(event, fn)
    return () => this.socket?.off(event, fn)
  },
}
