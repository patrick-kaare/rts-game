import type { BuildingType } from '../types';
import type { Weapon } from './units';

export interface BuildingDef {
  name: string;
  w: number;
  h: number;
  hp: number;
  cost: number;
  buildTicks: number;
  /** Positive = produces power, negative = consumes. */
  power: number;
  sight: number;
  prereq: BuildingType[];
  buildable: boolean;
  /**
   * Base buildings extend the build area. Defenses carry a weapon and go offline at low power.
   * Walls are placed in lines, aren't auto-targeted and don't keep a player in the game.
   */
  category: 'base' | 'defense' | 'wall';
  weapon: Weapon | null;
}

export const BUILDINGS: Record<BuildingType, BuildingDef> = {
  cy: { name: 'Construction Yard', w: 3, h: 3, hp: 1500, cost: 0, buildTicks: 0, power: 15, sight: 6, prereq: [], buildable: false, category: 'base', weapon: null },
  power: { name: 'Power Plant', w: 2, h: 2, hp: 400, cost: 300, buildTicks: 200, power: 100, sight: 4, prereq: [], buildable: true, category: 'base', weapon: null },
  refinery: { name: 'Refinery', w: 3, h: 2, hp: 900, cost: 1500, buildTicks: 300, power: -40, sight: 4, prereq: ['power'], buildable: true, category: 'base', weapon: null },
  barracks: { name: 'Barracks', w: 2, h: 2, hp: 500, cost: 300, buildTicks: 200, power: -20, sight: 4, prereq: ['power'], buildable: true, category: 'base', weapon: null },
  factory: { name: 'War Factory', w: 3, h: 3, hp: 1000, cost: 2000, buildTicks: 400, power: -30, sight: 4, prereq: ['refinery'], buildable: true, category: 'base', weapon: null },
  wall: { name: 'Wall', w: 1, h: 1, hp: 300, cost: 25, buildTicks: 20, power: 0, sight: 1, prereq: [], buildable: true, category: 'wall', weapon: null },
  pillbox: {
    name: 'Pillbox',
    w: 1,
    h: 1,
    hp: 400,
    cost: 400,
    buildTicks: 160,
    power: -15,
    sight: 6,
    prereq: ['barracks'],
    buildable: true,
    category: 'defense',
    weapon: { kind: 'bullet', range: 1280, damage: 8, cooldown: 8 },
  },
  turret: {
    name: 'Gun Turret',
    w: 1,
    h: 1,
    hp: 600,
    cost: 600,
    buildTicks: 220,
    power: -25,
    sight: 7,
    prereq: ['barracks'],
    buildable: true,
    category: 'defense',
    weapon: { kind: 'shell', range: 1536, damage: 40, cooldown: 30 },
  },
};

/** Max gap in tiles between a new building and an existing own base building. */
export const BUILD_GAP = 2;

/** Most wall segments one placement can lay. */
export const MAX_WALL_LINE = 8;
