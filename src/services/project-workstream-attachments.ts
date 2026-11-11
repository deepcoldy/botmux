/**
 * Imported project workstreams. The journal is host authority; project cards
 * and dispatch registry rows are repairable projections of it. Registration
 * never reads a transcript and never infers completion from session liveness.
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import {
  readSecureHostFileSync, secureHostFilePath, writeSecureHostFileSync,
} from '../platform/secure-host-file.js';
import { withFileLock } from '../utils/file-lock.js';
import { updateDispatchRegistry } from '../core/dispatch-registry.js';
import { recordDispatchLastReport } from '../core/dispatch-task-tree.js';
import {
  createDispatchReportBinding, verifyDispatchReportBinding,
  type DispatchReportAttachment,
} from '../core/dispatch-report-binding.js';
import type { ProjectCoordinatorAction, ProjectCoordinatorContext } from './project-coordinator.js';
import {
  mutateProjectGroup, type ProjectGroupState, type ProjectWorkstreamStatus,
} from './project-group-store.js';
import type { GroupCollaborationModeConfig } from './group-collaboration-mode-store.js';
import { safeScrubAndTruncate } from './insight/scrub.js';

export type ProjectAttachmentSourceKind = 'relay' | 'bind' | 'adopt' | 'resume_import' | 'fork' | 'manual';
export interface ProjectAttachmentSource {
  sessionId: string;
  larkAppId: string;
  chatId: string;
  rootMessageId: string;
  scope: 'chat' | 'thread';
  chatType?: 'group' | 'p2p';
  status: string;
  ownerKey?: string;
  routeRevision: number;
  source: ProjectAttachmentSourceKind;
  ordinary: boolean;
  reportCapability: DispatchReportAttachment['reportCapability'];
  title?: string;
}

/** Identity is constructed by the authenticated host route, not request JSON. */
export interface ProjectAttachmentActor {
  sessionId: string;
  larkAppId: string;
  chatId: string;
  scope: 'chat';
  ownerKey?: string;
  /** Source owner proved by a host-signed consent scoped to this exact source
   * route and coordinator. The route must never accept this field from JSON. */
  authorizedSourceOwnerKey?: string;
  authorizedSourceSessionId?: string;
  authorizedSourceLarkAppId?: string;
  authorizedSourceRootMessageId?: string;
  authorizedSourceRouteRevision?: number;
  /** Host closure checks an exact grant again at every commit boundary. */
  sourceAuthorizationStillValid?: () => boolean;
  /** Admission-frozen caller/turn capability and current operator policy. */
  authorizationStillValid?: () => boolean;
  turnId?: string;
}

export interface ProjectAttachmentRequest {
  sourceSessionId: string;
  sourceLarkAppId: string;
  rootMessageId: string;
  title?: string;
  purpose?: string;
  /** Explicit compare-and-set when the source session/route episode changed. */
  expectedRevision?: number;
}

export interface ProjectAttachmentRecord {
  version: 1;
  operationId: string;
  projectGeneration: string;
  chatId: string;
  rootMessageId: string;
  coordinatorSessionId: string;
  coordinatorLarkAppId: string;
  coordinatorOwnerKey: string;
  source: ProjectAttachmentSource;
  revision: number;
  state: DispatchReportAttachment['state'];
  phase: 'pending' | 'active';
  title: string;
  purpose: string;
  createdAt: string;
  updatedAt: string;
  /** A committed rename intent whose project projection may still need repair. */
  pendingRename?: boolean;
  pendingRenamePreviousTitle?: string;
  /** A status intent is never replayed into business state. Status can only
   * mirror it into the tree once the exact project-side result is present. */
  pendingReport?: {
    sourceSessionId: string; revision: number; routeRevision: number;
    status: ProjectWorkstreamStatus; content: string; at: string;
    progress?: number; remaining?: string;
  };
}

export interface ProjectAttachmentView {
  sourceSessionId: string;
  sourceLarkAppId: string;
  revision: number;
  routeRevision: number;
  source: ProjectAttachmentSourceKind;
  state: DispatchReportAttachment['state'];
  reportCapability: DispatchReportAttachment['reportCapability'];
}

export interface ProjectAttachmentResult {
  registered: boolean;
  cardSynced: boolean;
  attachment: ProjectAttachmentView;
  project?: ProjectGroupState;
  error?: string;
}

export interface ProjectWorkstreamAttachmentDeps {
  dataDir: string;
  getSource(appId: string, sessionId: string): Promise<ProjectAttachmentSource | undefined>;
  getProject(chatId: string): ProjectGroupState | undefined;
  getMode(chatId: string): GroupCollaborationModeConfig | undefined;
  projectRun(
    context: ProjectCoordinatorContext, action: ProjectCoordinatorAction, beforeApply?: () => void,
  ): Promise<ProjectGroupState>;
  reportSecret(): string;
  actorAllowed?(actor: ProjectAttachmentActor): boolean;
  lookupRoot?(chatId: string, rootMessageId: string): Promise<boolean>;
  now?(): string;
}

