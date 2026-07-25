/**
 * Authoritative game loop: ticks, runs the systems, broadcasts the snapshot.
 * Adding a feature never requires touching this file.
 */

import { TICK_MS } from '../../shared/constants.js'
import { S2C } from '../../shared/protocol.js'
import { world, toPlayerView } from './state.js'
import { invoke, collectExt } from '../systems/index.js'

export function startLoop(ctx) {
  let last = Date.now()

  const timer = setInterval(() => {
    const now = Date.now()
    const dt = now - last
    last = now
    world.tick += 1

    invoke('onTick', ctx, dt)

    ctx.broadcast(S2C.SNAPSHOT, {
      t: now,
      tick: world.tick,
      players: [...world.players.values()].map(toPlayerView),
      ext: collectExt(ctx),
    })
  }, TICK_MS)

  timer.unref?.()
  return () => clearInterval(timer)
}
