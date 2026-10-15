import type { Game } from '../game';
import { TEAM } from '../render/palette';
import { BUILD_MENU, isBuildingType, itemBuildTicks, itemCost, itemName, itemPrereq, itemProgressTotal, queueKindOf } from '../sim/data/items';
import { canBuild } from '../sim/systems/production';
import type { ItemType, QueueKind, World } from '../sim/types';
import { buildingDef, unitDef } from '../sim/world';
import { Minimap } from './minimap';

const SECTION_TITLES: Record<QueueKind, string> = {
  building: 'Structures',
  infantry: 'Infantry',
  vehicle: 'Vehicles',
};

interface ItemButton {
  item: ItemType;
  el: HTMLButtonElement;
  icon: HTMLDivElement;
  progress: HTMLDivElement;
  badge: HTMLSpanElement;
  status: HTMLSpanElement;
}

/** HTML sidebar: credits, power, build menu, selection info, minimap. */
export class Sidebar {
  private minimap: Minimap;
  private credits: HTMLSpanElement;
  private powerBar: HTMLDivElement;
  private powerText: HTMLSpanElement;
  private buttons: ItemButton[] = [];
  private info: HTMLDivElement;
  private playerList: HTMLDivElement;
  private frame = 0;

  constructor(
    el: HTMLElement,
    private game: Game,
  ) {
    this.minimap = new Minimap(game);
    el.innerHTML = '';
    el.append(this.minimap.canvas);

    const stats = div('stats');
    this.credits = span('credits');
    const power = div('power');
    this.powerBar = div('power-fill');
    power.append(this.powerBar);
    this.powerText = span('power-text');
    stats.append(labelled('Credits', this.credits), power, this.powerText);
    el.append(stats);

    this.playerList = div('players');
    el.append(this.playerList);

    for (const kind of Object.keys(BUILD_MENU) as QueueKind[]) {
      const section = div('section');
      const h = document.createElement('h3');
      h.textContent = SECTION_TITLES[kind];
      const grid = div('grid');
      for (const item of BUILD_MENU[kind]) grid.append(this.makeButton(item));
      section.append(h, grid);
      el.append(section);
    }

    this.info = div('info');
    el.append(this.info);

    const help = div('help');
    help.innerHTML = [
      '<b>LMB</b> select / drag box, <b>Shift</b> add',
      '<b>RMB</b> move · attack · harvest',
      '<b>WASD</b> / <b>arrows</b> / minimap to scroll',
      '<b>RMB</b> on build item: cancel',
    ].join('<br>');
    el.append(help);
  }

  setWorld(world: World) {
    this.minimap.setWorld(world);
    const color = TEAM[this.game.state.localPlayer].css;
    for (const b of this.buttons) b.icon.innerHTML = iconSvg(b.item, color);
    this.playerList.innerHTML = '';
    this.playerList.hidden = world.players.length <= 2 && !this.game.online;
  }

