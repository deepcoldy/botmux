import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, readdirSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { cleanupMaterializedDashboardImages } from '../core/dashboard-images.js';
import { deleteFrozenCards } from './frozen-card-store.js';
import type { Session } from '../types.js';
import { withFileLockSync } from '../utils/file-lock.js';

let sessions: Map<string, Session> = new Map();
let loaded = false;
let currentAppId: string | undefined;

// Legacy fields from the removed「处理中」placeholder-card PATCH delivery. They
// no longer exist on Session and nothing reads them, but sessions persisted
// before the removal still carry them on disk. Strip on write so the file
// converges to clean on the first save (daemon + CLI both call this).
const LEGACY_PENDING_CARD_FIELDS = ['pendingResponseCardId', 'pendingResponseCardState', 'lastPatchedResponseCardId'] as const;
export function stripLegacyPendingCardFields(session: Record<string, unknown>): void {
  for (const f of LEGACY_PENDING_CARD_FIELDS) delete session[f];
}

/** The exact active row no longer has the lineage/ownership sampled by the
 * caller. Unlike an I/O failure, retrying against the caller's live backend
 * could overwrite or resume a different durable owner. */
export class RiffLineageOwnershipError extends Error {
  override readonly name = 'RiffLineageOwnershipError';
}

export type RiffDurableOwner = {
  pid: number | null;
  larkAppId: string | null;
  backendType: string | null;
};

export type ActiveRiffShutdownSnapshot = {
  sessionId: string;
  taskId: string | null;
  owner: RiffDurableOwner;
};

export type ActiveRiffLineageBatchUpdate = ActiveRiffShutdownSnapshot & {
  targetTaskId: string | null;
  expectedCurrentTaskIds: readonly (string | null)[];
};

export type RiffLineageBatchFailureStage =
  | 'prewrite_ownership'
  | 'prewrite_io'
  | 'postrename_ambiguity';

export class RiffLineageBatchError extends Error {
  override readonly name = 'RiffLineageBatchError';
  constructor(
    readonly stage: RiffLineageBatchFailureStage,
    readonly sessionIds: readonly string[],
    message: string,
  ) {
    super(message);
  }
}

function riffDurableOwner(session: Session): RiffDurableOwner {
  return {
    pid: session.pid ?? null,
    larkAppId: session.larkAppId ?? null,
    backendType: session.backendType ?? null,
  };
}

function riffOwnersEqual(left: RiffDurableOwner, right: RiffDurableOwner): boolean {
  return left.pid === right.pid
    && left.larkAppId === right.larkAppId
    && left.backendType === right.backendType;
}

let testOnlyAfterRiffBatchRename: (() => void) | undefined;
export function __testOnly_setAfterRiffBatchRename(hook: (() => void) | undefined): void {
  testOnlyAfterRiffBatchRename = hook;
}

/**
 * Initialise session store for a specific bot (multi-daemon mode).
 * When appId is set, sessions are stored in `sessions-{appId}.json`.
 * When unset, uses the legacy `sessions.json`.
 */
export function init(appId?: string): void {
  currentAppId = appId;
  loaded = false;
  sessions = new Map();
}

function getFilePath(): string {
  const fileName = currentAppId ? `sessions-${currentAppId}.json` : 'sessions.json';
  return join(config.session.dataDir, fileName);
}

