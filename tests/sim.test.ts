import { describe, expect, it } from 'vitest';
import { isValidCommand } from '../src/net/protocol';
import { applyCommand } from '../src/sim/commands';
import { stateHash } from '../src/sim/hash';
import { itemBuildTicks, itemCost } from '../src/sim/data/items';
import { findPath } from '../src/sim/pathfinding';
import { DEFAULT_RULES, type Difficulty, type GameRules } from '../src/sim/rules';
import { acquireTarget } from '../src/sim/systems/combat';
import { canPlace, wallLine } from '../src/sim/systems/construction';
import { powerEfficiency, updatePower } from '../src/sim/systems/production';
import { updateFog } from '../src/sim/systems/fog';
import { stepWorld } from '../src/sim/step';
import { TILE, Terrain, type Entity, type World } from '../src/sim/types';
import { addBuilding, addUnit, createWorld, removeEntity, tileOf } from '../src/sim/world';
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

describe('jeep', () => {
  it('is built at a factory', () => {
    const w = flatWorld();
    w.players[0].credits = 10000;
    addBuilding(w, 0, 'cy', 5, 5);
    addBuilding(w, 0, 'power', 9, 5);
    applyCommand(w, 0, { t: 'build', item: 'jeep' });
    expect(w.players[0].queues.vehicle.items).toEqual([]);
    addBuilding(w, 0, 'factory', 5, 9);
    applyCommand(w, 0, { t: 'build', item: 'jeep' });
    expect(w.players[0].queues.vehicle.items).toEqual(['jeep']);
    let jeep: Entity | undefined;
    for (let i = 0; i < 3000 && !jeep; i++) {
      stepWorld(w);
      jeep = [...w.entities.values()].find((e) => e.owner === 0 && e.type === 'jeep');
    }
    expect(jeep).toBeDefined();
    expect(isValidCommand({ t: 'build', item: 'jeep' })).toBe(true);
  });

  it('outruns a tank', () => {
    const w = flatWorld();
    addBuilding(w, 0, 'cy', 5, 40);
    const jeep = addUnit(w, 0, 'jeep', 2 * TILE + TILE / 2, 10 * TILE + TILE / 2);
    const tank = addUnit(w, 0, 'tank', 2 * TILE + TILE / 2, 20 * TILE + TILE / 2);
    applyCommand(w, 0, { t: 'move', ids: [jeep.id], x: 50, y: 10 });
    applyCommand(w, 0, { t: 'move', ids: [tank.id], x: 50, y: 20 });
    for (let i = 0; i < 60; i++) stepWorld(w);
    expect(jeep.x - 2 * TILE).toBeGreaterThan((tank.x - 2 * TILE) * 1.5);
  });

  it('sees further than a tank', () => {
    const seen = (type: 'jeep' | 'tank') => {
      const w = flatWorld();
      w.entities.clear();
      addBuilding(w, 1, 'cy', 60, 60);
      addUnit(w, 0, type, 30 * TILE + TILE / 2, 30 * TILE + TILE / 2);
      updateFog(w);
      return w.visible[0].reduce((n, v) => n + v, 0);
    };
    expect(seen('jeep')).toBeGreaterThan(seen('tank') * 1.8);
  });
});

