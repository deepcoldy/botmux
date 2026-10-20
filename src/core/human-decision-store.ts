/**
 * Generic durable storage for human decisions.
 *
 * Ask and post-completion proposals have different product semantics, but they
 * share the same file-system invariants: stable scoped identity, atomic writes,
 * restart recovery, per-record serialization, and sentinel-guarded ownership.
 * Adapters own their schemas and expiry policy; this module only owns safe I/O.
 */
import { createHash } from 'node:crypto';
import {
  constants as fsConstants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { withFileLockSync } from '../utils/file-lock.js';

export const HUMAN_DECISION_STORE_SENTINEL = '.botmux-human-decision-store';

export interface PersistedHumanDecision {
  /** Adapter-owned schema version. */
  v: number;
  /** Stable full identity; hashed only for the file name. */
  decisionKey?: string;
  /** Legacy ask records use askKey. Kept for zero-copy migration. */
  askKey?: string;
}

export interface HumanDecisionStore {
  readonly dir: string;
  put(record: PersistedHumanDecision): void;
  get(decisionKey: string): PersistedHumanDecision | undefined;
  remove(decisionKey: string): void;
  list(): PersistedHumanDecision[];
  mutate<T>(
    decisionKey: string,
    update: (record: PersistedHumanDecision | undefined) => {
      record?: PersistedHumanDecision;
      result: T;
    },
    options?: { maxWaitMs?: number },
  ): T;
}

export type HumanDecisionGateOutcome =
  | 'ready'
  | 'stale'
  | 'unauthorized'
  | 'already_settled'
  | 'expired';

/**
 * Shared click gate. Authorization is an adapter-supplied fact: Ask injects its
 * canTalk verdict, while Completion Proposal injects exact-requester equality.
 */
export function gateHumanDecisionAttempt(input: {
  exists: boolean;
  nonceMatches: boolean;
  settled: boolean;
  authorized: boolean;
  expired?: boolean;
}): HumanDecisionGateOutcome {
  if (!input.exists || !input.nonceMatches) return 'stale';
  if (input.settled) return 'already_settled';
  if (!input.authorized) return 'unauthorized';
  if (input.expired) return 'expired';
  return 'ready';
}

function boundedKey(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096 && !value.includes('\0');
}

function recordKey(record: PersistedHumanDecision): string {
  const key = boundedKey(record.decisionKey)
    ? record.decisionKey
    : boundedKey(record.askKey)
      ? record.askKey
      : undefined;
  if (!key) throw new Error('human_decision_key_invalid');
  return key;
}

function fileNameForKey(decisionKey: string): string {
  if (!boundedKey(decisionKey)) throw new Error('human_decision_key_invalid');
  return `${createHash('sha256').update(decisionKey).digest('hex')}.json`;
}

function readRegularJson(path: string): PersistedHumanDecision | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const value = JSON.parse(readFileSync(fd, 'utf8')) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const record = value as PersistedHumanDecision;
    recordKey(record);
    return record;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
  }
}

export function humanDecisionKeyFor(...segments: readonly string[]): string {
  return segments.map((segment) => {
    const raw = String(segment);
    return `${raw.length}:${raw}`;
  }).join('|');
}

export function humanDecisionDispatchUuidForKey(
  decisionKey: string,
  prefix = 'decision',
): string {
  if (!/^[a-z][a-z0-9-]{0,8}$/.test(prefix)) throw new Error('human_decision_uuid_prefix_invalid');
  return `${prefix}-${createHash('sha256').update(`uuid|${decisionKey}`).digest('hex').slice(0, 40)}`;
}

/**
 * Create a store at an explicit directory. `legacySentinels` lets the existing
 * ask directory retain its historical teardown marker while the implementation
 * becomes shared by more than the Ask adapter.
 */
export function createHumanDecisionStore(
  dir: string,
  options: { legacySentinels?: readonly string[] } = {},
): HumanDecisionStore {
  const pathFor = (key: string): string => join(dir, fileNameForKey(key));

  function ensureDir(): void {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const stat = lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('human_decision_store_dir_unsafe');
    for (const sentinel of [HUMAN_DECISION_STORE_SENTINEL, ...(options.legacySentinels ?? [])]) {
      const path = join(dir, sentinel);
      if (!existsSync(path)) writeFileSync(path, 'botmux human decision store\n', { mode: 0o600 });
    }
  }

  function write(path: string, record: PersistedHumanDecision): void {
    const key = recordKey(record);
    if (path !== pathFor(key)) throw new Error('human_decision_store_key_mismatch');
    atomicWriteFileSync(path, JSON.stringify(record), {
      mode: 0o600,
      durable: true,
      followTargetSymlink: false,
    });
  }

  return {
    dir,
    put(record): void {
      ensureDir();
      const key = recordKey(record);
      const path = pathFor(key);
      withFileLockSync(path, () => write(path, record));
    },
    get(decisionKey): PersistedHumanDecision | undefined {
      const path = pathFor(decisionKey);
      if (!existsSync(path)) return undefined;
      return readRegularJson(path);
    },
    remove(decisionKey): void {
      const path = pathFor(decisionKey);
      try { unlinkSync(path); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    },
    list(): PersistedHumanDecision[] {
      if (!existsSync(dir)) return [];
      let names: string[];
      try { names = readdirSync(dir).filter(name => /^[0-9a-f]{64}\.json$/.test(name)); }
      catch { return []; }
      const records: PersistedHumanDecision[] = [];
      for (const name of names) {
        const path = join(dir, name);
        const record = readRegularJson(path);
        if (record) records.push(record);
        else {
          try { unlinkSync(path); } catch { /* ignore corrupt entries */ }
        }
      }
      return records;
    },
    mutate<T>(decisionKey: string, update: (record: PersistedHumanDecision | undefined) => {
      record?: PersistedHumanDecision;
      result: T;
    }, mutateOptions: { maxWaitMs?: number } = {}): T {
      ensureDir();
      const path = pathFor(decisionKey);
      return withFileLockSync(path, () => {
        const current = existsSync(path) ? readRegularJson(path) : undefined;
        if (existsSync(path) && !current) throw new Error('human_decision_record_corrupt');
        const next = update(current);
        if (next.record) write(path, next.record);
        else if (current) {
          try { unlinkSync(path); } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          }
        }
        return next.result;
      }, mutateOptions);
    },
  };
}
