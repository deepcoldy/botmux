import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, readdirSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { withFileLockSync } from '../utils/file-lock.js';
import { cleanupMaterializedDashboardImages } from '../core/dashboard-images.js';
import { deleteFrozenCards } from './frozen-card-store.js';
import type { Session } from '../types.js';

let sessions: Map<string, Session> = new Map();
let loaded = false;
let currentAppId: string | undefined;
let loadFailure: Error | undefined;

/**
 * The compatibility reader deliberately exposes an empty projection after a
 * read/parse failure. Destructive callers must use the strict API below so an
 * unreadable store cannot be mistaken for "there are no durable sessions".
 */
export class SessionStoreUnavailableError extends Error {
  override readonly name = 'SessionStoreUnavailableError';

  constructor(readonly loadError: Error) {
    super(`session store is unavailable: ${loadError.message}`);
  }
}

// Legacy fields from the removed「处理中」placeholder-card PATCH delivery. They
// no longer exist on Session and nothing reads them, but sessions persisted
// before the removal still carry them on disk. Strip on write so the file
// converges to clean on the first save (daemon + CLI both call this).
const LEGACY_PENDING_CARD_FIELDS = ['pendingResponseCardId', 'pendingResponseCardState', 'lastPatchedResponseCardId'] as const;
export function stripLegacyPendingCardFields(session: Record<string, unknown>): void {
  for (const f of LEGACY_PENDING_CARD_FIELDS) delete session[f];
}

/** The active row no longer has the lineage/ownership sampled by the caller. */
export class RemoteLineageOwnershipError extends Error {
  override readonly name = 'RemoteLineageOwnershipError';
}

export type RemoteDurableOwner = {
  pid: number | null;
  larkAppId: string | null;
  backendType: string | null;
};

export type ActiveRemoteShutdownSnapshot = {
  sessionId: string;
  taskId: string | null;
  owner: RemoteDurableOwner;
};

export type ActiveRemoteLineageBatchUpdate = ActiveRemoteShutdownSnapshot & {
  targetTaskId: string | null;
  expectedCurrentTaskIds: readonly (string | null)[];
};

export type RemoteLineageBatchFailureStage =
  | 'prewrite_ownership'
  | 'prewrite_io'
  | 'postrename_ambiguity';

export class RemoteLineageBatchError extends Error {
  override readonly name = 'RemoteLineageBatchError';

  constructor(
    readonly stage: RemoteLineageBatchFailureStage,
    readonly sessionIds: readonly string[],
    message: string,
  ) {
    super(message);
  }
}

function remoteDurableOwner(session: Session): RemoteDurableOwner {
  return {
    pid: session.pid ?? null,
    larkAppId: session.larkAppId ?? null,
    backendType: session.backendType ?? null,
  };
}

function remoteOwnersEqual(left: RemoteDurableOwner, right: RemoteDurableOwner): boolean {
  return left.pid === right.pid
    && left.larkAppId === right.larkAppId
    && left.backendType === right.backendType;
}

let testOnlyAfterRemoteBatchRename: (() => void) | undefined;
export function __testOnly_setAfterRemoteBatchRename(hook: (() => void) | undefined): void {
  testOnlyAfterRemoteBatchRename = hook;
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
  loadFailure = undefined;
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

function parseSessionsProjectionStrict(raw: string, fp: string): Record<string, Session> {
  const value = JSON.parse(raw) as unknown;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`invalid sessions projection at ${fp}`);
  }
  return value as Record<string, Session>;
}

// Sessions persisted before 2026-04-29 lack `cliId`; consumers must fall back to 'unknown' at the render boundary.
function load(): void {
  if (loaded) return;
  ensureDir();
  const fp = getFilePath();
  withFileLockSync(fp, () => {
    if (existsSync(fp)) {
      try {
        const data = parseSessionsProjectionStrict(readFileSync(fp, 'utf-8'), fp);
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
        loadFailure = err instanceof Error ? err : new Error(String(err));
        sessions = new Map();
      }
    } else if (currentAppId) {
      // Per-bot file doesn't exist — migrate matching legacy rows while still
      // holding the same lock used by daemon saves and offline CLI mutations.
      const legacyFp = join(config.session.dataDir, 'sessions.json');
      if (existsSync(legacyFp)) {
        try {
          const data = parseSessionsProjectionStrict(readFileSync(legacyFp, 'utf-8'), legacyFp);
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
          loadFailure = err instanceof Error ? err : new Error(String(err));
          sessions = new Map();
        }
      }
    }
  });
  loaded = true;
}

