import { BUILD_GAP, BUILDINGS } from '../data/buildings';
import { TILE, Terrain, type BuildingType, type World } from '../types';
import { areAllies, inBounds } from '../world';

/** Whether `owner` may place `type` with its top-left at (tx, ty). */
export function canPlace(world: World, owner: number, type: BuildingType, tx: number, ty: number): boolean {
  const def = BUILDINGS[type];
  if (!inBounds(world, tx, ty) || !inBounds(world, tx + def.w - 1, ty + def.h - 1)) return false;
  for (let y = ty; y < ty + def.h; y++) {
    for (let x = tx; x < tx + def.w; x++) {
      const i = y * world.w + x;
      if (world.terrain[i] !== Terrain.Grass || world.blocked[i]) return false;
    }
  }
  let near = false;
  for (const e of world.entities.values()) {
    if (e.kind === 'unit') {
      const ux = Math.floor(e.x / TILE);
      const uy = Math.floor(e.y / TILE);
      if (ux >= tx && ux < tx + def.w && uy >= ty && uy < ty + def.h) return false;
    } else if (!near && areAllies(world, e.owner, owner)) {
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
  return world.terrain[i] === Terrain.Grass && !world.blocked[i];
}
