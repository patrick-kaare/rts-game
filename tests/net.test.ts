import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type GameServer } from '../server/index';
import type { Room } from '../server/room';
import { NetTransport, type StartInfo } from '../src/net/net';
import { HASH_INTERVAL, MAX_CHAT, type SlotInfo, type SlotSetting } from '../src/net/protocol';
import { DEFAULT_RULES, type Difficulty, type GameRules } from '../src/sim/rules';
import { applyCommand } from '../src/sim/commands';
import { stateHash } from '../src/sim/hash';
import { stepWorld } from '../src/sim/step';
import { TILE, type World } from '../src/sim/types';
import { createWorld } from '../src/sim/world';

/** A headless client: a NetTransport plus its own copy of the world, run like the game loop does. */
class Client {
  net: NetTransport;
  world: World | null = null;
  info: StartInfo | null = null;
  lobby: SlotInfo[] = [];
  rules: GameRules | null = null;
  errors: string[] = [];
  desyncs: number[] = [];
  presence: boolean[] = [];

  constructor(url: string) {
    this.net = new NetTransport(url);
    this.net.onLobby = (s, r) => {
      this.lobby = s;
      this.rules = r;
    };
    this.net.onStart = (info) => {
      this.info = info;
      const { seed, players, rules } = info;
      this.world = createWorld(seed, players.length, rules, players.map((p) => p.team), players.map((p) => p.difficulty));
    };
    this.net.onError = (m) => this.errors.push(m);
    this.net.onDesync = (t) => this.desyncs.push(t);
    this.net.onPresence = (c) => (this.presence = c);
  }

  /** Host a new room. An empty slot setup gets the server's defaults (slot 1 AI, the rest open). */
  create(name: string, rules: GameRules = DEFAULT_RULES, slots: SlotSetting[] = [], teams: number[] = [], difficulties: Difficulty[] = []) {
    this.net.create(name, rules, slots, teams, difficulties);
  }

  /** Chat lines received so far, as "name: text" (allies lines get a "*"). */
  get chat(): string[] {
    return this.net.chatLog.map((m) => `${m.allies ? '*' : ''}${m.name}: ${m.text}`);
  }

  /** Run every tick that has arrived. */
  catchUp() {
    const w = this.world!;
    while (this.net.ready(w.tick)) {
      for (const c of this.net.take(w.tick)) applyCommand(w, c.player, c.cmd);
      stepWorld(w);
      if (w.tick % HASH_INTERVAL === 0) this.net.reportHash(w.tick, stateHash(w));
    }
  }
}

