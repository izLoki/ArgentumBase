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
| `ctx.canStand(x, y)`, `ctx.findFreeTile(x, y)` | whether a whole body fits, and where the nearest spot is |
| `ctx.log(...)` | prefixed logging |

Client (built in `client/src/main.js`):

| Field | Purpose |
|---|---|
| `ctx.app`, `ctx.layers` | Pixi application and draw layers |
| `ctx.state`, `ctx.self()` | local mirror of the world |
| `ctx.movement.selfTile()` | where the local player actually is — predicted, one round trip ahead of `self()` |
| `ctx.net` | `send` / `on` |
| `ctx.action({id, label, key, slot, onPress})` | one binding, keyboard **and** thumb button. `slot: 'rail'` (default, bottom-right thumb rail) or `'utility'` (top-right column, for panels and toggles) |
| `ctx.input.onKey(code, fn)` | keyboard-only binding (desktop-only features) |
| `ctx.viewport` | `isTouch`, `isMobile`, `isPortrait`, `zoom`, `onChange(fn)` |
| `ctx.touch` | `addButton` / `removeButton` / `buttonOf(id)` when `action()` is not enough |
| `ctx.hud`, `ctx.chat` | HUD updates and message output |

### The HUD sidebar

`ctx.hud` is the character sidebar — permanent on the right on desktop, a 🎒
overlay (`I`) on a phone. Never touch its elements; push into it:

```js
ctx.hud.setStats({ kills, deaths })      // any subset: hp, maxHp, exp, expToNext, level, gold
ctx.hud.setCharacter({ attributes, stats }) // Character tab: attrs + TOTAL derived stats
ctx.hud.setGear({ weapon: 2, boots: 1 }) // owned tier per gear slot
ctx.hud.setGearMarket({ nextCosts, buy }) // upgrade prices + the buy callback
ctx.hud.openEquipment()                  // open the sidebar on the Equipment tab
```

Its body is two tabs. **Character** is the sheet: the four attributes and the
total derived stats, pushed by `profile`. **Equipment** is the four gear slots
as full-width rows — current bonuses, what the next tier adds, and an Upgrade
button — drawn from `shared/gear.js` and fed by `inventory`, which owns the
prices and the `buy` wire (there is no separate shop modal). The HUD draws;
whoever owns the behaviour pushes state in through the calls above. Spells are
not here — the class's rail lives in the on-screen hotbar, next to the keys
that cast it.

`--hud-right` is the width the sidebar takes from the world. `#game` is inset
by it, so the camera already centres the player in what is visible — but a
panel of your own anchored to the right edge has to add it, the way
`client/src/systems/profile.js` does.

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

## Tiles, blocks and distances

The grid is fine and invisible. **A tile is a movement step, not a terrain
feature**: 8 px, four of which make one **block** — the 32 px square terrain is
actually built from. Maps are designed in blocks and expanded into tiles, so a
tree still looks like a tree while walking gained four times the resolution.

Two units, and mixing them up is the easiest bug to write here:

| Unit | What uses it |
|---|---|
| **tile** | every coordinate: `player.x`, `tx/ty`, anything compared against the map |
| **block** | every gameplay distance in a data table: spell `range`, `radius`, mob `aggro`, spawn distances |

Convert where a range meets a coordinate, never in the table:

```js
import { blocksToTiles } from '@shared/constants.js'
const reach = blocksToTiles(def.range) // 8 blocks -> 32 tiles
```

Bodies are wider than a tile (`PLAYER_RADIUS`), so a position is only valid
when the **whole footprint** fits. Use `ctx.canStand(x, y)` — not
`ctx.isWalkable`, which answers for a single tile — and `ctx.findFreeTile` to
place anything. Two entities collide when their footprints overlap
(`bodiesOverlap` in `shared/grid.js`).

When you design terrain, work in blocks — and leave **two blocks** of clearance
wherever something has to walk through. A body is 5 tiles across (`PLAYER_RADIUS`
is 2), a block is 4, so a one block opening is not a tight gate: it is a wall.

## Character sprites

Classes are drawn from one atlas per class, `client/src/render/sprites/<cls>.png`,
registered in the `SHEETS` map at the top of `client/src/render/sprites.js`. That
map is the whole wiring: a class listed there gets a sprite, a class missing from
it keeps the coloured fallback body. Nothing outside `render/` changes either way.

An atlas is a **3 x 4 grid of 144 x 192 cells** — three walk frames across, one
row per direction in `DIR` order (down, left, right, up). Two rules make it work:

- **Align every cell by the feet**, on `FEET_Y` (186) and centred horizontally on
  the body. Aligning by bounding box instead makes the character slide sideways
  whenever an arm or a weapon swings.
- **Frames read `contact, pass, contact`.** The cycle plays `0 1 2 1`, advanced by
  DISTANCE WALKED, not by a timer — so the legs stay in step with the feet at any
  speed, and a slowed or hastened player never moonwalks.

`client/src/render/entities.js` draws the sprite **larger than the body**: feet at
the bottom of the 5x5 footprint, head far above it. The footprint is what
collides; the sprite is a picture of it. Never measure gameplay against the
drawing — `PLAYER_RADIUS` is the only body there is.

`tools/cut-sprite-atlas.py` turns a raw sheet into that layout — it finds each
sprite by its alpha and re-anchors it, which is the part you do not want to do by
hand. The three classes were cut with:

