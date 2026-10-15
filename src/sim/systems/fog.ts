import { TILE, type World } from '../types';
import { buildingDef, unitDef } from '../world';

const circles = new Map<number, [number, number][]>();

function circle(r: number): [number, number][] {
  let c = circles.get(r);
  if (!c) {
    c = [];
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) if (dx * dx + dy * dy <= r * r + r) c.push([dx, dy]);
    }
    circles.set(r, c);
  }
  return c;
}

export function updateFog(world: World): void {
  const { w, h } = world;
  // Without fog, createWorld already made everything visible.
  if (world.rules.fog === 'off') return;
  for (const v of world.visible) v.fill(0);
  for (const e of world.entities.values()) {
    const vis = world.visible[e.owner];
    const exp = world.explored[e.owner];
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
    for (const [dx, dy] of circle(r)) {
      const x = cx + dx;
      const y = cy + dy;
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      const i = y * w + x;
      vis[i] = 1;
      exp[i] = 1;
    }
  }
}
