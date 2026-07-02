/**
 * Platform-team trust store: the centralized botmux platform's view of the
 * teams THIS machine belongs to — teammate bot union_ids + team group chats
 * (机器人大厅 etc.), pushed by the platform over the tunnel control channel
 * (`team-sync`, see platform repo tunnel/protocol).
 *
 * This is the PLATFORM counterpart of the legacy federation trust stores
 * ([[team-bots-store]] / [[team-groups-store]]): both feed the same auth gate
 * (isTrustedTeamBotSender / canOperate / evaluateTalk), so 平台团队 and 旧版
 * hub/spoke 团队 are equally "team mode" — neither needs /grant.
 *
 * Semantics differ from the learned store on purpose:
 * - Entries are AUTHORITATIVE roster state, not passively learned — they are
 *   replaced wholesale on every sync and follow team membership. No 30d expiry:
 *   a bot removed from the team disappears on the next sync instead of aging out.
 * - The version compare is declarative: the daemon reports `rev` (see
 *   getPlatformTeamSyncRev) on register/heartbeat; the platform pushes the full
 *   payload whenever its authoritative rev differs. Missed pushes self-heal on
 *   the next heartbeat; a lost/corrupt local file self-heals the same way.
 *
 * Group chats are additionally mirrored into [[team-groups-store]] under the
 * `platform:<teamId>` teamId prefix (replace-by-prefix, never touching legacy
 * federation entries) so every existing isTeamGroupChat consumer — the
 * first-contact trust leg AND the recordTeamBot learning gate — works unchanged.
 *
 * Storage: `{dataDir}/platform-team-sync.json`.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { replaceTeamGroupsByPrefix } from './team-groups-store.js';

/** teamId prefix used when mirroring platform team groups into team-groups.json. */
export const PLATFORM_TEAM_PREFIX = 'platform:';

export interface PlatformTeamBot {
  appId: string;
  unionId?: string;
  name?: string;
}

export interface PlatformTeamSyncTeam {
  teamId: string;
  teamName: string;
  /** Team-assembled group chats (机器人大厅 first) — trusted like 拉群 groups. */
  groupChatIds: string[];
  bots: PlatformTeamBot[];
}

export interface PlatformTeamSyncPayload {
  rev: string;
  teams: PlatformTeamSyncTeam[];
}

interface FileShape extends PlatformTeamSyncPayload {
  updatedAt: number;
}

function filePath(dataDir: string): string {
  return join(dataDir, 'platform-team-sync.json');
}

function readFile(dataDir: string): FileShape | null {
  const fp = filePath(dataDir);
  if (!existsSync(fp)) return null;
  try {
    const parsed = JSON.parse(readFileSync(fp, 'utf-8'));
    if (parsed && typeof parsed === 'object' && typeof parsed.rev === 'string' && Array.isArray(parsed.teams)) {
      return parsed as FileShape;
    }
  } catch { /* corrupt — fall through to null (rev mismatch → platform re-pushes) */ }
  return null;
}

/** Sanitize one team entry from an untrusted tunnel payload. Null → drop. */
function sanitizeTeam(raw: unknown): PlatformTeamSyncTeam | null {
  if (!raw || typeof raw !== 'object') return null;
  const t = raw as Record<string, unknown>;
  const teamId = typeof t.teamId === 'string' ? t.teamId.trim() : '';
  if (!teamId) return null;
  const teamName = typeof t.teamName === 'string' ? t.teamName : teamId;
  const groupChatIds = Array.isArray(t.groupChatIds)
    ? t.groupChatIds.filter((c): c is string => typeof c === 'string' && !!c.trim())
    : [];
  const bots: PlatformTeamBot[] = [];
  if (Array.isArray(t.bots)) {
    for (const b of t.bots) {
      if (!b || typeof b !== 'object') continue;
      const appId = typeof (b as Record<string, unknown>).appId === 'string' ? String((b as Record<string, unknown>).appId).trim() : '';
      if (!appId) continue;
      const unionId = typeof (b as Record<string, unknown>).unionId === 'string' ? String((b as Record<string, unknown>).unionId).trim() : '';
      const name = typeof (b as Record<string, unknown>).name === 'string' ? String((b as Record<string, unknown>).name) : undefined;
      bots.push({ appId, unionId: unionId || undefined, name });
    }
  }
  return { teamId, teamName, groupChatIds, bots };
}

/**
 * Apply a platform `team-sync` push: persist the payload (full-replace — it is
 * the platform's complete view of THIS machine's teams) and mirror the group
 * chats into team-groups.json under the platform prefix. Teams absent from the
 * payload (machine left the team / team deleted) drop out of both stores.
 */
export function applyPlatformTeamSync(
  dataDir: string,
  payload: { rev?: unknown; teams?: unknown },
  now: number = Date.now(),
): PlatformTeamSyncPayload | null {
  const rev = typeof payload?.rev === 'string' ? payload.rev.trim() : '';
  if (!rev) return null;
  const teams = (Array.isArray(payload?.teams) ? payload.teams : [])
    .map(sanitizeTeam)
    .filter((t): t is PlatformTeamSyncTeam => !!t);
  const shape: FileShape = { rev, teams, updatedAt: now };
  atomicWriteFileSync(filePath(dataDir), JSON.stringify(shape, null, 2) + '\n');
  replaceTeamGroupsByPrefix(
    dataDir,
    PLATFORM_TEAM_PREFIX,
    teams.flatMap(t => t.groupChatIds.map(chatId => ({ teamId: `${PLATFORM_TEAM_PREFIX}${t.teamId}`, chatId }))),
    now,
  );
  return { rev, teams };
}

/** The rev of the last applied team-sync ('' when none) — reported on
 *  register/heartbeat so the platform knows whether to re-push. */
export function getPlatformTeamSyncRev(dataDir: string): string {
  return readFile(dataDir)?.rev ?? '';
}

/** All platform teams this machine belongs to (last applied sync). */
export function listPlatformTeams(dataDir: string): PlatformTeamSyncTeam[] {
  return readFile(dataDir)?.teams ?? [];
}

/** Is `unionId` a bot in ANY platform team this machine belongs to? The auth
 *  gate's platform-mode predicate — membership-driven, no expiry. */
export function isPlatformTeamBot(dataDir: string, unionId: string | undefined): boolean {
  const id = (unionId ?? '').trim();
  if (!id) return false;
  const data = readFile(dataDir);
  if (!data) return false;
  for (const t of data.teams) {
    for (const b of t.bots) if (b.unionId === id) return true;
  }
  return false;
}