  private makeButton(item: ItemType): HTMLButtonElement {
    const el = document.createElement('button');
    el.className = 'item';
    const icon = div('icon');
    const name = span('name');
    name.textContent = itemName(item);
    const cost = span('cost');
    cost.textContent = `$${itemCost(item)}`;
    const progress = div('progress');
    const badge = span('badge');
    const status = span('status');
    el.append(progress, icon, name, cost, badge, status);
    el.title = `${itemName(item)} — $${itemCost(item)}, ${Math.round(itemBuildTicks(item) / 20)}s`;
    el.addEventListener('click', () => this.onClick(item));
    el.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      this.game.send({ t: 'cancel', item });
      if (this.game.state.placing === item) this.game.state.placing = null;
    });
    this.buttons.push({ item, el, icon, progress, badge, status });
    return el;
  }

  private onClick(item: ItemType) {
    const game = this.game;
    const p = game.world.players[game.state.localPlayer];
    if (isBuildingType(item)) {
      const q = p.queues.building;
      if (q.ready && q.items[0] === item) {
        game.state.placing = item;
        return;
      }
      if (q.items.length) return;
    }
    game.send({ t: 'build', item });
  }

  update() {
    // DOM updates at ~15 Hz are plenty.
    if (this.frame++ % 4 !== 0) return;
    const world = this.game.world;
    const me = this.game.state.localPlayer;
    const p = world.players[me];
    this.credits.textContent = String(p.credits);
    const total = Math.max(p.powerProduced, p.powerUsed, 1);
    this.powerBar.style.width = `${(p.powerUsed / total) * 100}%`;
    this.powerBar.classList.toggle('low', p.powerUsed > p.powerProduced);
    this.powerText.textContent = `Power ${p.powerUsed} / ${p.powerProduced}${p.powerUsed > p.powerProduced ? ' — LOW' : ''}`;

    for (const b of this.buttons) {
      const q = p.queues[queueKindOf(b.item)];
      const available = canBuild(world, me, b.item);
      const count = q.items.filter((i) => i === b.item).length;
      const active = q.items[0] === b.item;
      const busyOther = isBuildingType(b.item) && q.items.length > 0 && !active;
      b.el.disabled = !available || busyOther;
      b.el.classList.toggle('locked', !available);
      b.el.classList.toggle('placing', this.game.state.placing === b.item);
      const frac = active ? q.progress / itemProgressTotal(b.item) : 0;
      b.progress.style.height = `${(1 - frac) * 100}%`;
      b.progress.style.display = active ? 'block' : 'none';
      b.badge.textContent = count > 1 ? String(count) : '';
      let status = '';
      if (!available) status = `Needs ${itemPrereq(b.item).map((r) => shortName(r)).join(', ') || 'yard'}`;
      else if (active && q.ready) status = 'READY';
      else if (active && q.progress === 0 && p.credits === 0) status = 'No funds';
      b.status.textContent = status;
      b.el.classList.toggle('ready', active && q.ready);
    }

    this.updateInfo();
    this.updatePlayers();
    this.minimap.draw();
  }

  /** One row per player, grouped by team: colour, name, and whether they are still in it. */
  private updatePlayers() {
    if (this.playerList.hidden) return;
    const { world, players, connected } = this.game;
    const me = this.game.state.localPlayer;
    // Players without a lobby team have a solo team above every lobby team, so they sort last.
    const order = [...world.players].sort((a, b) => a.team - b.team || a.id - b.id);
    let lastTeam = -1;
    const html = order
      .map((p) => {
        const i = p.id;
        const info = players[i];
        const status = p.defeated ? 'out' : info?.ai ? 'AI' : connected[i] === false ? 'away' : '';
        const cls = ['player', p.defeated ? 'defeated' : '', i === me ? 'me' : ''].filter(Boolean).join(' ');
        const lobbyTeam = info?.team ?? 0;
        const header = lobbyTeam && p.team !== lastTeam ? `<div class="team-header">Team ${lobbyTeam}${p.team === world.players[me].team ? ' (yours)' : ''}</div>` : '';
        lastTeam = p.team;
        return `${header}<div class="${cls}"><i style="background:${TEAM[i].css}"></i><span>${escapeHtml(info?.name ?? `Player ${i + 1}`)}</span><em>${status}</em></div>`;
      })
      .join('');
    if (this.playerList.innerHTML !== html) this.playerList.innerHTML = html;
  }

  private updateInfo() {
    const world = this.game.world;
    const sel = [...this.game.state.selection].map((id) => world.entities.get(id)).filter((e) => !!e);
    if (sel.length === 0) {
      this.info.textContent = '';
      return;
    }
    if (sel.length === 1) {
      const e = sel[0];
      const name = e.kind === 'building' ? buildingDef(e).name : unitDef(e).name;
      const extra = e.type === 'harvester' ? ` · cargo ${e.cargo}` : '';
      this.info.textContent = `${name} — ${e.hp}/${e.maxHp} HP${extra}`;
      return;
    }
    const counts = new Map<string, number>();
    for (const e of sel) {
      const n = e.kind === 'building' ? buildingDef(e).name : unitDef(e).name;
      counts.set(n, (counts.get(n) ?? 0) + 1);
    }
    this.info.textContent = [...counts].map(([n, c]) => `${c}× ${n}`).join(', ');
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function shortName(type: string): string {
  return type in { cy: 1, power: 1, refinery: 1, barracks: 1, factory: 1 } ? itemName(type as ItemType) : type;
}

function div(cls: string) {
  const d = document.createElement('div');
  d.className = cls;
  return d;
}

function span(cls: string) {
  const s = document.createElement('span');
  s.className = cls;
  return s;
}

function labelled(label: string, value: HTMLElement) {
  const d = div('labelled');
  const l = span('label');
  l.textContent = label;
  d.append(l, value);
  return d;
}

/** Small SVG icons matching the in-game shapes. */
function iconSvg(item: ItemType, color: string): string {
  const shapes: Record<string, string> = {
    power: `<rect x="3" y="3" width="30" height="30" fill="#2b2f36" stroke="${color}" stroke-width="2"/><circle cx="12" cy="12" r="6" fill="none" stroke="${color}" stroke-width="2"/><circle cx="24" cy="24" r="6" fill="none" stroke="${color}" stroke-width="2"/><path d="M20 8 L14 18 H18 L16 28 L22 16 H18 Z" fill="#fde047"/>`,
    refinery: `<rect x="2" y="7" width="32" height="22" fill="#2b2f36" stroke="${color}" stroke-width="2"/><circle cx="12" cy="17" r="7" fill="none" stroke="${color}" stroke-width="2"/><circle cx="12" cy="17" r="3" fill="#e0a82e"/><rect x="14" y="26" width="8" height="2" fill="#e0a82e"/>`,
    barracks: `<rect x="3" y="3" width="30" height="30" fill="#2b2f36" stroke="${color}" stroke-width="2"/><path d="M7 27 L18 8 L29 27 Z" fill="none" stroke="${color}" stroke-width="2"/>`,
    factory: `<rect x="2" y="2" width="32" height="32" fill="#2b2f36" stroke="${color}" stroke-width="2"/><rect x="8" y="17" width="20" height="13" fill="#111"/><path d="M9 20 H27 M9 24 H27 M9 28 H27" stroke="${color}" stroke-width="1.5"/>`,
    rifleman: `<line x1="18" y1="18" x2="30" y2="10" stroke="#111" stroke-width="3"/><circle cx="18" cy="18" r="8" fill="${color}" stroke="#111" stroke-width="2"/>`,
    jeep: `<rect x="8" y="6" width="7" height="4" fill="#222"/><rect x="21" y="6" width="7" height="4" fill="#222"/><rect x="8" y="26" width="7" height="4" fill="#222"/><rect x="21" y="26" width="7" height="4" fill="#222"/><path d="M5 9 H27 L31 13 V23 L27 27 H5 Z" fill="#1f2937" stroke="${color}" stroke-width="2"/><rect x="22" y="11" width="3" height="14" fill="#9fb4c7"/><line x1="14" y1="18" x2="30" y2="18" stroke="#111" stroke-width="2"/><circle cx="14" cy="18" r="4" fill="${color}"/>`,
    tank: `<rect x="4" y="9" width="28" height="18" fill="#1f2937" stroke="${color}" stroke-width="2"/><line x1="18" y1="18" x2="34" y2="18" stroke="#111" stroke-width="4"/><circle cx="18" cy="18" r="6" fill="${color}"/>`,
    harvester: `<path d="M34 18 L18 5 L2 18 L18 31 Z" fill="#1f2937" stroke="${color}" stroke-width="2"/><rect x="11" y="14" width="14" height="8" fill="#e0a82e"/>`,
  };
  return `<svg viewBox="0 0 36 36" width="36" height="36">${shapes[item] ?? ''}</svg>`;
}
