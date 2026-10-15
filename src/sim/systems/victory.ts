import type { World } from '../types';

/** A player is out once they have no buildings left; the match ends when only one team is still in it. */
export function updateVictory(world: World): void {
  if (world.winner >= 0 || world.tick % 10 !== 0) return;
  const hasBuildings = new Set<number>();
  for (const e of world.entities.values()) if (e.kind === 'building') hasBuildings.add(e.owner);
  for (const p of world.players) if (!hasBuildings.has(p.id)) p.defeated = true;
  const alive = world.players.filter((p) => !p.defeated);
  // `winner` is the first surviving player of the winning team, or players.length if nobody survived.
  if (alive.every((p) => p.team === alive[0]?.team)) world.winner = alive.length ? alive[0].id : world.players.length;
}
