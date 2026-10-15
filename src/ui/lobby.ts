import { NetTransport, type StartInfo } from '../net/net';
import { TEAM_OPTIONS, sideCount, type MatchPlayer, type SlotInfo, type SlotSetting } from '../net/protocol';
import { TEAM } from '../render/palette';
import { MAP_SIDES, MAX_PLAYERS, mapSideFor } from '../sim/map';
import {
  CREDIT_OPTIONS,
  DEFAULT_RULES,
  DIFFICULTY_OPTIONS,
  FOG_OPTIONS,
  MAP_SIZE_OPTIONS,
  START_UNITS_OPTIONS,
  cleanRules,
  isValidRules,
  type Difficulty,
  type GameRules,
  type MapSizeRule,
} from '../sim/rules';
import { ChatBox } from './chat';

export interface LobbyHooks {
  playLocal(seed: number, players: MatchPlayer[], rules: GameRules): void;
  playOnline(net: NetTransport, info: StartInfo): void;
}

const NAME_KEY = 'rts-name';
const RULES_KEY = 'rts-rules';
const tokenKey = (code: string) => `rts-token-${code}`;

/** Web storage can throw (private mode, blocked storage); none of this is essential. */
function storage(kind: 'local' | 'session') {
  const get = () => (kind === 'local' ? localStorage : sessionStorage);
  return {
    get(key: string): string | null {
      try {
        return get().getItem(key);
      } catch {
        return null;
      }
    },
    set(key: string, value: string) {
      try {
        get().setItem(key, value);
      } catch {
        /* ignore */
      }
    },
    remove(key: string) {
      try {
        get().removeItem(key);
      } catch {
        /* ignore */
      }
    },
  };
}

const store = storage('local');
const session = storage('session');

function loadRules(): GameRules {
  try {
    const r: unknown = JSON.parse(store.get(RULES_KEY) ?? 'null');
    if (isValidRules(r)) return cleanRules(r);
  } catch {
    /* ignore */
  }
  return { ...DEFAULT_RULES };
}

const FOG_TEXT = { full: 'Fog of war', explored: 'Map revealed', off: 'No fog' };
const START_UNITS_TEXT = { none: 'Construction yard only', squad: '2 riflemen', army: '4 riflemen, 2 tanks' };
const MAP_SIZE_TEXT = { auto: 'Auto', small: 'Small', medium: 'Medium', large: 'Large', huge: 'Huge' };
const SLOT_TEXT = { open: 'Open', ai: 'AI', closed: 'Closed' };
const DIFFICULTY_TEXT = { easy: 'Easy', normal: 'Normal', hard: 'Hard' };

/** Slots of a new offline game: you against one AI. */
function localSlots(name: string): SlotInfo[] {
  return Array.from({ length: MAX_PLAYERS }, (_, i) => ({
    kind: i === 0 ? 'human' : i === 1 ? 'ai' : 'closed',
    name: i === 0 ? name || 'You' : '',
    connected: true,
    team: 0,
    difficulty: 'normal',
  }));
}

/**
 * Rejoin tokens live in sessionStorage (so two tabs in one browser keep
 * separate seats) and in localStorage (so closing the tab and opening the
 * link again still finds the seat).
 */
const tokens = {
  get: (code: string) => session.get(tokenKey(code)) ?? store.get(tokenKey(code)),
  set(code: string, token: string) {
    session.set(tokenKey(code), token);
    store.set(tokenKey(code), token);
  },
  remove(code: string) {
    session.remove(tokenKey(code));
    store.remove(tokenKey(code));
  },
};

function serverUrl(): string {
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
}

function setRoomInUrl(code: string | null) {
  const url = new URL(location.href);
  if (code) url.searchParams.set('room', code);
  else url.searchParams.delete('room');
  history.replaceState(null, '', url);
}

/**
 * Start menu and game lobby. A new game starts out in the browser; setting a
 * slot to Open moves the lobby to the game server so others can join. Games
 * with only AI opponents never need the server.
 */
export class Lobby {
  readonly el = document.createElement('div');
  private net: NetTransport | null = null;
  private slots: SlotInfo[] = [];
  private rules: GameRules = loadRules();
  /** The offline lobby while it is moving to the server, restored if that fails. */
  private pendingLocal: SlotInfo[] | null = null;
  private boxEl: HTMLDivElement | null = null;
  /** Online lobbies only. Lives outside the box, so re-rendering the box keeps the draft and focus. */
  private chat = new ChatBox('lobby', (m) => TEAM[m.slot]?.css ?? '');

  constructor(private hooks: LobbyHooks) {
    this.el.id = 'lobby';
    this.el.append(this.chat.el);
  }

