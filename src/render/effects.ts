import type { Graphics } from 'pixi.js';
import { TILE_PX } from '../client';
import { TILE, type Entity, type SimEvent } from '../sim/types';
import { COLORS, TEAM } from './palette';
import { drawWreck } from './shapes';

/** Sim units → pixels. */
const S = TILE_PX / TILE;

/** Live particle budget; smoke is dropped first when it is exceeded. */
const MAX_PARTICLES = 800;

type Shape = 'disc' | 'ring' | 'spark' | 'flash' | 'chunk';

interface Particle {
  shape: Shape;
  x: number;
  y: number;
  /** Velocity in px/s. */
  vx: number;
  vy: number;
  /** May lie in the future, for staggered spawns. */
  born: number;
  life: number;
  r0: number;
  r1: number;
  color: number;
  alpha: number;
  /** Velocity damping per second (exponential). */
  drag: number;
  /** Upward drift acceleration in px/s². */
  rise: number;
  /** Smoke fades in instead of starting at full alpha, and is first to go when over budget. */
  smoke: boolean;
  angle: number;
}

interface Decal {
  kind: 'scorch' | 'wreck' | 'body' | 'rubble';
  x: number;
  y: number;
  born: number;
  life: number;
  angle: number;
  type: string;
  owner: number;
  w: number;
  h: number;
  r: number;
  /** Fractional smoke/fire particles owed, for rate-based emission. */
  smokeAcc: number;
  fireAcc: number;
}

interface Emitter {
  smoke: number;
  fire: number;
  frame: number;
}

const rand = (a: number, b: number) => a + Math.random() * (b - a);
const pick = <T>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)];

/** Client-side particles and ground decals. Never touches the sim. */
export class Effects {
  private particles: Particle[] = [];
  private decals: Decal[] = [];
  private emitters = new Map<number, Emitter>();
  private last = 0;
  private frame = 0;
  private dt = 0;

  reset() {
    this.particles = [];
    this.decals = [];
    this.emitters.clear();
    this.last = 0;
  }

  // --- spawners -------------------------------------------------------------

  private add(p: Partial<Particle> & { x: number; y: number; life: number }) {
    if (this.particles.length >= MAX_PARTICLES) {
      const i = this.particles.findIndex((q) => q.smoke);
      this.particles.splice(i >= 0 ? i : 0, 1);
    }
    this.particles.push({
      shape: 'disc',
      vx: 0,
      vy: 0,
      born: performance.now(),
      r0: 2,
      r1: 2,
      color: 0xffffff,
      alpha: 1,
      drag: 0,
      rise: 0,
      smoke: false,
      angle: 0,
      ...p,
    });
  }

  private smokePuff(x: number, y: number, color: number, size: number, life: number, delay = 0) {
    this.add({
      x: x + rand(-2, 2),
      y: y + rand(-2, 2),
      // A slight constant breeze so plumes lean the same way.
      vx: rand(-3, 9),
      vy: rand(-24, -12),
      born: performance.now() + delay,
      life,
      r0: size * 0.6,
      r1: size * 2.2,
      color,
      alpha: 0.6,
      drag: 0.6,
      rise: 4,
      smoke: true,
    });
  }

  private sparks(x: number, y: number, n: number, speed: number, delay = 0) {
    for (let k = 0; k < n; k++) {
      const a = rand(0, Math.PI * 2);
      const v = rand(speed * 0.4, speed);
      this.add({ shape: 'spark', x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, born: performance.now() + delay, life: rand(150, 320), color: pick(COLORS.fx.fire), drag: 5 });
    }
  }

  private fireball(x: number, y: number, size: number, delay = 0) {
    const born = performance.now() + delay;
    this.add({ x, y, born, life: 260, r0: size * 0.4, r1: size, color: 0xfff1c1, alpha: 0.9 });
    this.add({ x, y, born, life: 420, r0: size * 0.5, r1: size * 1.3, color: COLORS.fx.fire[1], alpha: 0.7 });
    this.add({ shape: 'ring', x, y, born, life: 300, r0: size * 0.5, r1: size * 2, color: 0xffd08a, alpha: 0.8 });
  }

