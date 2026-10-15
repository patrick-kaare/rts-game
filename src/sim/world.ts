import { BUILDINGS } from './data/buildings';
import { UNITS } from './data/units';
import { generateMap } from './map';
import { DEFAULT_RULES, type Difficulty, type GameRules, type StartUnitsRule } from './rules';
import {
  TILE,
  Terrain,
  type BuildingType,
  type Entity,
  type Player,
  type UnitType,
  type World,
} from './types';

/** Starting units per setting, as tile offsets from the yard's top-left corner. */
const START_UNITS: Record<StartUnitsRule, [UnitType, number, number][]> = {
  none: [],
  squad: [
    ['rifleman', 1, 4],
    ['rifleman', 2, 4],
  ],
  army: [
    ['rifleman', 0, 4],
    ['rifleman', 1, 4],
    ['rifleman', 2, 4],
    ['rifleman', 3, 4],
    ['tank', 4, 1],
    ['tank', 4, 3],
  ],
};

/** Internal team for a player who picked none in the lobby, so nobody shares it. */
const SOLO_TEAM = 100;

/** `teams[i]` is player i's lobby team, 0 for none. `difficulties[i]` defaults to Normal. */
export function createWorld(
  seed: number,
  playerCount = 2,
  rules: GameRules = DEFAULT_RULES,
  teams: number[] = [],
  difficulties: Difficulty[] = [],
): World {
  const map = generateMap(seed, playerCount, rules.mapSize);
  const n = map.w * map.h;
  const blocked = new Uint8Array(n);
  for (let i = 0; i < n; i++) blocked[i] = map.terrain[i] === Terrain.Grass ? 0 : 1;

  const world: World = {
    tick: 0,
    seed,
    rules: { ...rules },
    rng: { s: seed ^ 0x5bd1e995 },
    w: map.w,
    h: map.h,
    terrain: map.terrain,
    ore: map.ore,
    blocked,
    buildingAt: new Int32Array(n),
    entities: new Map(),
    nextId: 1,
    players: [],
    visible: [],
    explored: [],
    events: [],
    oreVersion: 0,
    winner: -1,
  };

  for (let p = 0; p < playerCount; p++) {
    const start = map.starts[p];
    const player: Player = {
      id: p,
      credits: rules.credits,
      powerProduced: 0,
      powerUsed: 0,
      queues: {
        building: emptyQueue(),
        infantry: emptyQueue(),
        vehicle: emptyQueue(),
      },
      defeated: false,
      team: teams[p] ? teams[p] : SOLO_TEAM + p,
      difficulty: difficulties[p] ?? 'normal',
      startX: start.x,
      startY: start.y,
    };
    world.players.push(player);
    world.visible.push(new Uint8Array(n).fill(rules.fog === 'off' ? 1 : 0));
    world.explored.push(new Uint8Array(n).fill(rules.fog === 'full' ? 0 : 1));
    addBuilding(world, p, 'cy', start.x, start.y);
    for (const [type, dx, dy] of START_UNITS[rules.startUnits]) {
      addUnit(world, p, type, (start.x + dx) * TILE + TILE / 2, (start.y + dy) * TILE + TILE / 2);
    }
  }
  return world;
}

function emptyQueue() {
  return { items: [], progress: 0, spent: 0, ready: false };
}

function baseEntity(world: World, owner: number): Entity {
  return {
    id: world.nextId++,
    owner,
    kind: 'unit',
    type: 'rifleman',
    x: 0,
    y: 0,
    px: 0,
    py: 0,
    hp: 1,
    maxHp: 1,
    order: { t: 'idle' },
    path: [],
    pathIdx: 0,
    goalX: 0,
    goalY: 0,
    repathAt: 0,
    stuck: 0,
    targetId: 0,
    cooldown: 0,
    fx: 0,
    fy: TILE,
    ax: 0,
    ay: TILE,
    cargo: 0,
    tx: 0,
    ty: 0,
    w: 0,
    h: 0,
    rallyX: -1,
    rallyY: -1,
  };
}

