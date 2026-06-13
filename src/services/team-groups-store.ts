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
