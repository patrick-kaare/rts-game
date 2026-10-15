import { rand, randInt } from './rng';
import { isPassable } from './data/terrain';
import type { MapSizeRule, TerrainRule } from './rules';
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
 * Classic maps have rock and water blobs. Rich maps have rivers between the
 * bases, cliff arcs around them, forests, and roads (with bridges) linking them.
 * Retries with a derived seed until every base is connected.
 */
export function generateMap(seed: number, players = 2, size: MapSizeRule = 'auto', style: TerrainRule = 'classic'): GeneratedMap {
  if (players < 1 || players > MAX_PLAYERS) throw new Error(`unsupported player count ${players}`);
  const side = mapSideFor(size, players);
  for (let attempt = 0; ; attempt++) {
    const map = tryGenerate((seed + attempt * 7919) | 0, players, side, style);
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

function tryGenerate(seed: number, players: number, w: number, style: TerrainRule): GeneratedMap | null {
  const h = w;
  const rng = { s: seed };
  const terrain = new Uint8Array(w * h);
  const ore = new Uint16Array(w * h);
  const mirror = players % 2 === 0;
  const perimeter = 4 * (w - 1 - 2 * START_MARGIN);
  // The perimeter is even, so starts k and k + n/2 are always exactly opposite.
  const offset = randInt(rng, 0, perimeter - 1);
  const centres = ringPoints(w, players, offset);
  // Ring order, before the shuffle: entries k and k + n/2 are exactly opposite.
  const ring = centres.map((c) => ({ x: c.x + 0.5, y: c.y + 0.5 }));
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
  // With mirroring, features are drawn for half the ring and copied to the other half.
  const half = mirror ? players / 2 : players;
  // Ring point halfway between start k and start k + 1.
  const between = (k: number) =>
    ringPoint(START_MARGIN, w - 1 - 2 * START_MARGIN, (offset + Math.floor(((2 * k + 1) * perimeter) / (2 * players))) % perimeter);

  if (style === 'rich') {
    // Rivers from the map edge between neighbouring bases towards the centre.
    // The contested ore field later cuts a ford into each one.
    for (let k = 0; k < half; k++) {
      if (players >= 6 && k % 2 === 1) continue;
      const p = between(k);
      const px = p.x + 0.5;
      const py = p.y + 0.5;
      const d = dist(mid - px, mid - py) || 1;
      const ux = (mid - px) / d;
      const uy = (mid - py) / d;
      let x = px - ux * (START_MARGIN + 2);
      let y = py - uy * (START_MARGIN + 2);
      let drift = 0;
      let side = 0;
      const stop = 6 + players * 0.4;
      for (let n = 0; n < 4 * w && dist(mid - x, mid - y) > stop; n++) {
        blob(x, y, 1.1, (i) => (terrain[i] = Terrain.Water));
        drift = Math.max(-0.8, Math.min(0.8, drift + (rand(rng) - 0.5) * 0.5));
        if (Math.abs(side + drift * 0.5) > 4) drift = -drift;
        side += drift * 0.5;
        x += ux * 0.5 - uy * drift * 0.5;
        y += uy * 0.5 + ux * drift * 0.5;
      }
    }

    // A cliff arc around the side of each base that faces the centre, with a gap
    // towards the centre (where the road leaves) and one to the side.
    for (let k = 0; k < half; k++) {
      const s = ring[k];
      const d = dist(mid - s.x, mid - s.y) || 1;
      const ux = (mid - s.x) / d;
      const uy = (mid - s.y) / d;
      const turn = rand(rng) < 0.5 ? 1 : -1;
      // Side gap at about 60° from the centre direction.
      const gx = ux * 0.5 - uy * 0.866 * turn;
      const gy = uy * 0.5 + ux * 0.866 * turn;
      const r = 14 + rand(rng) * 1.5;
      for (let y = Math.floor(s.y - r - 2); y <= s.y + r + 2; y++) {
        for (let x = Math.floor(s.x - r - 2); x <= s.x + r + 2; x++) {
          const dx = x + 0.5 - s.x;
          const dy = y + 0.5 - s.y;
          const dd = dist(dx, dy);
          if (dd < r || dd >= r + 1.4) continue;
          if ((dx * ux + dy * uy) / dd < -0.2) continue;
          const gap = (vx: number, vy: number) => dx * vx + dy * vy > 0 && Math.abs(dx * vy - dy * vx) < 2.2;
          if (gap(ux, uy) || gap(gx, gy)) continue;
          set(x, y, (i) => (terrain[i] = Terrain.Rock), mirror);
        }
      }
    }

    // Cliff ridges and the odd pond, scaled to the map area.
    const ridges = Math.round(randInt(rng, 5, 8) * areaScale * (mirror ? 1 : 2));
    for (let n = 0; n < ridges; n++) {
      const cx = randInt(rng, 2, w - 3);
      const cy = randInt(rng, 2, h - 3);
      if (nearStart(cx, cy, 13)) continue;
      if (rand(rng) < 0.2) {
        blob(cx, cy, 1.5 + rand(rng) * 1.5, (i) => (terrain[i] = Terrain.Water));
        continue;
      }
      const dx = randInt(rng, -2, 2);
      const dy = dx === 0 ? (rand(rng) < 0.5 ? 1 : -1) : randInt(rng, -2, 2);
      const len = dist(dx, dy);
      const steps = randInt(rng, 6, 16) * 2;
      for (let k = 0; k <= steps; k++) {
        const t = k / 2 - steps / 4;
        blob(cx + (dx / len) * t, cy + (dy / len) * t, 0.7, (i) => (terrain[i] = Terrain.Rock));
      }
    }

    // Forests in clusters.
    const forests = Math.round(randInt(rng, 6, 9) * areaScale * (mirror ? 1 : 2));
    for (let n = 0; n < forests; n++) {
      const cx = randInt(rng, 2, w - 3);
      const cy = randInt(rng, 2, h - 3);
      if (nearStart(cx, cy, 10)) continue;
      const parts = randInt(rng, 3, 6);
      for (let k = 0; k < parts; k++) {
        const fx = cx + (rand(rng) - 0.5) * 7;
        const fy = cy + (rand(rng) - 0.5) * 7;
        blob(fx, fy, 1 + rand(rng) * 1.5, (i) => {
          if (terrain[i] === Terrain.Grass) terrain[i] = Terrain.Forest;
        });
      }
    }
  } else {
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
    const p = between(k);
    const cx = p.x + 0.5 + (mid - p.x - 0.5) * 0.3;
    const cy = p.y + 0.5 + (mid - p.y - 0.5) * 0.3;
    oreField(cx, cy, 2.4, 250, 450);
  }
  oreField(mid, mid, 3.2 + players * 0.2, 300, 500);

  if (style === 'rich') {
    // Roads, 2 tiles wide: each base to the centre, and neighbouring bases to each other.
    // They become bridges over water and cut passes through cliffs and forest.
    const road = (ax: number, ay: number, bx: number, by: number) => {
      const steps = Math.ceil(dist(bx - ax, by - ay) * 2);
      for (let k = 0; k <= steps; k++) {
        const cx = ax + ((bx - ax) * k) / steps;
        const cy = ay + ((by - ay) * k) / steps;
        for (let y = Math.floor(cy) - 1; y <= Math.floor(cy) + 1; y++) {
          for (let x = Math.floor(cx) - 1; x <= Math.floor(cx) + 1; x++) {
            if (dist(x + 0.5 - cx, y + 0.5 - cy) >= 1) continue;
            set(
              x,
              y,
              (i) => {
                if (terrain[i] === Terrain.Water || terrain[i] === Terrain.Bridge) terrain[i] = Terrain.Bridge;
                else if (!ore[i]) terrain[i] = Terrain.Road;
              },
              mirror,
            );
          }
        }
      }
    };
    for (let k = 0; k < half; k++) road(ring[k].x, ring[k].y, mid, mid);
    if (players >= 3) for (let k = 0; k < half; k++) road(ring[k].x, ring[k].y, ring[(k + 1) % players].x, ring[(k + 1) % players].y);
  }

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
      if (j >= 0 && !reach[j] && isPassable(terrain[j])) {
        reach[j] = 1;
        stack.push(j);
      }
    }
  }
  if (starts.some((s) => !reach[s.y * w + s.x])) return null;
  for (let i = 0; i < w * h; i++) {
    if (!reach[i] && isPassable(terrain[i])) {
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