describe('defenses', () => {
  /** Player 0 base at the left with spare power. */
  function base(): World {
    const w = flatWorld();
    addBuilding(w, 0, 'cy', 5, 20);
    addBuilding(w, 0, 'power', 9, 20);
    return w;
  }
  const at = (t: number) => t * TILE + TILE / 2;

  it('a pillbox kills approaching riflemen', () => {
    const w = base();
    const box = addBuilding(w, 0, 'pillbox', 12, 20);
    const rifles = [0, 1, 2].map((k) => addUnit(w, 1, 'rifleman', at(30), at(19 + k)));
    applyCommand(w, 1, { t: 'attackMove', ids: rifles.map((e) => e.id), x: 12, y: 20 });
    for (let i = 0; i < 1200; i++) stepWorld(w);
    expect(rifles.every((e) => !w.entities.has(e.id))).toBe(true);
    expect(w.entities.has(box.id)).toBe(true);
  });

  it('a turret beats a lone tank that attacks it', () => {
    const w = base();
    const turret = addBuilding(w, 0, 'turret', 12, 20);
    const tank = addUnit(w, 1, 'tank', at(30), at(20));
    applyCommand(w, 1, { t: 'attack', ids: [tank.id], target: turret.id });
    for (let i = 0; i < 1500; i++) stepWorld(w);
    expect(w.entities.has(tank.id)).toBe(false);
    expect(w.entities.has(turret.id)).toBe(true);
  });

  it('a turret prefers vehicles and a pillbox prefers infantry', () => {
    const w = base();
    const turret = addBuilding(w, 0, 'turret', 12, 18);
    const box = addBuilding(w, 0, 'pillbox', 12, 22);
    const rifle = addUnit(w, 1, 'rifleman', at(15), at(20));
    const tank = addUnit(w, 1, 'tank', at(16), at(20));
    updateFog(w);
    stepWorld(w);
    expect(turret.targetId).toBe(tank.id);
    expect(box.targetId).toBe(rifle.id);
  });

  it('goes offline at low power and comes back when power returns', () => {
    const w = base();
    const plant = [...w.entities.values()].find((e) => e.type === 'power')!;
    const turret = addBuilding(w, 0, 'turret', 12, 20);
    removeEntity(w, plant);
    const tank = addUnit(w, 1, 'tank', at(16), at(20));
    for (let i = 0; i < 100; i++) stepWorld(w);
    expect(tank.hp).toBe(tank.maxHp);
    expect(turret.targetId).toBe(0);
    addBuilding(w, 0, 'power', 9, 20);
    for (let i = 0; i < 100; i++) stepWorld(w);
    expect(tank.hp).toBeLessThan(tank.maxHp);
  });

  it('walls are not auto-targeted but can be attacked on order', () => {
    const w = base();
    const wall = addBuilding(w, 0, 'wall', 12, 20);
    const tank = addUnit(w, 1, 'tank', at(15), at(20));
    for (let i = 0; i < 100; i++) stepWorld(w);
    // Idle in sight of the wall (and the base), it shoots the base, never the wall.
    expect(wall.hp).toBe(wall.maxHp);
    applyCommand(w, 1, { t: 'attack', ids: [tank.id], target: wall.id });
    for (let i = 0; i < 100; i++) stepWorld(w);
    expect(wall.hp).toBeLessThan(wall.maxHp);
  });

  it('walls and defenses do not extend the build area', () => {
    const w = base();
    addBuilding(w, 0, 'wall', 12, 20);
    addBuilding(w, 0, 'turret', 15, 20);
    expect(canPlace(w, 0, 'power', 17, 20)).toBe(false);
    expect(canPlace(w, 0, 'power', 12, 22)).toBe(true);
  });

  it('a player with only walls left is defeated', () => {
    const w = flatWorld();
    addBuilding(w, 0, 'wall', 10, 10);
    for (let i = 0; i < 10; i++) stepWorld(w);
    expect(w.players[0].defeated).toBe(true);
  });
});