  /** Show the menu, or go straight back into a game this browser has a seat in. */
  open() {
    this.el.hidden = false;
    const code = new URL(location.href).searchParams.get('room')?.toUpperCase() ?? '';
    const token = code ? tokens.get(code) : null;
    if (code && token) {
      this.renderMessage(`Rejoining game ${code}…`);
      this.connect().rejoin(code, token);
    } else this.renderMenu(code);
  }

  hide() {
    this.el.hidden = true;
  }

  /** After an online game, or when backing out of a lobby: forget the seat and show the menu. */
  leave() {
    if (this.net?.code) tokens.remove(this.net.code);
    this.net?.close();
    this.net = null;
    this.pendingLocal = null;
    this.chat.clear();
    setRoomInUrl(null);
    this.el.hidden = false;
    this.renderMenu('');
  }

  /** After an offline game: back to its lobby, same slots and rules. */
  backToRoom() {
    this.el.hidden = false;
    // Started straight from ?seed=, without a lobby.
    if (!this.slots.length) this.slots = localSlots(store.get(NAME_KEY) ?? '');
    this.renderRoom();
  }

  private get online(): boolean {
    return this.net !== null && this.pendingLocal === null;
  }

  private connect(): NetTransport {
    this.net?.close();
    const net = new NetTransport(serverUrl());
    this.net = net;
    this.chat.clear();
    this.chat.onSend = (text, allies) => net.chat(text, allies);
    net.onChat = (msg) => (msg ? this.chat.add(msg) : this.chat.setMessages(net.chatLog));
    net.onJoined = (code, _slot, token) => {
      this.pendingLocal = null;
      tokens.set(code, token);
      setRoomInUrl(code);
    };
    net.onLobby = (slots, rules) => {
      this.slots = slots;
      this.chat.canAllies = (slots[net.slot]?.team ?? 0) > 0;
      this.rules = rules;
      this.renderRoom();
    };
    net.onStart = (info) => {
      net.onChat = undefined;
      this.hide();
      this.hooks.playOnline(net, info);
    };
    net.onError = (msg) => {
      // Our seat is gone (or never existed): drop the stale token and start over.
      if (net.code) tokens.remove(net.code);
      const code = net.code;
      net.close();
      this.net = null;
      setRoomInUrl(null);
      const local = this.pendingLocal;
      this.pendingLocal = null;
      if (local) {
        // Couldn't move online: stay in the offline lobby.
        this.slots = local;
        this.renderRoom(msg);
      } else this.renderMenu(code, msg);
    };
    net.onConnection = (lost) => {
      if (lost && !this.el.hidden) this.renderMessage('Connection lost — reconnecting…');
    };
    return net;
  }

  private renderMenu(code: string, error = '') {
    const box = this.box();
    this.chat.show(false);
    const name = input('Your name', store.get(NAME_KEY) ?? '');
    name.maxLength = 20;
    name.addEventListener('change', () => store.set(NAME_KEY, name.value.trim()));

    const create = button('New game', () => {
      store.set(NAME_KEY, name.value.trim());
      this.net = null;
      this.slots = localSlots(name.value.trim());
      this.renderRoom();
    });

    const codeIn = input('Code', code);
    codeIn.maxLength = 4;
    codeIn.className = 'code-input';
    codeIn.addEventListener('input', () => (codeIn.value = codeIn.value.toUpperCase()));
    const join = button('Join', () => {
      const c = codeIn.value.trim().toUpperCase();
      if (!c) return codeIn.focus();
      store.set(NAME_KEY, name.value.trim());
      this.renderMessage(`Joining ${c}…`);
      this.connect().join(c, name.value);
    });
    codeIn.addEventListener('keydown', (ev) => ev.key === 'Enter' && join.click());

    box.append(h('h1', 'Shape RTS'), row(label('Name'), name), row(create), h('h2', 'Join a game'), row(codeIn, join));
    if (error) box.append(p(error, 'error'));
    if (code) codeIn.focus();
  }

  private renderMessage(text: string) {
    const box = this.box();
    this.chat.show(false);
    box.append(h('h1', 'Shape RTS'), p(text));
    box.append(row(button('Cancel', () => (this.pendingLocal ? this.stayLocal() : this.leave()), 'secondary')));
  }

