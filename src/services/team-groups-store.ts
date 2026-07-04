// 团队协作群绑定：dashboard 团队页发起建群成功后记录 teamId↔chatId。
// 看板的团队筛选用它识别「dashboard 发起的协作群」（另一半靠 /introduce
// 记录 + 团队 roster 名字匹配识别手动协作群）。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFileSync } from '../utils/atomic-write.js';

export interface TeamGroupBinding {
  teamId: string;
  chatId: string;
  createdAt: number;
}

function filePath(dataDir: string): string {
  return join(dataDir, 'team-groups.json');
}

export function listTeamGroups(dataDir: string, teamId?: string): TeamGroupBinding[] {
  let arr: TeamGroupBinding[] = [];
  try {
    const raw = JSON.parse(readFileSync(filePath(dataDir), 'utf-8'));
    if (Array.isArray(raw)) arr = raw.filter(b => b && typeof b.teamId === 'string' && typeof b.chatId === 'string');
  } catch {
    // 文件不存在/损坏 → 视为无绑定
  }
  return teamId === undefined ? arr : arr.filter(b => b.teamId === teamId);
}

export function recordTeamGroup(dataDir: string, teamId: string, chatId: string, now: number = Date.now()): void {
  if (!teamId || !chatId) return;
  const all = listTeamGroups(dataDir);
  if (all.some(b => b.teamId === teamId && b.chatId === chatId)) return;
  all.push({ teamId, chatId, createdAt: now });
  atomicWriteFileSync(filePath(dataDir), JSON.stringify(all, null, 2) + '\n');
}

/**
 * Replace ALL entries whose teamId starts with `prefix` by `groups`, leaving
 * other entries (e.g. legacy federation teams) untouched. Used by the platform
 * team-sync mirror ([[platform-team-store]], prefix `platform:`): the platform
 * push is the authoritative full view, so removal must work — append-only
 * recordTeamGroup can't drop a dissolved hall / left team. Survivors keep
 * their original createdAt.
 */
export function replaceTeamGroupsByPrefix(
  dataDir: string,
  prefix: string,
  groups: Array<{ teamId: string; chatId: string }>,
  now: number = Date.now(),
): void {
  if (!prefix) return;
  const all = listTeamGroups(dataDir);
  const kept = all.filter(b => !b.teamId.startsWith(prefix));
  const prior = new Map(all.filter(b => b.teamId.startsWith(prefix)).map(b => [`${b.teamId}\u0000${b.chatId}`, b]));
  const seen = new Set<string>();
  for (const g of groups) {
    if (!g.teamId.startsWith(prefix) || !g.chatId) continue; // caller must pre-prefix — never let platform data shadow legacy ids
    const key = `${g.teamId}\u0000${g.chatId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(prior.get(key) ?? { teamId: g.teamId, chatId: g.chatId, createdAt: now });
  }
  atomicWriteFileSync(filePath(dataDir), JSON.stringify(kept, null, 2) + '\n');
}

/** Is `chatId` a team-assembled (拉群) group of ANY team? This is the TRUST ROOT
 *  for team-bot collaboration: such a group is built by the team (bots added by
 *  larkAppId from the federated roster), so a bot speaking there is a vouched
 *  teammate (see [[team-bots-store]]). Recorded on the orchestrating deployment
 *  by recordTeamGroup, and mirrored onto member deployments when the hub returns
 *  groupChatIds on federation sync — so every member's auth gate sees the same
 *  trust boundary. Platform-mode 拉群 groups land here too, mirrored from
 *  team-sync under the `platform:` teamId prefix (see [[platform-team-store]]). */
export function isTeamGroupChat(dataDir: string, chatId: string | undefined): boolean {
  if (!chatId) return false;
  return listTeamGroups(dataDir).some(b => b.chatId === chatId);
}
