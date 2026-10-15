import type { CommandTransport } from '../net/transport';
import { BUILDINGS } from '../sim/data/buildings';
import { itemCost } from '../sim/data/items';
import { canPlace } from '../sim/systems/construction';
import { canBuild, isLowPower } from '../sim/systems/production';
import { TILE, type BuildingType, type Entity, type World } from '../sim/types';
import { areAllies, countBuildings, isWall, unitDef } from '../sim/world';

const BUILD_ORDER: BuildingType[] = ['power', 'refinery', 'barracks', 'power', 'factory', 'pillbox', 'turret', 'power', 'refinery', 'power', 'barracks'];

/** Ticks past the wave time after which the AI attacks with whatever it has. */
const WAVE_PATIENCE = 1800;

/**
 * A simple scripted opponent. It only reads the world and issues commands
 * through the transport, exactly like a human player.
 */
export class AIController {
  private waveSize = 6;
  private attacking = new Set<number>();
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
    for (const id of this.attacking) if (!world.entities.has(id)) this.attacking.delete(id);

    // Defend: enemies near any of our buildings.
    const threat = this.findThreat(world);
    const home = army.filter((e) => !this.attacking.has(e.id));
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

    // Don't wait forever for a full wave: once the economy stalls the army may never grow.
    const impatient = world.tick >= this.nextWaveTick + WAVE_PATIENCE && home.length >= 3;
    if ((home.length >= this.waveSize || impatient) && world.tick >= this.nextWaveTick) {
      const target = this.enemyTarget(world);
      if (!target) return;
      this.send({ t: 'attackMove', ids: home.map((e) => e.id), x: target.x, y: target.y });
      for (const e of home) this.attacking.add(e.id);
      this.waveSize = Math.min(this.waveSize + 2, 14);
      this.nextWaveTick = world.tick + 900;
      return;
    }

    // Attackers that finished their march keep pushing to the next known target.
    const done = army.filter((e) => this.attacking.has(e.id) && e.order.t === 'idle');
    if (done.length) {
      const target = this.enemyTarget(world);
      if (target) this.send({ t: 'attackMove', ids: done.map((e) => e.id), x: target.x, y: target.y });
    }
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
   * Where to attack: the closest enemy building it has seen, else the nearest enemy start.
   * Only uses its own explored map, so no omniscience beyond start positions.
   */
  private enemyTarget(world: World): { x: number; y: number } | null {
    const explored = world.explored[this.player];
    let best: { x: number; y: number } | null = null;
    let bestD = Infinity;
    const home = world.players[this.player];
    for (const e of world.entities.values()) {
      if (areAllies(world, e.owner, this.player) || e.kind !== 'building' || isWall(e)) continue;
      if (!explored[e.ty * world.w + e.tx]) continue;
      const d = (e.tx - home.startX) ** 2 + (e.ty - home.startY) ** 2;
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
