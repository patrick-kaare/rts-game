import { TERRAIN, type MoveClass } from './data/terrain';
import { TILE, type World } from './types';

const STRAIGHT = 10;
const DIAG = 14;

interface CostTable {
  /** Cost of a straight / diagonal step onto a tile, by terrain id. Grass is 10 / 14. */
  straight: Int32Array;
  diag: Int32Array;
  /** Cheapest step costs on any terrain, so the heuristic never overestimates. */
  minStraight: number;
  minDiag: number;
}

function costTable(cls: MoveClass): CostTable {
  const straight = new Int32Array(TERRAIN.length);
  const diag = new Int32Array(TERRAIN.length);
  let minStraight = STRAIGHT;
  let minDiag = DIAG;
  TERRAIN.forEach((t, i) => {
    if (!t.passable) return;
    straight[i] = Math.round((STRAIGHT * 100) / t.speed[cls]);
    diag[i] = Math.round((straight[i] * DIAG) / STRAIGHT);
    minStraight = Math.min(minStraight, straight[i]);
    minDiag = Math.min(minDiag, diag[i]);
  });
  return { straight, diag, minStraight, minDiag };
}

const COSTS: Record<MoveClass, CostTable> = { infantry: costTable('infantry'), vehicle: costTable('vehicle') };

// Reused buffers; a generation counter avoids clearing them every search.
let cap = 0;
let gScore = new Int32Array(0);
let parent = new Int32Array(0);
let seen = new Uint32Array(0);
let closed = new Uint32Array(0);
let generation = 0;

function ensure(n: number) {
  if (cap >= n) return;
  cap = n;
  gScore = new Int32Array(n);
  parent = new Int32Array(n);
  seen = new Uint32Array(n);
  closed = new Uint32Array(n);
  generation = 0;
}

function octile(ax: number, ay: number, bx: number, by: number, straight = STRAIGHT, diag = DIAG): number {
  const dx = Math.abs(ax - bx);
  const dy = Math.abs(ay - by);
  return straight * Math.max(dx, dy) + (diag - straight) * Math.min(dx, dy);
}

/** Binary min-heap of node indices keyed by (f, h, index) for deterministic ties. */
class Heap {
  nodes: number[] = [];
  f: number[] = [];
  h: number[] = [];
  push(node: number, f: number, h: number) {
    const { nodes, f: fs, h: hs } = this;
    let i = nodes.length;
    nodes.push(node);
    fs.push(f);
    hs.push(h);
    // Sift up by moving the hole, not swapping.
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!less(f, h, node, fs[p], hs[p], nodes[p])) break;
      nodes[i] = nodes[p];
      fs[i] = fs[p];
      hs[i] = hs[p];
      i = p;
    }
    nodes[i] = node;
    fs[i] = f;
    hs[i] = h;
  }
  pop(): number {
    const { nodes, f: fs, h: hs } = this;
    const top = nodes[0];
    const node = nodes.pop()!;
    const f = fs.pop()!;
    const h = hs.pop()!;
    const n = nodes.length;
    if (n === 0) return top;
    let i = 0;
    for (;;) {
      const l = i * 2 + 1;
      if (l >= n) break;
      const r = l + 1;
      const m = r < n && less(fs[r], hs[r], nodes[r], fs[l], hs[l], nodes[l]) ? r : l;
      if (!less(fs[m], hs[m], nodes[m], f, h, node)) break;
      nodes[i] = nodes[m];
      fs[i] = fs[m];
      hs[i] = hs[m];
      i = m;
    }
    nodes[i] = node;
    fs[i] = f;
    hs[i] = h;
    return top;
  }
  get size() {
    return this.nodes.length;
  }
}

function less(fa: number, ha: number, na: number, fb: number, hb: number, nb: number): boolean {
  if (fa !== fb) return fa < fb;
  if (ha !== hb) return ha < hb;
  return na < nb;
}

const DIRS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];

/**
 * A* on the tile grid, 8-directional without corner cutting, weighted by how
 * fast `cls` units cross each terrain (roads are cheap, forest is dear).
 * Returns tile indices from the first step to the goal (start excluded).
 * If the goal is blocked or unreachable, returns a path to the closest reachable tile.
 */
export function findPath(world: World, start: number, goal: number, cls: MoveClass = 'vehicle'): number[] {
  const { w, h, blocked, terrain } = world;
  const costs = COSTS[cls];
  const hs = costs.minStraight;
  const hd = costs.minDiag;
  ensure(w * h);
  generation++;
  if (start === goal) return [];

  const sx = start % w;
  const sy = (start / w) | 0;
  // A blocked goal (usually a building being attacked) would make A* flood the
  // whole map looking for it. Aim for the nearest open tile around it instead.
  if (blocked[goal]) goal = nearestOpen(world, goal, sx, sy);
  if (start === goal) return [];
  const gx = goal % w;
  const gy = (goal / w) | 0;
  const heap = new Heap();
  gScore[start] = 0;
  parent[start] = -1;
  seen[start] = generation;
  const h0 = octile(sx, sy, gx, gy, hs, hd);
  heap.push(start, h0, h0);

  let best = start;
  let bestH = h0;

  while (heap.size) {
    const cur = heap.pop();
    if (closed[cur] === generation) continue;
    closed[cur] = generation;
    if (cur === goal) {
      best = cur;
      break;
    }
    const cx = cur % w;
    const cy = (cur / w) | 0;
    const ch = octile(cx, cy, gx, gy, hs, hd);
    if (ch < bestH) {
      bestH = ch;
      best = cur;
    }
    for (const [dx, dy] of DIRS) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const ni = ny * w + nx;
      if (blocked[ni] || closed[ni] === generation) continue;
      const diag = dx !== 0 && dy !== 0;
      if (diag && (blocked[cy * w + nx] || blocked[ny * w + cx])) continue;
      const g = gScore[cur] + (diag ? costs.diag : costs.straight)[terrain[ni]];
      if (seen[ni] === generation && g >= gScore[ni]) continue;
      seen[ni] = generation;
      gScore[ni] = g;
      parent[ni] = cur;
      const hh = octile(nx, ny, gx, gy, hs, hd);
      heap.push(ni, g + hh, hh);
    }
  }

  const path: number[] = [];
  for (let n = best; n !== start && n !== -1; n = parent[n]) path.push(n);
  path.reverse();
  return smooth(world, start, path, costs.straight);
}

