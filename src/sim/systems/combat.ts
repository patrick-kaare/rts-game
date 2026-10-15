import { DAMAGE_TABLE, type Weapon } from '../data/units';
import { TILE, type Armor, type Entity, type World } from '../types';
import { areAllies, distSqToEntity, removeEntity, unitDef } from '../world';
import { aimAt, clearPath, followPath, isMoving, setPath } from './movement';

export function armorOf(e: Entity): Armor {
  return e.kind === 'building' ? 'building' : unitDef(e).armor;
}

function targetPriority(e: Entity): number {
  if (e.kind === 'building') return 2;
  return unitDef(e).weapon ? 0 : 1;
}

export function effectiveRange(weapon: Weapon, t: Entity): number {
  return weapon.range + (t.kind === 'unit' ? unitDef(t).radius : 0);
}

export function inRange(e: Entity, t: Entity, weapon: Weapon): boolean {
  const r = effectiveRange(weapon, t);
  return distSqToEntity(e.x, e.y, t) <= r * r;
}

/** Find the best enemy within `radius` (armed units first, then nearest). */
export function acquireTarget(world: World, e: Entity, radius: number): Entity | null {
  let best: Entity | null = null;
  let bestP = 99;
  let bestD = Infinity;
  const r2 = radius * radius;
  for (const t of world.entities.values()) {
    if (areAllies(world, t.owner, e.owner)) continue;
    const d2 = distSqToEntity(e.x, e.y, t);
    if (d2 > r2) continue;
    const p = targetPriority(t);
    if (p < bestP || (p === bestP && d2 < bestD)) {
      best = t;
      bestP = p;
      bestD = d2;
    }
  }
  return best;
}

/** Keep the current target while it is valid and within leash; rescan every few ticks. */
export function currentOrAcquire(world: World, e: Entity, leash: number): Entity | null {
  const t = e.targetId ? world.entities.get(e.targetId) : undefined;
  const cur = t && !areAllies(world, t.owner, e.owner) && distSqToEntity(e.x, e.y, t) <= leash * leash ? t : null;
  const scan = (world.tick + e.id) % 4 === 0;
  // Keep fighting armed threats; periodically look for one if busy with something else.
  if (cur && (!scan || targetPriority(cur) === 0)) return cur;
  if (scan) {
    const found = acquireTarget(world, e, unitDef(e).sight * TILE);
    if (found) return found;
  }
  return cur;
}

/**
 * Fight `t`: fire if in range, otherwise chase (if allowed).
 * Returns true if the unit is busy with the target this tick.
 */
export function engage(world: World, e: Entity, t: Entity, chase: boolean): boolean {
  const weapon = unitDef(e).weapon;
  if (!weapon) return false;
  e.targetId = t.id;
  aimAt(e, t.x, t.y);
  if (inRange(e, t, weapon)) {
    if (chase && isMoving(e)) clearPath(e);
    if (e.cooldown === 0) fire(world, e, t, weapon);
    return true;
  }
  if (!chase) return false;
  if (!isMoving(e) || world.tick >= e.repathAt) {
    setPath(world, e, t.x, t.y);
    e.repathAt = world.tick + 15;
  }
  followPath(world, e);
  return true;
}

export function fire(world: World, e: Entity, t: Entity, weapon: Weapon): void {
  const pct = DAMAGE_TABLE[weapon.kind][armorOf(t)];
  const dmg = Math.max(1, Math.floor((weapon.damage * pct) / 100));
  t.hp -= dmg;
  e.cooldown = weapon.cooldown;
  world.events.push({ t: 'shot', weapon: weapon.kind, x0: e.x, y0: e.y, x1: t.x, y1: t.y });
  if (t.hp <= 0) killEntity(world, t);
}

export function killEntity(world: World, t: Entity): void {
  removeEntity(world, t);
  world.events.push({ t: 'death', x: t.x, y: t.y, big: t.kind === 'building' || t.type !== 'rifleman' });
}
