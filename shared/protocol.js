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
  JOIN: 'core:join', // { name: string, cls: 'warrior'|'mage'|'hunter' }
  MOVE: 'core:move', // { dir: 0|1|2|3, seq: number } one predicted step, already taken locally
  FACE: 'core:face', // { dir: 0|1|2|3 }
  PING: 'core:ping', // { t: number }

  // --- chat ---
  CHAT_SAY: 'chat:say', // { text: string }

  // --- profile ---
  PROFILE_SPEND_POINT: 'profile:spendPoint', // { attr: 'str'|'agi'|'int'|'con' }

  // --- combat ---
  COMBAT_ATTACK: 'combat:attack', // {} melee in the facing direction
  COMBAT_RESPAWN: 'combat:respawn', // {} early respawn once the timer allows

  // --- spells ---
  SPELL_CAST: 'spells:cast', // { id, tx?, ty?, dir? }

  // --- inventory ---
  INVENTORY_BUY: 'inventory:buy', // { slot: 'weapon'|'armor'|'focus'|'boots' }

  // --- add your system's events below, in their own block ---
}

/** Server -> Client */
export const S2C = {
  // --- core ---
  WELCOME: 'core:welcome', // { selfId, self, map: {w,h,block,rle}, systems }
  SNAPSHOT: 'core:snapshot', // { t, tick, players: PlayerView[], ext: {} }
  ERROR: 'core:error', // { code, message }
  PONG: 'core:pong', // { t }

  // --- chat ---
  CHAT_MSG: 'chat:msg', // { from, fromId, text, channel: 'say'|'system' }

  // --- profile ---
  PROFILE_SELF: 'profile:self', // { profile, stats } — owner only, never broadcast
  PROFILE_LEVEL_UP: 'profile:levelUp', // { id, level }

  // --- combat ---
  COMBAT_HIT: 'combat:hit', // { x, y, kind, id, amount, crit, school, byId }
  COMBAT_DEATH: 'combat:death', // { kind, id, name, killerId, killerName }
  COMBAT_RESPAWNED: 'combat:respawned', // { id, x, y, protectedMs }
  COMBAT_KILLFEED: 'combat:killfeed', // { killerName, victimName, victimKind, reward:{exp,coins} }

  // --- effects ---
  EFFECTS_SELF: 'effects:self', // owner only { active: [{ id, endsAt, stacks }] }

  // --- spells ---
  SPELL_BOOK: 'spells:book', // owner only { known: [{ id, slot, unlocked }] }
  SPELL_COOLDOWN: 'spells:cooldown', // owner only { id, untilMs }
  SPELL_CAST_FX: 'spells:castFx', // { casterKind, casterId, id, x0, y0, tx, ty, dir, projId? }
  SPELL_RAY: 'spells:ray', // { id, x0, y0, x1, y1 }
  SPELL_IMPACT: 'spells:impact', // { id, x, y, radius }
  SPELL_FAILED: 'spells:failed', // owner only { id, reason }

  // --- inventory ---
  INVENTORY_SELF: 'inventory:self', // owner only { tiers, nextCosts }

  // --- loot ---
  LOOT_PICKED: 'loot:picked', // { id, byId, type }
  LOOT_EXPLODE: 'loot:explode', // { id, x, y, radius }

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
 * @property {number} seq  last input the core acknowledged, for client prediction
 */

export const ERROR_CODE = {
  BAD_PAYLOAD: 'BAD_PAYLOAD',
  NOT_JOINED: 'NOT_JOINED',
  RATE_LIMIT: 'RATE_LIMIT',
  NOT_IMPLEMENTED: 'NOT_IMPLEMENTED',
}