  /** The lobby of a new game, offline or on the server. */
  private renderRoom(error = '') {
    const net = this.online ? this.net : null;
    const you = net ? net.slot : 0;
    const isHost = you === 0;
    const box = this.box();
    if (net) {
      const link = new URL(location.href);
      link.search = `?room=${net.code}`;
      const copy = button('Copy invite link', () => {
        navigator.clipboard?.writeText(link.href).then(
          () => (copy.textContent = 'Copied!'),
          () => (copy.textContent = link.href),
        );
      }, 'secondary');
      box.append(h('h1', 'Game lobby'), row(label('Code'), h('span', net.code, 'room-code'), copy));
    } else box.append(h('h1', 'New game'));

    const list = document.createElement('div');
    list.className = 'slots';
    this.slots.forEach((s, i) => {
      const r = document.createElement('div');
      r.className = `slot ${s.kind}`;
      const swatch = document.createElement('i');
      swatch.style.background = TEAM[i].css;
      r.append(swatch);
      if (s.kind === 'human') {
        const me = i === you ? ' (you)' : '';
        const host = net && i === 0 ? ' · host' : '';
        r.append(h('span', `${s.name}${me}${host}${s.connected ? '' : ' · away'}`));
        if (net && isHost && i !== 0) r.append(button('Remove', () => this.setSlot(i, 'open'), 'secondary small'));
      } else if (isHost) {
        const sel = document.createElement('select');
        for (const v of ['open', 'ai', 'closed'] as const) {
          sel.append(new Option(!net && v === 'open' ? 'Open (invite online)' : SLOT_TEXT[v], v, false, s.kind === v));
        }
        sel.addEventListener('change', () => this.setSlot(i, sel.value as SlotSetting));
        r.append(sel);
      } else {
        r.append(h('span', SLOT_TEXT[s.kind]));
      }
      if (s.kind === 'ai') r.append(this.difficultyPicker(i, s.difficulty, isHost));
      if (s.kind === 'human' || s.kind === 'ai') r.append(this.teamPicker(i, s.team, isHost || i === you));
      list.append(r);
    });
    box.append(list);

    box.append(h('h2', 'Rules'), this.rulesPanel(isHost));
    // Only online, next to the box. Left alone if already shown, so the input keeps its focus.
    this.chat.show(!!net);

    const taken = this.slots.filter((s) => s.kind === 'human' || s.kind === 'ai');
    const oneSide = taken.length >= 2 && sideCount(taken.map((s) => s.team)) < 2;
    const actions = row();
    if (isHost) {
      const start = button(`Start (${taken.length} players)`, () => this.start());
      start.disabled = taken.length < 2 || oneSide;
      actions.append(start);
    } else actions.append(p('Waiting for the host to start…'));
    actions.append(button('Leave', () => this.leave(), 'secondary'));
    box.append(actions);
    if (oneSide) box.append(p('Everyone is on the same team. Put someone on another team to start.', 'error'));
    if (error) box.append(p(error, 'error'));
    box.append(
      p(
        net
          ? 'Open slots that nobody has joined are left out when the game starts.'
          : 'Set a slot to Open to invite people: the game moves to the server and you get a code to share.',
        'hint',
      ),
    );
  }

  /** Team of a taken slot: "–" for no team (free-for-all), or Team 1–5. */
  private teamPicker(i: number, team: number, editable: boolean): HTMLElement {
    const text = (t: number) => (t ? `Team ${t}` : 'No team');
    if (!editable) return h('span', text(team), 'team');
    const sel = document.createElement('select');
    sel.className = 'team';
    for (const t of TEAM_OPTIONS) sel.append(new Option(text(t), String(t), false, t === team));
    sel.addEventListener('change', () => this.setTeam(i, Number(sel.value)));
    return sel;
  }

  private setTeam(i: number, team: number) {
    if (this.online) return this.net!.setTeam(i, team);
    this.slots[i] = { ...this.slots[i], team };
    this.renderRoom();
  }

  private difficultyPicker(i: number, difficulty: Difficulty, editable: boolean): HTMLElement {
    if (!editable) return h('span', DIFFICULTY_TEXT[difficulty], 'difficulty');
    const sel = document.createElement('select');
    sel.className = 'difficulty';
    for (const d of DIFFICULTY_OPTIONS) sel.append(new Option(DIFFICULTY_TEXT[d], d, false, d === difficulty));
    sel.addEventListener('change', () => this.setDifficulty(i, sel.value as Difficulty));
    return sel;
  }

  private setDifficulty(i: number, difficulty: Difficulty) {
    if (this.online) return this.net!.setDifficulty(i, difficulty);
    this.slots[i] = { ...this.slots[i], difficulty };
    this.renderRoom();
  }

