import type { Difficulty, GameRules } from '../sim/rules';
import type { Command, PlayerCommand } from '../sim/types';
import type { ClientMsg, ServerMsg, SlotInfo, SlotSetting } from './protocol';
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
  /** Highest tick whose bundle has arrived (every tick up to it is available). */
  latest = -1;
  /** Next tick the game loop will take. */
  private next = 0;
  private bundles = new Map<number, PlayerCommand[]>();
  private ws: WebSocket | null = null;
  private closed = false;
  private started = false;

  onJoined?: (code: string, slot: number, token: string) => void;
  onLobby?: (slots: SlotInfo[], rules: GameRules) => void;
  /** First start of this match in this page. Rejoins after that only refill the buffer. */
  onStart?: (info: StartInfo) => void;
  onPresence?: (connected: boolean[]) => void;
  onDesync?: (tick: number) => void;
  onError?: (msg: string) => void;
  /** Connection lost (true) or restored (false). */
  onConnection?: (lost: boolean) => void;
  /** Any message arrived; the game uses this to keep the sim going in hidden tabs. */
  onMessage?: () => void;

  constructor(private url: string) {}

  create(name: string, rules: GameRules, slots: SlotSetting[], teams: number[], difficulties: Difficulty[]) {
    this.open({ t: 'create', name, rules, slots, teams, difficulties });
  }

  join(code: string, name: string) {
    this.open({ t: 'join', code, name });
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

  start() {
    this.post({ t: 'start' });
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
        this.onConnection?.(false);
        this.onJoined?.(msg.code, msg.slot, msg.token);
        break;
      case 'lobby':
        this.onLobby?.(msg.slots, msg.rules);
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
      case 'error':
        this.onError?.(msg.msg);
        break;
    }
  }
}
