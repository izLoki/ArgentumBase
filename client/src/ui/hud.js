/**
 * DOM HUD: bars, name and debug line.
 *
 * DOM instead of Pixi on purpose — UI work and render work stay in separate
 * files, so two people can touch them without conflicting.
 *
 * There is no mana in this world, so the second bar is experience. HP comes
 * from the snapshot every frame; experience and level are private and pushed
 * here by the `profile` system through `setStats`.
 */

import { state, self } from '../state.js'
import { net } from '../net.js'

let els = null

export const hud = {
  mount() {
    document.getElementById('hud').classList.remove('hidden')
    els = {
      hpFill: document.getElementById('hp-fill'),
      hpText: document.getElementById('hp-text'),
      xpFill: document.getElementById('xp-fill'),
      xpText: document.getElementById('xp-text'),
      name: document.getElementById('hud-name'),
      level: document.getElementById('hud-level'),
      debug: document.getElementById('debug'),
    }
  },

  /**
   * Systems push authoritative readouts here rather than reaching into the
   * HUD's elements — that is what keeps `combat` and `profile` off each
   * other's toes.
   */
  setStats({ hp, maxHp, exp, expToNext, level } = {}) {
    if (!els) return
    if (hp !== undefined) {
      els.hpFill.style.transform = `scaleX(${maxHp ? hp / maxHp : 0})`
      els.hpText.textContent = `${hp}/${maxHp}`
    }
    if (exp !== undefined) {
      const ratio = expToNext > 0 ? Math.min(1, exp / expToNext) : 1
      els.xpFill.style.transform = `scaleX(${ratio})`
      els.xpText.textContent = expToNext > 0 ? `${exp}/${expToNext} xp` : 'max'
    }
    if (level !== undefined) els.level.textContent = `Lv ${level}`
  },

  update() {
    const me = self()
    if (!me || !els) return
    els.name.textContent = me.name
    els.hpFill.style.transform = `scaleX(${me.maxHp ? me.hp / me.maxHp : 0})`
    els.hpText.textContent = `${me.hp}/${me.maxHp}`
    els.debug.textContent = `tile ${me.x},${me.y} · tick ${state.serverTick} · ping ${net.latency}ms · ${state.players.size} online`
  },
}
