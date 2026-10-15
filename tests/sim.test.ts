import { describe, expect, it } from 'vitest';
import { applyCommand } from '../src/sim/commands';
import { stateHash } from '../src/sim/hash';
import { findPath } from '../src/sim/pathfinding';
import type { GameRules } from '../src/sim/rules';
import { canPlace } from '../src/sim/systems/construction';
import { stepWorld } from '../src/sim/step';
import { TILE, Terrain, type Entity, type World } from '../src/sim/types';
import { addBuilding, addUnit, createWorld, tileOf } from '../src/sim/world';
import { aiMatch } from './helpers';

function flatWorld(): World {
  const w = createWorld(1);
  w.terrain.fill(Terrain.Grass);
  w.blocked.fill(0);
  w.ore.fill(0);
  w.buildingAt.fill(0);
  w.entities.clear();
  // Keep player 1 alive so the game does not end immediately.
  addBuilding(w, 1, 'cy', 60, 0);
  return w;
}

describe('pathfinding', () => {
  it('finds a straight path on open ground', () => {
    const w = flatWorld();
    const path = findPath(w, 0, 10);
    expect(path[path.length - 1]).toBe(10);
  });

  it('routes around walls and does not cut corners', () => {
    const w = flatWorld();
    for (let y = 0; y < 20; y++) w.blocked[y * w.w + 5] = 1;
    const path = findPath(w, 2 * w.w + 2, 2 * w.w + 8);
    expect(path[path.length - 1]).toBe(2 * w.w + 8);
    expect(path.every((i) => !w.blocked[i])).toBe(true);
  });

  it('goes to the closest reachable tile when the goal is enclosed', () => {
    const w = flatWorld();
    const g = 30 * w.w + 30;
    for (const d of [-w.w - 1, -w.w, -w.w + 1, -1, 1, w.w - 1, w.w, w.w + 1]) w.blocked[g + d] = 1;
    const path = findPath(w, 0, g);
    const last = path[path.length - 1];
    expect(w.blocked[last]).toBe(0);
    expect(Math.abs((last % w.w) - 30)).toBeLessThanOrEqual(2);
  });
});

describe('construction', () => {
  it('requires adjacency to own buildings and free tiles', () => {
    const w = flatWorld();
    w.players[0].credits = 10000;
    addBuilding(w, 0, 'cy', 10, 10);
    expect(canPlace(w, 0, 'power', 14, 10)).toBe(true);
    expect(canPlace(w, 0, 'power', 20, 10)).toBe(false); // too far
    expect(canPlace(w, 0, 'power', 11, 11)).toBe(false); // overlaps
    expect(canPlace(w, 1, 'power', 14, 10)).toBe(false); // not their base
    addUnit(w, 0, 'rifleman', 14 * TILE + 10, 10 * TILE + 10);
    expect(canPlace(w, 0, 'power', 14, 10)).toBe(false); // unit in the way
  });
});

describe('economy', () => {
  it('harvesters bring in credits', () => {
    const w = flatWorld();
    addBuilding(w, 0, 'cy', 5, 5);
    addBuilding(w, 0, 'power', 9, 5);
    for (let y = 15; y < 18; y++) for (let x = 5; x < 8; x++) w.ore[y * w.w + x] = 400;
    w.players[0].queues.building = { items: ['refinery'], progress: 600, spent: 1500, ready: true };
    applyCommand(w, 0, { t: 'place', item: 'refinery', x: 5, y: 9 });
    expect([...w.entities.values()].some((e) => e.type === 'harvester')).toBe(true);
    const before = w.players[0].credits;
    for (let i = 0; i < 1500; i++) stepWorld(w);
    expect(w.players[0].credits).toBeGreaterThan(before + 400);
  });
});

describe('combat', () => {
  it('units shoot enemies in range and they die', () => {
    const w = flatWorld();
    addBuilding(w, 0, 'cy', 1, 1);
    const tank = addUnit(w, 0, 'tank', 20 * TILE, 20 * TILE);
    const rifle = addUnit(w, 1, 'rifleman', 23 * TILE, 20 * TILE);
    for (let i = 0; i < 400; i++) stepWorld(w);
    expect(w.entities.has(rifle.id)).toBe(false);
    expect(w.entities.has(tank.id)).toBe(true);
  });

  it('move orders reach their destination', () => {
    const w = flatWorld();
    addBuilding(w, 0, 'cy', 1, 1);
    const ids = [0, 1, 2, 3].map((k) => addUnit(w, 0, 'rifleman', (10 + k) * TILE, 40 * TILE).id);
    applyCommand(w, 0, { t: 'move', ids, x: 40, y: 20 });
    for (let i = 0; i < 1000; i++) stepWorld(w);
    for (const id of ids) {
      const e = w.entities.get(id)!;
      expect(e.order.t).toBe('idle');
      const t = tileOf(w, e.x, e.y);
      expect(Math.abs((t % w.w) - 40)).toBeLessThanOrEqual(3);
    }
  });
});

