/**
 * Self bot union_id store: each LOCAL bot's own tenant-stable `union_id`.
 *
 * Why we need it: the platform aggregates a team roster of bot union_ids and
 * pushes it to member deployments (see [[platform-team-store]]), so receivers
 * can trust a teammate bot in ANY chat without /grant. But a bot cannot ask
 * Feishu for its own union_id — /bot/v3/info doesn't return it and the contact
 * API can't resolve bot open_ids. Two event-borne sources exist:
 * - @mention 盖章（主腿）: mentions[] 里每个被 @ 实体都带 union_id，且 @ 驱动
 *   的事件投递不需要额外 scope——bot 在任何群被 @ 一次就学到自己的 union_id。
 * - 自家消息回声（兜底）: bot 发的群消息回推自己 daemon 时 sender.sender_id
 *   带 union_id——但仅限有 receive-all 群消息 scope 的应用，且 bot-only 大厅
 *   实测完全不推事件，回声独木难支。
 *
 * Written from the event dispatcher (once per bot — idempotent), read by the
 * platform tunnel heartbeat (PlatformBotInfo.unionId).
 *
 * Storage: `{dataDir}/bot-union-ids.json` — { [larkAppId]: { unionId, learnedAt } }
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFileSync } from '../utils/atomic-write.js';

type FileEntry = { unionId: string; learnedAt: number };
type FileShape = Record<string, FileEntry>;

function filePath(dataDir: string): string {
  return join(dataDir, 'bot-union-ids.json');
}

function readFile(dataDir: string): FileShape {
  const fp = filePath(dataDir);
  if (!existsSync(fp)) return {};
  try {
    const parsed = JSON.parse(readFileSync(fp, 'utf-8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as FileShape;
  } catch { /* corrupt — fall through */ }
  return {};
}

/** This bot's own learned union_id, or undefined if not yet echoed. */
export function getBotUnionId(dataDir: string, larkAppId: string): string | undefined {
  const id = (larkAppId ?? '').trim();
  if (!id) return undefined;
  return readFile(dataDir)[id]?.unionId;
}

/**
 * Persist a bot's own union_id learned from its message echo. Returns true iff
 * the store changed (first learn or a corrected value), so callers can log
 * exactly once. No-op on empty ids.
 */
export function recordBotUnionId(
  dataDir: string,
  larkAppId: string,
  unionId: string,
  now: number = Date.now(),
): boolean {
  const app = (larkAppId ?? '').trim();
  const uid = (unionId ?? '').trim();
  if (!app || !uid) return false;
  const data = readFile(dataDir);
  if (data[app]?.unionId === uid) return false;
  data[app] = { unionId: uid, learnedAt: now };
  atomicWriteFileSync(filePath(dataDir), JSON.stringify(data, null, 2) + '\n');
  return true;
}

/** A mention entry from a Lark message event (shape-tolerant subset). */
type MentionLike = { id?: { open_id?: string; union_id?: string } | string };

/**
 * Learn our OWN union_id from a message's mentions[]: Lark stamps every
 * mentioned entity with its union_id. Matches self strictly by open_id（app_id
 * 形态的 mention 不带 union_id，无从学起，忽略）。Returns true iff the store
 * changed. Idempotent — safe to call on every event.
 */
export function recordBotUnionIdFromMentions(
  dataDir: string,
  larkAppId: string,
  selfOpenId: string | undefined,
  mentions: MentionLike[] | undefined,
  now: number = Date.now(),
): boolean {
  if (!selfOpenId || !mentions?.length) return false;
  for (const m of mentions) {
    const id = m && typeof m.id === 'object' ? m.id : undefined;
    if (id?.open_id === selfOpenId && typeof id.union_id === 'string' && id.union_id.trim()) {
      return recordBotUnionId(dataDir, larkAppId, id.union_id, now);
    }
  }
  return false;
}
