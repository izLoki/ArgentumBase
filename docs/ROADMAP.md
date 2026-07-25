# Arena — roadmap

How to build `ARENA.md` with two or three people working at the same time
without stepping on each other.

Read `ARENA.md` for what is being built and `CLAUDE.md` for the rules that
make parallel work possible. This file is only about **order and ownership**:
grab a task, check its contract, ship it.

---

## The shape of the plan

```
M0  Foundations  ── one person, one commit, blocks everything
     │
     ├──► Lane A   Combat and effects
     ├──► Lane B   Spells and monsters
     └──► Lane C   Economy, loot and HUD
                    │
                   M9  Balance pass and smoke coverage
```

Each lane touches a disjoint set of files. The only shared files are
`server/systems/index.js` and `client/src/systems/index.js`, and since M0
already registered all nine systems there, **neither file needs touching
again**. The same goes for `shared/protocol.js`: every arena event is already
declared.

---

## Two people

The three lanes fold onto two people by keeping the dependency arrow pointing
one way. **P2 calls P1's frozen API; P1 never calls P2's.** Nobody waits on a
signature, and no file has two owners.

```
P1  combat · effects · loot · HUD        P2  spells · npc · inventory
     owns the damage layer                    owns the casting layer
              ▲                                        │
              └──────── calls (frozen in M0) ──────────┘
```

| | P1 — hits and consequences | P2 — casting and economy |
|---|---|---|
| Server | `combat.js`, `effects.js`, `loot.js` | `spells.js`, `npc.js`, `inventory.js` |
| Client | the same three, plus `ui/hud.js` | the same three |
| Shared | `rewards.js`, `effects.js` | `spells.js`, `gear.js` |
| Tasks | A1–A5, C4, C5, C6 | B1–B5, C1–C3 |

`loot` stays with P1 because everything it calls — `onKill`, `heal`,
`applyEffect` — is P1's. Mob drops come from `loot`'s own `onKill` listener,
which fires for every victim kind, so **`npc` never imports `loot`**.

### Order

Both start on day one; neither is ever blocked.

| Sprint | P1 | P2 |
|---|---|---|
| 1 | **A3 — `combat` server.** The unblocker: providers, pipeline, melee, death, respawn. Enable it as soon as a hit lands | **C2 + C3 — `inventory`.** Needs only `profile`, which is already live, so it is testable end to end on day one |
| 2 | A1 `effects` server, then A5 `combat` client | B2 — `spells` server executor, against a real `combat` |
| 3 | A4 kill rewards and feed, A2 `effects` client | B3 `spells` client, then B4 `npc` server |
| 4 | C4 + C5 `loot`, C6 HUD readouts | B5 `npc` client |

P2's sprint 1 is deliberately the one piece of Lane C that touches nothing of
P1's — it buys P1 the day it needs to land `combat` without anyone idling.

### The four rules that keep it clean

1. **Flip only your own `enabled`.** Both registries already list every
   system; the only edit either of you makes is `false → true` in your own
   file, when your server half works.
2. **`ui/hud.js` belongs to P1.** P2 shows gold inside the shop modal it owns.
   Anyone else who needs a readout goes through `ctx.hud.setStats`, never the
   HUD's elements. This is the one file that could have had two owners.
3. **Nobody edits `styles.css`.** Inject your styles from your own module, the
   way `client/src/systems/profile.js` already does.
4. **A frozen signature changes only by agreement.** If P2 needs a different
   shape from `combat`, that is a conversation, not a commit — every no-op in
   M0 is a promise P2 already built against.

### Known gap for P2

`MOB_TYPES` in `server/systems/npc.js` references `stoneSlam`, `fireBreath`,
`spark` and `hex`, which do not exist in `shared/spells.js` — `ARENA.md` never
specified them. Defining them is the first half of B4. They are ordinary rows
with `cls: 'npc'`, which is the whole point of mobs casting through the same
executor.

### Why M0 has to land first

Lane B writes `import { applyDamage } from './combat.js'` on day one, while
Lane A has barely started `combat`. That only works if the **signature is
already frozen and exported**. So M0 creates every system file with
`enabled: false`, full JSDoc, and every exported function present as a no-op
with its final signature.

