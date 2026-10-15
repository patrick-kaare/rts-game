import { TILE_PX } from '../client';
import type { Game } from '../game';
import { TEAM } from '../render/palette';
import { TILE, Terrain, type World } from '../sim/types';

const SIZE = 192;

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
    this.redrawBase(world);
  }

  private oreVersion = -1;

  private redrawBase(world: World) {
    const ctx = this.base.getContext('2d')!;
    const img = ctx.createImageData(world.w, world.h);
    for (let i = 0; i < world.terrain.length; i++) {
      const t = world.terrain[i];
      let c = MINIMAP_COLORS[t];
      if (world.ore[i]) c = [224, 168, 46];
      img.data.set([c[0], c[1], c[2], 255], i * 4);
    }
    ctx.putImageData(img, 0, 0);
    this.oreVersion = world.oreVersion;
  }

  draw() {
    const world = this.game.world;
    const me = this.game.state.localPlayer;
    const ctx = this.ctx;
    if (world.oreVersion - this.oreVersion > 50) this.redrawBase(world);
    const sx = SIZE / world.w;
    const sy = SIZE / world.h;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.base, 0, 0, SIZE, SIZE);

    const vis = world.visible[me];
    for (const e of world.entities.values()) {
      const tx = Math.floor(e.x / TILE);
      const ty = Math.floor(e.y / TILE);
      if (e.owner !== me && !vis[ty * world.w + tx]) continue;
      ctx.fillStyle = TEAM[e.owner].css;
      if (e.kind === 'building') ctx.fillRect(e.tx * sx, e.ty * sy, e.w * sx, e.h * sy);
      else ctx.fillRect(tx * sx, ty * sy, Math.max(2, sx), Math.max(2, sy));
    }

    // Fog: one pixel per tile, scaled up.
    const exp = world.explored[me];
    const data = this.fogImage!.data;
    for (let i = 0; i < vis.length; i++) data[i * 4 + 3] = vis[i] ? 0 : exp[i] ? 128 : 255;
    this.fogCtx.putImageData(this.fogImage!, 0, 0);
    ctx.drawImage(this.fog, 0, 0, SIZE, SIZE);

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
}
