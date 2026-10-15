import { randomInt } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
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
  /** Interface to bind; all interfaces when omitted. Production binds 127.0.0.1 behind the tunnel. */
  host?: string;
  /**
   * Directory with the built client (`npm run build` → dist/). When set, the
   * HTTP side of this server serves it, so one process behind one hostname
   * answers both the page and /ws. In development Vite serves the client and
   * proxies /ws here, so this stays unset.
   */
  staticDir?: string;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
};

/** Static file handler: real files from `root`, anything else gets index.html (the invite link is /?room=CODE). */
function staticHandler(root: string) {
  root = resolve(root);
  const index = join(root, 'index.html');
  return (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD' });
      return res.end();
    }
    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
    } catch {
      res.writeHead(400);
      return res.end();
    }
    let file = resolve(root, '.' + pathname);
    // Never leave the root, whatever the path tried.
    if (file !== root && !file.startsWith(root + sep)) {
      res.writeHead(403);
      return res.end();
    }
    let isFile = false;
    try {
      isFile = statSync(file).isFile();
    } catch {
      /* not there */
    }
    if (!isFile) {
      if (extname(pathname) && !pathname.endsWith('.html')) {
        // A missing asset is a 404, not the app shell — otherwise a stale
        // bundle name would be answered with HTML and fail obscurely.
        res.writeHead(404, { 'content-type': 'text/plain' });
        return res.end('Not found\n');
      }
      file = index;
    }
    // Vite puts hashed bundles under /assets/, so those can be cached for good;
    // index.html must always be re-checked or a deploy never reaches anyone.
    const immutable = file !== index && file.startsWith(join(root, 'assets') + sep);
    res.writeHead(200, {
      'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
      'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    if (req.method === 'HEAD') return res.end();
    createReadStream(file)
      .on('error', () => {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      })
      .pipe(res);
  };
}

export function createServer(port: number, opts: ServerOptions = {}): Promise<GameServer> {
  const rooms = new Map<string, Room>();
  const roomOf = new Map<WebSocket, Room>();
  const serveStatic = opts.staticDir ? staticHandler(opts.staticDir) : null;
  const http = createHttpServer((req, res) => {
    if (req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      return res.end(JSON.stringify({ ok: true, rooms: rooms.size }) + '\n');
    }
    if (serveStatic) return serveStatic(req, res);
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

      if (msg.t === 'create' || msg.t === 'join' || msg.t === 'watch' || msg.t === 'rejoin') {
        if (room) return;
        let target: Room | undefined;
        if (msg.t === 'create') {
          target = new Room(newCode(), randomInt(2 ** 31), opts.manualClock, msg.rules, msg.slots, msg.teams, msg.difficulties, msg.spectate);
          rooms.set(target.code, target);
        } else {
          target = rooms.get(String(msg.code ?? '').toUpperCase());
          if (!target) return send(socket, { t: 'error', msg: 'No game with that code.' });
        }
        if (msg.t === 'rejoin') {
          if (!target.rejoin(socket, String(msg.token))) return send(socket, { t: 'error', msg: 'Your seat in that game is gone.' });
        } else if (msg.t === 'watch') {
          const err = target.watch(socket, String(msg.name ?? ''));
          if (err) return send(socket, { t: 'error', msg: err });
        } else {
          const res = target.join(socket, String(msg.name ?? ''));
          if (typeof res === 'string') return send(socket, { t: 'error', msg: res });
        }
        roomOf.set(socket, target);
        return;
      }

      if (!room) return;
      const slot = room.slotOf(socket);
      if (slot < 0) {
        // Watchers can only chat and report hashes.
        const watcher = room.watcherOf(socket);
        if (watcher && msg.t === 'chat') room.chat(watcher, msg.text, msg.allies);
        else if (watcher && msg.t === 'hash') room.checkHash(watcher, msg.tick, msg.hash);
        return;
      }
      switch (msg.t) {
        case 'slot':
          room.setSlot(slot, msg.index, msg.kind);
          break;
        case 'team':
          room.setTeam(slot, msg.index, msg.team);
          break;
        case 'difficulty':
          room.setDifficulty(slot, msg.index, msg.difficulty);
          break;
        case 'rules':
          room.setRules(slot, msg.rules);
          break;
        case 'spectate':
          room.setSpectate(slot, msg.on);
          break;
        case 'start': {
          const err = room.start(slot);
          if (err) send(socket, { t: 'error', msg: err });
          break;
        }
        case 'cmd':
          room.command(slot, msg.cmd);
          break;
        case 'chat':
          room.chat(slot, msg.text, msg.allies);
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
    const onListen = () => {
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
    };
    if (opts.host) http.listen(port, opts.host, onListen);
    else http.listen(port, onListen);
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const port = Number(process.env.PORT) || 8787;
  const host = process.env.HOST || undefined;
  // STATIC_DIR=none keeps the plain game server even when a dist/ exists.
  // Unset, it serves dist/ when there is one (production) and nothing otherwise (dev).
  const defaultDist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
  const staticDir =
    process.env.STATIC_DIR === 'none' ? undefined
    : process.env.STATIC_DIR ? process.env.STATIC_DIR
    : existsSync(join(defaultDist, 'index.html')) ? defaultDist
    : undefined;
  createServer(port, { host, staticDir }).then((s) => {
    const where = `${host ?? 'localhost'}:${s.port}`;
    console.log(`Game server listening on ws://${where}/ws` + (staticDir ? `, serving ${staticDir} on http://${where}/` : ''));
  });
}