describe('low power', () => {
  /** CY (+15) and barracks (-20), plus extra consumers. */
  function lowBase(power: GameRules['power'], extra: ('factory' | 'refinery')[] = []): World {
    const w = flatWorld();
    w.rules = { ...w.rules, power };
    w.players[0].credits = 10000;
    addBuilding(w, 0, 'cy', 5, 5);
    addBuilding(w, 0, 'barracks', 5, 9);
    extra.forEach((t, i) => addBuilding(w, 0, t, 10 + i * 4, 5));
    updatePower(w);
    return w;
  }

  it('scales efficiency with the shortfall under full rules, down to a floor', () => {
    const p = (w: World) => powerEfficiency(w, w.players[0]);
    expect(p(lowBase('full'))).toBe(75); // 15 / 20
    expect(p(lowBase('full', ['factory']))).toBe(30); // 15 / 50
    expect(p(lowBase('full', ['factory', 'refinery']))).toBe(25); // 15 / 90, floored
    expect(p(lowBase('basic', ['factory', 'refinery']))).toBe(50);
    expect(p(lowBase('basic'))).toBe(50);
  });

  it('slows production by the efficiency', () => {
    for (const [power, step] of [['full', 150], ['basic', 100]] as const) {
      const w = lowBase(power);
      applyCommand(w, 0, { t: 'build', item: 'rifleman' });
      stepWorld(w);
      expect(w.players[0].queues.infantry.progress).toBe(step);
    }
  });

  it('damaged power producers yield less under full rules only', () => {
    for (const [power, produced] of [['full', 15 + 50], ['basic', 115]] as const) {
      const w = lowBase(power);
      const plant = addBuilding(w, 0, 'power', 9, 9);
      plant.hp = plant.maxHp / 2;
      updatePower(w);
      expect(w.players[0].powerProduced).toBe(produced);
    }
  });

  it('slows refining under full rules', () => {
    function ticksToUnload(power: GameRules['power'], plant: boolean): number {
      const w = flatWorld();
      w.rules = { ...w.rules, power };
      w.players[0].credits = 0;
      addBuilding(w, 0, 'cy', 5, 10);
      if (plant) addBuilding(w, 0, 'power', 9, 5);
      const ref = addBuilding(w, 0, 'refinery', 5, 5);
      const harv = addUnit(w, 0, 'harvester', 6 * TILE, 8 * TILE);
      harv.cargo = 100;
      harv.order = { t: 'harvest', state: 'unloading', tx: -1, ty: -1, refinery: ref.id };
      for (let i = 1; i < 100; i++) {
        stepWorld(w);
        if (harv.cargo === 0) {
          expect(w.players[0].credits).toBe(100);
          return i;
        }
      }
      throw new Error('never unloaded');
    }
    expect(ticksToUnload('full', true)).toBe(4);
    expect(ticksToUnload('basic', false)).toBe(4);
    // 15 / 40 power: 37% of ticks.
    expect(ticksToUnload('full', false)).toBeGreaterThanOrEqual(10);
  });

  it('is part of the state hash', () => {
    expect(stateHash(createWorld(5, 2, { ...DEFAULT_RULES, power: 'basic' }))).not.toBe(stateHash(createWorld(5, 2, { ...DEFAULT_RULES, power: 'full' })));
  });
});

describe('wall lines', () => {
  function ready(w: World) {
    w.players[0].queues.building = { items: ['wall'], progress: 4000, spent: 25, ready: true };
  }
  const walls = (w: World) => [...w.entities.values()].filter((e) => e.type === 'wall');

  it('places a line and charges each extra segment', () => {
    const w = flatWorld();
    addBuilding(w, 0, 'cy', 5, 5);
    w.players[0].credits = 1000;
    ready(w);
    applyCommand(w, 0, { t: 'place', item: 'wall', x: 8, y: 5, x2: 13, y2: 6 });
    // Snapped to the row, 6 segments, 5 of them paid on placement.
    expect(walls(w).map((e) => [e.tx, e.ty])).toEqual([5, 6, 7, 8, 9, 10].map((k) => [k + 3, 5]));
    expect(w.players[0].credits).toBe(1000 - 5 * 25);
    expect(w.players[0].queues.building.items).toEqual([]);
  });

  it('is capped, stops at obstacles and at the credit limit', () => {
    const w = flatWorld();
    addBuilding(w, 0, 'cy', 5, 5);
    expect(wallLine(w, 0, 8, 5, 30, 5, 10000)).toHaveLength(8);
    w.blocked[5 * w.w + 11] = 1;
    expect(wallLine(w, 0, 8, 5, 30, 5, 10000)).toHaveLength(3);
    expect(wallLine(w, 0, 8, 5, 30, 5, 50)).toHaveLength(3);
    expect(wallLine(w, 0, 8, 5, 30, 5, 49)).toHaveLength(2);
    // The first segment still has to be near the base.
    expect(wallLine(w, 0, 30, 30, 35, 30, 10000)).toHaveLength(0);
  });

  it('accepts the line end in the protocol', () => {
    expect(isValidCommand({ t: 'place', item: 'wall', x: 1, y: 2 })).toBe(true);
    expect(isValidCommand({ t: 'place', item: 'wall', x: 1, y: 2, x2: 5, y2: 2 })).toBe(true);
    expect(isValidCommand({ t: 'place', item: 'wall', x: 1, y: 2, x2: 'far', y2: 2 })).toBe(false);
    expect(isValidCommand({ t: 'place', item: 'wall', x: 1, y: 2, x2: 99999, y2: 2 })).toBe(false);
  });
});

