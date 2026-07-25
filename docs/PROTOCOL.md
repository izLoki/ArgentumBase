# Network protocol

The source of truth is [`shared/protocol.js`](../shared/protocol.js). This
document explains the flow; the exact names live in code.

## Principle

**The server decides.** The client sends *intents* ("I want to move left",
"I want to attack") and the server determines what actually happened. The
client never sends outcomes ("I dealt 20 damage"), only receives them.

This keeps a single implementation of every rule and makes the world
tamper-resistant by construction.

## Handshake

```
client                                 server
   |-- core:join {name, cls} ------------->|
   |<-- core:welcome {selfId, self,        |   player created
   |     map, systems} --------------------|
   |                                       |
   |<-- core:snapshot (15/s) --------------|   full world state
   |-- core:move {dir} ------------------->|   intent
   |<-- core:snapshot ---------------------|   authoritative result
```

`welcome.systems` is a map like `{ combat: false, npc: true }`. The client
uses it to decide which client systems to start.

## Snapshot shape

```js
{
  t: 1721800000000,   // server timestamp
  tick: 4211,
  players: [ { id, name, cls, x, y, dir, hp, maxHp, dead } ],
  ext: {
    // whatever each enabled system returned from collectSnapshot()
    // <systemId>: { ... }
  }
}
```

`players[]` carries core fields only. A system that needs to publish state
returns it from `collectSnapshot(ctx)`; it arrives as
`snapshot.ext.<systemId>`. Nobody has to edit the snapshot builder.

Per-player private data (inventory, quest progress) must **not** go in the
snapshot — snapshots are broadcast to everyone. Use
`ctx.sendTo(player.id, ...)`.

## Adding an event

1. Add it to `shared/protocol.js` inside a block named after your system.
2. Server: add the handler to your system's `handlers` object.
3. Client: `net.send(C2S.YOUR_EVENT, payload)` and/or a handler in your client
   system.

`server/net/connection.js` never needs to change: it subscribes to every event
declared in `C2S` and routes it to whichever system owns it.

## Errors

The server replies with `core:error` carrying `{ code, message }`. Codes are
in `ERROR_CODE`. `NOT_IMPLEMENTED` means the owning system is currently
disabled — expected while a feature is being built, not a bug.

## Continuous state vs one-shots

The choice between a snapshot field and an event is not a matter of taste:

| Put it in `snapshot.ext.<id>` | Send it as an event |
|---|---|
| Anything that persists across ticks: mobs, projectiles in flight, ground drops, public status icons, the scoreboard | Anything instantaneous: a hit, a death, a pickup, an explosion |
| | Anything private: a spellbook, a cooldown, gear tiers, gold |

Snapshots are full state, so a client that missed one self-heals on the next.
An event that is missed is gone — which is fine for a flash of light and fatal
for a projectile's position. And because snapshots are **broadcast to
everyone**, private data must never ride them; use `ctx.sendTo(player.id, ...)`.

## The arena blocks

These are declared in `shared/protocol.js` and owned by the system they are
named after. The system that owns a block is the only one that adds to it.

**C2S** — intents only.

| Event | Owner | Payload |
|---|---|---|
| `combat:attack` | combat | `{}` melee in the facing direction |
| `combat:respawn` | combat | `{}` early respawn once the timer allows |
| `spells:cast` | spells | `{ id, tx?, ty?, dir? }` — which fields matter depends on the spell's `targeting` |
| `inventory:buy` | inventory | `{ slot }` buys the next tier of that slot only |

**S2C** — outcomes. `owner only` means it goes out with `ctx.sendTo`.

| Event | Owner | Payload |
|---|---|---|
| `combat:hit` | combat | `{ x, y, kind, id, amount, crit, school, byId }` |
| `combat:death` | combat | `{ kind, id, name, killerId, killerName }` |
| `combat:respawned` | combat | `{ id, x, y, protectedMs }` |
| `combat:killfeed` | combat | `{ killerName, victimName, victimKind, reward }` |
| `effects:self` | effects | owner only — `{ active: [{ id, endsAt, stacks }] }` |
| `spells:book` | spells | owner only — `{ known: [{ id, slot, unlocked }] }` |
| `spells:cooldown` | spells | owner only — `{ id, untilMs }` |
| `spells:castFx` | spells | `{ casterKind, casterId, id, x0, y0, tx, ty, dir, projId? }` |
| `spells:ray` | spells | `{ id, x0, y0, x1, y1 }` |
| `spells:impact` | spells | `{ id, x, y, radius }` |
| `spells:failed` | spells | owner only — `{ id, reason }` |
| `inventory:self` | inventory | owner only — `{ tiers, nextCosts }` |
| `loot:picked` | loot | `{ id, byId, type }` |
| `loot:explode` | loot | `{ id, x, y, radius }` |

One melee attack must produce exactly **one** `combat:hit`. If you see two,
something other than `combat` wrote `hp` — see the ownership block at the top
of `server/systems/combat.js`.
