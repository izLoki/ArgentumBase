# Working in this repository

Read this before writing code here, whether you are a person or an AI
assistant.

## What this project is

A base for a **server-authoritative multiplayer tile world**: many players
moving on a shared grid map in real time. PixiJS 8 + Node/Express +
Socket.IO + Vite, plain JavaScript with ES modules (`"type": "module"`).

Gameplay features are deliberately absent. The point of the repo is the
skeleton plus a plugin layer that lets several people build features at the
same time without stepping on each other.

## The one rule everything else follows

**One feature = one file on each side, plus a registry entry.**

A feature never requires editing the core. That is what keeps parallel work
conflict-free: two people building different features touch disjoint files.

Core files — do not edit them to add a feature:

```
server/index.js  server/game/*  server/net/*  shared/constants.js
client/src/main.js  client/src/net.js  client/src/state.js  client/src/render/*
```

If you genuinely need something from the core (a new helper on `ctx`, a new
draw layer), add it — those changes are additive and safe. Rewriting or
restructuring the core is what breaks everyone else's branch.

## Adding a system

### 1. Server half

Create `server/systems/<name>.js`. Everything is optional except `id`:

```js
import { C2S, S2C } from '../../shared/protocol.js'

export default {
  id: 'combat',
  enabled: true,

  init(ctx) {
    // Runs once at startup. Create your global state here.
    ctx.world.ext.combat = { lastAttackAt: new Map() }
  },

  onPlayerJoin(ctx, player) {
    // Create your per-player state here.
    player.ext.combat = { kills: 0 }
  },

  onPlayerLeave(ctx, player) {},

  onTick(ctx, dtMs) {
    // Runs every server tick (15/s).
  },

  collectSnapshot(ctx) {
    // Optional. The return value is sent to clients as snapshot.ext.combat
    return { somethingClientsNeed: true }
  },

  handlers: {
    // C2S events this system owns.
    [C2S.ATTACK]: (ctx, player, payload) => {},
  },
}
```

Register it in `server/systems/index.js`: one import line and one array entry.
That file is the only shared file a new system touches, and the conflict is a
two-line append that git usually merges by itself.

### 2. Client half

Create `client/src/systems/<same-name>.js`:

```js
import { S2C } from '@shared/protocol.js'

export default {
  id: 'combat',

  init(ctx) {
    // Runs when the world is ready, only if the server system is enabled.
    // `action` binds a key and an on-screen button in one call, so the
    // feature works on a phone too. See "Mobile is not optional" below.
    ctx.action({
      id: 'attack',
      label: '⚔',
      key: 'ControlLeft',
      onPress: () => ctx.net.send(C2S.ATTACK, {}),
    })
  },

  onSnapshot(ctx, snapshot) {},
  onUpdate(ctx, dtMs) {},

  handlers: {
    [S2C.COMBAT_EVENT]: (ctx, payload) => {},
  },
}
```

Register it in `client/src/systems/index.js`, same two lines.

A client system only runs when the server reports its counterpart as
`enabled`, so an unfinished feature cannot break a running world.

### 3. Network events

Add them to `shared/protocol.js` **inside a block named after your system**,
appended at the end of `C2S` / `S2C`. Never rename or reorder someone else's
events. The server dispatcher routes everything declared there automatically —
there is nothing else to wire.

## What `ctx` gives you

Server (`server/game/context.js`):

| Field | Purpose |
|---|---|
| `ctx.world` | `players` (Map), `tick`, `ext` |
| `ctx.world.ext.<id>` | your global state, created in `init` |
| `player.ext.<id>` | your per-player state, created in `onPlayerJoin` |
| `ctx.broadcast(ev, data)` | send to everyone |
| `ctx.sendTo(id, ev, data)` | send to one socket |
| `ctx.fail(player, code, msg)` | typed error to the caller |
| `ctx.announce(text)` | system message in chat |
| `ctx.map`, `ctx.tileAt`, `ctx.isWalkable`, `ctx.SPAWN` | world queries |
| `ctx.log(...)` | prefixed logging |

Client (built in `client/src/main.js`):

| Field | Purpose |
|---|---|
| `ctx.app`, `ctx.layers` | Pixi application and draw layers |
| `ctx.state`, `ctx.self()` | local mirror of the world |
| `ctx.net` | `send` / `on` |
| `ctx.action({id, label, key, slot, onPress})` | one binding, keyboard **and** thumb button. `slot: 'rail'` (default, bottom-right thumb rail) or `'utility'` (top-right column, for panels and toggles) |
| `ctx.input.onKey(code, fn)` | keyboard-only binding (desktop-only features) |
| `ctx.viewport` | `isTouch`, `isMobile`, `isPortrait`, `zoom`, `onChange(fn)` |
| `ctx.touch` | `addButton` / `removeButton` / `buttonOf(id)` when `action()` is not enough |
| `ctx.hud`, `ctx.chat` | HUD updates and message output |

## The player profile

Anything about *who a player is* — level, exp, gold, attributes and the stats
derived from them — belongs to the `profile` system, not to your own state.
Inventory, combat, stats panels and data features all read the same numbers
from it instead of each keeping a copy.

- Shape and formulas: `shared/profile.js` (pure data, imported by both sides).
- Server: `server/systems/profile.js` owns it.
- Client: `client/src/systems/profile.js` mirrors it, plus the 👤 panel (`P`).

Server, from your own system:

