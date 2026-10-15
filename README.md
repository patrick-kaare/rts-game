# Shape RTS

A small Command & Conquer–style RTS in the browser: grid map, base building, harvesting, fog of war, and AI opponents. Up to 10 players, human or AI, free-for-all or in teams, offline or online. Everything is drawn with simple shapes.

```
npm install
npm run dev      # http://localhost:5173  (add ?seed=123 to jump into an offline 1v1 on that map with default rules)
npm run server   # game server for online play, ws://localhost:8787/ws (proxied by the dev server at /ws)
npm test         # simulation, map and network tests, including determinism checks
npm run build
```

## Starting a game
**New game** opens a lobby with 10 slots and the match rules. Set each slot to AI, Closed or Open, then press **Start**.

- **Rules**: starting credits, fog of war (fog, map revealed, or no fog), map size (Auto picks one from the player count; sizes too small for the players are bumped up), terrain (see below) and starting units. The host's last choice is remembered.
- **Teams**: each player or AI can be put on Team 1–5, or left with no team to play alone. The host can set every team; anyone else can change only their own. Teams are fixed once the match starts. Allies share vision, can't attack each other, and can build next to each other's buildings. A player is out once they have no buildings left, and the match ends when everyone still in it is on the same team. Start positions follow the slot order, so allies don't necessarily start next to each other.
- As long as every slot is AI or Closed, the game runs entirely in the browser and no server is needed.
- Setting a slot to **Open** moves the lobby to the game server (run both `npm run dev` and `npm run server`). You get a 4-letter code and an invite link; others use **Join** with the code or open the link. Open slots nobody joined are left out when the game starts.
- **Chat**: online lobbies have a chat panel next to the slots, and the chat carries on in the match. Players on a team can also send to their allies only (the All/Allies button, or Tab in the input). The server keeps the last 50 lines, so a player who rejoins sees them again.

There are no accounts. Each browser keeps a rejoin token for its seat, so closing the tab and opening the link again puts you back in the match. While a player is away the match keeps going: their base sits idle and can be attacked, and when they return their client replays the match log to catch up. The server's clock only stops when no human is connected at all. Rooms are deleted after 30 minutes with nobody connected, or 5 minutes after the match ends.

## Terrain
With **Terrain: Rivers, roads and forests** (the default), maps get:

- **Cliffs** (grey rock): impassable. Each base sits behind an arc of cliffs facing the centre, with one gap towards the centre and one to the side, and more cliff ridges are scattered around the map.
- **Rivers**: impassable water running from the map edge between neighbouring bases towards the centre. They're crossed by **bridges** where roads meet them, and by a ford at the contested ore field.
- **Roads** link every base to the centre and, with 3 or more players, to its neighbours. Vehicles move 50% faster on roads and bridges, infantry 30%. Pathfinding prefers them when they're quicker.
- **Forests** slow vehicles to half speed (infantry to 80%) and block sight: units see the edge of a forest but not past it, so a unit two tiles into a forest is hidden until enemies come close. Units only pick targets their team can see, which makes forests good for ambushes. With No fog, nothing is hidden.

Buildings can go on grass and roads, but not in forest or on bridges. **Classic** keeps the older maps with rock and water blobs only.

## Units
- **Rifleman** (barracks): cheap infantry, strong against infantry, weak against vehicles.
- **Jeep** (factory): fast scout with long sight and a light machine gun. Good for exploring through the fog and hunting infantry, but fragile and nearly harmless against vehicles and buildings.
- **Tank** (factory): main battle unit, strong against vehicles and buildings.
- **Harvester** (factory, and one free with each refinery): gathers ore and brings it to a refinery.

## Controls
- **LMB**: select / drag box (**Shift** adds; double-click selects all of that type on screen)
- **RMB**: context command: move, attack an enemy, harvest ore (harvesters), dock at a refinery. While placing a building, RMB cancels placement. With a barracks or factory selected, RMB sets its rally point, where new units walk to (RMB on the building itself clears it).
- **WASD** or **arrows**: scroll · click or drag the minimap to jump. There is no edge or middle-drag scrolling.
- **Shift+1–9** or **Ctrl+1–9**: save the selection as a control group (some browsers keep Ctrl+digit for switching tabs, so Shift always works) · **1–9**: select that group, press twice to center the view on it
- **Enter**: chat to everyone · **Shift+Enter**: chat to allies only (online). In the chat input Enter sends, Tab switches between everyone and allies, Esc closes it. Messages fade after 10 seconds.
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

The simulation runs at a fixed 20 ticks/s and changes only through `applyCommand()` and `stepWorld()`. Positions are integers (1 tile = 256 units), randomness comes from a seeded PRNG stored in the world, and entities are always processed in id order. `stateHash()` fingerprints the state. By default maps scale with the player count (64×64 for 2 players up to 160×160 for 7–10), with starts spread around a ring. With an even player count the map is point-symmetric.

**Multiplayer** is deterministic lockstep, with the server owning the clock. Every tick, the server sends all clients the commands received since the previous tick, stamped with the sender's player id. It sends this even when there are none. Clients run a tick once its bundle has arrived, so a slow or absent player never stalls anyone else. A client that falls behind (hidden tab, rejoin) fast-forwards. The server runs its own copy of the sim: it drives the AI players, decides the winner, and compares the `stateHash()` that clients report every 100 ticks to detect desyncs. Commands from the network are shape-checked before they reach the log.
