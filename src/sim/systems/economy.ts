import {
  GEM_VALUE,
  HARVEST_RATE,
  HARVESTER_CAPACITY,
  ORE_GROW,
  ORE_GROW_CAP,
  ORE_GROW_INTERVAL,
  ORE_SPREAD_CHANCE,
  ORE_SPREAD_MIN,
  ORE_SPREAD_SEED,
  UNLOAD_RATE,
} from '../data/units';
import { bfsFind } from '../pathfinding';
import { randInt } from '../rng';
import { DIFFICULTY, oreRegrows } from '../rules';
import { TILE, type Entity, type Order, type World } from '../types';
import { distSqToEntity, tileOf } from '../world';
import { clearPath, followPath, isMoving, setPath } from './movement';
import { powerEfficiency } from './production';

type HarvestOrder = Extract<Order, { t: 'harvest' }>;

export function startHarvesting(e: Entity, tx = -1, ty = -1): void {
  e.order = { t: 'harvest', state: 'seek', tx, ty, refinery: 0 };
  clearPath(e);
}

export function updateHarvester(world: World, e: Entity): void {
  const o = e.order as HarvestOrder;
  switch (o.state) {
    case 'seek': {
      const ore = findOre(world, e, o);
      if (ore < 0) {
        if (e.cargo > 0) o.state = 'toRefinery';
        else e.order = { t: 'idle' }; // Nothing left to mine.
        return;
      }
      o.tx = ore % world.w;
      o.ty = Math.floor(ore / world.w);
      setPath(world, e, o.tx * TILE + TILE / 2, o.ty * TILE + TILE / 2);
      o.state = 'toOre';
      return;
    }
    case 'toOre': {
      const i = o.ty * world.w + o.tx;
      if (world.ore[i] === 0) {
        o.state = 'seek';
        return;
      }
      if (followPath(world, e)) {
        o.state = tileOf(world, e.x, e.y) === i ? 'mining' : 'seek';
        // If we could not reach it, mark by moving the search origin to where we are.
        if (o.state === 'seek') {
          o.tx = -1;
          o.ty = -1;
        }
      }
      return;
    }
    case 'mining': {
      const i = o.ty * world.w + o.tx;
      const take = Math.min(HARVEST_RATE, world.ore[i], HARVESTER_CAPACITY - e.cargo);
      if (take > 0) {
        world.ore[i] -= take;
        e.cargo += take;
        if (world.gems[i]) e.gemCargo += take;
        world.oreVersion++;
      }
      if (e.cargo >= HARVESTER_CAPACITY) o.state = 'toRefinery';
      else if (world.ore[i] === 0) o.state = 'seek';
      return;
    }
    case 'toRefinery': {
      let ref = o.refinery ? world.entities.get(o.refinery) : undefined;
      if (!ref || ref.owner !== e.owner || ref.type !== 'refinery') {
        ref = nearestRefinery(world, e);
        if (!ref) {
          clearPath(e);
          return;
        }
        o.refinery = ref.id;
        clearPath(e);
      }
      const near = distSqToEntity(e.x, e.y, ref) <= (TILE * 1.6) ** 2;
      if (near && !isMoving(e)) {
        o.state = 'unloading';
        return;
      }
      if (!isMoving(e) && world.tick >= e.repathAt) {
        setPath(world, e, (ref.tx + 1) * TILE + TILE / 2, (ref.ty + ref.h) * TILE + TILE / 2);
        e.repathAt = world.tick + 20;
      }
      followPath(world, e);
      return;
    }
    case 'unloading': {
      const ref = world.entities.get(o.refinery);
      if (!ref) {
        o.state = 'toRefinery';
        o.refinery = 0;
        return;
      }
      const p = world.players[e.owner];
      // Full power rules: at low power, unload on only that share of ticks.
      if (world.rules.power === 'full') {
        const eff = powerEfficiency(world, p);
        if (eff < 100 && Math.floor((world.tick * eff) / 100) === Math.floor(((world.tick - 1) * eff) / 100)) return;
      }
      const amount = Math.min(UNLOAD_RATE, e.cargo);
      const gems = Math.min(amount, e.gemCargo);
      e.cargo -= amount;
      e.gemCargo -= gems;
      p.credits += Math.floor(((amount + gems * (GEM_VALUE - 1)) * DIFFICULTY[p.difficulty].income) / 100);
      if (e.cargo === 0) o.state = 'seek';
      return;
    }
  }
}

function nearestRefinery(world: World, e: Entity): Entity | undefined {
  let best: Entity | undefined;
  let bestD = Infinity;
  for (const r of world.entities.values()) {
    if (r.owner !== e.owner || r.type !== 'refinery') continue;
    const d = distSqToEntity(e.x, e.y, r);
    if (d < bestD) {
      bestD = d;
      best = r;
    }
  }
  return best;
}

/** Nearest ore tile, preferring the last field we worked and avoiding tiles claimed by other harvesters. */
function findOre(world: World, e: Entity, o: HarvestOrder): number {
  const claimed = new Set<number>();
  for (const h of world.entities.values()) {
    if (h === e || h.order.t !== 'harvest') continue;
    const ho = h.order;
    if ((ho.state === 'toOre' || ho.state === 'mining') && ho.tx >= 0) claimed.add(ho.ty * world.w + ho.tx);
  }
  let origin = tileOf(world, e.x, e.y);
  if (o.tx >= 0 && o.ty >= 0) {
    const pref = o.ty * world.w + o.tx;
    if (!world.blocked[pref]) origin = pref;
  }
  const accept = (i: number) => world.ore[i] > 0 && !claimed.has(i);
  const found = bfsFind(world, origin, accept);
  if (found >= 0) return found;
  // Everything nearby is claimed; share a tile rather than idle.
  return bfsFind(world, origin, (i) => world.ore[i] > 0);
}

/**
 * Regrowing ore: every ORE_GROW_INTERVAL ticks, ore tiles in the bed grow, and
 * empty bed tiles next to a rich tile may be seeded. A field mined bare stays bare.
 */
export function updateOre(world: World): void {
  if (!oreRegrows(world.rules) || world.tick % ORE_GROW_INTERVAL !== 0) return;
  const { w, h, ore, oreBed, buildingAt } = world;
  // Decide seeding from the ore as it was before this step, so the scan order doesn't matter.
  const before = ore.slice();
  const rich = (j: number) => before[j] >= ORE_SPREAD_MIN;
  let changed = false;
  for (let i = 0; i < ore.length; i++) {
    if (!oreBed[i] || buildingAt[i] || world.gems[i]) continue;
    if (before[i] > 0) {
      if (before[i] < ORE_GROW_CAP) {
        ore[i] = Math.min(ORE_GROW_CAP, before[i] + ORE_GROW);
        changed = true;
      }
      continue;
    }
    const x = i % w;
    const y = Math.floor(i / w);
    const nearRich = (x > 0 && rich(i - 1)) || (x < w - 1 && rich(i + 1)) || (y > 0 && rich(i - w)) || (y < h - 1 && rich(i + w));
    if (nearRich && randInt(world.rng, 1, ORE_SPREAD_CHANCE) === 1) {
      ore[i] = ORE_SPREAD_SEED;
      changed = true;
    }
  }
  if (changed) world.oreVersion++;
}
