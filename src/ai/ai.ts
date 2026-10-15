import type { CommandTransport } from '../net/transport';
import { BUILDINGS } from '../sim/data/buildings';
import { itemCost } from '../sim/data/items';
import { canPlace } from '../sim/systems/construction';
import { canBuild, isLowPower } from '../sim/systems/production';
import { TILE, type BuildingType, type Entity, type World } from '../sim/types';
import { bfsFind } from '../sim/pathfinding';
import { areAllies, countBuildings, isWall, tileOf, unitDef, weaponOf } from '../sim/world';

const BUILD_ORDER: BuildingType[] = ['power', 'refinery', 'barracks', 'power', 'factory', 'pillbox', 'turret', 'power', 'refinery', 'power', 'barracks'];

/** Ticks past the wave time after which the AI attacks with whatever it has. */
const WAVE_PATIENCE = 1800;
/** Units below this health percentage fall back home and no longer join waves. */
const RETREAT_HP = 35;
/** A wave down to fewer than this percentage of the units it set out with falls back. */
const WAVE_COLLAPSE = 40;
/** Tiles from the construction yard to the staging point, towards the enemy. */
const STAGING_DIST = 7;
/** A marching wave regroups once a unit is this many tiles from its centre. */
const REGROUP_SPREAD = 8;
/** Give up waiting for stragglers after this many ticks. */
const REGROUP_TIMEOUT = 300;
/** Tanks go after visible enemy harvesters within this many tiles of the wave. */
const HARVESTER_HUNT = 12;

const healthy = (e: Entity) => e.hp * 100 >= e.maxHp * RETREAT_HP;
const near = (e: Entity, at: { x: number; y: number }, tiles: number) =>
  (e.x / TILE - at.x - 0.5) ** 2 + (e.y / TILE - at.y - 0.5) ** 2 <= tiles * tiles;

/**
 * A simple scripted opponent. It only reads the world and issues commands
 * through the transport, exactly like a human player.
 */
export class AIController {
  private waveSize = 6;
  /** The army out attacking: who is in it, how many set out, and when to stop waiting for stragglers (-1 if not regrouping). */
  private wave: { ids: Set<number>; launched: number; regroupUntil: number } | null = null;
  private nextWaveTick = 1200;

  constructor(
    readonly player: number,
    private transport: CommandTransport,
  ) {}

  update(world: World): void {
    if ((world.tick + this.player * 5) % 10 !== 0) return;
    const me = world.players[this.player];
    if (me.defeated || world.winner >= 0) return;

    this.manageBase(world);
    this.manageUnits(world);
    this.manageArmy(world);
  }

  private send(cmd: Parameters<CommandTransport['send']>[1]) {
    this.transport.send(this.player, cmd);
  }

  private manageBase(world: World) {
    const me = world.players[this.player];
    const q = me.queues.building;
    if (q.ready) {
      const type = q.items[0] as BuildingType;
      const spot = this.findSpot(world, type);
      if (spot) this.send({ t: 'place', item: type, x: spot.x, y: spot.y });
      else this.send({ t: 'cancel', item: type });
      return;
    }
    if (q.items.length) return;

    let next: BuildingType | null = null;
    if (isLowPower(me) || me.powerProduced - me.powerUsed < 10) next = 'power';
    else {
      const counts: Partial<Record<BuildingType, number>> = {};
      for (const b of BUILD_ORDER) {
        counts[b] = (counts[b] ?? 0) + 1;
        if (countBuildings(world, this.player, b) < counts[b]!) {
          next = b;
          break;
        }
      }
    }
    if (next && canBuild(world, this.player, next) && me.credits >= itemCost(next) / 3) {
      this.send({ t: 'build', item: next });
    }
  }

  private manageUnits(world: World) {
    const me = world.players[this.player];
    let harvesters = 0;
    let jeeps = 0;
    for (const e of world.entities.values()) {
      if (e.owner !== this.player) continue;
      if (e.type === 'harvester') harvesters++;
      else if (e.type === 'jeep') jeeps++;
    }
    const refineries = countBuildings(world, this.player, 'refinery');
    const wantHarv = Math.min(refineries * 2, 4);

    const vq = me.queues.vehicle;
    if (vq.items.length === 0 && canBuild(world, this.player, 'harvester')) {
      if (harvesters < wantHarv) this.send({ t: 'build', item: 'harvester' });
      else if (jeeps === 0 && me.credits > 400) this.send({ t: 'build', item: 'jeep' });
      else if (me.credits > 700) this.send({ t: 'build', item: 'tank' });
    }
    const iq = me.queues.infantry;
    if (iq.items.length < 2 && canBuild(world, this.player, 'rifleman') && me.credits > 250) {
      this.send({ t: 'build', item: 'rifleman' });
    }
  }