/**
 * Mutations must never proceed from the compatibility reader's empty
 * projection after a load failure. In particular, serialising that empty
 * cache would replace the unreadable durable file and destroy the only copy
 * of its rows. Keep the failure sticky until init() explicitly reloads the
 * selected store, matching listSessionsStrict().
 */
function loadForWrite(): void {
  load();
  if (loadFailure) throw new SessionStoreUnavailableError(loadFailure);
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
  return { raw, parsed: parseSessionsProjectionStrict(raw, fp) };
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
 * Sample every active remote participant from one fresh sessions projection.
 * Fleet shutdown takes this snapshot before fencing any worker.
 */
export function getActiveRemoteShutdownSnapshotsBatch(
  sessionIds: readonly string[],
  options: { maxWaitMs?: number } = {},
): ActiveRemoteShutdownSnapshot[] {
  if (sessionIds.length === 0) return [];
  const duplicates = duplicateIds(sessionIds);
  if (duplicates.length > 0) {
    throw new RemoteLineageBatchError(
      'prewrite_ownership',
      duplicates,
      `duplicate remote shutdown session ids: ${duplicates.join(', ')}`,
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
        throw new RemoteLineageBatchError(
          'prewrite_ownership',
          invalid,
          `cannot snapshot non-active remote sessions: ${invalid.join(', ')}`,
        );
      }
      return sessionIds.map((sessionId) => {
        const session = parsed[sessionId]!;
        return {
          sessionId,
          taskId: session.riffParentTaskId ?? null,
          owner: remoteDurableOwner(session),
        };
      });
    }, { maxWaitMs: options.maxWaitMs });
  } catch (error) {
    if (error instanceof RemoteLineageBatchError) throw error;
    throw new RemoteLineageBatchError(
      'prewrite_io',
      [...sessionIds],
      `failed to snapshot active remote sessions: ${String(error)}`,
    );
  }
}

/**
 * Commit every prepared remote lineage as one compare-and-set transaction.
 * The published projection is read back under the same lock before workers
 * are allowed to exit.
 */
export function persistActiveRemoteLineagesExactBatch(
  updates: readonly ActiveRemoteLineageBatchUpdate[],
  options: { maxWaitMs?: number } = {},
): ActiveRemoteShutdownSnapshot[] {
  if (updates.length === 0) return [];
  const sessionIds = updates.map(update => update.sessionId);
  const duplicates = duplicateIds(sessionIds);
  if (duplicates.length > 0) {
    throw new RemoteLineageBatchError(
      'prewrite_ownership',
      duplicates,
      `duplicate remote lineage batch session ids: ${duplicates.join(', ')}`,
    );
  }

  loadForWrite();
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
            || !remoteOwnersEqual(remoteDurableOwner(durable), update.owner)) {
          conflicts.push(update.sessionId);
        }
      }
      if (conflicts.length > 0) {
        throw new RemoteLineageBatchError(
          'prewrite_ownership',
          conflicts,
          `Remote lineage batch compare-and-set failed for: ${conflicts.join(', ')}`,
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
        testOnlyAfterRemoteBatchRename?.();
      }

      let verifiedProjection: Record<string, Session>;
      try {
        verifiedProjection = readSessionsProjectionStrict(fp).parsed;
      } catch (error) {
        throw new RemoteLineageBatchError(
          published ? 'postrename_ambiguity' : 'prewrite_io',
          [...sessionIds],
          `failed to read back Remote lineage batch: ${String(error)}`,
        );
      }

      const ambiguous = updates.filter((update) => {
        const durable = verifiedProjection[update.sessionId];
        return !durable
          || durable.status !== 'active'
          || (durable.riffParentTaskId ?? null) !== update.targetTaskId
          || !remoteOwnersEqual(remoteDurableOwner(durable), update.owner);
      }).map(update => update.sessionId);
      if (ambiguous.length > 0) {
        throw new RemoteLineageBatchError(
          published ? 'postrename_ambiguity' : 'prewrite_ownership',
          ambiguous,
          `Remote lineage batch readback mismatch for: ${ambiguous.join(', ')}`,
        );
      }

      const verified = updates.map((update) => ({
        sessionId: update.sessionId,
        taskId: update.targetTaskId,
        owner: remoteDurableOwner(verifiedProjection[update.sessionId]!),
      }));
      if (loaded) {
        for (const update of updates) {
          const cached = sessions.get(update.sessionId);
          if (cached) cached.riffParentTaskId = update.targetTaskId ?? undefined;
        }
      }
      return verified;
    }, { maxWaitMs: options.maxWaitMs });
  } catch (error) {
    if (error instanceof RemoteLineageBatchError) throw error;
    throw new RemoteLineageBatchError(
      published ? 'postrename_ambiguity' : 'prewrite_io',
      [...sessionIds],
      `failed to persist Remote lineage batch: ${String(error)}`,
    );
  } finally {
    if (tmpFp) {
      try { unlinkSync(tmpFp); } catch { /* best-effort orphan cleanup */ }
    }
  }
}