describe('rules', () => {
  const units = (w: World, owner: number) => [...w.entities.values()].filter((e) => e.owner === owner && e.kind === 'unit').map((e) => e.type);

  it('sets starting credits and units', () => {
    const w = createWorld(3, 3, { credits: 5000, fog: 'full', mapSize: 'auto', startUnits: 'army', terrain: 'rich', power: 'full' });
    for (const p of w.players) {
      expect(p.credits).toBe(5000);
      expect(units(w, p.id).sort()).toEqual(['rifleman', 'rifleman', 'rifleman', 'rifleman', 'tank', 'tank']);
    }
    // Every starting unit stands on open ground.
    for (const e of w.entities.values()) if (e.kind === 'unit') expect(w.blocked[tileOf(w, e.x, e.y)]).toBe(0);
    expect(units(createWorld(3, 2, { credits: 1000, fog: 'full', mapSize: 'auto', startUnits: 'none', terrain: 'rich', power: 'full' }), 0)).toEqual([]);
    expect(units(createWorld(3), 0)).toEqual(['rifleman', 'rifleman']);
  });

  it('picks the map size, but never too small for the players', () => {
    const rules = (mapSize: GameRules['mapSize']): GameRules => ({ credits: 3000, fog: 'full', mapSize, startUnits: 'squad', terrain: 'rich', power: 'full' });
    expect(createWorld(1, 2, rules('huge')).w).toBe(160);
    expect(createWorld(1, 4, rules('small')).w).toBe(64);
    expect(createWorld(1, 8, rules('small')).w).toBe(96);
    expect(createWorld(1, 10, rules('auto')).w).toBe(160);
  });

  it('fog: explored map and no fog', () => {
    const explored = createWorld(1, 2, { credits: 3000, fog: 'explored', mapSize: 'auto', startUnits: 'squad', terrain: 'rich', power: 'full' });
    stepWorld(explored);
    expect(explored.explored[0].every((v) => v === 1)).toBe(true);
    expect(explored.visible[0].every((v) => v === 1)).toBe(false);
    const off = createWorld(1, 2, { credits: 3000, fog: 'off', mapSize: 'auto', startUnits: 'squad', terrain: 'rich', power: 'full' });
    for (let i = 0; i < 5; i++) stepWorld(off);
    expect(off.visible[1].every((v) => v === 1)).toBe(true);
    expect(off.explored[1].every((v) => v === 1)).toBe(true);
  });

  it('is part of the state hash', () => {
    const a = createWorld(5, 2, { credits: 3000, fog: 'full', mapSize: 'auto', startUnits: 'squad', terrain: 'rich', power: 'full' });
    const b = createWorld(5, 2, { credits: 3000, fog: 'off', mapSize: 'auto', startUnits: 'squad', terrain: 'rich', power: 'full' });
    expect(stateHash(a)).not.toBe(stateHash(b));
  });
});

/** Three players on open ground: 0 and 1 are allies, 2 is on their own. Player 2 keeps a yard so the game runs. */
function teamWorld(): World {
  const w = createWorld(1, 3, DEFAULT_RULES, [1, 1, 0]);
  w.terrain.fill(Terrain.Grass);
  w.blocked.fill(0);
  w.ore.fill(0);
  w.buildingAt.fill(0);
  w.entities.clear();
  addBuilding(w, 1, 'cy', 60, 0);
  addBuilding(w, 2, 'cy', 60, 60);
  return w;
}