function ensureDir(): void {
  const dir = dirname(getFilePath());
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

// A short-lived /repo bug recreated chat-scope sessions with the chat routing
// anchor (`oc_...`) copied into rootMessageId and omitted scope. That shape is
// impossible for a real thread: Lark message ids are `om_...`. Repair only this
// narrow signature so ordinary legacy records without scope keep their
// documented thread fallback. The original trace message cannot be recovered,
// but chat routing does not use rootMessageId.
export function repairMissingChatScope(session: unknown): boolean {
  if (!session || typeof session !== 'object' || Array.isArray(session)) return false;
  const record = session as Record<string, unknown>;
  if (
    record.scope === undefined
    && typeof record.chatId === 'string'
    && record.chatId.startsWith('oc_')
    && typeof record.rootMessageId === 'string'
    && record.rootMessageId === record.chatId
  ) {
    record.scope = 'chat';
    return true;
  }
  return false;
}

function repairMissingChatScopes(): number {
  let repaired = 0;
  for (const session of sessions.values()) {
    if (repairMissingChatScope(session)) repaired += 1;
  }
  return repaired;
}

// Sessions persisted before 2026-04-29 lack `cliId`; consumers must fall back to 'unknown' at the render boundary.
function load(): void {
  if (loaded) return;
  ensureDir();
  const fp = getFilePath();
  withFileLockSync(fp, () => {
    if (existsSync(fp)) {
      try {
        const data = JSON.parse(readFileSync(fp, 'utf-8'));
        sessions = new Map(Object.entries(data));
        const repaired = repairMissingChatScopes();
        if (repaired > 0) {
          try {
            const tmpFp = `${fp}.${process.pid}.${randomUUID()}.tmp`;
            writeFileSync(tmpFp, JSON.stringify(Object.fromEntries(sessions), null, 2), 'utf-8');
            renameSync(tmpFp, fp);
            logger.info(`Repaired ${repaired} scope-less chat session(s) in ${fp}`);
          } catch (err) {
            // Loading succeeded, so keep the in-memory sessions available even
            // if the best-effort repair cannot be persisted yet.
            logger.error(`Failed to persist repaired chat session scopes: ${err}`);
          }
        }
        logger.info(`Loaded ${sessions.size} sessions from ${fp}`);
      } catch (err) {
        logger.error(`Failed to load sessions: ${err}`);
        sessions = new Map();
      }
    } else if (currentAppId) {
      // Per-bot file doesn't exist — migrate matching legacy rows while still
      // holding the same lock used by daemon saves and offline CLI mutations.
      const legacyFp = join(config.session.dataDir, 'sessions.json');
      if (existsSync(legacyFp)) {
        try {
          const data: Record<string, Session> = JSON.parse(readFileSync(legacyFp, 'utf-8'));
          sessions = new Map();
          for (const [k, v] of Object.entries(data)) {
            if (v.larkAppId === currentAppId) sessions.set(k, v);
          }
          if (sessions.size > 0) {
            const repaired = repairMissingChatScopes();
            const obj = Object.fromEntries(sessions);
            const tmpFp = `${fp}.${process.pid}.${randomUUID()}.tmp`;
            writeFileSync(tmpFp, JSON.stringify(obj, null, 2), 'utf-8');
            renameSync(tmpFp, fp);
            logger.info(`Migrated ${sessions.size} sessions from sessions.json to ${fp}`);
            if (repaired > 0) {
              logger.info(`Repaired ${repaired} scope-less chat session(s) during migration`);
            }
          }
        } catch (err) {
          logger.error(`Failed to migrate sessions from legacy file: ${err}`);
          sessions = new Map();
        }
      }
    }
  });
  loaded = true;
}

function readExistingSessionsFromDisk(fp: string): { raw: string; parsed: Record<string, Session> } {
  if (!existsSync(fp)) return { raw: '', parsed: {} };
  try {
    const raw = readFileSync(fp, 'utf-8');
    return { raw, parsed: JSON.parse(raw) as Record<string, Session> };
  } catch {
    return { raw: '', parsed: {} };
  }
}

function readSessionsProjectionStrict(fp: string): { raw: string; parsed: Record<string, Session> } {
  if (!existsSync(fp)) return { raw: '', parsed: {} };
  const raw = readFileSync(fp, 'utf-8');
  const value = JSON.parse(raw) as unknown;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`invalid sessions projection at ${fp}`);
  }
  return { raw, parsed: value as Record<string, Session> };
}

function duplicateIds(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) duplicates.add(id);
    else seen.add(id);
  }
  return [...duplicates];
}

