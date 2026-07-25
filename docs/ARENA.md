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
| Death | You keep level, spells, attributes and gear, and lose **half your coins to your killer**. You respawn with full HP after a short delay, with brief spawn protection. You drop loot on the ground |
| Level cap | **20**. Attributes at any level are a linear interpolation between the class's level 1 and level 20 blocks — a pure function of class and level, with no manual point spending |
| Experience | Flat per victim: each class and each monster type is worth a different amount, but who you killed does not steer which attribute grows |
| Mana | Does not exist. Cooldown is the only limit on spells |
| Cooldown reduction | **Global and identical for every spell**: linear in intelligence, `[0, 150]` of `int` mapping onto `[0%, 50%]` |
| Spell damage | Tuned per spell by a `base` and a `scaling` factor saying how much of that spell's damage derives from its attribute |
| Gear | Accumulating tiers (sword / armor / staff / boots), never individual items |

### 1.1 What each attribute drives

| Attribute | Drives |
|---|---|
| `str` | damage of strength-scaling spells, and part of max HP |
| `agi` | movement speed, and damage of agility-scaling spells |
| `int` | cooldown reduction, and damage of intelligence-scaling spells |
| `con` | max HP |

Note what is **not** here: no attribute feeds `defense` or `evasion`. Those
become gear-and-effect stats only — armor and boots are the only way to raise
them. That is deliberate: it keeps gear meaningful next to a level curve that
is otherwise fully determined by class.

One shared reference ceiling anchors every formula:

```js
export const ATTR_MAX = 150   // what the specialising class reaches at level 20
```

Derived stats:

```js
maxHp:     40 + a.con * 4 + Math.round(a.str * 1.5),
cdr:       Math.min(CDR_MAX_PCT, (a.int / ATTR_MAX) * CDR_MAX_PCT),  // percent
moveSpeed: Math.min(MOVE_MAX_PCT, (a.agi / ATTR_MAX) * MOVE_MAX_PCT), // percent
damage:    0,        // flat bonus, gear and effects only
defense:   0,        // gear and effects only
evasion:   0,        // gear and effects only
```

`cdr` and `moveSpeed` are **integer percentages**, because `deriveStats`
rounds every stat. The caps are applied again at the use site so that gear
can add to them without ever breaking the ceiling.

### 1.2 Cooldown reduction

Global and identical for every spell — there is no per-spell cooldown
scaling. Linear in intelligence, mapping `[0, 150]` of `int` onto `[0%, 50%]`
of reduction:

```js
export const CDR_MAX_PCT = 50

export function effectiveCooldown(def, stats) {
  const cdr = Math.min(CDR_MAX_PCT, stats?.cdr ?? 0) / 100
  return Math.round(def.cooldownMs * (1 - cdr))
}
```

So a mage at level 20 (`int` 150) fires everything at half its base cooldown,
and a warrior at level 20 (`int` 40) at about 87%. Gear that grants `cdr` adds
into the same stat and is clamped by the same 50% ceiling.

### 1.3 Movement speed

Same shape, driven by agility. It reduces the move cooldown rather than
raising a speed:

```js
export const MOVE_MAX_PCT = 40

// effective move cooldown, in server/systems/core.js
MOVE_COOLDOWN_MS * (1 - Math.min(MOVE_MAX_PCT, stats.moveSpeed) / 100)
```

