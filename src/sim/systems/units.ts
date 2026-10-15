import { TILE, type Entity, type World } from '../types';
import { areAllies, unitDef } from '../world';
import { currentOrAcquire, engage } from './combat';
import { updateHarvester } from './economy';
import { followPath, isMoving, setPath } from './movement';

/** Per-unit order logic: what each unit does this tick. */
export function updateUnit(world: World, e: Entity): void {
  const def = unitDef(e);
  if (e.cooldown > 0) e.cooldown--;
  const sight = def.sight * TILE;
  const o = e.order;

  switch (o.t) {
    case 'idle': {
      if (def.weapon) {
        const t = currentOrAcquire(world, e, sight + TILE * 2);
        if (t && engage(world, e, t, true)) return;
        e.targetId = 0;
      }
      followPath(world, e);
      return;
    }
    case 'move': {
      // Forced move: shoot at things in range on the way, but never stop.
      if (def.weapon) {
        const t = currentOrAcquire(world, e, def.weapon.range);
        if (t) engage(world, e, t, false);
        else e.targetId = 0;
      }
      if (followPath(world, e)) e.order = { t: 'idle' };
      return;
    }
    case 'attackMove': {
      if (def.weapon) {
        const t = currentOrAcquire(world, e, sight + TILE * 2);
        if (t && engage(world, e, t, true)) return;
        if (e.targetId) {
          // Lost or killed the target: resume the march.
          e.targetId = 0;
          setPath(world, e, o.x, o.y);
        }
      }
      if (!isMoving(e)) {
        const dx = o.x - e.x;
        const dy = o.y - e.y;
        if (dx * dx + dy * dy <= (TILE * 1.5) ** 2) {
          e.order = { t: 'idle' };
          return;
        }
        if (world.tick >= e.repathAt) {
          setPath(world, e, o.x, o.y);
          e.repathAt = world.tick + 20;
        }
      }
      followPath(world, e);
      return;
    }
    case 'attack': {
      const t = world.entities.get(o.target);
      if (!t || areAllies(world, t.owner, e.owner) || !engage(world, e, t, true)) {
        e.order = { t: 'idle' };
        e.targetId = 0;
      }
      return;
    }
    case 'harvest':
      updateHarvester(world, e);
      return;
  }
}
