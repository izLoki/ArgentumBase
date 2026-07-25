/**
 * NETWORK CONTRACT — the single source of truth for every client <-> server
 * message.
 *
 * Naming convention: '<system>:<action>'
 *   C2S = client -> server  (intents only, never outcomes)
 *   S2C = server -> client  (authoritative truth)
 *
 * Adding events for a new system:
 *   1. Create a block below named after your system, at the end of the object.
 *   2. Only ever add lines inside your own block. Never rename or reorder
 *      someone else's events.
 *   3. The server dispatcher routes every event declared here automatically —
 *      there is nothing else to wire up.
 *
 * Because everyone appends to a different block, two people adding events at
 * the same time produce a merge conflict that is trivial to resolve (keep
 * both blocks).
 */

/** Client -> Server */
export const C2S = {
  // --- core ---
  JOIN: 'core:join', // { name: string, cls: 'warrior'|'mage'|'archer' }
  MOVE: 'core:move', // { dir: 0|1|2|3 }
  FACE: 'core:face', // { dir: 0|1|2|3 }
  PING: 'core:ping', // { t: number }

  // --- chat ---
  CHAT_SAY: 'chat:say', // { text: string }

  // --- add your system's events below, in their own block ---
}

/** Server -> Client */
export const S2C = {
  // --- core ---
  WELCOME: 'core:welcome', // { selfId, self, map: {w,h,tiles}, systems }
  SNAPSHOT: 'core:snapshot', // { t, tick, players: PlayerView[], ext: {} }
  ERROR: 'core:error', // { code, message }
  PONG: 'core:pong', // { t }

  // --- chat ---
  CHAT_MSG: 'chat:msg', // { from, fromId, text, channel: 'say'|'system' }

  // --- add your system's events below, in their own block ---
}

/**
 * The per-player shape the core guarantees in every snapshot.
 *
 * Systems must NOT add fields here. Publish your own data through
 * `collectSnapshot()` instead — it arrives as `snapshot.ext.<systemId>`.
 *
 * @typedef {Object} PlayerView
 * @property {string} id
 * @property {string} name
 * @property {string} cls
 * @property {number} x  tile x
 * @property {number} y  tile y
 * @property {number} dir
 * @property {number} hp
 * @property {number} maxHp
 * @property {boolean} dead
 */

export const ERROR_CODE = {
  BAD_PAYLOAD: 'BAD_PAYLOAD',
  NOT_JOINED: 'NOT_JOINED',
  RATE_LIMIT: 'RATE_LIMIT',
  NOT_IMPLEMENTED: 'NOT_IMPLEMENTED',
}
