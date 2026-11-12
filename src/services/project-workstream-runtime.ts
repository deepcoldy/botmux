import { config } from '../config.js';
import { getBot } from '../bot-registry.js';
import { botHasConfiguredAllowlist } from '../core/bot-allowlist.js';
import type { DaemonSession } from '../core/types.js';
import * as sessionStore from './session-store.js';
import { findOnlineDaemon } from '../utils/daemon-discovery.js';
import { fetchDaemonIpc } from '../core/daemon-ipc-auth.js';
import { resolveUnionIdFromOpenIdStrict, lookupMessageChatId, resolveTargetAppOpenId } from '../im/lark/client.js';
import { getIdentity } from '../im/lark/identity-cache.js';
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
import { readAllowedUsersResolveCache } from '../utils/allowed-users-cache.js';
import { isTeamBot } from './team-bots-store.js';
import { isPlatformTeamBot } from './platform-team-store.js';
import { noteProjectAssociationChanged } from '../core/project-session-association-events.js';
import { logger } from '../utils/logger.js';

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

/** Report-time runtime liveness for an attached source session.
 *  During an active turn (`runtime_busy`), `SessionController` clears
 *  `runtime.promptReady`, so `ds.cliReady` is legitimately `false` throughout
 *  the turn that executes `botmux report`. Require a live worker generation
 *  and bound native session instead of an idle prompt. */
function isSourceSessionRuntimeLive(ds: DaemonSession | undefined): ds is DaemonSession {
  if (!ds) return false;
  const s = ds.session;
  if (s.status !== 'active' || !s.cliSessionId || s.pendingForkSession || s.suspendedColdResume) {
    return false;
  }
  if (s.sessionLifecycle && s.sessionLifecycle !== 'active') {
    return false;
  }
  if (ds.worker !== undefined && (!ds.worker || ds.worker.killed)) {
    return false;
  }
  if (ds.workerReady !== undefined) {
    return ds.workerReady === true;
  }
  return ds.worker !== undefined ? true : ds.cliReady === true;
}

/** Display-only metadata may refresh mid-turn (the pinned/topic cards read it);
 *  every other field stays in the comparison, so a field later added to
 *  ProjectAttachmentSource is checked by default instead of silently dropping
 *  out of the freshness proof. `title`, `recentSummary` and `botName` are the
 *  display fields: they are excluded from `sourceIdentity()` in the attachment
 *  journal and stripped before the record is persisted, so a busy-turn summary
 *  refresh must not fail a report that is otherwise the same source. */
