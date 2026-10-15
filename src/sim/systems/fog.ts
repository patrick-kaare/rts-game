import { blocksSight } from '../data/terrain';
import { TILE, type World } from '../types';
import { buildingDef, unitDef } from '../world';

/**
 * Tile offsets in a sight circle, nearest first, each with the index of the
 * previous tile on the line of sight from the centre (-1 for the centre).
 * Sight reaches a tile if it reached that previous tile and the previous tile
 * doesn't block sight, so a forest edge is seen but not what lies behind it.
 */
interface Circle {
  dx: Int8Array;
  dy: Int8Array;
  parent: Int16Array;
}

const circles = new Map<number, Circle>();

function circle(r: number): Circle {
  let c = circles.get(r);
  if (!c) {
    const offsets: [number, number][] = [];
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) if (dx * dx + dy * dy <= r * r + r) offsets.push([dx, dy]);
    }
    // Moving one step back along the line never increases |dx| or |dy|, so parents sort first.
    offsets.sort((a, b) => a[0] * a[0] + a[1] * a[1] - (b[0] * b[0] + b[1] * b[1]) || a[1] - b[1] || a[0] - b[0]);
    const index = new Map(offsets.map(([dx, dy], k) => [dx * 1000 + dy, k]));
    c = { dx: new Int8Array(offsets.length), dy: new Int8Array(offsets.length), parent: new Int16Array(offsets.length) };
    offsets.forEach(([dx, dy], k) => {
      c!.dx[k] = dx;
      c!.dy[k] = dy;
      const [px, py] = stepBack(dx, dy);
      c!.parent[k] = dx === 0 && dy === 0 ? -1 : index.get(px * 1000 + py)!;
    });
    circles.set(r, c);
  }
  return c;
}

/** The tile before (x1, y1) on the Bresenham line from (0, 0). */
function stepBack(x1: number, y1: number): [number, number] {
  const ax = Math.abs(x1);
  const ay = Math.abs(y1);
  const sx = x1 < 0 ? -1 : 1;
  const sy = y1 < 0 ? -1 : 1;
  let x = 0;
  let y = 0;
  let px = 0;
  let py = 0;
  let err = ax - ay;
  while (x !== x1 || y !== y1) {
    px = x;
    py = y;
    const e2 = 2 * err;
    if (e2 > -ay) {
      err -= ay;
      x += sx;
    }
    if (e2 < ax) {
      err += ax;
      y += sy;
    }
  }
  return [px, py];
}

/** Per circle tile: whether sight reaches it. Reused between entities. */
let seen = new Uint8Array(0);

export function updateFog(world: World): void {
  const { w, h } = world;
  // Without fog, createWorld already made everything visible.
  if (world.rules.fog === 'off') return;
  for (const v of world.visible) v.fill(0);
  // Allies share vision: everything a player sees is seen by the whole team.
  const viewers = world.players.map((p) => world.players.filter((q) => q.team === p.team).map((q) => q.id));
  for (const e of world.entities.values()) {
    let cx: number;
    let cy: number;
    let r: number;
    if (e.kind === 'building') {
      cx = e.tx + Math.floor(e.w / 2);
      cy = e.ty + Math.floor(e.h / 2);
      r = buildingDef(e).sight;
    } else {
      cx = Math.floor(e.x / TILE);
      cy = Math.floor(e.y / TILE);
      r = unitDef(e).sight;
    }
    const c = circle(r);
    const n = c.dx.length;
    if (seen.length < n) seen = new Uint8Array(n);
    for (let k = 0; k < n; k++) {
      seen[k] = 0;
      const x = cx + c.dx[k];
      const y = cy + c.dy[k];
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      const i = y * w + x;
      const p = c.parent[k];
      if (p >= 0 && (!seen[p] || blocksSight(world.terrain[(cy + c.dy[p]) * w + cx + c.dx[p]]))) continue;
      seen[k] = 1;
      for (const v of viewers[e.owner]) {
        world.visible[v][i] = 1;
        world.explored[v][i] = 1;
      }
    }
  }
}

