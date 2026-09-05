/**
 * Durable, app-scoped provenance for DM topics explicitly materialized by /t.
 *
 * Default P2P routing deliberately folds root_id + thread_id replies into one
 * chat-scope session. A /t-created topic is the exception, including a bare /t
 * that intentionally creates no Session yet. Active-session ownership alone
 * cannot represent that setup-only state and also has a short registration race,
 * so the dispatcher records the explicit user intent before releasing its raw
 * per-chat routing lane.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { logger } from '../utils/logger.js';

const MAX_ROOTS_PER_APP = 10_000;

type RootRecord = { chatId: string; createdAt: number };
type RootStore = Record<string, RootRecord>;

const caches = new Map<string, Map<string, RootRecord>>();

function fileFor(larkAppId: string): string {
  return join(config.session.dataDir, 'p2p-force-topic-roots', `${larkAppId}.json`);
}

function load(larkAppId: string): Map<string, RootRecord> {
  const cached = caches.get(larkAppId);
  if (cached) return cached;

  const roots = new Map<string, RootRecord>();
  const file = fileFor(larkAppId);
  try {
    if (existsSync(file)) {
      const parsed = JSON.parse(readFileSync(file, 'utf-8')) as RootStore;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const entries = Object.entries(parsed)
          .filter((entry): entry is [string, RootRecord] => {
            const [rootId, record] = entry;
            return !!rootId
              && !!record
              && typeof record === 'object'
              && typeof record.chatId === 'string'
              && record.chatId.length > 0
              && typeof record.createdAt === 'number'
              && Number.isFinite(record.createdAt);
          })
          .sort((a, b) => a[1].createdAt - b[1].createdAt)
          .slice(-MAX_ROOTS_PER_APP);
        for (const entry of entries) roots.set(...entry);
      }
    }
  } catch (err) {
    logger.warn(`[p2p-force-topic] failed to load ${file}: ${err}`);
  }
  caches.set(larkAppId, roots);
  return roots;
}

function persist(larkAppId: string, roots: Map<string, RootRecord>): void {
  const file = fileFor(larkAppId);
  try {
    mkdirSync(dirname(file), { recursive: true });
    atomicWriteFileSync(file, `${JSON.stringify(Object.fromEntries(roots), null, 2)}\n`, { mode: 0o600 });
  } catch (err) {
    // Keep the in-process marker even if persistence is temporarily unavailable.
    logger.warn(`[p2p-force-topic] failed to persist ${file}: ${err}`);
  }
}

export function recordP2pForceTopicRoot(larkAppId: string, rootId: string, chatId: string): void {
  if (!larkAppId || !rootId || !chatId) return;
  const roots = load(larkAppId);
  roots.delete(rootId);
  roots.set(rootId, { chatId, createdAt: Date.now() });
  while (roots.size > MAX_ROOTS_PER_APP) {
    const oldest = roots.keys().next().value as string | undefined;
    if (!oldest) break;
    roots.delete(oldest);
  }
  persist(larkAppId, roots);
}

export function isP2pForceTopicRoot(larkAppId: string, rootId: string, chatId: string): boolean {
  if (!larkAppId || !rootId || !chatId) return false;
  return load(larkAppId).get(rootId)?.chatId === chatId;
}

/** Test-only: simulate a daemon restart without touching persisted files. */
export function __resetP2pForceTopicRootsForTest(): void {
  caches.clear();
}
