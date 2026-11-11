import { config } from '../config.js';
import { fetchDaemonIpc } from '../core/daemon-ipc-auth.js';
import type { DaemonSession } from '../core/types.js';
import { findOnlineDaemon } from '../utils/daemon-discovery.js';
import { readGroupCollaborationMode, type GroupCollaborationModeConfig } from './group-collaboration-mode-store.js';
import { readProjectGroup, type ProjectGroupState } from './project-group-store.js';
import { getProjectAttachmentSource } from './project-workstream-runtime.js';
import type { ProjectAttachmentSource } from './project-workstream-attachments.js';
import { projectImportSnapshotFromSource } from './project-import-snapshot.js';
export { projectImportSnapshotFromSource } from './project-import-snapshot.js';
import {
  createProjectImportNotifications,
  projectImportOperationId,
  type ProjectImportCoordinator,
  type ProjectImportNotification,
  type ProjectImportNotificationRuntime,
  type ProjectImportPolicy,
  type ProjectImportSource,
} from './project-import-notifications.js';

export const PROJECT_IMPORT_DELIVER_ROUTE = '/api/project-import/deliver';
export const PROJECT_IMPORT_COORDINATORS_ROUTE = '/api/project-workstream/coordinators';

export type ProjectImportRuntimeSource = ProjectAttachmentSource & { chatType?: 'group' | 'p2p' };

/** Recovery reads the source daemon's persisted import episode marker. Plain
 * session creation, /repo and worker restart without such a marker are not new
 * imports. No title/content/owner is included in this recovery projection. */
export interface ProjectImportRecoverableSession {
  sessionId: string;
  larkAppId?: string;
  chatId: string;
  rootMessageId: string;
  chatType?: 'group' | 'p2p';
  scope?: 'chat' | 'thread';
  status: string;
  projectRouteRevision?: number;
  projectImportSource?: ProjectImportSource;
  projectImportPending?: boolean;
}

export interface ProjectImportRuntimeDeps {
  dataDir: string;
  getMode(chatId: string): GroupCollaborationModeConfig | undefined;
  getProject(chatId: string): ProjectGroupState | undefined;
  getSource(appId: string, sessionId: string): Promise<ProjectImportRuntimeSource | undefined>;
  listRecoverableSessions(): readonly ProjectImportRecoverableSession[];
  /** Compare-and-set clear the SAME source revision after durable enqueue, or
   * after explicit disable; never clear a newer migration's pending marker. */
  markEnqueued?(session: ProjectImportRecoverableSession, outcome: 'queued' | 'skipped'): void;
  /** The local daemon may have the exact coordinator in memory. This is not a
   * fallback to another arbitrary chat session. */
  localCoordinator(sessionId: string): ProjectImportCoordinator | undefined;
  findDaemon(appId: string): { ipcPort: number } | undefined;
  fetchIpc(port: number, path: string, init?: RequestInit): Promise<Response>;
  now?(): number;
  log?(message: string): void;
}

export interface ProjectImportRuntime {
  notifications: ProjectImportNotificationRuntime;
  /** The daemon owns scheduling. Reentrant ticks reuse their pending promise. */
  tick(): Promise<{ recovered: number; delivered: number; pending: number; cancelled: number }>;
}

const IMPORT_SOURCES = new Set(['relay', 'bind', 'adopt', 'resume_import', 'fork']);
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/;
const knownSource = (source: string): source is ProjectImportSource => IMPORT_SOURCES.has(source);

/** This result is deliberately narrower than a successful trigger HTTP status.
 * "accepted" without durable input evidence can still be outcome-unknown. */
export function projectImportRegistrationOutcome(
  value: unknown,
  target: ProjectImportCoordinator,
): 'delivered' | 'unknown' {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'unknown';
  const body = value as Record<string, unknown>;
  const commit = body.inputCommitted as Record<string, unknown> | undefined;
  return body.ok === true && body.schemaVersion === 1 && body.state === 'registered'
    && body.sessionId === target.sessionId && body.larkAppId === target.larkAppId
    && commit?.state === 'observed'
    ? 'delivered' : 'unknown';
}

const PRE_DELIVERY_ERRORS = new Set([
  'project_import_policy_changed', 'project_import_source_changed',
  'project_import_coordinator_unavailable', 'project_import_coordinator_mismatch',
  'project_import_invalid_target', 'project_import_not_committed',
  'source_changed', 'policy_disabled', 'coordinator_unavailable',
]);