export function addUnit(world: World, owner: number, type: UnitType, x: number, y: number): Entity {
  const def = UNITS[type];
  const e = baseEntity(world, owner);
  e.type = type;
  e.x = e.px = e.goalX = x;
  e.y = e.py = e.goalY = y;
  e.hp = e.maxHp = def.hp;
  world.entities.set(e.id, e);
  return e;
}

export function addBuilding(world: World, owner: number, type: BuildingType, tx: number, ty: number): Entity {
  const def = BUILDINGS[type];
  const e = baseEntity(world, owner);
  e.kind = 'building';
  e.type = type;
  e.tx = tx;
  e.ty = ty;
  e.w = def.w;
  e.h = def.h;
  e.x = e.px = tx * TILE + (def.w * TILE) / 2;
  e.y = e.py = ty * TILE + (def.h * TILE) / 2;
  e.hp = e.maxHp = def.hp;
  world.entities.set(e.id, e);
  for (let y = ty; y < ty + def.h; y++) {
    for (let x = tx; x < tx + def.w; x++) {
      const i = y * world.w + x;
      world.blocked[i] = 1;
      world.buildingAt[i] = e.id;
      world.ore[i] = 0;
    }
  }
  world.oreVersion++;
  return e;
}

export function removeEntity(world: World, e: Entity): void {
  world.entities.delete(e.id);
  if (e.kind === 'building') {
    for (let y = e.ty; y < e.ty + e.h; y++) {
      for (let x = e.tx; x < e.tx + e.w; x++) {
        const i = y * world.w + x;
        world.buildingAt[i] = 0;
        world.blocked[i] = world.terrain[i] === Terrain.Grass ? 0 : 1;
      }
    }
  }
}

export function tileOf(world: World, x: number, y: number): number {
  const tx = Math.min(world.w - 1, Math.max(0, Math.floor(x / TILE)));
  const ty = Math.min(world.h - 1, Math.max(0, Math.floor(y / TILE)));
  return ty * world.w + tx;
}

export function tileCenter(world: World, i: number): { x: number; y: number } {
  return { x: (i % world.w) * TILE + TILE / 2, y: Math.floor(i / world.w) * TILE + TILE / 2 };
}

export function inBounds(world: World, tx: number, ty: number): boolean {
  return tx >= 0 && ty >= 0 && tx < world.w && ty < world.h;
}

export function unitDef(e: Entity) {
  return UNITS[e.type as UnitType];
}

export function buildingDef(e: Entity) {
  return BUILDINGS[e.type as BuildingType];
}

export function isAlive(world: World, id: number): Entity | undefined {
  return id ? world.entities.get(id) : undefined;
}

/** Squared distance from a point to an entity's body (rect for buildings). */
export function distSqToEntity(x: number, y: number, e: Entity): number {
  if (e.kind === 'building') {
    const x0 = e.tx * TILE;
    const y0 = e.ty * TILE;
    const cx = Math.max(x0, Math.min(x, x0 + e.w * TILE));
    const cy = Math.max(y0, Math.min(y, y0 + e.h * TILE));
    const dx = x - cx;
    const dy = y - cy;
    return dx * dx + dy * dy;
  }
  const dx = x - e.x;
  const dy = y - e.y;
  return dx * dx + dy * dy;
}

export function countBuildings(world: World, owner: number, type: BuildingType): number {
  let n = 0;
  for (const e of world.entities.values()) if (e.owner === owner && e.type === type) n++;
  return n;
}

export function areAllies(world: World, a: number, b: number): boolean {
  return world.players[a].team === world.players[b].team;
}

export function hasBuilding(world: World, owner: number, type: string): boolean {
  for (const e of world.entities.values()) if (e.owner === owner && e.kind === 'building' && e.type === type) return true;
  return false;
}