async function until(cond: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

let server: GameServer;
let url: string;
const clients: Client[] = [];

function client() {
  const c = new Client(url);
  clients.push(c);
  return c;
}

beforeEach(async () => {
  server = await createServer(0, { manualClock: true });
  url = `ws://localhost:${server.port}/ws`;
});

afterEach(async () => {
  for (const c of clients.splice(0)) c.net.close();
  await server.close();
});

/** Host + one joined human; slot 2 is an AI. Returns the started room. */
async function startMatch() {
  const a = client();
  a.create('Alice');
  await until(() => a.net.slot === 0);
  a.net.setSlot(1, 'open');
  a.net.setSlot(2, 'ai');
  for (let i = 3; i < 10; i++) a.net.setSlot(i, 'closed');
  await until(() => a.lobby[2]?.kind === 'ai' && a.lobby[1]?.kind === 'open');
  const b = client();
  b.net.join(a.net.code, 'Bob');
  await until(() => a.lobby[1]?.kind === 'human');
  a.net.start();
  await until(() => !!a.info && !!b.info);
  const room = server.rooms.get(a.net.code)!;
  return { a, b, room };
}

async function runTicks(room: Room, n: number, ...cs: Client[]) {
  for (let i = 0; i < n; i++) room.tick();
  const target = room.currentTick - 1;
  await until(() => cs.every((c) => c.net.latest >= target));
  for (const c of cs) c.catchUp();
}

describe('game server', () => {
  it('only the host can change slots or start', async () => {
    const a = client();
    a.create('Alice');
    await until(() => a.net.slot === 0);
    const b = client();
    b.net.join(a.net.code, 'Bob');
    // Slot 1 starts as AI, so Bob takes slot 2.
    await until(() => b.net.slot === 2 && a.lobby[2]?.name === 'Bob');
    b.net.setSlot(3, 'closed');
    b.net.start();
    await new Promise((r) => setTimeout(r, 50));
    expect(server.rooms.get(a.net.code)!.phase).toBe('lobby');
    expect(a.lobby[3].kind).toBe('open');
    expect(b.info).toBeNull();
  });

  it('keeps clients in sync with each other and the server', async () => {
    const { a, b, room } = await startMatch();
    expect(a.info!.players.map((p) => p.ai)).toEqual([false, false, true]);
    expect(a.info!.you).toBe(0);
    expect(b.info!.you).toBe(1);

    const mine = [...a.world!.entities.values()].filter((e) => e.owner === 0 && e.kind === 'unit');
    a.net.send(0, { t: 'move', ids: mine.map((e) => e.id), x: 20, y: 20 });
    a.net.send(0, { t: 'build', item: 'power' });
    await until(() => room['pending'].length === 2);
    await runTicks(room, 450, a, b);

    expect(stateHash(a.world!)).toBe(room.serverHash);
    expect(stateHash(b.world!)).toBe(room.serverHash);
    // The server AI did something.
    expect(room['log'].some(([, cmds]) => cmds.some((c) => c.player === 2))).toBe(true);
    await new Promise((r) => setTimeout(r, 50));
    expect(a.desyncs).toEqual([]);
    expect(b.desyncs).toEqual([]);
  });

  it("ignores commands for another player's units", async () => {
    const { a, b, room } = await startMatch();
    const alices = [...a.world!.entities.values()].filter((e) => e.owner === 0 && e.kind === 'unit');
    const before = alices.map((e) => [e.x, e.y]);
    b.net.send(1, { t: 'move', ids: alices.map((e) => e.id), x: 30, y: 30 });
    // Malformed commands are dropped by the server.
    b.net.send(1, { t: 'move', ids: 'nope', x: 1, y: 1 } as never);
    await runTicks(room, 60, a, b);
    for (const [k, e] of alices.entries()) expect([e.x, e.y]).toEqual(before[k]);
    expect(room['log'].every(([, cmds]) => cmds.every((c) => c.player !== 1 || Array.isArray((c.cmd as { ids?: unknown }).ids)))).toBe(true);
  });

  it('keeps going without a disconnected player, who can rejoin and catch up', async () => {
    const { a, b, room } = await startMatch();
    await runTicks(room, 100, a, b);
    const token = b.net.token;
    const code = b.net.code;
    b.net.close();
    await until(() => a.presence[1] === false);
    expect(room.phase).toBe('running');

    // Alice attacks Bob's base while he's away.
    const alices = [...a.world!.entities.values()].filter((e) => e.owner === 0 && e.kind === 'unit');
    const bobYard = [...a.world!.entities.values()].find((e) => e.owner === 1 && e.type === 'cy')!;
    a.net.send(0, { t: 'attackMove', ids: alices.map((e) => e.id), x: Math.floor(bobYard.x / TILE), y: Math.floor(bobYard.y / TILE) });
    await until(() => room['pending'].length >= 1);
    await runTicks(room, 600, a);
    expect(a.world!.tick).toBe(room.currentTick);

    const b2 = client();
    b2.net.rejoin(code, token);
    await until(() => !!b2.info);
    expect(b2.info!.you).toBe(1);
    expect(b2.info!.tick).toBe(room.currentTick);
    b2.catchUp();
    expect(b2.world!.tick).toBe(room.currentTick);
    expect(stateHash(b2.world!)).toBe(stateHash(a.world!));
    await until(() => a.presence[1] === true);

    // And they stay in sync afterwards.
    await runTicks(room, 100, a, b2);
    expect(stateHash(b2.world!)).toBe(room.serverHash);
  });

  it('takes the setup from create and lets only the host change the rules', async () => {
    const rules: GameRules = { credits: 10000, fog: 'off', mapSize: 'large', startUnits: 'army' };
    const setup: SlotSetting[] = ['open', 'ai', ...Array<SlotSetting>(7).fill('closed')];
    const a = client();
    a.create('Alice', rules, setup);
    await until(() => !!a.rules);
    expect(a.rules).toEqual(rules);
    expect(a.lobby.map((s) => s.kind)).toEqual(['human', 'open', 'ai', ...Array(7).fill('closed')]);

    const b = client();
    b.net.join(a.net.code, 'Bob');
    await until(() => b.net.slot === 1 && !!b.rules);
    b.net.setRules({ ...rules, credits: 1000 });
    a.net.setRules({ ...rules, credits: 1234 });
    a.net.setRules({ ...rules, fog: 'explored', extra: 'junk' } as GameRules);
    await until(() => b.rules?.fog === 'explored');
    expect(b.rules).toEqual({ ...rules, fog: 'explored' });

    a.net.start();
    await until(() => !!a.info && !!b.info);
    expect(b.info!.rules).toEqual({ ...rules, fog: 'explored' });
    expect(a.world!.players.every((p) => p.credits === 10000)).toBe(true);
    const room = server.rooms.get(a.net.code)!;
    await runTicks(room, 300, a, b);
    expect(stateHash(a.world!)).toBe(room.serverHash);
    expect(stateHash(b.world!)).toBe(room.serverHash);
  });

  it('falls back to defaults for a malformed setup', async () => {
    const a = client();
    a.net.create('Alice', { credits: 7 } as GameRules, ['human' as SlotSetting], [9], ['brutal' as Difficulty]);
    await until(() => !!a.rules);
    expect(a.rules).toEqual(DEFAULT_RULES);
    expect(a.lobby[1].kind).toBe('ai');
    expect(a.lobby[2].kind).toBe('open');
    expect(a.lobby.every((s) => s.team === 0)).toBe(true);
    expect(a.lobby.every((s) => s.difficulty === 'normal')).toBe(true);
  });

  it('lets only the host set AI difficulty, and starts a match that stays in sync', async () => {
    const a = client();
    const setup: SlotSetting[] = ['open', 'ai', 'ai', 'closed', 'closed', 'closed', 'closed', 'closed', 'closed'];
    a.create('Alice', DEFAULT_RULES, setup, [], ['normal', 'normal', 'easy', 'normal', 'normal', 'normal', 'normal', 'normal', 'normal', 'normal']);
    await until(() => a.net.slot === 0 && a.lobby.length > 0);
    expect(a.lobby[2].difficulty).toBe('easy');
    const b = client();
    b.net.join(a.net.code, 'Bob');
    await until(() => a.lobby[1]?.kind === 'human');
    b.net.setDifficulty(2, 'hard'); // not the host
    a.net.setDifficulty(3, 'nope' as Difficulty);
    a.net.setDifficulty(3, 'hard');
    await until(() => a.lobby[3].difficulty === 'hard');
    expect(a.lobby[2].difficulty).toBe('easy');
    // Humans play Normal whatever their seat says.
    a.net.setDifficulty(1, 'hard');
    await until(() => a.lobby[1].difficulty === 'hard');
    a.net.start();
    await until(() => !!a.info && !!b.info);
    expect(b.info!.players.map((p) => p.difficulty)).toEqual(['normal', 'normal', 'easy', 'hard']);
    expect(b.world!.players.map((p) => p.difficulty)).toEqual(['normal', 'normal', 'easy', 'hard']);
    const room = server.rooms.get(a.net.code)!;
    await runTicks(room, 300, a, b);
    expect(stateHash(a.world!)).toBe(room.serverHash);
    expect(stateHash(b.world!)).toBe(room.serverHash);
  });

  it('lets the host set any team and guests only their own', async () => {
    const a = client();
    // Slot 1 AI, slot 2 open; teams for every slot from the offline lobby.
    a.create('Alice', DEFAULT_RULES, ['ai', 'open', 'closed', 'closed', 'closed', 'closed', 'closed', 'closed', 'closed'], [1, 2, 0, 0, 0, 0, 0, 0, 0, 0]);
    await until(() => a.net.slot === 0 && a.lobby.length > 0);
    expect(a.lobby.map((s) => s.team).slice(0, 3)).toEqual([1, 2, 0]);
    const b = client();
    b.net.join(a.net.code, 'Bob');
    await until(() => a.lobby[2]?.kind === 'human');
    b.net.setTeam(1, 1); // not Bob's slot
    b.net.setTeam(2, 9); // not a team
    b.net.setTeam(2, 2);
    a.net.setTeam(1, 3);
    await until(() => a.lobby[2].team === 2 && a.lobby[1].team === 3);
    expect(a.lobby[1].team).toBe(3);

    // Everyone on one side can't start.
    a.net.setTeam(0, 1);
    a.net.setTeam(1, 1);
    a.net.setTeam(2, 1);
    await until(() => a.lobby.slice(0, 3).every((s) => s.team === 1));
    const room = server.rooms.get(a.net.code)!;
    a.net.start();
    await until(() => a.errors.length > 0);
    expect(a.errors[0]).toMatch(/same team/);
    expect(room.phase).toBe('lobby');
  });

  it('starts a team match that stays in sync', async () => {
    const a = client();
    a.create('Alice', DEFAULT_RULES, ['open', 'ai', 'ai', 'closed', 'closed', 'closed', 'closed', 'closed', 'closed'], [1, 1, 2, 2, 0, 0, 0, 0, 0, 0]);
    await until(() => a.net.slot === 0);
    const b = client();
    b.net.join(a.net.code, 'Bob');
    await until(() => a.lobby[1]?.kind === 'human');
    a.net.start();
    await until(() => !!a.info && !!b.info);
    expect(b.info!.players.map((p) => p.team)).toEqual([1, 1, 2, 2]);
    expect(b.world!.players[0].team).toBe(b.world!.players[1].team);
    expect(b.world!.players[0].team).not.toBe(b.world!.players[2].team);
    const room = server.rooms.get(a.net.code)!;
    await runTicks(room, 300, a, b);
    expect(stateHash(a.world!)).toBe(room.serverHash);
    expect(stateHash(b.world!)).toBe(room.serverHash);
  });

  it('reports a server it cannot reach', async () => {
    const c = new Client('ws://localhost:1/ws');
    clients.push(c);
    c.create('Nobody');
    await until(() => c.errors.length > 0);
    expect(c.errors[0]).toMatch(/reach/);
  });

  it('rejects a bad rejoin token', async () => {
    const { a } = await startMatch();
    const c = client();
    c.net.rejoin(a.net.code, 'not-a-token');
    await until(() => c.errors.length > 0);
    expect(c.info).toBeNull();
  });

  it('refuses new joins once the match has started', async () => {
    const { a } = await startMatch();
    const c = client();
    c.net.join(a.net.code, 'Late');
    await until(() => c.errors.length > 0);
    expect(c.errors[0]).toMatch(/started/);
  });

  it('relays lobby chat to everyone, cleaned up', async () => {
    const a = client();
    a.create('Alice');
    await until(() => a.net.slot === 0);
    const b = client();
    b.net.join(a.net.code, 'Bob');
    await until(() => a.lobby[2]?.name === 'Bob');
    a.net.chat('  hi\u0001 there  ', false);
    a.net.chat('   ', false);
    // Alice has no team, so she can't talk to allies.
    a.net.chat('nobody hears this', true);
    b.net.chat('x'.repeat(300), false);
    await until(() => a.chat.length === 2 && b.chat.length === 2);
    await new Promise((r) => setTimeout(r, 50));
    expect(a.chat).toEqual(['Alice: hi there', `Bob: ${'x'.repeat(MAX_CHAT)}`]);
    expect(b.net.chatLog.map((m) => [m.slot, m.player])).toEqual([
      [0, -1],
      [2, -1],
    ]);
  });

  it('limits how fast one seat can chat', async () => {
    const a = client();
    a.create('Alice');
    await until(() => a.net.slot === 0);
    const b = client();
    b.net.join(a.net.code, 'Bob');
    await until(() => a.lobby[2]?.name === 'Bob');
    for (let i = 0; i < 10; i++) a.net.chat(`spam ${i}`, false);
    await until(() => b.chat.length === 5);
    await new Promise((r) => setTimeout(r, 50));
    expect(b.chat).toEqual([0, 1, 2, 3, 4].map((i) => `Alice: spam ${i}`));
  });

  it('keeps allies chat within the team, also on rejoin, and out of the match log', async () => {
    const a = client();
    a.create('Alice', DEFAULT_RULES, ['open', 'open', 'closed', 'closed', 'closed', 'closed', 'closed', 'closed', 'closed'], [1, 1, 2, 0, 0, 0, 0, 0, 0, 0]);
    await until(() => a.net.slot === 0);
    const b = client();
    b.net.join(a.net.code, 'Bob');
    await until(() => a.lobby[1]?.kind === 'human');
    const c = client();
    c.net.join(a.net.code, 'Cleo');
    await until(() => a.lobby[2]?.kind === 'human');
    a.net.chat('hello all', false);
    await until(() => c.chat.length === 1);
    a.net.start();
    await until(() => !!a.info && !!b.info && !!c.info);
    const room = server.rooms.get(a.net.code)!;

    a.net.chat('rush red', true);
    c.net.chat('turtle up', true);
    b.net.chat('gl hf', false);
    await until(() => a.chat.length === 3 && b.chat.length === 3 && c.chat.length === 3);
    await new Promise((r) => setTimeout(r, 50));
    expect(a.chat).toEqual(['Alice: hello all', '*Alice: rush red', 'Bob: gl hf']);
    expect(b.chat).toEqual(a.chat);
    expect(c.chat).toEqual(['Alice: hello all', '*Cleo: turtle up', 'Bob: gl hf']);
    expect(a.net.chatLog[1].player).toBe(0);

    // A rejoining seat gets the history it may see.
    const token = c.net.token;
    c.net.close();
    const c2 = client();
    c2.net.rejoin(a.net.code, token);
    await until(() => !!c2.info && c2.chat.length === 3);
    expect(c2.chat).toEqual(c.chat);

    // Chat never touches the simulation.
    await runTicks(room, 200, a, b);
    expect(room['log']).toEqual([]);
    expect(stateHash(a.world!)).toBe(room.serverHash);
  });
});
