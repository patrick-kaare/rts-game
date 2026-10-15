import { Application, Container, Graphics, Sprite, Texture } from 'pixi.js';
import { TILE_PX, type ClientState } from '../client';
import type { Camera } from '../input/camera';
import { BUILDINGS } from '../sim/data/buildings';
import { canPlace, tileBuildable } from '../sim/systems/construction';
import { TILE, Terrain, type Entity, type SimEvent, type World } from '../sim/types';
import { areAllies } from '../sim/world';
import { Effects } from './effects';
import { COLORS, TEAM, hpColor } from './palette';
import { drawBuilding, drawHarvester, drawJeep, drawRifleman, drawTank } from './shapes';

/** Tiles of solid fog drawn around the map, so its edge never shows a seam. */
const FOG_MARGIN = 2;

/** Ore is drawn in square chunks of this many tiles, so mining only redraws what changed. */
const ORE_CHUNK = 16;

/** Sim units → pixels. */
const S = TILE_PX / TILE;

interface Effect {
  kind: 'shot' | 'shell' | 'marker';
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  born: number;
  life: number;
  color: number;
}

interface RememberedBuilding {
  id: number;
  owner: number;
  type: string;
  tx: number;
  ty: number;
  w: number;
  h: number;
}

export class Renderer {
  readonly root = new Container();
  private terrain = new Graphics();
  private ore = new Container();
  private oreChunks: Graphics[] = [];
  /** Dots last drawn per tile; a chunk is redrawn when any of its tiles changes. */
  private oreDots = new Uint8Array(0);
  private groundFx = new Graphics();
  private buildings = new Graphics();
  private units = new Graphics();
  private effectsG = new Graphics();
  private overlay = new Graphics();
  private screen = new Graphics();
  private fogCanvas = document.createElement('canvas');
  private fogCtx: CanvasRenderingContext2D;
  private fogImage: ImageData;
  private fogTexture: Texture;
  private fogSprite: Sprite;
  private effects: Effect[] = [];
  private fx = new Effects();
  private oreVersion = -1;
  private fogTick = -1;
  private remembered = new Map<number, RememberedBuilding>();
  private world!: World;
  private localPlayer = 0;

  constructor(private app: Application) {
    this.fogCanvas.width = 64;
    this.fogCanvas.height = 64;
    this.fogCtx = this.fogCanvas.getContext('2d')!;
    this.fogImage = this.fogCtx.createImageData(64, 64);
    this.fogTexture = Texture.from(this.fogCanvas, true);
    this.fogSprite = new Sprite(this.fogTexture);
    this.root.addChild(this.terrain, this.ore, this.groundFx, this.buildings, this.units, this.effectsG, this.fogSprite, this.overlay);
    app.stage.addChild(this.root, this.screen);
  }

  setWorld(world: World, localPlayer: number) {
    this.world = world;
    this.localPlayer = localPlayer;
    this.remembered.clear();
    this.effects = [];
    this.fx.reset();
    this.oreVersion = -1;
    this.oreDots = new Uint8Array(0);
    this.fogTick = -1;
    // The fog extends FOG_MARGIN tiles past the map on every side. If it ended exactly
    // at the map edge, antialiasing (and fractional display scaling) would let a
    // sliver of terrain show through there, flickering as the fog updates.
    const fw = world.w + FOG_MARGIN * 2;
    const fh = world.h + FOG_MARGIN * 2;
    if (this.fogCanvas.width !== fw || this.fogCanvas.height !== fh) {
      this.fogCanvas.width = fw;
      this.fogCanvas.height = fh;
      this.fogImage = this.fogCtx.createImageData(fw, fh);
      // The margin is always fully fogged; the map area is rewritten every tick.
      for (let i = 3; i < this.fogImage.data.length; i += 4) this.fogImage.data[i] = 255;
      // Recreate the texture so it picks up the new canvas size.
      const old = this.fogTexture;
      this.fogTexture = Texture.from(this.fogCanvas, true);
      this.fogSprite.texture = this.fogTexture;
      old.destroy();
    }
    this.fogSprite.scale.set(TILE_PX);
    this.fogSprite.position.set(-FOG_MARGIN * TILE_PX, -FOG_MARGIN * TILE_PX);
    this.drawTerrain();
  }

