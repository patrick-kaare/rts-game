import type { Application } from 'pixi.js';
import { AIController } from './ai/ai';
import { TILE_PX, createClientState, type ClientState } from './client';
import { Camera } from './input/camera';
import { Input } from './input/input';
import { LocalTransport } from './net/local';
import type { NetTransport, StartInfo } from './net/net';
import { HASH_INTERVAL, type MatchPlayer } from './net/protocol';
import type { CommandTransport } from './net/transport';
import { Renderer } from './render/renderer';
import { applyCommand } from './sim/commands';
import { stateHash } from './sim/hash';
import type { GameRules } from './sim/rules';
import { stepWorld } from './sim/step';
import { TICK_MS, type Command, type World } from './sim/types';
import { areAllies, createWorld } from './sim/world';
import { Sidebar } from './ui/sidebar';

const LOCAL_PLAYER = 0;
/** Max sim time spent per animation frame, so catching up stays responsive. */
const FRAME_BUDGET_MS = 12;
/** Max sim time per background timer call while the tab is hidden. */
const BACKGROUND_BUDGET_MS = 200;
/** If no frame has run for this long, the background timer drives the sim. */
const BACKGROUND_AFTER_MS = 200;
/** Online: ticks buffered beyond this are run as fast as the budget allows. */
const JITTER_TICKS = 2;
/** Online: show "catching up" when this many ticks behind the server. */
const CATCH_UP_NOTICE_TICKS = 40;

export interface GameHooks {
  /** Game over: the player wants to go back to the lobby (offline) or the menu (online). */
  onExit(online: boolean): void;
}

export class Game {
  world!: World;
  transport!: CommandTransport;
  state: ClientState = createClientState(LOCAL_PLAYER);
  camera!: Camera;
  players: MatchPlayer[] = [];
  /** Per player: is a human connected (online only). */
  connected: boolean[] = [];
  readonly renderer: Renderer;
  readonly input: Input;
  readonly sidebar: Sidebar;
  private net: NetTransport | null = null;
  private ais: AIController[] = [];
  private localConfig: { players: MatchPlayer[]; rules: GameRules } | null = null;
  /** Real time owed to the sim, in ms. */
  private acc = 0;
  private lastPump = performance.now();
  private lastFrame = performance.now();
  private gameOver = false;
  private shownDefeat = false;
  private connectionLost = false;
  private desyncTick = -1;

  constructor(
    private app: Application,
    viewport: HTMLElement,
    sidebarEl: HTMLElement,
    private overlayEl: HTMLElement,
    private statusEl: HTMLElement,
    private hooks: GameHooks,
  ) {
    this.renderer = new Renderer(app);
    this.input = new Input(viewport, this);
    this.sidebar = new Sidebar(sidebarEl, this);
    app.ticker.add((t) => this.frame(t.deltaMS));
    // Browsers stop animation frames in hidden tabs, and throttle timers to
    // about once a second. That's fine: each call runs every tick that is due.
    setInterval(() => {
      if (this.world && performance.now() - this.lastFrame > BACKGROUND_AFTER_MS) this.pump(BACKGROUND_BUDGET_MS);
    }, 250);
    window.addEventListener('resize', () => this.resize());
  }

  get online(): boolean {
    return this.net !== null;
  }

  /** Offline match: player 0 is the local human, the rest are AIs. */
  startLocal(seed: number, players: MatchPlayer[], rules: GameRules) {
    this.localConfig = { players, rules };
    this.net = null;
    const transport = new LocalTransport();
    this.transport = transport;
    this.players = players;
    this.connected = this.players.map(() => true);
    this.begin(createWorld(seed, players.length, rules, players.map((p) => p.team)), LOCAL_PLAYER);
    this.ais = this.players.flatMap((p, id) => (p.ai ? [new AIController(id, transport)] : []));
  }