describe('teams', () => {
  it('allies never shoot each other, enemies still do', () => {
    const w = teamWorld();
    const a = addUnit(w, 0, 'tank', 20 * TILE, 20 * TILE);
    const b = addUnit(w, 1, 'tank', 21 * TILE, 20 * TILE);
    for (let i = 0; i < 60; i++) stepWorld(w);
    expect(a.hp).toBe(a.maxHp);
    expect(b.hp).toBe(b.maxHp);
    const c = addUnit(w, 2, 'rifleman', 22 * TILE, 21 * TILE);
    for (let i = 0; i < 60; i++) stepWorld(w);
    expect(c.hp).toBeLessThan(c.maxHp);
  });

  it('ignores attack orders on allies', () => {
    const w = teamWorld();
    const a = addUnit(w, 0, 'tank', 20 * TILE, 20 * TILE);
    const b = addUnit(w, 1, 'tank', 30 * TILE, 20 * TILE);
    applyCommand(w, 0, { t: 'attack', ids: [a.id], target: b.id });
    expect(a.order.t).toBe('idle');
  });

  it('shares vision with allies only', () => {
    const w = teamWorld();
    const u = addUnit(w, 1, 'rifleman', 30 * TILE + TILE / 2, 30 * TILE + TILE / 2);
    stepWorld(w);
    const i = tileOf(w, u.x, u.y);
    expect(w.visible[0][i]).toBe(1);
    expect(w.explored[0][i]).toBe(1);
    expect(w.visible[2][i]).toBe(0);
  });

  it('lets allies build next to each other', () => {
    const w = teamWorld();
    addBuilding(w, 1, 'cy', 10, 10);
    expect(canPlace(w, 0, 'power', 14, 10)).toBe(true);
    expect(canPlace(w, 2, 'power', 14, 10)).toBe(false);
  });

  it('ends when one team is left', () => {
    const w = teamWorld();
    // Player 0 has no buildings and is out, but their ally plays on.
    for (let i = 0; i < 20; i++) stepWorld(w);
    expect(w.players[0].defeated).toBe(true);
    expect(w.winner).toBe(-1);
    for (const e of [...w.entities.values()]) if (e.owner === 2) w.entities.delete(e.id);
    for (let i = 0; i < 20; i++) stepWorld(w);
    expect(w.winner).toBe(1);
  });

  it('is part of the state hash', () => {
    expect(stateHash(createWorld(5, 3, DEFAULT_RULES, [1, 1, 0]))).not.toBe(stateHash(createWorld(5, 3)));
  });

  const teamRules: GameRules = { credits: 10000, fog: 'full', mapSize: 'small', startUnits: 'army', terrain: 'rich', power: 'full' };

  it('a 2v2 AI match is deterministic', () => {
    const a = aiMatch(4, 4, teamRules, [1, 1, 2, 2]);
    const b = aiMatch(4, 4, teamRules, [1, 1, 2, 2]);
    for (let i = 0; i < 2000; i++) {
      a.step();
      b.step();
    }
    expect(stateHash(a.world)).toBe(stateHash(b.world));
  });

  it('a 2v2 AI match ends with one team standing', () => {
    const { world, step } = aiMatch(9, 4, teamRules, [1, 1, 2, 2]);
    // Defended bases take a while to break, so allow 20 minutes of game time.
    for (let i = 0; i < 24000 && world.winner < 0; i++) step();
    expect(world.winner).toBeGreaterThanOrEqual(0);
    expect(world.winner).toBeLessThan(4);
    const team = world.players[world.winner].team;
    // Everyone on the other team is out.
    for (const p of world.players) if (p.team !== team) expect(p.defeated).toBe(true);
  }, 40000);
});

