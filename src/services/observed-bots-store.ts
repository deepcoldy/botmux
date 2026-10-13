/**
 * Per-observer × per-chat persistent store of bot open_ids discovered via the
 * `/introduce` collaboration handshake.
 *
 * Why per-observer (file name includes the observing app's larkAppId):
 * - **Lark open_id is per-app scoped.** When Bot A's daemon receives
 *   `@A @B /introduce`, `mentions[i].id.open_id` for Bot B is
 *   `B_as_seen_by_A` — which is the right id for A to use when @-mentioning B.
 *   Bot B's daemon receives the same event but sees `B_as_seen_by_B` for the
 *   same entry. If both daemons wrote to one shared `observed-bots-<chatId>`
 *   file, A could later read B's self-view open_id and @ B with the wrong id.
 *   Per-observer files keep each daemon's view of the world consistent and
 *   correct for its own outbound traffic.
 *
 * Why also per-chat (file name includes chatId):
 * - Path-level isolation; lookups physically cannot leak entries from other
 *   chats. Avoids the "remembered to filter by chatId" foot-gun.
 *
 * Atomic writes via UNIQUE tmp + rename (pid + randomUUID): a fixed `.tmp`
 * suffix would race between concurrent writers (different processes or two
 * /introduce events in flight on the same app), causing rename ENOENT or one
 * writer's partial buffer being renamed into place.
 */
import { mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { isJsonObject, readJsonFileSoft } from '../utils/json-file.js';

const DEFAULT_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000;

export type ObservedBotSource = 'introduce';

export interface ObservedBot {
  openId: string;
  name: string;
  source: ObservedBotSource;
  firstSeenAt: number;
  lastSeenAt: number;
}

type FileEntry = { name: string; source: ObservedBotSource; firstSeenAt: number; lastSeenAt: number };
type FileShape = Record<string, FileEntry>;

function filePath(dataDir: string, larkAppId: string, chatId: string): string {
  return join(dataDir, `observed-bots-${larkAppId}-${chatId}.json`);
}

function readFile(dataDir: string, larkAppId: string, chatId: string): FileShape {
  // 损坏的文件被隔离为 .corrupt-*（而不是被下一次写入覆盖），见 utils/json-file.ts。
  return readJsonFileSoft<FileShape>(filePath(dataDir, larkAppId, chatId), {
    fallback: () => ({}),
    validate: isJsonObject,
    label: 'observed-bots-store',
  });
}

function writeFileAtomic(dataDir: string, larkAppId: string, chatId: string, data: FileShape): void {
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  // atomicWriteFileSync uses a unique tmp name (pid + random) so concurrent
  // writers don't clobber each other's in-flight bytes via a shared `.tmp`.
  atomicWriteFileSync(filePath(dataDir, larkAppId, chatId), JSON.stringify(data, null, 2) + '\n', { followTargetSymlink: false });
}

/**
 * Merge a batch of (openId, name) pairs into the observer's per-chat file.
 *
 * - Existing openIds: keep firstSeenAt, bump lastSeenAt, refresh name.
 * - New openIds: firstSeenAt = lastSeenAt = now.
 * - Entries with empty openId or empty name are silently skipped — callers
 *   pass through whatever Lark gave them, and we never want a half-known
 *   entry polluting the store.
 * - Empty input or all-filtered input is a no-op (no file write).
 *
 * `larkAppId` is the OBSERVING daemon's app id (i.e. whose perspective these
 * open_ids represent). Pass the receiving bot's `larkAppId`, not the sender's.
 */
export function recordObservedBots(
  dataDir: string,
  larkAppId: string,
  chatId: string,
  bots: ReadonlyArray<{ openId: string; name: string }>,
  source: ObservedBotSource = 'introduce',
  now: number = Date.now(),
): void {
  const valid = bots.filter(b => b.openId && b.name);
  if (valid.length === 0) return;

  const data = readFile(dataDir, larkAppId, chatId);
  for (const b of valid) {
    for (const [existingOpenId, entry] of Object.entries(data)) {
      if (entry.name === b.name && existingOpenId !== b.openId) {
        delete data[existingOpenId];
      }
    }

    const prior = data[b.openId];
    if (prior) {
      data[b.openId] = { ...prior, name: b.name, lastSeenAt: now };
    } else {
      data[b.openId] = { name: b.name, source, firstSeenAt: now, lastSeenAt: now };
    }
  }
  writeFileAtomic(dataDir, larkAppId, chatId, data);
}

/**
 * Return non-expired entries for the (observer, chat) pair. `maxAgeMs`
 * defaults to 30 days; pass a custom value (or `Infinity`) to override.
 * Order is unspecified — callers needing a deterministic order should sort
 * on their side.
 */
export function listObservedBots(
  dataDir: string,
  larkAppId: string,
  chatId: string,
  maxAgeMs: number = DEFAULT_EXPIRY_MS,
  now: number = Date.now(),
): ObservedBot[] {
  const data = readFile(dataDir, larkAppId, chatId);
  const out: ObservedBot[] = [];
  for (const [openId, entry] of Object.entries(data)) {
    if (now - entry.lastSeenAt > maxAgeMs) continue;
    out.push({ openId, name: entry.name, source: entry.source, firstSeenAt: entry.firstSeenAt, lastSeenAt: entry.lastSeenAt });
  }
  return out;
}
