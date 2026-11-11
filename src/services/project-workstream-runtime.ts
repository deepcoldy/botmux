import { config } from '../config.js';
import type { DaemonSession } from '../core/types.js';
import * as sessionStore from './session-store.js';
import { findOnlineDaemon } from '../utils/daemon-discovery.js';
import { fetchDaemonIpc } from '../core/daemon-ipc-auth.js';
import { resolveUnionIdFromOpenIdStrict, lookupMessageChatId } from '../im/lark/client.js';
import { readGroupCollaborationMode } from './group-collaboration-mode-store.js';
import { readProjectGroup } from './project-group-store.js';
import { projectCoordinator } from './project-coordinator-runtime.js';
import { loadOrCreateDispatchReportBindingSecret } from '../core/dispatch-report-binding.js';
import { projectOwnerKey, projectCallerOwnerKey } from './project-workstream-authority.js';
import { createProjectWorkstreamAttachments, readProjectAttachmentRecord, type ProjectAttachmentActor, type ProjectAttachmentSource } from './project-workstream-attachments.js';
import { safeTextPreview } from './insight/safe-detail.js';
import type { TrustedCaller, Session } from '../types.js';
import { getBinding } from './issue-board-store.js';
import { verifyDispatchReportBinding } from '../core/dispatch-report-binding.js';

export interface ProjectWorkstreamPool {
  findActiveBySessionId(sessionId: string): DaemonSession | undefined;
}

let workstreamPool: ProjectWorkstreamPool | undefined;

/** The daemon/IPC composition root installs its pool after bootstrap. Services
 * must not import the worker-pool (which itself imports the daemon IPC graph),
 * or loading a route can initialize a second unconfigured pool during a cycle. */
export function setProjectWorkstreamPool(pool: ProjectWorkstreamPool | undefined): void {
  workstreamPool = pool;
}

function findActiveBySessionId(sessionId: string): DaemonSession | undefined {
  return workstreamPool?.findActiveBySessionId(sessionId);
}

/** Freshness is proved against the denied host journal, not the CLI-readable
 * registry. Replaying an old valid signature cannot revive a revoked source. */