  handleEvents(events: SimEvent[]) {
    const now = performance.now();
    for (const ev of events) {
      if (ev.t === 'shot') {
        const jitter = ev.weapon === 'shell' ? 4 : 6;
        this.effects.push({
          kind: ev.weapon === 'shell' ? 'shell' : 'shot',
          x0: ev.x0 * S,
          y0: ev.y0 * S,
          x1: ev.x1 * S + (Math.random() - 0.5) * jitter,
          y1: ev.y1 * S + (Math.random() - 0.5) * jitter,
          born: now,
          life: ev.weapon === 'shell' ? 180 : 70,
          color: ev.weapon === 'shell' ? COLORS.shellShot : COLORS.bulletShot,
        });
        const shot = this.effects[this.effects.length - 1];
        this.fx.muzzleFlash(shot.x0, shot.y0, shot.x1, shot.y1, ev.weapon);
        this.fx.impact(shot.x1, shot.y1, ev.weapon);
      } else {
        this.fx.death(ev);
      }
    }
  }

  /** A client-side marker where a command was issued. */
  marker(tx: number, ty: number, color: number) {
    const x = tx * TILE_PX + TILE_PX / 2;
    const y = ty * TILE_PX + TILE_PX / 2;
    this.effects.push({ kind: 'marker', x0: x, y0: y, x1: 0, y1: 0, born: performance.now(), life: 450, color });
  }

  render(alpha: number, state: ClientState, camera: Camera) {
    const world = this.world;
    this.root.position.set(-Math.round(camera.x), -Math.round(camera.y));
    const me = state.localPlayer;
    const visible = world.visible[me];
    const view = { x0: camera.x - 64, y0: camera.y - 64, x1: camera.x + camera.viewW + 64, y1: camera.y + camera.viewH + 64 };

    if (world.oreVersion !== this.oreVersion) {
      this.oreVersion = world.oreVersion;
      this.drawOre();
    }
    if (world.tick !== this.fogTick) {
      this.fogTick = world.tick;
      this.updateFog();
      this.updateMemory();
    }

    // Buildings: own and allied ones live, enemy ones from memory (last seen state).
    const b = this.buildings.clear();
    for (const e of world.entities.values()) {
      if (e.kind !== 'building' || !areAllies(world, e.owner, me)) continue;
      drawBuilding(b, e.type, e.tx * TILE_PX, e.ty * TILE_PX, e.w, e.h, TEAM[e.owner]);
    }
    for (const r of this.remembered.values()) {
      const live = world.entities.get(r.id);
      const seen = live && this.buildingVisible(live);
      drawBuilding(b, r.type, r.tx * TILE_PX, r.ty * TILE_PX, r.w, r.h, TEAM[r.owner], !seen);
    }

    this.fx.update(performance.now());

    // Units, interpolated between the previous and current tick.
    const u = this.units.clear();
    const o = this.overlay.clear();
    for (const e of world.entities.values()) {
      if (e.kind !== 'unit') continue;
      const x = (e.px + (e.x - e.px) * alpha) * S;
      const y = (e.py + (e.y - e.py) * alpha) * S;
      if (x < view.x0 || x > view.x1 || y < view.y0 || y > view.y1) continue;
      if (e.owner !== me && !visible[Math.floor(e.y / TILE) * world.w + Math.floor(e.x / TILE)]) continue;
      const team = TEAM[e.owner];
      const facing = Math.atan2(e.fy, e.fx);
      const aim = e.targetId ? Math.atan2(e.ay, e.ax) : facing;
      if (e.type === 'rifleman') drawRifleman(u, x, y, aim, team);
      else if (e.type === 'jeep') drawJeep(u, x, y, facing, aim, team);
      else if (e.type === 'tank') drawTank(u, x, y, facing, aim, team);
      else drawHarvester(u, x, y, facing, e.cargo, team);

      const selected = state.selection.has(e.id);
      const r = e.type === 'rifleman' ? 8 : e.type === 'jeep' ? 11 : 15;
      if (selected) o.circle(x, y, r + 1).stroke({ width: 1.5, color: 0xffffff, alpha: 0.9 });
      if (selected || state.hovered === e.id) this.healthBar(o, x - r, y - r - 6, r * 2, e.hp / e.maxHp);
    }

    for (const e of world.entities.values()) {
      if (e.kind !== 'building') continue;
      const selected = state.selection.has(e.id);
      if (e.owner !== me && !this.buildingVisible(e)) continue;
      const x = e.tx * TILE_PX;
      const y = e.ty * TILE_PX;
      const w = e.w * TILE_PX;
      const h = e.h * TILE_PX;
      if (selected) this.brackets(o, x, y, w, h);
      if (selected && e.owner === me && e.rallyX >= 0) this.rallyLine(o, x + w / 2, y + h, e.rallyX, e.rallyY);
      if (selected || state.hovered === e.id) this.healthBar(o, x + 4, y - 7, w - 8, e.hp / e.maxHp);
      if (x + w >= view.x0 && x <= view.x1 && y + h >= view.y0 && y <= view.y1) this.fx.buildingDamage(e);
    }

    const now = performance.now();
    const seen = (px: number, py: number) => {
      const tx = Math.floor(px / TILE_PX);
      const ty = Math.floor(py / TILE_PX);
      return tx >= 0 && ty >= 0 && tx < world.w && ty < world.h && visible[ty * world.w + tx] === 1;
    };
    this.fx.drawGround(this.groundFx.clear(), now, seen);
    this.fx.drawAir(this.effectsG.clear(), now, seen);
    this.drawEffects(visible);
    this.drawPlacement(state, camera);
    this.drawScreenOverlay(state);
  }

