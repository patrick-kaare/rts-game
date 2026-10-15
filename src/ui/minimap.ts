import { TILE_PX } from '../client';
import type { Game } from '../game';
import { TEAM } from '../render/palette';
import { isLowPower } from '../sim/systems/production';
import { TILE, Terrain, type World } from '../sim/types';

const SIZE = 192;
/** Under-attack pings: how long one pulses, and how near (tiles) and recent (ms) another must be to suppress a new one. */
const PING_LIFE_MS = 1500;
const PING_RADIUS_TILES = 8;
const PING_COOLDOWN_MS = 4000;

/** RGB per terrain id. */
const MINIMAP_COLORS: number[][] = [];
MINIMAP_COLORS[Terrain.Grass] = [47, 74, 44];
MINIMAP_COLORS[Terrain.Rock] = [91, 93, 97];
MINIMAP_COLORS[Terrain.Water] = [29, 59, 92];
MINIMAP_COLORS[Terrain.Forest] = [26, 56, 28];
MINIMAP_COLORS[Terrain.Road] = [120, 102, 72];
MINIMAP_COLORS[Terrain.Bridge] = [138, 104, 64];

export class Minimap {
  readonly canvas = document.createElement('canvas');
  private ctx: CanvasRenderingContext2D;
  private base = document.createElement('canvas');
  private fog = document.createElement('canvas');
  private fogCtx = this.fog.getContext('2d')!;
  private fogImage: ImageData | null = null;
  private dragging = false;
  /** Under-attack pings, in tiles. */
  private pings: { x: number; y: number; born: number }[] = [];

  constructor(private game: Game) {
    this.canvas.width = SIZE;
    this.canvas.height = SIZE;
    this.canvas.className = 'minimap';
    this.ctx = this.canvas.getContext('2d')!;
    const jump = (ev: MouseEvent) => {
      const r = this.canvas.getBoundingClientRect();
      const world = this.game.world;
      const x = ((ev.clientX - r.left) / r.width) * world.w * TILE_PX;
      const y = ((ev.clientY - r.top) / r.height) * world.h * TILE_PX;
      this.game.camera.centerOn(x, y);
    };
    this.canvas.addEventListener('mousedown', (ev) => {
      if (ev.button === 2 && this.game.input.selectedOwnUnits().length) {
        // Right-click on the minimap: move selected units there.
        const r = this.canvas.getBoundingClientRect();
        const world = this.game.world;
        const x = Math.floor(((ev.clientX - r.left) / r.width) * world.w);
        const y = Math.floor(((ev.clientY - r.top) / r.height) * world.h);
        this.game.send({ t: 'move', ids: this.game.input.selectedOwnUnits().map((e) => e.id), x, y });
        return;
      }
      this.dragging = true;
      jump(ev);
    });
    this.canvas.addEventListener('contextmenu', (ev) => ev.preventDefault());
    window.addEventListener('mousemove', (ev) => this.dragging && jump(ev));
    window.addEventListener('mouseup', () => (this.dragging = false));
  }

  setWorld(world: World) {
    this.base.width = world.w;
    this.base.height = world.h;
    this.fog.width = world.w;
    this.fog.height = world.h;
    this.fogImage = this.fogCtx.createImageData(world.w, world.h);
    this.pings = [];
    this.redrawBase(world);
  }

  /** Something of ours was hit at this tile. One ping per area every few seconds, so a long fight doesn't spam. */
  alert(tx: number, ty: number) {
    const now = performance.now();
    const r2 = PING_RADIUS_TILES * PING_RADIUS_TILES;
    const near = this.pings.some((p) => now - p.born < PING_COOLDOWN_MS && (p.x - tx) ** 2 + (p.y - ty) ** 2 < r2);
    if (!near) this.pings.push({ x: tx, y: ty, born: now });
  }

  private oreVersion = -1;
  private baseTick = 0;