/**
 * Sample every active Riff participant from one fresh sessions projection.
 * Graceful fleet shutdown must take this snapshot before it fences any worker:
 * sampling rows one-at-a-time can otherwise mix owners from different durable
 * generations and leave an already-fenced peer without a trustworthy abort
 * handle.
 */
export function getActiveRiffShutdownSnapshotsBatch(
  sessionIds: readonly string[],
  options: { maxWaitMs?: number } = {},
): ActiveRiffShutdownSnapshot[] {
  if (sessionIds.length === 0) return [];
  const duplicates = duplicateIds(sessionIds);
  if (duplicates.length > 0) {
    throw new RiffLineageBatchError(
      'prewrite_ownership',
      duplicates,
      `duplicate Riff shutdown session ids: ${duplicates.join(', ')}`,
    );
  }

  ensureDir();
  const fp = getFilePath();
  try {
    return withFileLockSync(fp, () => {
      const { parsed } = readSessionsProjectionStrict(fp);
      const invalid = sessionIds.filter((sessionId) => {
        const session = parsed[sessionId];
        return !session || session.status !== 'active';
      });
      if (invalid.length > 0) {
        throw new RiffLineageBatchError(
          'prewrite_ownership',
          invalid,
          `cannot snapshot non-active Riff sessions: ${invalid.join(', ')}`,
        );
      }
      return sessionIds.map((sessionId) => {
        const session = parsed[sessionId]!;
        return {
          sessionId,
          taskId: session.riffParentTaskId ?? null,
          owner: riffDurableOwner(session),
        };
      });
    }, { maxWaitMs: options.maxWaitMs });
  } catch (error) {
    if (error instanceof RiffLineageBatchError) throw error;
    throw new RiffLineageBatchError(
      'prewrite_io',
      [...sessionIds],
      `failed to snapshot active Riff sessions: ${String(error)}`,
    );
  }
}

/**
 * Commit every prepared Riff lineage as one compare-and-set transaction.
 * Every row is checked before the single rename and every published row is
 * read back under the same lock before any worker may be ACKed to exit.
 */