  private buildingVisible(e: Entity): boolean {
    const vis = this.world.visible[this.localPlayer];
    for (let y = e.ty; y < e.ty + e.h; y++) for (let x = e.tx; x < e.tx + e.w; x++) if (vis[y * this.world.w + x]) return true;
    return false;
  }

  /** Update what the local player remembers about enemy buildings. */
  private updateMemory() {
    const world = this.world;
    const me = this.localPlayer;
    for (const e of world.entities.values()) {
      if (e.kind === 'building' && !areAllies(world, e.owner, me) && this.buildingVisible(e)) {
        this.remembered.set(e.id, { id: e.id, owner: e.owner, type: e.type, tx: e.tx, ty: e.ty, w: e.w, h: e.h });
      }
    }
    // Forget buildings we can see are gone.
    for (const r of this.remembered.values()) {
      if (world.entities.has(r.id)) continue;
      const vis = world.visible[me];
      let seen = false;
      for (let y = r.ty; y < r.ty + r.h && !seen; y++) for (let x = r.tx; x < r.tx + r.w; x++) if (vis[y * world.w + x]) seen = true;
      if (seen) this.remembered.delete(r.id);
    }
  }

  private healthBar(g: Graphics, x: number, y: number, w: number, frac: number) {
    g.rect(x, y, w, 4).fill(0x000000);
    g.rect(x + 1, y + 1, Math.max(0, (w - 2) * frac), 2).fill(hpColor(frac));
  }

  /** Line from a producer's exit to its rally point, with a small flag there. */
  private rallyLine(g: Graphics, x0: number, y0: number, tx: number, ty: number) {
    const x1 = tx * TILE_PX + TILE_PX / 2;
    const y1 = ty * TILE_PX + TILE_PX / 2;
    g.moveTo(x0, y0).lineTo(x1, y1).stroke({ width: 1, color: COLORS.rally, alpha: 0.6 });
    g.moveTo(x1, y1).lineTo(x1, y1 - 12).stroke({ width: 1.5, color: 0xffffff });
    g.poly([x1, y1 - 12, x1 + 8, y1 - 9, x1, y1 - 6]).fill(COLORS.rally);
  }

