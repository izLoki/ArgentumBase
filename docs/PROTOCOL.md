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
