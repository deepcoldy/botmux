import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { withSecureHostParentSync } from '../platform/secure-host-file.js';

export type ProjectImportSource = 'relay' | 'bind' | 'adopt' | 'resume_import' | 'fork';

/** An authoritative source-daemon snapshot, not a CLI-supplied claim. Revision
 * advances on a real association change, not on a worker refork. */
export interface ProjectImportSnapshot {
  sessionId: string;
  larkAppId: string;
  chatId: string;
  rootMessageId: string;
  chatType: 'group' | 'p2p';
  scope: 'thread' | 'chat';
  status: string;
  routeRevision: number;
  ordinary: boolean;
  source: ProjectImportSource;
}

export interface ProjectImportPolicy {
  mode: 'standard' | 'project';
  importedSessionPolicy?: 'ignore' | 'notify';
  projectExists: boolean;
  /** Stable project incarnation, for example ProjectGroupState.createdAt. */
  projectGeneration: string;
  coordinatorAppId?: string;
  workerAppIds?: readonly string[];
}

export interface ProjectImportCoordinator {
  sessionId: string;
  larkAppId: string;
  chatId: string;
  scope: 'thread' | 'chat';
  /** Only authoritative live, active chat sessions qualify. */
  status: string;
}

export interface ProjectImportEvent {
  operationId: string;
  snapshot: ProjectImportSnapshot;
}

export interface ProjectImportNotification {
  schemaVersion: 1;
  id: string;
  operationId: string;
  snapshot: ProjectImportSnapshot;
  projectGeneration: string;
  coordinatorAppId: string;
  state: 'pending' | 'delivered' | 'cancelled';
  attempts: number;
  nextAttemptAt?: number;
  createdAt: string;
  updatedAt: string;
  deliveredAt?: string;
  reason?: string;
  delivery?: {
    target: ProjectImportCoordinator;
    idempotencyKey: string;
  };
  lease?: { token: string; expiresAt: number };
}

/** retry proves this transport invocation did not deliver, not that an earlier
 * invocation with a lost response never delivered. */
export type ProjectImportDeliveryOutcome = 'delivered' | 'retry' | 'unknown';

export interface ProjectImportNotificationDeps {
  dataDir: string;
  getPolicy(chatId: string): ProjectImportPolicy | undefined;
  /** undefined = not observable/offline; a closed snapshot = definitive close.
   * Never infer that an unavailable daemon means its session was deleted. */
  getCurrent(larkAppId: string, sessionId: string): ProjectImportSnapshot | undefined | Promise<ProjectImportSnapshot | undefined>;
  getCoordinator(chatId: string, larkAppId: string): readonly ProjectImportCoordinator[] | Promise<readonly ProjectImportCoordinator[]>;
  /** MUST use the provided stable idempotency key, including retries after a
   * lost response. Call beforeDeliver at the actual dispatch boundary too. */
  deliver(notification: ProjectImportNotification, input: {
    target: ProjectImportCoordinator;
    idempotencyKey: string;
    beforeDeliver(): Promise<void>;
  }): Promise<ProjectImportDeliveryOutcome>;
  /** Required to retarget a previously attempted notification safely. Without
   * a definitive not_delivered result, a successor must not get a second copy. */
  reconcileDelivery?(notification: ProjectImportNotification): Promise<'delivered' | 'not_delivered' | 'unknown'>;
  now?(): number;
  leaseMs?: number;
  log?(message: string): void;
}

export interface ProjectImportNotificationRuntime {
  enqueue(event: ProjectImportEvent): { queued: boolean; id?: string; reason?: string };
  flush(input?: { limit?: number }): Promise<{ delivered: number; pending: number; cancelled: number }>;
  list(): ProjectImportNotification[];
}

const STORE_DIRECTORY = '.dashboard-secret.project-imports';
const SOURCES = new Set<ProjectImportSource>(['relay', 'bind', 'adopt', 'resume_import', 'fork']);
const RECORD_NAME = /^[a-f0-9]{64}\.json$/;
const safeId = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(value);
const prefixedId = (value: unknown, prefix: string): value is string =>
  typeof value === 'string' && new RegExp(`^${prefix}[A-Za-z0-9_-]{1,128}$`).test(value);