export async function validateProjectAttachmentReport(
  registry: Record<string, unknown>, root: string, appId: string, sessionId: string,
): Promise<{ ok: true; ownerKey?: string; routeRevision?: number } | { ok: false; error: string }> {
  const localSourceIdentity = () => {
    const ds = findActiveBySessionId(sessionId);
    if (!ds) return '';
    const s = ds.session;
    return JSON.stringify([s.sessionId, s.larkAppId, s.chatId, s.rootMessageId, s.status,
      s.ownerOpenId, s.ownerUnionId, s.projectRouteRevision, s.cliSessionId, s.pendingForkSession,
      !!s.workflowNode, !!s.vcMeetingReceiver, !!s.messageListenerRun, !!s.deferredScheduleRun,
      !!s.adoptedFrom, ds.cliReady]);
  };
  const identityBefore = localSourceIdentity();
  const entry = registry[root] as Record<string, unknown> | undefined;
  const binding = verifyDispatchReportBinding(
    loadOrCreateDispatchReportBindingSecret(config.session.dataDir), root, entry?.reportBinding,
  );
  if (!binding?.attachment) {
    // A journal exists: absence of imported fields is a downgrade attack.
    if (readProjectAttachmentRecord(config.session.dataDir, root)) return { ok: false, error: 'dispatch_attachment_inactive' };
    return { ok: true };
  }
  const record = readProjectAttachmentRecord(config.session.dataDir, root);
  const source = await getProjectAttachmentSource(appId, sessionId);
  const mode = record && readGroupCollaborationMode(config.session.dataDir, record.chatId);
  const project = record && readProjectGroup(config.session.dataDir, record.chatId);
  if (!record || record.phase !== 'active' || record.state !== 'active'
    || mode?.mode !== 'project' || mode.coordinatorAppId !== record.coordinatorLarkAppId
    || !mode.workerAppIds?.includes(appId)
    || project?.createdAt !== record.projectGeneration
    || project.coordinatorSessionId !== record.coordinatorSessionId || project.larkAppId !== record.coordinatorLarkAppId
    || !project.workstreams.some(item => item.dispatchRoot === root)
    || record.revision !== binding.attachment.revision
    || record.source.sessionId !== sessionId || record.source.larkAppId !== appId
    || record.source.routeRevision !== binding.attachment.sourceRouteRevision
    || source?.status !== 'active' || source.chatId !== record.chatId || source.rootMessageId !== root
    || source.ownerKey !== record.source.ownerKey || source.routeRevision !== record.source.routeRevision
    || binding.attachment.sourceSessionId !== source.sessionId || binding.attachment.sourceLarkAppId !== source.larkAppId
    || binding.attachment.ownerKey !== source.ownerKey || binding.attachment.reportCapability !== 'verified'
    || !source.ordinary || source.reportCapability !== 'verified') return { ok: false, error: 'dispatch_attachment_inactive' };
  const coordinator = await getProjectAttachmentSource(record.coordinatorLarkAppId, record.coordinatorSessionId);
  if (coordinator?.status !== 'active' || coordinator.scope !== 'chat'
    || coordinator.chatId !== record.chatId || coordinator.ownerKey !== record.coordinatorOwnerKey
    || binding.targetSessionId !== record.coordinatorSessionId
    || binding.targetLarkAppId !== record.coordinatorLarkAppId) return { ok: false, error: 'dispatch_attachment_inactive' };
  const finalSource = await getProjectAttachmentSource(appId, sessionId);
  const finalRecord = readProjectAttachmentRecord(config.session.dataDir, root);
  const finalMode = readGroupCollaborationMode(config.session.dataDir, record.chatId);
  const finalProject = readProjectGroup(config.session.dataDir, record.chatId);
  if (!finalSource || JSON.stringify(finalSource) !== JSON.stringify(source)
    || JSON.stringify(finalRecord) !== JSON.stringify(record)
    || finalMode?.mode !== 'project' || finalMode.coordinatorAppId !== record.coordinatorLarkAppId
    || !finalMode.workerAppIds?.includes(appId)
    || finalProject?.createdAt !== record.projectGeneration
    || finalProject.coordinatorSessionId !== record.coordinatorSessionId
    || finalProject.larkAppId !== record.coordinatorLarkAppId) {
    return { ok: false, error: 'dispatch_attachment_inactive' };
  }
  const finalCoordinator = await getProjectAttachmentSource(record.coordinatorLarkAppId, record.coordinatorSessionId);
  const currentSource = findActiveBySessionId(sessionId);
  const currentMode = readGroupCollaborationMode(config.session.dataDir, record.chatId);
  const currentProject = readProjectGroup(config.session.dataDir, record.chatId);
  if (!finalCoordinator || finalCoordinator.status !== 'active'
    || finalCoordinator.larkAppId !== record.coordinatorLarkAppId
    || finalCoordinator.chatId !== record.chatId || finalCoordinator.scope !== 'chat'
    || finalCoordinator.ownerKey !== record.coordinatorOwnerKey
    || !currentSource || !currentSource.cliReady || currentSource.session.status !== 'active'
    || currentSource.session.chatId !== record.chatId || currentSource.session.rootMessageId !== root
    || (currentSource.session.projectRouteRevision ?? 1) !== record.source.routeRevision
    || currentMode?.mode !== 'project' || currentMode.coordinatorAppId !== record.coordinatorLarkAppId
    || !currentMode.workerAppIds?.includes(appId)
    || currentProject?.coordinatorSessionId !== record.coordinatorSessionId
    || localSourceIdentity() !== identityBefore
    || JSON.stringify(readProjectAttachmentRecord(config.session.dataDir, root)) !== JSON.stringify(record)) {
    return { ok: false, error: 'dispatch_attachment_inactive' };
  }
  return { ok: true, ownerKey: source.ownerKey, routeRevision: source.routeRevision };
}

/** Owner-key normalization is read-only. A failed cross-app identity lookup
 * never borrows another bot's open_id namespace. */
export async function projectSessionOwnerKey(session: Pick<Session, 'larkAppId' | 'ownerOpenId' | 'ownerUnionId'>): Promise<string | undefined> {
  if (!session.larkAppId) return;
  if (session.ownerUnionId) return projectOwnerKey({ ...session, larkAppId: session.larkAppId });
  if (session.ownerOpenId) {
    const lookup = await resolveUnionIdFromOpenIdStrict(session.larkAppId, session.ownerOpenId).catch(() => undefined);
    if (lookup?.status === 'resolved') return projectOwnerKey({ larkAppId: session.larkAppId, ownerUnionId: lookup.unionId });
  }
  return projectOwnerKey({ ...session, larkAppId: session.larkAppId });
}

export async function projectHumanCallerKey(caller: TrustedCaller | undefined | null): Promise<string | undefined> {
  if (caller?.senderType !== 'user' || caller.source || !caller.requestLarkAppId) return;
  if (!caller.requestUserUnionId && caller.requestUserOpenId) {
    const lookup = await resolveUnionIdFromOpenIdStrict(caller.requestLarkAppId, caller.requestUserOpenId).catch(() => undefined);
    if (lookup?.status === 'resolved') return projectCallerOwnerKey({ ...caller, requestUserUnionId: lookup.unionId });
  }
  return projectCallerOwnerKey(caller);
}

