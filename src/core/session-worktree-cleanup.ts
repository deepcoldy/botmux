/**
 * The session-closed card's「清理 worktree」button (#698): botmux never reclaims
 * the worktrees it creates on its own (a closed session may still be under
 * review), so a person decides — and only for a worktree botmux itself created.
 *
 * Refuses, and says why, whenever deleting could lose work or pull a directory
 * out from under someone: uncommitted or untracked changes, unpushed commits,
 * an active session in the directory, a process whose cwd is inside it, or any
 * of those checks being unanswerable. Deletion is `git worktree remove` without
 * `--force`; the branch is never touched. Everything is re-proven from the
 * session row and the creation record at click time — the card carries only the
 * session id.
 */
import { existsSync, realpathSync } from 'node:fs';
import { config } from '../config.js';
import {
  isLinkedWorktree,
  mainWorktreeFor,
  removeCleanWorktree,
  withWorktreeTargetLock,
  worktreeRootFor,
  worktreeSafetyStatus,
} from '../services/git-worktree.js';
import {
  botmuxWorktreeIdentityMatches,
  deleteBotmuxWorktree,
  findBotmuxWorktreeFor,
  type BotmuxWorktreeRecord,
} from '../services/botmux-worktree-store.js';
import * as sessionStore from '../services/session-store.js';
import { findProcessesWithCwdUnder, type DirProcessProbe } from '../utils/dir-process-probe.js';
import type { Session } from '../types.js';

export type SessionWorktreeBlockReason =
  | { kind: 'uncommitted'; count: number }
  | { kind: 'unpushed'; count: number }
  | { kind: 'sessions'; count: number }
  | { kind: 'processes'; count: number }
  | { kind: 'sessions_unknown'; error: string }
  | { kind: 'processes_unknown'; error: string }
  | { kind: 'status_unknown'; error: string };

export type SessionWorktreeCleanupOutcome =
  | { status: 'removed'; dir: string; branch: string }
  | { status: 'blocked'; dir: string; reasons: SessionWorktreeBlockReason[] }
  | { status: 'gone'; dir: string }
  | { status: 'not_botmux' }
  | { status: 'session_active' }
  | { status: 'session_missing' }
  | { status: 'failed'; dir: string; error: string };

export interface SessionWorktreeCleanupDeps {
  dataDir: string;
  getSession: (sessionId: string) => Session | undefined;
  /** Active sessions (any bot) whose working dir is in `dir`; throws when the
   *  inventory cannot be read completely. */
  activeSessionsUsing: (dir: string) => Session[];
  processesUsing: (dir: string) => Promise<DirProcessProbe>;
}

export function defaultSessionWorktreeCleanupDeps(): SessionWorktreeCleanupDeps {
  return {
    dataDir: config.session.dataDir,
    getSession: sessionId => sessionStore.getSession(sessionId),
    activeSessionsUsing: dir => sessionStore.findActiveSessionsByWorkingDirStrict(dir),
    processesUsing: dir => findProcessesWithCwdUnder(dir),
  };
}

const message = (err: unknown) => err instanceof Error ? err.message : String(err);

function sameDir(a: string, b: string): boolean {
  try { return realpathSync(a) === realpathSync(b); } catch { return false; }
}

/**
 * The botmux-created worktree a closed card may offer to clean up: the
 * recorded worktree holding the session's working dir, still the same
 * directory botmux created. Any read failure means "no button". A multi-repo
 * worktree group gets no button: its session runs in the group's parent
 * directory, which is not a linked worktree and is not recorded — only the
 * per-repo worktrees inside it are.
 */
export function sessionWorktreeOffer(
  session: Pick<Session, 'workingDir'>,
  dataDir?: string,
): BotmuxWorktreeRecord | undefined {
  if (!session.workingDir) return undefined;
  try {
    const record = findBotmuxWorktreeFor(dataDir ?? config.session.dataDir, session.workingDir);
    return record && botmuxWorktreeIdentityMatches(record) ? record : undefined;
  } catch {
    return undefined;
  }
}

export async function cleanupSessionWorktree(
  sessionId: string,
  larkAppId: string,
  deps: SessionWorktreeCleanupDeps = defaultSessionWorktreeCleanupDeps(),
): Promise<SessionWorktreeCleanupOutcome> {
  const session = deps.getSession(sessionId);
  if (!session || (session.larkAppId && session.larkAppId !== larkAppId)) return { status: 'session_missing' };
  if (session.status !== 'closed') return { status: 'session_active' };
  if (!session.workingDir) return { status: 'not_botmux' };
  let record: BotmuxWorktreeRecord | undefined;
  try {
    record = findBotmuxWorktreeFor(deps.dataDir, session.workingDir);
  } catch (err) {
    return { status: 'failed', dir: session.workingDir, error: message(err) };
  }
  if (!record) {
    // Already removed through this button (the record goes with it), or never ours.
    return existsSync(session.workingDir) ? { status: 'not_botmux' } : { status: 'gone', dir: session.workingDir };
  }
  const { dir } = record;
  if (!existsSync(dir)) {
    try { deleteBotmuxWorktree(deps.dataDir, dir); } catch { /* stale record only */ }
    return { status: 'gone', dir };
  }
  if (!botmuxWorktreeIdentityMatches(record)) return { status: 'not_botmux' };
  try {
    const root = await worktreeRootFor(dir);
    if (!root || !sameDir(root, dir) || !(await isLinkedWorktree(root))
      || !sameDir(await mainWorktreeFor(root), record.main)) {
      return { status: 'not_botmux' };
    }
    return await withWorktreeTargetLock(dir, async (): Promise<SessionWorktreeCleanupOutcome> => {
      const current = deps.getSession(sessionId);
      if (!current || current.status !== 'closed') return { status: 'session_active' };
      const reasons: SessionWorktreeBlockReason[] = [];
      try {
        const active = deps.activeSessionsUsing(dir);
        if (active.length > 0) reasons.push({ kind: 'sessions', count: active.length });
      } catch (err) {
        reasons.push({ kind: 'sessions_unknown', error: message(err) });
      }
      const probe = await deps.processesUsing(dir);
      if (probe.status === 'unknown') reasons.push({ kind: 'processes_unknown', error: probe.error });
      else if (probe.pids.length > 0) reasons.push({ kind: 'processes', count: probe.pids.length });
      try {
        const safety = await worktreeSafetyStatus(dir);
        if (safety.uncommittedCount > 0) reasons.push({ kind: 'uncommitted', count: safety.uncommittedCount });
        if (safety.ahead > 0) reasons.push({ kind: 'unpushed', count: safety.ahead });
      } catch (err) {
        reasons.push({ kind: 'status_unknown', error: message(err) });
      }
      if (reasons.length > 0) return { status: 'blocked', dir, reasons };
      await removeCleanWorktree(record!.main, dir);
      deleteBotmuxWorktree(deps.dataDir, dir);
      return { status: 'removed', dir, branch: record!.branch };
    });
  } catch (err) {
    return { status: 'failed', dir, error: message(err) };
  }
}