/**
 * The open tile closest to `goal` (by ring), preferring the one nearest the start.
 * Returns `goal` itself if nothing within a few tiles is open.
 */
function nearestOpen(world: World, goal: number, sx: number, sy: number): number {
  const { w, h, blocked } = world;
  const gx = goal % w;
  const gy = (goal / w) | 0;
  for (let r = 1; r <= 6; r++) {
    let best = -1;
    let bestD = Infinity;
    for (let y = gy - r; y <= gy + r; y++) {
      for (let x = gx - r; x <= gx + r; x++) {
        if (Math.max(Math.abs(x - gx), Math.abs(y - gy)) !== r) continue;
        if (x < 0 || y < 0 || x >= w || y >= h || blocked[y * w + x]) continue;
        const d = octile(x, y, sx, sy);
        if (d < bestD) {
          bestD = d;
          best = y * w + x;
        }
      }
    }
    if (best >= 0) return best;
  }
  return goal;
}

/**
 * Drop intermediate waypoints that have a clear straight line between them,
 * as long as that line crosses no slower terrain than the path it replaces
 * (so a unit doesn't leave a winding road to cut through grass or forest).
 */
function smooth(world: World, start: number, path: number[], cost: Int32Array): number[] {
  if (path.length < 3) return path;
  const out: number[] = [];
  let anchor = start;
  // Dearest tile on the path since the anchor.
  let worst = cost[world.terrain[path[0]]];
  for (let i = 1; i < path.length; i++) {
    worst = Math.max(worst, cost[world.terrain[path[i]]]);
    if (!clearLine(world, anchor, path[i]) || maxLineCost(world, anchor, path[i], cost) > worst) {
      out.push(path[i - 1]);
      anchor = path[i - 1];
      worst = Math.max(cost[world.terrain[path[i - 1]]], cost[world.terrain[path[i]]]);
    }
  }
  out.push(path[path.length - 1]);
  return out;
}

/** Conservative line-of-travel check: samples the center line and two offset lines. */
export function clearLine(world: World, a: number, b: number): boolean {
  const { w } = world;
  const x0 = (a % w) * TILE + TILE / 2;
  const y0 = ((a / w) | 0) * TILE + TILE / 2;
  const x1 = (b % w) * TILE + TILE / 2;
  const y1 = ((b / w) | 0) * TILE + TILE / 2;
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len === 0) return true;
  const ox = Math.trunc((-dy * 100) / len);
  const oy = Math.trunc((dx * 100) / len);
  const steps = Math.ceil(len / 32);
  for (let s = 0; s <= steps; s++) {
    const px = x0 + Math.trunc((dx * s) / steps);
    const py = y0 + Math.trunc((dy * s) / steps);
    if (blockedAt(world, px, py) || blockedAt(world, px + ox, py + oy) || blockedAt(world, px - ox, py - oy)) {
      return false;
    }
  }
  return true;
}

/** Dearest terrain step cost under the centre line from tile a to tile b. */
function maxLineCost(world: World, a: number, b: number, cost: Int32Array): number {
  const { w, terrain } = world;
  const x0 = (a % w) * TILE + TILE / 2;
  const y0 = ((a / w) | 0) * TILE + TILE / 2;
  const dx = (b % w) * TILE + TILE / 2 - x0;
  const dy = ((b / w) | 0) * TILE + TILE / 2 - y0;
  const steps = Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / 32);
  let worst = 0;
  for (let s = 1; s < steps; s++) {
    const tx = Math.floor((x0 + Math.trunc((dx * s) / steps)) / TILE);
    const ty = Math.floor((y0 + Math.trunc((dy * s) / steps)) / TILE);
    worst = Math.max(worst, cost[terrain[ty * w + tx]]);
  }
  return worst;
}

function blockedAt(world: World, x: number, y: number): boolean {
  const tx = Math.floor(x / TILE);
  const ty = Math.floor(y / TILE);
  if (tx < 0 || ty < 0 || tx >= world.w || ty >= world.h) return true;
  return world.blocked[ty * world.w + tx] === 1;
}

/**
 * Breadth-first search over passable tiles from `start`, returning the first
 * tile for which `accept` is true (or -1). Deterministic neighbour order.
 */
export function bfsFind(world: World, start: number, accept: (i: number) => boolean, maxNodes = 4096): number {
  const { w, h, blocked } = world;
  ensure(w * h);
  generation++;
  const queue = [start];
  seen[start] = generation;
  for (let qi = 0; qi < queue.length && qi < maxNodes; qi++) {
    const cur = queue[qi];
    if (accept(cur)) return cur;
    const cx = cur % w;
    const cy = (cur / w) | 0;
    for (const [dx, dy] of DIRS) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const ni = ny * w + nx;
      if (seen[ni] === generation || blocked[ni]) continue;
      // Same no-corner-cutting rule as findPath, so whatever we find is reachable.
      if (dx !== 0 && dy !== 0 && (blocked[cy * w + nx] || blocked[ny * w + cx])) continue;
      seen[ni] = generation;
      queue.push(ni);
    }
  }
  return -1;
}