describe('production', () => {
  it('sends new units to the rally point', () => {
    const w = flatWorld();
    w.players[0].credits = 10000;
    addBuilding(w, 0, 'cy', 5, 5);
    addBuilding(w, 0, 'power', 9, 5);
    const rax = addBuilding(w, 0, 'barracks', 5, 9);
    applyCommand(w, 0, { t: 'rally', ids: [rax.id], x: 40, y: 20 });
    expect([rax.rallyX, rax.rallyY]).toEqual([40, 20]);
    applyCommand(w, 0, { t: 'build', item: 'rifleman' });
    let rifle: Entity | undefined;
    for (let i = 0; i < 3000 && !rifle; i++) {
      stepWorld(w);
      rifle = [...w.entities.values()].find((e) => e.owner === 0 && e.type === 'rifleman');
    }
    expect(rifle).toBeDefined();
    for (let i = 0; i < 800; i++) stepWorld(w);
    const t = tileOf(w, rifle!.x, rifle!.y);
    expect(Math.abs((t % w.w) - 40)).toBeLessThanOrEqual(1);
    expect(Math.abs(Math.floor(t / w.w) - 20)).toBeLessThanOrEqual(1);
  });

  it('clears the rally point on the building itself and ignores other players', () => {
    const w = flatWorld();
    const rax = addBuilding(w, 0, 'barracks', 5, 9);
    applyCommand(w, 1, { t: 'rally', ids: [rax.id], x: 40, y: 20 });
    expect(rax.rallyX).toBe(-1);
    applyCommand(w, 0, { t: 'rally', ids: [rax.id], x: 40, y: 20 });
    applyCommand(w, 0, { t: 'rally', ids: [rax.id], x: rax.tx, y: rax.ty });
    expect([rax.rallyX, rax.rallyY]).toEqual([-1, -1]);
  });
});

describe('rules', () => {
  const units = (w: World, owner: number) => [...w.entities.values()].filter((e) => e.owner === owner && e.kind === 'unit').map((e) => e.type);

  it('sets starting credits and units', () => {
    const w = createWorld(3, 3, { credits: 5000, fog: 'full', mapSize: 'auto', startUnits: 'army' });
    for (const p of w.players) {
      expect(p.credits).toBe(5000);
      expect(units(w, p.id).sort()).toEqual(['rifleman', 'rifleman', 'rifleman', 'rifleman', 'tank', 'tank']);
    }
    // Every starting unit stands on open ground.
    for (const e of w.entities.values()) if (e.kind === 'unit') expect(w.blocked[tileOf(w, e.x, e.y)]).toBe(0);
    expect(units(createWorld(3, 2, { credits: 1000, fog: 'full', mapSize: 'auto', startUnits: 'none' }), 0)).toEqual([]);
    expect(units(createWorld(3), 0)).toEqual(['rifleman', 'rifleman']);
  });

  it('picks the map size, but never too small for the players', () => {
    const rules = (mapSize: GameRules['mapSize']): GameRules => ({ credits: 3000, fog: 'full', mapSize, startUnits: 'squad' });
    expect(createWorld(1, 2, rules('huge')).w).toBe(160);
    expect(createWorld(1, 4, rules('small')).w).toBe(64);
    expect(createWorld(1, 8, rules('small')).w).toBe(96);
    expect(createWorld(1, 10, rules('auto')).w).toBe(160);
  });

  it('fog: explored map and no fog', () => {
    const explored = createWorld(1, 2, { credits: 3000, fog: 'explored', mapSize: 'auto', startUnits: 'squad' });
    stepWorld(explored);
    expect(explored.explored[0].every((v) => v === 1)).toBe(true);
    expect(explored.visible[0].every((v) => v === 1)).toBe(false);
    const off = createWorld(1, 2, { credits: 3000, fog: 'off', mapSize: 'auto', startUnits: 'squad' });
    for (let i = 0; i < 5; i++) stepWorld(off);
    expect(off.visible[1].every((v) => v === 1)).toBe(true);
    expect(off.explored[1].every((v) => v === 1)).toBe(true);
  });

  it('is part of the state hash', () => {
    const a = createWorld(5, 2, { credits: 3000, fog: 'full', mapSize: 'auto', startUnits: 'squad' });
    const b = createWorld(5, 2, { credits: 3000, fog: 'off', mapSize: 'auto', startUnits: 'squad' });
    expect(stateHash(a)).not.toBe(stateHash(b));
  });
});

describe('AI match', () => {
  it('is deterministic with non-default rules', () => {
    const rules: GameRules = { credits: 10000, fog: 'off', mapSize: 'medium', startUnits: 'army' };
    const a = aiMatch(8, 3, rules);
    const b = aiMatch(8, 3, rules);
    for (let i = 0; i < 2000; i++) {
      a.step();
      b.step();
    }
    expect(stateHash(a.world)).toBe(stateHash(b.world));
  });

  it('is deterministic', () => {
    const a = aiMatch(42);
    const b = aiMatch(42);
    for (let i = 0; i < 3000; i++) {
      a.step();
      b.step();
      if (i % 100 === 0) expect(stateHash(a.world)).toBe(stateHash(b.world));
    }
    expect(stateHash(a.world)).toBe(stateHash(b.world));
  });

  it('is deterministic with 10 players', () => {
    const a = aiMatch(11, 10);
    const b = aiMatch(11, 10);
    expect(a.world.w).toBe(160);
    for (let i = 0; i < 3000; i++) {
      a.step();
      b.step();
    }
    expect(stateHash(a.world)).toBe(stateHash(b.world));
    // Every AI got its economy going.
    for (const p of a.world.players) expect([...a.world.entities.values()].some((e) => e.owner === p.id && e.type === 'refinery')).toBe(true);
  });

  it('AIs build a base and an army', () => {
    const { world, step } = aiMatch(7);
    for (let i = 0; i < 6000; i++) step();
    for (const p of world.players) {
      const mine = [...world.entities.values()].filter((e) => e.owner === p.id);
      const types = new Set(mine.map((e) => e.type));
      console.log(`p${p.id}: credits=${p.credits} power=${p.powerProduced}/${p.powerUsed}`, [...types].join(','), mine.length);
    }
    const all = [...world.entities.values()];
    expect(all.some((e) => e.type === 'refinery')).toBe(true);
    expect(all.some((e) => e.type === 'factory')).toBe(true);
  });
});