export async function localProjectAttachmentSource(appId: string, sessionId: string): Promise<ProjectAttachmentSource | undefined> {
  const live = findActiveBySessionId(sessionId);
  const session = live?.session ?? sessionStore.getOwnedSession(sessionId);
  if (!session || session.larkAppId !== appId) return;
  const before = JSON.stringify([session.sessionId, session.chatId, session.rootMessageId, session.projectRouteRevision, session.ownerOpenId, session.ownerUnionId, session.status]);
  const ownerKey = await projectSessionOwnerKey(session);
  const latestLive = findActiveBySessionId(sessionId);
  const latest = latestLive?.session ?? sessionStore.getOwnedSession(sessionId);
  if (!latest || before !== JSON.stringify([latest.sessionId, latest.chatId, latest.rootMessageId, latest.projectRouteRevision, latest.ownerOpenId, latest.ownerUnionId, latest.status])) return;
  const issueBinding = getBinding(config.session.dataDir, latest.scope === 'chat' ? latest.chatId : latest.rootMessageId);
  const ordinary = !latest.workflowNode && !latest.vcMeetingReceiver
    && !(issueBinding && issueBinding.larkAppId === appId)
    && !latest.messageListenerRun && !latest.deferredScheduleRun;
  return {
    sessionId, larkAppId: appId, chatId: latest.chatId, rootMessageId: latest.rootMessageId,
    scope: latest.scope ?? 'thread', status: latest.status, chatType: latest.chatType,
    ownerKey, routeRevision: latest.projectRouteRevision ?? 1,
    source: latest.projectImportSource ?? 'manual', ordinary,
    // Capability is a property of the association, not of the current worker
    // generation: idle suspension/reclaim clears cliReady while the session
    // stays active. Freezing that transient state into attach or letting status
    // downgrade on it would reject every later report from the woken worker.
    // Report-time readiness is checked separately in
    // validateProjectAttachmentReport.
    reportCapability: latest.adoptedFrom ? 'manual'
      : latest.pendingForkSession || !latest.cliSessionId || !latestLive ? 'unavailable' : 'verified',
    title: safeTextPreview(latest.title, 80)?.text,
  };
}

export async function getProjectAttachmentSource(appId: string, sessionId: string): Promise<ProjectAttachmentSource | undefined> {
  const local = await localProjectAttachmentSource(appId, sessionId);
  if (local) return local;
  const peer = findOnlineDaemon(appId);
  if (!peer) return;
  const response = await fetchDaemonIpc(peer.ipcPort, '/api/project-workstream/source', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sourceSessionId: sessionId, sourceLarkAppId: appId }),
    signal: AbortSignal.timeout(5000),
  }).catch(() => undefined);
  if (!response?.ok) return;
  const body = await response.json().catch(() => undefined) as { source?: ProjectAttachmentSource } | undefined;
  return body?.source?.sessionId === sessionId && body.source.larkAppId === appId ? body.source : undefined;
}

export function projectAttachmentActorAllowed(actor: ProjectAttachmentActor): boolean {
  const ds = findActiveBySessionId(actor.sessionId);
  return !!actor.turnId && !!ds && ds.larkAppId === actor.larkAppId && ds.chatId === actor.chatId
    && ds.scope === 'chat' && ds.managedTurnOrigin?.turnId === actor.turnId;
}

type ProjectWorkstreamService = ReturnType<typeof createProjectWorkstreamAttachments>;
let cachedWorkstreamService: { dataDir: string; service: ProjectWorkstreamService } | undefined;

/** Importing the IPC module must not read session configuration before daemon
 * bootstrap (or a test fixture) has initialized it. Keep a stable facade for
 * IPC callers/spies and bind each service instance to its selected state root. */
function workstreamService(): ProjectWorkstreamService {
  const dataDir = config.session.dataDir;
  if (cachedWorkstreamService?.dataDir === dataDir) return cachedWorkstreamService.service;
  const service = createProjectWorkstreamAttachments({
    dataDir,
    getSource: getProjectAttachmentSource,
    getProject: chatId => readProjectGroup(dataDir, chatId),
    getMode: chatId => readGroupCollaborationMode(dataDir, chatId),
    projectRun: (context, action, beforeApply) => projectCoordinator.run(context, action, beforeApply),
    reportSecret: () => loadOrCreateDispatchReportBindingSecret(dataDir),
    actorAllowed: projectAttachmentActorAllowed,
    lookupRoot: async (chatId, root) => {
      const project = readProjectGroup(dataDir, chatId);
      return !!project && await lookupMessageChatId(project.larkAppId, root) === chatId;
    },
  });
  cachedWorkstreamService = { dataDir, service };
  return service;
}

export const projectWorkstreamAttachments: ProjectWorkstreamService = {
  inspect: (...args) => workstreamService().inspect(...args),
  attach: (...args) => workstreamService().attach(...args),
  update: (...args) => workstreamService().update(...args),
  rename: (...args) => workstreamService().rename(...args),
  reconcile: (...args) => workstreamService().reconcile(...args),
  observe: (...args) => workstreamService().observe(...args),
};
