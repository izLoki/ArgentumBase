/**
 * Chat box and message console.
 *
 * `chat.log(text, cssClass)` is the quick channel for any system that needs
 * to tell the player something. Use it instead of alert().
 */

import { C2S } from '@shared/protocol.js'
import { net } from '../net.js'

const MAX_LINES = 80
let logEl = null
let inputEl = null

export const chat = {
  mount() {
    logEl = document.getElementById('chat-log')
    inputEl = document.getElementById('chat-input')

    window.addEventListener('keydown', (e) => {
      if (e.code !== 'Enter') return
      if (document.activeElement === inputEl) {
        const text = inputEl.value.trim()
        if (text) net.send(C2S.CHAT_SAY, { text })
        inputEl.value = ''
        inputEl.blur()
      } else {
        e.preventDefault()
        inputEl.focus()
      }
    })
  },

  log(text, cls = '') {
    if (!logEl) return
    const line = document.createElement('div')
    line.className = cls
    line.innerHTML = text
    logEl.appendChild(line)
    while (logEl.childElementCount > MAX_LINES) logEl.firstElementChild.remove()
    logEl.scrollTop = logEl.scrollHeight
  },

  message({ from, text, channel }) {
    if (channel === 'system') return this.log(escape(text), 'system')
    this.log(`<span class="who">${escape(from)}:</span> ${escape(text)}`)
  },
}

function escape(value) {
  return String(value).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  )
}