function validSnapshot(value: unknown): value is ProjectImportSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const s = value as ProjectImportSnapshot;
  return safeId(s.sessionId) && prefixedId(s.larkAppId, 'cli_') && prefixedId(s.chatId, 'oc_')
    && prefixedId(s.rootMessageId, 'om_')
    && (s.chatType === 'group' || s.chatType === 'p2p')
    && (s.scope === 'chat' || s.scope === 'thread') && safeId(s.status)
    && Number.isSafeInteger(s.routeRevision) && s.routeRevision > 0
    && typeof s.ordinary === 'boolean' && SOURCES.has(s.source);
}

function projectAllows(policy: ProjectImportPolicy | undefined, source: ProjectImportSnapshot): policy is ProjectImportPolicy & { coordinatorAppId: string } {
  return !!policy && policy.mode === 'project' && policy.importedSessionPolicy === 'notify'
    && policy.projectExists && safeId(policy.projectGeneration)
    && prefixedId(policy.coordinatorAppId, 'cli_') && policy.coordinatorAppId !== source.larkAppId
    && (!policy.workerAppIds || policy.workerAppIds.includes(source.larkAppId));
}

function sameAssociation(a: ProjectImportSnapshot, b: ProjectImportSnapshot): boolean {
  return a.sessionId === b.sessionId && a.larkAppId === b.larkAppId && a.chatId === b.chatId
    && a.rootMessageId === b.rootMessageId && a.scope === b.scope
    && a.chatType === b.chatType && a.routeRevision === b.routeRevision;
}

/** Explicit allowlist: no title, cwd, owner identity, transcript or screen
 * survives even if an upstream caller passed extra object properties. */
function snapshotMetadata(s: ProjectImportSnapshot): ProjectImportSnapshot {
  return {
    sessionId: s.sessionId, larkAppId: s.larkAppId, chatId: s.chatId,
    rootMessageId: s.rootMessageId, chatType: s.chatType, scope: s.scope,
    status: s.status, routeRevision: s.routeRevision, ordinary: s.ordinary, source: s.source,
  };
}

function coordinatorMetadata(c: ProjectImportCoordinator): ProjectImportCoordinator {
  return { sessionId: c.sessionId, larkAppId: c.larkAppId, chatId: c.chatId, scope: c.scope, status: c.status };
}

function eligible(s: ProjectImportSnapshot): boolean {
  return s.chatType === 'group' && s.scope === 'thread' && s.status === 'active' && s.ordinary;
}

class NotificationFenceError extends Error {
  constructor(readonly reason: string, readonly cancel: boolean) { super(reason); }
}

/**
 * Metadata-only, default-off import outbox. Records are retained after delivery
 * or cancellation. Each write is a secure, crash-durable atomic replacement.
 * File locks protect short claims; a lease and target-specific idempotency key
 * protect asynchronous delivery across multiple daemons and process restarts.
 */
