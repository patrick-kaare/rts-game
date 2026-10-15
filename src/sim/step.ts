import { separateUnits } from './systems/movement';
import { updateDefense } from './systems/combat';
import { updateFog } from './systems/fog';
import { updatePower, updateProduction } from './systems/production';
import { updateUnit } from './systems/units';
import { updateVictory } from './systems/victory';
import type { World } from './types';
import { buildingDef } from './world';

/** Advance the simulation by exactly one tick. */
export function stepWorld(world: World): void {
  world.events = [];
  if (world.winner >= 0) {
    world.tick++;
    return;
  }
  for (const e of world.entities.values()) {
    e.px = e.x;
    e.py = e.y;
  }
  updatePower(world);
  updateProduction(world);
  // Map iteration is insertion (= id) order, which keeps the sim deterministic.
  for (const e of world.entities.values()) {
    if (e.kind === 'unit') updateUnit(world, e);
    else if (buildingDef(e).weapon) updateDefense(world, e);
  }
  separateUnits(world);
  updateFog(world);
  updateVictory(world);
  world.tick++;
}
