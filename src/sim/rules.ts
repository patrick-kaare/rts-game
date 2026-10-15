/** Match settings chosen in the lobby. Fixed for the whole match and part of the deterministic state. */
export interface GameRules {
  credits: number;
  fog: FogRule;
  mapSize: MapSizeRule;
  startUnits: StartUnitsRule;
}

export type FogRule = 'full' | 'explored' | 'off';
export type MapSizeRule = 'auto' | 'small' | 'medium' | 'large' | 'huge';
export type StartUnitsRule = 'none' | 'squad' | 'army';

export const CREDIT_OPTIONS = [1000, 3000, 5000, 10000];
export const FOG_OPTIONS: FogRule[] = ['full', 'explored', 'off'];
export const MAP_SIZE_OPTIONS: MapSizeRule[] = ['auto', 'small', 'medium', 'large', 'huge'];
export const START_UNITS_OPTIONS: StartUnitsRule[] = ['none', 'squad', 'army'];

export const DEFAULT_RULES: GameRules = { credits: 3000, fog: 'full', mapSize: 'auto', startUnits: 'squad' };

/** Strict shape check for rules from the network or storage. */
export function isValidRules(r: unknown): r is GameRules {
  if (!r || typeof r !== 'object') return false;
  const rules = r as Record<string, unknown>;
  return (
    CREDIT_OPTIONS.includes(rules.credits as number) &&
    FOG_OPTIONS.includes(rules.fog as FogRule) &&
    MAP_SIZE_OPTIONS.includes(rules.mapSize as MapSizeRule) &&
    START_UNITS_OPTIONS.includes(rules.startUnits as StartUnitsRule)
  );
}

/** Copy only the known fields, so extra junk never reaches the match. */
export function cleanRules(r: GameRules): GameRules {
  return { credits: r.credits, fog: r.fog, mapSize: r.mapSize, startUnits: r.startUnits };
}