function save(): void {
  if (loadFailure) throw new SessionStoreUnavailableError(loadFailure);
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
  loadForWrite();
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

const bridgeMarkerCleanupFences = new Map<string, Promise<void>>();

export function registerSessionBridgeSendMarkerCleanupFence(
  sessionId: string,
  fence: Promise<void>,
): void {
  bridgeMarkerCleanupFences.set(sessionId, fence);
  void fence.then(
    () => {
      if (bridgeMarkerCleanupFences.get(sessionId) === fence) {
        bridgeMarkerCleanupFences.delete(sessionId);
      }
    },
    () => {
      if (bridgeMarkerCleanupFences.get(sessionId) === fence) {
        bridgeMarkerCleanupFences.delete(sessionId);
      }
    },
  );
}

/**
 * Return a row only when it belongs to this process's currently-initialised
 * bot store. Mutating daemon endpoints must use this instead of getSession(),
 * whose cross-file fallback is intentionally read-only discovery.
 */
export function getOwnedSession(sessionId: string): Session | undefined {
  load();
  return sessions.get(sessionId);
}

/** Cross-process fresh read ordered after daemon/CLI writes by the shared lock. */
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

export function cleanupSessionBridgeSendMarkersNow(sessionId: string): void {
  try { unlinkSync(join(config.session.dataDir, 'turn-sends', `${sessionId}.jsonl`)); } catch { /* absent/best effort */ }
}

export function cleanupSessionBridgeSendMarkers(sessionId: string): void {
  const fence = bridgeMarkerCleanupFences.get(sessionId);
  if (fence) {
    void fence.then(
      () => cleanupSessionBridgeSendMarkersNow(sessionId),
      () => cleanupSessionBridgeSendMarkersNow(sessionId),
    );
    return;
  }
  cleanupSessionBridgeSendMarkersNow(sessionId);
}

export function isValidMojoCloseJournal(
  value: unknown,
): value is NonNullable<Session['mojoCloseJournal']> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const journal = value as Record<string, unknown>;
  if (journal.phase !== 'preparing'
      && journal.phase !== 'prepared'
      && journal.phase !== 'uncertain') return false;
  if (typeof journal.requestId !== 'string' || !journal.requestId.trim()) return false;
  if (typeof journal.updatedAt !== 'string' || !journal.updatedAt.trim()) return false;
  return journal.taskId === undefined
    || (typeof journal.taskId === 'string' && !!journal.taskId.trim());
}

function mutateMojoCloseJournal(
  sessionId: string,
  mutate: (session: Session) => void,
): Session {
  loadForWrite();
  const session = sessions.get(sessionId);
  if (!session || session.status !== 'active') {
    throw new Error(`cannot mutate Mojo close journal for non-active session ${sessionId}`);
  }
  if (session.backendType !== 'mojo') {
    throw new Error(`cannot mutate Mojo close journal for non-Mojo session ${sessionId}`);
  }
  const priorJournal = session.mojoCloseJournal
    ? { ...session.mojoCloseJournal }
    : undefined;
  const priorTaskId = session.riffParentTaskId;
  if (session.mojoCloseJournal && !isValidMojoCloseJournal(session.mojoCloseJournal)) {
    throw new Error(`cannot mutate malformed Mojo close journal for ${sessionId}`);
  }
  mutate(session);
  try {
    save();
  } catch (error) {
    session.mojoCloseJournal = priorJournal;
    session.riffParentTaskId = priorTaskId;
    throw error;
  }
  return session;
}