  private redrawBase(world: World) {
    const ctx = this.base.getContext('2d')!;
    const img = ctx.createImageData(world.w, world.h);
    for (let i = 0; i < world.terrain.length; i++) {
      const t = world.terrain[i];
      let c = MINIMAP_COLORS[t];
      if (world.ore[i]) c = world.gems[i] ? [95, 216, 232] : [224, 168, 46];
      img.data.set([c[0], c[1], c[2], 255], i * 4);
    }
    ctx.putImageData(img, 0, 0);
    this.oreVersion = world.oreVersion;
    this.baseTick = world.tick;
  }

  draw() {
    const world = this.game.world;
    // The viewed player; -1 for a spectator's whole map view, which has no fog.
    const me = this.game.state.view;
    const ctx = this.ctx;
    // Mining changes ore every tick, so batch those; slow regrowth still shows up within a couple of seconds.
    const oreChanged = world.oreVersion - this.oreVersion;
    if (oreChanged > 50 || (oreChanged > 0 && world.tick - this.baseTick >= 40)) this.redrawBase(world);
    const sx = SIZE / world.w;
    const sy = SIZE / world.h;
    // Full power rules: radar goes dark at low power, showing only our own things.
    const dark = me >= 0 && world.rules.power === 'full' && isLowPower(world.players[me]);
    ctx.imageSmoothingEnabled = false;
    if (dark) {
      ctx.fillStyle = '#16181c';
      ctx.fillRect(0, 0, SIZE, SIZE);
    } else ctx.drawImage(this.base, 0, 0, SIZE, SIZE);

    const vis = me >= 0 ? world.visible[me] : null;
    for (const e of world.entities.values()) {
      const tx = Math.floor(e.x / TILE);
      const ty = Math.floor(e.y / TILE);
      if (vis && e.owner !== me && (dark || !vis[ty * world.w + tx])) continue;
      ctx.fillStyle = TEAM[e.owner].css;
      if (e.kind === 'building') ctx.fillRect(e.tx * sx, e.ty * sy, e.w * sx, e.h * sy);
      else ctx.fillRect(tx * sx, ty * sy, Math.max(2, sx), Math.max(2, sy));
    }

    if (dark) {
      ctx.fillStyle = '#f87171';
      ctx.font = 'bold 12px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('RADAR OFFLINE', SIZE / 2, SIZE / 2);
    } else if (vis) {
      // Fog: one pixel per tile, scaled up.
      const exp = world.explored[me];
      const data = this.fogImage!.data;
      for (let i = 0; i < vis.length; i++) data[i * 4 + 3] = vis[i] ? 0 : exp[i] ? 128 : 255;
      this.fogCtx.putImageData(this.fogImage!, 0, 0);
      ctx.drawImage(this.fog, 0, 0, SIZE, SIZE);
    }

    this.drawPings(sx, sy);

    const cam = this.game.camera;
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1;
    ctx.strokeRect(
      (cam.x / TILE_PX) * sx + 0.5,
      (cam.y / TILE_PX) * sy + 0.5,
      (cam.viewW / TILE_PX) * sx,
      (cam.viewH / TILE_PX) * sy,
    );
  }

  /** Two staggered red rings growing and fading at each recent ping. */
  private drawPings(sx: number, sy: number) {
    const now = performance.now();
    this.pings = this.pings.filter((p) => now - p.born < PING_COOLDOWN_MS);
    const ctx = this.ctx;
    ctx.strokeStyle = '#ef4444';
    ctx.lineWidth = 2;
    for (const p of this.pings) {
      const cx = (p.x + 0.5) * sx;
      const cy = (p.y + 0.5) * sy;
      for (const delay of [0, PING_LIFE_MS / 3]) {
        const t = (now - p.born - delay) / (PING_LIFE_MS - delay);
        if (t < 0 || t >= 1) continue;
        ctx.globalAlpha = 1 - t;
        ctx.beginPath();
        ctx.arc(cx, cy, 3 + t * 11, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
  }
}
