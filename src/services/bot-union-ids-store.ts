/**
 * Self bot union_id store: each LOCAL bot's own tenant-stable `union_id`.
 *
 * Why we need it: the platform aggregates a team roster of bot union_ids and
 * pushes it to member deployments (see [[platform-team-store]]), so receivers
 * can trust a teammate bot in ANY chat without /grant. But a bot cannot ask
 * Feishu for its own union_id — /bot/v3/info doesn't return it and the contact
 * API can't resolve bot open_ids. The only reliable source is the bot's own
 * message ECHO: a group message the bot sends is delivered back to its own
 * daemon (im:message.group_msg) with `sender.sender_id.union_id` stamped.
 *
 * Written from the event dispatcher's self-message branch (once per bot —
 * idempotent), read by the platform tunnel heartbeat (PlatformBotInfo.unionId).
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