```sh
python tools/cut-sprite-atlas.py warrior.png client/src/render/sprites/warrior.png --rows 0 1 2 3
python tools/cut-sprite-atlas.py mage.png    client/src/render/sprites/mage.png    --rows 0 1m 1 3
python tools/cut-sprite-atlas.py hunter.png  client/src/render/sprites/hunter.png  --rows 0 1 2 3
```

`--rows` names the source row behind each direction, and `m` mirrors it: the mage
sheet only draws a right-facing pose, so its LEFT is that row flipped.

Three things about reading and fitting a raw sheet:

- **Read the direction off the FACE**, never off a hat, a plume or a weapon — the
  art puts those wherever it likes. One visible eye sits on the side the
  character faces; a helmet's visor slit does the same job; no face at all is the
  back view.
- **Every class comes out the same height** — the tool fits each sheet to the cell
  on its own, so sources drawn at different sizes still land on one baseline. If a
  tall plume or a raised weapon eats the cell and leaves that class looking small,
  trim it with `--scale 0.95` rather than editing the art.
- **A sheet that runs off the bottom of its canvas gets its baseline
  reconstructed** from the intact poses, and the tool says so loudly. That keeps
  the pose standing at the right height, but the pixels it lost are gone — the fix
  is to re-export the sheet taller. The hunter's UP row is currently in this state,
  missing the boots.

### Monsters

Same atlas format as a class walk sheet, one registry along:

```sh
python tools/cut-sprite-atlas.py dragon.png client/src/render/sprites/mob-dragon.png --rows 0 1 2 3
```

```js
const MOB_SHEETS = { dragon: mobDragonUrl }   // sprites.js
```

`systems/npc.js` draws the sprite at `look.scale` when `mobSheetFor(type)` finds
one, and keeps its coloured blob and emoji when it does not — so the roster gets
its art one creature at a time. The walk cycle is distance-driven like a
player's: mobs step on their own `moveMs`, and a timer would be in phase with
the feet at exactly one speed.

### Ability animations

A spell can replace the walking body with an animation of its own for the length
of one cast. Same idea, one extra registry:

```sh
# one row of frames: a spin looks the same from every direction
python tools/cut-sprite-atlas.py warrior_attack_360.png \
    client/src/render/sprites/warrior-whirlwind.png --action --source-grid 3x2

# four rows: a lunge has to point where the caster is going. `--key-background`
# is for a sheet matted onto a colour plate instead of cut out.
python tools/cut-sprite-atlas.py warrior_dash.png \
    client/src/render/sprites/warrior-charge.png --action --rows 0 1 2 3 --key-background
```

```js
const ACTIONS = {                                  // sprites.js
  'warrior:whirlwind': warriorWhirlwindUrl,
  'warrior:charge': warriorChargeUrl,
}
```

Row and frame counts are read off the image, not declared: **one** row means the
animation ignores facing, **four** means it is picked by the caster's direction —
once, at cast time, so a dash cannot turn mid-lunge.

`systems/spells.js` calls `playAction(casterId, spellId)` on `SPELL_CAST_FX`, and
skips its own generic flash when that returns true — a finished animation does
not want a placeholder ring drawn over it. A spell with no entry is unaffected.

An action cell is **352 x 192**: wider than a walk cell, and the same height. A
sword sweep reaches about a body's width to each side but never above the head or
below the feet, so keeping `CELL_H` and `FEET_Y` means the body lands on the same
baseline at the same scale and the swap is invisible. Two traps the tool handles
for you, both of which show up as garbage on screen rather than as an error:

- **The anchor must ignore the effect.** A sweep of light is half the image and
  moves every frame; anchor on it and the character jitters inside his own
  animation. `--action` masks saturated gold out before measuring. It is only
  applied in that mode — on a walk sheet the same test would eat the hunter's
  blond hair.
- **Each frame is cut in isolation.** The sampling window is sized for the art,
  not for the source grid, so a wide pose reaches past its own cell and drags the
  neighbouring frame's sweep in as a crescent floating beside the character.

## Movement is predicted

Walking does not wait for the server. The client applies the step immediately,
tags it with a sequence number and sends it; the server re-runs the same rules
and every snapshot carries back the last sequence it processed, so
`client/src/movement.js` can replay whatever is still unacknowledged on top of
the server's position. On a server hosted far away this is the difference
between a game and a slideshow.

This does not weaken the server's authority — it still decides, and its verdict
lands on the next snapshot. What it does require:

- **The rules both sides run live in `shared/grid.js`.** Never copy a movement
  rule into the client; a divergence shows up as rubber-banding.
- **Read the local player's position from `ctx.movement.selfTile()`**, not from
  `ctx.self().x`. The first is where the player sees themselves, the second is
  up to one round trip behind.
- A system that blocks movement (`registerMoveGate`, a new blocker) is invisible
  to the prediction and corrects with a small snap. That is fine for something
  occasional like a root; it is not a place to put a rule that fires constantly.

## Architecture invariants

- **The server is authoritative.** The client sends intents; the server
  decides outcomes. Never compute damage or validate a hit on the client. The
  one exception is the local player's own movement, which is predicted and then
  corrected — see above.
- **Snapshots are full state**, sent 15 times per second. The client
  interpolates for smoothness and predicts its own steps.
- **The world lives in memory.** There is no database and none is needed.
- **Art lives in `client/src/render/`, and nowhere else.** Terrain and effects
  are still Pixi primitives; characters are sprite atlases (see below). Anything
  that replaces a primitive with an image belongs under that directory, so the
  rest of the client never learns that images exist.

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
