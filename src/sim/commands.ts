import { PRODUCER, isBuildingType, queueKindOf } from './data/items';
import { bfsFind } from './pathfinding';
import { canPlace } from './systems/construction';
import { startHarvesting } from './systems/economy';
import { clearPath, setPath } from './systems/movement';
import { MAX_UNIT_QUEUE, canBuild, spawnUnit } from './systems/production';
import { TILE, type Command, type Entity, type World } from './types';
import { addBuilding, areAllies, inBounds, unitDef } from './world';

/** The only way player input changes the simulation. Invalid commands are ignored. */
export function applyCommand(world: World, playerId: number, cmd: Command): void {
  const p = world.players[playerId];
  if (!p || p.defeated || world.winner >= 0) return;

  switch (cmd.t) {
    case 'move':
    case 'attackMove': {
      const units = ownUnits(world, playerId, cmd.ids);
      if (!inBounds(world, cmd.x, cmd.y) || units.length === 0) return;
      const spots = formation(world, cmd.x, cmd.y, units);
      units.forEach((e, k) => {
        const [x, y] = spots[k];
        e.order = { t: cmd.t, x, y };
        e.targetId = 0;
        setPath(world, e, x, y);
      });
      return;
    }
    case 'attack': {
      const target = world.entities.get(cmd.target);
      if (!target || areAllies(world, target.owner, playerId)) return;
      for (const e of ownUnits(world, playerId, cmd.ids)) {
        if (!unitDef(e).weapon) continue;
        e.order = { t: 'attack', target: target.id };
        e.targetId = target.id;
        clearPath(e);
      }
      return;
    }
    case 'harvest': {
      if (!inBounds(world, cmd.x, cmd.y)) return;
      const others: Entity[] = [];
      for (const e of ownUnits(world, playerId, cmd.ids)) {
        if (e.type === 'harvester') startHarvesting(e, cmd.x, cmd.y);
        else others.push(e);
      }
      if (others.length) applyCommand(world, playerId, { t: 'move', ids: others.map((e) => e.id), x: cmd.x, y: cmd.y });
      return;
    }
    case 'dock': {
      const ref = world.entities.get(cmd.refinery);
      if (!ref || ref.owner !== playerId || ref.type !== 'refinery') return;
      for (const e of ownUnits(world, playerId, cmd.ids)) {
        if (e.type !== 'harvester') continue;
        e.order = { t: 'harvest', state: 'toRefinery', tx: -1, ty: -1, refinery: ref.id };
        clearPath(e);
      }
      return;
    }
    case 'stop': {
      for (const e of ownUnits(world, playerId, cmd.ids)) {
        e.order = { t: 'idle' };
        e.targetId = 0;
        clearPath(e);
      }
      return;
    }
    case 'rally': {
      if (!inBounds(world, cmd.x, cmd.y)) return;
      for (const id of cmd.ids) {
        const b = world.entities.get(id);
        if (!b || b.owner !== playerId || (b.type !== PRODUCER.infantry && b.type !== PRODUCER.vehicle)) continue;
        // Right-clicking the building itself clears its rally point.
        const inside = cmd.x >= b.tx && cmd.x < b.tx + b.w && cmd.y >= b.ty && cmd.y < b.ty + b.h;
        b.rallyX = inside ? -1 : cmd.x;
        b.rallyY = inside ? -1 : cmd.y;
      }
      return;
    }
    case 'build': {
      if (!canBuild(world, playerId, cmd.item)) return;
      const q = p.queues[queueKindOf(cmd.item)];
      if (isBuildingType(cmd.item)) {
        if (q.items.length > 0) return;
      } else if (q.items.length >= MAX_UNIT_QUEUE) return;
      q.items.push(cmd.item);
      return;
    }
    case 'cancel': {
      const q = p.queues[queueKindOf(cmd.item)];
      const idx = q.items.lastIndexOf(cmd.item);
      if (idx < 0) return;
      q.items.splice(idx, 1);
      if (idx === 0) {
        p.credits += q.spent;
        q.progress = 0;
        q.spent = 0;
        q.ready = false;
      }
      return;
    }
    case 'place': {
      const q = p.queues.building;
      if (!q.ready || q.items[0] !== cmd.item || !isBuildingType(cmd.item)) return;
      if (!canPlace(world, playerId, cmd.item, cmd.x, cmd.y)) return;
      const b = addBuilding(world, playerId, cmd.item, cmd.x, cmd.y);
      q.items = [];
      q.ready = false;
      q.progress = 0;
      q.spent = 0;
      if (cmd.item === 'refinery') spawnUnit(world, playerId, 'harvester', b);
      return;
    }
  }
}

function ownUnits(world: World, owner: number, ids: number[]): Entity[] {
  const out: Entity[] = [];
  const seen = new Set<number>();
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const e = world.entities.get(id);
    if (e && e.owner === owner && e.kind === 'unit') out.push(e);
  }
  return out;
}

/**
 * Distinct destination points around the target tile, one per unit.
 * Closest units get the closest spots.
 */
function formation(world: World, tx: number, ty: number, units: Entity[]): [number, number][] {
  const center = ty * world.w + tx;
  const cx = tx * TILE + TILE / 2;
  const cy = ty * TILE + TILE / 2;
  if (units.length === 1) return [[cx, cy]];
  const tiles: number[] = [];
  bfsFind(
    world,
    center,
    (i) => {
      if (!world.blocked[i]) tiles.push(i);
      return tiles.length >= units.length;
    },
    2000,
  );
  while (tiles.length < units.length) tiles.push(tiles[tiles.length - 1] ?? center);

  const order = units
    .map((e, k) => ({ k, d: (e.x - cx) ** 2 + (e.y - cy) ** 2, id: e.id }))
    .sort((a, b) => a.d - b.d || a.id - b.id);
  const out: [number, number][] = new Array(units.length);
  order.forEach(({ k }, n) => {
    const t = tiles[n];
    out[k] = [(t % world.w) * TILE + TILE / 2, Math.floor(t / world.w) * TILE + TILE / 2];
  });
  return out;
}