function fail(error: string): never { throw new Error(error); }
function id(value: unknown, prefix?: string): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256
    && !/[\x00-\x20\x7f]/u.test(value)
    && (!prefix || new RegExp(`^${prefix}[A-Za-z0-9_-]{1,128}$`, 'u').test(value));
}
function sourceValid(source: ProjectAttachmentSource): boolean {
  return id(source.sessionId) && id(source.larkAppId, 'cli_')
    && id(source.chatId, 'oc_') && id(source.rootMessageId, 'om_')
    && Number.isSafeInteger(source.routeRevision) && source.routeRevision >= 1
    && ['relay', 'bind', 'adopt', 'resume_import', 'fork', 'manual'].includes(source.source)
    && ['verified', 'manual', 'unavailable'].includes(source.reportCapability)
    && (source.ownerKey === undefined || id(source.ownerKey));
}
function sourceIdentity(source: ProjectAttachmentSource): string {
  return JSON.stringify([
    source.sessionId, source.larkAppId, source.chatId, source.rootMessageId,
    source.scope, source.status, source.ownerKey, source.routeRevision,
    source.ordinary, source.reportCapability,
  ]);
}
function view(record: ProjectAttachmentRecord): ProjectAttachmentView {
  return {
    sourceSessionId: record.source.sessionId,
    sourceLarkAppId: record.source.larkAppId,
    revision: record.revision,
    routeRevision: record.source.routeRevision,
    source: record.source.source,
    state: record.state,
    reportCapability: record.source.reportCapability,
  };
}
function context(actor: ProjectAttachmentActor, dataDir: string): ProjectCoordinatorContext {
  return { dataDir, chatId: actor.chatId, larkAppId: actor.larkAppId, coordinatorSessionId: actor.sessionId };
}
function journalDir(dataDir: string): string {
  return join(dataDir, '.dashboard-secret.project-attachments');
}
export function projectAttachmentRecordPath(dataDir: string, rootMessageId: string): string {
  if (!id(rootMessageId, 'om_')) fail('invalid_workstream_root');
  return join(journalDir(dataDir), `${createHash('sha256').update(rootMessageId).digest('hex')}.json`);
}
function readRecord(path: string): ProjectAttachmentRecord | undefined {
  const raw = readSecureHostFileSync(path);
  if (raw === null) return;
  const value = JSON.parse(raw) as ProjectAttachmentRecord;
  if (value.version !== 1 || !id(value.operationId) || !id(value.chatId, 'oc_')
    || !id(value.rootMessageId, 'om_') || !id(value.coordinatorSessionId)
    || !id(value.coordinatorLarkAppId, 'cli_') || !id(value.coordinatorOwnerKey)
    || !value.source || !sourceValid(value.source)
    || !Number.isSafeInteger(value.revision) || value.revision < 1
    || !['pending', 'active'].includes(value.phase)
    || !['pending', 'active', 'moved', 'closed', 'unknown'].includes(value.state)
    || typeof value.projectGeneration !== 'string'
    || typeof value.title !== 'string' || typeof value.purpose !== 'string'
    || (value.pendingRename !== undefined && typeof value.pendingRename !== 'boolean')
    || (value.pendingRenamePreviousTitle !== undefined && typeof value.pendingRenamePreviousTitle !== 'string')
    || (value.pendingReport !== undefined && (!value.pendingReport
      || !id(value.pendingReport.sourceSessionId)
      || !Number.isSafeInteger(value.pendingReport.revision) || value.pendingReport.revision < 1
      || !Number.isSafeInteger(value.pendingReport.routeRevision) || value.pendingReport.routeRevision < 1
      || !['pending', 'in_progress', 'blocked', 'completed', 'failed'].includes(value.pendingReport.status)
      || typeof value.pendingReport.content !== 'string' || typeof value.pendingReport.at !== 'string'))
    || typeof value.createdAt !== 'string' || typeof value.updatedAt !== 'string') {
    fail('invalid_project_attachment_record');
  }
  return value;
}
/** Host-only authority lookup. A card or mutable dispatch entry cannot replace
 * this source/target proof. */
