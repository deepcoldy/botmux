import { withManagedDirectories } from '../services/managed-directory-retention.js';
/**
 * `bots.json` 原子读写. Codex review 边界 #2 + #3:
 * - tmp 文件必须和 `bots.json` 同目录, 保证 `renameSync` 在同 fs 下原子覆盖
 * - 任意写入失败不留半截 JSON (renameSync 之前一切失败都不影响旧文件)
 * - 文件权限 0o600 (只有用户自己能读), secret 不外泄给同机器人其它用户
 */
import { writeFileSync, renameSync, existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { withFileLockSync } from '../utils/file-lock.js';
import { assertCodexInstanceConfigWrite } from '../services/codex-instance-config-guard.js';
import { assertQuotaFallbackGraphAcyclic } from '../services/quota-fallback.js';
import { assertChangedBotConfigInvariants } from '../services/bot-config-invariants.js';
import { assertDurableConfigMutationAllowed } from '../services/durable-config-mutation.js';
import { assertNextBotsGenerationContent } from '../services/config-store.js';

export interface BotsJsonMutation<T> {
  bots: any[];
  result: T;
}

export interface BotsJsonMutationContext {
  /** Exact file contents at the locked read; null means the file did not exist. */
  revision: string | null;
}

interface BotsJsonSnapshot {
  path: string;
  revision: string | null;
}

// Snapshot identity deliberately lives out-of-band: bots.json rows remain plain
// JSON data and bookkeeping cannot leak into a committed generation.
const snapshots = new WeakMap<readonly any[], BotsJsonSnapshot>();

/** A whole-file writer's source generation no longer matches the locked file. */
export class BotsJsonStaleSnapshotError extends Error {
  readonly code = 'BOTS_JSON_STALE_SNAPSHOT' as const;
  constructor(readonly botsJsonPath: string) {
    super(
      `bots.json changed since it was read; refusing to overwrite newer changes: ${botsJsonPath}. `
      + 'Re-read the configuration and retry the edit.',
    );
    this.name = 'BotsJsonStaleSnapshotError';
  }
}

/** Attach the exact source generation returned by a bots.json reader. */
export function trackBotsJsonSnapshot<T extends any[]>(
  bots: T,
  botsJsonPath: string,
  revision: string | null,
): T {
  snapshots.set(bots, { path: resolve(botsJsonPath), revision });
  return bots;
}

/**
 * Cross-process read-modify-write under ONE non-reentrant file lock.
 *
 * The callback runs against the latest on-disk generation. It must return a new
 * array rather than relying on an earlier caller snapshot; otherwise two
 * processes can each append to a different stale array and the later rename
 * silently discards the other one's update. Keep the callback synchronous:
 * yielding while holding this lock would also block the process's own writer.
 */
export function mutateBotsJsonAtomic<T>(
  botsJsonPath: string,
  mutation: (previous: any[], context: BotsJsonMutationContext) => BotsJsonMutation<T>,
): T {
  assertDurableConfigMutationAllowed('bots');
  return withFileLockSync(botsJsonPath, () => {
    // Compare exact contents rather than mtime: atomic rename, coarse filesystem
    // timestamps and same-ms writes must not make two generations look equal.
    const revision = existsSync(botsJsonPath) ? readFileSync(botsJsonPath, 'utf8') : null;
    const previous = revision === null ? [] : JSON.parse(revision) as any[];
    const { bots, result } = mutation(previous, { revision });
    assertCodexInstanceConfigWrite(previous, bots);
    assertChangedBotConfigInvariants(previous, bots);
    assertQuotaFallbackGraphAcyclic(bots);
    // Same loader-level gate as the daemon's writeRawConfigAtomic: never persist
    // a changed entry parseBotConfigsFromText would reject on the next startup.
    assertNextBotsGenerationContent(previous, bots);
    // 注意: tmp 必须在同一目录下 (同 fs), 否则 rename 可能跨文件系统失败.
    const tmp = botsJsonPath + '.tmp';
    withManagedDirectories(bots, () => {
      writeFileSync(tmp, JSON.stringify(bots, null, 2) + '\n', { mode: 0o600 });
      renameSync(tmp, botsJsonPath);
    }, undefined, botsJsonPath);
    return result;
  });
}

/**
 * Write a caller-assembled generation without overwriting a newer generation.
 *
 * `snapshotSource` is the array returned by the original read. A derived next
 * array (spread/slice/map) must pass that source explicitly; null documents an
 * intentionally untracked write, used for new files and tests with no reader.
 * The check runs AFTER acquiring the lock, so non-FIFO lock acquisition cannot
 * make an older operation overwrite a rename that committed in the meantime.
 */
export function writeBotsJsonAtomic(
  botsJsonPath: string,
  bots: any[],
  snapshotSource: readonly any[] | null,
): void {
  mutateBotsJsonAtomic(botsJsonPath, (_previous, { revision }) => {
    if (snapshotSource === undefined) {
      throw new Error('writeBotsJsonAtomic requires an explicit snapshot source (or null for an untracked write)');
    }
    const snapshot = snapshotSource ? snapshots.get(snapshotSource) : undefined;
    if (snapshotSource && !snapshot) {
      throw new Error('writeBotsJsonAtomic snapshot source was not captured by a bots.json reader');
    }
    // Reading one path and intentionally writing another remains supported.
    if (snapshot && snapshot.path === resolve(botsJsonPath) && snapshot.revision !== revision) {
      throw new BotsJsonStaleSnapshotError(botsJsonPath);
    }
    return { bots, result: undefined };
  });
}

export function readBotsJsonOrEmpty(botsJsonPath: string): any[] {
  if (!existsSync(botsJsonPath)) return trackBotsJsonSnapshot([], botsJsonPath, null);
  try {
    const revision = readFileSync(botsJsonPath, 'utf8');
    const bots = JSON.parse(revision);
    // Preserve the legacy read helper's permissive scalar/object behavior; only
    // arrays can serve as whole-file snapshot sources for the writer.
    return Array.isArray(bots) ? trackBotsJsonSnapshot(bots, botsJsonPath, revision) : bots;
  } catch {
    return [];
  }
}
