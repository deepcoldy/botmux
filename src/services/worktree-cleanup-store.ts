import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { withFileLockSync } from '../utils/file-lock.js';

export interface WorktreeCleanupJob {
  id: string;
  larkAppId: string;
  worktreeMain: string;
  worktreeDir: string;
  safetyFingerprint: string;
  error: string;
  createdAt: number;
  updatedAt: number;
}

type Store = Record<string, WorktreeCleanupJob>;

function storePath(dataDir: string): string {
  return join(dataDir, 'worktree-cleanup-jobs.json');
}

function readStore(path: string): Store {
  if (!existsSync(path)) return {};
  const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('invalid worktree cleanup job store');
  }
  return parsed as Store;
}

function writeStore(path: string, value: Store): void {
  atomicWriteFileSync(path, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
    durable: true,
    followTargetSymlink: false,
  });
}

function jobId(worktreeDir: string): string {
  return createHash('sha256').update(resolve(worktreeDir)).digest('hex').slice(0, 16);
}

export function putWorktreeCleanupJob(
  dataDir: string,
  input: Omit<WorktreeCleanupJob, 'id' | 'createdAt' | 'updatedAt'>,
  now: number = Date.now(),
): WorktreeCleanupJob {
  mkdirSync(dataDir, { recursive: true });
  const path = storePath(dataDir);
  return withFileLockSync(path, () => {
    const store = readStore(path);
    const id = jobId(input.worktreeDir);
    const job: WorktreeCleanupJob = {
      ...input,
      id,
      worktreeMain: resolve(input.worktreeMain),
      worktreeDir: resolve(input.worktreeDir),
      createdAt: store[id]?.createdAt ?? now,
      updatedAt: now,
    };
    store[id] = job;
    writeStore(path, store);
    return job;
  });
}

export function getWorktreeCleanupJob(dataDir: string, id: string): WorktreeCleanupJob | undefined {
  const path = storePath(dataDir);
  return withFileLockSync(path, () => readStore(path)[id]);
}

export function deleteWorktreeCleanupJob(dataDir: string, id: string): boolean {
  const path = storePath(dataDir);
  return withFileLockSync(path, () => {
    const store = readStore(path);
    if (!store[id]) return false;
    delete store[id];
    writeStore(path, store);
    return true;
  });
}