`enabled: false` is the safety switch: a disabled system's events answer
`NOT_IMPLEMENTED` and its client half never initialises, so half-finished
work merges without breaking the running world.

---

## M0 — Foundations

One person. No visible gameplay change. `npm run smoke` must still pass.

| Task | What | Files |
|---|---|---|
| **M0.1** | Rename `archer` to `hunter` | `shared/constants.js` (`CLASSES`), `shared/profile.js` (`BASE_ATTRIBUTES`), `client/index.html` (login option), the comment on `shared/protocol.js` `JOIN` |
| **M0.2** | Add `spellPower` and `cdr` to `STAT_KEYS` and `deriveStats`. **Integer percentages** — `deriveStats` rounds every key. `spellPower: 100 + int*4`, `cdr: min(45, int*1.2)` | `shared/profile.js` |
| **M0.3** | Drop mana everywhere: the derived-stat surface, the HUD (the MP bar becomes an XP bar) and the `player.mana` core fields | `shared/profile.js`, `server/systems/profile.js`, `shared/constants.js`, `server/game/state.js`, `client/src/ui/hud.js`, `client/src/systems/profile.js`, `client/index.html` |
| **M0.4** | `MAX_LEVEL` + `GROWTH_TOTAL` + `attributesAtLevel` inside the level-up loop of `addExp`, replacing attributes wholesale each level-up instead of accumulating a per-level delta. `POINTS_PER_LEVEL` and `STARTING_POINTS` go to `0` | `shared/profile.js`, `server/systems/profile.js` |
| **M0.5** | `registerMoveGate(fn)` in the core plus one guard in the `MOVE` handler, so `rooted` and `stunned` work without a hack | `server/game/state.js`, `server/systems/core.js` |
| **M0.6** | `ctx.action({ ..., slot: 'rail'\|'utility' })` and an `#actions-utility` container built in JS, top right. Document the new parameter in the `ctx` table of `CLAUDE.md` in the same commit | `client/src/ui/touch.js`, `CLAUDE.md` |
| **M0.7** | **Freeze the contracts.** The four `shared/` data files with their initial tables, and all six systems on both sides created with `enabled: false`, full JSDoc, and every export present as a no-op with its final signature | `shared/{spells,effects,gear,rewards}.js`, `server/systems/{combat,effects,spells,npc,inventory,loot}.js`, the client mirrors, both `index.js` |
| **M0.8** | Every protocol event, in per-system blocks at the end of `C2S` and `S2C` | `shared/protocol.js`, `docs/PROTOCOL.md` |

**Definition of done:** `npm run smoke` passes, two browser tabs can still
join and walk around, `/health` lists the six new systems as disabled, and
every function named in `ARENA.md` §2 exists and is importable.

---

## Lane A — Combat and effects

Owns `server/systems/combat.js`, `server/systems/effects.js` and their client
halves. Nothing else in the repo.

| Task | What | Depends on |
|---|---|---|
| **A1** | `effects` server: the timed layer, flags, DoT and HoT ticks, expiry, and the change-gated `setModifier` from `ARENA.md` §3.1. Register the pipeline stage that handles `invulnerable` and `taken` multipliers | M0 |
| **A2** | `effects` client: status icons above heads in `layers.overlay`, driven by `EFFECTS_SELF` and the public icon list in the snapshot | A1 |
| **A3** | `combat` server: target providers, damage pipeline, melee attack, death, respawn timer and spawn protection. Register the `players` provider in `init` | M0 |
| **A4** | `combat` server: kill attribution — `addExp` and `addGold` from `shared/rewards.js` — the kill feed, and `kills`/`deaths` in `collectSnapshot` | A3 |
| **A5** | `combat` client: the ⚔ action, floating damage numbers in `layers.fx`, hit flash, death and respawn overlay, kill feed | A3 |

**Ship A3 first.** Lanes B and C call its API. The frozen signatures from M0
mean they are not blocked, but the sooner it exists, the sooner anything can
be tested end to end.

**Watch out for:** `hp` has exactly one writer. Put the ownership block from
`ARENA.md` §2.1 at the top of `combat.js` verbatim. A single melee hit must
produce exactly one `combat:hit`.

