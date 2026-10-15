# Shape RTS

A small Command & Conquer–style RTS in the browser: grid map, base building, harvesting, fog of war, and AI opponents. Up to 10 players, human or AI, free-for-all, offline or online. Everything is drawn with simple shapes.

```
npm install
npm run dev      # http://localhost:5173  (add ?seed=123 to jump into an offline 1v1 on that map)
npm run server   # game server for online play, ws://localhost:8787/ws (proxied by the dev server at /ws)
npm test         # simulation, map and network tests, including determinism checks
npm run build
```

## Playing online
1. Run both `npm run dev` and `npm run server`.
2. **Host online game**: you get a 4-letter code and an invite link. Set each slot to Open, AI or Closed, then press **Start** once people have joined. Open slots nobody joined are left out.
3. Others use **Join** with the code, or open the invite link.

There are no accounts. Each browser keeps a rejoin token for its seat, so closing the tab and opening the link again puts you back in the match. While a player is away the match keeps going: their base sits idle and can be attacked, and when they return their client replays the match log to catch up. The server's clock only stops when no human is connected at all. Rooms are deleted after 30 minutes with nobody connected, or 5 minutes after the match ends.

## Controls
- **LMB**: select / drag box (**Shift** adds; double-click selects all of that type on screen)
- **RMB**: context command: move, attack an enemy, harvest ore (harvesters), dock at a refinery. While placing a building, RMB cancels placement.
- **WASD** or **arrows**: scroll · click or drag the minimap to jump. There is no edge or middle-drag scrolling.
- **Shift+1–9** or **Ctrl+1–9**: save the selection as a control group (some browsers keep Ctrl+digit for switching tabs, so Shift always works) · **1–9**: select that group, press twice to center the view on it
- Sidebar: click to build; a finished structure shows READY, then click it again to place it. Right-click an item to cancel it (refunds what you've spent).

## Architecture

```
src/sim/     deterministic simulation: no DOM, no Pixi, no Math.random
src/net/     CommandTransport: LocalTransport (offline, 2-tick input delay), NetTransport (online), protocol
src/ai/      AI opponents; they issue Commands just like the player
src/render/  PixiJS renderer (reads sim state, interpolates between ticks)
src/input/   mouse/keyboard → selection (client-only) and Commands
src/ui/      start menu / lobby, HTML sidebar, minimap
server/      Node WebSocket game server (rooms, lobby, tick clock)
```

The simulation runs at a fixed 20 ticks/s and changes only through `applyCommand()` and `stepWorld()`. Positions are integers (1 tile = 256 units), randomness comes from a seeded PRNG stored in the world, and entities are always processed in id order. `stateHash()` fingerprints the state. Maps scale with the player count (64×64 for 2 players up to 160×160 for 7–10), with starts spread around a ring. With an even player count the map is point-symmetric.

**Multiplayer** is deterministic lockstep, with the server owning the clock. Every tick, the server sends all clients the commands received since the previous tick, stamped with the sender's player id. It sends this even when there are none. Clients run a tick once its bundle has arrived, so a slow or absent player never stalls anyone else. A client that falls behind (hidden tab, rejoin) fast-forwards. The server runs its own copy of the sim: it drives the AI players, decides the winner, and compares the `stateHash()` that clients report every 100 ticks to detect desyncs. Commands from the network are shape-checked before they reach the log.