describe('difficulty', () => {
  function ticksToTrain(difficulty: Difficulty): number {
    const w = flatWorld();
    w.players[0].difficulty = difficulty;
    w.players[0].credits = 10000;
    addBuilding(w, 0, 'cy', 5, 5);
    addBuilding(w, 0, 'power', 9, 5);
    addBuilding(w, 0, 'barracks', 5, 9);
    applyCommand(w, 0, { t: 'build', item: 'rifleman' });
    for (let i = 1; i < 3000; i++) {
      stepWorld(w);
      if ([...w.entities.values()].some((e) => e.owner === 0 && e.type === 'rifleman')) {
        // Same price whatever the speed.
        expect(w.players[0].credits).toBe(10000 - itemCost('rifleman'));
        return i;
      }
    }
    throw new Error('never trained');
  }

  it('changes build speed', () => {
    const normal = ticksToTrain('normal');
    expect(normal).toBe(itemBuildTicks('rifleman'));
    expect(ticksToTrain('hard')).toBe(Math.ceil(normal / 1.5));
    expect(ticksToTrain('easy')).toBe(Math.ceil(normal / 0.75));
  });

  function unload(difficulty: Difficulty): number {
    const w = flatWorld();
    w.players[0].difficulty = difficulty;
    w.players[0].credits = 0;
    addBuilding(w, 0, 'power', 9, 5);
    const ref = addBuilding(w, 0, 'refinery', 5, 5);
    const harv = addUnit(w, 0, 'harvester', 6 * TILE, 8 * TILE);
    harv.cargo = 100;
    harv.order = { t: 'harvest', state: 'unloading', tx: -1, ty: -1, refinery: ref.id };
    for (let i = 0; i < 10 && harv.cargo > 0; i++) stepWorld(w);
    expect(harv.cargo).toBe(0);
    return w.players[0].credits;
  }

  it('changes harvest income', () => {
    expect(unload('normal')).toBe(100);
    expect(unload('hard')).toBe(140);
    expect(unload('easy')).toBe(80);
  });

  it('is part of the state hash', () => {
    expect(stateHash(createWorld(5, 2, DEFAULT_RULES, [], ['normal', 'hard']))).not.toBe(stateHash(createWorld(5)));
    expect(stateHash(createWorld(5, 2, DEFAULT_RULES, [], ['normal', 'normal']))).toBe(stateHash(createWorld(5)));
  });

  it('a mixed-difficulty AI match is deterministic', () => {
    const a = aiMatch(6, 3, DEFAULT_RULES, [], ['easy', 'normal', 'hard']);
    const b = aiMatch(6, 3, DEFAULT_RULES, [], ['easy', 'normal', 'hard']);
    for (let i = 0; i < 2000; i++) {
      a.step();
      b.step();
    }
    expect(stateHash(a.world)).toBe(stateHash(b.world));
  });
});

describe('AI match', () => {
  it('is deterministic with non-default rules', () => {
    const rules: GameRules = { credits: 10000, fog: 'off', mapSize: 'medium', startUnits: 'army', terrain: 'rich', power: 'basic' };
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
    expect(all.some((e) => e.type === 'pillbox' || e.type === 'turret')).toBe(true);
  });
});

