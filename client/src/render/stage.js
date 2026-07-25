/**
 * PixiJS bootstrap and draw layers.
 *
 * Use these layers from your system instead of creating new stages:
 *   layers.ground    map tiles (static)
 *   layers.floor     things lying on the ground
 *   layers.entities  players and other actors (auto sorted by Y)
 *   layers.fx        hits, floating numbers, particles
 *   layers.overlay   nameplates and bars drawn above everything
 */

import { Application, Container } from 'pixi.js'
import { loadSprites } from './sprites.js'

export async function createStage(mount) {
  const app = new Application()
  await app.init({
    background: '#0b0d11',
    // The mount box, not the window: the HUD sidebar insets it, and the camera
    // reads `app.screen` to centre the player in what is actually visible.
    resizeTo: mount,
    antialias: false,
    roundPixels: true,
    // Phones are high-DPI; without this the primitives look soft. Capped at 2
    // because a 3x buffer costs more than it shows.
    resolution: Math.min(window.devicePixelRatio || 1, 2),
    autoDensity: true,
  })
  mount.appendChild(app.canvas)

  // Before the first view is built: a class either has its atlas from the
  // start, or spends the session as the fallback body. Never both.
  await loadSprites()

  /** World container: the camera moves this one. */
  const camera = new Container()
  app.stage.addChild(camera)

  const layers = {
    camera,
    ground: new Container(),
    floor: new Container(),
    entities: new Container(),
    fx: new Container(),
    overlay: new Container(),
  }

  layers.entities.sortableChildren = true
  camera.addChild(layers.ground, layers.floor, layers.entities, layers.fx, layers.overlay)

  return { app, layers }
}
