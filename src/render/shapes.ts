import type { Graphics } from 'pixi.js';
import { HARVESTER_CAPACITY } from '../sim/data/units';
import { TILE_PX } from '../client';
import { COLORS, type TeamColors } from './palette';

/** Rotate a list of local [x, y] points by `angle` around (cx, cy). */
function rotated(cx: number, cy: number, angle: number, pts: number[]): number[] {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const out: number[] = [];
  for (let i = 0; i < pts.length; i += 2) {
    out.push(cx + pts[i] * c - pts[i + 1] * s, cy + pts[i] * s + pts[i + 1] * c);
  }
  return out;
}

export function drawRifleman(g: Graphics, x: number, y: number, aim: number, team: TeamColors) {
  g.moveTo(x, y)
    .lineTo(x + Math.cos(aim) * 9, y + Math.sin(aim) * 9)
    .stroke({ width: 2, color: 0x111111 });
  g.circle(x, y, 5.5).fill(team.main).stroke({ width: 1.5, color: team.dark });
}

export function drawTank(g: Graphics, x: number, y: number, facing: number, aim: number, team: TeamColors) {
  g.poly(rotated(x, y, facing, [-11, -8, 11, -8, 11, 8, -11, 8])).fill(team.dark).stroke({ width: 1.5, color: team.main });
  // Treads.
  g.poly(rotated(x, y, facing, [-11, -8, 11, -8, 11, -5, -11, -5])).fill(0x222222);
  g.poly(rotated(x, y, facing, [-11, 5, 11, 5, 11, 8, -11, 8])).fill(0x222222);
  g.moveTo(x, y)
    .lineTo(x + Math.cos(aim) * 15, y + Math.sin(aim) * 15)
    .stroke({ width: 3, color: 0x1a1a1a });
  g.circle(x, y, 5.5).fill(team.main).stroke({ width: 1, color: team.dark });
}

export function drawHarvester(g: Graphics, x: number, y: number, facing: number, cargo: number, team: TeamColors) {
  g.poly(rotated(x, y, facing, [14, 0, 0, -11, -14, 0, 0, 11])).fill(team.dark).stroke({ width: 2, color: team.main });
  const frac = cargo / HARVESTER_CAPACITY;
  g.poly(rotated(x, y, facing, [-6, -4, 6, -4, 6, 4, -6, 4])).fill(0x1a1a1a);
  if (frac > 0) {
    const w = 12 * frac;
    g.poly(rotated(x, y, facing, [-6, -4, -6 + w, -4, -6 + w, 4, -6, 4])).fill(COLORS.ore);
  }
}

/** Charred hull left behind by a destroyed vehicle. */
export function drawWreck(g: Graphics, x: number, y: number, facing: number, type: string, alpha: number) {
  const body = { color: COLORS.fx.wreck, alpha };
  const edge = { width: 1.5, color: COLORS.fx.wreckEdge, alpha };
  if (type === 'tank') {
    g.poly(rotated(x, y, facing, [-11, -8, 11, -8, 11, 8, -11, 8])).fill(body).stroke(edge);
    // Turret knocked askew, barrel snapped short.
    const turret = facing + 0.7;
    g.moveTo(x, y)
      .lineTo(x + Math.cos(turret) * 9, y + Math.sin(turret) * 9)
      .stroke({ width: 3, color: 0x111111, alpha });
    g.circle(x, y, 5).fill({ color: 0x171513, alpha });
  } else {
    g.poly(rotated(x, y, facing, [14, 0, 0, -11, -14, 0, 0, 11])).fill(body).stroke(edge);
    g.poly(rotated(x, y, facing, [-6, -4, 6, -4, 6, 4, -6, 4])).fill({ color: 0x111111, alpha });
  }
}

/** Buildings: team-tinted body with a simple symbol per type. (x, y) is the top-left in pixels. */
export function drawBuilding(g: Graphics, type: string, x: number, y: number, wTiles: number, hTiles: number, team: TeamColors, dim = false) {
  const w = wTiles * TILE_PX;
  const h = hTiles * TILE_PX;
  const m = 2;
  const alpha = dim ? 0.55 : 1;
  g.rect(x + m, y + m, w - m * 2, h - m * 2).fill({ color: 0x2b2f36, alpha }).stroke({ width: 2, color: team.main, alpha });
  const cx = x + w / 2;
  const cy = y + h / 2;
  const sym = { color: team.light, alpha };
  switch (type) {
    case 'cy': {
      g.rect(x + 10, y + 10, w - 20, h - 20).fill({ color: team.dark, alpha });
      // Crane.
      g.moveTo(x + 14, y + h - 14).lineTo(x + 14, y + 12).lineTo(x + w - 12, y + 12).stroke({ width: 4, ...sym });
      g.moveTo(x + w - 18, y + 12).lineTo(x + w - 18, y + 30).stroke({ width: 2, ...sym });
      g.rect(x + w - 23, y + 30, 10, 8).fill(sym);
      break;
    }
    case 'power': {
      g.circle(x + 20, y + 22, 11).fill({ color: team.dark, alpha }).stroke({ width: 2, ...sym });
      g.circle(x + w - 20, y + h - 22, 11).fill({ color: team.dark, alpha }).stroke({ width: 2, ...sym });
      g.poly([cx + 3, cy - 12, cx - 6, cy + 2, cx, cy + 2, cx - 3, cy + 12, cx + 6, cy - 2, cx, cy - 2]).fill({ color: 0xfde047, alpha });
      break;
    }
    case 'refinery': {
      g.circle(x + 22, cy - 2, 14).fill({ color: team.dark, alpha }).stroke({ width: 2, ...sym });
      g.circle(x + 22, cy - 2, 6).fill({ color: COLORS.ore, alpha });
      g.rect(x + 44, y + 10, w - 54, 16).fill({ color: team.dark, alpha }).stroke({ width: 1, ...sym });
      // Dock marker along the bottom-middle edge.
      g.rect(x + TILE_PX + 4, y + h - 6, TILE_PX - 8, 4).fill({ color: COLORS.ore, alpha });
      break;
    }
    case 'barracks': {
      g.poly([x + 8, y + h - 10, cx, y + 10, x + w - 8, y + h - 10]).fill({ color: team.dark, alpha }).stroke({ width: 2, ...sym });
      g.rect(cx - 5, y + h - 22, 10, 12).fill({ color: 0x111111, alpha });
      break;
    }
    case 'factory': {
      g.rect(x + 10, y + 10, w - 20, h - 36).fill({ color: team.dark, alpha });
      g.rect(x + 20, y + h - 30, w - 40, 24).fill({ color: 0x111111, alpha });
      for (let k = 0; k < 4; k++) g.rect(x + 22, y + h - 28 + k * 6, w - 44, 3).fill(sym);
      break;
    }
  }
}
