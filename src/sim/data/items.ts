import type { BuildingType, ItemType, QueueKind, UnitType } from '../types';
import { BUILDINGS } from './buildings';
import { UNITS } from './units';

export function isBuildingType(item: ItemType): item is BuildingType {
  return item in BUILDINGS;
}

export function isUnitType(item: ItemType): item is UnitType {
  return item in UNITS;
}

export function queueKindOf(item: ItemType): QueueKind {
  if (isBuildingType(item)) return 'building';
  return item === 'rifleman' ? 'infantry' : 'vehicle';
}

/** Building type that must exist for a queue to make progress. */
export const PRODUCER: Record<QueueKind, BuildingType> = {
  building: 'cy',
  infantry: 'barracks',
  vehicle: 'factory',
};

export function itemCost(item: ItemType): number {
  return isBuildingType(item) ? BUILDINGS[item].cost : UNITS[item].cost;
}

export function itemBuildTicks(item: ItemType): number {
  return isBuildingType(item) ? BUILDINGS[item].buildTicks : UNITS[item].buildTicks;
}

/** Queue progress needed to finish an item: 200 per tick at Normal speed and full power. */
export function itemProgressTotal(item: ItemType): number {
  return Math.max(1, itemBuildTicks(item) * 200);
}

export function itemPrereq(item: ItemType): readonly string[] {
  return isBuildingType(item) ? BUILDINGS[item].prereq : UNITS[item].prereq;
}

export function itemName(item: ItemType): string {
  return isBuildingType(item) ? BUILDINGS[item].name : UNITS[item].name;
}

export const BUILD_MENU: Record<QueueKind, ItemType[]> = {
  building: ['power', 'refinery', 'barracks', 'factory'],
  infantry: ['rifleman'],
  vehicle: ['jeep', 'tank', 'harvester'],
};