  private rulesPanel(editable: boolean): HTMLElement {
    const rules = this.rules;
    // Map sizes too small for the players that might take part are bumped up by the sim.
    const players = this.slots.filter((s) => s.kind !== 'closed').length;
    const sizeText = (v: MapSizeRule) => {
      const side = mapSideFor(v, players);
      return `${MAP_SIZE_TEXT[v]} (${side}×${side})`;
    };
    const fields: [string, string[], string, (v: string) => string, (v: string) => void, (v: string) => boolean][] = [
      ['Credits', CREDIT_OPTIONS.map(String), String(rules.credits), (v) => Number(v).toLocaleString('en-US'), (v) => (rules.credits = Number(v)), () => false],
      ['Fog', FOG_OPTIONS, rules.fog, (v) => FOG_TEXT[v as GameRules['fog']], (v) => (rules.fog = v as GameRules['fog']), () => false],
      [
        'Map',
        MAP_SIZE_OPTIONS,
        rules.mapSize,
        (v) => sizeText(v as MapSizeRule),
        (v) => (rules.mapSize = v as MapSizeRule),
        (v) => v !== 'auto' && mapSideFor(v as MapSizeRule, players) !== MAP_SIDES[v as Exclude<MapSizeRule, 'auto'>],
      ],
      ['Units', START_UNITS_OPTIONS, rules.startUnits, (v) => START_UNITS_TEXT[v as GameRules['startUnits']], (v) => (rules.startUnits = v as GameRules['startUnits']), () => false],
    ];
    const grid = document.createElement('div');
    grid.className = 'rules';
    for (const [name, options, current, text, set, disabled] of fields) {
      grid.append(label(name));
      if (!editable) {
        grid.append(h('span', text(current)));
        continue;
      }
      const sel = document.createElement('select');
      for (const v of options) {
        const opt = new Option(text(v), v, false, v === current);
        opt.disabled = disabled(v) && v !== current;
        sel.append(opt);
      }
      sel.addEventListener('change', () => {
        set(sel.value);
        this.changeRules();
      });
      grid.append(sel);
    }
    return grid;
  }

  private changeRules() {
    store.set(RULES_KEY, JSON.stringify(this.rules));
    if (this.online) this.net!.setRules(this.rules);
    else this.renderRoom();
  }

  private setSlot(i: number, kind: SlotSetting) {
    if (this.online) return this.net!.setSlot(i, kind);
    if (kind === 'open') return this.goOnline(i);
    this.slots[i] = { kind, name: '', connected: true, team: this.slots[i].team, difficulty: this.slots[i].difficulty };
    this.renderRoom();
  }

  /** Move the offline lobby to the server, with `open` as an open slot. */
  private goOnline(open: number) {
    const local = this.slots;
    const setup = local.slice(1).map((s, k) => (k + 1 === open ? 'open' : s.kind === 'ai' ? 'ai' : 'closed'));
    this.renderMessage('Creating online game…');
    const net = this.connect();
    this.pendingLocal = local;
    net.create(
      local[0].name,
      this.rules,
      setup,
      local.map((s) => s.team),
      local.map((s) => s.difficulty),
    );
  }

  /** Give up moving online and go back to the offline lobby. */
  private stayLocal() {
    this.net?.close();
    this.net = null;
    this.slots = this.pendingLocal!;
    this.pendingLocal = null;
    this.renderRoom();
  }

  private start() {
    if (this.online) return this.net!.start();
    const players: MatchPlayer[] = [];
    this.slots.forEach((s, i) => {
      if (s.kind === 'human') players.push({ name: s.name, ai: false, team: s.team, difficulty: 'normal' });
      else if (s.kind === 'ai') players.push({ name: `AI ${i + 1}`, ai: true, team: s.team, difficulty: s.difficulty });
    });
    this.hide();
    this.hooks.playLocal((Math.random() * 2 ** 31) | 0, players, { ...this.rules });
  }

  /** A fresh, empty lobby box. */
  private box(): HTMLDivElement {
    this.boxEl?.remove();
    const box = document.createElement('div');
    box.className = 'lobby-box';
    this.el.prepend(box);
    this.boxEl = box;
    return box;
  }
}

function h(tag: string, text: string, cls = '') {
  const e = document.createElement(tag);
  e.textContent = text;
  if (cls) e.className = cls;
  return e;
}

function p(text: string, cls = '') {
  return h('p', text, cls);
}

function label(text: string) {
  return h('label', text);
}

function input(placeholder: string, value: string) {
  const e = document.createElement('input');
  e.placeholder = placeholder;
  e.value = value;
  e.spellcheck = false;
  return e;
}

function button(text: string, onClick: () => void, cls = '') {
  const b = document.createElement('button');
  b.textContent = text;
  if (cls) b.className = cls;
  b.addEventListener('click', onClick);
  return b;
}

function row(...children: HTMLElement[]) {
  const d = document.createElement('div');
  d.className = 'row';
  d.append(...children);
  return d;
}