  private manageArmy(world: World) {
    const army: Entity[] = [];
    for (const e of world.entities.values()) {
      if (e.owner === this.player && e.kind === 'unit' && unitDef(e).weapon) army.push(e);
    }
    const staging = this.stagingPoint(world);
    if (staging) this.rallyTo(world, staging);
    if (this.wave) this.retreatDamaged(world, staging);

    // Defend: enemies near any of our buildings.
    const threat = this.findThreat(world);
    const home = army.filter((e) => !this.wave?.ids.has(e.id));
    if (threat) {
      const idle = home.filter((e) => e.order.t === 'idle' || e.order.t === 'move');
      if (idle.length) {
        this.send({
          t: 'attackMove',
          ids: idle.map((e) => e.id),
          x: Math.floor(threat.x / TILE),
          y: Math.floor(threat.y / TILE),
        });
      }
      return;
    }

    if (this.wave) this.steerWave(world);
    if (!staging) return;

    // Gather at the staging point; only healthy units that made it there count towards a wave.
    const stray = home.filter((e) => e.order.t === 'idle' && !near(e, staging, 4));
    if (stray.length) this.send({ t: 'move', ids: stray.map((e) => e.id), x: staging.x, y: staging.y });
    const gathered = home.filter((e) => healthy(e) && near(e, staging, 5));

    // Don't wait forever for a full wave: once the economy stalls the army may never grow.
    const impatient = world.tick >= this.nextWaveTick + WAVE_PATIENCE && gathered.length >= 3;
    if ((gathered.length >= this.waveSize || impatient) && world.tick >= this.nextWaveTick) {
      const target = this.enemyTarget(world, staging);
      if (!target) return;
      this.send({ t: 'attackMove', ids: gathered.map((e) => e.id), x: target.x, y: target.y });
      const wave = (this.wave ??= { ids: new Set(), launched: 0, regroupUntil: -1 });
      for (const e of gathered) wave.ids.add(e.id);
      wave.launched += gathered.length;
      wave.regroupUntil = -1;
      this.waveSize = Math.min(this.waveSize + 2, 14);
      this.nextWaveTick = world.tick + 900;
    }
  }

  /** Living wave members; forgets the dead. */
  private waveMembers(world: World): Entity[] {
    const out: Entity[] = [];
    for (const id of this.wave!.ids) {
      const e = world.entities.get(id);
      if (e) out.push(e);
      else this.wave!.ids.delete(id);
    }
    return out;
  }

  /** Badly hurt units fall back home; a wave that lost most of its strength falls back as a whole. */
  private retreatDamaged(world: World, staging: { x: number; y: number } | null) {
    const wave = this.wave!;
    const members = this.waveMembers(world);
    const collapsed = members.length * 100 < wave.launched * WAVE_COLLAPSE;
    const back = collapsed ? members : members.filter((e) => !healthy(e));
    if (collapsed) this.wave = null;
    else for (const e of back) wave.ids.delete(e.id);
    if (back.length && staging) this.send({ t: 'move', ids: back.map((e) => e.id), x: staging.x, y: staging.y });
  }

