/**
 * DOM HUD: bars, name and debug line.
 *
 * DOM instead of Pixi on purpose — UI work and render work stay in separate
 * files, so two people can touch them without conflicting.
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
      mpFill: document.getElementById('mp-fill'),
      mpText: document.getElementById('mp-text'),
      name: document.getElementById('hud-name'),
      debug: document.getElementById('debug'),
    }
  },

  /** Systems can push authoritative stat updates here. */
  setStats({ hp, maxHp, mana, maxMana }) {
    if (!els) return
    if (hp !== undefined) {
      els.hpFill.style.transform = `scaleX(${maxHp ? hp / maxHp : 0})`
      els.hpText.textContent = `${hp}/${maxHp}`
    }
    if (mana !== undefined) {
      els.mpFill.style.transform = `scaleX(${maxMana ? mana / maxMana : 0})`
      els.mpText.textContent = `${mana}/${maxMana}`
    }
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