A hunter at level 20 (`agi` 150) walks at 84 ms per tile instead of 140 ms.
This needs one additive line in the core `MOVE` handler — see
[Foundations](#foundations).

### 1.4 Attributes by level

Level max is **20**. A character's attributes are a **pure function of class
and level**: linear interpolation between the level 1 block and the level 20
block, which is different for every class.

```js
export const LEVEL_MAX = 20

export const BASE_ATTRIBUTES = {   // level 1
  warrior: { str:  20, agi: 12, int:  8, con:  25 },
  mage:    { str:   8, agi: 14, int: 25, con:  12 },
  hunter:  { str:  12, agi: 25, int: 12, con:  15 },
}

export const MAX_ATTRIBUTES = {    // level 20
  warrior: { str: 130, agi:  60, int:  40, con: 150 },
  mage:    { str:  40, agi:  70, int: 150, con:  70 },
  hunter:  { str:  70, agi: 150, int:  75, con:  90 },
}

export function attributesForLevel(cls, level) {
  const t = (clamp(level, 1, LEVEL_MAX) - 1) / (LEVEL_MAX - 1)
  const lo = BASE_ATTRIBUTES[cls], hi = MAX_ATTRIBUTES[cls]
  return Object.fromEntries(
    ATTRIBUTES.map((k) => [k, Math.round(lo[k] + (hi[k] - lo[k]) * t)]),
  )
}
```

This is a real simplification over accumulating growth: **`profile.attributes`
stops being mutable state and becomes derived**, exactly like `stats`.
`recompute()` calls `attributesForLevel(cls, level)` and that is the whole
progression system. Consequences:

- `POINTS_PER_LEVEL`, `STARTING_POINTS` and `profile.points` are removed.
- The `PROFILE_SPEND_POINT` handler is removed along with its C2S event and
  the `+` buttons in the client profile panel.
- Nothing can ever desync a player's attributes from their level, so there is
  no migration or repair path to write.

Tune a class by editing two rows. The level 20 numbers are what balance
actually turns on: `MAX_ATTRIBUTES.mage.int = 150` is what grants the mage the
full 50% cooldown reduction, and `MAX_ATTRIBUTES.hunter.agi = 150` is what
grants the hunter the full 40% movement bonus.

`expForLevel` needs re-tuning for a 20-level curve — the current
`50 * level * (level + 1)` was written for 50 levels.

### 1.5 Kill rewards

Experience is flat per victim. **Coins are not**: a player pays their killer
out of their own purse, and a monster pays from a table because it has none.

```js
export const XP_REWARD = {
  player: { warrior: 130, mage: 140, hunter: 135 },  // scaled by the victim's level
  npc:    { bat: 22, skeleton: 30, golem: 55, dragon: 95 },
}

/** Minted coins. Monsters only — a player has a purse to take from. */
export const COIN_REWARD = {
  npc:    { bat: 7, skeleton: 10, golem: 14, dragon: 26 },
}

/** What a killer takes from a player victim. A transfer, not a mint. */
export const PURSE_LOOT_PCT = 50

/** Floor, so beating someone who happens to be broke is not worth nothing. */
export const MIN_KILL_COINS = 8

export const REPEAT_KILL_WINDOW_MS = 45_000
```

A bat is worth roughly a quarter of a dragon, which is about the ratio of
effort: the dragon is the only monster that can actually kill a healthy
player, and the bat is a mosquito that flees on contact.

`rewardFor` returns `{ exp, coins, fromPurse }`: `coins` is what the killer
receives and `fromPurse` is how much of it is charged to the victim. They are
equal for a normal kill; they diverge only when the purse is too thin to reach
`MIN_KILL_COINS`, and the difference is the only minted part. Charging
`fromPurse` rather than `coins` is what guarantees no player is ever billed
gold they did not have.

Looting half the purse is a **transfer**: the victim loses exactly what the
killer gains. Two consequences worth stating, because they replace rules the
first draft needed:

- **Player coins cannot inflate.** The gear prices in §6 are set against a
  fixed pool of coins, which monsters top up at a rate the spawner controls.
- **It is the sharpest anti-snowball lever there is,** and the only one that
  makes dying cost anything at all. A broke player is worth only the floor, so
  spawn-camping the same victim collapses to a coin a kill; a rich leader is
  worth hunting, which is the bounty effect the levers below wanted, arrived
  at from the other direction.

The transfer deliberately does **not** go through the multipliers. They exist
to limit minting, and scaling a transfer down would simply delete the
difference from the economy. Experience, monster coins and the floor do go
through them — which is precisely what stops the floor from being farmable:

Anti-snowball levers (at least two must be on): diminishing XP by killer level
(`1 - lvl * 0.02`, floor `0.25`), decay for repeatedly killing the same victim
inside `REPEAT_KILL_WINDOW_MS`, and a bounty multiplier that makes the current
leader worth more.

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
    for (const [k, v] of Object.entries(e.params.stats ?? {}))
      sum[k] = (sum[k] ?? 0) + v * e.stacks

  const sig = JSON.stringify(sum)
  if (sig === player.ext.effects.sig) return   // <-- not optional
  player.ext.effects.sig = sig
  setModifier(ctx, player, 'effects', sum)
}
```

Note it reads `e.params`, the **instance**, not the definition — see §3.3.

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

### 3.3 Definition versus instance

A first draft of this table baked the magnitude into the definition:

```js
burning: { name:'Burning', icon:'🔥', tick:{ hp:-4, everyMs:500 } }   // WRONG
```

That makes every burn in the game identical. Two spells that both apply
`burning`, where one is meant to burn harder than the other, cannot be
expressed at all.

The fix is to split the two things that were conflated. **The definition
declares identity and behaviour; the application site supplies the
magnitude; the instance stores the resolved numbers.**

```js
// shared/effects.js — WHAT the effect is, and what it can be tuned by
export const EFFECTS = {
  burning: {
    name: 'Burning', icon: '🔥',
    kind: 'dot',                    // which runtime path handles it
    everyMs: 500,
    stacking: 'strongest',
    defaults: { tick: { hp: -4 } }, // used when the caller says nothing
  },
  iceBlock: {
    name: 'Ice Block', icon: '🧊',
    kind: 'aura', everyMs: 500, stacking: 'refresh',
    defaults: {
      flags: { invulnerable: true, rooted: true, silenced: true },
      tick:  { hp: +6 },
    },
  },
  poisoned: {
    name: 'Poisoned', icon: '🧪',
    kind: 'dot', everyMs: 1000, stacking: 'strongest',
    defaults: { tick: { hp: -3 } },
  },
  marked: { name:'Marked', icon:'🎯', kind:'aura', stacking:'refresh',
            defaults: { taken: { all: +20 } } },
  rooted: { name:'Rooted', icon:'🪢', kind:'aura', stacking:'refresh',
            defaults: { flags: { rooted: true } } },
  rage:   { name:'Rage',   icon:'⚗', kind:'aura', stacking:'strongest',
            defaults: { stats: { damage: +8 } } },
}
```

`poisoned` ticks once a second rather than twice like `burning`: it is the
bat's whole contribution and it should read as a slow drain the victim has
time to notice, not a burst.

A spell overrides whatever it wants when it applies the effect:

```js
// a weak burn
{ type:'effect', effect:'burning', ms:3000 }

