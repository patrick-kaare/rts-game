import type { Difficulty, GameRules } from './rules';
/** Sub-tile units per tile. All sim positions are integers in these units. */
export const TILE = 256;
export const TICK_RATE = 20;
export const TICK_MS = 1000 / TICK_RATE;

export type UnitType = 'rifleman' | 'jeep' | 'tank' | 'harvester';
export type BuildingType = 'cy' | 'power' | 'refinery' | 'barracks' | 'factory' | 'wall' | 'pillbox' | 'turret';
export type ItemType = UnitType | BuildingType;
export type QueueKind = 'building' | 'infantry' | 'vehicle';
export type Armor = 'infantry' | 'vehicle' | 'building';

export const Terrain = { Grass: 0, Rock: 1, Water: 2, Forest: 3, Road: 4, Bridge: 5 } as const;

export type HarvestState = 'seek' | 'toOre' | 'mining' | 'toRefinery' | 'unloading';

export type Order =
  | { t: 'idle' }
  | { t: 'move'; x: number; y: number }
  | { t: 'attackMove'; x: number; y: number }
  | { t: 'attack'; target: number }
  | { t: 'harvest'; state: HarvestState; tx: number; ty: number; refinery: number };

/**
 * A single flat entity shape for both units and buildings keeps the state
 * plain, serializable data (important for future multiplayer snapshots).
 */
export interface Entity {
  id: number;
  owner: number;
  kind: 'unit' | 'building';
  type: ItemType;
  /** Center position in sub-tile units. */
  x: number;
  y: number;
  /** Position at the start of the current tick (for render interpolation). */
  px: number;
  py: number;
  hp: number;
  maxHp: number;

  // --- units ---
  order: Order;
  /** Remaining waypoints as tile indices; path[pathIdx] is the next one. */
  path: number[];
  pathIdx: number;
  /** Exact final point of the current path. */
  goalX: number;
  goalY: number;
  repathAt: number;
  /** Consecutive ticks of little progress while following a path. */
  stuck: number;
  targetId: number;
  cooldown: number;
  /** Body facing and turret aim, as integer vectors scaled to TILE. */
  fx: number;
  fy: number;
  ax: number;
  ay: number;
  cargo: number;

  // --- buildings (tile footprint) ---
  tx: number;
  ty: number;
  w: number;
  h: number;
  /** Producers: tile new units walk to, -1 if none. */
  rallyX: number;
  rallyY: number;
}

export interface Queue {
  items: ItemType[];
  /** Progress out of itemProgressTotal: the build speed percentage per tick, scaled by power efficiency. */
  progress: number;
  /** Credits spent on the current item so far. */
  spent: number;
  /** Building finished and waiting for placement. */
  ready: boolean;
}

export interface Player {
  id: number;
  credits: number;
  powerProduced: number;
  powerUsed: number;
  queues: Record<QueueKind, Queue>;
  defeated: boolean;
  /** Players on the same team are allies. Players without a lobby team get a team of their own. */
  team: number;
  difficulty: Difficulty;
  /** Top-left tile of the starting construction yard. */
  startX: number;
  startY: number;
}

export type Command =
  | { t: 'move'; ids: number[]; x: number; y: number }
  | { t: 'attackMove'; ids: number[]; x: number; y: number }
  | { t: 'attack'; ids: number[]; target: number }
  | { t: 'harvest'; ids: number[]; x: number; y: number }
  | { t: 'dock'; ids: number[]; refinery: number }
  | { t: 'stop'; ids: number[] }
  | { t: 'rally'; ids: number[]; x: number; y: number }
  | { t: 'build'; item: ItemType }
  | { t: 'cancel'; item: ItemType }
  /** Walls may give an end tile (x2, y2) to place a straight line of segments. */
  | { t: 'place'; item: BuildingType; x: number; y: number; x2?: number; y2?: number };

export interface PlayerCommand {
  player: number;
  cmd: Command;
}

/** Transient per-tick events for the renderer. Not part of sim state. */
export type SimEvent =
  | { t: 'shot'; weapon: 'bullet' | 'shell'; x0: number; y0: number; x1: number; y1: number }
  | {
      t: 'death';
      x: number;
      y: number;
      kind: 'unit' | 'building';
      type: ItemType;
      owner: number;
      /** Body facing, for wreck orientation. */
      fx: number;
      fy: number;
      /** Building footprint in tiles (0 for units). */
      tx: number;
      ty: number;
      w: number;
      h: number;
    };

export interface World {
  tick: number;
  seed: number;
  rules: GameRules;
  rng: { s: number };
  w: number;
  h: number;
  terrain: Uint8Array;
  /** Ore amount (credits) per tile. */
  ore: Uint16Array;
  /** 1 if impassable (terrain or building). */
  blocked: Uint8Array;
  /** Building entity id occupying a tile, 0 if none. */
  buildingAt: Int32Array;
  entities: Map<number, Entity>;
  nextId: number;
  players: Player[];
  /** Per player: currently visible tiles / ever-explored tiles. */
  visible: Uint8Array[];
  explored: Uint8Array[];
  events: SimEvent[];
  /** Bumped whenever ore changes, so renderers know to redraw. */
  oreVersion: number;
  /** Winning player id, -1 while the game is running. */
  winner: number;
}
