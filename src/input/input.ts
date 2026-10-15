import { TILE_PX } from '../client';
import type { Game } from '../game';
import { placementOrigin } from '../render/renderer';
import { BUILDINGS } from '../sim/data/buildings';
import { canPlace } from '../sim/systems/construction';
import { TILE, type Entity } from '../sim/types';
import { unitDef } from '../sim/world';

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
      if (st.placing) st.placing = null;
      else this.contextCommand(p);
      return;
    }
    if (ev.button !== 0) return;
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
   */
  private onKey(ev: KeyboardEvent) {
    if (ev.target instanceof HTMLInputElement || ev.target instanceof HTMLSelectElement || !this.game.world) return;
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

  /** Entity under a viewport point, respecting fog. */
  pick(p: { x: number; y: number }): Entity | null {
    const world = this.game.world;
    const me = this.state.localPlayer;
    const w = this.toWorldPx(p);
    let best: Entity | null = null;
    let bestD = Infinity;
    for (const e of world.entities.values()) {
      if (e.kind !== 'unit') continue;
      if (e.owner !== me && !world.visible[me][Math.floor(e.y / TILE) * world.w + Math.floor(e.x / TILE)]) continue;
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
    if (b.owner !== me && !world.explored[me][ty * world.w + tx]) return null;
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

  /** Right-click: move, attack, harvest or dock depending on what's under the cursor. */
  private contextCommand(p: { x: number; y: number }) {
    const st = this.state;
    const world = this.game.world;
    const units = this.selectedOwnUnits();
    if (!units.length) {
      st.selection.clear();
      return;
    }
    const ids = units.map((e) => e.id);
    const target = this.pick(p);
    const w = this.toWorldPx(p);
    const tx = Math.floor(w.x / TILE_PX);
    const ty = Math.floor(w.y / TILE_PX);
    if (tx < 0 || ty < 0 || tx >= world.w || ty >= world.h) return;

    if (target && target.owner !== st.localPlayer) {
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

  private updateCursor() {
    const st = this.state;
    let cursor = 'default';
    if (st.placing) cursor = 'cell';
    else if (this.selectedOwnUnits().length) {
      const t = this.pick(st.mouse);
      if (t && t.owner !== st.localPlayer) cursor = 'crosshair';
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