export function createProjectImportNotifications(deps: ProjectImportNotificationDeps): ProjectImportNotificationRuntime {
  const directory = join(deps.dataDir, STORE_DIRECTORY);
  const now = deps.now ?? Date.now;
  const leaseMs = Math.max(1_000, Math.min(deps.leaseMs ?? 60_000, 5 * 60_000));
  let flushing: Promise<{ delivered: number; pending: number; cancelled: number }> | undefined;

  function ensureDirectory(): void {
    try { mkdirSync(directory, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    assertDirectory();
  }

  function assertDirectory(): void {
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()
      || (process.getuid && stat.uid !== process.getuid())
      || (process.platform !== 'win32' && (stat.mode & 0o022) !== 0)) {
      throw new Error('unsafe_project_import_directory');
    }
  }

  function parseRecord(text: string | null, id: string): ProjectImportNotification | undefined {
    if (text === null) return undefined;
    const r = JSON.parse(text) as ProjectImportNotification;
    const fields = new Set(['schemaVersion', 'id', 'operationId', 'snapshot', 'projectGeneration',
      'coordinatorAppId', 'state', 'attempts', 'nextAttemptAt', 'createdAt', 'updatedAt',
      'deliveredAt', 'reason', 'delivery', 'lease']);
    if (!r || r.schemaVersion !== 1 || r.id !== id || !safeId(r.operationId)
      || Object.keys(r).some(key => !fields.has(key))
      || createHash('sha256').update(r.operationId).digest('hex') !== id
      || !validSnapshot(r.snapshot) || !safeId(r.projectGeneration)
      || !prefixedId(r.coordinatorAppId, 'cli_')
      || !['pending', 'delivered', 'cancelled'].includes(r.state)
      || !Number.isSafeInteger(r.attempts) || r.attempts < 0
      || (r.nextAttemptAt !== undefined && !Number.isFinite(r.nextAttemptAt))
      || !safeId(r.createdAt) || !safeId(r.updatedAt)
      || (r.lease && (!safeId(r.lease.token) || !Number.isFinite(r.lease.expiresAt)))
      || (r.delivery && (!safeId(r.delivery.idempotencyKey)
        || !safeId(r.delivery.target?.sessionId)
        || r.delivery.target.larkAppId !== r.coordinatorAppId
        || r.delivery.target.chatId !== r.snapshot.chatId
        || r.delivery.target.scope !== 'chat'))) {
      throw new Error('invalid_project_import_record');
    }
    r.snapshot = snapshotMetadata(r.snapshot);
    if (r.delivery) r.delivery.target = coordinatorMetadata(r.delivery.target);
    return r;
  }

  function mutateRecord<T>(id: string, fn: (record: ProjectImportNotification | undefined) => {
    record?: ProjectImportNotification; result: T;
  }): T {
    assertDirectory();
    return withSecureHostParentSync(join(directory, `${id}.json`), parent => parent.withLeafLock(() => {
      const current = parseRecord(parent.readLeaf(), id);
      const next = fn(current);
      if (next.record) parent.writeLeaf(JSON.stringify(next.record));
      return { value: next.result };
    })).value;
  }

  function list(): ProjectImportNotification[] {
    try { assertDirectory(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    const records: ProjectImportNotification[] = [];
    for (const name of readdirSync(directory).filter(name => RECORD_NAME.test(name))) {
      const id = name.slice(0, -5);
      const record = mutateRecord(id, current => ({ result: current }));
      if (record) records.push(record);
    }
    return records.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }

  function enqueue(event: ProjectImportEvent): { queued: boolean; id?: string; reason?: string } {
    if (!safeId(event.operationId) || !validSnapshot(event.snapshot)) throw new Error('invalid_project_import_event');
    const source = snapshotMetadata(event.snapshot);
    if (!eligible(source)) return { queued: false, reason: 'not_ordinary_thread' };
    const policy = deps.getPolicy(source.chatId);
    if (!projectAllows(policy, source)) return { queued: false, reason: 'notifications_disabled' };
    ensureDirectory();
    const id = createHash('sha256').update(event.operationId).digest('hex');
    return mutateRecord<{ queued: boolean; id?: string; reason?: string }>(id, current => {
      if (current) {
        if (!sameAssociation(current.snapshot, source) || current.snapshot.source !== source.source
          || current.projectGeneration !== policy.projectGeneration || current.coordinatorAppId !== policy.coordinatorAppId) {
          throw new Error('project_import_operation_conflict');
        }
        return { result: { queued: current.state === 'pending', id, reason: 'duplicate' } };
      }
      const timestamp = new Date(now()).toISOString();
      return {
        record: {
          schemaVersion: 1, id, operationId: event.operationId, snapshot: source,
          projectGeneration: policy.projectGeneration, coordinatorAppId: policy.coordinatorAppId,
          state: 'pending', attempts: 0, createdAt: timestamp, updatedAt: timestamp,
        },
        result: { queued: true, id },
      };
    });
  }

  async function liveFence(record: ProjectImportNotification, target?: ProjectImportCoordinator): Promise<void> {
    const policy = deps.getPolicy(record.snapshot.chatId);
    if (!projectAllows(policy, record.snapshot) || policy.projectGeneration !== record.projectGeneration
      || policy.coordinatorAppId !== record.coordinatorAppId) throw new NotificationFenceError('project_policy_changed', true);
    const current = await deps.getCurrent(record.snapshot.larkAppId, record.snapshot.sessionId);
    if (!current) throw new NotificationFenceError('source_unavailable', false);
    if (!validSnapshot(current) || !sameAssociation(current, record.snapshot) || !eligible(current)) {
      throw new NotificationFenceError('source_association_changed', true);
    }
    if (target) {
      const candidates = await coordinators(record);
      if (candidates.length !== 1 || candidates[0]!.sessionId !== target.sessionId) {
        throw new NotificationFenceError('coordinator_unavailable', false);
      }
      const latestSource = await deps.getCurrent(record.snapshot.larkAppId, record.snapshot.sessionId);
      if (!latestSource) throw new NotificationFenceError('source_unavailable', false);
      if (!validSnapshot(latestSource) || !sameAssociation(latestSource, record.snapshot) || !eligible(latestSource)) {
        throw new NotificationFenceError('source_association_changed', true);
      }
    }
    // Awaited source/coordinator lookups cannot preserve an old policy grant.
    const latestPolicy = deps.getPolicy(record.snapshot.chatId);
    if (!projectAllows(latestPolicy, record.snapshot) || latestPolicy.projectGeneration !== record.projectGeneration
      || latestPolicy.coordinatorAppId !== record.coordinatorAppId) throw new NotificationFenceError('project_policy_changed', true);
  }

  async function coordinators(record: ProjectImportNotification): Promise<ProjectImportCoordinator[]> {
    return (await deps.getCoordinator(record.snapshot.chatId, record.coordinatorAppId))
      .filter(c => safeId(c.sessionId) && c.larkAppId === record.coordinatorAppId
        && c.chatId === record.snapshot.chatId && c.scope === 'chat' && c.status === 'active')
      .map(coordinatorMetadata);
  }

  function finish(record: ProjectImportNotification, token: string, state: ProjectImportNotification['state'], reason?: string): boolean {
    return mutateRecord(record.id, current => {
      if (!current || current.state !== 'pending' || current.lease?.token !== token) return { result: false };
      current.state = state;
      current.updatedAt = new Date(now()).toISOString();
      if (state === 'delivered') current.deliveredAt = current.updatedAt;
      if (state === 'pending') current.nextAttemptAt = now() + Math.min(5 * 60_000, 5_000 * 2 ** Math.min(current.attempts - 1, 6));
      else delete current.nextAttemptAt;
      if (reason) current.reason = reason; else delete current.reason;
      delete current.lease;
      return { record: current, result: true };
    });
  }

  async function deliverOne(id: string): Promise<'delivered' | 'pending' | 'cancelled'> {
    const token = randomUUID();
    let record = mutateRecord(id, current => {
      if (!current || current.state !== 'pending' || (current.nextAttemptAt ?? 0) > now()
        || (current.lease && current.lease.expiresAt > now())) {
        return { result: undefined };
      }
      current.lease = { token, expiresAt: now() + leaseMs };
      current.attempts++;
      current.updatedAt = new Date(now()).toISOString();
      return { record: current, result: structuredClone(current) };
    });
    if (!record) return 'pending';
    let newDelivery = false;
    let dispatchAttempted = false;
    try {
      await liveFence(record);
      const candidates = await coordinators(record);
      const candidate = candidates.length === 1 ? candidates[0] : undefined;
      if (record.delivery && (!candidate || candidate.sessionId !== record.delivery.target.sessionId)) {
        // A lost acknowledgement can mean the old coordinator received it.
        // Never send to a successor until non-delivery has been established.
        const outcome = await deps.reconcileDelivery?.(record) ?? 'unknown';
        if (outcome === 'delivered') {
          return finish(record, token, 'delivered') ? 'delivered' : 'pending';
        }
        if (outcome !== 'not_delivered') throw new NotificationFenceError('delivery_outcome_unknown', false);
        record = mutateRecord(id, current => {
          if (!current || current.lease?.token !== token) throw new NotificationFenceError('lease_superseded', false);
          delete current.delivery;
          return { record: current, result: structuredClone(current) };
        });
      }
      if (!candidate) throw new NotificationFenceError('coordinator_unavailable', false);
      if (!record.delivery) {
        record = mutateRecord(id, current => {
          if (!current || current.state !== 'pending' || current.lease?.token !== token) {
            throw new NotificationFenceError('lease_superseded', false);
          }
          current.delivery = {
            target: candidate,
            idempotencyKey: `project-import:${current.id}:${createHash('sha256').update(candidate.sessionId).digest('hex').slice(0, 24)}`,
          };
          return { record: current, result: structuredClone(current) };
        });
        newDelivery = true;
      }
      const attemptedRecord = record;
      const delivery = record.delivery!;
      const beforeDeliver = async () => {
        await liveFence(attemptedRecord, delivery.target);
        mutateRecord(id, current => {
          if (!current || current.state !== 'pending' || current.lease?.token !== token) {
            throw new NotificationFenceError('lease_superseded', false);
          }
          current.lease.expiresAt = now() + leaseMs;
          return { record: current, result: undefined };
        });
      };
      await beforeDeliver();
      dispatchAttempted = true;
      const outcome = await deps.deliver(structuredClone(record), {
        ...delivery, beforeDeliver,
      });
      if (outcome === 'delivered') return finish(record, token, 'delivered') ? 'delivered' : 'pending';
      if (outcome === 'retry' && newDelivery) {
        // Definitive pre-delivery failure; a later coordinator may be selected.
        mutateRecord(id, current => {
          if (!current || current.lease?.token !== token) return { result: undefined };
          delete current.delivery;
          return { record: current, result: undefined };
        });
      }
      finish(record, token, 'pending', outcome === 'unknown' ? 'delivery_outcome_unknown' : 'delivery_retry');
      return 'pending';
    } catch (error) {
      // We know a freshly selected target never received a dispatch when the
      // local pre-delivery fence failed before calling the transport.
      if (newDelivery && !dispatchAttempted) {
        mutateRecord(id, current => {
          if (!current || current.lease?.token !== token) return { result: undefined };
          delete current.delivery;
          return { record: current, result: undefined };
        });
      }
      const fence = error instanceof NotificationFenceError ? error : undefined;
      const state = fence?.cancel ? 'cancelled' : 'pending';
      const reason = fence?.reason ?? 'delivery_outcome_unknown';
      finish(record, token, state, reason);
      // Do not log provider messages: errors can include raw request bodies.
      deps.log?.(`[project-import] ${id.slice(0, 12)} ${reason}`);
      return state;
    }
  }

  async function flushNow(input?: { limit?: number }) {
    const limit = Math.max(1, Math.min(Math.floor(input?.limit ?? 10) || 10, 50));
    const result = { delivered: 0, pending: 0, cancelled: 0 };
    for (const record of list().filter(r => r.state === 'pending'
      && (r.nextAttemptAt ?? 0) <= now()).slice(0, limit)) {
      result[await deliverOne(record.id)]++;
    }
    return result;
  }

  function flush(input?: { limit?: number }) {
    if (flushing) return flushing;
    const task = flushNow(input);
    flushing = task;
    void task.finally(() => { if (flushing === task) flushing = undefined; }).catch(() => undefined);
    return task;
  }

  return { enqueue, list, flush };
}

/** The same committed source episode is recorded by the hot path and the
 * recovery scan. Real moves/imports advance revision, so A→B→A is distinct. */
export function projectImportOperationId(snapshot: Pick<ProjectImportSnapshot, 'larkAppId' | 'sessionId' | 'routeRevision'>): string {
  return `project-import-${createHash('sha256').update(JSON.stringify([
    snapshot.larkAppId, snapshot.sessionId, snapshot.routeRevision,
  ])).digest('hex')}`;
}
