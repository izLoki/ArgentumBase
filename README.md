# Argentum — multiplayer world base

A minimal, authoritative multiplayer world you can build a game on top of.
Grid-based movement in a shared persistent map, in the spirit of classic
tile MMORPGs.

**Stack:** PixiJS 8 on the client, Node + Express + Socket.IO on the server,
Vite for the dev server and build. Plain JavaScript with ES modules — no
TypeScript, no build step on the server, no assets to download.

## What this repo gives you

- Server-authoritative grid movement with terrain collision and a move
  cooldown, so the client cannot cheat position.
- A real multiplayer session: many players in one world, joining and leaving
  live, at 15 snapshots per second with client-side interpolation.
- Deterministic map generation (walled town, lake, forest, roads).
- Global chat with rate limiting.
- A minimal HUD: health, mana, name, and a debug line with tile, tick, ping
  and player count.
- A **plugin system layer**: gameplay features are self-contained modules that
  register themselves, so several people can build different features in
  parallel with almost no chance of touching the same lines of code.

That is the entire scope. Combat, NPCs, items, magic, quests — none of that is
implemented. There are empty system slots waiting for whatever you want to
build.

## Getting started

```bash
npm install
npm run dev
```

- Server: <http://localhost:3000> (`/health` lists which systems are enabled)
- Client: <http://localhost:5173>

Open two browser tabs to see the multiplayer working. To play across machines
on the same network, point the client at the host:

```
# .env
VITE_SERVER_URL=http://192.168.0.10:3000
```

Production build: `npm run build && npm start` — the server then serves
`/dist` itself.

### Smoke test

With the server running:

```bash
npm run smoke
```

Connects two headless clients and checks the handshake, map delivery,
movement, the anti-spam cooldown, chat, disabled-system responses and clean
disconnects. If it passes, the base is healthy and the problem is in your own
code.

## Controls

| Key | Action |
|---|---|
| WASD / arrow keys | Move |
| Enter | Chat |

Any other key belongs to a system you write.

## Adding features

Read **[CLAUDE.md](CLAUDE.md)**. It documents the system contract and the
workflow that keeps several people out of each other's way: one feature per
file, a registry instead of core edits, per-system state, and a network
protocol split into per-system blocks.

Short version:

1. Pick an empty slot in `server/systems/` (or add a new file).
2. Write your feature there and set `enabled: true`.
3. Add whatever events you need to your own block in `shared/protocol.js`.
4. Do the client half in `client/src/systems/<same-name>.js`.

You never edit the core to add a feature.

## Layout

```
shared/            protocol and constants shared by both sides
server/
  index.js         entrypoint
  game/            state, context, game loop        <- core
  net/             socket.io -> systems dispatcher  <- core
  world/map.js     map generation
  systems/         ONE FEATURE PER FILE             <- your code
client/
  src/render/      pixi stage, tilemap, entities, camera
  src/ui/          HUD and chat (DOM)
  src/input.js     keyboard -> network intents
  src/systems/     ONE FEATURE PER FILE             <- your code
docs/PROTOCOL.md   how client and server talk
scripts/smoke.mjs  multiplayer smoke test
```

## Suggested branching

```bash
git checkout -b feat/combat
# work only inside your own system files
git commit -m "feat: melee combat"
git push -u origin feat/combat
```

Because each feature lives in its own pair of files, merges are usually
trivial: the only shared file anyone touches is `shared/protocol.js`, and even
there everyone appends to a separate block.
