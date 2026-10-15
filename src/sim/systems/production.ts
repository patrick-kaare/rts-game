import { BUILDINGS } from '../data/buildings';
import { PRODUCER, isBuildingType, itemBuildTicks, itemCost, itemPrereq, queueKindOf } from '../data/items';
import { bfsFind } from '../pathfinding';
import { TILE, type Entity, type ItemType, type Player, type QueueKind, type UnitType, type World } from '../types';
import { addUnit, hasBuilding } from '../world';
import { startHarvesting } from './economy';
import { setPath } from './movement';

const QUEUE_KINDS: QueueKind[] = ['building', 'infantry', 'vehicle'];
export const MAX_UNIT_QUEUE = 10;

export function updatePower(world: World): void {
  for (const p of world.players) {
    p.powerProduced = 0;
    p.powerUsed = 0;
  }
  for (const e of world.entities.values()) {
    if (e.kind !== 'building') continue;
    const pw = BUILDINGS[e.type as keyof typeof BUILDINGS].power;
    const p = world.players[e.owner];
    if (pw > 0) p.powerProduced += pw;
    else p.powerUsed -= pw;
  }
}

export function isLowPower(p: Player): boolean {
  return p.powerUsed > p.powerProduced;
}

/** Whether the item's prerequisites and producer exist for this player. */
export function canBuild(world: World, owner: number, item: ItemType): boolean {
  if (isBuildingType(item) && !BUILDINGS[item].buildable) return false;
  if (!hasBuilding(world, owner, PRODUCER[queueKindOf(item)])) return false;
  return itemPrereq(item).every((req) => hasBuilding(world, owner, req));
}

export function updateProduction(world: World): void {
  for (const p of world.players) {
    if (p.defeated) continue;
    const step = isLowPower(p) ? 1 : 2;
    for (const kind of QUEUE_KINDS) {
      const q = p.queues[kind];
      if (q.items.length === 0 || q.ready) continue;
      const producer = findProducer(world, p.id, kind);
      if (!producer) continue;
      const item = q.items[0];
      const total = Math.max(1, itemBuildTicks(item) * 2);
      if (q.progress < total) {
        const next = Math.min(total, q.progress + step);
        const targetSpent = Math.floor((itemCost(item) * next) / total);
        const need = targetSpent - q.spent;
        if (need > p.credits) continue; // Stalled on funds.
        p.credits -= need;
        q.spent = targetSpent;
        q.progress = next;
      }
      if (q.progress < total) continue;
      if (kind === 'building') {
        q.ready = true;
      } else if (spawnUnit(world, p.id, item as UnitType, producer)) {
        q.items.shift();
        q.progress = 0;
        q.spent = 0;
      }
    }
  }
}

/** The oldest (lowest id) producer building of the right type. */
export function findProducer(world: World, owner: number, kind: QueueKind): Entity | undefined {
  const type = PRODUCER[kind];
  for (const e of world.entities.values()) if (e.owner === owner && e.type === type) return e;
  return undefined;
}

/** Spawn a unit at the nearest free tile below the producer, sending it to the rally point if set. */
export function spawnUnit(world: World, owner: number, type: UnitType, producer: Entity): Entity | null {
  const exitX = producer.tx + Math.floor(producer.w / 2);
  const exitY = Math.min(world.h - 1, producer.ty + producer.h);
  const start = exitY * world.w + exitX;
  const occupied = new Set<number>();
  for (const e of world.entities.values()) {
    if (e.kind === 'unit') occupied.add(Math.floor(e.y / TILE) * world.w + Math.floor(e.x / TILE));
  }
  const tile = bfsFind(world, start, (i) => !world.blocked[i] && !occupied.has(i), 400);
  if (tile < 0) return null;
  const x = (tile % world.w) * TILE + TILE / 2;
  const y = Math.floor(tile / world.w) * TILE + TILE / 2;
  const u = addUnit(world, owner, type, x, y);
  if (type === 'harvester') startHarvesting(u);
  else if (producer.rallyX >= 0) {
    const rx = producer.rallyX * TILE + TILE / 2;
    const ry = producer.rallyY * TILE + TILE / 2;
    u.order = { t: 'move', x: rx, y: ry };
    setPath(world, u, rx, ry);
  }
  return u;
}