```js
import { profileOf, statsOf, addExp, addGold, spendGold, setModifier } from './profile.js'

const stats = statsOf(player)          // { maxHp, damage, defense, evasion, spellPower, cdr }
addExp(ctx, player, 40)                // levels up and announces on its own
if (!spendGold(ctx, player, 25)) return ctx.fail(player, 'BAD_PAYLOAD', 'not enough gold')
```

Never write `level`, `gold` or a stat by hand. To contribute bonuses (gear, a
buff) register a modifier under your system id — the profile folds it into the
derived stats and recomputes:

```js
setModifier(ctx, player, 'inventory', { damage: 4, defense: 2 })
clearModifier(ctx, player, 'inventory')
```

Need to carry your own data with the profile? Use your own key,
`profile.ext.<yourId> = {...}`, then `markDirty(player)`.

Client:

```js
import { myProfile, myStats, profileOf, onProfileChange } from './profile.js'
```

`snapshot.ext.profile` carries only the public part (`id, name, cls, level`).
Gold, exp and attributes are private and pushed to their owner alone over
`S2C.PROFILE_SELF` — do not republish them.

## Mobile is not optional

The world is played on phones in landscape. A feature that only works with a
keyboard is an unfinished feature, so build both halves in the same pass.

**Screen budget on a phone in landscape (~740×380 CSS px):**

```
┌──────────────────────────────────────────────┐
│ stats                            debug   💬  │  top strip: HUD readouts
│ chat log                                 🛒  │  utility column (top right)
│                                          👤  │
│                                              │
│   ← stick zone (46% × 62%) →      [action]   │  bottom-left: movement
│                                   [ rail  ]  │  bottom-right: actions
└──────────────────────────────────────────────┘
```

1. **Bind actions with `ctx.action`, never `ctx.input.onKey` alone.**

   ```js
   ctx.action({ id: 'attack', label: '⚔', key: 'ControlLeft', onPress: () => ... })
   ```

   That is one keyboard binding plus one button in the action rail. Reserve
   `ctx.input.onKey` for things a phone genuinely cannot do.

   Pick the slot by *when* the button is pressed. Things used mid-fight stay
   on the thumb rail; panels and toggles go to the utility column, so the rail
   does not fill up with things nobody presses under pressure:

   ```js
   ctx.action({ id: 'shop', label: '🛒', key: 'KeyB', slot: 'utility', onPress: ... })
   ```

2. **Never place UI over `#stick-zone`, `#actions` or `#actions-utility`.**
   The bottom-left quadrant, the bottom-right corner and the top-right column
   are reserved. Panels go top-left, or centred as a modal.

3. **Anchor to the safe-area variables**, not to raw pixels — notches and
   rounded corners eat the edges:

   ```css
   top: calc(12px + var(--safe-t));
   left: calc(12px + var(--safe-l));
   ```

4. **Anything anchored to the bottom adds `var(--kb)`.** That is the soft
   keyboard's overlap, kept up to date by `client/src/viewport.js`. Without it
   the element sits under the keyboard while the player types.

5. **Size panels in `%` / `min()`, with a `max-height`.** A fixed 400×500 panel
   does not fit. Assume 380px of height, minus the top strip.

6. **Tap targets are at least 44×44 px**, and `font-size: 16px` on any input —
   below that iOS Safari zooms the page on focus.

7. **Do not read `window.innerWidth` yourself.** `ctx.viewport.isMobile` is the
   single answer, and `ctx.viewport.onChange(fn)` fires on rotation and resize.

8. **World scale belongs to the camera.** `ctx.viewport.zoom` is applied once,
   to `layers.camera`; systems keep working in plain world pixels.

Test the mobile layout on a desktop with `?touch=1` — it forces the touch HUD
without a device.

## Rules that keep merges clean

1. **Never write another system's state.** Reading is fine. If you need
   another system to act, import a function it exports — do not reach into its
   internals.
2. **Never add fields to `PlayerView`.** Publish your data through
   `collectSnapshot()` and read it from `snapshot.ext.<yourId>`.
3. **Private data does not go in the snapshot.** Snapshots are broadcast to
   everyone; use `ctx.sendTo(player.id, ...)` for per-player data.
4. **Bind actions from your own module** with `ctx.action`, not by editing
   `input.js`.
5. **Build UI panels from your own module** by creating the elements in JS,
   rather than editing `client/index.html`. Keep them inside the mobile screen
   budget — see "Mobile is not optional".
6. **`enabled: false` is the safety switch.** While a system is off, its
   events answer `NOT_IMPLEMENTED` and nothing else runs. Half-finished work
   can be merged without breaking the world.

## Architecture invariants

- **The server is authoritative.** The client sends intents; the server
  decides outcomes. Never compute damage, validate collisions, or apply
  position changes on the client.
- **Snapshots are full state**, sent 15 times per second. The client only
  interpolates for smoothness.
- **The world lives in memory.** There is no database and none is needed.
- **No assets.** Everything is drawn with Pixi primitives. Replacing that with
  a real tileset should only touch `client/src/render/`.

## Style

- All code, comments and documentation in English.
- Small functions, early returns, no speculative abstractions.
- Comment *why*, not *what*.
- No leftover debug `console.log` outside server startup and error paths.

## Things not to do

- Refactoring or restructuring the core "to make it nicer". It invalidates
  every open branch.
- Migrating to TypeScript, swapping the bundler, or adding a UI framework.
- Adding dependencies that a single feature could implement in a few lines.
- Adding a database or persistence layer unless it was explicitly asked for.
