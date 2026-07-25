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
`server/systems/index.js` and `client/src/systems/index.js`, where the
conflict is a two-line append that git resolves on its own.

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
| **M0.2** | `STAT_KEYS` becomes `['maxHp','damage','defense','evasion','cdr','moveSpeed']`; `deriveStats` follows `ARENA.md` §1.1. `cdr` and `moveSpeed` are **integer percentages** — `deriveStats` rounds every key. Add `ATTR_MAX = 150`, `CDR_MAX_PCT = 50`, `MOVE_MAX_PCT = 40` | `shared/profile.js` |
| **M0.3** | Drop mana from the derived-stat surface and the HUD; the MP bar becomes an XP bar. Leave the vestigial `player.mana` core fields alone | `shared/profile.js`, `server/systems/profile.js`, `client/src/ui/hud.js`, `client/src/systems/profile.js`, `client/index.html` |
| **M0.4** | The level curve: `LEVEL_MAX` 50 → 20, add `MAX_ATTRIBUTES` and `attributesForLevel`, re-tune `expForLevel`, and make `recompute()` derive attributes from class and level (`ARENA.md` §1.4) | `shared/profile.js`, `server/systems/profile.js` |
| **M0.5** | Remove manual point spending entirely: `POINTS_PER_LEVEL`, `STARTING_POINTS`, `profile.points`, the `PROFILE_SPEND_POINT` event and handler, and the `+` buttons in the client panel | `shared/profile.js`, `server/systems/profile.js`, `shared/protocol.js`, `client/src/systems/profile.js` |
| **M0.6** | Movement speed: `profile.applyVitals` writes `player.moveCooldownMs` from `stats.moveSpeed`; the `MOVE` handler reads `player.moveCooldownMs ?? MOVE_COOLDOWN_MS`. Plus `registerMoveGate(fn)` and one guard in the same handler, so `rooted` and `stunned` work without a hack | `server/systems/profile.js`, `server/game/state.js`, `server/systems/core.js` |
| **M0.7** | `ctx.action({ ..., slot: 'rail'\|'utility' })` and an `#actions-utility` container built in JS, top right. Document the new parameter in the `ctx` table of `CLAUDE.md` in the same commit | `client/src/ui/touch.js`, `CLAUDE.md` |
| **M0.8** | **Freeze the contracts.** The four `shared/` data files with their initial tables, and all six systems on both sides created with `enabled: false`, full JSDoc, and every export present as a no-op with its final signature | `shared/{spells,effects,gear,rewards}.js`, `server/systems/{combat,effects,spells,npc,inventory,loot}.js`, the client mirrors, both `index.js` |
| **M0.9** | Every protocol event, in per-system blocks at the end of `C2S` and `S2C` | `shared/protocol.js`, `docs/PROTOCOL.md` |

**Definition of done:** `npm run smoke` passes, two browser tabs can still
join and walk around, `/health` lists the six new systems as disabled, and
every function named in `ARENA.md` §2 exists and is importable. A hunter
should visibly outwalk a warrior at the same level — that is the cheapest
proof M0.2, M0.4 and M0.6 all landed correctly.

---

## Lane A — Combat and effects

Owns `server/systems/combat.js`, `server/systems/effects.js` and their client
halves. Nothing else in the repo.

| Task | What | Depends on |
|---|---|---|
| **A1** | `effects` server: the timed layer, flags, DoT and HoT ticks, expiry, and the change-gated `setModifier` from `ARENA.md` §3.1. **Definition versus instance (§3.3) and the four stacking policies (§3.4) are the core of this task** — an effect's magnitude comes from the caller, never from the table. Register the pipeline stage that handles `invulnerable` and `taken` multipliers | M0 |
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
| **B1** | `shared/spells.js` in full: the melee slot 0 plus all fifteen definitions from `ARENA.md` §4.6, each with its `base` / `attr` / `scaling` triple (§4.2), plus `effectiveCooldown` and `spellDamage` | M0 |
| **B2** | `spells` server: the executor, the `ACTIONS` registry, all seven targeting shapes, cooldowns from `cdr`, level-gated unlocks, the private spellbook | B1, A3 signature |
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
  (`ARENA.md` §1.5). Tuning happens in two places and nowhere else:
  `MAX_ATTRIBUTES` for class identity, and each spell's `base` / `scaling`
  pair for its curve.
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
