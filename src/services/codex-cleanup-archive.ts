import type { CodexCleanupRelease } from './codex-cleanup-release.js';
import { isAbsolute } from 'node:path';
import type { Session } from '../types.js';
import { applySessionOwnerEnv } from '../utils/child-env.js';
import { setCodexAppThreadArchived } from './codex-app-threads.js';

export function ownedLocalCodex(session: Session): boolean {
  return (session.cliId === 'codex' || session.cliId === 'codex-app')
    && !session.adoptedFrom && !session.existingAppServerEndpoint
    && session.creationSource !== 'external' && !session.wrapperCli
    && session.sandbox !== 'scratch'
    && (session.backendType === undefined || session.backendType === 'pty' || session.backendType === 'tmux');
}

export function codexCleanupEligible(session: Session): boolean {
  const target = session.codexCleanupTarget;
  // The worker publishes targets only from verified local PTY/tmux launches.
  // Historical rows may omit backendType even after that worker proof arrives.
  return ownedLocalCodex(session) && !!target && target.threadId === session.cliSessionId
    && isAbsolute(target.codexHome) && isAbsolute(target.codexBin);
}

type Persist = (session: Session) => void;
type ArchiveRpc = typeof setCodexAppThreadArchived;

/** Called only after an explicit or idle-cleanup close commits. Persist intent before RPC
 * so a timeout/crash never loses the obligation to unarchive on reopen. */
async function archiveCodexForCleanupImpl(
  session: Session, enabled: boolean, persist: Persist,
  rpc: ArchiveRpc = setCodexAppThreadArchived, beforeArchive?: () => Promise<CodexCleanupRelease | undefined>,
): Promise<string | undefined> {
  if (!enabled || session.status !== 'closed' || !ownedLocalCodex(session)) return;
  // A successful local close must never imply native archive success when the
  // identity cannot be proved. Keep historical sessions untouched but report it.
  if (!session.codexCleanupTarget) return 'codex_archive_target_unverified';
  if (!codexCleanupEligible(session)) return 'codex_archive_target_invalid';
  if (session.codexCleanupArchive?.state === 'archived') return;
  const target = session.codexCleanupTarget!;
  try {
    const release = session.codexCleanupArchive?.release ?? await beforeArchive?.();
    if (!release || release.sessionId !== session.sessionId || release.threadId !== target.threadId
        || !Number.isSafeInteger(release.workerGeneration) || release.workerGeneration < 0
        || (session.workerGeneration !== undefined && session.workerGeneration !== release.workerGeneration)
        || typeof release.nonce !== 'string' || release.nonce.length < 16) return 'codex_native_release_unverified';
    session.codexCleanupArchive = { threadId: target.threadId, state: 'pending', release };
    persist(session);
    const env = { ...process.env, CODEX_HOME: target.codexHome };
    applySessionOwnerEnv(env, session.ownerOpenId);
    await rpc({ ...target, archived: true, env });
    session.codexCleanupArchive = { threadId: target.threadId, state: 'archived', release };
    persist(session);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** Applies even after the global toggle is disabled; only our own journal
 * authorizes recovery, never an arbitrary archived historical thread. */
async function restoreCodexCleanupArchiveImpl(
  session: Session, persist: Persist, rpc: ArchiveRpc = setCodexAppThreadArchived,
): Promise<void> {
  const journal = session.codexCleanupArchive;
  if (!journal) return;
  if (!codexCleanupEligible(session) || journal.threadId !== session.codexCleanupTarget!.threadId) {
    throw new Error('Codex cleanup archive identity changed; refusing recovery');
  }
  const target = session.codexCleanupTarget!;
  const env = { ...process.env, CODEX_HOME: target.codexHome };
  applySessionOwnerEnv(env, session.ownerOpenId);
  await rpc({ ...target, archived: false, env });
  session.codexCleanupArchive = undefined;
  persist(session);
}

// Close and resume use different admission gates. Serialize the native lifecycle
// across both so a reopen cannot race an in-flight archive, including retries.
const lifecycle = new Map<string, Promise<unknown>>();
function serialized<T>(id: string, action: () => Promise<T>): Promise<T> {
  const next = (lifecycle.get(id) ?? Promise.resolve()).catch(() => undefined).then(action);
  lifecycle.set(id, next);
  void next.finally(() => { if (lifecycle.get(id) === next) lifecycle.delete(id); }).catch(() => undefined);
  return next;
}
export function archiveCodexForCleanup(session: Session, enabled: boolean, persist: Persist,
  rpc: ArchiveRpc = setCodexAppThreadArchived, beforeArchive?: () => Promise<CodexCleanupRelease | undefined>): Promise<string | undefined> {
  return serialized(session.sessionId, () => archiveCodexForCleanupImpl(session, enabled, persist, rpc, beforeArchive));
}
export function restoreCodexCleanupArchive(session: Session, persist: Persist,
  rpc: ArchiveRpc = setCodexAppThreadArchived, reload?: () => Session | undefined): Promise<void> {
  return serialized(session.sessionId, async () => {
    // A card may return before its queued archive has persisted the journal.
    // Reload INSIDE the lifecycle queue, after the archive has settled.
    const current = reload ? reload() : session;
    if (!current || current.sessionId !== session.sessionId || current.cliSessionId !== session.cliSessionId) {
      throw new Error('Codex cleanup archive identity changed; refusing recovery');
    }
    await restoreCodexCleanupArchiveImpl(current, persist, rpc);
    session.codexCleanupArchive = current.codexCleanupArchive;
  });
}
