import type { Difficulty, GameRules } from '../sim/rules';
import type { Command, PlayerCommand } from '../sim/types';
import { CHAT_HISTORY, type ChatMsg, type ClientMsg, type ServerMsg, type SlotInfo, type SlotSetting } from './protocol';
import type { CommandTransport } from './transport';

export type StartInfo = Extract<ServerMsg, { t: 'start' }>;

const RECONNECT_MS = 2000;

/**
 * Lockstep transport over the game server. The server stamps each command
 * with the player and the tick it runs on; this side just buffers the
 * per-tick bundles until the game loop takes them.
 */
export class NetTransport implements CommandTransport {
  code = '';
  slot = -1;
  token = '';
  /** Watching rather than playing: joined with Watch, or the host spectating. */
  spectator = false;
  /** Highest tick whose bundle has arrived (every tick up to it is available). */
  latest = -1;
  /** Chat lines so far, oldest first; kept here so they carry from the lobby into the game. */
  chatLog: ChatMsg[] = [];
  /** Next tick the game loop will take. */
  private next = 0;
  private bundles = new Map<number, PlayerCommand[]>();
  private ws: WebSocket | null = null;
  private closed = false;
  private started = false;

  onJoined?: (code: string, slot: number, token: string) => void;
  onLobby?: (slots: SlotInfo[], rules: GameRules, spectators: string[]) => void;
  /** First start of this match in this page. Rejoins after that only refill the buffer. */
  onStart?: (info: StartInfo) => void;
  onPresence?: (connected: boolean[]) => void;
  onDesync?: (tick: number) => void;
  /** A new chat line, or null when the whole log was replaced on a (re)join (see chatLog). */
  onChat?: (msg: ChatMsg | null) => void;
  onError?: (msg: string) => void;
  /** Connection lost (true) or restored (false). */
  onConnection?: (lost: boolean) => void;
  /** Any message arrived; the game uses this to keep the sim going in hidden tabs. */
  onMessage?: () => void;

  constructor(private url: string) {}

  create(name: string, rules: GameRules, slots: SlotSetting[], teams: number[], difficulties: Difficulty[], spectate = false) {
    this.open({ t: 'create', name, rules, slots, teams, difficulties, spectate });
  }

  join(code: string, name: string) {
    this.open({ t: 'join', code, name });
  }

  watch(code: string, name: string) {
    this.open({ t: 'watch', code, name });
  }

  rejoin(code: string, token: string) {
    this.code = code;
    this.token = token;
    this.open({ t: 'rejoin', code, token });
  }

  setSlot(index: number, kind: SlotSetting) {
    this.post({ t: 'slot', index, kind });
  }

  setTeam(index: number, team: number) {
    this.post({ t: 'team', index, team });
  }

  setDifficulty(index: number, difficulty: Difficulty) {
    this.post({ t: 'difficulty', index, difficulty });
  }

  setRules(rules: GameRules) {
    this.post({ t: 'rules', rules });
  }

  /** Host only: watch the match instead of playing. */
  setSpectate(on: boolean) {
    this.post({ t: 'spectate', on });
  }

  start() {
    this.post({ t: 'start' });
  }

  chat(text: string, allies: boolean) {
    this.post({ t: 'chat', text, allies });
  }

  close() {
    this.closed = true;
    this.ws?.close();
  }

  // --- CommandTransport ---

  send(_player: number, cmd: Command): void {
    this.post({ t: 'cmd', cmd });
  }

  ready(tick: number): boolean {
    return tick <= this.latest;
  }

  take(tick: number): PlayerCommand[] {
    const cmds = this.bundles.get(tick) ?? [];
    this.bundles.delete(tick);
    this.next = tick + 1;
    return cmds;
  }

  /** How many ticks have arrived but not been run yet, given the sim's next tick. */
  backlog(tick: number): number {
    return Math.max(0, this.latest - tick + 1);
  }

  reportHash(tick: number, hash: number) {
    this.post({ t: 'hash', tick, hash });
  }

  // --- socket ---

  private open(first: ClientMsg) {
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => ws.send(JSON.stringify(first));
    // The close handler below does the reporting. Without an error listener the
    // `ws` package (what Node < 22 uses) throws on a refused connection before it
    // ever emits close.
    ws.onerror = () => {};
    ws.onmessage = (ev) => {
      let msg: ServerMsg;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      this.handle(msg);
      this.onMessage?.();
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.closed) return;
      // 4000+: the server deliberately dropped this seat (other tab, kicked).
      if (ev.code >= 4000) return this.onError?.(ev.reason || 'Disconnected.');
      // Never got a seat: nothing to rejoin.
      if (!this.token) return this.onError?.("Couldn't reach the game server.");
      this.onConnection?.(true);
      setTimeout(() => !this.closed && this.open({ t: 'rejoin', code: this.code, token: this.token }), RECONNECT_MS);
    };
  }

  private post(msg: ClientMsg) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private handle(msg: ServerMsg) {
    switch (msg.t) {
      case 'joined':
        this.code = msg.code;
        this.slot = msg.slot;
        this.token = msg.token;
        this.spectator = msg.spectator;
        this.onConnection?.(false);
        this.onJoined?.(msg.code, msg.slot, msg.token);
        break;
      case 'lobby':
        // The host's spectate toggle can change in the lobby.
        if (this.slot >= 0) this.spectator = !!msg.slots[this.slot]?.spectator;
        this.onLobby?.(msg.slots, msg.rules, msg.spectators);
        break;
      case 'start':
        // Fill in everything we haven't run yet. Ticks without commands are implicit.
        for (const [tick, cmds] of msg.log) if (tick >= this.next) this.bundles.set(tick, cmds);
        this.latest = Math.max(this.latest, msg.tick - 1);
        if (!this.started) {
          this.started = true;
          this.onStart?.(msg);
        }
        break;
      case 'tick':
        if (msg.tick >= this.next && msg.cmds.length) this.bundles.set(msg.tick, msg.cmds);
        this.latest = Math.max(this.latest, msg.tick);
        break;
      case 'presence':
        this.onPresence?.(msg.connected);
        break;
      case 'desync':
        this.onDesync?.(msg.tick);
        break;
      case 'chat':
        this.chatLog.push(msg.msg);
        if (this.chatLog.length > CHAT_HISTORY) this.chatLog.shift();
        this.onChat?.(msg.msg);
        break;
      case 'chatLog':
        this.chatLog = msg.msgs.slice(-CHAT_HISTORY);
        this.onChat?.(null);
        break;
      case 'error':
        this.onError?.(msg.msg);
        break;
    }
  }
}
