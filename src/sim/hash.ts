import { FOG_OPTIONS, MAP_SIZE_OPTIONS, START_UNITS_OPTIONS } from './rules';
import type { World } from './types';

/** FNV-1a over the authoritative sim state. Used for determinism tests and future desync checks. */
export function stateHash(world: World): number {
  let h = 0x811c9dc5;
  const mix = (n: number) => {
    h ^= n | 0;
    h = Math.imul(h, 0x01000193);
  };
  mix(world.tick);
  mix(world.rng.s);
  mix(world.nextId);
  // Rules never change, but a mismatch should show up as a desync rather than drift.
  mix(world.rules.credits);
  mix(FOG_OPTIONS.indexOf(world.rules.fog));
  mix(MAP_SIZE_OPTIONS.indexOf(world.rules.mapSize));
  mix(START_UNITS_OPTIONS.indexOf(world.rules.startUnits));
  for (const p of world.players) {
    mix(p.credits);
    for (const q of Object.values(p.queues)) {
      mix(q.items.length);
      mix(q.progress);
      mix(q.spent);
    }
  }
  for (const e of world.entities.values()) {
    mix(e.id);
    mix(e.x);
    mix(e.y);
    mix(e.hp);
    mix(e.cargo);
    mix(e.cooldown);
    mix(e.targetId);
    mix(e.pathIdx);
    mix(e.order.t.length);
    mix(e.rallyX);
    mix(e.rallyY);
  }
  for (let i = 0; i < world.ore.length; i++) if (world.ore[i]) mix(i * 65536 + world.ore[i]);
  return h >>> 0;
}