/** Persist the admission fence before any authoritative Mojo cancel begins. */
export function beginMojoCloseJournal(
  sessionId: string,
  requestId: string,
  expectedTaskId?: string,
): Session {
  return mutateMojoCloseJournal(sessionId, (session) => {
    if (session.riffParentTaskId !== expectedTaskId) {
      throw new Error(`Mojo close lineage changed before prepare for ${sessionId}`);
    }
    const existing = session.mojoCloseJournal;
    if (existing) {
      if (existing.requestId !== requestId) {
        throw new Error(`another Mojo close journal already owns ${sessionId}`);
      }
      if (existing.phase !== 'preparing') {
        throw new Error(`cannot restart ${existing.phase} Mojo close journal for ${sessionId}`);
      }
      if (existing.taskId !== expectedTaskId) {
        throw new Error(`Mojo close journal lineage changed before retry for ${sessionId}`);
      }
      return;
    }
    session.mojoCloseJournal = {
      phase: 'preparing',
      requestId,
      ...(expectedTaskId ? { taskId: expectedTaskId } : {}),
      updatedAt: new Date().toISOString(),
    };
  });
}

/** Publish irreversible remote-cancel proof before the local close commit. */
export function markMojoClosePrepared(
  sessionId: string,
  requestId: string,
  taskId?: string,
): Session {
  return mutateMojoCloseJournal(sessionId, (session) => {
    const existing = session.mojoCloseJournal;
    if (existing && existing.requestId !== requestId) {
      throw new Error(`stale Mojo close prepare for ${sessionId}`);
    }
    if (existing?.phase === 'uncertain') {
      throw new Error(`cannot promote uncertain Mojo close journal for ${sessionId}`);
    }
    if (existing?.taskId && taskId && existing.taskId !== taskId) {
      throw new Error(`Mojo close proof changed journal lineage for ${sessionId}`);
    }
    const provenTaskId = taskId ?? existing?.taskId;
    if (provenTaskId && session.riffParentTaskId
        && session.riffParentTaskId !== provenTaskId) {
      throw new Error(`Mojo close result lineage changed for ${sessionId}`);
    }
    if (provenTaskId) session.riffParentTaskId = provenTaskId;
    session.mojoCloseJournal = {
      phase: 'prepared',
      requestId,
      ...(provenTaskId ? { taskId: provenTaskId } : {}),
      updatedAt: new Date().toISOString(),
    };
  });
}

/**
 * Finish a failed prepare after worker admission restore. If restore was not
 * proven, keep a durable uncertain fence; either way retain a newly discovered
 * pre-init lineage for later reconciliation.
 */
export function finishMojoCloseAbort(
  sessionId: string,
  requestId: string,
  options: { admissionRestored: boolean; taskId?: string },
): Session {
  return mutateMojoCloseJournal(sessionId, (session) => {
    const existing = session.mojoCloseJournal;
    if (!existing || existing.requestId !== requestId) {
      throw new Error(`stale Mojo close abort for ${sessionId}`);
    }
    if (existing.phase === 'prepared') {
      throw new Error(`cannot abort prepared Mojo close proof for ${sessionId}`);
    }
    if (existing.taskId && options.taskId && existing.taskId !== options.taskId) {
      throw new Error(`Mojo close abort changed journal lineage for ${sessionId}`);
    }
    const retainedTaskId = options.taskId ?? existing.taskId;
    if (retainedTaskId && session.riffParentTaskId
        && session.riffParentTaskId !== retainedTaskId) {
      throw new Error(`Mojo close abort lineage changed for ${sessionId}`);
    }
    if (retainedTaskId) session.riffParentTaskId = retainedTaskId;
    if (options.admissionRestored) {
      session.mojoCloseJournal = undefined;
      return;
    }
    session.mojoCloseJournal = {
      phase: 'uncertain',
      requestId,
      ...(retainedTaskId ? { taskId: retainedTaskId } : {}),
      updatedAt: new Date().toISOString(),
    };
  });
}

