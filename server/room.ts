import { randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';
import { AIController } from '../src/ai/ai';
import type { CommandTransport } from '../src/net/transport';
import {
  HASH_INTERVAL,
  SLOT_COUNT,
  cleanCommand,
  isSlotSetting,
  isValidCommand,
  type MatchPlayer,
  type ServerMsg,
  type SlotInfo,
  type TickBundle,
} from '../src/net/protocol';
import { applyCommand } from '../src/sim/commands';
import { DEFAULT_RULES, cleanRules, isValidRules, type GameRules } from '../src/sim/rules';
import { stateHash } from '../src/sim/hash';
import { stepWorld } from '../src/sim/step';
import { TICK_MS, type Command, type PlayerCommand, type World } from '../src/sim/types';
import { createWorld } from '../src/sim/world';

/** How many recent hashes the server keeps to compare against. */
const HASH_HISTORY = 50;
const MAX_NAME = 20;

interface Seat {
  kind: 'open' | 'ai' | 'closed' | 'human';
  name: string;
  token: string;
  socket: WebSocket | null;
}

/**
 * One lobby and, once started, one match. The room runs its own copy of the
 * simulation (it decides the winner, drives the AIs and provides reference
 * hashes) and owns the tick clock.
 */
export class Room {
  readonly seats: Seat[] = [];
  phase: 'lobby' | 'running' | 'finished' = 'lobby';
  /** When the room last had nobody connected, or became finished (ms since epoch). */
  idleSince = 0;

  rules: GameRules;
  private world: World | null = null;
  /** Sim player id → seat index. */
  private players: number[] = [];
  private matchPlayers: MatchPlayer[] = [];
  private ais: AIController[] = [];
  private pending: PlayerCommand[] = [];
  private log: TickBundle[] = [];
  private hashes = new Map<number, number>();
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Real time owed to the sim, in ms. */
  private acc = 0;
  private last = 0;

  constructor(
    readonly code: string,
    private seed: number,
    /** Tests drive the clock by calling tick() themselves. */
    private manualClock = false,
    /** Initial setup from the host; anything malformed falls back to the defaults. */
    rules: unknown = DEFAULT_RULES,
    slots: unknown = [],
  ) {
    this.rules = isValidRules(rules) ? cleanRules(rules) : { ...DEFAULT_RULES };
    // Setups for slots 1 and up; slot 0 is the creator's.
    const setup = Array.isArray(slots) && slots.length === SLOT_COUNT - 1 && slots.every(isSlotSetting) ? slots : null;
    for (let i = 0; i < SLOT_COUNT; i++) {
      const kind = i === 0 ? 'open' : (setup?.[i - 1] ?? (i === 1 ? 'ai' : 'open'));
      this.seats.push({ kind, name: '', token: '', socket: null });
    }
  }

  /** Take the first open seat. Returns the seat index, or an error message. */
  join(socket: WebSocket, name: string): number | string {
    if (this.phase !== 'lobby') return 'That game has already started.';
    const slot = this.seats.findIndex((s) => s.kind === 'open');
    if (slot < 0) return 'That game is full.';
    const seat = this.seats[slot];
    seat.kind = 'human';
    seat.name = cleanName(name, slot);
    seat.token = randomUUID();
    this.attach(slot, socket);
    return slot;
  }

  /** Reattach a socket to the seat holding `token`. Returns the seat index or -1. */
  rejoin(socket: WebSocket, token: string): number {
    const slot = this.seats.findIndex((s) => s.kind === 'human' && s.token === token);
    if (slot < 0) return -1;
    const old = this.seats[slot].socket;
    if (old && old !== socket) old.close(4000, 'Joined from another tab.');
    this.attach(slot, socket);
    return slot;
  }

  private attach(slot: number, socket: WebSocket) {
    const seat = this.seats[slot];
    seat.socket = socket;
    this.idleSince = 0;
    send(socket, { t: 'joined', code: this.code, slot, token: seat.token });
    if (this.phase === 'lobby') this.broadcastLobby();
    else {
      send(socket, this.startMsg(this.players.indexOf(slot)));
      this.broadcastPresence();
    }
  }

  detach(socket: WebSocket) {
    const slot = this.seats.findIndex((s) => s.socket === socket);
    if (slot < 0) return;
    this.seats[slot].socket = null;
    if (!this.anyoneConnected() && !this.idleSince) this.idleSince = Date.now();
    if (this.phase === 'lobby') this.broadcastLobby();
    else this.broadcastPresence();
  }

  slotOf(socket: WebSocket): number {
    return this.seats.findIndex((s) => s.socket === socket);
  }

  /** Host changes a slot. Setting a human's seat to 'open' removes them. */
  setSlot(from: number, index: unknown, kind: unknown) {
    if (from !== 0 || this.phase !== 'lobby') return;
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 1 || index >= SLOT_COUNT) return;
    if (!isSlotSetting(kind)) return;
    const seat = this.seats[index];
    if (seat.kind === kind) return;
    if (seat.kind === 'human') {
      if (kind !== 'open') return;
      seat.socket?.close(4001, 'Removed by the host.');
    }
    this.seats[index] = { kind, name: '', token: '', socket: null };
    this.broadcastLobby();
  }

  /** Host changes the match rules. */
  setRules(from: number, rules: unknown) {
    if (from !== 0 || this.phase !== 'lobby' || !isValidRules(rules)) return;
    this.rules = cleanRules(rules);
    this.broadcastLobby();
  }

  start(from: number): string | null {
    if (from !== 0 || this.phase !== 'lobby') return null;
    const taken = this.seats.map((s, i) => [s, i] as const).filter(([s]) => s.kind === 'human' || s.kind === 'ai');
    if (taken.length < 2) return 'You need at least two players.';
    this.players = taken.map(([, i]) => i);
    this.matchPlayers = taken.map(([s, i]) => ({ name: s.kind === 'ai' ? `AI ${i + 1}` : s.name, ai: s.kind === 'ai' }));
    this.world = createWorld(this.seed, this.players.length, this.rules);
    const transport: CommandTransport = {
      send: (player, cmd) => this.pending.push({ player, cmd: structuredClone(cmd) }),
      take: () => [],
      ready: () => true,
    };
    this.ais = this.matchPlayers.flatMap((p, id) => (p.ai ? [new AIController(id, transport)] : []));
    this.phase = 'running';
    this.players.forEach((slot, id) => {
      const socket = this.seats[slot].socket;
      if (socket) send(socket, this.startMsg(id));
    });
    this.broadcastPresence();
    this.last = performance.now();
    if (!this.manualClock) this.timer = setInterval(() => this.pump(), TICK_MS / 2);
    return null;
  }

  /** A command from a human seat, executed on the next tick. */
  command(from: number, cmd: unknown) {
    if (this.phase !== 'running' || !isValidCommand(cmd)) return;
    const player = this.players.indexOf(from);
    if (player < 0) return;
    this.pending.push({ player, cmd: cleanCommand(cmd as Command) });
  }

  /** Compare a client's hash against ours; tell everyone on a mismatch. */
  checkHash(from: number, tick: unknown, hash: unknown) {
    if (!this.world || typeof tick !== 'number' || typeof hash !== 'number') return;
    const ours = this.hashes.get(tick);
    if (ours === undefined || ours === hash) return;
    console.warn(`[room ${this.code}] desync at tick ${tick}: seat ${from} has ${hash}, server has ${ours}`);
    this.broadcast({ t: 'desync', tick });
  }

  anyoneConnected(): boolean {
    return this.seats.some((s) => s.socket);
  }

  close() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const s of this.seats) s.socket?.close(1001, 'Room closed.');
  }

  /** Run every tick that is due. The clock stands still while no human is connected. */
  private pump() {
    const now = performance.now();
    if (this.anyoneConnected()) this.acc += now - this.last;
    this.last = now;
    // After a long stall (e.g. a suspended server), don't burst through minutes of ticks.
    this.acc = Math.min(this.acc, TICK_MS * 20);
    try {
      while (this.acc >= TICK_MS && this.phase === 'running') {
        this.acc -= TICK_MS;
        this.tick();
      }
    } catch (err) {
      // A sim bug must not take the whole server down with it.
      console.error(`[room ${this.code}] tick failed, ending match`, err);
      this.broadcast({ t: 'error', msg: 'The server hit an error and stopped this match.' });
      this.phase = 'finished';
      this.idleSince = Date.now();
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Run one tick now. Public so tests can drive a manual clock. */
  tick() {
    const world = this.world!;
    for (const ai of this.ais) ai.update(world);
    // Stable sort: by player, then arrival order.
    const cmds = this.pending.map((c, seq) => ({ c, seq })).sort((a, b) => a.c.player - b.c.player || a.seq - b.seq).map((x) => x.c);
    this.pending = [];
    const tick = world.tick;
    for (const c of cmds) applyCommand(world, c.player, c.cmd);
    stepWorld(world);
    if (cmds.length) this.log.push([tick, cmds]);
    if (world.tick % HASH_INTERVAL === 0) {
      this.hashes.set(world.tick, stateHash(world));
      this.hashes.delete(world.tick - HASH_INTERVAL * HASH_HISTORY);
    }
    this.broadcast({ t: 'tick', tick, cmds });
    if (world.winner >= 0) {
      this.phase = 'finished';
      this.idleSince = Date.now();
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
    }
  }

  get currentTick(): number {
    return this.world?.tick ?? 0;
  }

  get serverHash(): number {
    return this.world ? stateHash(this.world) : 0;
  }

  private startMsg(you: number): ServerMsg {
    return { t: 'start', seed: this.seed, rules: this.rules, players: this.matchPlayers, you, tick: this.world!.tick, log: this.log };
  }

  private broadcastLobby() {
    const slots: SlotInfo[] = this.seats.map((s) => ({ kind: s.kind, name: s.name, connected: !!s.socket }));
    this.broadcast({ t: 'lobby', slots, rules: this.rules });
  }

  private broadcastPresence() {
    const connected = this.players.map((slot) => this.seats[slot].kind === 'ai' || !!this.seats[slot].socket);
    this.broadcast({ t: 'presence', connected });
  }

  private broadcast(msg: ServerMsg) {
    const data = JSON.stringify(msg);
    for (const s of this.seats) if (s.socket && s.socket.readyState === s.socket.OPEN) s.socket.send(data);
  }
}

export function send(socket: WebSocket, msg: ServerMsg) {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
}

function cleanName(name: unknown, slot: number): string {
  const s = typeof name === 'string' ? name.replace(/[\u0000-\u001f]/g, '').trim().slice(0, MAX_NAME) : '';
  return s || `Player ${slot + 1}`;
}