describe('terrain', () => {
  /** Set a rectangle of tiles to a terrain type (and keep `blocked` in sync). */
  function paint(w: World, x0: number, y0: number, x1: number, y1: number, t: number) {
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        w.terrain[y * w.w + x] = t;
        w.blocked[y * w.w + x] = t === Terrain.Rock || t === Terrain.Water ? 1 : 0;
      }
    }
  }

  function distanceIn(t: number, ticks: number): number {
    const w = flatWorld();
    addBuilding(w, 0, 'cy', 5, 30);
    paint(w, 0, 10, 50, 10, t);
    const tank = addUnit(w, 0, 'tank', 2 * TILE + TILE / 2, 10 * TILE + TILE / 2);
    applyCommand(w, 0, { t: 'move', ids: [tank.id], x: 45, y: 10 });
    for (let i = 0; i < ticks; i++) stepWorld(w);
    return tank.x - 2 * TILE;
  }

  it('roads speed vehicles up and forests slow them down', () => {
    const grass = distanceIn(Terrain.Grass, 40);
    expect(distanceIn(Terrain.Road, 40)).toBeGreaterThan(grass * 1.3);
    expect(distanceIn(Terrain.Forest, 40)).toBeLessThan(grass * 0.7);
  });

  it('paths detour along a road instead of through forest, and keep to it', () => {
    const w = flatWorld();
    // Forest band from x=5 to x=30, with a road running around it.
    paint(w, 5, 0, 30, 20, Terrain.Forest);
    paint(w, 4, 21, 31, 22, Terrain.Road);
    paint(w, 3, 10, 4, 22, Terrain.Road);
    paint(w, 31, 10, 32, 22, Terrain.Road);
    const path = findPath(w, 10 * w.w + 2, 10 * w.w + 34, 'vehicle');
    expect(path[path.length - 1]).toBe(10 * w.w + 34);
    // No waypoint, and no straight leg between waypoints, crosses the forest.
    let prev = 10 * w.w + 2;
    for (const node of path) {
      for (let k = 0; k <= 16; k++) {
        const x = Math.floor(((prev % w.w) * (16 - k) + (node % w.w) * k) / 16 + 0.5);
        const y = Math.floor((Math.floor(prev / w.w) * (16 - k) + Math.floor(node / w.w) * k) / 16 + 0.5);
        expect(w.terrain[y * w.w + x]).not.toBe(Terrain.Forest);
      }
      prev = node;
    }
    // Infantry barely slow down in forest, so for them the straight line wins.
    const walk = findPath(w, 10 * w.w + 2, 10 * w.w + 34, 'infantry');
    expect(walk.length).toBeLessThanOrEqual(2);
    expect(walk.every((i) => Math.floor(i / w.w) === 10)).toBe(true);
  });

  it('forests block sight beyond their edge', () => {
    const w = flatWorld();
    w.entities.clear();
    addBuilding(w, 1, 'cy', 60, 60);
    paint(w, 13, 0, 14, 30, Terrain.Forest);
    addUnit(w, 0, 'tank', 10 * TILE + TILE / 2, 20 * TILE + TILE / 2);
    updateFog(w);
    const vis = w.visible[0];
    expect(vis[20 * w.w + 12]).toBe(1);
    // The forest edge is seen, the next forest tile and everything behind it isn't.
    expect(vis[20 * w.w + 13]).toBe(1);
    expect(vis[20 * w.w + 14]).toBe(0);
    expect(vis[20 * w.w + 15]).toBe(0);
    // Open ground still seen around the forest.
    expect(vis[15 * w.w + 10]).toBe(1);
  });

  it('units hidden in forest are not targeted until they step out', () => {
    const w = flatWorld();
    paint(w, 13, 0, 15, 30, Terrain.Forest);
    const tank = addUnit(w, 0, 'tank', 10 * TILE + TILE / 2, 20 * TILE + TILE / 2);
    const hidden = addUnit(w, 1, 'rifleman', 15 * TILE + TILE / 2, 20 * TILE + TILE / 2);
    updateFog(w);
    expect(acquireTarget(w, tank, 6 * TILE)).toBeNull();
    hidden.x = 12 * TILE + TILE / 2;
    updateFog(w);
    expect(acquireTarget(w, tank, 6 * TILE)).toBe(hidden);
  });

  it('allows building on roads but not in forest or on bridges', () => {
    const w = flatWorld();
    addBuilding(w, 0, 'cy', 5, 5);
    paint(w, 8, 5, 9, 6, Terrain.Road);
    expect(canPlace(w, 0, 'power', 8, 5)).toBe(true);
    paint(w, 8, 5, 9, 6, Terrain.Forest);
    expect(canPlace(w, 0, 'power', 8, 5)).toBe(false);
    paint(w, 8, 5, 9, 6, Terrain.Bridge);
    expect(canPlace(w, 0, 'power', 8, 5)).toBe(false);
  });
});