  /** Online match; AIs run on the server. */
  startOnline(net: NetTransport, info: StartInfo) {
    this.net = net;
    this.transport = net;
    this.ais = [];
    this.players = info.players;
    this.connected = info.players.map(() => true);
    net.onPresence = (c) => (this.connected = c);
    net.onDesync = (tick) => (this.desyncTick = tick);
    net.onConnection = (lost) => (this.connectionLost = lost);
    net.onError = (msg) => this.showOverlay('Disconnected', msg, [this.endButton()]);
    // Messages keep arriving in hidden tabs, so run the sim on them too.
    net.onMessage = () => {
      if (performance.now() - this.lastFrame > BACKGROUND_AFTER_MS) this.pump(BACKGROUND_BUDGET_MS);
    };
    this.begin(createWorld(info.seed, info.players.length, info.rules, info.players.map((p) => p.team)), info.you);
  }

  private begin(world: World, you: number) {
    this.world = world;
    // The pointer hasn't moved just because a new game started.
    const mouse = this.state.mouse;
    this.state = createClientState(you);
    this.state.mouse = mouse;
    this.camera = new Camera(this.world.w * TILE_PX, this.world.h * TILE_PX);
    this.resize();
    this.renderer.setWorld(this.world, you);
    this.sidebar.setWorld(this.world);
    this.acc = 0;
    this.lastPump = performance.now();
    this.gameOver = false;
    this.shownDefeat = false;
    this.connectionLost = false;
    this.desyncTick = -1;
    this.overlayEl.hidden = true;
    this.centerOnBase();
  }

  send(cmd: Command) {
    this.transport.send(this.state.localPlayer, cmd);
  }

  centerOnBase() {
    if (!this.world) return;
    const me = this.world.players[this.state.localPlayer];
    for (const e of this.world.entities.values()) {
      if (e.owner === me.id && e.type === 'cy') {
        this.camera.centerOn((e.tx + 1.5) * TILE_PX, (e.ty + 1.5) * TILE_PX);
        return;
      }
    }
    this.camera.centerOn((me.startX + 1.5) * TILE_PX, (me.startY + 1.5) * TILE_PX);
  }

  private resize() {
    if (!this.camera) return;
    this.camera.resize(this.app.screen.width, this.app.screen.height);
  }

  private frame(dtMs: number) {
    if (!this.world) return;
    this.lastFrame = performance.now();
    this.camera.update(dtMs, this.input.keys);
    this.pump(FRAME_BUDGET_MS);
    this.input.prune();
    const alpha = Math.min(1, this.acc / TICK_MS);
    this.renderer.render(alpha, this.state, this.camera);
    this.sidebar.update();
    this.updateStatus();
  }

  /** Ticks we are behind: wall-clock debt offline, buffered server ticks online. */
  private behind(): number {
    return this.net ? this.net.backlog(this.world.tick) : Math.floor(this.acc / TICK_MS);
  }

  /**
   * Run every tick owed since the last call, within a time budget. Anything
   * left over carries to the next call, so after time away the game
   * fast-forwards until it is back to real time.
   *
   * Offline, the wall clock decides what is owed. Online, the server does:
   * a tick can only run once its bundle has arrived. A couple of buffered
   * ticks are paced by the clock to smooth out network jitter; anything
   * beyond that runs straight away.
   */
  private pump(budgetMs: number) {
    const now = performance.now();
    if (!this.gameOver) this.acc += now - this.lastPump;
    this.lastPump = now;
    const deadline = now + budgetMs;
    if (this.net) {
      while (!this.gameOver && this.net.ready(this.world.tick)) {
        if (this.acc < TICK_MS && this.behind() <= JITTER_TICKS) break;
        this.tick();
        this.acc = Math.max(0, this.acc - TICK_MS);
        if (performance.now() > deadline) break;
      }
      // Waiting on the server: don't bank time, or we'd burst when it arrives.
      if (!this.net.ready(this.world.tick)) this.acc = Math.min(this.acc, TICK_MS);
      return;
    }
    while (this.acc >= TICK_MS && !this.gameOver && this.transport.ready(this.world.tick)) {
      this.tick();
      this.acc -= TICK_MS;
      if (performance.now() > deadline) break;
    }
  }

