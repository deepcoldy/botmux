/**
 * Linked worktrees botmux itself created with `git worktree add` (auto-worktree,
 * `/tw`, `/repo wt`, the repo card's worktree button, an independent XPI task).
 *
 * This is the ownership proof behind the session-closed card's「清理 worktree」
 * button: a directory the user picked, a worktree botmux merely reused, or a path
 * that was later deleted and re-created by someone else is never in here (the
 * record pins the directory's dev/ino at creation). Keyed by the resolved
 * directory and shared by every bot on the data dir, because worktrees and
 * sessions are too — a sibling bot's session may be the one that closes last.
 */
import { existsSync, lstatSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { withFileLockSync } from '../utils/file-lock.js';
import { logger } from '../utils/logger.js';
import { mainWorktreeFor } from './git-worktree.js';

export interface BotmuxWorktreeRecord {
  /** Resolved worktree root. */
  dir: string;
  /** Main checkout the worktree belongs to. */
  main: string;
  branch: string;
  /** Identity of the directory botmux created; a re-created path differs. */
  dev: number;
  ino: number;
  larkAppId?: string;
  createdAt: number;
}

type Store = Record<string, BotmuxWorktreeRecord>;

function storePath(dataDir: string): string {
  return join(dataDir, 'botmux-worktrees.json');
}

function readStore(path: string): Store {
  if (!existsSync(path)) return {};
  const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('invalid botmux worktree store');
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

/** Whether `record` still describes the directory on disk (same dev/ino). */
export function botmuxWorktreeIdentityMatches(record: BotmuxWorktreeRecord): boolean {
  try {
    const stat = lstatSync(record.dir);
    return stat.isDirectory() && stat.dev === record.dev && stat.ino === record.ino;
  } catch {
    return false;
  }
}

/** Record a worktree botmux just created. Entries whose directory is gone are
 *  dropped on the way, so the file only tracks worktrees that still exist. */
export function recordBotmuxWorktree(
  dataDir: string,
  input: { dir: string; main: string; branch: string; larkAppId?: string },
  now: number = Date.now(),
): BotmuxWorktreeRecord {
  const dir = resolve(input.dir);
  const stat = lstatSync(dir);
  if (!stat.isDirectory()) throw new Error(`not a directory: ${dir}`);
  mkdirSync(dataDir, { recursive: true });
  const path = storePath(dataDir);
  return withFileLockSync(path, () => {
    const store = readStore(path);
    for (const [key, record] of Object.entries(store)) {
      if (!existsSync(record.dir)) delete store[key];
    }
    const record: BotmuxWorktreeRecord = {
      dir,
      main: resolve(input.main),
      branch: input.branch,
      dev: stat.dev,
      ino: stat.ino,
      ...(input.larkAppId ? { larkAppId: input.larkAppId } : {}),
      createdAt: now,
    };
    store[dir] = record;
    writeStore(path, store);
    return record;
  });
}

/** The recorded worktree that is `path` or contains it (deepest match wins).
 *  Throws when the store is unreadable — callers treat that as "not offered". */
export function findBotmuxWorktreeFor(dataDir: string, path: string): BotmuxWorktreeRecord | undefined {
  const target = resolve(path);
  let best: BotmuxWorktreeRecord | undefined;
  for (const record of Object.values(readStore(storePath(dataDir)))) {
    if (target !== record.dir && !target.startsWith(record.dir + sep)) continue;
    if (!best || record.dir.length > best.dir.length) best = record;
  }
  return best;
}

export function deleteBotmuxWorktree(dataDir: string, dir: string): boolean {
  const path = storePath(dataDir);
  if (!existsSync(path)) return false;
  return withFileLockSync(path, () => {
    const store = readStore(path);
    const key = resolve(dir);
    if (!store[key]) return false;
    delete store[key];
    writeStore(path, store);
    return true;
  });
}

/**
 * Creation sites call this right after `git worktree add` succeeded. A reused
 * worktree is skipped (botmux did not create it). Best-effort: a failed write
 * only means the closed card offers no button, never a failed session start.
 */
export async function recordCreatedWorktree(
  larkAppId: string | undefined,
  creation: { path: string; branch: string; reused?: true },
): Promise<void> {
  if (creation.reused) return;
  try {
    recordBotmuxWorktree(config.session.dataDir, {
      dir: creation.path,
      main: await mainWorktreeFor(creation.path),
      branch: creation.branch,
      larkAppId,
    });
  } catch (err) {
    logger.warn(`[botmux-worktree] could not record created worktree ${creation.path}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
