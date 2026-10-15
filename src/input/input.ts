import { TILE_PX } from '../client';
import type { Game } from '../game';
import { placementOrigin } from '../render/renderer';
import { BUILDINGS } from '../sim/data/buildings';
import { PRODUCER } from '../sim/data/items';
import { canPlace, wallLine } from '../sim/systems/construction';
import { TILE, type Entity } from '../sim/types';
import { areAllies, unitDef } from '../sim/world';

const S = TILE_PX / TILE;
const DRAG_THRESHOLD = 5;
/** Physical key codes (layout-independent), so WASD works on AZERTY etc. too. */
const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'KeyW', 'KeyA', 'KeyS', 'KeyD']);

/** Turns mouse and keyboard input into selection changes and sim commands. */
export class Input {
  /** Scroll keys currently held, as KeyboardEvent.code values. */
  readonly keys = new Set<string>();
  private dragStart: { x: number; y: number } | null = null;
  private lastClick = { time: 0, id: 0 };
  private lastRecall = { time: 0, n: 0 };

  constructor(
    private el: HTMLElement,
    private game: Game,
  ) {
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener('mousedown', (e) => this.onDown(e));
    window.addEventListener('mousemove', (e) => this.onMove(e));
    window.addEventListener('mouseup', (e) => this.onUp(e));
    // Take the position from the event too: when an overlay (the start menu)
    // disappears under a still pointer, mouseenter fires without a mousemove,
    // and a stale position would put the placement ghost and cursor in the wrong spot.
    el.addEventListener('mouseenter', (e) => {
      const m = this.game.state.mouse;
      Object.assign(m, this.local(e), { inside: true });
    });
    el.addEventListener('mouseleave', () => (this.game.state.mouse.inside = false));
    window.addEventListener('keydown', (e) => this.onKey(e));
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
  }

  private get state() {
    return this.game.state;
  }