  /** Flash at the barrel tip; (x0, y0) is the shooter, (x1, y1) the target, in pixels. */
  muzzleFlash(x0: number, y0: number, x1: number, y1: number, weapon: 'bullet' | 'shell') {
    const angle = Math.atan2(y1 - y0, x1 - x0);
    const len = weapon === 'shell' ? 15 : 9;
    const x = x0 + Math.cos(angle) * len;
    const y = y0 + Math.sin(angle) * len;
    const big = weapon === 'shell';
    this.add({ shape: 'flash', x, y, angle, life: big ? 80 : 55, r0: big ? 6 : 3.5, r1: big ? 7 : 4, color: COLORS.fx.muzzle });
    if (big) this.smokePuff(x + Math.cos(angle) * 3, y + Math.sin(angle) * 3, COLORS.fx.smokeLight, 4, 600);
  }

  impact(x: number, y: number, weapon: 'bullet' | 'shell') {
    if (weapon === 'bullet') {
      this.sparks(x, y, 2 + Math.floor(Math.random() * 2), 90);
      this.add({ x, y, life: 260, r0: 1.5, r1: 4, color: COLORS.fx.dust, alpha: 0.5, smoke: true });
      return;
    }
    this.fireball(x, y, 9);
    this.sparks(x, y, 7, 160);
    for (let k = 0; k < 3; k++) this.smokePuff(x + rand(-4, 4), y + rand(-4, 4), COLORS.fx.smokeDark, 6, rand(700, 1100), 80);
    this.decal({ kind: 'scorch', x, y, life: 4000, r: rand(6, 9) });
  }

  death(ev: Extract<SimEvent, { t: 'death' }>) {
    const now = performance.now();
    const x = ev.x * S;
    const y = ev.y * S;
    const angle = Math.atan2(ev.fy, ev.fx);
    if (ev.kind === 'building') {
      const px = ev.tx * TILE_PX;
      const py = ev.ty * TILE_PX;
      const w = ev.w * TILE_PX;
      const h = ev.h * TILE_PX;
      // A wall segment just crumbles; real buildings go up in a chain of blasts.
      const wall = ev.type === 'wall';
      const n = wall ? 1 : 4 + Math.floor(Math.random() * 3);
      for (let k = 0; k < n; k++) {
        const delay = (k / n) * 600 + rand(0, 80);
        const ex = px + rand(0.15, 0.85) * w;
        const ey = py + rand(0.15, 0.85) * h;
        this.fireball(ex, ey, wall ? rand(6, 9) : rand(12, 18), delay);
        this.sparks(ex, ey, 6, 200, delay);
      }
      for (let k = 0; k < (wall ? 3 : 10); k++) {
        this.smokePuff(px + rand(0.1, 0.9) * w, py + rand(0.1, 0.9) * h, k % 2 ? COLORS.fx.dust : COLORS.fx.smokeDark, rand(10, 16), rand(1400, 2200), 500 + rand(0, 300));
      }
      this.decal({ kind: 'rubble', x: px, y: py, w, h, life: 10000, born: now });
      return;
    }
    if (ev.type === 'rifleman') {
      this.decal({ kind: 'body', x, y, angle: angle + Math.PI / 2, owner: ev.owner, life: 1500 });
      this.add({ x, y, life: 300, r0: 2, r1: 6, color: COLORS.fx.dust, alpha: 0.4, smoke: true });
      return;
    }
    // Vehicles: burst, flying debris, then a smoking wreck.
    this.fireball(x, y, 18);
    this.sparks(x, y, 10, 220);
    for (let k = 0; k < 6; k++) {
      const a = rand(0, Math.PI * 2);
      const v = rand(60, 140);
      this.add({ shape: 'chunk', x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: rand(400, 700), r0: rand(1.5, 2.5), r1: 1.5, color: COLORS.fx.wreckEdge, drag: 4, angle: a });
    }
    this.decal({ kind: 'scorch', x, y, life: 6000, r: 16 });
    this.decal({ kind: 'wreck', x, y, angle, type: ev.type, life: 6000 });
  }

  private decal(d: Partial<Decal> & Pick<Decal, 'kind' | 'x' | 'y' | 'life'>) {
    this.decals.push({ born: performance.now(), angle: 0, type: '', owner: 0, w: 0, h: 0, r: 0, smokeAcc: 0, fireAcc: 0, ...d });
  }

