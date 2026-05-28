/**
 * Team-level collaboration roster for the platform UI: every bot the deployment
 * runs (from bots-info.json) enriched with its team capability label and whether
 * it has a team-level role, plus the team's member count.
 *
 * This is the TEAM view (who's on the team), distinct from the per-chat roster
 * in listChatBotMembers (who's in a given group + reliably @-mentionable).
 * Pure read from `{dataDir}` files — no Lark API, no config coupling — so it is
 * trivially testable and cheap for the UI to poll.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { getBotCapability } from './bot-profile-store.js';
import { getBotOwner } from './bot-owner-store.js';
import { getTeam, getDefaultTeam, DEFAULT_TEAM_ID } from './team-store.js';

export interface TeamRosterBot {
  larkAppId: string;
  name: string;
  cliId: string;
  capability: string | null;
  hasTeamRole: boolean;
  /** Owner for grouping by person; null if unassigned. unionId is the key, name for display. */
  owner: { unionId?: string; openId?: string; name?: string } | null;
}

export interface TeamRoster {
  team: { id: string; name: string; memberCount: number };
  bots: TeamRosterBot[];
}

interface BotInfoEntry { larkAppId: string; botOpenId: string | null; botName: string | null; cliId: string }

function readBotsInfo(dataDir: string): BotInfoEntry[] {
  const fp = join(dataDir, 'bots-info.json');
  if (!existsSync(fp)) return [];
  try {
    const parsed = JSON.parse(readFileSync(fp, 'utf-8'));
    if (Array.isArray(parsed)) return parsed as BotInfoEntry[];
  } catch { /* corrupt — empty roster */ }
  return [];
}

function hasTeamRoleFile(dataDir: string, larkAppId: string): boolean {
  return existsSync(join(dataDir, 'team-roles', `${larkAppId}.md`));
}

/** A currently-running bot from the live daemon registry (authoritative for
 *  "what's running" — unlike bots-info.json which is a racy, probe-lagged file). */
export interface LiveBot { larkAppId: string; botName?: string | null; cliId?: string }

/**
 * @param configOrder optional list of larkAppIds in bots.json (config) order;
 *   when given, the roster is sorted to match it (and the personal dashboard).
 * @param liveBots optional live daemon-registry bots. When given, the roster's
 *   bot set is THESE (authoritative — fixes an empty/stale bots-info.json
 *   showing no bots even though daemons are running), enriched with cliId from
 *   bots-info.json by larkAppId. When omitted, falls back to bots-info.json.
 */
export function buildTeamRoster(dataDir: string, teamId: string = DEFAULT_TEAM_ID, configOrder?: string[], liveBots?: LiveBot[]): TeamRoster {
  const team = getTeam(dataDir, teamId) ?? getDefaultTeam(dataDir);
  const info = readBotsInfo(dataDir);
  let entries: BotInfoEntry[];
  if (liveBots !== undefined) {
    // Live registry is the source of truth WHEN PROVIDED — including an empty
    // array (no daemons running ⇒ empty roster). Never fall back to a stale
    // bots-info.json here, or removed/offline bots would linger. Enrich
    // cliId/openId/name from bots-info.json (which carries cliId — the registry
    // doesn't) by larkAppId.
    const byId = new Map(info.map(e => [e.larkAppId, e]));
    entries = liveBots.map(lb => {
      const ex = byId.get(lb.larkAppId);
      return {
        larkAppId: lb.larkAppId,
        botOpenId: ex?.botOpenId ?? null,
        botName: lb.botName ?? ex?.botName ?? null,
        cliId: lb.cliId ?? ex?.cliId ?? '',
      };
    });
  } else {
    entries = info;
  }
  if (configOrder && configOrder.length) {
    const rank = new Map(configOrder.map((id, i) => [id, i]));
    const at = (id: string) => rank.has(id) ? (rank.get(id) as number) : Number.MAX_SAFE_INTEGER;
    // stable sort by config index; unknown bots fall to the end keeping their order
    entries = entries.map((b, i) => ({ b, i })).sort((x, y) => (at(x.b.larkAppId) - at(y.b.larkAppId)) || (x.i - y.i)).map(x => x.b);
  }
  const bots: TeamRosterBot[] = entries.map((b) => {
    const o = getBotOwner(dataDir, b.larkAppId);
    return {
      larkAppId: b.larkAppId,
      name: b.botName ?? b.cliId,
      cliId: b.cliId,
      capability: getBotCapability(dataDir, b.larkAppId),
      hasTeamRole: hasTeamRoleFile(dataDir, b.larkAppId),
      owner: o ? { unionId: o.unionId, openId: o.openId, name: o.name } : null,
    };
  });
  return { team: { id: team.id, name: team.name, memberCount: team.members.length }, bots };
}