  private brackets(g: Graphics, x: number, y: number, w: number, h: number) {
    const l = 8;
    const st = { width: 2, color: 0xffffff };
    g.moveTo(x, y + l).lineTo(x, y).lineTo(x + l, y).stroke(st);
    g.moveTo(x + w - l, y).lineTo(x + w, y).lineTo(x + w, y + l).stroke(st);
    g.moveTo(x, y + h - l).lineTo(x, y + h).lineTo(x + l, y + h).stroke(st);
    g.moveTo(x + w - l, y + h).lineTo(x + w, y + h).lineTo(x + w, y + h - l).stroke(st);
  }

  private drawEffects(visible: Uint8Array) {
    const now = performance.now();
    const g = this.effectsG;
    const w = this.world.w;
    this.effects = this.effects.filter((f) => now - f.born < f.life);
    for (const f of this.effects) {
      const t = (now - f.born) / f.life;
      const a = 1 - t;
      if (f.kind !== 'marker') {
        const tx = Math.floor(f.x0 / TILE_PX);
        const ty = Math.floor(f.y0 / TILE_PX);
        if (!visible[ty * w + tx]) continue;
      }
      switch (f.kind) {
        case 'shot':
          g.moveTo(f.x0, f.y0).lineTo(f.x1, f.y1).stroke({ width: 1, color: f.color, alpha: a });
          break;
        case 'shell':
          g.moveTo(f.x0, f.y0).lineTo(f.x1, f.y1).stroke({ width: 2, color: f.color, alpha: a * 0.8 });
          g.circle(f.x1, f.y1, 3 + t * 7).fill({ color: f.color, alpha: a * 0.6 });
          break;
        case 'marker': {
          const r = 10 * (1 - t) + 3;
          g.moveTo(f.x0 - r, f.y0 - r).lineTo(f.x0 + r, f.y0 + r).stroke({ width: 2, color: f.color, alpha: a });
          g.moveTo(f.x0 + r, f.y0 - r).lineTo(f.x0 - r, f.y0 + r).stroke({ width: 2, color: f.color, alpha: a });
          break;
        }
      }
    }
  }

  private drawPlacement(state: ClientState, camera: Camera) {
    if (!state.placing || !state.mouse.inside) return;
    const def = BUILDINGS[state.placing];
    const { tx, ty } = placementOrigin(state, camera, def.w, def.h);
    const ok = canPlace(this.world, state.localPlayer, state.placing, tx, ty);
    const g = this.overlay;
    for (let y = ty; y < ty + def.h; y++) {
      for (let x = tx; x < tx + def.w; x++) {
        const good = ok || tileBuildable(this.world, x, y);
        g.rect(x * TILE_PX + 1, y * TILE_PX + 1, TILE_PX - 2, TILE_PX - 2).fill({
          color: ok ? COLORS.valid : good ? 0xeab308 : COLORS.invalid,
          alpha: 0.4,
        });
      }
    }
    g.rect(tx * TILE_PX, ty * TILE_PX, def.w * TILE_PX, def.h * TILE_PX).stroke({ width: 2, color: ok ? COLORS.valid : COLORS.invalid });
  }

  private drawScreenOverlay(state: ClientState) {
    const g = this.screen.clear();
    const d = state.drag;
    if (!d) return;
    const x = Math.min(d.x0, d.x1);
    const y = Math.min(d.y0, d.y1);
    const w = Math.abs(d.x1 - d.x0);
    const h = Math.abs(d.y1 - d.y0);
    if (w < 4 && h < 4) return;
    g.rect(x, y, w, h).fill({ color: 0x22c55e, alpha: 0.08 }).stroke({ width: 1, color: 0x4ade80 });
  }