export function createProjectImportRuntime(deps: ProjectImportRuntimeDeps): ProjectImportRuntime {
  const policy = (chatId: string): ProjectImportPolicy | undefined => {
    const mode = deps.getMode(chatId);
    if (!mode) return;
    const project = deps.getProject(chatId);
    return {
      mode: mode.mode, importedSessionPolicy: mode.importedSessionPolicy ?? 'ignore',
      projectExists: !!project && project.larkAppId === mode.coordinatorAppId,
      projectGeneration: project?.createdAt ?? '',
      coordinatorAppId: mode.coordinatorAppId,
      workerAppIds: mode.workerAppIds ?? [],
    };
  };

  const current = async (appId: string, sessionId: string) =>
    projectImportSnapshotFromSource(await deps.getSource(appId, sessionId));

  async function coordinators(chatId: string, appId: string): Promise<ProjectImportCoordinator[]> {
    const project = deps.getProject(chatId);
    const mode = deps.getMode(chatId);
    if (!project || mode?.mode !== 'project' || mode.coordinatorAppId !== appId
      || project.larkAppId !== appId) return [];
    const local = deps.localCoordinator(project.coordinatorSessionId);
    if (local) return local.larkAppId === appId && local.chatId === chatId
      && local.sessionId === project.coordinatorSessionId && local.scope === 'chat'
      && local.status === 'active' ? [local] : [];
    const daemon = deps.findDaemon(appId);
    if (!daemon) return [];
    try {
      const response = await deps.fetchIpc(daemon.ipcPort, PROJECT_IMPORT_COORDINATORS_ROUTE, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chatId, coordinatorLarkAppId: appId, coordinatorSessionId: project.coordinatorSessionId }),
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) return [];
      const body = await response.json() as { ok?: unknown; coordinators?: unknown };
      if (body.ok !== true || !Array.isArray(body.coordinators)) return [];
      // Never let an old/faulty peer select a different session or destination.
      return body.coordinators.filter((c): c is ProjectImportCoordinator => !!c
        && typeof c === 'object' && !Array.isArray(c)
        && c.sessionId === project.coordinatorSessionId && c.larkAppId === appId
        && c.chatId === chatId && c.scope === 'chat' && c.status === 'active')
        .map(c => ({ sessionId: c.sessionId, larkAppId: c.larkAppId, chatId: c.chatId, scope: c.scope, status: c.status }));
    } catch { return []; }
  }

  async function registration(notification: ProjectImportNotification): Promise<'delivered' | 'unknown'> {
    const delivery = notification.delivery;
    if (!delivery) return 'unknown';
    const daemon = deps.findDaemon(delivery.target.larkAppId);
    if (!daemon) return 'unknown';
    try {
      const path = `/api/sessions/${encodeURIComponent(delivery.target.sessionId)}/trigger-registration`
        + `?turnIdempotencyKey=${encodeURIComponent(delivery.idempotencyKey)}`;
      const response = await deps.fetchIpc(daemon.ipcPort, path, { signal: AbortSignal.timeout(5_000) });
      if (!response.ok) return 'unknown';
      return projectImportRegistrationOutcome(await response.json(), delivery.target);
    } catch { return 'unknown'; }
  }

  const notifications = createProjectImportNotifications({
    dataDir: deps.dataDir, now: deps.now, log: deps.log,
    getPolicy: policy, getCurrent: current, getCoordinator: coordinators,
    reconcileDelivery: registration,
    deliver: async (notification, input) => {
      await input.beforeDeliver();
      const daemon = deps.findDaemon(input.target.larkAppId);
      if (!daemon) return 'retry';
      try {
        const response = await deps.fetchIpc(daemon.ipcPort, PROJECT_IMPORT_DELIVER_ROUTE, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ notification, target: input.target, idempotencyKey: input.idempotencyKey }),
          signal: AbortSignal.timeout(10_000),
        });
        const body = await response.json().catch(() => undefined) as Record<string, unknown> | undefined;
        if (!response.ok && body?.ok === false && typeof body.error === 'string'
          && PRE_DELIVERY_ERRORS.has(body.error) && body.preDispatch === true) return 'retry';
        // Even an HTTP success/"delivered" receipt is not durable input proof.
        // Resolve the exact app/session/key registration before completing the
        // outbox. Generic trigger_failed/500 can also follow accepted input.
        return registration({ ...notification, delivery: { target: input.target, idempotencyKey: input.idempotencyKey } });
      } catch {
        return registration({ ...notification, delivery: { target: input.target, idempotencyKey: input.idempotencyKey } });
      }
    },
  });

  let ticking: Promise<{ recovered: number; delivered: number; pending: number; cancelled: number }> | undefined;
  let recoveryCursor = 0;
  async function tickNow() {
    let recovered = 0;
    const pending = deps.listRecoverableSessions().filter(session => session.projectImportPending === true);
    const offset = pending.length ? recoveryCursor % pending.length : 0;
    const candidates = [...pending.slice(offset), ...pending.slice(0, offset)].slice(0, 50);
    recoveryCursor = pending.length ? (offset + candidates.length) % pending.length : 0;
    for (const session of candidates) {
      if (!session.larkAppId || !session.projectImportSource || !knownSource(session.projectImportSource)
        || session.projectImportPending !== true
        || session.status !== 'active' || session.chatType !== 'group' || session.scope !== 'thread'
        || !Number.isSafeInteger(session.projectRouteRevision) || (session.projectRouteRevision ?? 0) <= 0
        || !ID.test(session.sessionId)) continue;
      const effective = policy(session.chatId);
      // Fast gate before querying another daemon or resolving source owner.
      if (effective?.mode !== 'project' || effective.importedSessionPolicy !== 'notify'
        || !effective.projectExists || !effective.workerAppIds?.includes(session.larkAppId)) {
        deps.markEnqueued?.(session, 'skipped');
        continue;
      }
      try {
        const source = await current(session.larkAppId, session.sessionId);
        if (!source || source.routeRevision !== session.projectRouteRevision
          || source.chatId !== session.chatId || source.rootMessageId !== session.rootMessageId
          || source.source !== session.projectImportSource) continue;
        const queued = notifications.enqueue({ operationId: projectImportOperationId(source), snapshot: source });
        if (queued.id || queued.reason === 'notifications_disabled' || queued.reason === 'not_ordinary_thread') {
          deps.markEnqueued?.(session, queued.id ? 'queued' : 'skipped');
        }
        if (queued.queued && queued.reason !== 'duplicate') recovered++;
      } catch {
        deps.log?.('[project-import] committed import recovery pending');
      }
    }
    return { recovered, ...await notifications.flush({ limit: 10 }) };
  }

  return {
    notifications,
    tick() {
      if (ticking) return ticking;
      const task = tickNow();
      ticking = task;
      void task.finally(() => { if (ticking === task) ticking = undefined; }).catch(() => undefined);
      return task;
    },
  };
}

