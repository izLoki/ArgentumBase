# Arena — game specification

The gameplay layer built on top of the base described in `CLAUDE.md`.

A **persistent arena**: players join and leave freely, fight each other and
monsters that keep spawning, level up by killing, unlock spells, and spend
coins on tiered gear. There are no rounds, no winner and no reset.

Read `CLAUDE.md` first. Nothing here overrides it — in particular, "one
feature = one file on each side plus a registry entry" still holds, and the
core stays untouched except for the additive hooks listed in
[Foundations](#foundations).

---

## 1. Core rules

| Topic | Rule |
|---|---|
| Classes | `warrior`, `mage`, `hunter` |
| Format | Persistent arena. No rounds, no match state, no reset |
| Death | You keep level, spells, attributes and gear. You respawn with full HP after a short delay, with brief spawn protection. You drop loot on the ground |
| Attributes | Grow **only on level up**, following a fixed per-class curve. There is no manual point spending |
| Experience | Flat per victim: each class and each monster type is worth a different amount, but who you killed does not steer which attribute grows |
| Mana | Does not exist. Cooldown is the only limit on spells |
| Intelligence | Reduces every cooldown **and** boosts spell damage, weighted per spell |
| Gear | Accumulating tiers (sword / armor / staff / boots), never individual items |

### 1.1 Attributes and derived stats

Attributes are the four already defined in `shared/profile.js`:

| Attribute | Drives |
|---|---|
| `str` | melee damage |
| `agi` | evasion, and the damage of agility-scaling spells |
| `int` | cooldown reduction and spell power |
| `con` | max HP and defense |

`deriveStats()` gains two keys so intelligence has somewhere to land. Both are
**integer percentages**, because `deriveStats` rounds every stat:

```js
spellPower: 100 + a.int * 4          // 100 = neutral
cdr:        Math.min(45, a.int * 1.2) // percent, clamped again at the use site
```

### 1.2 Growth per level

There is no open-ended growth. Every class shares the same **max level** —
the highest level reachable in the arena — and a fixed attribute total to
reach by then. A level-up does not add a constant per-level increment;
instead each attribute is interpolated linearly between the class's base
value at level 1 and its target total at `MAX_LEVEL`, so the numbers land on
the target exactly regardless of how `MAX_LEVEL` or the totals get tuned
later.

```js
export const MAX_LEVEL = 20 // same cap for every class

// Total attribute points gained between level 1 and MAX_LEVEL, per class.
export const GROWTH_TOTAL = {
  warrior: { str: 38, agi: 19, int: 0,  con: 38 },
  mage:    { str: 0,  agi: 19, int: 57, con: 19 },
  hunter:  { str: 19, agi: 57, int: 19, con: 19 },
}

export function attributesAtLevel(cls, level) {
  const base = BASE_ATTRIBUTES[cls] ?? BASE_ATTRIBUTES.warrior
  const total = GROWTH_TOTAL[cls] ?? {}
  const t = (Math.min(level, MAX_LEVEL) - 1) / (MAX_LEVEL - 1)
  const out = {}
  for (const attr of ATTRIBUTES) out[attr] = base[attr] + Math.round((total[attr] ?? 0) * t)
  return out
}
```

Applied inside the existing level-up loop of `addExp`
(`server/systems/profile.js`): once the loop settles on a new level,
`profile.attributes = attributesAtLevel(profile.cls, profile.level)`
replaces the whole set in one shot, rather than accumulating deltas.
Recomputing from `level` instead of adding a per-level delta is what
guarantees the total lands exactly on `GROWTH_TOTAL` at `MAX_LEVEL`, with no
rounding drift from repeated additions. XP stops mattering once
`profile.level` reaches `MAX_LEVEL` — the loop guard simply stops advancing.

`POINTS_PER_LEVEL` and `STARTING_POINTS` stay at `0`; the
`PROFILE_SPEND_POINT` handler stays in place but can never succeed, so
nothing on the client breaks.

### 1.3 Kill rewards

Flat XP and coins per victim, in `shared/rewards.js`:

```js
export const XP_REWARD = {
  player: { warrior: 130, mage: 140, hunter: 135 },  // scaled by the victim's level
  npc:    { wisp: 28, imp: 30, golem: 45, dragon: 80 },
}
export const COIN_REWARD = {
  player: { warrior: 45, mage: 45, hunter: 45 },
  npc:    { wisp: 9, imp: 10, golem: 14, dragon: 26 },
}
export const REPEAT_KILL_WINDOW_MS = 45_000
```

Anti-snowball levers (turn on at least two before the arena is playable):
diminishing XP by killer level (`1 - lvl * 0.02`, floor `0.25`), decay for
repeatedly killing the same victim inside `REPEAT_KILL_WINDOW_MS`, and a
bounty multiplier that makes the current leader worth more.

---

## 2. System map

Six systems to build. Four are the existing stubs; two are new files.
Creating a system is the sanctioned way to add a feature, so this is not a
core change.

| System | Owns | Exports |
|---|---|---|
| `combat` | `player.hp`, `player.dead`, `player.ext.combat` | `applyDamage`, `heal`, `targetAt`, `targetsInRadius`, `registerTargetProvider`, `registerDamagePipeline`, `onKill` |
| `effects` | `player.ext.effects` | `applyEffect`, `removeEffect`, `hasFlag`, `activeOf` |
| `spells` | `player.ext.spells`, `world.ext.spells` | `castSpell`, `knownSpells`, `registerAction` |
| `npc` | `world.ext.npc` | `mobAt`, `mobById` |
| `inventory` | `player.ext.inventory` | `tiersOf` |
| `loot` | `world.ext.loot` | `spawnDrop` |

There is no `arena` system: with no rounds there is no match state to own.
Kill rewards, respawn, the kill feed and the scoreboard live in `combat`.

### 2.1 State ownership — the rule that matters most

```
maxHp        -> profile   (deriveStats -> applyVitals). Change it ONLY via setModifier.
hp / dead    -> combat    (single writer). Everyone else calls combat's API.
mob hp       -> npc       (combat reaches it only through the registered target provider)
```

This block belongs verbatim at the top of `server/systems/combat.js`. Two
systems subtracting `hp` independently produces two death events and two
rewards — the single most likely bug in this design.

### 2.2 Avoiding circular imports

The naive design has `combat` importing `npc` to damage a mob and `npc`
importing `combat` to damage a player. The core already solves this exact
problem with `registerBlocker` in `server/game/state.js`, so copy that
pattern: **downstream systems register into `combat`; `combat` imports
nobody.**

```js
// server/systems/npc.js, inside init(ctx)
registerTargetProvider({
  id: 'npc',
  at(x, y)      { return mobAt(x, y) },
  byId(id)      { return mobById(id) },
  posOf(ref)    { return { x: ref.x, y: ref.y } },
  isAlive(ref)  { return ref.hp > 0 },
  kindOf(ref)   { return { kind: 'npc', type: ref.type } },
  teamOf(ref)   { return 'monsters' },
  statsFor(ref) { return ref.stats },
  applyDamage(ctx, ref, amount, meta) { /* npc writes its own hp here */ },
  applyHeal(ctx, ref, amount) {},
})
```

`combat` registers the `players` provider in its own `init`.
`targetAt(ctx, x, y)` walks the provider list and returns a uniform handle
`{ providerId, ref }`. Spells, mob AI and bombs all use that handle without
knowing whether they are hitting a player or a dragon.

`teamOf` is in the contract even though everyone is hostile to everyone
today. It is what lets teams be added later without a rewrite — do not
remove it.

Two more registries follow the same shape:

```js
registerDamagePipeline(priority, fn)  // (ctx, dmg) => dmg
onKill(fn)                            // (ctx, { killer, victim, victimKind, victimType })
```

Pipeline order by priority: `effects` (invulnerable cancels the hit; damage
taken multipliers) then `inventory` (gear multipliers and limiters). Each
stage registers from its own file, so `combat` stays generic and keeps
working while every other system is still `enabled: false`.

---

## 3. Effects: one layer for buffs, debuffs and gear

Every **durable** state in the game lives in `effects`, whatever produced it.
Instant damage does not — that is an event, not a state.

| Producer | Entry | Duration |
|---|---|---|
| Spell buff (Ice Block, War Cry) | `{ stats:{defense:+999}, flags:{invulnerable,rooted}, tick:{hp:+6, everyMs:500} }` | timed |
| Spell debuff (Hunter's Mark) | `{ taken:{ all:+20 } }` | timed |
| Potion | same shape | timed |
| Gear tier | `{ stats:{damage:+9}, dealt:{melee:+15} }` | permanent |
| Spawn protection | `{ flags:{invulnerable:true} }` | timed + condition |

The payoff: freezing, gear, potions and spawn protection become one tick
loop, one expiry path, one status-icon UI and one network shape. Adding
poison is a table row, not code.

### 3.1 How it folds into the existing profile machinery

`setModifier(ctx, player, sourceId, mods)` accepts one entry per `sourceId`,
and `pickStats` filters to `STAT_KEYS`. So `effects` sums all its active
entries and publishes a single modifier:

```js
function republish(ctx, player) {
  const sum = {}
  for (const e of player.ext.effects.active.values())
    for (const [k, v] of Object.entries(EFFECTS[e.id].stats ?? {}))
      sum[k] = (sum[k] ?? 0) + v * e.stacks

  const sig = JSON.stringify(sum)
  if (sig === player.ext.effects.sig) return   // <-- not optional
  player.ext.effects.sig = sig
  setModifier(ctx, player, 'effects', sum)
}
```

**The change gate is mandatory.** `setModifier` triggers `recompute()` which
sets `dirty = true`, and `profile.onTick` turns that into a private
`PROFILE_SELF` packet. Without the gate that is 15 packets per player per
second.

`inventory` keeps its own `setModifier(..., 'inventory', ...)` rather than
routing through `effects`: it is already a permanent single-source modifier,
and keeping them separate keeps the two features independently mergeable.

### 3.2 What must not go through modifiers

- **Booleans** (`invulnerable`, `rooted`, `silenced`, `stunned`). `pickStats`
  drops them. They live in `player.ext.effects.flags`, read via
  `effects.hasFlag(player, 'rooted')`.
- **Percent multipliers on a single hit** (`+20% damage taken`). The damage
  pipeline stage consumes those, not `deriveStats`.
- **Instant damage.** Modelling "Fireball deals 40" as a `-40 maxHp` buff
  would fight the clamp in `applyVitals`.

### 3.3 Effect table (`shared/effects.js`)

```js
export const EFFECTS = {
  iceBlock: { name:'Ice Block', icon:'🧊',
              flags:{ invulnerable:true, rooted:true, silenced:true },
              tick:{ hp:+6, everyMs:500 } },
  burning:  { name:'Burning',   icon:'🔥', tick:{ hp:-4, everyMs:500 } },
  marked:   { name:'Marked',    icon:'🎯', taken:{ all:+20 } },
  rooted:   { name:'Rooted',    icon:'🪢', flags:{ rooted:true } },
  stunned:  { name:'Stunned',   icon:'💫', flags:{ rooted:true, silenced:true } },
  rage:     { name:'Rage',      icon:'⚗',  stats:{ damage:+8 } },
  swift:    { name:'Swift',     icon:'🌀', stats:{ evasion:+6 } },
}
```

`rooted` needs a hook the core does not have yet: see
[Foundations](#foundations), `registerMoveGate`.

---

## 4. Spells

### 4.1 Definition shape (`shared/spells.js`)

Pure data and pure functions, mirroring `shared/profile.js`. The client
genuinely needs the table — icons, cooldowns, ranges, unlock levels, the
cooldown sweep maths — so duplicating it would drift. The client never
executes `actions`; the server is the only place that resolves them.

```js
export const SPELLS = {
  fireball: {
    id: 'fireball', name: 'Fireball', icon: '🔥',
    cls: 'mage', slot: 1,
    cooldownMs: 2400,
    intScaling: 0.9,          // how hard int cuts THIS cooldown (0..1)

    targeting: 'projectile',  // 'self'|'tile'|'ray'|'aoe'|'projectile'|'dash'
    range: 8, radius: 1,
    speedTps: 9,              // tiles per second, projectiles only
    pierce: false, stopsOnTerrain: true, requiresLos: true,

    fx: { color: 0xff7a3c, shape: 'orb', trail: true, impact: 'burst' },

    actions: [
      { type: 'damage', base: 18, scale: { int: 1.6 }, school: 'fire', target: 'hit' },
      { type: 'effect', effect: 'burning', ms: 3000, target: 'hit' },
    ],
  },
}

// Slot order is a fixed role convention, the same for every class:
//   [0] mobility spell   [1] special attack (higher cooldown)   [2] third basic
//   [3] unlocks at level 10                [4] unlocks at level 20
export const CLASS_SPELLS = {
  mage:    ['blink', 'fireball', 'lightningRay', 'frostNova', 'iceBlock'],
  warrior: ['charge', 'cleave', 'warCry', 'shieldWall', 'whirlwind'],
  hunter:  ['roll', 'piercingShot', 'huntersMark', 'trap', 'volley'],
}
export const UNLOCK_LEVELS = [1, 1, 1, 10, 20]  // by slot index

export function effectiveCooldown(def, stats) {
  const cdr = Math.min(45, (stats?.cdr ?? 0) * def.intScaling) / 100
  return Math.round(def.cooldownMs * (1 - cdr))
}
```

**Adding a spell is one table row.** Adding a new *kind* of spell is one entry
in the action registry inside `server/systems/spells.js`:

```js
const ACTIONS = { damage, heal, effect, teleport, dash, knockback, spawnZone, dispel }
export function registerAction(type, fn) { ACTIONS[type] = fn }
```

### 4.2 Resolution shapes

| `targeting` | C2S payload | Server resolution |
|---|---|---|
| `self` | `{ id }` | apply actions to the caster |
| `tile` | `{ id, tx, ty }` | validate range (Chebyshev) and LOS (Bresenham over `ctx.isWalkable`), then `targetsInRadius` |
| `ray` | `{ id, dir }` | walk up to `range` tiles from the caster, break on blocked terrain, hit everything on the way (`pierce` decides whether it stops at the first) |
| `aoe` | `{ id }` or `{ id, tx, ty }` | `targetsInRadius` around the caster or the target tile |
| `projectile` | `{ id, tx, ty }` | push into `world.ext.spells.projectiles`, advance in `onTick`, test `targetAt` on each tile change |
| `dash` | `{ id, dir }` | step up to `range` tiles, stop before the first blocked or occupied tile, then apply actions |

Projectiles **travel in the snapshot** (`snapshot.ext.spells.proj`), not only
in a one-shot event: the base's contract is "snapshots are full state", which
makes late joiners and packet loss self-healing. Keep the payload terse —
`{ i, s, x, y, vx, vy }` with positions in tenths of a tile. A one-shot
`SPELL_CAST_FX` starts the animation locally so the caster sees zero latency.

### 4.3 Mobs cast through the same executor

`castSpell(ctx, casterRef, spellId, target)` takes a **caster handle**, not a
player:

```js
{ providerId: 'players'|'npc', ref, x, y, dir, team, stats, cdUntil: Map }
```

A dragon's fireball is literally `SPELLS.fireball` with `cls: 'npc'`. No
duplicated projectile code.

### 4.4 Learning and unlocking

Five slots, always in the same shape: **three basic spells unlocked from
level 1**, a fourth at level 10, a fifth at level 20 — the same level as
`MAX_LEVEL` (§1.2), so the last spell arrives exactly when a player hits the
level cap for their class.

`spells.onPlayerJoin` seeds `known = CLASS_SPELLS[cls].slice(0, 3)`. On level
up it compares `profile.level` against `UNLOCK_LEVELS` and pushes newly
unlocked ids. The spellbook and cooldowns are private, so they go out with
`ctx.sendTo`, never in the snapshot.

The hotbar is six slots, not five: **attack is number 1**, then the five
`CLASS_SPELLS` slots take `2`–`6` in order, so `key = slotIndex + 2`. Combined
with the fixed role order above, that pins the same role to the same key on
every class regardless of which spell fills it:

| Key | `1` | `2` | `3` | `4` | `5` | `6` |
|---|---|---|---|---|---|---|
| Role | attack | mobility | special attack | third basic | unlock L10 | unlock L20 |

Each is bound with `ctx.action({ id, key: 'Digit1' … 'Digit6', ... })` — attack
included — which is what puts `⚔` and `S1`–`S5` on the action rail (§8) for
touch **and** the matching digit keys on desktop in the same call. A locked
slot still renders (opacity `.35`, lock glyph, §8) but its key press and
button tap both no-op client-side; the server rejects the cast regardless via
`SPELL_FAILED` if one somehow reaches it.

### 4.5 The spell sets

Key `1` (attack) is the shared `combat:attack` action, not part of
`CLASS_SPELLS` — every class's basic melee/ranged hit, whatever their weapon.
The tables below cover keys `2`–`6`.

**Mage** — four were specified; Frost Nova is a proposal.

| Key | Spell | Shape | Notes |
|---|---|---|---|
| 2 | **Blink** *(mobility)* | tile + `teleport` | range 5, instant, destination must be walkable and free |
| 3 | **Fireball** *(special attack)* | projectile, `speedTps 9` | splash radius 1, leaves `burning`, the heaviest cooldown of the three basics |
| 4 | **Lightning Ray** | ray, range 7 | instant, `pierce: true`, hits everything in the line |
| 5 | **Frost Nova** (L10) *(proposed)* | aoe radius 2 on self | small damage + `rooted 1.5s`. The escape enabler that pairs with Blink and sets up the ice theme. *Alternative:* **Arcane Barrier**, absorbs N damage for 6s, if a defensive slot is preferred |
| 6 | **Ice Block** (L20) | self | `flags {invulnerable, rooted, silenced}` + `tick {hp:+6 / 500ms}`, 4s. The spec's "total protection plus regeneration, immobile" |

**Warrior** — proposal.

| Key | Spell | Shape | Notes |
|---|---|---|---|
| 2 | **Charge** *(mobility)* | dash up to 4 tiles | stops at the first enemy, damage + `stunned 0.8s` |
| 3 | **Cleave** *(special attack)* | ray range 1, width 3 | a cone, instant, scales with `str`, longer cooldown than the plain attack |
| 4 | **War Cry** | self buff | +damage / +defense for 6s |
| 5 | **Shield Wall** (L10) | self | `taken -60%` for 4s with `slowed` attached — one effect carrying a buff *and* a debuff |
| 6 | **Whirlwind** (L20) | aoe radius 1 on self | hits everything, short cooldown. *Alternative:* **Execute**, heavy damage below 30% target HP |

**Hunter** — proposal.

| Key | Spell | Shape | Notes |
|---|---|---|---|
| 2 | **Roll** *(mobility)* | dash 3 tiles | passes through entities, +evasion for 1.5s |
| 3 | **Piercing Shot** *(special attack)* | projectile, `speedTps 14` | `pierce: true`, range 9, scales with `agi`, the hardest-hitting of the three basics |
| 4 | **Hunter's Mark** | tile, instant | `marked` for 8s: the victim takes +20% from everyone |
| 5 | **Trap** (L10) | spawnZone within 2 tiles | invisible to enemies, roots the first one to enter for 2s |
| 6 | **Volley** (L20) | spawnZone, radius 1 | ticking damage for 2s |

Between the three classes every `targeting` value and every `ACTIONS` entry
gets exercised, which is what keeps the registry honest.

---

## 5. Monsters

```js
const MOB_TYPES = {
  golem:  { hp:160, stats:{damage:14, defense:8, spellPower:100, cdr:0},  moveMs:520, aggro:7,  spells:['stoneSlam'],             weight:3 },
  dragon: { hp:220, stats:{damage:11, defense:5, spellPower:150, cdr:20}, moveMs:400, aggro:10, spells:['fireball','fireBreath'], weight:1 },
  wisp:   { hp: 60, stats:{damage: 7, defense:2, spellPower:110, cdr:10}, moveMs:240, aggro:8,  spells:['spark'],                 weight:4 },
  imp:    { hp: 90, stats:{damage: 9, defense:3, spellPower:120, cdr:15}, moveMs:320, aggro:9,  spells:['hex'],                   weight:3 },
}
const MAX_MOBS = 24, SPAWN_INTERVAL_MS = 2500, MIN_SPAWN_DIST = 10
```

**Tick budget at 15 Hz.** Every mob carries a `nextThinkAt` with a randomised
200–400 ms think interval, so roughly 10–14 think per tick rather than all 24.
Movement is greedy single-tile stepping — dominant axis first, fall back to
the other, random unstick after three blocked attempts. **No pathfinding**:
the arena is open, and A* on 24 mobs at 15 Hz is exactly where this would fall
over.

`npc.init` calls `registerBlocker((x, y) => mobAt(x, y) !== null)` — the hook
already exists in `server/game/state.js` and nothing uses it yet — plus
`registerTargetProvider`.

Snapshot payload stays terse: `{ m: [[id, typeIdx, x, y, dir, hp, maxHp], ...] }`.

---

## 6. Gear tiers and the shop

Not items: a monotonically increasing tier counter per slot, bought with
coins. Coins reuse `profile.gold`, which already exists, is already private
and already has a HUD readout.

```js
export const GEAR = {
  weapon: { label:'Sword', icon:'⚔', restrict:null,
    tiers:[ {}, {cost:60,  mods:{damage:+4}},
                {cost:150, mods:{damage:+9}},
                {cost:320, mods:{damage:+16}} ] },
  armor:  { label:'Armor', icon:'🛡', restrict:null,
    tiers:[ {}, {cost:70,  mods:{defense:+4, maxHp:+15}},
                {cost:170, mods:{defense:+9, maxHp:+35}}, ... ] },
  focus:  { label:'Staff', icon:'🔮', restrict:['mage'],
    tiers:[ {}, {cost:80,  mods:{spellPower:+8, cdr:+3}},
                {cost:190, mods:{spellPower:+18, cdr:+7}}, ... ] },
  boots:  { label:'Boots', icon:'👢', restrict:null,
    tiers:[ {}, {cost:50,  mods:{evasion:+3}, mult:{taken:-4}}, ... ] },
}
```

Buying: `INVENTORY_BUY { slot }` buys the next tier only, charges through
`spendGold` (already atomic — it returns `false` and changes nothing when the
player cannot pay), recomputes the summed `mods`, and publishes **one**
`setModifier(ctx, player, 'inventory', sum)`.

Anything that is not a `STAT_KEY` — `mult: { taken:-4, dealt:+6, meleeOnly:true }`
— is not a modifier. The damage pipeline stage that `inventory` registers with
`combat` reads it. That is where damage multipliers and limiters live.

---

## 7. Ground loot

```js
const DROP_TYPES = {
  healPotion:  { icon:'🧪', onPickup: (ctx,p) => heal(ctx, p, 45) },
  ragePotion:  { icon:'⚗',  onPickup: (ctx,p) => applyEffect(ctx, p, 'rage', 8000) },
  swiftPotion: { icon:'🌀', onPickup: (ctx,p) => applyEffect(ctx, p, 'swift', 8000) },
  coins:       { icon:'🪙', onPickup: (ctx,p) => addGold(ctx, p, 25) },
  bomb:        { icon:'💣', fuseMs:3000, radius:2, damage:55 },  // arms on drop, never picked up
}
const DROP_TTL_MS = 45_000
```

Potions are **consumed by walking over them** — no extra buttons, no
inventory. The bomb is the exception: it arms where it lands and detonates on
a timer, so it is an area-denial hazard rather than a pickup. That matches
"explodes on a timer" and is more interesting than another consumable.

Drops spawn from `combat.onKill` at the victim's tile, or the nearest free
tile if it is occupied. Pickup runs in `loot.onTick` as one `byTile` lookup
per player — O(players), not O(drops).

---

## 8. Mobile layout

Landscape budget, roughly 740×380 CSS px.

```
┌──────────────────────────────────────────────────────┐
│ stats                                 debug     [💬] │
│ chat log                                        [🛒] │  utility column
│                                                 [👤] │  (top right)
│                                                      │
│                                    [4][5][6]         │  rail row 2
│   ← stick zone 46%×62% →           [1][2][3]         │  rail row 1 (thumb)
└──────────────────────────────────────────────────────┘
```

- The action rail holds **attack plus five spells**, keys `1`–`6` (§4.4):
  52×52 px buttons, three per row, two rows, about 124 px of the 380
  available. Row 1 (thumb row) is attack, mobility, special attack — the
  three actions used on reflex; row 2 holds the third basic and the two
  level-gated unlocks.
- Locked spells render at `opacity .35` with a lock glyph until their level.
- The cooldown sweep is a `conic-gradient` driven by one CSS custom property
  updated in `onUpdate`. No extra DOM, no Pixi.
- The utility column sits top right, which is not a reserved zone, and holds
  the shop and profile buttons alongside the existing chat toggle.
- The shop is a centred modal:
  `width: min(520px, 92vw); max-height: min(300px, calc(var(--app-h) - 60px))`,
  one row per slot with 44 px buy buttons, digit keys 1–4 on desktop. The world
  keeps running while it is open, so every purchase must be a single tap.

### 8.1 Targeting without a second tap

This is the decision that makes or breaks the phone experience.

- `self` spells cast immediately.
- `ray` and `dash` spells always use the stick's current facing — nothing to aim.
- Everything else: **tap casts at the auto-target**, the nearest enemy in
  range inside the facing cone. The client proposes a target; the server
  re-validates and may pick its own. Server-authoritative, always.
- **Long-press (250 ms) enters manual aim**: a reticle appears, drag to place
  it, release to cast. Dragging back onto the button cancels.

### 8.2 Render layers

`client/src/render/stage.js` already exposes `ground / floor / entities / fx /
overlay` under the camera, and `entities` is already `sortableChildren`. No
core render change is needed.

| Visual | Layer | Owner |
|---|---|---|
| Drops, trap markers, AoE telegraphs | `floor` | `loot`, `spells` |
| Mobs (`zIndex = worldY`) | `entities` | `npc` |
| Projectiles, beams, impacts, hit flashes | `fx` | `spells`, `combat` |
| Floating damage numbers | `fx` | `combat` (exports `floatText`) |
| Status icons above heads, kill feed | `overlay` | `effects`, `combat` |

Each client system creates its own `Container` and adds it to the layer in
`init`, so nothing collides. FX anchor to players through the existing
`viewPosition(id)` in `client/src/render/entities.js`; `npc` exports
`mobViewPosition(id)` for the same job on mobs.

---

## 9. Protocol

Appended to `shared/protocol.js` in per-system blocks, per the file's own
rules.

```js
// C2S
  COMBAT_ATTACK:  'combat:attack',    // {}  melee in the facing direction
  COMBAT_RESPAWN: 'combat:respawn',   // {}  early respawn once the timer allows
  SPELL_CAST:     'spells:cast',      // { id, tx?, ty?, dir? }
  INVENTORY_BUY:  'inventory:buy',    // { slot }

// S2C
  COMBAT_HIT:       'combat:hit',       // { x, y, kind, id, amount, crit, school, byId }
  COMBAT_DEATH:     'combat:death',     // { kind, id, name, killerId, killerName }
  COMBAT_RESPAWNED: 'combat:respawned', // { id, x, y, protectedMs }
  COMBAT_KILLFEED:  'combat:killfeed',  // { killerName, victimName, victimKind, reward:{exp,coins} }
  EFFECTS_SELF:     'effects:self',     // owner only { active:[{id, endsAt, stacks}] }
  SPELL_BOOK:       'spells:book',      // owner only { known:[{id, slot, unlocked}] }
  SPELL_COOLDOWN:   'spells:cooldown',  // owner only { id, untilMs }
  SPELL_CAST_FX:    'spells:castFx',    // { casterKind, casterId, id, x0,y0, tx,ty, dir, projId? }
  SPELL_RAY:        'spells:ray',       // { id, x0,y0, x1,y1 }
  SPELL_IMPACT:     'spells:impact',    // { id, x, y, radius }
  SPELL_FAILED:     'spells:failed',    // owner only { id, reason }
  INVENTORY_SELF:   'inventory:self',   // owner only { tiers, nextCosts }
  LOOT_PICKED:      'loot:picked',      // { id, byId, type }
  LOOT_EXPLODE:     'loot:explode',     // { id, x, y, radius }
```

Continuous state — mobs, projectiles, drops, public status icons, the
scoreboard — rides `snapshot.ext.<systemId>`. One-shots and private data ride
events.

---

## Foundations

The additive core changes this specification depends on. They are additive
helpers, not restructuring, which `CLAUDE.md` explicitly allows. They all land
in milestone M0 — see `ROADMAP.md`.

| Change | File | Why |
|---|---|---|
| `archer` → `hunter` | `shared/constants.js`, `shared/profile.js`, `client/index.html` | class list |
| `spellPower` and `cdr` in `STAT_KEYS` and `deriveStats` | `shared/profile.js` | intelligence needs somewhere to land |
| Mana removed entirely — the derived stats, the HUD (the MP bar becomes an XP bar) and the `player.mana` core fields | `shared/profile.js`, `server/systems/profile.js`, `shared/constants.js`, `server/game/state.js`, `client/src/ui/hud.js`, `client/index.html` | there is no mana. Leaving dead fields on the player would just invite a system to start writing them |
| `MAX_LEVEL` / `GROWTH_TOTAL` / `attributesAtLevel` applied inside `addExp` | `shared/profile.js`, `server/systems/profile.js` | attributes grow toward a fixed per-class target, capped at a shared max level |
| `registerMoveGate(fn)` plus one guard in the `MOVE` handler | `server/game/state.js`, `server/systems/core.js` | `rooted` and `stunned` need to stop movement without hacking the core |
| `ctx.action({ ..., slot: 'rail'\|'utility' })` and an `#actions-utility` container built in JS | `client/src/ui/touch.js`, `CLAUDE.md` | nine buttons do not fit one rail, and every feature author inventing their own floating button is worse |