  private local(e: MouseEvent) {
    const r = this.el.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private toWorldPx(p: { x: number; y: number }) {
    return { x: p.x + this.game.camera.x, y: p.y + this.game.camera.y };
  }

  private onDown(ev: MouseEvent) {
    if (!this.game.world) return;
    const p = this.local(ev);
    const st = this.state;
    if (ev.button === 1) {
      // No middle-drag scrolling; just keep the browser's autoscroll from kicking in.
      ev.preventDefault();
      return;
    }
    if (ev.button === 2) {
      if (st.placing) {
        st.placing = null;
        st.wallStart = null;
      }
      else this.contextCommand(p);
      return;
    }
    if (ev.button !== 0) return;
    if (st.placing === 'wall') {
      // Walls are dragged out as a line and placed on release.
      st.wallStart = placementOrigin(st, this.game.camera, 1, 1);
      return;
    }
    if (st.placing) {
      this.tryPlace();
      return;
    }
    this.dragStart = p;
    st.drag = { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
  }

  private onMove(ev: MouseEvent) {
    const p = this.local(ev);
    const st = this.state;
    st.mouse.x = p.x;
    st.mouse.y = p.y;
    if (st.drag) {
      st.drag.x1 = p.x;
      st.drag.y1 = p.y;
    }
    if (this.game.world) this.updateCursor();
  }

  private onUp(ev: MouseEvent) {
    if (ev.button === 0 && this.state.wallStart) {
      this.placeWall();
      return;
    }
    if (ev.button !== 0 || !this.dragStart || !this.state.drag) return;
    const d = this.state.drag;
    this.state.drag = null;
    this.dragStart = null;
    const additive = ev.shiftKey;
    if (Math.abs(d.x1 - d.x0) > DRAG_THRESHOLD || Math.abs(d.y1 - d.y0) > DRAG_THRESHOLD) {
      this.boxSelect(d, additive);
    } else {
      this.clickSelect({ x: d.x1, y: d.y1 }, additive);
    }
  }

  /**
   * Scrolling (arrows / WASD, see Camera.update) and control groups:
   * Ctrl or Shift + 1–9 saves the selection (browsers may keep Ctrl+digit for
   * tab switching, hence Shift), 1–9 recalls it, pressing it twice centers the view.
   * Online, Enter opens the chat (Shift+Enter: allies only).
   * Spectators have no groups: 0 shows the whole map, 1–9 that player's view.
   */
  private onKey(ev: KeyboardEvent) {
    if (ev.target instanceof HTMLInputElement || ev.target instanceof HTMLSelectElement || !this.game.world) return;
    if (ev.code === 'Enter' || ev.code === 'NumpadEnter') {
      if (!this.game.online || ev.repeat) return;
      ev.preventDefault();
      // Stop scrolling while typing.
      this.keys.clear();
      this.game.openChat(ev.shiftKey);
      return;
    }
    if (this.game.spectator) {
      const d = /^Digit([0-9])$/.exec(ev.code);
      if (d && !ev.altKey && !ev.metaKey && !ev.ctrlKey) {
        ev.preventDefault();
        const n = Number(d[1]);
        if (!ev.repeat && n <= this.game.world.players.length) this.game.setView(n - 1);
        return;
      }
    }
    const digit = /^Digit([1-9])$/.exec(ev.code);
    if (digit) {
      if (ev.altKey || ev.metaKey) return;
      ev.preventDefault();
      if (ev.repeat) return;
      const n = Number(digit[1]);
      if (ev.ctrlKey || ev.shiftKey) this.saveGroup(n);
      else this.recallGroup(n);
      return;
    }
    if (!SCROLL_KEYS.has(ev.code)) return;
    ev.preventDefault();
    this.keys.add(ev.code);
  }

  private saveGroup(n: number) {
    const st = this.state;
    const ents = this.game.world.entities;
    const ids = [...st.selection].filter((id) => ents.get(id)?.owner === st.localPlayer);
    if (ids.length) st.groups.set(n, new Set(ids));
    else st.groups.delete(n);
  }

  private recallGroup(n: number) {
    const st = this.state;
    const group = st.groups.get(n);
    if (!group?.size) return;
    st.selection.clear();
    for (const id of group) st.selection.add(id);
    const now = performance.now();
    if (this.lastRecall.n === n && now - this.lastRecall.time < 350) {
      // Double-tap: center the view on the group.
      let x = 0;
      let y = 0;
      let count = 0;
      for (const id of group) {
        const e = this.game.world.entities.get(id);
        if (!e) continue;
        x += e.x;
        y += e.y;
        count++;
      }
      if (count) this.game.camera.centerOn((x / count) * S, (y / count) * S);
      this.lastRecall = { time: 0, n: 0 };
      return;
    }
    this.lastRecall = { time: now, n };
  }

  selectedOwnUnits(): Entity[] {
    const out: Entity[] = [];
    for (const id of this.state.selection) {
      const e = this.game.world.entities.get(id);
      if (e && e.kind === 'unit' && e.owner === this.state.localPlayer) out.push(e);
    }
    return out;
  }

  /** Selected own buildings that can have a rally point. */
  selectedOwnProducers(): Entity[] {
    const out: Entity[] = [];
    for (const id of this.state.selection) {
      const e = this.game.world.entities.get(id);
      if (e && e.owner === this.state.localPlayer && (e.type === PRODUCER.infantry || e.type === PRODUCER.vehicle)) out.push(e);
    }
    return out;
  }

  /** Entity under a viewport point, respecting the fog of the player whose view is shown. */
  pick(p: { x: number; y: number }): Entity | null {
    const world = this.game.world;
    const me = this.state.view;
    const w = this.toWorldPx(p);
    let best: Entity | null = null;
    let bestD = Infinity;
    for (const e of world.entities.values()) {
      if (e.kind !== 'unit') continue;
      if (me >= 0 && e.owner !== me && !world.visible[me][Math.floor(e.y / TILE) * world.w + Math.floor(e.x / TILE)]) continue;
      const r = unitDef(e).radius * S + 5;
      const d = (e.x * S - w.x) ** 2 + (e.y * S - w.y) ** 2;
      if (d < r * r && d < bestD) {
        best = e;
        bestD = d;
      }
    }
    if (best) return best;
    const tx = Math.floor(w.x / TILE_PX);
    const ty = Math.floor(w.y / TILE_PX);
    if (tx < 0 || ty < 0 || tx >= world.w || ty >= world.h) return null;
    const id = world.buildingAt[ty * world.w + tx];
    if (!id) return null;
    const b = world.entities.get(id)!;
    if (me >= 0 && b.owner !== me && !world.explored[me][ty * world.w + tx]) return null;
    return b;
  }

  private clickSelect(p: { x: number; y: number }, additive: boolean) {
    const st = this.state;
    const e = this.pick(p);
    if (!additive) st.selection.clear();
    if (!e) return;
    const now = performance.now();
    if (e.kind === 'unit' && e.owner === st.localPlayer && this.lastClick.id === e.id && now - this.lastClick.time < 350) {
      // Double-click: all own units of this type on screen.
      this.boxSelect({ x0: 0, y0: 0, x1: this.game.camera.viewW, y1: this.game.camera.viewH }, true, e.type);
      return;
    }
    this.lastClick = { time: now, id: e.id };
    if (additive && st.selection.has(e.id)) st.selection.delete(e.id);
    else st.selection.add(e.id);
  }

  private boxSelect(d: { x0: number; y0: number; x1: number; y1: number }, additive: boolean, type?: string) {
    const st = this.state;
    const a = this.toWorldPx({ x: Math.min(d.x0, d.x1), y: Math.min(d.y0, d.y1) });
    const b = this.toWorldPx({ x: Math.max(d.x0, d.x1), y: Math.max(d.y0, d.y1) });
    const found: number[] = [];
    for (const e of this.game.world.entities.values()) {
      if (e.kind !== 'unit' || e.owner !== st.localPlayer) continue;
      if (type && e.type !== type) continue;
      const x = e.x * S;
      const y = e.y * S;
      if (x >= a.x && x <= b.x && y >= a.y && y <= b.y) found.push(e.id);
    }
    if (!additive) st.selection.clear();
    for (const id of found) st.selection.add(id);
  }

  /**
   * Right-click: move, attack, harvest or dock depending on what's under the cursor.
   * Selected barracks and factories get their rally point set.
   */
  private contextCommand(p: { x: number; y: number }) {
    const st = this.state;
    const world = this.game.world;
    const units = this.selectedOwnUnits();
    const producers = this.selectedOwnProducers();
    if (!units.length && !producers.length) {
      st.selection.clear();
      return;
    }
    const w = this.toWorldPx(p);
    const tx = Math.floor(w.x / TILE_PX);
    const ty = Math.floor(w.y / TILE_PX);
    if (tx < 0 || ty < 0 || tx >= world.w || ty >= world.h) return;
    if (producers.length) {
      this.game.send({ t: 'rally', ids: producers.map((e) => e.id), x: tx, y: ty });
      if (!units.length) this.game.renderer.marker(tx, ty, 0x38bdf8);
    }
    if (!units.length) return;
    const ids = units.map((e) => e.id);
    const target = this.pick(p);

    if (target && !areAllies(world, target.owner, st.localPlayer)) {
      this.game.send({ t: 'attack', ids, target: target.id });
      this.game.renderer.marker(tx, ty, 0xef4444);
      return;
    }
    const harvesters = units.filter((e) => e.type === 'harvester');
    if (target && target.type === 'refinery' && harvesters.length) {
      this.game.send({ t: 'dock', ids: harvesters.map((e) => e.id), refinery: target.id });
      return;
    }
    if (harvesters.length && world.ore[ty * world.w + tx] > 0 && world.explored[st.localPlayer][ty * world.w + tx]) {
      this.game.send({ t: 'harvest', ids, x: tx, y: ty });
      this.game.renderer.marker(tx, ty, 0xeab308);
      return;
    }
    this.issueMove('move', tx, ty);
  }

  private issueMove(kind: 'move' | 'attackMove', tx: number, ty: number) {
    const ids = this.selectedOwnUnits().map((e) => e.id);
    if (!ids.length) return;
    this.game.send({ t: kind, ids, x: tx, y: ty });
    this.game.renderer.marker(tx, ty, kind === 'move' ? 0x4ade80 : 0xf97316);
  }

  private tryPlace() {
    const st = this.state;
    if (!st.placing) return;
    const def = BUILDINGS[st.placing];
    const { tx, ty } = placementOrigin(st, this.game.camera, def.w, def.h);
    if (!canPlace(this.game.world, st.localPlayer, st.placing, tx, ty)) return;
    this.game.send({ t: 'place', item: st.placing, x: tx, y: ty });
    st.placing = null;
  }

  private placeWall() {
    const st = this.state;
    const start = st.wallStart!;
    st.wallStart = null;
    if (st.placing !== 'wall') return;
    const { tx, ty } = placementOrigin(st, this.game.camera, 1, 1);
    const p = this.game.world.players[st.localPlayer];
    if (wallLine(this.game.world, st.localPlayer, start.tx, start.ty, tx, ty, p.credits).length === 0) return;
    this.game.send({ t: 'place', item: 'wall', x: start.tx, y: start.ty, x2: tx, y2: ty });
    st.placing = null;
  }

  private updateCursor() {
    const st = this.state;
    let cursor = 'default';
    if (st.placing) cursor = 'cell';
    else if (this.selectedOwnUnits().length || this.selectedOwnProducers().length) {
      const t = this.pick(st.mouse);
      if (t && !areAllies(this.game.world, t.owner, st.localPlayer) && this.selectedOwnUnits().length) cursor = 'crosshair';
      else cursor = 'pointer';
    }
    if (this.el.style.cursor !== cursor) this.el.style.cursor = cursor;
  }

  /** Remove dead entities from the selection and control groups. */
  prune() {
    const ents = this.game.world.entities;
    for (const id of this.state.selection) if (!ents.has(id)) this.state.selection.delete(id);
    for (const [n, group] of this.state.groups) {
      for (const id of group) if (!ents.has(id)) group.delete(id);
      if (!group.size) this.state.groups.delete(n);
    }
  }
}