/** Install only in the owning daemon. Scheduling is explicitly its caller's
 * responsibility, so importing this module never starts timers or reads state. */
export function installProjectImportRuntime(options: {
  listActiveSessions(): readonly DaemonSession[];
  findActiveBySessionId(sessionId: string): DaemonSession | undefined;
  markEnqueued?: ProjectImportRuntimeDeps['markEnqueued'];
}): ProjectImportRuntime {
  const runtime = createProjectImportRuntime({
    dataDir: config.session.dataDir,
    getMode: chatId => readGroupCollaborationMode(config.session.dataDir, chatId),
    getProject: chatId => readProjectGroup(config.session.dataDir, chatId),
    getSource: getProjectAttachmentSource,
    listRecoverableSessions: () => options.listActiveSessions().map(ds => {
      const session = ds.session as typeof ds.session & { projectImportPending?: boolean };
      return {
        sessionId: session.sessionId,
        larkAppId: session.larkAppId,
        chatId: session.chatId,
        rootMessageId: session.rootMessageId,
        chatType: session.chatType,
        scope: session.scope,
        status: session.status,
        projectRouteRevision: session.projectRouteRevision,
        projectImportSource: session.projectImportSource,
        projectImportPending: session.projectImportPending,
      };
    }),
    markEnqueued: options.markEnqueued,
    localCoordinator: sessionId => {
      const ds = options.findActiveBySessionId(sessionId);
      return ds ? { sessionId, larkAppId: ds.larkAppId, chatId: ds.chatId, scope: ds.scope, status: ds.session.status } : undefined;
    },
    findDaemon: appId => findOnlineDaemon(appId) ?? undefined,
    fetchIpc: fetchDaemonIpc,
  });
  return runtime;
}