// a hard burn, from a bigger spell
{ type:'effect', effect:'burning', ms:5000, params:{ tick:{ hp:-11 } } }
```

And the stored instance carries the **resolved** values:

```js
{ id:'burning', endsAt, params:{ tick:{ hp:-11 } }, sourceId, stacks, nextTickAt }
```

```js
export function resolveParams(effectId, overrides, casterStats) {
  const def = EFFECTS[effectId]
  return deepMerge(def.defaults, typeof overrides === 'function'
    ? overrides(casterStats)     // lets a DoT scale with the caster's int
    : overrides ?? {})
}
```

Params are resolved **once, at application time**, from the caster's stats as
they were at that moment. A DoT does not get weaker because its caster died,
swapped gear or was debuffed mid-burn. That is both simpler to reason about
and cheaper than re-reading the caster every tick.

### 3.4 Stacking

Two `burning` instances landing on the same victim is a real case, so the
policy is part of the definition rather than an implicit rule:

| `stacking` | Behaviour | Instance key |
|---|---|---|
| `refresh` | The newest replaces the old one and brings its own params. Control effects — root, stun, Ice Block | `effectId` |
| `strongest` | The bigger magnitude wins; the weaker one is discarded or kept dormant. DoTs and stat buffs — burning, rage | `effectId` |
| `stack` | Independent instances that all tick, up to `maxStacks` | `effectId + sourceId` |
| `perSource` | One instance per caster, each with its own params | `effectId + sourceId` |

`strongest` is the right default for `burning`: two mages burning the same
target does not double the damage, but the stronger spell wins — which is what
makes tuning one spell to burn harder than another actually mean something.

`rooted` needs a hook the core does not have yet: see
[Foundations](#foundations), `registerMoveGate`.

---

## 4. Spells

### 4.1 Definition shape (`shared/spells.js`)

Pure data and pure functions, mirroring `shared/profile.js`. The client
genuinely needs the table — icons, cooldowns, ranges, unlock levels, the
cooldown sweep maths — so duplicating it would drift. The client never
executes `actions`; the server is the only place that resolves them.

> **Distances in this document are in BLOCKS.** A block is the 32 px square
> terrain is built from; coordinates are in tiles, four times finer. Every
> `range`, `radius`, `width`, `aggro` and `speedTps` below reads in blocks and
> goes through `blocksToTiles()` the moment it meets a coordinate. Skipping
> that conversion makes every number a quarter of its intended reach — see
> "Tiles, blocks and distances" in CLAUDE.md.

```js
export const SPELLS = {
  fireball: {
    id: 'fireball', name: 'Fireball', icon: '🔥',
    cls: 'mage', slot: 1,
    cooldownMs: 2400,         // reduced globally by cdr — no per-spell cooldown scaling

    targeting: 'projectile',  // 'melee'|'nearest'|'self'|'tile'|'ray'|'aoe'|'projectile'|'dash'
    range: 8, radius: 1,      // BLOCKS — blocksToTiles() before touching coords
    speedTps: 9,              // blocks per second, projectiles only
    pierce: false, stopsOnTerrain: true, requiresLos: true,

    fx: { color: 0xff7a3c, shape: 'orb', trail: true, impact: 'burst' },

    actions: [
      { type: 'damage', base: 30, attr: 'int', scaling: 1.2, school: 'fire', target: 'hit' },
      { type: 'effect', effect: 'burning', ms: 3000, params: { tick: { hp: -7 } }, target: 'hit' },
    ],
  },
}

