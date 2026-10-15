/** Match settings chosen in the lobby. Fixed for the whole match and part of the deterministic state. */
export interface GameRules {
  credits: number;
  fog: FogRule;
  mapSize: MapSizeRule;
  startUnits: StartUnitsRule;
  terrain: TerrainRule;
  power: PowerRule;
  ore: OreRule;
}

export type FogRule = 'full' | 'explored' | 'off';
export type MapSizeRule = 'auto' | 'small' | 'medium' | 'large' | 'huge';
export type StartUnitsRule = 'none' | 'squad' | 'army';
/** Classic: rock and water blobs only. Rich: rivers with bridges, roads, forests and cliff ridges. */
export type TerrainRule = 'classic' | 'rich';
/** Basic: low power only slows production by half and switches defenses off. Full: also scales the slowdown with the shortfall, slows refining, darkens the minimap and makes damaged power producers yield less. */
export type PowerRule = 'full' | 'basic';

/** Whether ore fields grow back over the match, and whether the contested fields have gems worth double. */
export type OreRule = 'both' | 'regrow' | 'gems' | 'finite';

export const CREDIT_OPTIONS = [1000, 3000, 5000, 10000];
export const FOG_OPTIONS: FogRule[] = ['full', 'explored', 'off'];
export const MAP_SIZE_OPTIONS: MapSizeRule[] = ['auto', 'small', 'medium', 'large', 'huge'];
export const START_UNITS_OPTIONS: StartUnitsRule[] = ['none', 'squad', 'army'];
export const TERRAIN_OPTIONS: TerrainRule[] = ['rich', 'classic'];
export const POWER_OPTIONS: PowerRule[] = ['full', 'basic'];
export const ORE_OPTIONS: OreRule[] = ['both', 'regrow', 'gems', 'finite'];
export const oreRegrows = (r: GameRules): boolean => r.ore === 'both' || r.ore === 'regrow';
export const hasGems = (r: GameRules): boolean => r.ore === 'both' || r.ore === 'gems';

/** Per player, set in the lobby for AI slots. Humans always play Normal. */
export type Difficulty = 'easy' | 'normal' | 'hard';
export const DIFFICULTY_OPTIONS: Difficulty[] = ['easy', 'normal', 'hard'];
export const isDifficulty = (v: unknown): v is Difficulty => DIFFICULTY_OPTIONS.includes(v as Difficulty);
/**
 * Build speed and harvest income in percent. Income values are multiples of 4
 * so every unload step (25 credits) stays a whole number.
 */
export const DIFFICULTY: Record<Difficulty, { build: number; income: number }> = {
  easy: { build: 75, income: 80 },
  normal: { build: 100, income: 100 },
  hard: { build: 150, income: 140 },
};

export const DEFAULT_RULES: GameRules = { credits: 3000, fog: 'full', mapSize: 'auto', startUnits: 'squad', terrain: 'rich', power: 'full', ore: 'both' };

/** Strict shape check for rules from the network or storage. */
export function isValidRules(r: unknown): r is GameRules {
  if (!r || typeof r !== 'object') return false;
  const rules = r as Record<string, unknown>;
  return (
    CREDIT_OPTIONS.includes(rules.credits as number) &&
    FOG_OPTIONS.includes(rules.fog as FogRule) &&
    MAP_SIZE_OPTIONS.includes(rules.mapSize as MapSizeRule) &&
    START_UNITS_OPTIONS.includes(rules.startUnits as StartUnitsRule) &&
    TERRAIN_OPTIONS.includes(rules.terrain as TerrainRule) &&
    POWER_OPTIONS.includes(rules.power as PowerRule) &&
    ORE_OPTIONS.includes(rules.ore as OreRule)
  );
}

/** Copy only the known fields, so extra junk never reaches the match. */
export function cleanRules(r: GameRules): GameRules {
  return { credits: r.credits, fog: r.fog, mapSize: r.mapSize, startUnits: r.startUnits, terrain: r.terrain, power: r.power, ore: r.ore };
}
