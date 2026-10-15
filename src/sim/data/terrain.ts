import { Terrain, type Armor } from '../types';

export interface TerrainDef {
  name: string;
  passable: boolean;
  buildable: boolean;
  /** Units can't see past a tile of this type (they still see the tile itself). */
  blocksSight: boolean;
  /** Movement speed in percent, by unit armor class. */
  speed: Record<Exclude<Armor, 'building'>, number>;
}

/** Indexed by Terrain id. */
export const TERRAIN: TerrainDef[] = [];
TERRAIN[Terrain.Grass] = { name: 'Grass', passable: true, buildable: true, blocksSight: false, speed: { infantry: 100, vehicle: 100 } };
TERRAIN[Terrain.Rock] = { name: 'Cliff', passable: false, buildable: false, blocksSight: false, speed: { infantry: 0, vehicle: 0 } };
TERRAIN[Terrain.Water] = { name: 'Water', passable: false, buildable: false, blocksSight: false, speed: { infantry: 0, vehicle: 0 } };
TERRAIN[Terrain.Forest] = { name: 'Forest', passable: true, buildable: false, blocksSight: true, speed: { infantry: 80, vehicle: 50 } };
TERRAIN[Terrain.Road] = { name: 'Road', passable: true, buildable: true, blocksSight: false, speed: { infantry: 130, vehicle: 150 } };
TERRAIN[Terrain.Bridge] = { name: 'Bridge', passable: true, buildable: false, blocksSight: false, speed: { infantry: 130, vehicle: 150 } };

export type MoveClass = 'infantry' | 'vehicle';

export const isPassable = (t: number): boolean => TERRAIN[t].passable;
export const isBuildable = (t: number): boolean => TERRAIN[t].buildable;
export const blocksSight = (t: number): boolean => TERRAIN[t].blocksSight;
export const speedPct = (t: number, cls: MoveClass): number => TERRAIN[t].speed[cls];
