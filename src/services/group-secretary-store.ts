/**
 * 群秘书（/secretary）开关登记：哪些普通群让本 bot 当「秘书」。
 *
 * 秘书开启后，本 bot 的 daemon 旁听该群全部消息、轮询本机所有 bot 在该群的会话
 * 状态，发现「做完一轮 / 卡住 / 被阻塞 / 进程没了」或「没 @ 任何 bot 的任务」时，
 * 把摘要作为静默回合送进本 bot 在该群的 chat 级会话，由模型决定是否催办 / 派活。
 * 判定与投递见 services/group-secretary-engine.ts 与 group-secretary-runtime.ts。
 *
 * 一个 daemon 只服务一个 bot：文件按 appId 分，`${dataDir}/group-secretary-${appId}.json`，
 * tmp + rename 原子写。开关是 per-chat 的，不写 bots.json（不影响 bot 其它配置的
 * 归一化与 Dashboard 编辑）。
 */
import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { logger } from '../utils/logger.js';

export interface GroupSecretaryChatEntry {
  /** 开启人（本 app 视角的 open_id）。秘书回合以此人的身份投递。 */
  enabledBy: string;
  /** 开启时间（epoch ms）。 */
  enabledAt: number;
}

interface GroupSecretaryFile {
  version: 1;
  chats: Record<string, GroupSecretaryChatEntry>;
}

const caches = new Map<string, GroupSecretaryFile>();

function filePath(larkAppId: string, dataDir = config.session.dataDir): string {
  return join(dataDir, `group-secretary-${larkAppId}.json`);
}

function load(larkAppId: string): GroupSecretaryFile {
  const cached = caches.get(larkAppId);
  if (cached) return cached;
  let parsed: GroupSecretaryFile = { version: 1, chats: {} };
  const path = filePath(larkAppId);
  if (existsSync(path)) {
    try {
      const raw = JSON.parse(readFileSync(path, 'utf-8'));
      if (raw && typeof raw === 'object' && raw.chats && typeof raw.chats === 'object') {
        const chats: Record<string, GroupSecretaryChatEntry> = {};
        for (const [chatId, entry] of Object.entries(raw.chats as Record<string, any>)) {
          if (!chatId.startsWith('oc_')) continue;
          if (!entry || typeof entry.enabledBy !== 'string' || !entry.enabledBy) continue;
          chats[chatId] = {
            enabledBy: entry.enabledBy,
            enabledAt: Number.isFinite(entry.enabledAt) ? entry.enabledAt : 0,
          };
        }
        parsed = { version: 1, chats };
      }
    } catch (err) {
      logger.warn(`[group-secretary] failed to read ${path}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  caches.set(larkAppId, parsed);
  return parsed;
}

function persist(larkAppId: string, data: GroupSecretaryFile): void {
  const path = filePath(larkAppId);
  mkdirSync(dirname(path), { recursive: true });
  atomicWriteFileSync(path, JSON.stringify(data, null, 2));
}

export function getGroupSecretaryChat(larkAppId: string, chatId: string): GroupSecretaryChatEntry | undefined {
  return load(larkAppId).chats[chatId];
}

export function isGroupSecretaryChat(larkAppId: string, chatId: string | undefined): boolean {
  return !!chatId && !!load(larkAppId).chats[chatId];
}

export function listGroupSecretaryChats(larkAppId: string): Array<{ chatId: string } & GroupSecretaryChatEntry> {
  return Object.entries(load(larkAppId).chats).map(([chatId, entry]) => ({ chatId, ...entry }));
}

/** 写盘失败时内存不变（调用方据返回值回执用户）。 */
export function setGroupSecretaryChat(
  larkAppId: string,
  chatId: string,
  entry: GroupSecretaryChatEntry | null,
): { ok: true } | { ok: false; reason: string } {
  const current = load(larkAppId);
  const next: GroupSecretaryFile = { version: 1, chats: { ...current.chats } };
  if (entry) next.chats[chatId] = entry;
  else delete next.chats[chatId];
  try {
    persist(larkAppId, next);
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
  caches.set(larkAppId, next);
  return { ok: true };
}

/** 测试隔离用。 */
export function resetGroupSecretaryStoreCache(): void {
  caches.clear();
}