export function readProjectAttachmentRecord(
  dataDir: string, chatIdOrRoot: string, providedRoot?: string,
): ProjectAttachmentRecord | undefined {
  const rootMessageId = providedRoot ?? chatIdOrRoot;
  const chatId = providedRoot ? chatIdOrRoot : undefined;
  const record = readRecord(projectAttachmentRecordPath(dataDir, rootMessageId));
  if (record && ((chatId && record.chatId !== chatId) || record.rootMessageId !== rootMessageId)) {
    fail('project_attachment_route_mismatch');
  }
  return record;
}
function saveRecord(path: string, record: ProjectAttachmentRecord): void {
  writeSecureHostFileSync(path, JSON.stringify(record));
}
function requestValid(request: ProjectAttachmentRequest): void {
  if (!id(request.sourceSessionId) || !id(request.sourceLarkAppId, 'cli_')
    || !id(request.rootMessageId, 'om_')) fail('invalid_workstream_source');
  if (request.expectedRevision !== undefined
    && (!Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 1)) {
    fail('invalid_attachment_revision');
  }
}
function cleanText(text: string | undefined, max: number): string {
  return safeScrubAndTruncate((text ?? '').trim(), max).text;
}

/** Hold the authority directory open across async file-lock operations. Linux
 * shared-drive ancestors need not be immutable when every leaf lookup uses the
 * same opened directory. Other platforms retain strict ancestor validation. */
async function withRecordLock<T>(
  path: string, run: (pinnedPath: string) => Promise<T>,
): Promise<T> {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (lstatSync(dirname(path)).isSymbolicLink()) fail('unsafe_attachment_directory');
  if (process.platform !== 'linux') {
    const secure = secureHostFilePath(path);
    return withFileLock(secure, () => run(secure));
  }
  const fd = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const stats = fstatSync(fd);
    if (!stats.isDirectory() || (stats.mode & 0o022) !== 0
      || (process.getuid && stats.uid !== process.getuid())) fail('unsafe_attachment_directory');
    const pinned = join(`/proc/self/fd/${fd}`, basename(path));
    // A minimal Linux environment may not mount procfs. Never fall back to an
    // unprotected async path in that case.
    try { lstatSync(`/proc/self/fd/${fd}`); }
    catch {
      const secure = secureHostFilePath(path);
      return await withFileLock(secure, () => run(secure));
    }
    return await withFileLock(pinned, () => run(pinned));
  } finally {
    closeSync(fd);
  }
}