  /** Smoke and fire from a damaged building. Call once per frame for each visible, live building. */
  buildingDamage(e: Entity) {
    const frac = e.hp / e.maxHp;
    if (frac >= 0.6) return;
    let em = this.emitters.get(e.id);
    if (!em) this.emitters.set(e.id, (em = { smoke: 0, fire: 0, frame: 0 }));
    em.frame = this.frame;
    const missing = 1 - frac;
    const heavy = frac < 0.3;
    em.smoke += this.dt * (heavy ? 6 + missing * 10 : 2 + missing * 6);
    if (heavy) em.fire += this.dt * 14;
    // One or two fixed vents per building, stable across frames.
    let h = Math.imul(e.id, 2654435761) >>> 0;
    const vents: [number, number][] = [];
    const nv = e.w * e.h >= 6 ? 2 : 1;
    for (let k = 0; k < nv; k++) {
      vents.push([(e.tx + 0.2 + ((h & 255) / 255) * 0.6 * e.w) * TILE_PX, (e.ty + 0.2 + (((h >> 8) & 255) / 255) * 0.6 * e.h) * TILE_PX]);
      h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
    }
    for (; em.smoke >= 1; em.smoke--) {
      const [vx, vy] = pick(vents);
      this.smokePuff(vx, vy, heavy ? COLORS.fx.smokeDark : COLORS.fx.smokeLight, heavy ? 7 : 6, rand(1400, 2000));
    }
    for (; em.fire >= 1; em.fire--) {
      const [vx, vy] = pick(vents);
      this.add({ x: vx + rand(-4, 4), y: vy + rand(-3, 3), vy: rand(-18, -8), life: rand(250, 450), r0: rand(3, 5), r1: 1, color: pick(COLORS.fx.fire), alpha: 0.85, rise: 10 });
    }
  }

  // --- update and draw ------------------------------------------------------

  /** Advance particles to `now`. Call once per frame before buildingDamage and draw. */
  update(now: number) {
    // Clamped so a long frame (or a backgrounded tab) doesn't dump a burst of smoke.
    this.dt = this.last ? Math.min(0.1, (now - this.last) / 1000) : 0;
    this.last = now;
    this.frame++;
    const dt = this.dt;
    this.particles = this.particles.filter((p) => now - p.born < p.life);
    for (const p of this.particles) {
      if (now < p.born) continue;
      const k = Math.exp(-p.drag * dt);
      p.vx *= k;
      p.vy = p.vy * k - p.rise * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
    }
    this.decals = this.decals.filter((d) => now - d.born < d.life);
    for (const d of this.decals) {
      if (d.kind !== 'wreck') continue;
      const t = (now - d.born) / d.life;
      if (t < 0.7) d.smokeAcc += dt * 5 * (1 - t);
      if (now - d.born < 1500) d.fireAcc += dt * 16;
      for (; d.smokeAcc >= 1; d.smokeAcc--) this.smokePuff(d.x + rand(-5, 5), d.y + rand(-5, 5), COLORS.fx.smokeDark, 6, rand(1200, 1800));
      for (; d.fireAcc >= 1; d.fireAcc--) this.add({ x: d.x + rand(-6, 6), y: d.y + rand(-5, 5), vy: rand(-15, -6), life: rand(200, 380), r0: rand(2.5, 4.5), r1: 1, color: pick(COLORS.fx.fire), alpha: 0.85, rise: 8 });
    }
    for (const [id, em] of this.emitters) if (em.frame < this.frame - 1) this.emitters.delete(id);
  }