  /** Keep the wave together on the march, send its tanks after harvesters, and push on to the next target. */
  private steerWave(world: World) {
    const wave = this.wave!;
    const members = this.waveMembers(world);
    if (members.length === 0) {
      this.wave = null;
      return;
    }
    let cx = 0;
    let cy = 0;
    for (const e of members) {
      cx += e.x;
      cy += e.y;
    }
    const c = { x: Math.floor(cx / members.length / TILE), y: Math.floor(cy / members.length / TILE) };

    const harv = this.harvesterNear(world, c, HARVESTER_HUNT);
    if (harv) {
      // Shells do full damage to vehicles; bullets barely scratch a harvester.
      const hunters = members.filter((e) => {
        if (unitDef(e).weapon?.kind !== 'shell') return false;
        if (e.order.t === 'attack' && e.order.target === harv.id) return false;
        const cur = e.targetId ? world.entities.get(e.targetId) : undefined;
        return !cur || !weaponOf(cur);
      });
      if (hunters.length) this.send({ t: 'attack', ids: hunters.map((e) => e.id), target: harv.id });
    }

    // Regroup when strung out on the march, but not in the middle of a fight.
    const fighting = members.some((e) => e.targetId);
    if (!fighting && members.length > 2) {
      let spread = 0;
      for (const e of members) spread = Math.max(spread, (e.x / TILE - c.x) ** 2 + (e.y / TILE - c.y) ** 2);
      if (wave.regroupUntil < 0 && spread > REGROUP_SPREAD ** 2) {
        const target = this.enemyTarget(world, c);
        if (target) {
          // Units closer to the target than the centre wait there for the rest.
          const dc = (c.x - target.x) ** 2 + (c.y - target.y) ** 2;
          const ahead = members.filter((e) => (e.x / TILE - target.x) ** 2 + (e.y / TILE - target.y) ** 2 < dc);
          if (ahead.length) {
            this.send({ t: 'attackMove', ids: ahead.map((e) => e.id), x: c.x, y: c.y });
            wave.regroupUntil = world.tick + REGROUP_TIMEOUT;
            return;
          }
        }
      }
      if (wave.regroupUntil >= 0 && (spread <= (REGROUP_SPREAD / 2) ** 2 || world.tick >= wave.regroupUntil)) {
        wave.regroupUntil = -1;
        const target = this.enemyTarget(world, c);
        if (target) this.send({ t: 'attackMove', ids: members.map((e) => e.id), x: target.x, y: target.y });
        return;
      }
    }
    if (wave.regroupUntil >= 0) return;

    // Attackers that finished their march keep pushing to the next known target.
    const done = members.filter((e) => e.order.t === 'idle');
    if (done.length) {
      const target = this.enemyTarget(world, c);
      if (target) this.send({ t: 'attackMove', ids: done.map((e) => e.id), x: target.x, y: target.y });
    }
  }

  /** Closest enemy harvester we can currently see within `radius` tiles of tile `at`. */
  private harvesterNear(world: World, at: { x: number; y: number }, radius: number): Entity | null {
    const visible = world.visible[this.player];
    let best: Entity | null = null;
    let bestD = radius * radius;
    for (const e of world.entities.values()) {
      if (e.type !== 'harvester' || areAllies(world, e.owner, this.player)) continue;
      if (!visible[tileOf(world, e.x, e.y)]) continue;
      const d = (e.x / TILE - at.x) ** 2 + (e.y / TILE - at.y) ** 2;
      if (d <= bestD) {
        bestD = d;
        best = e;
      }
    }
    return best;
  }

  /**
   * Gathering spot a few tiles in front of the base, towards the nearest enemy.
   * Recomputed each time so a new building on it just moves it to the next free tile.
   */
  private stagingPoint(world: World): { x: number; y: number } | null {
    const enemy = this.nearestEnemyStart(world);
    if (!enemy) return null;
    const me = world.players[this.player];
    const hx = me.startX + 1;
    const hy = me.startY + 1;
    const len = Math.sqrt((enemy.x - hx) ** 2 + (enemy.y - hy) ** 2);
    if (len === 0) return null;
    const x = Math.min(world.w - 1, Math.max(0, Math.round(hx + ((enemy.x - hx) * STAGING_DIST) / len)));
    const y = Math.min(world.h - 1, Math.max(0, Math.round(hy + ((enemy.y - hy) * STAGING_DIST) / len)));
    const tile = bfsFind(world, y * world.w + x, (i) => !world.blocked[i], 400);
    if (tile < 0) return null;
    return { x: tile % world.w, y: Math.floor(tile / world.w) };
  }

  /** New units walk straight to the staging point. */
  private rallyTo(world: World, at: { x: number; y: number }) {
    const ids: number[] = [];
    for (const e of world.entities.values()) {
      if (e.owner !== this.player || (e.type !== 'barracks' && e.type !== 'factory')) continue;
      if (e.rallyX !== at.x || e.rallyY !== at.y) ids.push(e.id);
    }
    if (ids.length) this.send({ t: 'rally', ids, x: at.x, y: at.y });
  }