export const CLASS_SPELLS = {
  mage:    ['fireball', 'lightningRay', 'blink', 'frostNova', 'iceBlock'],
  warrior: ['bash', 'charge', 'whirlwind', 'warCry', 'shieldWall'],
  hunter:  ['piercingShot', 'trap', 'huntersMark', 'roll', 'volley'],
}
export const UNLOCK_LEVELS = [1, 1, 1, 8, 14]   // by slot index, out of LEVEL_MAX 20
```

### 4.2 The two balance knobs on a spell

Each damaging action carries the two numbers that tune it, and nothing else:

```js
{ type:'damage', base: 30, attr: 'int', scaling: 1.2 }
```

| Field | Meaning |
|---|---|
| `base` | damage at attribute 0 — the floor the spell always delivers |
| `attr` | which attribute scales it: `'str'`, `'agi'` or `'int'` |
| `scaling` | **how much of the damage derives from stats** |

```js
export function spellDamage(action, attrs, stats) {
  const a = attrs[action.attr] ?? 0
  const scaled = action.base * (1 + action.scaling * (a / ATTR_MAX))
  return Math.round(scaled + (stats.damage ?? 0))   // gear/effect flat bonus on top
}
```

`scaling` reads directly as a multiplier at the ceiling:

| `scaling` | Damage at `ATTR_MAX` | Character |
|---|---|---|
| `0` | `base` | ignores stats entirely — utility spells, traps |
| `0.5` | `1.5 × base` | mostly flat, mildly rewarded by stats |
| `1` | `2 × base` | the normal case |
| `2` | `3 × base` | a scaling payoff spell that is weak early and dominant at 20 |

So a spell is balanced by moving `base` (how strong it is at level 1) and
`scaling` (how much it grows). Two spells can share an attribute and still
have completely different curves — which is exactly the lever that was missing.

The choice of `attr` is what makes a spell belong to its class in practice: a
`str`-scaling spell in a mage's hands stays near its `base` forever, because
`MAX_ATTRIBUTES.mage.str` is only 40.

**Adding a spell is one table row.** Adding a new *kind* of spell is one entry
in the action registry inside `server/systems/spells.js`:

```js
const ACTIONS = { damage, heal, effect, teleport, dash, knockback, spawnZone, dispel }
export function registerAction(type, fn) { ACTIONS[type] = fn }
```

### 4.3 Resolution shapes

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

### 4.4 Mobs cast through the same executor

`castSpell(ctx, casterRef, spellId, target)` takes a **caster handle**, not a
player:

```js
{ providerId: 'players'|'npc', ref, x, y, dir, team, stats, cdUntil: Map }
```

A dragon's fireball is literally `SPELLS.fireball` with `cls: 'npc'`. No
duplicated projectile code.

### 4.5 Learning and unlocking

`spells.onPlayerJoin` seeds `known = CLASS_SPELLS[cls].slice(0, 3)`. On level
up it compares `profile.level` against `UNLOCK_LEVELS` and pushes newly
unlocked ids. The spellbook and cooldowns are private, so they go out with
`ctx.sendTo`, never in the snapshot.

### 4.6 The spell sets

The **basic melee attack is slot 0**, a spell definition like any other:
`targeting: 'melee'`, range 1, `attr: 'str'`, a short cooldown, available to
every class from level 1. That keeps the ⚔ button on the same code path as
everything else instead of a parallel implementation inside `combat`.

Each class's spells scale off its own attribute — `int` for the mage, `str`
for the warrior, `agi` for the hunter — with the exceptions noted below.
Utility spells use `scaling: 0`.

**Mage** — four were specified; slot 4 is a proposal.

| # | Spell | Shape | Notes |
|---|---|---|---|
| 1 | **Fireball** | projectile, `speedTps 9` | splash radius 1, leaves `burning` |
| 2 | **Lightning Ray** | ray, range 7 | instant, `pierce: true`, hits everything in the line |
| 3 | **Blink** | tile + `teleport` | range 5, instant, destination must be walkable and free |
| 4 | **Frost Nova** *(proposed)* | aoe radius 2 on self | small damage + `rooted 1.5s`. The escape enabler that pairs with Blink and sets up the ice theme. *Alternative:* **Arcane Barrier**, absorbs N damage for 6s, if a defensive slot 4 is preferred |
| 5 | **Ice Block** (L14) | self | `flags {invulnerable, rooted, silenced}` + `tick {hp:+6 / 500ms}`, 4s. The spec's "total protection plus regeneration, immobile" |

**Warrior** — proposal.

| # | Spell | Shape | Notes |
|---|---|---|---|
| 1 | **Bash** | `nearest`, range 2 | the class's own strike: hits the closest enemy in reach with no aiming, harder than the universal Attack |
| 2 | **Charge** | dash 4 blocks, `phasing` + `sweeps` | runs through the line, damaging and stunning everyone it crossed |
| 3 | **Whirlwind** | aoe radius 1 on self | a 360° swing, hits everything around, short cooldown |
| 4 | **War Cry** (L8) | self buff | +damage / +defense for 6s |
| 5 | **Shield Wall** (L14) | self | `taken -60%` for 4s with `slowed` attached — one effect carrying a buff *and* a debuff |

**Hunter** — proposal.

| # | Spell | Shape | Notes |
|---|---|---|---|
| 1 | **Piercing Shot** | projectile, `speedTps 14` | `pierce: true`, range 9, scales with `agi` |
| 2 | **Trap** | spawnZone within 2 tiles | invisible to enemies, roots the first one to enter for 2s |
| 3 | **Hunter's Mark** | tile, instant | `marked` for 8s: the victim takes +20% from everyone |
| 4 | **Roll** (L8) | dash 3 tiles | passes through entities, +evasion for 1.5s |
| 5 | **Volley** (L14) | spawnZone, radius 1 | ticking damage for 2s |

Between the three classes every `targeting` value and every `ACTIONS` entry
gets exercised, which is what keeps the registry honest.

---

## 5. Monsters

Four types, each with a different reason to exist: the golem is a wall, the
dragon is the real threat, the skeleton is an obstacle, and the bat is a
nuisance that never stays to fight.

```js
const MOB_TYPES = {
  dragon: {
    hp: 280, attrs:{ str: 70, agi: 45, int:120, con:100 }, stats:{ damage:+4, defense: 6 },
    moveMs: 400, aggro: 10, behaviour: 'brawler', weight: 1,
    spells: ['fireBreath', 'tailSweep', 'clawSwipe'],
  },
  golem: {
    hp: 240, attrs:{ str:130, agi: 10, int:  5, con:130 }, stats:{ damage:+6, defense:12 },
    moveMs: 560, aggro:  6, behaviour: 'brawler', weight: 3,
    spells: ['boulder', 'stoneFist'],
  },
  skeleton: {
    hp:  80, attrs:{ str: 20, agi: 35, int: 45, con: 30 }, stats:{ damage: 0, defense: 3 },
    moveMs: 340, aggro:  8, behaviour: 'brawler', weight: 4,
    spells: ['chill'],
  },
  bat: {
    hp:  45, attrs:{ str: 10, agi:120, int: 60, con: 15 }, stats:{ damage: 0, defense: 1 },
    moveMs: 200, aggro:  9, behaviour: 'hitAndRun', weight: 4,
    spells: ['venomBite'],
  },
}
const MAX_MOBS = 24, SPAWN_INTERVAL_MS = 2500, MIN_SPAWN_DIST = 10
```

Mobs carry an `attrs` block on the same `[0, 150]` scale as players, so
`spellDamage()` and `effectiveCooldown()` work on them unchanged — a mob is
just another caster handle. Their `hp` is authored directly rather than
derived, because a mob has no level curve to interpolate. `moveMs` is
likewise authored rather than derived from `agi`: mob movement does not go
through the player `MOVE` handler.

### 5.1 Monster abilities

They are ordinary rows in `shared/spells.js` with `cls: 'npc'`, which is the
whole point of mobs casting through the same executor. Nothing here needs a
new `targeting` shape or a new action.

| Monster | Ability | Shape | Notes |
|---|---|---|---|
| **Dragon** | **Claw Swipe** | melee, range 1 | the filler. Short cooldown, `str`-scaling |
| | **Tail Sweep** | aoe radius 1 on self | occasional. Hits everything around it and knocks it back — the one user of the `knockback` action |
| | **Fire Breath** | ray range 4, width 3, pierce | the real threat. Long cooldown, `int`-scaling, leaves `burning` on everything in the cone |
| **Golem** | **Stone Fist** | melee, range 1 | slow and very heavy, `str`-scaling |
| | **Boulder** | projectile, slow, splash radius 1 | a lobbed rock. `str`-scaling, telegraphed by how slowly it travels |
| **Skeleton** | **Chill** | tile, range 4 | its only ability: `rooted` for a moment and **1–2 damage**. See below |
| **Bat** | **Venom Bite** | melee, range 1 | its only ability: applies `poisoned` and then the bat leaves |

**The skeleton is meant to be an obstacle, not a threat.** `Chill` is authored
with `base: 2, scaling: 0` — it ignores the caster's attributes entirely, so it
deals the same trivial damage forever and cannot scale into relevance. The
point is the root: it interrupts a chase, not a life bar. It is deliberately
*not* zero, because `spellDamage` floors at 1 and a skeleton finishing off
someone who was already nearly dead is a good story rather than a bug. Do not
"fix" that by making it harmless.

**The bat never fights.** `behaviour: 'hitAndRun'` is what makes it approach,
apply `poisoned`, and immediately retreat for a few seconds before considering
another pass. Its damage is entirely in the DoT, so a bat that is chased down
and killed has already done its whole job.

This adds one row to `shared/effects.js`:

```js
poisoned: { name:'Poisoned', icon:'🧪', kind:'dot', everyMs:1000,
            stacking:'strongest', defaults:{ tick:{ hp:-3 } } },
