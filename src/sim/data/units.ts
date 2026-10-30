import type { Armor, UnitType } from '../types';

export interface Weapon {
  kind: 'bullet' | 'shell';
  /** Range in sub-tile units. */
  range: number;
  damage: number;
  /** Ticks between shots. */
  cooldown: number;
}

export interface UnitDef {
  name: string;
  hp: number;
  /** Sub-tile units per tick. */
  speed: number;
  /** Sight radius in tiles. */
  sight: number;
  /** Collision radius in sub-tile units. */
  radius: number;
  armor: Armor;
  cost: number;
  buildTicks: number;
  weapon: Weapon | null;
  prereq: string[];
}

export const UNITS: Record<UnitType, UnitDef> = {
  rifleman: {
    name: 'Rifleman',
    hp: 50,
    speed: 14,
    sight: 5,
    radius: 50,
    armor: 'infantry',
    cost: 100,
    buildTicks: 100,
    weapon: { kind: 'bullet', range: 896, damage: 8, cooldown: 12 },
    prereq: ['barracks'],
  },
  jeep: {
    name: 'Jeep',
    hp: 80,
    speed: 36,
    sight: 9,
    radius: 70,
    armor: 'vehicle',
    cost: 400,
    buildTicks: 120,
    weapon: { kind: 'bullet', range: 1024, damage: 8, cooldown: 8 },
    prereq: ['factory'],
  },
  tank: {
    name: 'Tank',
    hp: 300,
    speed: 20,
    sight: 6,
    radius: 100,
    armor: 'vehicle',
    cost: 700,
    buildTicks: 240,
    weapon: { kind: 'shell', range: 1152, damage: 32, cooldown: 30 },
    prereq: ['factory'],
  },
  harvester: {
    name: 'Harvester',
    hp: 450,
    speed: 16,
    sight: 4,
    radius: 110,
    armor: 'vehicle',
    cost: 1000,
    buildTicks: 280,
    weapon: null,
    prereq: ['factory'],
  },
};

/** Damage percentage by weapon kind vs armor class. */
export const DAMAGE_TABLE: Record<Weapon['kind'], Record<Armor, number>> = {
  bullet: { infantry: 100, vehicle: 25, building: 30 },
  shell: { infantry: 40, vehicle: 100, building: 80 },
};

export const HARVESTER_CAPACITY = 500;
export const HARVEST_RATE = 5;
export const UNLOAD_RATE = 25;
/** Credits per gem, as a multiple of ore. */
export const GEM_VALUE = 2;
/** Ore regrowth: every interval, ore tiles grow and empty ones next to rich tiles may be seeded. */
export const ORE_GROW_INTERVAL = 100;
export const ORE_GROW = 1;
export const ORE_GROW_CAP = 400;
export const ORE_SPREAD_MIN = 100;
export const ORE_SPREAD_SEED = 25;
/** An eligible empty tile is seeded with a chance of 1 in this. */
export const ORE_SPREAD_CHANCE = 8;