  /** Enemy units within 10 tiles of one of our buildings. */
  private findThreat(world: World): Entity | null {
    const buildings: Entity[] = [];
    for (const e of world.entities.values()) if (e.owner === this.player && e.kind === 'building') buildings.push(e);
    const r2 = (TILE * 10) ** 2;
    for (const e of world.entities.values()) {
      if (areAllies(world, e.owner, this.player) || e.kind !== 'unit') continue;
      for (const b of buildings) {
        if ((e.x - b.x) ** 2 + (e.y - b.y) ** 2 < r2) return e;
      }
    }
    return null;
  }

  /**
   * Where to attack from tile `from`: the closest refinery it has seen (harvesters come and go there),
   * else the closest seen building, else the nearest enemy start.
   * Only uses its own explored map, so no omniscience beyond start positions.
   */
  private enemyTarget(world: World, from: { x: number; y: number }): { x: number; y: number } | null {
    const explored = world.explored[this.player];
    let best: { x: number; y: number } | null = null;
    let bestD = Infinity;
    for (const e of world.entities.values()) {
      if (areAllies(world, e.owner, this.player) || e.kind !== 'building' || isWall(e)) continue;
      if (!explored[e.ty * world.w + e.tx]) continue;
      // Refineries always beat other buildings.
      const d = (e.tx - from.x) ** 2 + (e.ty - from.y) ** 2 + (e.type === 'refinery' ? 0 : world.w * world.w * 4);
      if (d < bestD) {
        bestD = d;
        best = { x: e.tx + 1, y: e.ty + 1 };
      }
    }
    return best ?? this.nearestEnemyStart(world);
  }

  /** Centre of the nearest enemy construction yard start that is still in the game. */
  private nearestEnemyStart(world: World): { x: number; y: number } | null {
    const home = world.players[this.player];
    let best: { x: number; y: number } | null = null;
    let bestD = Infinity;
    for (const p of world.players) {
      if (areAllies(world, p.id, this.player) || p.defeated) continue;
      const d = (p.startX - home.startX) ** 2 + (p.startY - home.startY) ** 2;
      if (d < bestD) {
        bestD = d;
        best = { x: p.startX + 1, y: p.startY + 1 };
      }
    }
    return best;
  }

  /** Spiral out from the construction yard; keep a one-tile lane around buildings. */
  private findSpot(world: World, type: BuildingType): { x: number; y: number } | null {
    const def = BUILDINGS[type];
    const me = world.players[this.player];
    const ox = me.startX + 1;
    const oy = me.startY + 1;
    const defense = def.category === 'defense';
    const front = defense ? this.nearestEnemyStart(world) : null;
    let best: { x: number; y: number } | null = null;
    let bestScore = Infinity;
    for (let r = 2; r <= 12; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const x = ox + dx;
          const y = oy + dy;
          if (!canPlace(world, this.player, type, x, y) || !this.hasLane(world, x, y, def.w, def.h)) continue;
          let score = r * 10;
          if (type === 'refinery') score = this.oreDistance(world, x + 1, y + 1);
          // Defenses go on the side facing the enemy.
          else if (front) score = (x - front.x) ** 2 + (y - front.y) ** 2;
          if (score < bestScore) {
            bestScore = score;
            best = { x, y };
          }
        }
      }
      if (best && type !== 'refinery' && !defense) return best;
    }
    return best;
  }

  private hasLane(world: World, x: number, y: number, w: number, h: number): boolean {
    for (let ty = y - 1; ty <= y + h; ty++) {
      for (let tx = x - 1; tx <= x + w; tx++) {
        if (tx < 0 || ty < 0 || tx >= world.w || ty >= world.h) continue;
        if (world.buildingAt[ty * world.w + tx]) return false;
      }
    }
    return true;
  }

  private oreDistance(world: World, x: number, y: number): number {
    let best = Infinity;
    for (let i = 0; i < world.ore.length; i++) {
      if (!world.ore[i]) continue;
      const d = (i % world.w - x) ** 2 + (Math.floor(i / world.w) - y) ** 2;
      if (d < best) best = d;
    }
    return best;
  }
}