function authoritativeSourceIdentity(source: ProjectAttachmentSource): string {
  const {
    title: _displayOnlyTitle,
    recentSummary: _displayOnlySummary,
    botName: _displayOnlyBotName,
    ...authoritative
  } = source;
  return JSON.stringify(authoritative);
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
      !!s.suspendedColdResume, s.sessionLifecycle ?? 'active',
      !!s.workflowNode, !!s.vcMeetingReceiver, !!s.messageListenerRun, !!s.deferredScheduleRun,
      !!s.adoptedFrom, ds.workerGeneration ?? null, isSourceSessionRuntimeLive(ds)]);
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
  if (!finalSource || authoritativeSourceIdentity(finalSource) !== authoritativeSourceIdentity(source)
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
    || !isSourceSessionRuntimeLive(currentSource)
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
    recentSummary: safeTextPreview(latestLive?.currentTurnTitle || latest.nativeSessionTitle, 80)?.text,
    botName: resolveSourceBotDisplayName(appId),
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

const HOST_CARD_CALLBACK_ACTOR = Symbol('hostCardCallbackActor');
const UNION_ID_RE = /^on_[A-Za-z0-9_-]{1,128}$/u;
const OPEN_ID_RE = /^ou_[A-Za-z0-9_-]{1,128}$/u;
const APP_ID_RE = /^cli_[A-Za-z0-9_-]{1,128}$/u;
const CHAT_ID_RE = /^oc_[A-Za-z0-9_-]{1,128}$/u;
const ROOT_ID_RE = /^om_[A-Za-z0-9_-]{1,128}$/u;

function tryGetBot(appId: string): ReturnType<typeof getBot> | undefined {
  try { return getBot(appId); } catch { return undefined; }
}

/** Human-only operator gate matching event-dispatcher canOperate without its bot-union legs. */
export function canHumanOperateBot(larkAppId: string, humanOpenId: string | undefined): boolean {
  const bot = tryGetBot(larkAppId);
  if (!bot) return false;
  if (humanOpenId && bot.resolvedAllowedUsers.includes(humanOpenId)) return true;
  if (humanOpenId && bot.resolvedBlockedUsers.includes(humanOpenId)) return false;
  return !botHasConfiguredAllowlist(bot);
}

export function resolveSourceBotDisplayName(appId: string, dataDir = config.session.dataDir): string {
  const local = tryGetBot(appId)?.botName?.trim();
  if (local) return local;
  const peer = findOnlineDaemon(appId, dataDir)?.botName?.trim();
  return peer || appId;
}

/** Non-serializable host proof used only by verified Feishu card callbacks in-daemon. */
export function markHostCardCallbackActor(actor: ProjectAttachmentActor): ProjectAttachmentActor {
  Object.defineProperty(actor, HOST_CARD_CALLBACK_ACTOR, {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return actor;
}

export interface ClaimOwnerlessProjectSourceInput {
  sourceLarkAppId: string;
  sourceSessionId: string;
  chatId: string;
  rootMessageId: string;
  expectedRouteRevision?: number;
  claimantUnionId: string;
  claimantLarkAppId: string;
  claimantOpenId: string;
  via: 'human_turn_attach' | 'topic_card_confirm';
}

export type ClaimOwnerlessProjectSourceResult =
  | { ok: true; alreadyClaimed: boolean; source: ProjectAttachmentSource }
  | { ok: false; error: string };

export async function resolveHumanOpenIdOnApp(
  targetLarkAppId: string,
  humanUnionId: string,
): Promise<string | undefined> {
  if (!APP_ID_RE.test(targetLarkAppId) || !UNION_ID_RE.test(humanUnionId)) return undefined;
  const direct = await resolveTargetAppOpenId(targetLarkAppId, humanUnionId).catch(() => undefined);
  if (direct?.status === 'resolved' && OPEN_ID_RE.test(direct.openId)) {
    return direct.openId;
  }
  const cached = readAllowedUsersResolveCache(config.session.dataDir, targetLarkAppId)[humanUnionId];
  if (cached && OPEN_ID_RE.test(cached)) return cached;
  try {
    const matches = [...new Set(
      sessionStore.listSessions()
        .filter(s => s.larkAppId === targetLarkAppId && s.ownerUnionId === humanUnionId && OPEN_ID_RE.test(s.ownerOpenId ?? ''))
        .map(s => s.ownerOpenId!),
    )];
    if (matches.length === 1) return matches[0];
  } catch { /* Fall closed to undefined if store snapshot is unavailable. */ }
  return undefined;
}

async function resolveClaimantOpenIdOnSourceApp(
  sourceLarkAppId: string,
  claimantUnionId: string,
  claimantLarkAppId: string,
  claimantOpenId: string,
): Promise<string | undefined> {
  if (claimantLarkAppId === sourceLarkAppId && OPEN_ID_RE.test(claimantOpenId)) {
    return claimantOpenId;
  }
  return resolveHumanOpenIdOnApp(sourceLarkAppId, claimantUnionId);
}

/**
 * Execute an ownerless source-session claim on the daemon that owns `sourceLarkAppId`.
 * Returns `undefined` when this process does not host `sourceLarkAppId` / `sourceSessionId`.
 */
export async function localClaimOwnerlessProjectSource(
  input: ClaimOwnerlessProjectSourceInput,
): Promise<ClaimOwnerlessProjectSourceResult | undefined> {
  const {
    sourceLarkAppId, sourceSessionId, chatId, rootMessageId, expectedRouteRevision,
    claimantUnionId, claimantLarkAppId, claimantOpenId, via,
  } = input;
  if (!APP_ID_RE.test(sourceLarkAppId) || !APP_ID_RE.test(claimantLarkAppId)
    || !CHAT_ID_RE.test(chatId) || !ROOT_ID_RE.test(rootMessageId)
    || !UNION_ID_RE.test(claimantUnionId) || !OPEN_ID_RE.test(claimantOpenId)
    || !sourceSessionId || sourceSessionId.length > 256) {
    return { ok: false, error: 'invalid_workstream_source' };
  }
  if (!tryGetBot(sourceLarkAppId)) return undefined;
  const live = findActiveBySessionId(sourceSessionId);
  const durableBefore = sessionStore.getOwnedSession(sourceSessionId);
  const initialSession = live?.session ?? durableBefore;
  if (!initialSession || initialSession.larkAppId !== sourceLarkAppId) return undefined;

  const auditDeny = (reason: string) => {
    logger.warn(
      `[project-workstream-claim] outcome=denied reason=${reason} via=${via} `
      + `session=${sourceSessionId} app=${sourceLarkAppId} chat=${chatId} root=${rootMessageId} `
      + `operator_union=${claimantUnionId} coordinator_open=${claimantOpenId} at=${new Date().toISOString()}`,
    );
  };

  const dataDir = config.session.dataDir;
  if (isTeamBot(dataDir, claimantUnionId) || isPlatformTeamBot(dataDir, claimantUnionId)) {
    auditDeny('actor_nonhuman');
    return { ok: false, error: 'actor_nonhuman' };
  }
  const resolvedSourceOpenId = await resolveClaimantOpenIdOnSourceApp(
    sourceLarkAppId, claimantUnionId, claimantLarkAppId, claimantOpenId,
  );
  if (resolvedSourceOpenId) {
    const cachedIdentity = getIdentity(sourceLarkAppId, resolvedSourceOpenId);
    if (cachedIdentity?.type === 'bot' || cachedIdentity?.type === 'app') {
      auditDeny('actor_nonhuman');
      return { ok: false, error: 'actor_nonhuman' };
    }
  }
  if (!canHumanOperateBot(sourceLarkAppId, resolvedSourceOpenId)) {
    auditDeny('source_claim_operator_not_allowed');
    return { ok: false, error: 'source_claim_operator_not_allowed' };
  }

  const currentLive = findActiveBySessionId(sourceSessionId);
  const currentDurable = sessionStore.getOwnedSession(sourceSessionId);
  const session = currentLive?.session ?? currentDurable;
  if (!session || session.larkAppId !== sourceLarkAppId) {
    return { ok: false, error: 'source_session_unavailable' };
  }
  if (session.status !== 'active' || session.chatId !== chatId || session.rootMessageId !== rootMessageId
    || (session.scope ?? 'thread') !== 'thread'
    || (expectedRouteRevision !== undefined && (session.projectRouteRevision ?? 1) !== expectedRouteRevision)) {
    auditDeny('source_route_mismatch');
    return { ok: false, error: 'source_route_mismatch' };
  }
  const issueBinding = getBinding(dataDir, session.rootMessageId);
  const ordinary = !session.workflowNode && !session.vcMeetingReceiver
    && !(issueBinding && issueBinding.larkAppId === sourceLarkAppId)
    && !session.messageListenerRun && !session.deferredScheduleRun
    && !currentLive?.pendingRepo && !session.pendingRepoSetup;
  if (!ordinary) {
    auditDeny('source_managed_elsewhere');
    return { ok: false, error: 'source_managed_elsewhere' };
  }

  const existingUnion = session.ownerUnionId ?? currentDurable?.ownerUnionId;
  const existingOpen = session.ownerOpenId ?? currentDurable?.ownerOpenId;
  if (existingUnion !== undefined || existingOpen !== undefined) {
    const sameClaimant = existingUnion === claimantUnionId
      && (session.ownerUnionId === undefined || session.ownerUnionId === claimantUnionId)
      && (currentDurable?.ownerUnionId === undefined || currentDurable.ownerUnionId === claimantUnionId)
      && (existingOpen === undefined || (resolvedSourceOpenId !== undefined && existingOpen === resolvedSourceOpenId));
    if (!sameClaimant) {
      auditDeny('source_owner_already_present');
      return { ok: false, error: 'source_owner_already_present' };
    }
    const existingSource = await localProjectAttachmentSource(sourceLarkAppId, sourceSessionId);
    if (!existingSource) return { ok: false, error: 'source_session_unavailable' };
    logger.info(
      `[project-workstream-claim] outcome=already_claimed via=${via} `
      + `session=${sourceSessionId} app=${sourceLarkAppId} chat=${chatId} root=${rootMessageId} `
      + `routeRevision=${session.projectRouteRevision ?? 1} operator_union=${claimantUnionId} at=${new Date().toISOString()}`,
    );
    return { ok: true, alreadyClaimed: true, source: existingSource };
  }

  const prevOwnerUnionId = session.ownerUnionId;
  const prevOwnerOpenId = session.ownerOpenId;
  const prevDsOwnerOpenId = currentLive?.ownerOpenId;
  try {
    session.ownerUnionId = claimantUnionId;
    if (resolvedSourceOpenId) {
      session.ownerOpenId = resolvedSourceOpenId;
      if (currentLive) currentLive.ownerOpenId = resolvedSourceOpenId;
    }
    sessionStore.updateSession(session);
  } catch (error) {
    session.ownerUnionId = prevOwnerUnionId;
    session.ownerOpenId = prevOwnerOpenId;
    if (currentLive) currentLive.ownerOpenId = prevDsOwnerOpenId;
    auditDeny('source_claim_persist_failed');
    return { ok: false, error: error instanceof Error ? error.message : 'source_claim_persist_failed' };
  }

  noteProjectAssociationChanged(session);
  const claimedSource = await localProjectAttachmentSource(sourceLarkAppId, sourceSessionId);
  if (!claimedSource) return { ok: false, error: 'source_session_unavailable' };
  logger.info(
    `[project-workstream-claim] outcome=claimed via=${via} `
    + `session=${sourceSessionId} app=${sourceLarkAppId} chat=${chatId} root=${rootMessageId} `
    + `routeRevision=${session.projectRouteRevision ?? 1} operator_union=${claimantUnionId} `
    + `coordinator_open=${claimantOpenId} source_open=${resolvedSourceOpenId ?? 'unresolved'} at=${new Date().toISOString()}`,
  );
  return { ok: true, alreadyClaimed: false, source: claimedSource };
}

export async function claimOwnerlessProjectSource(
  input: ClaimOwnerlessProjectSourceInput,
): Promise<ClaimOwnerlessProjectSourceResult> {
  const local = await localClaimOwnerlessProjectSource(input);
  if (local) return local;
  const peer = findOnlineDaemon(input.sourceLarkAppId);
  if (!peer) return { ok: false, error: 'source_session_unavailable' };
  const response = await fetchDaemonIpc(peer.ipcPort, '/api/project-workstream/claim-source', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(5_000),
  }).catch(() => undefined);
  if (!response) return { ok: false, error: 'source_session_unavailable' };
  const body = await response.json().catch(() => undefined) as {
    ok?: boolean;
    alreadyClaimed?: boolean;
    source?: ProjectAttachmentSource;
    error?: string;
  } | undefined;
  if (response.ok && body?.ok === true && body.source?.sessionId === input.sourceSessionId
    && body.source.larkAppId === input.sourceLarkAppId) {
    return { ok: true, alreadyClaimed: body.alreadyClaimed === true, source: body.source };
  }
  return { ok: false, error: typeof body?.error === 'string' && body.error ? body.error : 'source_session_unavailable' };
}

export function projectAttachmentActorAllowed(actor: ProjectAttachmentActor): boolean {
  const ds = findActiveBySessionId(actor.sessionId);
  if ((actor as unknown as Record<symbol, unknown>)[HOST_CARD_CALLBACK_ACTOR] === true) {
    const session = ds?.session ?? sessionStore.getOwnedSession(actor.sessionId);
    return !!session && session.status === 'active' && !session.vcMeetingReceiver
      && (ds
        ? ds.larkAppId === actor.larkAppId && ds.chatId === actor.chatId && ds.scope === 'chat'
        : session.larkAppId === actor.larkAppId && session.chatId === actor.chatId && session.scope === 'chat');
  }
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