export function closeSession(
  sessionId: string,
  opts: {
    cleanupBridgeMarkers?: boolean;
    clearRiffParentTaskId?: boolean;
    /**
     * Park an uncancellable mojo lineage as PART of this transaction.
     *
     * The caller must not pre-write this onto its own Session object: the runtime
     * object is not always the authoritative row (and when it is, a failed save
     * would leave a parked id the rollback below does not know about). Merging it
     * here — against the store's own row, snapshotted and rolled back with
     * everything else — is what makes "closed + parked" actually atomic.
     */
    parkMojoLineage?: string;
  } = {},
): void {
  loadForWrite();
  const session = sessions.get(sessionId);
  if (session) {
    const priorStatus = session.status;
    const priorClosedAt = session.closedAt;
    const priorRiffParentTaskId = session.riffParentTaskId;
    const priorDashboardAttachments = session.dashboardAttachments;
    const priorQueuedAttachments = session.queuedAttachments;
    const priorQuarantinedLineage = session.mojoQuarantinedLineage;
    const priorQuarantineNoticePending = session.mojoQuarantineNoticePending;
    const priorMojoCloseJournal = session.mojoCloseJournal
      ? { ...session.mojoCloseJournal }
      : undefined;
    session.status = 'closed';
    session.closedAt = new Date().toISOString();
    session.dashboardAttachments = undefined;
    session.queuedAttachments = undefined;
    session.mojoCloseJournal = undefined;
    if (opts.parkMojoLineage) {
      // Keep both ids when a different one was already parked: each is the only
      // handle left for manual cleanup of its remote session.
      const already = session.mojoQuarantinedLineage;
      session.mojoQuarantinedLineage = already && already !== opts.parkMojoLineage
        ? `${already},${opts.parkMojoLineage}`
        : opts.parkMojoLineage;
      session.mojoQuarantineNoticePending = true;
    }
    // Riff cancellation has already completed before this durable transition.
    // Clear its retry handle in the same atomic save as status='closed'.
    if (opts.clearRiffParentTaskId) session.riffParentTaskId = undefined;
    try {
      save();
    } catch (err) {
      session.status = priorStatus;
      session.closedAt = priorClosedAt;
      session.riffParentTaskId = priorRiffParentTaskId;
      session.dashboardAttachments = priorDashboardAttachments;
      session.queuedAttachments = priorQueuedAttachments;
      // Without these two the row keeps a parked lineage after a FAILED close, so
      // the next turn treats a still-live remote session as quarantined and starts
      // a new one — i.e. the "close failed, retry unchanged" guarantee is broken.
      session.mojoQuarantinedLineage = priorQuarantinedLineage;
      session.mojoQuarantineNoticePending = priorQuarantineNoticePending;
      session.mojoCloseJournal = priorMojoCloseJournal;
      throw err;
    }
    if (session.larkAppId && priorDashboardAttachments?.length) {
      try {
        cleanupMaterializedDashboardImages(session.larkAppId, priorDashboardAttachments);
      } catch (error: any) {
        logger.warn(`Failed to clean Dashboard images for session ${sessionId}: ${error?.message ?? error}`);
      }
    }
    // turn-sends was originally a transient bridge-dedup file cleaned by a
    // live worker's close handler. Message previews now make its bounded tail
    // user-visible, so workerless/forced closes must apply the same cleanup;
    // otherwise closed sessions retain private reply text indefinitely.
    if (opts.cleanupBridgeMarkers !== false) cleanupSessionBridgeSendMarkers(sessionId);
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
  loadForWrite();
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
    mojoCloseJournal: session.mojoCloseJournal,
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
  session.mojoCloseJournal = undefined;

  try {
    save();
  } catch (err) {
    Object.assign(session, prior);
    throw err;
  }
  return { ok: true, session };
}

export function updateSessionPid(sessionId: string, pid: number | null): void {
  loadForWrite();
  const session = sessions.get(sessionId);
  if (session) {
    session.pid = pid ?? undefined;
    save();
  }
}

export function updateSession(session: Session): void {
  loadForWrite();
  sessions.set(session.sessionId, session);
  save();
}

/**
 * Persist one exact remote follow-up lineage for an active durable owner.
 * The process cache changes only after the atomic file replacement succeeds.
 */
export function persistActiveRemoteLineageExact(
  sessionId: string,
  taskId: string | null,
  options: {
    expectedCurrentTaskIds?: readonly (string | null)[];
    expectedOwner?: RemoteDurableOwner;
  } = {},
): Session {
  loadForWrite();
  ensureDir();
  const fp = getFilePath();
  return withFileLockSync(fp, () => {
    const { raw, parsed } = readExistingSessionsFromDisk(fp);
    const durable = parsed[sessionId];
    if (!durable || durable.status !== 'active') {
      throw new RemoteLineageOwnershipError(
        `cannot persist remote lineage for non-active session ${sessionId}`,
      );
    }
    const durableTaskId = durable.riffParentTaskId ?? null;
    const expected = options.expectedCurrentTaskIds;
    if (expected && !expected.some(candidate => candidate === durableTaskId)) {
      throw new RemoteLineageOwnershipError(
        `Remote lineage compare-and-set failed for ${sessionId} `
        + `(current=${durableTaskId ?? 'none'}, expected=${expected.map(id => id ?? 'none').join('|')})`,
      );
    }
    if (options.expectedOwner && !remoteOwnersEqual(remoteDurableOwner(durable), options.expectedOwner)) {
      throw new RemoteLineageOwnershipError(
        `Remote owner compare-and-set failed for ${sessionId} `
        + `(current=${JSON.stringify(remoteDurableOwner(durable))}, `
        + `expected=${JSON.stringify(options.expectedOwner)})`,
      );
    }

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
 * Return the current projection only when its backing file was loaded safely.
 * Use this for decisions that delete, retire, or reconfigure resources: the
 * legacy empty-on-error behaviour of listSessions() is unsafe at those gates.
 * A failed load remains unhealthy until init() explicitly selects/reloads a
 * store, avoiding a silent mid-transaction recovery against a different view.
 */
export function listSessionsStrict(): Session[] {
  load();
  if (loadFailure) throw new SessionStoreUnavailableError(loadFailure);
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

// ─── Cross-process offline access ───────────────────────────────────────────
// The only sanctioned ways to touch session rows from OUTSIDE the owning
// daemon process (agent-facing CLI subcommands, caller-identity proofs). Until
// 2026-08 the CLI kept its own parallel copies of these (loadSessions /
// saveSession / mutateSessionOffline in cli.ts) — one of which wrote the whole
// file WITHOUT the lock; they were absorbed here so persistence mechanics
// (file layout, lock, tmp+rename, legacy-field strip) stay private to this
// module.

/**
 * Read-only snapshot of every session row across the legacy `sessions.json`
 * and all per-bot `sessions-<appId>.json` files. Per-bot rows win duplicate
 * sessionIds and get `larkAppId` stamped from their filename so a later
 * offline mutation resolves the owning file. Deliberately lock-free: atomic
 * tmp+rename publication keeps each file self-consistent, and snapshot
 * composition must stay a pure reader (an older CLI opportunistically migrated
 * legacy rows here, which made even `botmux list` a whole-file writer able to
 * race a daemon save).
 */
export function loadAllSessionsSnapshot(options: {
  dataDir?: string;
  /** Per-bot fallback when the data dir cannot be enumerated (the CLI file
   *  sandbox exposes sessions-<self>.json but NOT a listing of data/). */
  fallbackAppId?: string;
} = {}): Map<string, Session> {
  const dataDir = options.dataDir ?? config.session.dataDir;
  const out = new Map<string, Session>();
  const readInto = (file: string, stampAppId?: string): void => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(join(dataDir, file), 'utf-8'));
    } catch { return; /* missing or corrupt file → skip */ }
    // Arrays are deliberately tolerated (Object.values yields their rows):
    // the historical CLI loader accepted array-shaped files and existing
    // fixtures/tools rely on that.
    if (!parsed || typeof parsed !== 'object') return;
    for (const value of Object.values(parsed as Record<string, unknown>)) {
      const session = value as Session;
      if (!session || typeof session !== 'object' || !session.sessionId) continue;
      repairMissingChatScope(session);
      if (stampAppId && !session.larkAppId) session.larkAppId = stampAppId;
      out.set(session.sessionId, session);
    }
  };
  readInto('sessions.json');
  try {
    for (const file of readdirSync(dataDir)) {
      if (file.startsWith('sessions-') && file.endsWith('.json')) {
        readInto(file, file.slice('sessions-'.length, -'.json'.length));
      }
    }
  } catch {
    if (options.fallbackAppId) {
      readInto(`sessions-${options.fallbackAppId}.json`, options.fallbackAppId);
    }
  }
  return out;
}

/**
 * Unlocked point-read of one row straight from disk, bypassing this process's
 * in-memory cache: the owning per-bot file first, then the legacy
 * `sessions.json`. Atomic tmp+rename publication keeps each file
 * self-consistent, so this never blocks on (or throws from) the store lock —
 * safe on hot paths that only need a freshness hint.
 */
export function readSessionRowFromDisk(
  sessionId: string,
  larkAppId?: string,
  dataDir: string = config.session.dataDir,
): Session | undefined {
  const files = larkAppId
    ? [`sessions-${larkAppId}.json`, 'sessions.json']
    : ['sessions.json'];
  for (const file of files) {
    const fp = join(dataDir, file);
    if (!existsSync(fp)) continue;
    try {
      const data = JSON.parse(readFileSync(fp, 'utf-8')) as Record<string, Session>;
      if (data[sessionId]) return data[sessionId];
    } catch { /* ignore corrupt/racing session file */ }
  }
  return undefined;
}

/**
 * Fail-closed identity scan: every file's copy of one session row across the
 * legacy and all per-bot files — one entry per file that holds the id. An
 * unlistable data dir THROWS: a caller proving "this row resolves exactly
 * once" must not mistake an unreadable store for an empty one. A corrupt
 * individual file is skipped: an unrelated bot's bad file must neither block
 * nor impersonate a valid record; the target row still has to resolve from a
 * readable file.
 */
export function readSessionRowCopiesAcrossStores(
  sessionId: string,
  dataDir: string = config.session.dataDir,
): Session[] {
  const files = readdirSync(dataDir).filter((name) => (
    name === 'sessions.json'
    || (name.startsWith('sessions-') && name.endsWith('.json'))
  ));
  const matches: Session[] = [];
  for (const file of files) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(join(dataDir, file), 'utf-8')) as unknown;
    } catch { continue; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
    const keyed = (parsed as Record<string, unknown>)[sessionId];
    if (!keyed || typeof keyed !== 'object' || Array.isArray(keyed)) continue;
    const session = keyed as Session;
    if (session.sessionId !== sessionId) continue;
    matches.push(session);
  }
  return matches;
}