```

### 5.2 AI

**Ability choice is a data question, not a decision tree.** `spells` is in
priority order and the mob casts **the first one that is off cooldown and
whose range covers the target**. That is why the dragon lists
`['fireBreath', 'tailSweep', 'clawSwipe']`: the long-cooldown abilities get
first refusal and the claw is what is left over. Retuning a monster means
reordering a list.

**Behaviour** is one field with two values today:

| `behaviour` | Movement |
|---|---|
| `brawler` | close on the nearest player inside `aggro` and stay there |
| `hitAndRun` | close, cast, then retreat for `RETREAT_MS` before approaching again |

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
    tiers:[ {}, {cost:80,  mods:{cdr:+3,  damage:+3}},
                {cost:190, mods:{cdr:+7,  damage:+8}}, ... ] },
  boots:  { label:'Boots', icon:'👢', restrict:null,
    tiers:[ {}, {cost:50,  mods:{moveSpeed:+4, evasion:+3}, mult:{taken:-4}}, ... ] },
}
```

`damage` is a **flat bonus added after** `spellDamage()` scales the spell, so
gear helps a level 1 character noticeably and a level 20 one marginally —
which is what keeps the shop relevant early without letting it decide fights
late. `cdr` and `moveSpeed` from gear are clamped by the same global ceilings
as the attribute-derived part, so a mage with a tier 3 staff still cannot pass
50% cooldown reduction.

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
  xpOrb:       { icon:'🔹', onPickup: (ctx,p) => addExp(ctx, p, 35) },
  bomb:        { icon:'💣', fuseMs:3000, radius:2, damage:55 },  // arms on drop, never picked up
}
const DROP_TTL_MS = 45_000
```

Potions are **consumed by walking over them** — no extra buttons, no
inventory. The bomb is the exception: it arms where it lands and detonates on
a timer, so it is an area-denial hazard rather than a pickup. That matches
"explodes on a timer" and is more interesting than another consumable.

Pickup runs in `loot.onTick` as one `byTile` lookup per player — O(players),
not O(drops) — and asks the same body-overlap question every area effect asks,
so a drop is collected by touching it rather than by centring on it.

### 7.1 Two sources: kills and the world itself

**Kill drops** spawn from `combat.onKill` at the victim's tile, or the nearest
free tile if it is occupied.

**World drops** appear on their own, so the map is worth walking around even
when nothing is dying on it. That is the difference between an arena and a
lobby: a player with nothing to fight still has somewhere to go.

```js
const WORLD_SPAWN_INTERVAL_MS = 12_000
const MAX_WORLD_DROPS = 18
const WORLD_MIN_PLAYER_DIST = 6      // blocks
const WORLD_DROP_TTL_MS = 120_000    // outlive a kill drop: nobody saw them land