---

## Lane B — Spells and monsters

Owns `shared/spells.js`, `server/systems/spells.js`, `server/systems/npc.js`
and their client halves.

| Task | What | Depends on |
|---|---|---|
| **B1** | `shared/spells.js` in full: all fifteen definitions from `ARENA.md` §4.5, plus `effectiveCooldown` and the damage helper | M0 |
| **B2** | `spells` server: the executor, the `ACTIONS` registry, all six targeting shapes, cooldowns from `cdr`, level-gated unlocks, the private spellbook | B1, A3 signature |
| **B3** | `spells` client: five rail buttons, cooldown sweeps, auto-target plus long-press aiming, projectile / ray / impact rendering in `layers.fx` | B2 |
| **B4** | `npc` server: the mob table, spawner, AI, `registerBlocker` and `registerTargetProvider`, casting through B2's executor, drops through `loot.spawnDrop` | B2, A3 signature |
| **B5** | `npc` client: mob rendering with health bars in `layers.entities`, and `mobViewPosition` for other systems to anchor FX | B4 |

B4 depends on B2 because mobs cast through the same executor. Inside the lane
that is sequential; across lanes it blocks nobody.

**Watch out for:** projectiles belong in the snapshot, not only in one-shot
events. Keep the payload as terse integer arrays — Lane B is where the
bandwidth wall shows up first.

---

## Lane C — Economy, loot and HUD

Owns `shared/gear.js`, `server/systems/inventory.js`, `server/systems/loot.js`
and their client halves.

| Task | What | Depends on |
|---|---|---|
| **C1** | `shared/gear.js`: tier tables and prices for the four slots | M0 |
| **C2** | `inventory` server: buy by slot, next-tier-only validation, atomic `spendGold`, one `setModifier`, and the damage pipeline stage that reads the non-stat `mult` fields | C1, A3 signature |
| **C3** | `inventory` client: the shop modal inside the mobile budget, the 🛒 button in the utility column, digit keys 1–4 on desktop | C2 |
| **C4** | `loot` server: drops on death via `combat.onKill`, the `byTile` index, walk-over pickup, the fused bomb | A3 signature |
| **C5** | `loot` client: drop rendering in `layers.floor`, pickup and explosion animations | C4 |
| **C6** | HUD: XP bar where the mana bar was, level, coins, kills and deaths | M0.3 |

**Watch out for:** C6 and A5 both touch the HUD. Resolve it by having `combat`
write through the existing `ctx.hud.setStats` rather than reaching into HUD
internals. That is the only friction point between lanes.

---

## M9 — Close out

- Balance pass, with at least two anti-snowball levers switched on
  (`ARENA.md` §1.3).
- Extend `scripts/smoke.mjs` to cover cast → damage → death → reward, and
  assert that one melee hit produces exactly one `combat:hit`.
- Verify the mobile layout with `?touch=1`.
- Add a snapshot byte counter in dev and check it with a full arena.

---

## Verification

```bash
npm run dev     # server on :3000 plus the Vite client
npm run smoke   # must pass after M0 and after every milestone
```

Open two browser tabs with different names to test PvP, and a third with
`?touch=1` to check the mobile layout without a device.

Flip a system's `enabled` to `true` only when its server half is finished.
Until then its events answer `NOT_IMPLEMENTED` and its client half never
initialises, so an unfinished lane cannot break anyone else's world.

---

## Decisions still open

These do not block M0, but they should be settled before Lane A ships A4.

1. **Snowball control.** With death costing nothing, whoever gets ahead stays
   ahead. Pick at least two of: diminishing XP by killer level, repeat-kill
   decay, and a bounty multiplier on the leader.
2. **The map.** This plan does not rewrite `server/world/map.js` — the existing
   walled town is the arena. A purpose-built symmetric arena is a separate
   milestone adding `server/world/arena.js`.
3. **Mage slot 4.** Frost Nova or Arcane Barrier — pick one, or specify
   something else.
4. **Friendly fire and teams.** Everyone is hostile to everyone today.
   `teamOf` is already in the target-provider contract so teams can be added
   later; do not remove it.
