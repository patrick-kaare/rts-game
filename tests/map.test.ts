import { describe, expect, it } from 'vitest';
import { MAX_PLAYERS, generateMap, mapSideFor, mapSize } from '../src/sim/map';
import { isPassable } from '../src/sim/data/terrain';
import { MAP_SIZE_OPTIONS, TERRAIN_OPTIONS } from '../src/sim/rules';
import { Terrain } from '../src/sim/types';

/** Passable tiles reachable from (x, y), 4-connected. */
function reachable(map: ReturnType<typeof generateMap>, x: number, y: number): Uint8Array {
  const { w, h, terrain } = map;
  const seen = new Uint8Array(w * h);
  const stack = [y * w + x];
  seen[stack[0]] = 1;
  while (stack.length) {
    const i = stack.pop()!;
    const tx = i % w;
    const ty = (i / w) | 0;
    for (const j of [tx > 0 ? i - 1 : -1, tx < w - 1 ? i + 1 : -1, ty > 0 ? i - w : -1, ty < h - 1 ? i + w : -1]) {
      if (j >= 0 && !seen[j] && isPassable(terrain[j])) {
        seen[j] = 1;
        stack.push(j);
      }
    }
  }
  return seen;
}

describe.each(TERRAIN_OPTIONS)('%s map generation', (style) => {
  for (let players = 2; players <= MAX_PLAYERS; players++) {
    it(`works for ${players} players`, () => {
      for (let seed = 1; seed <= 15; seed++) {
        const map = generateMap(seed * 101, players, 'auto', style);
        expect(map.w).toBe(mapSize(players));
        expect(map.starts).toHaveLength(players);
        const reach = reachable(map, map.starts[0].x, map.starts[0].y);
        for (const s of map.starts) {
          // The 3×3 yard footprint is open grass and connected to every other base.
          for (let dy = 0; dy < 3; dy++) for (let dx = 0; dx < 3; dx++) expect(map.terrain[(s.y + dy) * map.w + s.x + dx]).toBe(Terrain.Grass);
          expect(reach[s.y * map.w + s.x]).toBe(1);
          // Home ore within 14 tiles.
          let homeOre = 0;
          for (let y = s.y - 14; y <= s.y + 16; y++) {
            for (let x = s.x - 14; x <= s.x + 16; x++) {
              if (x >= 0 && y >= 0 && x < map.w && y < map.h && map.ore[y * map.w + x]) homeOre++;
            }
          }
          expect(homeOre).toBeGreaterThan(10);
        }
        for (let i = 0; i < players; i++) {
          for (let j = i + 1; j < players; j++) {
            const a = map.starts[i];
            const b = map.starts[j];
            expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThan(30);
          }
        }
      }
    });
  }

  for (const size of MAP_SIZE_OPTIONS) {
    it(`connects every base on ${size} maps`, () => {
      for (const players of [1, 2, 4, 5, 8, 10]) {
        for (let seed = 1; seed <= 4; seed++) {
          const map = generateMap(seed * 31, players, size, style);
          expect(map.w).toBe(mapSideFor(size, players));
          const reach = reachable(map, map.starts[0].x, map.starts[0].y);
          for (const s of map.starts) expect(reach[s.y * map.w + s.x]).toBe(1);
          for (let i = 0; i < players; i++) {
            for (let j = i + 1; j < players; j++) {
              const a = map.starts[i];
              const b = map.starts[j];
              expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThan(20);
            }
          }
        }
      }
    });
  }

  it('is deterministic', () => {
    const a = generateMap(99, 7, 'auto', style);
    const b = generateMap(99, 7, 'auto', style);
    expect(a.starts).toEqual(b.starts);
    expect(a.terrain).toEqual(b.terrain);
    expect(a.ore).toEqual(b.ore);
  });
});

describe('rich terrain', () => {
  const count = (map: ReturnType<typeof generateMap>, t: number) => map.terrain.filter((v) => v === t).length;

  it('has roads, forests, rivers and bridges', () => {
    let bridged = 0;
    for (const players of [2, 3, 4, 7, 10]) {
      for (let seed = 1; seed <= 5; seed++) {
        const map = generateMap(seed * 17, players, 'auto', 'rich');
        expect(count(map, Terrain.Road)).toBeGreaterThan(20);
        expect(count(map, Terrain.Forest)).toBeGreaterThan(20);
        expect(count(map, Terrain.Water)).toBeGreaterThan(20);
        if (count(map, Terrain.Bridge)) bridged++;
        // Ore only ever lies on grass.
        for (let i = 0; i < map.ore.length; i++) if (map.ore[i]) expect(map.terrain[i]).toBe(Terrain.Grass);
      }
    }
    expect(bridged).toBeGreaterThan(15);
  });

  it('only puts bridges next to water or other bridges', () => {
    const map = generateMap(5, 4, 'auto', 'rich');
    const { w, terrain } = map;
    for (let i = 0; i < terrain.length; i++) {
      if (terrain[i] !== Terrain.Bridge) continue;
      const around = [i - 1, i + 1, i - w, i + w].filter((j) => j >= 0 && j < terrain.length).map((j) => terrain[j]);
      expect(around.some((t) => t === Terrain.Water || t === Terrain.Bridge)).toBe(true);
    }
  });

  it('keeps even player counts point-symmetric apart from ore fields', () => {
    for (const players of [2, 4, 6]) {
      const map = generateMap(42, players, 'auto', 'rich');
      const { w, h, terrain, ore } = map;
      let differ = 0;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = y * w + x;
          const j = (h - 1 - y) * w + (w - 1 - x);
          if (terrain[i] !== terrain[j] && !ore[i] && !ore[j]) differ++;
        }
      }
      // Ore fields aren't mirrored tile for tile, so their fringes can differ slightly.
      expect(differ).toBeLessThan(w * 0.5);
    }
  });
});
