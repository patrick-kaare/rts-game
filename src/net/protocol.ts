import { BUILDINGS } from '../sim/data/buildings';
import { UNITS } from '../sim/data/units';
import { MAX_PLAYERS } from '../sim/map';
import type { GameRules } from '../sim/rules';
import type { Command, PlayerCommand } from '../sim/types';

/**
 * Messages between browser and game server (JSON over one WebSocket).
 *
 * The server owns the clock: every tick it broadcasts the commands it
 * received since the previous one (`tick`, possibly empty). Clients run a
 * tick once its bundle has arrived, so a missing or slow player never
 * stalls anyone else.
 */

export const SLOT_COUNT = MAX_PLAYERS;
/** How often clients report a state hash, in ticks. */
export const HASH_INTERVAL = 100;

/** Lobby teams; 0 means no team (free-for-all). */
export const TEAM_OPTIONS = [0, 1, 2, 3, 4, 5];
export const isTeam = (v: unknown): v is number => TEAM_OPTIONS.includes(v as number);

/** Number of sides a set of lobby teams makes: each team counts once, each player without one counts alone. */
export function sideCount(teams: number[]): number {
  return new Set(teams.filter((t) => t > 0)).size + teams.filter((t) => t === 0).length;
}

/** What a lobby slot holds. 'human' slots are taken by a connected or disconnected person. */
export type SlotKind = 'open' | 'ai' | 'closed' | 'human';
/** What the host can set a free slot to. */
export type SlotSetting = 'open' | 'ai' | 'closed';

export interface SlotInfo {
  kind: SlotKind;
  name: string;
  connected: boolean;
  team: number;
}

/** A participant in a running match; the array index is the sim player id. */
export interface MatchPlayer {
  name: string;
  ai: boolean;
  team: number;
}

/** Commands for one tick, as stored in a match log. Ticks with no commands are omitted. */
export type TickBundle = [tick: number, cmds: PlayerCommand[]];

export type ClientMsg =
  /**
   * `slots` is the setup of every slot after the host's own (slot 0), e.g. from an offline lobby.
   * `teams` is the team of every slot, the host's included.
   */
  | { t: 'create'; name: string; rules: GameRules; slots: SlotSetting[]; teams: number[] }
  | { t: 'join'; code: string; name: string }
  | { t: 'rejoin'; code: string; token: string }
  /** Host only. Setting a human's seat to 'open' removes them. */
  | { t: 'slot'; index: number; kind: SlotSetting }
  /** In the lobby: the host can set any slot's team, others only their own. */
  | { t: 'team'; index: number; team: number }
  /** Host only, in the lobby. */
  | { t: 'rules'; rules: GameRules }
  | { t: 'start' }
  | { t: 'cmd'; cmd: Command }
  | { t: 'hash'; tick: number; hash: number };

export type ServerMsg =
  | { t: 'joined'; code: string; slot: number; token: string }
  | { t: 'lobby'; slots: SlotInfo[]; rules: GameRules }
  /** Sent when the match starts, and again on every rejoin. `tick` is the next tick the server will run. */
  | { t: 'start'; seed: number; rules: GameRules; players: MatchPlayer[]; you: number; tick: number; log: TickBundle[] }
  | { t: 'tick'; tick: number; cmds: PlayerCommand[] }
  /** Per sim player: is a human connected (AIs are always true). */
  | { t: 'presence'; connected: boolean[] }
  | { t: 'desync'; tick: number }
  | { t: 'error'; msg: string };

export const isSlotSetting = (v: unknown): v is SlotSetting => v === 'open' || v === 'ai' || v === 'closed';

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const isCoord = (v: unknown) => isInt(v) && v >= -1 && v < 4096;
const isIds = (v: unknown) => Array.isArray(v) && v.length <= 500 && v.every((id) => isInt(id) && id > 0);

/**
 * Strict shape check for a command from the network. applyCommand assumes
 * well-formed input, and a malformed command that threw would crash every
 * client in the same way, so the server drops anything that doesn't match.
 */
export function isValidCommand(c: unknown): c is Command {
  if (!c || typeof c !== 'object') return false;
  const cmd = c as Record<string, unknown>;
  switch (cmd.t) {
    case 'move':
    case 'attackMove':
    case 'harvest':
    case 'rally':
      return isIds(cmd.ids) && isCoord(cmd.x) && isCoord(cmd.y);
    case 'attack':
      return isIds(cmd.ids) && isInt(cmd.target);
    case 'dock':
      return isIds(cmd.ids) && isInt(cmd.refinery);
    case 'stop':
      return isIds(cmd.ids);
    case 'build':
    case 'cancel':
      return typeof cmd.item === 'string' && (Object.hasOwn(UNITS, cmd.item) || Object.hasOwn(BUILDINGS, cmd.item));
    case 'place':
      return typeof cmd.item === 'string' && Object.hasOwn(BUILDINGS, cmd.item) && isCoord(cmd.x) && isCoord(cmd.y);
    default:
      return false;
  }
}

/** Copy only the fields a command type uses, so extra junk never reaches the log. */
export function cleanCommand(cmd: Command): Command {
  switch (cmd.t) {
    case 'move':
    case 'attackMove':
    case 'harvest':
    case 'rally':
      return { t: cmd.t, ids: [...cmd.ids], x: cmd.x, y: cmd.y };
    case 'attack':
      return { t: 'attack', ids: [...cmd.ids], target: cmd.target };
    case 'dock':
      return { t: 'dock', ids: [...cmd.ids], refinery: cmd.refinery };
    case 'stop':
      return { t: 'stop', ids: [...cmd.ids] };
    case 'build':
    case 'cancel':
      return { t: cmd.t, item: cmd.item };
    case 'place':
      return { t: 'place', item: cmd.item, x: cmd.x, y: cmd.y };
  }
}