  private drawTerrain() {
    const world = this.world;
    const g = this.terrain.clear();
    const at = (x: number, y: number) => (x < 0 || y < 0 || x >= world.w || y >= world.h ? -1 : world.terrain[y * world.w + x]);
    const isRoad = (t: number) => t === Terrain.Road || t === Terrain.Bridge;
    const trees: [number, number, number, number][] = [];
    for (let y = 0; y < world.h; y++) {
      for (let x = 0; x < world.w; x++) {
        const i = y * world.w + x;
        const t = world.terrain[i];
        const px = x * TILE_PX;
        const py = y * TILE_PX;
        if (t === Terrain.Grass) {
          g.rect(px, py, TILE_PX, TILE_PX).fill(COLORS.grass[(x * 7 + y * 13 + ((x * y) % 5)) % 3]);
        } else if (t === Terrain.Rock) {
          g.rect(px, py, TILE_PX, TILE_PX).fill(COLORS.rock);
          const h = (x * 31 + y * 17) % 4;
          g.poly([px + 6 + h, py + 20, px + 14, py + 8 + h, px + 24 - h, py + 18]).fill(COLORS.rockEdge);
          // Cliff face: a shadow where the rock drops down to open ground below or to the right.
          const open = (t2: number) => t2 >= 0 && t2 !== Terrain.Rock;
          if (open(at(x, y + 1))) g.rect(px, py + TILE_PX - 6, TILE_PX, 6).fill(COLORS.rockShadow);
          if (open(at(x + 1, y))) g.rect(px + TILE_PX - 4, py, 4, TILE_PX).fill({ color: COLORS.rockShadow, alpha: 0.8 });
        } else if (t === Terrain.Water) {
          g.rect(px, py, TILE_PX, TILE_PX).fill(COLORS.water);
          if ((x + y * 3) % 4 === 0) g.moveTo(px + 6, py + 16).lineTo(px + 14, py + 13).lineTo(px + 22, py + 16).stroke({ width: 1, color: COLORS.waterEdge });
        } else if (t === Terrain.Bridge) {
          // Planks run across the direction of travel; rails along the sides facing water.
          const horizontal = isRoad(at(x - 1, y)) || isRoad(at(x + 1, y));
          g.rect(px, py, TILE_PX, TILE_PX).fill(COLORS.bridge);
          for (let k = 4; k < TILE_PX; k += 6) {
            if (horizontal) g.rect(px + k, py, 1.5, TILE_PX).fill(COLORS.bridgePlank);
            else g.rect(px, py + k, TILE_PX, 1.5).fill(COLORS.bridgePlank);
          }
          if (horizontal) {
            if (!isRoad(at(x, y - 1))) g.rect(px, py, TILE_PX, 3).fill(COLORS.bridgeRail);
            if (!isRoad(at(x, y + 1))) g.rect(px, py + TILE_PX - 3, TILE_PX, 3).fill(COLORS.bridgeRail);
          } else {
            if (!isRoad(at(x - 1, y))) g.rect(px, py, 3, TILE_PX).fill(COLORS.bridgeRail);
            if (!isRoad(at(x + 1, y))) g.rect(px + TILE_PX - 3, py, 3, TILE_PX).fill(COLORS.bridgeRail);
          }
        } else if (t === Terrain.Road) {
          g.rect(px, py, TILE_PX, TILE_PX).fill(COLORS.road);
          const edge = (x2: number, y2: number) => {
            const n = at(x2, y2);
            return n >= 0 && !isRoad(n);
          };
          if (edge(x, y - 1)) g.rect(px, py, TILE_PX, 2).fill(COLORS.roadEdge);
          if (edge(x, y + 1)) g.rect(px, py + TILE_PX - 2, TILE_PX, 2).fill(COLORS.roadEdge);
          if (edge(x - 1, y)) g.rect(px, py, 2, TILE_PX).fill(COLORS.roadEdge);
          if (edge(x + 1, y)) g.rect(px + TILE_PX - 2, py, 2, TILE_PX).fill(COLORS.roadEdge);
        } else if (t === Terrain.Forest) {
          g.rect(px, py, TILE_PX, TILE_PX).fill(COLORS.forestFloor);
          // A few trees per tile at stable pseudo-random spots, drawn after all floors so crowns overlap neighbours.
          const n = 2 + (i % 2);
          for (let k = 0; k < n; k++) {
            const hx = ((i * 53 + k * 97) % 89) / 89;
            const hy = ((i * 71 + k * 61) % 83) / 83;
            trees.push([px + 5 + hx * 22, py + 5 + hy * 22, 6 + ((i + k * 3) % 4), COLORS.canopy[(i + k) % 3]]);
          }
        }
      }
    }
    for (const [cx, cy, r] of trees) g.circle(cx + 1.5, cy + 2, r).fill({ color: 0x000000, alpha: 0.25 });
    for (const [cx, cy, r, c] of trees) g.circle(cx, cy, r).fill(c);
    // Faint grid.
    for (let x = 0; x <= world.w; x++) g.moveTo(x * TILE_PX, 0).lineTo(x * TILE_PX, world.h * TILE_PX);
    for (let y = 0; y <= world.h; y++) g.moveTo(0, y * TILE_PX).lineTo(world.w * TILE_PX, y * TILE_PX);
    g.stroke({ width: 1, color: COLORS.grid, alpha: 0.12 });
  }

