export interface TeamColors {
  main: number;
  dark: number;
  light: number;
  css: string;
}

/** One colour set per player slot (up to MAX_PLAYERS). */
export const TEAM: TeamColors[] = [
  { main: 0x3b82f6, dark: 0x1e3a8a, light: 0x93c5fd, css: '#3b82f6' }, // blue
  { main: 0xef4444, dark: 0x7f1d1d, light: 0xfca5a5, css: '#ef4444' }, // red
  { main: 0x22c55e, dark: 0x14532d, light: 0x86efac, css: '#22c55e' }, // green
  { main: 0xeab308, dark: 0x713f12, light: 0xfde047, css: '#eab308' }, // yellow
  { main: 0xa855f7, dark: 0x4c1d95, light: 0xd8b4fe, css: '#a855f7' }, // purple
  { main: 0xf97316, dark: 0x7c2d12, light: 0xfdba74, css: '#f97316' }, // orange
  { main: 0x06b6d4, dark: 0x164e63, light: 0x67e8f9, css: '#06b6d4' }, // cyan
  { main: 0xec4899, dark: 0x831843, light: 0xf9a8d4, css: '#ec4899' }, // pink
  { main: 0xe5e7eb, dark: 0x4b5563, light: 0xffffff, css: '#e5e7eb' }, // white
  { main: 0x84cc16, dark: 0x365314, light: 0xbef264, css: '#84cc16' }, // lime
];

export const COLORS = {
  grass: [0x2f4a2c, 0x324e2e, 0x2c472a],
  rock: 0x5b5d61,
  rockEdge: 0x3d3f43,
  rockShadow: 0x1f2124,
  water: 0x1d3b5c,
  waterEdge: 0x2a5580,
  forestFloor: 0x223a20,
  canopy: [0x1d4d22, 0x2a5e2b, 0x163d1a],
  road: 0x6b5a3e,
  roadEdge: 0x4f4230,
  bridge: 0x7a5a36,
  bridgePlank: 0x5a3f22,
  bridgeRail: 0x3a2814,
  concrete: 0x8a8d91,
  concreteEdge: 0x55585c,
  ore: 0xe0a82e,
  oreDark: 0x9a6b12,
  grid: 0x000000,
  bulletShot: 0xfff3a0,
  shellShot: 0xffa640,
  valid: 0x22c55e,
  invalid: 0xef4444,
  rally: 0x38bdf8,
  fx: {
    muzzle: 0xfff7c2,
    fire: [0xffd166, 0xff8c1a, 0xe2461b],
    smokeLight: 0xb4b9c0,
    smokeDark: 0x3a3a3a,
    dust: 0x8a7a5c,
    scorch: 0x1a1712,
    wreck: 0x2a2623,
    wreckEdge: 0x45403b,
    splat: 0x3b1a14,
  },
};

export function hpColor(frac: number): number {
  return frac > 0.5 ? 0x22c55e : frac > 0.25 ? 0xeab308 : 0xef4444;
}
