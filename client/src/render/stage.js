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

export async function createStage(mount) {
  const app = new Application()
  await app.init({
    background: '#0b0d11',
    resizeTo: window,
    antialias: false,
    roundPixels: true,
  })
  mount.appendChild(app.canvas)

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
