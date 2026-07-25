/**
 * Local mirror of the server state.
 *
 * The server owns the truth. The client interpolates so movement looks smooth,
 * and predicts its own steps so walking does not wait for a round trip — that
 * prediction lives in `movement.js` and is always corrected from here. Never
 * write authoritative values from a system: send an intent over the network.
 */

import { decodeTiles } from '@shared/grid.js'

export const state = {
  selfId: null,
  map: null,
  /** Which server systems are live: { combat: false, npc: true, ... } */
  systems: {},
  /** @type {Map<string, any>} playerId -> PlayerView */
  players: new Map(),
  /** Latest `snapshot.ext`, keyed by system id. */
  ext: {},
  lastSnapshotAt: 0,
  serverTick: 0,
}

export function self() {
  return state.players.get(state.selfId) ?? null
}

/**
 * Expands the run-length encoded map from WELCOME. Throws on a malformed
 * payload rather than leaving the client walking around a half built world.
 */
export function setMap(wire) {
  state.map = {
    w: wire.w,
    h: wire.h,
    block: wire.block,
    tiles: decodeTiles(wire.rle, wire.w * wire.h),
  }
  return state.map
}

/** Applies a server snapshot onto the local mirror. */
export function applySnapshot(snapshot) {
  state.lastSnapshotAt = performance.now()
  state.serverTick = snapshot.tick
  state.ext = snapshot.ext ?? {}

  const seen = new Set()
  for (const view of snapshot.players) {
    seen.add(view.id)
    const existing = state.players.get(view.id)
    if (existing) Object.assign(existing, view)
    else state.players.set(view.id, { ...view })
  }
  for (const id of state.players.keys()) {
    if (!seen.has(id)) state.players.delete(id)
  }
}
