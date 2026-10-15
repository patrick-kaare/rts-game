import { randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';
import { AIController } from '../src/ai/ai';
import type { CommandTransport } from '../src/net/transport';
import {
  CHAT_HISTORY,
  HASH_INTERVAL,
  MAX_CHAT,
  MAX_WATCHERS,
  cleanText,
  SLOT_COUNT,
  cleanCommand,
  isSlotSetting,
  isTeam,
  sideCount,
  isValidCommand,
  type ChatMsg,
  type MatchPlayer,
  type ServerMsg,
  type SlotInfo,
  type TickBundle,
} from '../src/net/protocol';
import { applyCommand } from '../src/sim/commands';
import { DEFAULT_RULES, cleanRules, isDifficulty, isValidRules, type Difficulty, type GameRules } from '../src/sim/rules';
import { stateHash } from '../src/sim/hash';
import { stepWorld } from '../src/sim/step';
import { TICK_MS, type Command, type PlayerCommand, type World } from '../src/sim/types';
import { createWorld } from '../src/sim/world';

/** How many recent hashes the server keeps to compare against. */
const HASH_HISTORY = 50;
const MAX_NAME = 20;
/** Chat rate limit: at most CHAT_BURST lines per CHAT_WINDOW_MS per seat. */
const CHAT_BURST = 5;
const CHAT_WINDOW_MS = 5000;

interface Seat {
  kind: 'open' | 'ai' | 'closed' | 'human';
  name: string;
  token: string;
  socket: WebSocket | null;
  team: number;
  difficulty: Difficulty;
  /** Only on the host's seat: watch the match instead of playing. */
  spectate: boolean;
  /** When this seat's recent chat lines were sent, for the rate limit. */
  chatTimes: number[];
}

/** A spectator who joined with Watch. Kept after disconnecting, so the token still rejoins. */
interface Watcher {
  name: string;
  token: string;
  socket: WebSocket | null;
  chatTimes: number[];
}

/** Who sent a chat line or hash: a seat index, or a watcher. */
type Sender = number | Watcher;

/**
 * One lobby and, once started, one match. The room runs its own copy of the
 * simulation (it decides the winner, drives the AIs and provides reference
 * hashes) and owns the tick clock.
 */
export class Room {
  readonly seats: Seat[] = [];
  readonly watchers: Watcher[] = [];
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
  /** Recent chat, with the sender's team at the time for allies-only lines. */
  private chatLog: { msg: ChatMsg; team: number }[] = [];
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
    teams: unknown = [],
    difficulties: unknown = [],
    spectate: unknown = false,
  ) {
    this.rules = isValidRules(rules) ? cleanRules(rules) : { ...DEFAULT_RULES };
    // Setups for slots 1 and up; slot 0 is the creator's.
    const setup = Array.isArray(slots) && slots.length === SLOT_COUNT - 1 && slots.every(isSlotSetting) ? slots : null;
    for (let i = 0; i < SLOT_COUNT; i++) {
      const kind = i === 0 ? 'open' : (setup?.[i - 1] ?? (i === 1 ? 'ai' : 'open'));
      this.seats.push({ kind, name: '', token: '', socket: null, team: 0, difficulty: 'normal', spectate: false, chatTimes: [] });
    }
    if (Array.isArray(teams) && teams.length === SLOT_COUNT && teams.every(isTeam)) teams.forEach((t, i) => (this.seats[i].team = t));
    if (Array.isArray(difficulties) && difficulties.length === SLOT_COUNT && difficulties.every(isDifficulty)) {
      difficulties.forEach((d, i) => (this.seats[i].difficulty = d));
    }
    this.seats[0].spectate = spectate === true;
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

  /** Watch as a spectator, in any phase. Returns an error message, or null. */
  watch(socket: WebSocket, name: string): string | null {
    if (this.watchers.length >= MAX_WATCHERS) {
      // Make room by forgetting someone who left.
      const gone = this.watchers.findIndex((w) => !w.socket);
      if (gone < 0) return 'That game has too many spectators.';
      this.watchers.splice(gone, 1);
    }
    const watcher: Watcher = { name: cleanText(name, MAX_NAME) || 'Spectator', token: randomUUID(), socket: null, chatTimes: [] };
    this.watchers.push(watcher);
    this.attachWatcher(watcher, socket);
    return null;
  }

  /** Reattach a socket to the seat or watcher holding `token`. Returns false if there is none. */
  rejoin(socket: WebSocket, token: string): boolean {
    const slot = this.seats.findIndex((s) => s.kind === 'human' && s.token === token);
    const watcher = slot < 0 ? this.watchers.find((w) => w.token === token) : undefined;
    if (slot < 0 && !watcher) return false;
    const old = slot >= 0 ? this.seats[slot].socket : watcher!.socket;
    if (old && old !== socket) old.close(4000, 'Joined from another tab.');
    if (watcher) this.attachWatcher(watcher, socket);
    else this.attach(slot, socket);
    return true;
  }

  private attach(slot: number, socket: WebSocket) {
    const seat = this.seats[slot];
    seat.socket = socket;
    this.idleSince = 0;
    send(socket, { t: 'joined', code: this.code, slot, token: seat.token, spectator: seat.spectate });
    if (this.phase === 'lobby') this.broadcastLobby();
    else {
      send(socket, this.startMsg(this.players.indexOf(slot)));
      this.broadcastPresence();
    }
    this.sendChatLog(slot, socket);
  }

  private attachWatcher(watcher: Watcher, socket: WebSocket) {
    watcher.socket = socket;
    this.idleSince = 0;
    send(socket, { t: 'joined', code: this.code, slot: -1, token: watcher.token, spectator: true });
    if (this.phase === 'lobby') this.broadcastLobby();
    else send(socket, this.startMsg(-1));
    this.sendChatLog(watcher, socket);
  }

  private sendChatLog(to: Sender, socket: WebSocket) {
    send(socket, { t: 'chatLog', msgs: this.chatLog.filter((c) => this.canSee(to, c)).map((c) => c.msg) });
  }

  detach(socket: WebSocket) {
    const slot = this.seats.findIndex((s) => s.socket === socket);
    const watcher = this.watcherOf(socket);
    if (slot >= 0) this.seats[slot].socket = null;
    else if (watcher) watcher.socket = null;
    else return;
    if (!this.anyoneConnected() && !this.idleSince) this.idleSince = Date.now();
    if (this.phase === 'lobby') this.broadcastLobby();
    else if (slot >= 0) this.broadcastPresence();
  }

  slotOf(socket: WebSocket): number {
    return this.seats.findIndex((s) => s.socket === socket);
  }

  watcherOf(socket: WebSocket): Watcher | undefined {
    return this.watchers.find((w) => w.socket === socket);
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
    this.seats[index] = { kind, name: '', token: '', socket: null, team: seat.team, difficulty: seat.difficulty, spectate: false, chatTimes: [] };
    this.broadcastLobby();
  }

  /** Change a slot's team: the host may change any slot, everyone else only their own. */
  setTeam(from: number, index: unknown, team: unknown) {
    if (this.phase !== 'lobby' || !isTeam(team)) return;
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= SLOT_COUNT) return;
    if (from !== 0 && from !== index) return;
    if (this.seats[index].team === team) return;
    this.seats[index].team = team;
    this.broadcastLobby();
  }

  /** Host changes an AI's difficulty. */
  setDifficulty(from: number, index: unknown, difficulty: unknown) {
    if (from !== 0 || this.phase !== 'lobby' || !isDifficulty(difficulty)) return;
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 1 || index >= SLOT_COUNT) return;
    if (this.seats[index].difficulty === difficulty) return;
    this.seats[index].difficulty = difficulty;
    this.broadcastLobby();
  }

  /** Host changes the match rules. */
  setRules(from: number, rules: unknown) {
    if (from !== 0 || this.phase !== 'lobby' || !isValidRules(rules)) return;
    this.rules = cleanRules(rules);
    this.broadcastLobby();
  }

  /** Host switches between playing and watching. */
  setSpectate(from: number, on: unknown) {
    if (from !== 0 || this.phase !== 'lobby' || typeof on !== 'boolean') return;
    if (this.seats[0].spectate === on) return;
    this.seats[0].spectate = on;
    this.broadcastLobby();
  }

  start(from: number): string | null {
    if (from !== 0 || this.phase !== 'lobby') return null;
    const taken = this.seats.map((s, i) => [s, i] as const).filter(([s]) => (s.kind === 'human' && !s.spectate) || s.kind === 'ai');
    if (taken.length < 2) return 'You need at least two players.';
    if (sideCount(taken.map(([s]) => s.team)) < 2) return 'Everyone is on the same team.';
    this.players = taken.map(([, i]) => i);
    this.matchPlayers = taken.map(([s, i]) => {
      const ai = s.kind === 'ai';
      return { name: ai ? `AI ${i + 1}` : s.name, ai, team: s.team, difficulty: ai ? s.difficulty : 'normal' };
    });
    this.world = createWorld(
      this.seed,
      this.players.length,
      this.rules,
      this.matchPlayers.map((p) => p.team),
      this.matchPlayers.map((p) => p.difficulty),
    );
    const transport: CommandTransport = {
      send: (player, cmd) => this.pending.push({ player, cmd: structuredClone(cmd) }),
      take: () => [],
      ready: () => true,
    };
    this.ais = this.matchPlayers.flatMap((p, id) => (p.ai ? [new AIController(id, transport)] : []));
    this.phase = 'running';
    this.seats.forEach((s, slot) => {
      if (s.socket) send(s.socket, this.startMsg(this.players.indexOf(slot)));
    });
    for (const w of this.watchers) if (w.socket) send(w.socket, this.startMsg(-1));
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

  /**
   * A chat line from a human seat or a watcher. Allies-only lines need a team
   * (spectators have none); extra lines over the rate limit are dropped.
   * Spectators' lines during the match only reach other spectators.
   */
  chat(from: Sender, text: unknown, allies: unknown) {
    const seat = typeof from === 'number' ? this.seats[from] : null;
    const sender = seat ?? (from as Watcher);
    const clean = cleanText(text, MAX_CHAT);
    if ((seat && seat.kind !== 'human') || !clean) return;
    const spectator = this.isSpectator(from);
    const team = seat && !spectator ? seat.team : 0;
    if (allies === true && team === 0) return;
    const now = Date.now();
    sender.chatTimes = sender.chatTimes.filter((t) => now - t < CHAT_WINDOW_MS);
    if (sender.chatTimes.length >= CHAT_BURST) return;
    sender.chatTimes.push(now);
    const msg: ChatMsg = {
      slot: typeof from === 'number' ? from : -1,
      player: typeof from === 'number' ? this.players.indexOf(from) : -1,
      name: sender.name,
      text: clean,
      allies: allies === true,
      spectator: spectator && this.phase !== 'lobby',
    };
    const entry = { msg, team };
    this.chatLog.push(entry);
    if (this.chatLog.length > CHAT_HISTORY) this.chatLog.shift();
    const data = JSON.stringify({ t: 'chat', msg } satisfies ServerMsg);
    const deliver = (to: Sender, socket: WebSocket | null) => {
      if (socket && socket.readyState === socket.OPEN && this.canSee(to, entry)) socket.send(data);
    };
    this.seats.forEach((s, i) => deliver(i, s.socket));
    for (const w of this.watchers) deliver(w, w.socket);
  }

  /** Watchers and a spectating host. */
  private isSpectator(who: Sender): boolean {
    return typeof who !== 'number' || this.seats[who].spectate;
  }

  /** Spectators see every line; players never see spectators' lines, and allies lines only from their team. */
  private canSee(who: Sender, c: { msg: ChatMsg; team: number }): boolean {
    if (this.isSpectator(who)) return true;
    if (c.msg.spectator) return false;
    return !c.msg.allies || this.seats[who as number].team === c.team;
  }

  /** Compare a client's hash against ours; tell everyone on a mismatch. */
  checkHash(from: Sender, tick: unknown, hash: unknown) {
    if (!this.world || typeof tick !== 'number' || typeof hash !== 'number') return;
    const ours = this.hashes.get(tick);
    if (ours === undefined || ours === hash) return;
    const who = typeof from === 'number' ? `seat ${from}` : `watcher ${from.name}`;
    console.warn(`[room ${this.code}] desync at tick ${tick}: ${who} has ${hash}, server has ${ours}`);
    this.broadcast({ t: 'desync', tick });
  }

  /** Players and spectators alike: anyone watching keeps the clock going. */
  anyoneConnected(): boolean {
    return this.seats.some((s) => s.socket) || this.watchers.some((w) => w.socket);
  }

  close() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const s of this.seats) s.socket?.close(1001, 'Room closed.');
    for (const w of this.watchers) w.socket?.close(1001, 'Room closed.');
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
    const slots: SlotInfo[] = this.seats.map((s) => ({
      kind: s.kind,
      name: s.name,
      connected: !!s.socket,
      team: s.team,
      difficulty: s.difficulty,
      spectator: s.spectate,
    }));
    const spectators = this.watchers.filter((w) => w.socket).map((w) => w.name);
    this.broadcast({ t: 'lobby', slots, rules: this.rules, spectators });
  }

  private broadcastPresence() {
    const connected = this.players.map((slot) => this.seats[slot].kind === 'ai' || !!this.seats[slot].socket);
    this.broadcast({ t: 'presence', connected });
  }

  private broadcast(msg: ServerMsg) {
    const data = JSON.stringify(msg);
    for (const s of [...this.seats, ...this.watchers]) if (s.socket && s.socket.readyState === s.socket.OPEN) s.socket.send(data);
  }
}

export function send(socket: WebSocket, msg: ServerMsg) {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
}

function cleanName(name: unknown, slot: number): string {
  return cleanText(name, MAX_NAME) || `Player ${slot + 1}`;
}
