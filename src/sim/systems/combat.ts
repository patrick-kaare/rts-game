import { DAMAGE_TABLE, type Weapon } from '../data/units';
import { TILE, type Armor, type Entity, type World } from '../types';
import { areAllies, buildingDef, distSqToEntity, isWall, removeEntity, tileOf, unitDef, weaponOf } from '../world';
import { aimAt, clearPath, followPath, isMoving, setPath } from './movement';
import { isLowPower } from './production';

export function armorOf(e: Entity): Armor {
  return e.kind === 'building' ? 'building' : unitDef(e).armor;
}

/** Armed units and defenses first, then unarmed units, then other buildings. */
function targetPriority(e: Entity): number {
  if (weaponOf(e)) return 0;
  return e.kind === 'unit' ? 1 : 2;
}

export function effectiveRange(weapon: Weapon, t: Entity): number {
  return weapon.range + (t.kind === 'unit' ? unitDef(t).radius : 0);
}

export function inRange(e: Entity, t: Entity, weapon: Weapon): boolean {
  const r = effectiveRange(weapon, t);
  return distSqToEntity(e.x, e.y, t) <= r * r;
}

/**
 * Find the best enemy within `radius` (armed ones first, then nearest).
 * Only enemies the team can see count, so units hidden in forest aren't picked.
 * Walls are never picked; they are only attacked on order.
 * With `prefer`, ties in priority go to the target that weapon hurts most before distance.
 */
export function acquireTarget(world: World, e: Entity, radius: number, prefer?: Weapon): Entity | null {
  let best: Entity | null = null;
  let bestP = 99;
  let bestPct = 0;
  let bestD = Infinity;
  const r2 = radius * radius;
  const visible = world.visible[e.owner];
  for (const t of world.entities.values()) {
    if (areAllies(world, t.owner, e.owner) || isWall(t)) continue;
    const d2 = distSqToEntity(e.x, e.y, t);
    if (d2 > r2) continue;
    if (t.kind === 'unit' && !visible[tileOf(world, t.x, t.y)]) continue;
    const p = targetPriority(t);
    const pct = prefer ? DAMAGE_TABLE[prefer.kind][armorOf(t)] : 0;
    if (p < bestP || (p === bestP && (pct > bestPct || (pct === bestPct && d2 < bestD)))) {
      best = t;
      bestP = p;
      bestPct = pct;
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

/** Turrets and pillboxes: shoot the best enemy in range. Offline at low power. */
export function updateDefense(world: World, e: Entity): void {
  const weapon = buildingDef(e).weapon!;
  if (e.cooldown > 0) e.cooldown--;
  if (isLowPower(world.players[e.owner])) {
    e.targetId = 0;
    return;
  }
  const cur = e.targetId ? world.entities.get(e.targetId) : undefined;
  let t = cur && !areAllies(world, cur.owner, e.owner) && inRange(e, cur, weapon) ? cur : undefined;
  // Rescan now and then, like units, in case a better target walked in.
  if (!t || (world.tick + e.id) % 4 === 0) {
    const found = acquireTarget(world, e, weapon.range, weapon);
    if (found) t = found;
  }
  if (!t) {
    e.targetId = 0;
    return;
  }
  e.targetId = t.id;
  aimAt(e, t.x, t.y);
  if (e.cooldown === 0 && inRange(e, t, weapon)) fire(world, e, t, weapon);
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
  world.events.push({
    t: 'death',
    x: t.x,
    y: t.y,
    kind: t.kind,
    type: t.type,
    owner: t.owner,
    fx: t.fx,
    fy: t.fy,
    tx: t.tx,
    ty: t.ty,
    w: t.kind === 'building' ? t.w : 0,
    h: t.kind === 'building' ? t.h : 0,
  });
}
