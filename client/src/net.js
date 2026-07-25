/**
 * Client network layer.
 *
 * From a system:
 *   net.send(C2S.MY_EVENT, payload)
 *   net.on(S2C.MY_EVENT, (payload) => { ... })
 */

import { io } from 'socket.io-client'

// In development the client runs on :5173 and the server on :3000.
const SERVER_URL =
  import.meta.env.VITE_SERVER_URL ??
  (location.port === '5173' ? `http://${location.hostname}:3000` : location.origin)

export const net = {
  /** @type {import('socket.io-client').Socket | null} */
  socket: null,
  latency: 0,

  connect() {
    this.socket = io(SERVER_URL, { transports: ['websocket'] })
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
