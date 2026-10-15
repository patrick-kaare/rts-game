import type { BuildingType } from './sim/types';

/** Size of a tile on screen, in pixels. */
export const TILE_PX = 32;

/**
 * Client-only view state. Never part of the simulation: in multiplayer,
 * each player has their own.
 */
export interface ClientState {
  localPlayer: number;
  selection: Set<number>;
  /** Control groups: number key 1–9 → entity ids. */
  groups: Map<number, Set<number>>;
  placing: BuildingType | null;
  /** Start tile of a wall line being dragged out. */
  wallStart: { tx: number; ty: number } | null;
  /** Mouse position in viewport pixels. */
  mouse: { x: number; y: number; inside: boolean };
  /** Entity under the mouse, refreshed each frame. */
  hovered: number | null;
  /** Drag-select rectangle in viewport pixels. */
  drag: { x0: number; y0: number; x1: number; y1: number } | null;
}

export function createClientState(localPlayer: number): ClientState {
  return {
    localPlayer,
    selection: new Set(),
    groups: new Map(),
    placing: null,
    wallStart: null,
    mouse: { x: 0, y: 0, inside: false },
    hovered: null,
    drag: null,
  };
}
