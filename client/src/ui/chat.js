/**
 * Chat box and message console.
 *
 * `chat.log(text, cssClass)` is the quick channel for any system that needs
 * to tell the player something. Use it instead of alert().
 *
 * On touch the field is hidden until the player taps the bubble: the bottom of
 * the screen belongs to the stick and the action rail.
 */

import { C2S } from '@shared/protocol.js'
import { net } from '../net.js'
import { viewport } from '../viewport.js'

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
        submit()
      } else {
        e.preventDefault()
        chat.open()
      }
    })

    if (viewport.isTouch) mountTouchChat()
  },

  /** Focuses the field, and reveals it first on touch. */
  open() {
    document.body.classList.add('chat-open')
    inputEl.focus()
  },

  close() {
    document.body.classList.remove('chat-open')
    inputEl.blur()
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

function submit() {
  const text = inputEl.value.trim()
  if (text) net.send(C2S.CHAT_SAY, { text })
  inputEl.value = ''
  chat.close()
}

function mountTouchChat() {
  const toggle = document.createElement('button')
  toggle.id = 'chat-toggle'
  toggle.type = 'button'
  toggle.textContent = '💬'
  toggle.setAttribute('aria-label', 'Chat')
  toggle.addEventListener('click', () => chat.open())
  document.getElementById('hud').appendChild(toggle)

  const send = document.createElement('button')
  send.id = 'chat-send'
  send.type = 'button'
  send.textContent = '➤'
  send.setAttribute('aria-label', 'Send')
  // pointerdown + preventDefault: a click would blur the field first, and the
  // soft keyboard closing mid-tap is what makes mobile send buttons miss.
  send.addEventListener('pointerdown', (e) => {
    e.preventDefault()
    submit()
  })
  document.getElementById('hud').appendChild(send)

  // Dismissing the keyboard should put the screen back to playing state.
  inputEl.addEventListener('blur', () => document.body.classList.remove('chat-open'))
}

function escape(value) {
  return String(value).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  )
}
