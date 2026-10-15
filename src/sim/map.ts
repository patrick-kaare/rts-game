import { rand, randInt } from './rng';
import type { MapSizeRule } from './rules';
import { Terrain } from './types';

export const MAX_PLAYERS = 10;

/** Square map side in tiles for a player count. */
export function mapSize(players: number): number {
  if (players <= 2) return 64;
  if (players <= 4) return 96;
  if (players <= 6) return 128;
  return 160;
}

export const MAP_SIDES: Record<Exclude<MapSizeRule, 'auto'>, number> = { small: 64, medium: 96, large: 128, huge: 160 };

/** Smallest map side that still fits a player count: one size class below the automatic one. */
export function minMapSize(players: number): number {
  if (players <= 4) return 64;
  if (players <= 8) return 96;
  return 128;
}

/** Map side for a size setting, never smaller than the player count allows. */
export function mapSideFor(size: MapSizeRule, players: number): number {
  return size === 'auto' ? mapSize(players) : Math.max(MAP_SIDES[size], minMapSize(players));
}

/** Distance from the map edge to the ring of construction yard centres. */
const START_MARGIN = 7;

export interface GeneratedMap {
  w: number;
  h: number;
  terrain: Uint8Array;
  ore: Uint16Array;
  /** Top-left tiles of each player's construction yard. */
  starts: { x: number; y: number }[];
}

/**
 * Starts are spread evenly around a square ring. With an even player count
 * opposite starts are exact 180° rotations of each other and the terrain is
 * mirrored to match, so the 2-player map stays perfectly fair.
 * Retries with a derived seed until every base is connected.
 */
export function generateMap(seed: number, players = 2, size: MapSizeRule = 'auto'): GeneratedMap {
  if (players < 1 || players > MAX_PLAYERS) throw new Error(`unsupported player count ${players}`);
  const side = mapSideFor(size, players);
  for (let attempt = 0; ; attempt++) {
    const map = tryGenerate((seed + attempt * 7919) | 0, players, side);
    if (map) return map;
  }
}

/** Centre tiles of the yards, spaced evenly along the ring (integer math only). */
function ringPoints(size: number, players: number, offset: number): { x: number; y: number }[] {
  const a = START_MARGIN;
  const len = size - 1 - 2 * a;
  const perimeter = 4 * len;
  const out = [];
  for (let k = 0; k < players; k++) out.push(ringPoint(a, len, (offset + Math.floor((k * perimeter) / players)) % perimeter));
  return out;
}

function ringPoint(a: number, len: number, t: number): { x: number; y: number } {
  if (t < len) return { x: a + t, y: a };
  t -= len;
  if (t < len) return { x: a + len, y: a + t };
  t -= len;
  if (t < len) return { x: a + len - t, y: a + len };
  t -= len;
  return { x: a, y: a + len - t };
}