export function persistActiveRiffLineagesExactBatch(
  updates: readonly ActiveRiffLineageBatchUpdate[],
  options: { maxWaitMs?: number } = {},
): ActiveRiffShutdownSnapshot[] {
  if (updates.length === 0) return [];
  const sessionIds = updates.map(update => update.sessionId);
  const duplicates = duplicateIds(sessionIds);
  if (duplicates.length > 0) {
    throw new RiffLineageBatchError(
      'prewrite_ownership',
      duplicates,
      `duplicate Riff lineage batch session ids: ${duplicates.join(', ')}`,
    );
  }

  ensureDir();
  const fp = getFilePath();
  let published = false;
  let tmpFp: string | undefined;
  try {
    return withFileLockSync(fp, () => {
      const { raw, parsed } = readSessionsProjectionStrict(fp);
      const conflicts: string[] = [];
      for (const update of updates) {
        const durable = parsed[update.sessionId];
        const durableTaskId = durable?.riffParentTaskId ?? null;
        if (!durable
            || durable.status !== 'active'
            || !update.expectedCurrentTaskIds.some(candidate => candidate === durableTaskId)
            || !riffOwnersEqual(riffDurableOwner(durable), update.owner)) {
          conflicts.push(update.sessionId);
        }
      }
      if (conflicts.length > 0) {
        throw new RiffLineageBatchError(
          'prewrite_ownership',
          conflicts,
          `Riff lineage batch compare-and-set failed for: ${conflicts.join(', ')}`,
        );
      }

      for (const update of updates) {
        const durable = parsed[update.sessionId]!;
        const next: Session = {
          ...durable,
          riffParentTaskId: update.targetTaskId ?? undefined,
        };
        stripLegacyPendingCardFields(next as unknown as Record<string, unknown>);
        parsed[update.sessionId] = next;
      }

      const json = JSON.stringify(parsed, null, 2);
      if (json !== raw) {
        tmpFp = `${fp}.${process.pid}.${randomUUID()}.tmp`;
        writeFileSync(tmpFp, json, 'utf-8');
        renameSync(tmpFp, fp);
        tmpFp = undefined;
        published = true;
        testOnlyAfterRiffBatchRename?.();
      }

      let verifiedProjection: Record<string, Session>;
      try {
        verifiedProjection = readSessionsProjectionStrict(fp).parsed;
      } catch (error) {
        throw new RiffLineageBatchError(
          published ? 'postrename_ambiguity' : 'prewrite_io',
          [...sessionIds],
          `failed to read back Riff lineage batch: ${String(error)}`,
        );
      }

      const ambiguous = updates.filter((update) => {
        const durable = verifiedProjection[update.sessionId];
        return !durable
          || durable.status !== 'active'
          || (durable.riffParentTaskId ?? null) !== update.targetTaskId
          || !riffOwnersEqual(riffDurableOwner(durable), update.owner);
      }).map(update => update.sessionId);
      if (ambiguous.length > 0) {
        throw new RiffLineageBatchError(
          published ? 'postrename_ambiguity' : 'prewrite_ownership',
          ambiguous,
          `Riff lineage batch readback mismatch for: ${ambiguous.join(', ')}`,
        );
      }

      const verified = updates.map((update) => ({
        sessionId: update.sessionId,
        taskId: update.targetTaskId,
        owner: riffDurableOwner(verifiedProjection[update.sessionId]!),
      }));

      // The durable projection remains authoritative. Only mirror the exact
      // verified rows into an already-loaded process cache after readback.
      if (loaded) {
        for (const update of updates) {
          const cached = sessions.get(update.sessionId);
          if (cached) cached.riffParentTaskId = update.targetTaskId ?? undefined;
        }
      }
      return verified;
    }, { maxWaitMs: options.maxWaitMs });
  } catch (error) {
    if (error instanceof RiffLineageBatchError) throw error;
    throw new RiffLineageBatchError(
      published ? 'postrename_ambiguity' : 'prewrite_io',
      [...sessionIds],
      `failed to persist Riff lineage batch: ${String(error)}`,
    );
  } finally {
    if (tmpFp) {
      try { unlinkSync(tmpFp); } catch { /* best-effort orphan cleanup */ }
    }
  }
}

