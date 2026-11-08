import { realpath } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { SkillFeedbackStore } from './skill-feedback-store.js';
import { FeedbackAnalyticsService } from './feedback-analytics.js';
import { readFeedbackStorageConfig, readFeedbackStorageSecret, readPostgresCredential } from './feedback-storage-config.js';
import type { FeedbackAnalytics, FeedbackStore, FeedbackStorageConfig } from './feedback-storage-types.js';
// The PostgreSQL-backed modules value-import `pg`. They are loaded lazily
// inside openStorage's postgresql branch so this selector — used by every
// SQLite write and by daemon/dashboard startup — works in installs where the
// optional pg dependency is absent.

export interface FeedbackStorage {
  store: FeedbackStore;
  analytics: FeedbackAnalytics;
  generation: number;
}

const entries = new Map<string, { identity: string; value: Promise<FeedbackStorage> }>();
const operations = new Map<string, Promise<unknown>>();

function serialized<Result>(key: string, operation: () => Promise<Result>): Promise<Result> {
  const previous = operations.get(key) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(operation);
  operations.set(key, next);
  void next.finally(() => {
    if (operations.get(key) === next) operations.delete(key);
  }).catch(() => {});
  return next;
}

async function openStorage(dataDir: string, config: FeedbackStorageConfig): Promise<FeedbackStorage> {
  if (config.active.backend === 'postgresql') {
    const target = config.active.postgres;
    const password = await readPostgresCredential(dataDir, target);
    const ca = target.tls.caRef ? await readFeedbackStorageSecret(dataDir, target.tls.caRef) : undefined;
    const [{ openPostgresFeedbackStore }, { openPostgresFeedbackAnalytics }] = await Promise.all([
      import('./feedback-postgres-store.js'),
      import('./feedback-postgres-analytics.js'),
    ]);
    const store = await openPostgresFeedbackStore(target, password, config.instanceId, ca);
    try {
      const analytics = await openPostgresFeedbackAnalytics(target, password, ca);
      const close = store.close.bind(store);
      store.close = async () => { await analytics.close(); await close(); };
      return { store, analytics, generation: config.generation };
    } catch (error) { await store.close(); throw error; }
  }
  const sqlite = await SkillFeedbackStore.open(dataDir);
  let analytics: FeedbackAnalyticsService;
  try {
    analytics = new FeedbackAnalyticsService(dataDir);
  } catch (error) {
    sqlite.close();
    throw error;
  }
  let closed = false;
  let queue: Promise<unknown> = Promise.resolve();
  const invoke = <Result>(operation: () => Result): Promise<Awaited<Result>> => {
    const next = queue.catch(() => {}).then(() => {
      if (closed) throw new Error('feedback_storage_closed');
      return operation();
    });
    queue = next;
    return next as Promise<Awaited<Result>>;
  };
  const wrap = <Target extends object, Result>(target: Target): Result => new Proxy(target, {
    get(object, property) {
      const method = Reflect.get(object, property);
      if (typeof method !== 'function') return undefined;
      if (property === 'close') {
        return async () => {
          await queue.catch(() => {});
          if (closed) return;
          closed = true;
          analytics.close();
          sqlite.close();
        };
      }
      return (...args: unknown[]) => invoke(() => Reflect.apply(method, object, args));
    },
  }) as unknown as Result;
  return { store: wrap<SkillFeedbackStore, FeedbackStore>(sqlite), analytics: wrap<FeedbackAnalyticsService, FeedbackAnalytics>(analytics), generation: config.generation };
}

export async function getFeedbackStorage(dataDir: string): Promise<FeedbackStorage> {
  let key = resolve(dataDir);
  try { key = realpathSync(dataDir); } catch {}
  return serialized(key, async () => {
    const config = await readFeedbackStorageConfig(key);
    const identity = JSON.stringify([config.instanceId, config.active]);
    const existing = entries.get(key);
    if (existing?.identity === identity) {
      const storage = await existing.value;
      storage.generation = config.generation;
      return storage;
    }
    if (existing) {
      entries.delete(key);
      try { await (await existing.value).store.close(); } catch {}
    }
    const value = openStorage(key, config);
    const entry = { identity, value };
    entries.set(key, entry);
    try {
      return await value;
    } catch (error) {
      if (entries.get(key) === entry) entries.delete(key);
      throw error;
    }
  });
}

export async function closeFeedbackStorage(dataDir: string): Promise<void> {
  const key = await realpath(dataDir).catch(() => resolve(dataDir));
  await serialized(key, async () => {
    const entry = entries.get(key);
    entries.delete(key);
    if (entry) await (await entry.value).store.close();
  });
}

export async function closeAllFeedbackStorage(): Promise<void> {
  await Promise.allSettled([...operations.values()]);
  await Promise.all([...entries.keys()].map(closeFeedbackStorage));
}
