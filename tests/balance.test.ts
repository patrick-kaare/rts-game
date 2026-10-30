import { describe, expect, it } from 'vitest';
import { applyCommand } from '../src/sim/commands';
import { startHarvesting } from '../src/sim/systems/economy';
import { stepWorld } from '../src/sim/step';
import { TILE, type Entity, type UnitType, type World } from '../src/sim/types';
import { addBuilding, addUnit } from '../src/sim/world';
import { DAMAGE_TABLE, UNITS } from '../src/sim/data/units';
import { aiMatch, flatWorld } from './helpers';

const at = (t: number) => t * TILE + TILE / 2;

/** Units of `type` for `player`, lined up in a column at tile column `x`. */
function line(w: World, player: number, type: UnitType, n: number, x: number) {
  for (let i = 0; i < n; i++) addUnit(w, player, type, at(x), at(10 + i * 2));
}

/** Pits `na` of `a` (player 0) against `nb` of `b` (player 1) on open ground. */
function duel(a: UnitType, na: number, b: UnitType, nb: number, maxTicks = 3000) {
  const w = flatWorld();
  line(w, 0, a, na, 10);
  line(w, 1, b, nb, 14);
  // Give player 0 a base so a wiped-out army is not an instant defeat that hides the result.
  addBuilding(w, 0, 'cy', 2, 2);
  let ticks = 0;
  const count = (p: number) => [...w.entities.values()].filter((e) => e.owner === p && e.kind === 'unit').length;
  while (ticks < maxTicks && count(0) > 0 && count(1) > 0) {
    // Idle units march on the nearest enemy unit, so survivors keep fighting.
    if (ticks % 10 === 0) {
      const units = [...w.entities.values()].filter((e) => e.kind === 'unit');
      for (const e of units) {
        if (e.order.t !== 'idle') continue;
        let best: Entity | undefined;
        let bestD = Infinity;
        for (const o of units) {
          if (o.owner === e.owner) continue;
          const d = (o.x - e.x) ** 2 + (o.y - e.y) ** 2;
          if (d < bestD) { bestD = d; best = o; }
        }
        if (best) applyCommand(w, e.owner, { t: 'attackMove', ids: [e.id], x: Math.floor(best.x / TILE), y: Math.floor(best.y / TILE) });
      }
    }
    stepWorld(w);
    ticks++;
  }
  return { ticks, a: count(0), b: count(1) };
}

describe('unit balance', () => {
  // Cost parity targets: a tank (700) is about 4-5 riflemen (100 each); a jeep (400) loses to 4 riflemen.
  it('a tank beats 4 riflemen but 6 riflemen beat a tank', () => {
    const four = duel('tank', 1, 'rifleman', 4);
    expect(four.a).toBe(1);
    const six = duel('tank', 1, 'rifleman', 6);
    expect(six.a).toBe(0);
    expect(six.b).toBeGreaterThan(0);
  });

  it('riflemen are not reduced to the 1-damage floor against vehicles', () => {
    // Rifleman/jeep bullets must do more than 1 per hit to vehicles, or numbers cannot trade with a tank.
    for (const t of ['rifleman', 'jeep'] as const) {
      const weapon = UNITS[t].weapon!;
      expect(Math.floor((weapon.damage * DAMAGE_TABLE[weapon.kind].vehicle) / 100)).toBeGreaterThan(1);
    }
  });

  it('a jeep beats 2 riflemen, loses to 4, and a tank beats 2 jeeps', () => {
    expect(duel('jeep', 1, 'rifleman', 2).a).toBe(1);
    expect(duel('jeep', 1, 'rifleman', 4).a).toBe(0);
    expect(duel('tank', 1, 'jeep', 2).a).toBe(1);
  });
});

describe('economy', () => {
  it('one harvester earns about 1000 credits in its first 30 seconds', () => {
    const w = flatWorld();
    addBuilding(w, 0, 'cy', 5, 5);
    addBuilding(w, 0, 'power', 9, 5);
    addBuilding(w, 0, 'refinery', 5, 9);
    for (let y = 14; y < 17; y++) for (let x = 5; x < 8; x++) w.ore[y * w.w + x] = 400;
    startHarvesting(addUnit(w, 0, 'harvester', at(6), at(12)));
    w.players[0].credits = 0;
    for (let t = 0; t < 600; t++) stepWorld(w);
    expect(w.players[0].credits).toBeGreaterThanOrEqual(800);
    expect(w.players[0].credits).toBeLessThanOrEqual(1200);
  });
});

describe('AI matches', () => {
  it('favour neither starting slot', () => {
    const army = [0, 0];
    for (let seed = 1; seed <= 12; seed++) {
      const m = aiMatch(seed);
      for (let i = 0; i < 6000; i++) m.step();
      for (const e of m.world.entities.values()) if (e.kind === 'unit') army[e.owner] += UNITS[e.type as UnitType].cost;
    }
    const ratio = army[0] / army[1];
    expect(ratio, `army value ${army}`).toBeGreaterThan(0.7);
    expect(ratio, `army value ${army}`).toBeLessThan(1.4);
  });
});