function save(): void {
  ensureDir();
  const fp = getFilePath();
  withFileLockSync(fp, () => {
    const { raw: existingRaw } = readExistingSessionsFromDisk(fp);
    const obj: Record<string, Session> = {};
    for (const [k, v] of sessions) {
      stripLegacyPendingCardFields(v as unknown as Record<string, unknown>);
      obj[k] = v;
    }
    const json = JSON.stringify(obj, null, 2);
    // The daemon fires several updateSession()/save() calls per inbound message
    // (activity bump, pid, stream-card state, …) and many leave the serialized
    // file byte-identical. Skipping the temp-file write + rename in that case
    // elides the bulk of the redundant disk I/O.
    if (json === existingRaw) return;
    const tmpFp = `${fp}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(tmpFp, json, 'utf-8');
    renameSync(tmpFp, fp);
  });
}

export function createSession(
  chatId: string,
  rootMessageId: string,
  title: string,
  chatType?: 'group' | 'p2p',
  scope?: 'thread' | 'chat',
): Session {
  load();
  const session: Session = {
    sessionId: randomUUID(),
    chatId,
    chatType,
    rootMessageId,
    scope,
    title,
    status: 'active',
    createdAt: new Date().toISOString(),
  };
  sessions.set(session.sessionId, session);
  save();
  logger.info(`Created session ${session.sessionId} (thread: ${rootMessageId})`);
  return session;
}

export function getSession(sessionId: string): Session | undefined {
  load();
  return sessions.get(sessionId) ?? findInOtherFiles(sessionId);
}

/** Cross-process fresh read for worker-side authorization. Workers initialise
 * this store once, but the daemon rotates Codex dispatch ledgers in a different
 * process; the ordinary in-memory cache is therefore not an authority for a
 * later turn. The shared file lock orders this read after daemon/CLI writes. */
export function getSessionFresh(sessionId: string): Session | undefined {
  ensureDir();
  const fp = getFilePath();
  return withFileLockSync(fp, () => {
    if (!existsSync(fp)) return undefined;
    try {
      const data = JSON.parse(readFileSync(fp, 'utf-8')) as Record<string, Session>;
      return data[sessionId];
    } catch {
      return undefined;
    }
  });
}

/**
 * Search all session files for a session not found in the current file.
 *
 * Sessions are partitioned per-bot (sessions-<larkAppId>.json), but agent-
 * facing CLI subcommands (`botmux send`, etc.) may be invoked in contexts
 * where LARK_APP_ID isn't set, so they can't pick the right file directly.
 * Scanning all files is safe — these callers only read sessions.
 */
function findInOtherFiles(sessionId: string): Session | undefined {
  const dataDir = config.session.dataDir;
  const currentFp = getFilePath();
  try {
    for (const file of readdirSync(dataDir)) {
      if (!file.startsWith('sessions') || !file.endsWith('.json')) continue;
      const fp = join(dataDir, file);
      if (fp === currentFp) continue;
      try {
        const data: Record<string, Session> = JSON.parse(readFileSync(fp, 'utf-8'));
        if (data[sessionId]) return data[sessionId];
      } catch { continue; }
    }
  } catch { /* ignore */ }
  return undefined;
}

export function closeSession(
  sessionId: string,
  opts: { clearRiffParentTaskId?: boolean } = {},
): void {
  load();
  const session = sessions.get(sessionId);
  if (session) {
    const priorStatus = session.status;
    const priorClosedAt = session.closedAt;
    const priorLedger = session.codexAppDispatchLedger;
    const priorCommits = session.codexAppGenerationCommits;
    const priorRiffParentTaskId = session.riffParentTaskId;
    const priorDashboardAttachments = session.dashboardAttachments;
    const priorQueuedAttachments = session.queuedAttachments;
    const priorQueuedOwnership = {
      queued: session.queued,
      queuedPrompt: session.queuedPrompt,
      queuedCodexAppText: session.queuedCodexAppText,
      queuedCodexAppMessageContext: session.queuedCodexAppMessageContext,
      queuedActivationPending: session.queuedActivationPending,
      queuedActivationToken: session.queuedActivationToken,
      queuedActivationInput: session.queuedActivationInput,
      queuedActivationTurnId: session.queuedActivationTurnId,
      queuedActivationDispatchAttempt: session.queuedActivationDispatchAttempt,
      queuedActivationResume: session.queuedActivationResume,
      queuedActivationTail: session.queuedActivationTail,
      queuedActivationTailNextOrder: session.queuedActivationTailNextOrder,
      pendingRepoSetup: session.pendingRepoSetup,
    };
    session.status = 'closed';
    session.closedAt = new Date().toISOString();
    // Closing is an explicit abandon boundary, unlike suspend/daemon crash.
    // Never let a later generic resume replay prepared Codex App input the
    // user intentionally discarded, and retire generation ACK history with
    // the abandoned FIFO.
    session.codexAppDispatchLedger = undefined;
    session.codexAppGenerationCommits = undefined;
    session.queued = undefined;
    session.queuedPrompt = undefined;
    session.queuedCodexAppText = undefined;
    session.queuedCodexAppMessageContext = undefined;
    session.queuedActivationPending = undefined;
    session.queuedActivationToken = undefined;
    session.queuedActivationInput = undefined;
    session.queuedActivationTurnId = undefined;
    session.queuedActivationDispatchAttempt = undefined;
    session.queuedActivationResume = undefined;
    session.queuedActivationTail = undefined;
    session.queuedActivationTailNextOrder = undefined;
    session.pendingRepoSetup = undefined;
    session.dashboardAttachments = undefined;
    session.queuedAttachments = undefined;
    // A successful explicit Riff close has already confirmed remote
    // cancellation. Clear its retry handle in the SAME atomic file replace as
    // the closed status; clearing it in a prior update loses lineage when this
    // save fails between prepare and commit.
    if (opts.clearRiffParentTaskId) session.riffParentTaskId = undefined;
    try {
      save();
    } catch (err) {
      session.status = priorStatus;
      session.closedAt = priorClosedAt;
      session.codexAppDispatchLedger = priorLedger;
      session.codexAppGenerationCommits = priorCommits;
      session.riffParentTaskId = priorRiffParentTaskId;
      session.dashboardAttachments = priorDashboardAttachments;
      session.queuedAttachments = priorQueuedAttachments;
      Object.assign(session, priorQueuedOwnership);
      throw err;
    }
    if (session.larkAppId && priorDashboardAttachments?.length) {
      try {
        cleanupMaterializedDashboardImages(session.larkAppId, priorDashboardAttachments);
      } catch (error: any) {
        logger.warn(`Failed to clean Dashboard images for session ${sessionId}: ${error?.message ?? error}`);
      }
    }
    deleteFrozenCards(sessionId);
    logger.info(`Closed session ${sessionId}`);
  }
}

/**
 * Reactivate one explicitly closed row and discard every queued/setup owner in
 * the same durable file replacement.  The close path has cleared these fields
 * since 2026-07, but older closed rows can still contain prepared input.  A
 * generic resume is an explicit new lifecycle and must never revive that
 * abandoned FIFO.
 */
export function reactivateClosedSession(
  sessionId: string,
): { ok: true; session: Session }
| { ok: false; error: 'not_found' | 'not_closed' } {
  load();
  const session = sessions.get(sessionId);
  if (!session) return { ok: false, error: 'not_found' };
  if (session.status !== 'closed') return { ok: false, error: 'not_closed' };

  const prior = {
    status: session.status,
    closedAt: session.closedAt,
    lastMessageAt: session.lastMessageAt,
    codexAppDispatchLedger: session.codexAppDispatchLedger,
    codexAppGenerationCommits: session.codexAppGenerationCommits,
    queued: session.queued,
    queuedPrompt: session.queuedPrompt,
    queuedCodexAppText: session.queuedCodexAppText,
    queuedCodexAppMessageContext: session.queuedCodexAppMessageContext,
    queuedActivationPending: session.queuedActivationPending,
    queuedActivationToken: session.queuedActivationToken,
    queuedActivationInput: session.queuedActivationInput,
    queuedActivationTurnId: session.queuedActivationTurnId,
    queuedActivationDispatchAttempt: session.queuedActivationDispatchAttempt,
    queuedActivationResume: session.queuedActivationResume,
    queuedActivationTail: session.queuedActivationTail,
    queuedActivationTailNextOrder: session.queuedActivationTailNextOrder,
    pendingRepoSetup: session.pendingRepoSetup,
  };

  session.status = 'active';
  session.closedAt = undefined;
  session.lastMessageAt = new Date().toISOString();
  session.codexAppDispatchLedger = undefined;
  session.codexAppGenerationCommits = undefined;
  session.queued = undefined;
  session.queuedPrompt = undefined;
  session.queuedCodexAppText = undefined;
  session.queuedCodexAppMessageContext = undefined;
  session.queuedActivationPending = undefined;
  session.queuedActivationToken = undefined;
  session.queuedActivationInput = undefined;
  session.queuedActivationTurnId = undefined;
  session.queuedActivationDispatchAttempt = undefined;
  session.queuedActivationResume = undefined;
  session.queuedActivationTail = undefined;
  session.queuedActivationTailNextOrder = undefined;
  session.pendingRepoSetup = undefined;

  try {
    save();
  } catch (err) {
    Object.assign(session, prior);
    throw err;
  }
  return { ok: true, session };
}

export function updateSessionPid(sessionId: string, pid: number | null): void {
  load();
  const session = sessions.get(sessionId);
  if (session) {
    session.pid = pid ?? undefined;
    save();
  }
}

export function updateSession(session: Session): void {
  load();
  sessions.set(session.sessionId, session);
  save();
}

/** Persist the exact Riff follow-up lineage for an ACTIVE row, transactionally
 * with respect to this process's in-memory store. Graceful shutdown uses this
 * before ACKing a worker detach: `updateSession()` cannot provide that ACK
 * because it installs the caller's object in the Map before save(), leaving a
 * false in-memory success when the atomic file replace throws.
 *
 * `null` is authoritative and clears a stale parent. The caller should follow
 * with getSessionFresh() when it needs proof that the on-disk row contains the
 * exact value before allowing a remote owner to exit. */
export function persistActiveRiffLineageExact(
  sessionId: string,
  taskId: string | null,
  options: {
    expectedCurrentTaskIds?: readonly (string | null)[];
    expectedOwner?: {
      pid: number | null;
      larkAppId: string | null;
      backendType: string | null;
    };
  } = {},
): Session {
  load();
  ensureDir();
  const fp = getFilePath();
  return withFileLockSync(fp, () => {
    const { raw, parsed } = readExistingSessionsFromDisk(fp);
    const durable = parsed[sessionId];
    if (!durable || durable.status !== 'active') {
      throw new RiffLineageOwnershipError(
        `cannot persist Riff lineage for non-active session ${sessionId}`,
      );
    }
    const durableTaskId = durable.riffParentTaskId ?? null;
    const expected = options.expectedCurrentTaskIds;
    if (expected && !expected.some(candidate => candidate === durableTaskId)) {
      throw new RiffLineageOwnershipError(
        `Riff lineage compare-and-set failed for ${sessionId} `
        + `(current=${durableTaskId ?? 'none'}, expected=${expected.map(id => id ?? 'none').join('|')})`,
      );
    }
    const expectedOwner = options.expectedOwner;
    const durableOwner = {
      pid: durable.pid ?? null,
      larkAppId: durable.larkAppId ?? null,
      backendType: durable.backendType ?? null,
    };
    if (expectedOwner
        && (durableOwner.pid !== expectedOwner.pid
          || durableOwner.larkAppId !== expectedOwner.larkAppId
          || durableOwner.backendType !== expectedOwner.backendType)) {
      throw new RiffLineageOwnershipError(
        `Riff owner compare-and-set failed for ${sessionId} `
        + `(current=${JSON.stringify(durableOwner)}, expected=${JSON.stringify(expectedOwner)})`,
      );
    }

    // Merge only this exact fresh row. Serializing the process-wide `sessions`
    // cache here can leak unrelated runtime-only mutations from another
    // prepared fleet participant into the durable file before its own commit.
    const next: Session = {
      ...durable,
      riffParentTaskId: taskId ?? undefined,
    };
    stripLegacyPendingCardFields(next as unknown as Record<string, unknown>);
    parsed[sessionId] = next;
    const json = JSON.stringify(parsed, null, 2);
    if (json !== raw) {
      const tmpFp = `${fp}.${process.pid}.${randomUUID()}.tmp`;
      writeFileSync(tmpFp, json, 'utf-8');
      renameSync(tmpFp, fp);
    }

    // Publish into the local cache only after the atomic replace succeeded.
    const cached = sessions.get(sessionId);
    if (cached) {
      cached.riffParentTaskId = taskId ?? undefined;
      return cached;
    }
    sessions.set(sessionId, next);
    return next;
  });
}

export function listSessions(): Session[] {
  load();
  return [...sessions.values()];
}

/**
 * Cross-file lookup: find every active session attached to a thread, across
 * all bots. Used when a not-yet-initialized bot is mentioned in a thread that
 * another bot has already pinned to a working directory — the new bot inherits
 * the pinned dir instead of re-prompting the user for repo selection.
 *
 * Reads other bots' session files directly (best-effort) instead of relying on
 * any in-memory state, since each daemon process only owns its own bot.
 */
export function findActiveSessionsByRoot(rootMessageId: string): Session[] {
  return findActiveSessionsMatching(s => s.rootMessageId === rootMessageId);
}

/**
 * Cross-file lookup: find every active chat-scope session for a chat, across
 * all bots. Mirror of findActiveSessionsByRoot for chat-scope (普通群整群一会话):
 * lets a not-yet-initialised bot inherit the workingDir from a peer bot that
 * already has a chat-scope session in the same chat, so a `botmux send
 * --mention <other-bot>` in 普通群 can spawn the second bot without bouncing
 * through the repo-select card.
 *
 * Only returns scope='chat' sessions — thread-scope sessions in the same chat
 * are routed by rootMessageId and not eligible for chat-scope inheritance.
 */
export function findActiveChatScopeSessionsByChat(chatId: string): Session[] {
  return findActiveSessionsMatching(s => s.chatId === chatId && s.scope === 'chat');
}

/**
 * Count active sessions across every bot's on-disk session file. A pure disk
 * read (no in-memory state) so it's correct at daemon startup regardless of
 * which bot owns this process — used by the restart-report DM after a restart.
 */
export function countActiveSessionsOnDisk(dataDir: string = config.session.dataDir): number {
  let n = 0;
  try {
    for (const file of readdirSync(dataDir)) {
      if (!file.startsWith('sessions') || !file.endsWith('.json')) continue;
      try {
        const data: Record<string, Session> = JSON.parse(readFileSync(join(dataDir, file), 'utf-8'));
        for (const s of Object.values(data)) if (s?.status === 'active') n++;
      } catch { continue; }
    }
  } catch { /* missing dir → 0 */ }
  return n;
}

/**
 * Collect every CLI session identity botmux has ever recorded — across ALL bot
 * store files, ANY status (active or closed). Returns both each session's
 * botmux `sessionId` (which, for claude-family, IS the on-disk jsonl filename
 * since botmux spawns with `--session-id <id>`) and its `cliSessionId` (the
 * CLI-native id after any resume/rotation, e.g. a codex/traex rollout id).
 *
 * Used by `/adopt`'s resume-import discovery to hide sessions botmux already
 * manages — live OR closed — so the picker surfaces only genuinely external
 * sessions (a CLI the user ran standalone). Closed botmux sessions remain
 * resumable via their own session-closed cards.
 */
export function collectBotmuxSessionIdentities(dataDir: string = config.session.dataDir): Set<string> {
  const ids = new Set<string>();
  const add = (s: Session | undefined) => {
    if (!s) return;
    if (s.sessionId) ids.add(s.sessionId);
    if (s.cliSessionId) ids.add(s.cliSessionId);
  };
  // In-memory first (freshest — covers ids not yet flushed to disk).
  load();
  for (const s of sessions.values()) add(s);
  // Then every bot's persisted store file (other daemons own their own files).
  try {
    for (const file of readdirSync(dataDir)) {
      if (!file.startsWith('sessions') || !file.endsWith('.json')) continue;
      try {
        const data: Record<string, Session> = JSON.parse(readFileSync(join(dataDir, file), 'utf-8'));
        for (const s of Object.values(data)) add(s);
      } catch { continue; }
    }
  } catch { /* missing dir → in-memory only */ }
  return ids;
}

function findActiveSessionsMatching(predicate: (s: Session) => boolean): Session[] {
  load();
  const matches: Session[] = [];
  for (const s of sessions.values()) {
    if (predicate(s) && s.status === 'active') matches.push(s);
  }
  const dataDir = config.session.dataDir;
  const currentFp = getFilePath();
  try {
    for (const file of readdirSync(dataDir)) {
      if (!file.startsWith('sessions') || !file.endsWith('.json')) continue;
      const fp = join(dataDir, file);
      if (fp === currentFp) continue;
      try {
        const data: Record<string, Session> = JSON.parse(readFileSync(fp, 'utf-8'));
        for (const s of Object.values(data)) {
          if (predicate(s) && s.status === 'active') matches.push(s);
        }
      } catch { continue; }
    }
  } catch { /* ignore */ }
  return matches;
}