export function createProjectWorkstreamAttachments(deps: ProjectWorkstreamAttachmentDeps) {
  const now = () => deps.now?.() ?? new Date().toISOString();
  const registryPath = join(deps.dataDir, 'orchestrate-dispatch.json');

  function authorizeActor(actor: ProjectAttachmentActor): ProjectGroupState {
    if (deps.actorAllowed && !deps.actorAllowed(actor)) fail('project_attachment_turn_stale');
    if (actor.authorizationStillValid && !actor.authorizationStillValid()) {
      fail('project_attachment_turn_stale');
    }
    if (actor.sourceAuthorizationStillValid && !actor.sourceAuthorizationStillValid()) {
      fail('source_owner_authorization_required');
    }
    if (!id(actor.sessionId) || !id(actor.larkAppId, 'cli_') || !id(actor.chatId, 'oc_')
      || actor.scope !== 'chat' || !id(actor.ownerKey)) fail('project_attachment_actor_unproven');
    const mode = deps.getMode(actor.chatId);
    if (!mode || mode.mode !== 'project') fail('project_mode_required');
    if (mode.coordinatorAppId !== actor.larkAppId) fail('project_coordinator_required');
    const project = deps.getProject(actor.chatId);
    if (!project) fail('project_not_found');
    if (project.chatId !== actor.chatId || project.larkAppId !== actor.larkAppId) {
      fail('project_coordinator_mismatch');
    }
    return project;
  }

  function actorCommitGuard(actor: ProjectAttachmentActor, generation: string): () => void {
    return () => {
      if (authorizeActor(actor).createdAt !== generation) fail('project_generation_changed');
    };
  }

  async function authorizeSource(
    actor: ProjectAttachmentActor, request: ProjectAttachmentRequest,
  ): Promise<{ source: ProjectAttachmentSource; project: ProjectGroupState }> {
    const project = authorizeActor(actor);
    requestValid(request);
    if (!(deps.getMode(actor.chatId)?.workerAppIds ?? []).includes(request.sourceLarkAppId)) {
      fail('project_worker_not_allowed');
    }
    const source = await deps.getSource(request.sourceLarkAppId, request.sourceSessionId);
    if (!source || !sourceValid(source)) fail('source_session_unavailable');
    if (source.sessionId !== request.sourceSessionId || source.larkAppId !== request.sourceLarkAppId
      || source.chatId !== actor.chatId || source.rootMessageId !== request.rootMessageId
      || source.scope !== 'thread' || source.status !== 'active') fail('source_route_mismatch');
    if (!source.ordinary) fail('source_managed_elsewhere');
    if (!source.ownerKey || (source.ownerKey !== actor.ownerKey
      && source.ownerKey !== actor.authorizedSourceOwnerKey)) fail('source_owner_authorization_required');
    if (source.ownerKey !== actor.ownerKey
      && (source.sessionId !== actor.authorizedSourceSessionId
        || source.larkAppId !== actor.authorizedSourceLarkAppId
        || source.rootMessageId !== actor.authorizedSourceRootMessageId
        || source.routeRevision !== actor.authorizedSourceRouteRevision
        || !actor.sourceAuthorizationStillValid)) fail('source_owner_authorization_required');
    if (deps.lookupRoot && !await deps.lookupRoot(actor.chatId, request.rootMessageId)) {
      fail('source_root_unproven');
    }
    const latestProject = authorizeActor(actor);
    if (latestProject.createdAt !== project.createdAt) fail('project_generation_changed');
    const latest = await deps.getSource(request.sourceLarkAppId, request.sourceSessionId);
    if (!latest || sourceIdentity(latest) !== sourceIdentity(source)) fail('source_changed');
    authorizeActor(actor);
    if (!(deps.getMode(actor.chatId)?.workerAppIds ?? []).includes(request.sourceLarkAppId)) {
      fail('project_worker_not_allowed');
    }
    return { source: { ...source, title: source.title ? cleanText(source.title, 120) : undefined }, project: latestProject };
  }

  async function writeRegistry(
    record: ProjectAttachmentRecord,
    beforeCommit?: () => Promise<void>,
  ): Promise<void> {
    const secret = deps.reportSecret();
    await updateDispatchRegistry(registryPath, async registry => {
      const raw = registry[record.rootMessageId];
      if (raw !== undefined) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('workstream_root_already_registered');
        const existing = raw as Record<string, unknown>;
        const signed = verifyDispatchReportBinding(secret, record.rootMessageId, existing.reportBinding);
        if (!signed?.attachment
          || existing.projectAttachmentOperationId !== record.operationId
          || signed.targetLarkAppId !== record.coordinatorLarkAppId
          || signed.targetChatId !== record.chatId) fail('workstream_root_already_registered');
      }
      if (beforeCommit) await beforeCommit();
      const previous = raw as Record<string, unknown> | undefined;
      const reportBinding = createDispatchReportBinding(secret, {
        dispatchRoot: record.rootMessageId,
        targetLarkAppId: record.coordinatorLarkAppId,
        targetSessionId: record.coordinatorSessionId,
        targetChatId: record.chatId,
        targetScope: 'chat',
        sourceName: record.title,
        issuedAt: record.createdAt,
        attachment: {
          sourceSessionId: record.source.sessionId,
          sourceLarkAppId: record.source.larkAppId,
          ownerKey: record.source.ownerKey!,
          revision: record.revision,
          sourceRouteRevision: record.source.routeRevision,
          state: record.state,
          reportCapability: record.source.reportCapability,
        },
      });
      registry[record.rootMessageId] = {
        ...previous,
        orchChatId: record.chatId,
        orchScope: 'chat',
        orchAppId: record.coordinatorLarkAppId,
        orchSessionId: record.coordinatorSessionId,
        targetChatId: record.chatId,
        targetAppIds: [record.source.larkAppId],
        title: record.title,
        source: record.source.source,
        projectAttachmentOperationId: record.operationId,
        projectAttachment: view(record),
        status: previous?.status ?? 'accepted',
        createdAt: previous?.createdAt ?? record.createdAt,
        updatedAt: record.updatedAt,
        reportBinding,
      };
    });
  }

  async function updateProjectAttachment(
    record: ProjectAttachmentRecord, rebindCoordinator = false, beforeApply?: () => void,
  ): Promise<ProjectGroupState | undefined> {
    return mutateProjectGroup(deps.dataDir, record.chatId, project => {
      beforeApply?.();
      if (!project || project.createdAt !== record.projectGeneration
        || project.larkAppId !== record.coordinatorLarkAppId) fail('project_generation_changed');
      const item = project.workstreams.find(item => item.dispatchRoot === record.rootMessageId);
      if (!item) fail('workstream_not_found');
      if (JSON.stringify((item as { attachment?: ProjectAttachmentView }).attachment) === JSON.stringify(view(record))
        && (!rebindCoordinator || project.coordinatorSessionId === record.coordinatorSessionId)) return project;
      Object.assign(item, { attachment: view(record) });
      if (rebindCoordinator) project.coordinatorSessionId = record.coordinatorSessionId;
      project.revision += 1;
      project.updatedAt = now();
      return project;
    });
  }

  async function projectRefresh(actor: ProjectAttachmentActor): Promise<{
    cardSynced: boolean; project?: ProjectGroupState; error?: string;
  }> {
    try {
      authorizeActor(actor);
      const project = authorizeActor(actor);
      return { cardSynced: true, project: await deps.projectRun(
        context(actor, deps.dataDir), { action: 'refresh' }, actorCommitGuard(actor, project.createdAt),
      ) };
    } catch (error) {
      return { cardSynced: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  return {
    async inspect(actor: ProjectAttachmentActor, request: ProjectAttachmentRequest) {
      const { source } = await authorizeSource(actor, request);
      // Deliberately no native transcript, cwd or raw terminal content.
      return {
        sourceSessionId: source.sessionId, sourceLarkAppId: source.larkAppId,
        chatId: source.chatId, rootMessageId: source.rootMessageId,
        routeRevision: source.routeRevision, source: source.source,
        title: source.title,
        reportCapability: source.reportCapability,
      };
    },

    async attach(actor: ProjectAttachmentActor, request: ProjectAttachmentRequest): Promise<ProjectAttachmentResult> {
      requestValid(request);
      return withRecordLock(projectAttachmentRecordPath(deps.dataDir, request.rootMessageId), async path => {
        const { source, project } = await authorizeSource(actor, request);
        const old = readRecord(path);
        if (old && (old.chatId !== actor.chatId || old.coordinatorLarkAppId !== actor.larkAppId
          || old.coordinatorOwnerKey !== actor.ownerKey
          || old.projectGeneration !== project.createdAt)) fail('workstream_root_already_registered');
        if (old && request.expectedRevision !== undefined && request.expectedRevision !== old.revision) {
          fail('attachment_revision_conflict');
        }
        const changed = !!old && sourceIdentity(source) !== sourceIdentity(old.source);
        if (changed && request.expectedRevision !== old!.revision) fail('attachment_revision_required');
        const existingItem = project.workstreams.find(item => item.dispatchRoot === request.rootMessageId);
        const title = cleanText(request.title ?? old?.title ?? existingItem?.title, 80);
        if (!title || title === '子任务' || title === '子项目' || Array.from(title).length > 24) {
          fail('project_workstream_title_required');
        }
        const stamp = now();
        const record: ProjectAttachmentRecord = {
          version: 1, operationId: old?.operationId ?? randomUUID(),
          projectGeneration: project.createdAt, chatId: actor.chatId,
          rootMessageId: request.rootMessageId,
          coordinatorSessionId: actor.sessionId, coordinatorLarkAppId: actor.larkAppId,
          coordinatorOwnerKey: actor.ownerKey!,
          source: { ...source, title: undefined }, revision: old ? old.revision + (changed ? 1 : 0) : 1,
          state: 'pending', phase: 'pending', title,
          purpose: cleanText(request.purpose ?? old?.purpose ?? existingItem?.purpose, 300),
          createdAt: old?.createdAt ?? stamp, updatedAt: stamp,
        };
        // The pending binding cannot report. Recovery reuses the operation and
        // never blindly clobbers an ordinary dispatch/workflow registry row.
        await writeRegistry(record, async () => {
          const fresh = await authorizeSource(actor, request);
          if (fresh.project.createdAt !== record.projectGeneration) fail('project_generation_changed');
          if (sourceIdentity(fresh.source) !== sourceIdentity(record.source)) fail('source_changed');
          saveRecord(path, record);
        });
        let publishError: string | undefined;
        try {
          await authorizeSource(actor, request);
          await deps.projectRun(context(actor, deps.dataDir), {
            action: 'dispatch', dispatchRoot: request.rootMessageId, title: record.title,
            purpose: record.purpose,
            // Preserve business status/progress for every existing row.
            ...(!existingItem ? { status: 'pending' as const, progress: 0, owners: [source.larkAppId] } : {}),
          }, actorCommitGuard(actor, record.projectGeneration));
        } catch (error) {
          const after = deps.getProject(actor.chatId);
          if (!after?.workstreams.some(item => item.dispatchRoot === request.rootMessageId)) {
            return { registered: false, cardSynced: false, attachment: view(record),
              error: error instanceof Error ? error.message : String(error) };
          }
          publishError = error instanceof Error ? error.message : String(error);
        }
        const latest = await authorizeSource(actor, request);
        if (latest.project.createdAt !== record.projectGeneration) fail('project_generation_changed');
        if (sourceIdentity(latest.source) !== sourceIdentity(record.source)) fail('source_changed');
        record.phase = 'active';
        record.state = 'active';
        record.updatedAt = now();
        await updateProjectAttachment(record, true, actorCommitGuard(actor, record.projectGeneration));
        saveRecord(path, record);
        await writeRegistry(record, async () => {
          const fresh = await authorizeSource(actor, request);
          if (fresh.project.createdAt !== record.projectGeneration) fail('project_generation_changed');
          if (sourceIdentity(fresh.source) !== sourceIdentity(record.source)) fail('source_changed');
        });
        const refreshed = await projectRefresh(actor);
        return { registered: true, attachment: view(record), ...refreshed,
          ...(!refreshed.error && publishError ? { error: publishError } : {}) };
      });
    },

    async update(actor: ProjectAttachmentActor, request: {
      rootMessageId: string; status: ProjectWorkstreamStatus; content?: string;
      progress?: number; remaining?: string; milestone?: string; expectedRevision?: number;
    }): Promise<ProjectAttachmentResult> {
      authorizeActor(actor);
      if (!['pending', 'in_progress', 'blocked', 'completed', 'failed'].includes(request.status)) {
        fail('invalid_workstream_status');
      }
      if (request.progress !== undefined && (!Number.isInteger(request.progress) || request.progress < 0 || request.progress > 100)) {
        fail('invalid_workstream_progress');
      }
      return withRecordLock(projectAttachmentRecordPath(deps.dataDir, request.rootMessageId), async path => {
        const project = authorizeActor(actor);
        const record = readRecord(path);
        if (!record || record.phase !== 'active' || record.chatId !== actor.chatId
          || record.coordinatorLarkAppId !== actor.larkAppId
          || record.coordinatorOwnerKey !== actor.ownerKey || record.projectGeneration !== project.createdAt) {
          fail('workstream_not_found');
        }
        if (request.expectedRevision !== undefined && request.expectedRevision !== record.revision) {
          fail('attachment_revision_conflict');
        }
        let updated: ProjectGroupState | undefined;
        let cardError: string | undefined;
        const content = cleanText(request.content, 1000) || '主控手工更新';
        record.pendingReport = {
          sourceSessionId: record.source.sessionId, revision: record.revision,
          routeRevision: record.source.routeRevision,
          status: request.status, content, at: now(), progress: request.progress,
          remaining: cleanText(request.remaining, 300) || undefined,
        };
        saveRecord(path, record);
        try {
          updated = await deps.projectRun(context(actor, deps.dataDir), {
            action: 'report', dispatchRoot: request.rootMessageId,
            content,
            status: request.status, progress: request.progress,
            remaining: cleanText(request.remaining, 300) || undefined,
            milestone: cleanText(request.milestone, 300) || undefined,
          }, actorCommitGuard(actor, record.projectGeneration));
        } catch (error) {
          updated = deps.getProject(actor.chatId);
          const item = updated?.workstreams.find(item => item.dispatchRoot === request.rootMessageId);
          if (item?.status !== request.status || item.lastReport !== content
            || (request.progress !== undefined && item.progress !== request.progress)
            || item.remaining !== record.pendingReport.remaining) {
            throw error;
          }
          cardError = error instanceof Error ? error.message : String(error);
        }
        await updateDispatchRegistry(registryPath, registry => {
          authorizeActor(actor);
          const raw = registry[request.rootMessageId] as Record<string, unknown> | undefined;
          if (!raw || raw.projectAttachmentOperationId !== record.operationId) fail('workstream_root_already_registered');
          recordDispatchLastReport(registry, request.rootMessageId, {
            status: request.status, content, at: record.pendingReport!.at,
          });
        });
        delete record.pendingReport;
        saveRecord(path, record);
        return { registered: true, cardSynced: !cardError, attachment: view(record), project: updated,
          ...(cardError ? { error: cardError } : {}) };
      });
    },

    async rename(actor: ProjectAttachmentActor, request: { rootMessageId: string; title: string }) {
      const project = authorizeActor(actor);
      if (!id(request.rootMessageId, 'om_')) fail('invalid_workstream_root');
      const title = cleanText(request.title, 80);
      if (!title || title === '子任务' || title === '子项目' || Array.from(title).length > 24) {
        fail('project_workstream_title_required');
      }
      if (!project.workstreams.some(item => item.dispatchRoot === request.rootMessageId)) fail('workstream_not_found');
      return withRecordLock(projectAttachmentRecordPath(deps.dataDir, request.rootMessageId), async path => {
        authorizeActor(actor);
        const record = readRecord(path);
        if (record && (record.chatId !== actor.chatId || record.coordinatorLarkAppId !== actor.larkAppId
          || record.coordinatorOwnerKey !== actor.ownerKey || record.projectGeneration !== project.createdAt)) {
          fail('workstream_root_already_registered');
        }
        const secret = deps.reportSecret();
        await updateDispatchRegistry(registryPath, registry => {
          const current = authorizeActor(actor);
          if (current.createdAt !== project.createdAt) fail('project_generation_changed');
          const raw = registry[request.rootMessageId];
          if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('workstream_root_unregistered');
          const entry = raw as Record<string, unknown>;
          const binding = verifyDispatchReportBinding(secret, request.rootMessageId, entry.reportBinding);
          if (!binding || binding.targetLarkAppId !== actor.larkAppId || binding.targetChatId !== actor.chatId) {
            fail('workstream_root_already_registered');
          }
          if (record && entry.projectAttachmentOperationId !== record.operationId) fail('workstream_root_already_registered');
          if (record) {
            // Intent precedes both projections. A crash after either write can
            // be repaired by status without inventing a new business task.
            record.title = title;
            record.pendingRename = true;
            record.pendingRenamePreviousTitle = current.workstreams
              .find(item => item.dispatchRoot === request.rootMessageId)?.title;
            record.updatedAt = now();
            saveRecord(path, record);
          }
          const { domain: _domain, ...payload } = binding;
          entry.title = title;
          entry.reportBinding = createDispatchReportBinding(secret, { ...payload, sourceName: title });
        });
        authorizeActor(actor);
        try {
          const renamed = await deps.projectRun(context(actor, deps.dataDir), {
            action: 'workstream_rename', dispatchRoot: request.rootMessageId, title,
          }, actorCommitGuard(actor, project.createdAt));
          if (record) {
            delete record.pendingRename;
            delete record.pendingRenamePreviousTitle;
            saveRecord(path, record);
          }
          return { cardSynced: true, project: renamed };
        } catch (error) {
          const after = deps.getProject(actor.chatId);
          if (after?.workstreams.find(item => item.dispatchRoot === request.rootMessageId)?.title !== title) throw error;
          if (record) {
            delete record.pendingRename;
            delete record.pendingRenamePreviousTitle;
            saveRecord(path, record);
          }
          return { cardSynced: false, project: after, error: error instanceof Error ? error.message : String(error) };
        }
      });
    },

    async reconcile(actor: ProjectAttachmentActor, request: { rootMessageId?: string } = {}) {
      const project = authorizeActor(actor);
      let roots: string[];
      if (request.rootMessageId) roots = [request.rootMessageId];
      else {
        try {
          if (lstatSync(journalDir(deps.dataDir)).isSymbolicLink()) fail('unsafe_attachment_directory');
          roots = readdirSync(journalDir(deps.dataDir)).filter(file => /^[a-f0-9]{64}\.json$/u.test(file))
            .slice(0, 512).flatMap(file => {
              const record = readRecord(join(journalDir(deps.dataDir), file));
              return record?.chatId === actor.chatId ? [record.rootMessageId] : [];
            });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') roots = [];
          else throw error;
        }
      }
      const outcomes: (ProjectAttachmentView & {
        rootMessageId: string; phase: ProjectAttachmentRecord['phase'];
      })[] = [];
      for (const root of roots) {
        await withRecordLock(projectAttachmentRecordPath(deps.dataDir, root), async path => {
          authorizeActor(actor);
          const record = readRecord(path);
          if (!record || record.chatId !== actor.chatId
            || record.projectGeneration !== project.createdAt || record.coordinatorLarkAppId !== actor.larkAppId
            || record.coordinatorOwnerKey !== actor.ownerKey) return;
          const source = await deps.getSource(record.source.larkAppId, record.source.sessionId);
          const beforeApply = actorCommitGuard(actor, record.projectGeneration);
          beforeApply();
          let state: DispatchReportAttachment['state'] = 'unknown';
          if (source?.status === 'closed') state = 'closed';
          else if (source && sourceValid(source)) {
            if (source.chatId !== record.chatId || source.rootMessageId !== root
              || source.scope !== 'thread' || source.routeRevision !== record.source.routeRevision) state = 'moved';
            else if (source.status === 'active' && source.ownerKey === record.source.ownerKey
              && source.ordinary && source.reportCapability === record.source.reportCapability) {
              // Status may inspect/recover a partial write, but only an
              // explicit attach can activate a pending association.
              state = record.phase === 'pending' ? 'pending' : 'active';
            }
          }
          if (record.state !== state || record.coordinatorSessionId !== actor.sessionId) {
            record.state = state;
            record.coordinatorSessionId = actor.sessionId;
            record.updatedAt = now();
            saveRecord(path, record);
          }
          // Reconcile projections even if the authority is unchanged: a crash
          // between journal, registry and project must not leave a stale view.
          await writeRegistry(record, async () => beforeApply());
          if (record.pendingRename) {
            await mutateProjectGroup(deps.dataDir, record.chatId, current => {
              beforeApply();
              const item = current?.workstreams.find(item => item.dispatchRoot === root);
              if (!current || !item) fail('workstream_not_found');
              if (item.title === record.title) return current;
              if (item.title !== record.pendingRenamePreviousTitle) {
                // A newer human title wins; don't replay the obsolete rename.
                record.title = item.title;
                return current;
              }
              item.title = record.title;
              item.updatedAt = now();
              current.revision += 1;
              current.updatedAt = now();
              return current;
            });
            beforeApply();
            delete record.pendingRename;
            delete record.pendingRenamePreviousTitle;
            saveRecord(path, record);
            await writeRegistry(record, async () => beforeApply());
          }
          if (record.pendingReport) {
            const intent = record.pendingReport;
            await updateDispatchRegistry(registryPath, registry => {
              beforeApply();
              const item = deps.getProject(actor.chatId)?.workstreams.find(item => item.dispatchRoot === root);
              const raw = registry[root] as Record<string, unknown> | undefined;
              if (!raw || raw.projectAttachmentOperationId !== record.operationId) fail('workstream_root_already_registered');
              if (intent.sourceSessionId === record.source.sessionId
                && intent.revision === record.revision && intent.routeRevision === record.source.routeRevision
                && item?.attachment?.sourceSessionId === intent.sourceSessionId
                && item.attachment.revision === intent.revision
                && item.status === intent.status && item.lastReport === intent.content
                && (intent.progress === undefined || item.progress === intent.progress)
                && item.remaining === intent.remaining) {
                recordDispatchLastReport(registry, root, intent);
              }
            });
            // Whether committed or superseded, never replay the business write.
            beforeApply();
            delete record.pendingReport;
            saveRecord(path, record);
          }
          if (deps.getProject(actor.chatId)?.workstreams.some(item => item.dispatchRoot === root)) {
            await updateProjectAttachment(record, true, beforeApply);
          } else if (record.phase === 'active') {
            fail('workstream_not_found');
          }
          outcomes.push({ ...view(record), rootMessageId: root, phase: record.phase });
        });
      }
      const refreshed = outcomes.length ? await projectRefresh(actor) : { cardSynced: true, project };
      return { attachments: outcomes, ...refreshed };
    },

    /** A source daemon observed an existing source leave/close/change lifetime.
     * This method may only DOWNGRADE an existing association. It cannot claim a
     * new source, revive a moved attachment or change coordinator authority. */
    async observe(source: ProjectAttachmentSource): Promise<void> {
      if (!id(source.sessionId) || !id(source.larkAppId, 'cli_')) return;
      let files: string[];
      try {
        if (lstatSync(journalDir(deps.dataDir)).isSymbolicLink()) fail('unsafe_attachment_directory');
        files = readdirSync(journalDir(deps.dataDir)).filter(file => /^[a-f0-9]{64}\.json$/u.test(file)).slice(0, 512);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
      }
      for (const file of files) {
        const candidate = readRecord(join(journalDir(deps.dataDir), file));
        if (!candidate
          || candidate.source.sessionId !== source.sessionId
          || candidate.source.larkAppId !== source.larkAppId) continue;
        await withRecordLock(projectAttachmentRecordPath(deps.dataDir, candidate.rootMessageId), async path => {
          const record = readRecord(path);
          if (!record || record.source.sessionId !== source.sessionId
            || record.source.larkAppId !== source.larkAppId) return;
          const current = await deps.getSource(source.larkAppId, source.sessionId) ?? source;
          let state: DispatchReportAttachment['state'] = record.state;
          if (current.status === 'closed') state = 'closed';
          else if (current.chatId !== record.chatId || current.rootMessageId !== record.rootMessageId
            || current.scope !== 'thread' || current.routeRevision !== record.source.routeRevision) state = 'moved';
          else if (current.status !== 'active' || current.ownerKey !== record.source.ownerKey
            || !current.ordinary || current.reportCapability !== record.source.reportCapability) state = 'unknown';
          if (state !== record.state) {
            // This never changes moved/closed/unknown back to active.
            record.state = state;
            record.updatedAt = now();
            saveRecord(path, record);
          }
          await writeRegistry(record);
          const project = deps.getProject(record.chatId);
          if (!project || project.createdAt !== record.projectGeneration
            || project.larkAppId !== record.coordinatorLarkAppId) return;
          if (project.workstreams.some(item => item.dispatchRoot === record.rootMessageId)) {
            await updateProjectAttachment(record);
          } else if (record.phase === 'active') {
            fail('workstream_not_found');
          }
          const mode = deps.getMode(record.chatId);
          if (mode?.mode === 'project' && mode.coordinatorAppId === record.coordinatorLarkAppId) {
            try {
              await deps.projectRun({
                dataDir: deps.dataDir, chatId: record.chatId,
                larkAppId: record.coordinatorLarkAppId, coordinatorSessionId: record.coordinatorSessionId,
              }, { action: 'refresh' });
            } catch { /* Only the view failed; status/reconcile can repair it. */ }
          }
        });
      }
    },
  };
}
