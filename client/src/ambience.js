/**
 * Ambient background music for the game session.
 *
 * Browsers block programmatic audio until a real user gesture, so `start()`
 * is called from the login form's submit handler in main.js rather than
 * from WELCOME. Once started it loops for the rest of the session — there
 * is no stop, matching "permanent while in a match".
 */

import ambientTrackUrl from './audio/ambient-1.mp3'

const VOLUME = 0.12

let track = null

export const ambience = {
  start() {
    if (track) return
    track = new Audio(ambientTrackUrl)
    track.loop = true
    track.volume = VOLUME
    // Autoplay can still be refused (e.g. gesture too indirect); music just
    // stays off rather than breaking login.
    track.play().catch(() => {})
  },
}
