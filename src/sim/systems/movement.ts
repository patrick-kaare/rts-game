import { speedPct, type MoveClass } from '../data/terrain';
import { findPath } from '../pathfinding';
import { TILE, type Entity, type World } from '../types';
import { tileOf, unitDef } from '../world';

/** Plan a path for a unit to an exact sub-tile point. */
export function setPath(world: World, e: Entity, x: number, y: number): void {
  const start = tileOf(world, e.x, e.y);
  const goal = tileOf(world, x, y);
  const path = findPath(world, start, goal, unitDef(e).armor as MoveClass);
  if (path.length === 0) path.push(start);
  e.path = path;
  e.pathIdx = 0;
  e.stuck = 0;
  const last = path[path.length - 1];
  if (last === goal) {
    e.goalX = x;
    e.goalY = y;
  } else {
    // Unreachable: stop at the centre of the closest reachable tile.
    e.goalX = (last % world.w) * TILE + TILE / 2;
    e.goalY = Math.floor(last / world.w) * TILE + TILE / 2;
  }
}

/** Sub-tile units per tick on the terrain the unit is standing on. */
export function unitSpeed(world: World, e: Entity): number {
  const def = unitDef(e);
  return Math.trunc((def.speed * speedPct(world.terrain[tileOf(world, e.x, e.y)], def.armor as MoveClass)) / 100);
}

export function clearPath(e: Entity): void {
  e.path = [];
  e.pathIdx = 0;
  e.stuck = 0;
}

export function isMoving(e: Entity): boolean {
  return e.pathIdx < e.path.length;
}

/**
 * Advance a unit along its path. Returns true once it has arrived
 * (or has no path at all).
 */
export function followPath(world: World, e: Entity): boolean {
  if (!isMoving(e)) return true;
  const speed = unitSpeed(world, e);
  const isLast = e.pathIdx === e.path.length - 1;
  const node = e.path[e.pathIdx];

  if (world.blocked[node]) {
    // Something was built on our route.
    setPath(world, e, e.goalX, e.goalY);
    return !isMoving(e);
  }

  const tx = isLast ? e.goalX : (node % world.w) * TILE + TILE / 2;
  const ty = isLast ? e.goalY : Math.floor(node / world.w) * TILE + TILE / 2;
  const dx = tx - e.x;
  const dy = ty - e.y;
  const d = Math.sqrt(dx * dx + dy * dy);

  if (e.stuck > 20) {
    // Crowded near the destination: good enough.
    if (isLast && d < TILE * 1.5) return arrive(e);
    if (e.stuck > 80) return arrive(e);
    if (e.stuck % 20 === 1) {
      setPath(world, e, e.goalX, e.goalY);
      e.stuck = 21;
    }
  }

  if (d <= speed) {
    e.x = tx;
    e.y = ty;
    e.pathIdx++;
    if (e.pathIdx >= e.path.length) return arrive(e);
    return false;
  }
  e.x += Math.trunc((dx * speed) / d);
  e.y += Math.trunc((dy * speed) / d);
  e.fx = Math.trunc((dx * TILE) / d);
  e.fy = Math.trunc((dy * TILE) / d);
  return false;
}

function arrive(e: Entity): true {
  clearPath(e);
  return true;
}

/** Face (turret) toward a point. */
export function aimAt(e: Entity, x: number, y: number): void {
  const dx = x - e.x;
  const dy = y - e.y;
  const d = Math.sqrt(dx * dx + dy * dy);
  if (d === 0) return;
  e.ax = Math.trunc((dx * TILE) / d);
  e.ay = Math.trunc((dy * TILE) / d);
}

/**
 * Soft collision between units. Moving units mostly shove idle ones
 * aside. Pushes never move a unit onto a blocked tile.
 */
export function separateUnits(world: World): void {
  const units: Entity[] = [];
  for (const e of world.entities.values()) if (e.kind === 'unit') units.push(e);

  for (let i = 0; i < units.length; i++) {
    const a = units[i];
    const ra = unitDef(a).radius;
    for (let j = i + 1; j < units.length; j++) {
      const b = units[j];
      const rs = ra + unitDef(b).radius;
      let dx = b.x - a.x;
      let dy = b.y - a.y;
      if (dx >= rs || dx <= -rs || dy >= rs || dy <= -rs) continue;
      let d2 = dx * dx + dy * dy;
      if (d2 >= rs * rs) continue;
      if (d2 === 0) {
        dx = a.id & 1 ? 1 : -1;
        dy = b.id & 1 ? 1 : -1;
        d2 = 2;
      }
      const d = Math.sqrt(d2);
      const overlap = Math.min(24, Math.ceil(rs - d));
      const am = isMoving(a);
      const bm = isMoving(b);
      // Share of the push applied to b (out of 4).
      const bShare = am && !bm ? 3 : !am && bm ? 1 : 2;
      const pb = Math.ceil((overlap * bShare) / 4);
      const pa = overlap - pb;
      push(world, b, Math.trunc((dx * pb) / d), Math.trunc((dy * pb) / d));
      push(world, a, -Math.trunc((dx * pa) / d), -Math.trunc((dy * pa) / d));
    }
  }

  // Stuck tracking for units that are trying to move.
  for (const e of units) {
    if (!isMoving(e)) continue;
    const moved = Math.abs(e.x - e.px) + Math.abs(e.y - e.py);
    if (moved * 3 < unitSpeed(world, e)) e.stuck++;
    else if (e.stuck > 0) e.stuck--;
  }
}

function push(world: World, e: Entity, dx: number, dy: number): void {
  if (dx === 0 && dy === 0) return;
  const nx = e.x + dx;
  const ny = e.y + dy;
  const max = world.w * TILE - 1;
  if (nx < 0 || ny < 0 || nx > max || ny > world.h * TILE - 1) return;
  if (world.blocked[tileOf(world, nx, ny)]) return;
  e.x = nx;
  e.y = ny;
}
