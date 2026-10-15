import { BUILD_GAP, BUILDINGS, MAX_WALL_LINE } from '../data/buildings';
import { isBuildable } from '../data/terrain';
import { TILE, type BuildingType, type World } from '../types';
import { areAllies, buildingDef, inBounds } from '../world';

/** Whether `owner` may place `type` with its top-left at (tx, ty). Only base buildings extend the build area. */
export function canPlace(world: World, owner: number, type: BuildingType, tx: number, ty: number): boolean {
  const def = BUILDINGS[type];
  if (!inBounds(world, tx, ty) || !inBounds(world, tx + def.w - 1, ty + def.h - 1)) return false;
  for (let y = ty; y < ty + def.h; y++) {
    for (let x = tx; x < tx + def.w; x++) {
      const i = y * world.w + x;
      if (!isBuildable(world.terrain[i]) || world.blocked[i]) return false;
    }
  }
  let near = false;
  for (const e of world.entities.values()) {
    if (e.kind === 'unit') {
      const ux = Math.floor(e.x / TILE);
      const uy = Math.floor(e.y / TILE);
      if (ux >= tx && ux < tx + def.w && uy >= ty && uy < ty + def.h) return false;
    } else if (!near && areAllies(world, e.owner, owner) && buildingDef(e).category === 'base') {
      const gapX = Math.max(e.tx - (tx + def.w), tx - (e.tx + e.w), 0);
      const gapY = Math.max(e.ty - (ty + def.h), ty - (e.ty + e.h), 0);
      if (Math.max(gapX, gapY) <= BUILD_GAP) near = true;
    }
  }
  return near;
}

/** Per-tile validity for the placement ghost (ignores the adjacency rule). */
export function tileBuildable(world: World, tx: number, ty: number): boolean {
  if (!inBounds(world, tx, ty)) return false;
  const i = ty * world.w + tx;
  return isBuildable(world.terrain[i]) && !world.blocked[i];
}

function unitOnTile(world: World, tx: number, ty: number): boolean {
  for (const e of world.entities.values()) {
    if (e.kind === 'unit' && Math.floor(e.x / TILE) === tx && Math.floor(e.y / TILE) === ty) return true;
  }
  return false;
}

/** The straight line of tiles from (x, y) towards (x2, y2): snapped to its main axis, at most MAX_WALL_LINE long. */
export function wallLineTiles(x: number, y: number, x2: number, y2: number): [number, number][] {
  const dx = x2 - x;
  const dy = y2 - y;
  const horizontal = Math.abs(dx) >= Math.abs(dy);
  const len = Math.min(MAX_WALL_LINE, (horizontal ? Math.abs(dx) : Math.abs(dy)) + 1);
  const sx = horizontal ? Math.sign(dx) : 0;
  const sy = horizontal ? 0 : Math.sign(dy);
  const out: [number, number][] = [];
  for (let k = 0; k < len; k++) out.push([x + sx * k, y + sy * k]);
  return out;
}

/**
 * The wall segments `owner` can actually lay along that line: the first must pass canPlace,
 * each later one must be free and is paid for from `credits`. Stops at the first tile that fails.
 */
export function wallLine(world: World, owner: number, x: number, y: number, x2: number, y2: number, credits: number): [number, number][] {
  const out: [number, number][] = [];
  const cost = BUILDINGS.wall.cost;
  for (const [tx, ty] of wallLineTiles(x, y, x2, y2)) {
    if (out.length === 0) {
      if (!canPlace(world, owner, 'wall', tx, ty)) break;
    } else if (credits < out.length * cost || !tileBuildable(world, tx, ty) || unitOnTile(world, tx, ty)) break;
    out.push([tx, ty]);
  }
  return out;
}