  private tick() {
    const world = this.world;
    const local = this.transport instanceof LocalTransport ? this.transport : null;
    if (local) local.currentTick = world.tick;
    for (const ai of this.ais) ai.update(world);
    for (const c of this.transport.take(world.tick)) applyCommand(world, c.player, c.cmd);
    stepWorld(world);
    if (local) local.currentTick = world.tick;
    if (this.net && world.tick % HASH_INTERVAL === 0) this.net.reportHash(world.tick, stateHash(world));
    // Skip visual effects nobody will see (hidden tab or fast-forwarding).
    if (!document.hidden && this.behind() < 4) this.renderer.handleEvents(world.events);
    if (world.winner >= 0 && !this.gameOver) {
      this.gameOver = true;
      const me = this.state.localPlayer;
      const draw = world.winner >= world.players.length;
      const won = !draw && areAllies(world, world.winner, me);
      this.showOverlay(won ? 'Victory' : 'Defeat', draw ? 'Nobody survived.' : this.winnerText(won), this.endButtons());
    } else if (world.winner < 0 && !this.shownDefeat && world.players[this.state.localPlayer].defeated) {
      // Knocked out while others play on: let the player watch or leave.
      this.shownDefeat = true;
      const me = this.state.localPlayer;
      const alliesLeft = world.players.some((p) => p.id !== me && !p.defeated && areAllies(world, p.id, me));
      const text = alliesLeft ? 'Your base has been destroyed. Your allies fight on.' : 'Your base has been destroyed. The others play on.';
      this.showOverlay('Defeat', text, [
        { label: 'Keep watching', action: () => this.showOverlay(null, '') },
        ...this.endButtons(),
      ]);
    }
  }

  /** Who won: the winning player, or every member of the winning team. */
  private winnerText(won: boolean): string {
    const world = this.world;
    const team = world.players.filter((p) => areAllies(world, p.id, world.winner));
    if (team.length === 1) return won ? 'Every enemy base has been destroyed.' : `${this.players[world.winner]?.name ?? 'Someone'} wins.`;
    const names = team.map((p) => this.players[p.id]?.name ?? `Player ${p.id + 1}`).join(', ');
    return won ? `Your team wins: ${names}.` : `Team ${this.players[world.winner]?.team} wins: ${names}.`;
  }

  private updateStatus() {
    const lines: string[] = [];
    if (this.connectionLost) lines.push('Connection lost — reconnecting…');
    const behind = this.behind();
    if (this.net && behind > CATCH_UP_NOTICE_TICKS) lines.push(`Catching up… ${Math.ceil(behind / 20)}s behind`);
    if (this.desyncTick >= 0) lines.push(`Out of sync with the server since tick ${this.desyncTick}. Reload to rejoin.`);
    const away = this.players.filter((p, i) => !p.ai && !this.connected[i] && !this.world.players[i]?.defeated).map((p) => p.name);
    if (away.length) lines.push(`${away.join(', ')} ${away.length > 1 ? 'are' : 'is'} disconnected — the game continues`);
    const text = lines.join('\n');
    if (this.statusEl.textContent !== text) this.statusEl.textContent = text;
    this.statusEl.hidden = !text;
  }

  private endButton(): OverlayButton {
    return {
      label: 'Back to menu',
      action: () => {
        this.net?.close();
        this.hooks.onExit(true);
      },
    };
  }

  private endButtons(): OverlayButton[] {
    const local = this.localConfig;
    if (this.online || !local) return [this.endButton()];
    return [
      { label: 'Play again', action: () => this.startLocal((Math.random() * 2 ** 31) | 0, local.players, local.rules) },
      {
        label: 'Back to lobby',
        action: () => {
          // Stop the sim; the AIs may still be playing on after a defeat.
          this.gameOver = true;
          this.hooks.onExit(false);
        },
      },
    ];
  }

  private showOverlay(title: string | null, text: string, buttons: OverlayButton[] = []) {
    const el = this.overlayEl;
    if (!title) {
      el.hidden = true;
      return;
    }
    el.hidden = false;
    el.innerHTML = '';
    const box = document.createElement('div');
    box.className = 'overlay-box';
    const h = document.createElement('h1');
    h.textContent = title;
    const p = document.createElement('p');
    p.textContent = text;
    box.append(h, p);
    const row = document.createElement('div');
    row.className = 'overlay-buttons';
    for (const b of buttons) {
      const btn = document.createElement('button');
      btn.textContent = b.label;
      btn.onclick = b.action;
      row.append(btn);
    }
    box.append(row);
    el.append(box);
  }
}

interface OverlayButton {
  label: string;
  action: () => void;
}
