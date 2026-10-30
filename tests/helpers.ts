import { AIController } from '../src/ai/ai';
import { LocalTransport } from '../src/net/local';
import { applyCommand } from '../src/sim/commands';
import { DEFAULT_RULES, type Difficulty, type GameRules } from '../src/sim/rules';
import { stepWorld } from '../src/sim/step';
import { Terrain, type World } from '../src/sim/types';
import { addBuilding, createWorld } from '../src/sim/world';

/** An empty open field with a far-away enemy CY so the match does not end at once. */
export function flatWorld(): World {
  const w = createWorld(1);
  w.terrain.fill(Terrain.Grass);
  w.blocked.fill(0);
  w.ore.fill(0);
  w.gems.fill(0);
  w.oreBed.fill(0);
  w.buildingAt.fill(0);
  w.entities.clear();
  // Keep player 1 alive so the game does not end immediately.
  addBuilding(w, 1, 'cy', 60, 0);
  return w;
}

/** A headless match between AIs. */
export function aiMatch(seed: number, players = 2, rules: GameRules = DEFAULT_RULES, teams: number[] = [], difficulties: Difficulty[] = []) {
  const world = createWorld(seed, players, rules, teams, difficulties);
  const transport = new LocalTransport();
  const ais = world.players.map((p) => new AIController(p.id, transport));
  const step = () => {
    transport.currentTick = world.tick;
    for (const ai of ais) ai.update(world);
    for (const c of transport.take(world.tick)) applyCommand(world, c.player, c.cmd);
    stepWorld(world);
  };
  return { world, transport, step };
}