  drawGround(g: Graphics, now: number, visible: (x: number, y: number) => boolean) {
    for (const d of this.decals) {
      const t = (now - d.born) / d.life;
      // Hold, then fade out over the last third.
      const a = t < 0.66 ? 1 : (1 - t) * 3;
      switch (d.kind) {
        case 'scorch':
          if (!visible(d.x, d.y)) break;
          g.circle(d.x, d.y, d.r).fill({ color: COLORS.fx.scorch, alpha: 0.4 * a });
          g.circle(d.x, d.y, d.r * 0.55).fill({ color: COLORS.fx.scorch, alpha: 0.35 * a });
          break;
        case 'wreck':
          if (visible(d.x, d.y)) drawWreck(g, d.x, d.y, d.angle, d.type, a);
          break;
        case 'body': {
          if (!visible(d.x, d.y)) break;
          // Falls over in the first 250ms: the round body flattens into a figure lying down.
          const fall = Math.min(1, (now - d.born) / 250);
          const fade = Math.min(1, (1 - t) * 2);
          g.circle(d.x, d.y, 4 + fall * 2).fill({ color: COLORS.fx.splat, alpha: 0.45 * fade * fall });
          g.poly(ellipse(d.x, d.y, 5.5 + fall * 2.5, 5.5 - fall * 2.5, d.angle)).fill({ color: TEAM[d.owner].dark, alpha: fade });
          break;
        }
        case 'rubble': {
          if (!visible(d.x + d.w / 2, d.y + d.h / 2)) break;
          g.rect(d.x + 3, d.y + 3, d.w - 6, d.h - 6).fill({ color: COLORS.fx.scorch, alpha: 0.6 * a });
          // Stable scattered blocks.
          let h = Math.imul((d.x * 31 + d.y) | 0, 2654435761) >>> 0;
          for (let k = 0; k < (d.w * d.h > TILE_PX * TILE_PX ? 10 : 3); k++) {
            const bx = d.x + 6 + ((h & 255) / 255) * (d.w - 16);
            const by = d.y + 6 + (((h >> 8) & 255) / 255) * (d.h - 16);
            const s = 3 + ((h >> 16) & 7);
            g.rect(bx, by, s, s * 0.7).fill({ color: k % 3 ? COLORS.fx.wreck : COLORS.fx.wreckEdge, alpha: a });
            h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
          }
          break;
        }
      }
    }
  }

  drawAir(g: Graphics, now: number, visible: (x: number, y: number) => boolean) {
    for (const p of this.particles) {
      if (now < p.born || !visible(p.x, p.y)) continue;
      const t = (now - p.born) / p.life;
      const r = p.r0 + (p.r1 - p.r0) * t;
      const a = p.alpha * (p.smoke ? Math.min(1, t * 8) * (1 - t * t) : 1 - t);
      switch (p.shape) {
        case 'disc':
          g.circle(p.x, p.y, r).fill({ color: p.color, alpha: a });
          break;
        case 'ring':
          g.circle(p.x, p.y, r).stroke({ width: 2, color: p.color, alpha: a });
          break;
        case 'spark':
          g.moveTo(p.x, p.y)
            .lineTo(p.x - p.vx * 0.03, p.y - p.vy * 0.03)
            .stroke({ width: 1.5, color: p.color, alpha: a });
          break;
        case 'chunk':
          g.poly(ellipse(p.x, p.y, r, r * 0.7, p.angle + t * 8, 4)).fill({ color: p.color, alpha: Math.min(1, a * 2) });
          break;
        case 'flash': {
          // Elongated star pointing along the shot, with a white-hot core.
          const c = Math.cos(p.angle);
          const s = Math.sin(p.angle);
          const pt = (f: number, side: number) => [p.x + c * f - s * side, p.y + s * f + c * side];
          g.poly([...pt(r * 2.4, 0), ...pt(r * 0.5, r * 0.9), ...pt(0, r * 1.4), ...pt(-r * 0.4, r * 0.5), ...pt(-r * 0.6, 0), ...pt(-r * 0.4, -r * 0.5), ...pt(0, -r * 1.4), ...pt(r * 0.5, -r * 0.9)]).fill({ color: p.color, alpha: a });
          g.circle(p.x, p.y, r * 0.5).fill({ color: 0xffffff, alpha: a });
          break;
        }
      }
    }
  }
}

/** Polygon points for an ellipse with radii (rx, ry), rotated by `angle`. */
function ellipse(cx: number, cy: number, rx: number, ry: number, angle: number, n = 12): number[] {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    const x = Math.cos(t) * rx;
    const y = Math.sin(t) * ry;
    out.push(cx + x * c - y * s, cy + x * s + y * c);
  }
  return out;
}
