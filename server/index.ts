import { randomInt } from 'node:crypto';
import { createServer as createHttpServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import type { ClientMsg } from '../src/net/protocol';
import { Room, send } from './room';

/** Rooms with nobody connected are deleted after this long. */
const IDLE_ROOM_MS = 30 * 60 * 1000;
/** Finished rooms are kept this long so players can still rejoin and see the result. */
const FINISHED_ROOM_MS = 5 * 60 * 1000;
const MAX_MESSAGE_BYTES = 64 * 1024;
/** No 0/O or 1/I, so codes are easy to read out. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export interface GameServer {
  port: number;
  rooms: Map<string, Room>;
  close(): Promise<void>;
}

export interface ServerOptions {
  /** Don't tick rooms on a timer; tests call room.tick() instead. */
  manualClock?: boolean;
}

export function createServer(port: number, opts: ServerOptions = {}): Promise<GameServer> {
  const rooms = new Map<string, Room>();
  const roomOf = new Map<WebSocket, Room>();
  const http = createHttpServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('Shape RTS game server\n');
  });
  const wss = new WebSocketServer({ server: http, path: '/ws', maxPayload: MAX_MESSAGE_BYTES });

  const newCode = () => {
    for (;;) {
      let code = '';
      for (let i = 0; i < 4; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
      if (!rooms.has(code)) return code;
    }
  };

  wss.on('connection', (socket) => {
    socket.on('message', (data) => {
      let msg: ClientMsg;
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }
      if (!msg || typeof msg !== 'object') return;
      const room = roomOf.get(socket);

      if (msg.t === 'create' || msg.t === 'join' || msg.t === 'rejoin') {
        if (room) return;
        let target: Room | undefined;
        if (msg.t === 'create') {
          target = new Room(newCode(), randomInt(2 ** 31), opts.manualClock, msg.rules, msg.slots, msg.teams);
          rooms.set(target.code, target);
        } else {
          target = rooms.get(String(msg.code ?? '').toUpperCase());
          if (!target) return send(socket, { t: 'error', msg: 'No game with that code.' });
        }
        if (msg.t === 'rejoin') {
          if (target.rejoin(socket, String(msg.token)) < 0) return send(socket, { t: 'error', msg: 'Your seat in that game is gone.' });
        } else {
          const res = target.join(socket, String(msg.name ?? ''));
          if (typeof res === 'string') return send(socket, { t: 'error', msg: res });
        }
        roomOf.set(socket, target);
        return;
      }

      if (!room) return;
      const slot = room.slotOf(socket);
      if (slot < 0) return;
      switch (msg.t) {
        case 'slot':
          room.setSlot(slot, msg.index, msg.kind);
          break;
        case 'team':
          room.setTeam(slot, msg.index, msg.team);
          break;
        case 'rules':
          room.setRules(slot, msg.rules);
          break;
        case 'start': {
          const err = room.start(slot);
          if (err) send(socket, { t: 'error', msg: err });
          break;
        }
        case 'cmd':
          room.command(slot, msg.cmd);
          break;
        case 'hash':
          room.checkHash(slot, msg.tick, msg.hash);
          break;
      }
    });
    socket.on('close', () => {
      roomOf.get(socket)?.detach(socket);
      roomOf.delete(socket);
    });
    socket.on('error', () => socket.close());
  });

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [code, room] of rooms) {
      const limit = room.phase === 'finished' ? FINISHED_ROOM_MS : IDLE_ROOM_MS;
      if (room.idleSince && now - room.idleSince > limit) {
        room.close();
        rooms.delete(code);
      }
    }
  }, 60 * 1000);

  return new Promise((resolve) => {
    http.listen(port, () => {
      const addr = http.address();
      resolve({
        port: typeof addr === 'object' && addr ? addr.port : port,
        rooms,
        close: () =>
          new Promise<void>((done) => {
            clearInterval(sweep);
            for (const room of rooms.values()) room.close();
            wss.close();
            http.close(() => done());
            http.closeAllConnections();
          }),
      });
    });
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const port = Number(process.env.PORT) || 8787;
  createServer(port).then((s) => console.log(`Game server listening on ws://localhost:${s.port}/ws`));
}