function tryGenerate(seed: number, players: number, w: number): GeneratedMap | null {
  const h = w;
  const rng = { s: seed };
  const terrain = new Uint8Array(w * h);
  const ore = new Uint16Array(w * h);
  const mirror = players % 2 === 0;
  const perimeter = 4 * (w - 1 - 2 * START_MARGIN);
  // The perimeter is even, so starts k and k + n/2 are always exactly opposite.
  const offset = randInt(rng, 0, perimeter - 1);
  const centres = ringPoints(w, players, offset);
  // Which slot gets which start.
  for (let i = centres.length - 1; i > 0; i--) {
    const j = randInt(rng, 0, i);
    [centres[i], centres[j]] = [centres[j], centres[i]];
  }
  const starts = centres.map((c) => ({ x: c.x - 1, y: c.y - 1 }));
  const startCenters = centres.map((c) => ({ x: c.x + 0.5, y: c.y + 0.5 }));
  const mid = w / 2;

  const set = (x: number, y: number, fn: (i: number) => void, mirrored: boolean) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    fn(y * w + x);
    if (mirrored) fn((h - 1 - y) * w + (w - 1 - x));
  };

  const blob = (cx: number, cy: number, r: number, fn: (i: number) => void, mirrored = mirror) => {
    const ri = Math.ceil(r + 1);
    for (let y = Math.floor(cy) - ri; y <= Math.floor(cy) + ri; y++) {
      for (let x = Math.floor(cx) - ri; x <= Math.floor(cx) + ri; x++) {
        const dx = x + 0.5 - cx;
        const dy = y + 0.5 - cy;
        if (Math.sqrt(dx * dx + dy * dy) < r + rand(rng) * 0.9) set(x, y, fn, mirrored);
      }
    }
  };

  const nearStart = (x: number, y: number, radius: number) =>
    startCenters.some((s) => dist(s.x - x, s.y - y) < radius);

  // Obstacles, scaled to the map area. Mirrored ones are placed twice.
  const areaScale = (w * h) / (64 * 64);
  const obstacleCount = Math.round(randInt(rng, 10, 15) * areaScale * (mirror ? 1 : 2));
  for (let n = 0; n < obstacleCount; n++) {
    const cx = randInt(rng, 2, w - 3);
    const cy = randInt(rng, 2, h - 3);
    if (nearStart(cx, cy, 13)) continue;
    const type = rand(rng) < 0.65 ? Terrain.Rock : Terrain.Water;
    const r = 1.2 + rand(rng) * 2.8;
    blob(cx, cy, r, (i) => (terrain[i] = type));
    // Occasional elongated ridge.
    if (rand(rng) < 0.4) {
      const dx = randInt(rng, -1, 1);
      const dy = randInt(rng, -1, 1);
      for (let k = 1; k <= 4; k++) blob(cx + dx * k * r, cy + dy * k * r, r * 0.7, (i) => (terrain[i] = type));
    }
  }

  const oreField = (cx: number, cy: number, r: number, lo: number, hi: number) =>
    blob(
      cx,
      cy,
      r,
      (i) => {
        terrain[i] = Terrain.Grass;
        ore[i] = randInt(rng, lo, hi);
      },
      false,
    );

  // Two home fields per base, either side of the direction towards the centre.
  for (const s of startCenters) {
    const dx = mid - s.x;
    const dy = mid - s.y;
    const d = dist(dx, dy) || 1;
    const ux = dx / d;
    const uy = dy / d;
    oreField(s.x + ux * 9 - uy * 6, s.y + uy * 9 + ux * 6, 2.6, 200, 400);
    oreField(s.x + ux * 9 + uy * 6, s.y + uy * 9 - ux * 6, 2.2, 200, 350);
  }

  // Contested fields halfway between neighbouring starts, pulled towards the centre, and one in the middle.
  for (let k = 0; k < players; k++) {
    const p = ringPoint(START_MARGIN, w - 1 - 2 * START_MARGIN, (offset + Math.floor(((2 * k + 1) * perimeter) / (2 * players))) % perimeter);
    const cx = p.x + 0.5 + (mid - p.x - 0.5) * 0.3;
    const cy = p.y + 0.5 + (mid - p.y - 0.5) * 0.3;
    oreField(cx, cy, 2.4, 250, 450);
  }
  oreField(mid, mid, 3.2 + players * 0.2, 300, 500);

  // Clear the base areas.
  for (const s of startCenters) {
    for (let y = Math.max(0, Math.floor(s.y - 8)); y < Math.min(h, s.y + 8); y++) {
      for (let x = Math.max(0, Math.floor(s.x - 8)); x < Math.min(w, s.x + 8); x++) {
        if (dist(x + 0.5 - s.x, y + 0.5 - s.y) < 7) {
          terrain[y * w + x] = Terrain.Grass;
          ore[y * w + x] = 0;
        }
      }
    }
  }

  // Connectivity: flood from start 0, turn unreachable pockets into rock.
  const reach = new Uint8Array(w * h);
  const stack = [starts[0].y * w + starts[0].x];
  reach[stack[0]] = 1;
  while (stack.length) {
    const i = stack.pop()!;
    const x = i % w;
    const y = (i / w) | 0;
    const nb = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1];
    for (const j of nb) {
      if (j >= 0 && !reach[j] && terrain[j] === Terrain.Grass) {
        reach[j] = 1;
        stack.push(j);
      }
    }
  }
  if (starts.some((s) => !reach[s.y * w + s.x])) return null;
  for (let i = 0; i < w * h; i++) {
    if (!reach[i] && terrain[i] === Terrain.Grass) {
      terrain[i] = Terrain.Rock;
      ore[i] = 0;
    }
  }

  return { w, h, terrain, ore, starts };
}

/** Math.hypot is not guaranteed to be identical across engines; sqrt is. */
function dist(dx: number, dy: number): number {
  return Math.sqrt(dx * dx + dy * dy);
}