const WORLD_SPAWN_TABLE = [
  ['coins', 40],
  ['healPotion', 25],
  ['xpOrb', 20],
  ['ragePotion', 8],
  ['swiftPotion', 7],
]
```

Rules that keep it from being annoying rather than generous:

- **Never a bomb.** Every other type is a reward; a bomb that materialises
  under someone with no one to blame is just a random death. Bombs stay a
  kill drop, where the player who died put it there.
- **Never within `WORLD_MIN_PLAYER_DIST` of a player.** A reward that appears
  on top of you is not a reward, it is a lottery — and it makes standing still
  the optimal strategy.
- **Placed with `ctx.findFreeTile`**, so a drop never lands inside a wall or
  the lake. The map is mostly open, so a single random pick plus that helper
  is enough; no rejection loop.
- **Capped at `MAX_WORLD_DROPS`.** Without a cap an empty server accumulates
  drops for hours and the first player to join sweeps a fortune off the floor.
- **Longer TTL than a kill drop.** A kill drop is contested loot with a clock
  on it. A world drop had no audience, so it waits.

`xpOrb` is the only genuinely new type: it grants experience through
`profile.addExp`, which already handles levelling, announcing and the spell
unlock that follows. Nothing about progression needs to know it exists.

**The world spawner is the second mint, and §1.5 assumes there is only one.**
Player kills move coins between purses and monsters mint them at a rate the
mob spawner controls — that is what keeps gear prices meaningful against a
roughly fixed pool. A `coins` drop appearing on its own is new money nobody
earned, so `WORLD_SPAWN_INTERVAL_MS` and the `coins` weight belong to the
economy, not to the loot table's flavour. Retune them together with
`COIN_REWARD`, or price inflation arrives through the floor rather than
through kills.

---

## 8. Mobile layout

Landscape budget, roughly 740×380 CSS px.

```
┌──────────────────────────────────────────────────────┐
│ stats                                 debug     [💬] │
│ chat log                                        [🛒] │  utility column
│                                                 [👤] │  (top right)
│                                                      │
│                                    [S3][S4][S5]      │  rail row 2
│   ← stick zone 46%×62% →           [⚔][S1][S2]      │  rail row 1 (thumb)
└──────────────────────────────────────────────────────┘
```

- The action rail holds **attack plus five spells**: 52×52 px buttons, three
  per row, two rows, about 124 px of the 380 available.
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
| `STAT_KEYS` becomes `['maxHp', 'damage', 'defense', 'evasion', 'cdr', 'moveSpeed']`, and `deriveStats` follows §1.1 | `shared/profile.js` | `cdr` and `moveSpeed` are where intelligence and agility land; `maxMana` and `spellPower` are gone |
| Mana removed from the derived-stat surface and the HUD; the MP bar becomes an XP bar | `shared/profile.js`, `server/systems/profile.js`, `client/src/ui/hud.js`, `client/index.html` | there is no mana. The vestigial `player.mana` fields stay — removing them means editing the core for no gain |
| `LEVEL_MAX` 50 → 20, `MAX_ATTRIBUTES`, `attributesForLevel`, re-tuned `expForLevel`. `recompute()` derives attributes from class and level | `shared/profile.js`, `server/systems/profile.js` | §1.4 — attributes become derived, not accumulated |
| Remove `POINTS_PER_LEVEL`, `STARTING_POINTS`, `profile.points`, the `PROFILE_SPEND_POINT` event and handler, and the `+` buttons in the client panel | `shared/profile.js`, `server/systems/profile.js`, `shared/protocol.js`, `client/src/systems/profile.js` | there is no manual point spending any more |
| `player.moveCooldownMs`, written by `profile.applyVitals` from `stats.moveSpeed`, read by the `MOVE` handler as `player.moveCooldownMs ?? MOVE_COOLDOWN_MS` | `server/systems/profile.js`, `server/systems/core.js` | agility has to actually make you faster; one line in the core |
| `registerMoveGate(fn)` plus one guard in the `MOVE` handler | `server/game/state.js`, `server/systems/core.js` | `rooted` and `stunned` need to stop movement without hacking the core |
| `ctx.action({ ..., slot: 'rail'\|'utility' })` and an `#actions-utility` container built in JS | `client/src/ui/touch.js`, `CLAUDE.md` | nine buttons do not fit one rail, and every feature author inventing their own floating button is worse |
