import type { Game } from '../game';
import { TEAM } from '../render/palette';
import { MAX_WALL_LINE } from '../sim/data/buildings';
import { BUILD_MENU, isBuildingType, itemBuildTicks, itemCost, itemName, itemPrereq, itemProgressTotal, queueKindOf } from '../sim/data/items';
import { canBuild, isLowPower, powerEfficiency } from '../sim/systems/production';
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
  private stats: HTMLDivElement;
  private sections: HTMLDivElement[] = [];
  private help: HTMLDivElement;
  /** Spectators only: whose view to show. */
  private spectate: HTMLDivElement;
  private viewSelect = document.createElement('select');
  private frame = 0;

  constructor(
    el: HTMLElement,
    private game: Game,
  ) {
    this.minimap = new Minimap(game);
    el.innerHTML = '';
    el.append(this.minimap.canvas);

    this.spectate = div('spectate');
    this.spectate.hidden = true;
    this.viewSelect.addEventListener('change', () => game.setView(Number(this.viewSelect.value)));
    this.spectate.append(labelled('Spectating', this.viewSelect));
    el.append(this.spectate);

    const stats = div('stats');
    this.stats = stats;
    this.credits = span('credits');
    const power = div('power');
    this.powerBar = div('power-fill');
    power.append(this.powerBar);
    this.powerText = span('power-text');
    stats.append(labelled('Credits', this.credits), power, this.powerText);
    el.append(stats);

    this.playerList = div('players');
    // Spectators click a player to see through their eyes.
    this.playerList.addEventListener('click', (ev) => {
      const row = (ev.target as HTMLElement).closest<HTMLElement>('[data-player]');
      if (row && game.spectator) game.setView(Number(row.dataset.player));
    });
    el.append(this.playerList);

    for (const kind of Object.keys(BUILD_MENU) as QueueKind[]) {
      const section = div('section');
      const h = document.createElement('h3');
      h.textContent = SECTION_TITLES[kind];
      const grid = div('grid');
      for (const item of BUILD_MENU[kind]) grid.append(this.makeButton(item));
      section.append(h, grid);
      el.append(section);
      this.sections.push(section);
    }

    this.info = div('info');
    el.append(this.info);

    this.help = div('help');
    el.append(this.help);
  }

  setWorld(world: World) {
    this.minimap.setWorld(world);
    const spectator = this.game.spectator;
    this.spectate.hidden = !spectator;
    this.viewSelect.innerHTML = '';
    if (spectator) {
      this.viewSelect.append(new Option('Whole map (0)', '-1'));
      world.players.forEach((_, i) => {
        const opt = new Option(`${this.game.players[i]?.name ?? `Player ${i + 1}`}${i < 9 ? ` (${i + 1})` : ''}`, String(i));
        opt.style.color = TEAM[i].css;
        this.viewSelect.append(opt);
      });
    }
    this.help.innerHTML = (
      spectator
        ? ['<b>0</b> whole map · <b>1–9</b> player view', 'or click a player above', '<b>LMB</b> select for info', '<b>WASD</b> / <b>arrows</b> / minimap to scroll']
        : ['<b>LMB</b> select / drag box, <b>Shift</b> add', '<b>RMB</b> move · attack · harvest', '<b>WASD</b> / <b>arrows</b> / minimap to scroll', '<b>RMB</b> on build item: cancel']
    ).join('<br>');
    this.playerList.innerHTML = '';
    this.playerList.hidden = world.players.length <= 2 && !this.game.online && !spectator;
    this.playerList.classList.toggle('pickable', spectator);
    this.setView();
  }

  /**
   * The view changed (spectators): the whole map hides one player's credits and
   * build menu; a player's view shows theirs, read-only.
   */
  setView() {
    const view = this.game.state.view;
    this.viewSelect.value = String(view);
    this.stats.hidden = view < 0;
    for (const s of this.sections) {
      s.hidden = view < 0;
      s.classList.toggle('readonly', this.game.spectator);
    }
    const color = TEAM[Math.max(0, view)].css;
    for (const b of this.buttons) b.icon.innerHTML = iconSvg(b.item, color);
    this.frame = 0;
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
    if (item === 'wall') el.title += ` per segment. Drag to lay up to ${MAX_WALL_LINE} in a line.`;
    el.addEventListener('click', () => this.onClick(item));
    el.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      if (this.game.spectator) return;
      this.game.send({ t: 'cancel', item });
      if (this.game.state.placing === item) this.game.state.placing = null;
    });
    this.buttons.push({ item, el, icon, progress, badge, status });
    return el;
  }

  private onClick(item: ItemType) {
    const game = this.game;
    if (game.spectator) return;
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
    const me = this.game.state.view;
    this.updateInfo();
    this.updatePlayers();
    this.minimap.draw();
    // Spectators' whole map view: no one player's credits or build menu.
    if (me < 0) return;
    const p = world.players[me];
    this.credits.textContent = String(p.credits);
    const total = Math.max(p.powerProduced, p.powerUsed, 1);
    this.powerBar.style.width = `${(p.powerUsed / total) * 100}%`;
    this.powerBar.classList.toggle('low', p.powerUsed > p.powerProduced);
    const low = isLowPower(p) ? (world.rules.power === 'full' ? ` — LOW (${powerEfficiency(world, p)}%)` : ' — LOW') : '';
    this.powerText.textContent = `Power ${p.powerUsed} / ${p.powerProduced}${low}`;

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
  }

  /** One row per player, grouped by team: colour, name, and whether they are still in it. */
  private updatePlayers() {
    if (this.playerList.hidden) return;
    const { world, players, connected } = this.game;
    const me = this.game.state.view;
    // Spectators' whole map view lists everyone's credits and power instead.
    const economy = me < 0;
    // Players without a lobby team have a solo team above every lobby team, so they sort last.
    const order = [...world.players].sort((a, b) => a.team - b.team || a.id - b.id);
    let lastTeam = -1;
    const html = order
      .map((p) => {
        const i = p.id;
        const info = players[i];
        let status = p.defeated ? 'out' : info?.ai ? 'AI' : connected[i] === false ? 'away' : '';
        if (economy && !p.defeated) status = `$${p.credits} · ⚡${p.powerUsed}/${p.powerProduced}${status ? ` · ${status}` : ''}`;
        const cls = ['player', p.defeated ? 'defeated' : '', i === me ? 'me' : '', economy && isLowPower(p) ? 'low' : ''].filter(Boolean).join(' ');
        const lobbyTeam = info?.team ?? 0;
        const yours = me >= 0 && p.team === world.players[me].team ? (this.game.spectator ? ' (viewing)' : ' (yours)') : '';
        const header = lobbyTeam && p.team !== lastTeam ? `<div class="team-header">Team ${lobbyTeam}${yours}</div>` : '';
        lastTeam = p.team;
        return `${header}<div class="${cls}" data-player="${i}"><i style="background:${TEAM[i].css}"></i><span>${escapeHtml(info?.name ?? `Player ${i + 1}`)}</span><em>${status}</em></div>`;
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
      let extra = e.type === 'harvester' ? ` · cargo ${e.cargo}${e.gemCargo ? ` (gems ${e.gemCargo})` : ''}` : '';
      if (e.kind === 'building' && buildingDef(e).category === 'defense' && isLowPower(world.players[e.owner])) extra = ' · offline (low power)';
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
  return isBuildingType(type as ItemType) ? itemName(type as ItemType) : type;
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
    wall: `<rect x="3" y="11" width="10" height="14" fill="#8a8d91" stroke="#55585c" stroke-width="1.5"/><rect x="13" y="11" width="10" height="14" fill="#8a8d91" stroke="#55585c" stroke-width="1.5"/><rect x="23" y="11" width="10" height="14" fill="#8a8d91" stroke="#55585c" stroke-width="1.5"/><rect x="16" y="16" width="4" height="4" fill="${color}"/>`,
    pillbox: `<path d="M12 4 H24 L32 12 V24 L24 32 H12 L4 24 V12 Z" fill="#8a8d91" stroke="${color}" stroke-width="2"/><circle cx="18" cy="18" r="8" fill="#55585c"/><line x1="18" y1="18" x2="33" y2="18" stroke="#111" stroke-width="2.5"/><circle cx="18" cy="18" r="3" fill="${color}"/>`,
    turret: `<rect x="3" y="3" width="30" height="30" fill="#8a8d91" stroke="#55585c" stroke-width="1.5"/><line x1="18" y1="18" x2="35" y2="18" stroke="#111" stroke-width="4"/><circle cx="18" cy="18" r="9" fill="#1f2937" stroke="${color}" stroke-width="2"/>`,
    rifleman: `<line x1="18" y1="18" x2="30" y2="10" stroke="#111" stroke-width="3"/><circle cx="18" cy="18" r="8" fill="${color}" stroke="#111" stroke-width="2"/>`,
    jeep: `<rect x="8" y="6" width="7" height="4" fill="#222"/><rect x="21" y="6" width="7" height="4" fill="#222"/><rect x="8" y="26" width="7" height="4" fill="#222"/><rect x="21" y="26" width="7" height="4" fill="#222"/><path d="M5 9 H27 L31 13 V23 L27 27 H5 Z" fill="#1f2937" stroke="${color}" stroke-width="2"/><rect x="22" y="11" width="3" height="14" fill="#9fb4c7"/><line x1="14" y1="18" x2="30" y2="18" stroke="#111" stroke-width="2"/><circle cx="14" cy="18" r="4" fill="${color}"/>`,
    tank: `<rect x="4" y="9" width="28" height="18" fill="#1f2937" stroke="${color}" stroke-width="2"/><line x1="18" y1="18" x2="34" y2="18" stroke="#111" stroke-width="4"/><circle cx="18" cy="18" r="6" fill="${color}"/>`,
    harvester: `<path d="M34 18 L18 5 L2 18 L18 31 Z" fill="#1f2937" stroke="${color}" stroke-width="2"/><rect x="11" y="14" width="14" height="8" fill="#e0a82e"/>`,
  };
  return `<svg viewBox="0 0 36 36" width="36" height="36">${shapes[item] ?? ''}</svg>`;
}