  private drawOre() {
    const world = this.world;
    const cw = Math.ceil(world.w / ORE_CHUNK);
    const ch = Math.ceil(world.h / ORE_CHUNK);
    if (this.oreDots.length !== world.ore.length || this.oreChunks.length !== cw * ch) {
      for (const g of this.oreChunks) g.destroy();
      this.oreChunks = [];
      for (let i = 0; i < cw * ch; i++) this.oreChunks.push(this.ore.addChild(new Graphics()));
      this.oreDots = new Uint8Array(world.ore.length).fill(255);
    }
    const dirty = new Set<number>();
    for (let i = 0; i < world.ore.length; i++) {
      const amount = world.ore[i];
      const dots = amount ? Math.min(5, 1 + Math.floor(amount / 100)) : 0;
      if (dots === this.oreDots[i]) continue;
      this.oreDots[i] = dots;
      dirty.add(Math.floor(Math.floor(i / world.w) / ORE_CHUNK) * cw + Math.floor((i % world.w) / ORE_CHUNK));
    }
    for (const c of dirty) this.drawOreChunk(c % cw, Math.floor(c / cw), this.oreChunks[c]);
  }

  private drawOreChunk(cx: number, cy: number, g: Graphics) {
    const world = this.world;
    g.clear();
    for (let y = cy * ORE_CHUNK; y < Math.min(world.h, (cy + 1) * ORE_CHUNK); y++) {
      for (let x = cx * ORE_CHUNK; x < Math.min(world.w, (cx + 1) * ORE_CHUNK); x++) {
        const i = y * world.w + x;
        const dots = this.oreDots[i];
        const px = x * TILE_PX;
        const py = y * TILE_PX;
        for (let k = 0; k < dots; k++) {
          // Stable pseudo-random placement per tile.
          const hx = ((i * 73 + k * 151) % 97) / 97;
          const hy = ((i * 131 + k * 89) % 89) / 89;
          const r = 2.5 + (((i + k * 7) % 5) / 5) * 2.5;
          g.circle(px + 6 + hx * 20, py + 6 + hy * 20, r).fill(COLORS.ore).stroke({ width: 1, color: COLORS.oreDark });
        }
      }
    }
  }

  private updateFog() {
    const world = this.world;
    const vis = world.visible[this.localPlayer];
    const exp = world.explored[this.localPlayer];
    const data = this.fogImage.data;
    const fw = world.w + FOG_MARGIN * 2;
    for (let y = 0; y < world.h; y++) {
      const row = (y + FOG_MARGIN) * fw + FOG_MARGIN;
      for (let x = 0; x < world.w; x++) {
        const i = y * world.w + x;
        data[(row + x) * 4 + 3] = vis[i] ? 0 : exp[i] ? 140 : 255;
      }
    }
    this.fogCtx.putImageData(this.fogImage, 0, 0);
    this.fogTexture.source.update();
  }

  get canvas() {
    return this.app.canvas;
  }
}

/** Top-left tile for a building footprint centred on the mouse. */
export function placementOrigin(state: ClientState, camera: Camera, w: number, h: number) {
  const wx = state.mouse.x + camera.x;
  const wy = state.mouse.y + camera.y;
  return {
    tx: Math.floor(wx / TILE_PX - w / 2 + 0.5),
    ty: Math.floor(wy / TILE_PX - h / 2 + 0.5),
  };
}