/**
 * Locked offline mutation of one exact row in its owning file (per-bot when
 * the caller-observed row carries `larkAppId`, legacy `sessions.json`
 * otherwise). Re-reads the row under the SAME lock the owning daemon uses for
 * every save and hands the FRESH copy to `mutate` — never publishing the
 * caller's possibly-stale snapshot — then republishes with the daemon's own
 * tmp+rename / mismatched-key cleanup / legacy-field strip.
 *
 * `abortIf` is evaluated under the lock at entry and re-evaluated immediately
 * before publication; returning true abandons the mutation with `undefined`
 * (callers pass a daemon-liveness probe so an owning daemon that appears
 * mid-flight stays authoritative and the file is left untouched).
 *
 * Returns the fresh row — mutated when `mutate` returned true, otherwise
 * unmodified (so `() => false` is a locked fresh read) — or undefined when
 * the row is absent or `abortIf` aborted.
 */
export function mutateSessionRowOffline(
  target: { sessionId: string; larkAppId?: string },
  mutate: (current: Session) => boolean,
  options: { dataDir?: string; abortIf?: () => boolean } = {},
): Session | undefined {
  const dataDir = options.dataDir ?? config.session.dataDir;
  const fileName = target.larkAppId ? `sessions-${target.larkAppId}.json` : 'sessions.json';
  const fp = join(dataDir, fileName);
  return withFileLockSync(fp, () => {
    if (options.abortIf?.()) return undefined;
    let data: Record<string, Session> = {};
    if (existsSync(fp)) {
      try { data = JSON.parse(readFileSync(fp, 'utf-8')); } catch { /* start fresh */ }
    }
    const current = data[target.sessionId];
    if (!current || !mutate(current)) return current;
    data[target.sessionId] = current;

    // Clean up entries where the file key doesn't match the entry's sessionId
    // (data corruption), and strip removed placeholder-card fields — the same
    // convergence the daemon's save() applies.
    for (const [key, val] of Object.entries(data)) {
      if (val && typeof val === 'object' && 'sessionId' in val && (val as Session).sessionId !== key) {
        delete data[key];
        continue;
      }
      if (val && typeof val === 'object') stripLegacyPendingCardFields(val as unknown as Record<string, unknown>);
    }

    if (options.abortIf?.()) return undefined;
    const tmpFp = `${fp}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(tmpFp, JSON.stringify(data, null, 2), 'utf-8');
    renameSync(tmpFp, fp);
    return current;
  });
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
