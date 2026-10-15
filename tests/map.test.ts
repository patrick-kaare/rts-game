import { describe, expect, it } from 'vitest';
import { MAX_PLAYERS, generateMap, mapSideFor, mapSize } from '../src/sim/map';
import { MAP_SIZE_OPTIONS } from '../src/sim/rules';
import { Terrain } from '../src/sim/types';

/** Grass tiles reachable from (x, y), 4-connected. */
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
      if (j >= 0 && !seen[j] && terrain[j] === Terrain.Grass) {
        seen[j] = 1;
        stack.push(j);
      }
    }
  }
  return seen;
}

describe('map generation', () => {
  for (let players = 2; players <= MAX_PLAYERS; players++) {
    it(`works for ${players} players`, () => {
      for (let seed = 1; seed <= 15; seed++) {
        const map = generateMap(seed * 101, players);
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
          const map = generateMap(seed * 31, players, size);
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
    const a = generateMap(99, 7);
    const b = generateMap(99, 7);
    expect(a.starts).toEqual(b.starts);
    expect(a.terrain).toEqual(b.terrain);
    expect(a.ore).toEqual(b.ore);
  });
});
