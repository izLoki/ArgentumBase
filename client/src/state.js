/**
 * Local mirror of the server state.
 *
 * The server owns the truth; the client only interpolates so movement looks
 * smooth. Never write authoritative values here from a system — send an
 * intent over the network instead.
 */

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
