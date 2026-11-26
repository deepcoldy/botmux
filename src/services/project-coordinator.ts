import { createHash } from 'node:crypto';
import { localeForBot } from '../i18n/index.js';
import { logger } from '../utils/logger.js';
import {
  buildProjectGroupCard,
  buildProjectGroupCardDigest,
  buildProjectGroupOnboardingCard,
  buildProjectGroupStartedNoticeCard,
  type ProjectGroupCardRuntime,
  type ProjectGroupOnboardingCardInput,
} from '../im/lark/project-group-card.js';
import type { Brand } from '../im/lark/lark-hosts.js';
import {
  mutateProjectGroup,
  readProjectGroup,
  visibleProjectWorkstreams,
  type ProjectGroupState,
  type ProjectGroupStatus,
  type ProjectWorkstreamStatus,
} from './project-group-store.js';
import {
  readGroupCollaborationMode,
  writeProjectOnboardingCard,
  type ProjectOnboardingCardState,
} from './group-collaboration-mode-store.js';

export interface ProjectCoordinatorTransport {
  sendCard(larkAppId: string, chatId: string, cardJson: string, uuid?: string): Promise<string>;
  updateCard(larkAppId: string, messageId: string, cardJson: string): Promise<void>;
  pinMessage(larkAppId: string, messageId: string): Promise<boolean>;
  unpinMessage(larkAppId: string, messageId: string): Promise<boolean>;
  resolveThreadId(larkAppId: string, dispatchRoot: string): Promise<string | null>;
  isMessageWithdrawn(error: unknown): boolean;
  isMessageUpdateExpired(error: unknown): boolean;
  brand(larkAppId: string): Brand;
  resolveCardRuntime?(
    project: ProjectGroupState,
    dataDir: string,
  ): Promise<ProjectGroupCardRuntime | undefined> | ProjectGroupCardRuntime | undefined;
}

export type ProjectCoordinatorAction =
  | { action: 'init'; title: string; goal: string; phase?: string; focus?: string; remaining?: string }
  | { action: 'status' }
  | { action: 'refresh' }
  | { action: 'workstream_rename'; dispatchRoot: string; title: string }
  | {
      action: 'update'; goal?: string; phase?: string; focus?: string; progress?: number;
      remaining?: string; blocker?: string; clearBlockers?: boolean; milestone?: string; nextMilestone?: string;
    }
  | { action: 'close'; milestone?: string }
  | { action: 'resume'; phase?: string; focus?: string }
  | {
      action: 'dispatch'; dispatchRoot: string; title: string; purpose?: string; owners?: string[];
      status?: ProjectWorkstreamStatus; progress?: number;
    }
  | {
      action: 'report'; dispatchRoot: string; content: string; status?: ProjectWorkstreamStatus;
      progress?: number; remaining?: string; milestone?: string;
      expectedAttachment?: { sourceSessionId: string; revision: number; coordinatorSessionId: string };
    };

export type ProjectCardPublicationPolicy = 'patch' | 'repost' | 'deferred';

export interface ProjectCoordinatorContext {
  dataDir: string;
  chatId: string;
  larkAppId: string;
  coordinatorSessionId: string;
  cardPublication?: ProjectCardPublicationPolicy;
}

export interface ProjectCardPublication {
  project: ProjectGroupState;
  /** The digest of the payload sent to Lark, not a later runtime snapshot. */
  digest: string;
}

export interface ProjectCardSyncTarget {
  messageId: string;
  digest: string;
}

interface PreparedProjectCard {
  project: ProjectGroupState;
  cardJson: string;
  digest: string;
  runtime?: ProjectGroupCardRuntime;
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  return typeof record[key] === 'string' ? record[key] as string : undefined;
}

function workstreamStatus(value: unknown): ProjectWorkstreamStatus | undefined {
  return value === 'pending' || value === 'in_progress' || value === 'blocked'
    || value === 'completed' || value === 'failed'
    ? value
    : undefined;
}

export function parseProjectCoordinatorAction(raw: unknown): ProjectCoordinatorAction | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const body = raw as Record<string, unknown>;
  const action = body.action;
  if (action === 'init') {
    const title = stringField(body, 'title');
    const goal = stringField(body, 'goal');
    if (!title || !goal) return undefined;
    return {
      action, title, goal, phase: stringField(body, 'phase'), focus: stringField(body, 'focus'),
      remaining: stringField(body, 'remaining'),
    };
  }
  if (action === 'status') return { action };
  if (action === 'workstream_rename') {
    const dispatchRoot = stringField(body, 'dispatchRoot');
    const title = stringField(body, 'title');
    return dispatchRoot && title ? { action, dispatchRoot, title } : undefined;
  }
  if (action === 'update') {
    const progress = body.progress === undefined || typeof body.progress === 'number' ? body.progress as number | undefined : undefined;
    if (body.progress !== undefined && progress === undefined) return undefined;
    return {
      action, goal: stringField(body, 'goal'), phase: stringField(body, 'phase'), focus: stringField(body, 'focus'),
      progress, remaining: stringField(body, 'remaining'), blocker: stringField(body, 'blocker'),
      clearBlockers: body.clearBlockers === true, milestone: stringField(body, 'milestone'),
      nextMilestone: stringField(body, 'nextMilestone'),
    };
  }
  if (action === 'close') return { action, milestone: stringField(body, 'milestone') };
  if (action === 'resume') return { action, phase: stringField(body, 'phase'), focus: stringField(body, 'focus') };
  if (action === 'dispatch') {
    const dispatchRoot = stringField(body, 'dispatchRoot');
    const title = stringField(body, 'title');
    const status = workstreamStatus(body.status);
    if (!dispatchRoot || (body.status !== undefined && !status)) return undefined;
    const owners = Array.isArray(body.owners)
      ? body.owners.filter((owner): owner is string => typeof owner === 'string')
      : undefined;
    const progress = body.progress === undefined || typeof body.progress === 'number' ? body.progress as number | undefined : undefined;
    if (body.progress !== undefined && progress === undefined) return undefined;
    return { action, dispatchRoot, title: title ?? '', purpose: stringField(body, 'purpose'), owners, status, progress };
  }
  if (action === 'report') {
    const dispatchRoot = stringField(body, 'dispatchRoot');
    const content = stringField(body, 'content');
    const status = workstreamStatus(body.status);
    if (!dispatchRoot || !content || (body.status !== undefined && !status)) return undefined;
    const progress = body.progress === undefined || typeof body.progress === 'number' ? body.progress as number | undefined : undefined;
    if (body.progress !== undefined && progress === undefined) return undefined;
    return {
      action, dispatchRoot, content, status, progress,
      remaining: stringField(body, 'remaining'), milestone: stringField(body, 'milestone'),
      ...(body.expectedAttachment && typeof body.expectedAttachment === 'object'
        && typeof (body.expectedAttachment as Record<string, unknown>).sourceSessionId === 'string'
        && typeof (body.expectedAttachment as Record<string, unknown>).coordinatorSessionId === 'string'
        && Number.isSafeInteger((body.expectedAttachment as Record<string, unknown>).revision)
        ? { expectedAttachment: body.expectedAttachment as { sourceSessionId: string; revision: number; coordinatorSessionId: string } } : {}),
    };
  }
  return undefined;
}

const projectQueues = new Map<string, Promise<unknown>>();
const PROJECT_CARD_PIN_RETRY_MS = 60_000;

function queued<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = projectQueues.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(operation);
  projectQueues.set(key, next);
  const cleanup = () => {
    if (projectQueues.get(key) === next) projectQueues.delete(key);
  };
  void next.then(cleanup, cleanup);
  return next;
}

function nowIso(): string {
  return new Date().toISOString();
}

/** Lark deduplicates a supplied send UUID for one hour. All replacements of
 * the same old card share one identity, even if a retry carries newer content;
 * sendAndPinCard reconciles that content with a PATCH before reporting success. */
function replacementSendUuid(project: ProjectGroupState): string | undefined {
  const replacedMessageId = project.card?.messageId;
  if (!replacedMessageId) return undefined;
  const digest = createHash('sha256')
    .update(`${project.chatId}\0${project.larkAppId}\0${replacedMessageId}`)
    .digest('hex').slice(0, 32);
  return `project-card-${digest}`;
}

function boundedText(value: string | undefined, max: number, fallback = ''): string {
  const text = value?.trim() ?? '';
  return (text || fallback).slice(0, max);
}

function validProgress(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.min(100, Math.round(value)))
    : undefined;
}

function statusProgress(status: ProjectWorkstreamStatus, explicit?: number, current?: number): number {
  const valid = validProgress(explicit);
  if (valid !== undefined) return valid;
  if (status === 'completed') return 100;
  if (status === 'in_progress') return current ?? 20;
  return current ?? 0;
}

export class ProjectCoordinator {
  constructor(private readonly transport: ProjectCoordinatorTransport) {}

  private async retireOnboardingCard(
    context: Pick<ProjectCoordinatorContext, 'dataDir' | 'chatId' | 'larkAppId'>,
  ): Promise<void> {
    const current = readGroupCollaborationMode(context.dataDir, context.chatId)?.onboardingCard;
    if (!current) return;
    if (current.larkAppId !== context.larkAppId) throw new Error('project_onboarding_coordinator_mismatch');
    try {
      await this.transport.updateCard(context.larkAppId, current.messageId,
        JSON.stringify(buildProjectGroupStartedNoticeCard(localeForBot(context.larkAppId))));
    } catch (error) {
      if (!this.transport.isMessageWithdrawn(error) && !this.transport.isMessageUpdateExpired(error)) {
        logger.warn(`[project] Could not retire onboarding card ${current.messageId}; will retry on refresh: ${error}`);
        return;
      }
    }
    if (current.pinned) {
      try {
        const unpinned = await this.transport.unpinMessage(context.larkAppId, current.messageId);
        if (!unpinned) return;
      } catch (error) {
        if (!this.transport.isMessageWithdrawn(error)) {
          logger.warn(`[project] Could not retire onboarding card ${current.messageId}; will retry on refresh: ${error}`);
          return;
        }
      }
    }
    await writeProjectOnboardingCard(context.dataDir, context.chatId, undefined);
  }

  ensureOnboardingCard(
    context: Pick<ProjectCoordinatorContext, 'dataDir' | 'chatId' | 'larkAppId'>,
    input: Omit<ProjectGroupOnboardingCardInput, 'updatedAt'>,
  ): Promise<ProjectOnboardingCardState | null> {
    return queued(`${context.dataDir}:${context.chatId}`, async () => {
      if (readProjectGroup(context.dataDir, context.chatId)) return null;
      const mode = readGroupCollaborationMode(context.dataDir, context.chatId);
      if (mode?.mode !== 'project' || mode.coordinatorAppId !== context.larkAppId) {
        throw new Error('project_coordinator_mismatch');
      }
      const now = nowIso();
      const cardJson = JSON.stringify(buildProjectGroupOnboardingCard({ ...input, updatedAt: now }));
      const current = mode.onboardingCard;
      if (current) {
        if (current.larkAppId !== context.larkAppId) throw new Error('project_onboarding_coordinator_mismatch');
        try {
          await this.transport.updateCard(context.larkAppId, current.messageId, cardJson);
          const next = { ...current, updatedAt: now };
          await writeProjectOnboardingCard(context.dataDir, context.chatId, next);
          return next;
        } catch (error) {
          if (!this.transport.isMessageWithdrawn(error)) throw error;
          await writeProjectOnboardingCard(context.dataDir, context.chatId, undefined);
        }
      }
      const messageId = await this.transport.sendCard(context.larkAppId, context.chatId, cardJson);
      const pinned = await this.transport.pinMessage(context.larkAppId, messageId);
      const created: ProjectOnboardingCardState = {
        messageId, larkAppId: context.larkAppId, pinned, createdAt: now, updatedAt: now,
      };
      await writeProjectOnboardingCard(context.dataDir, context.chatId, created);
      return created;
    });
  }

  clearOnboardingCard(
    context: Pick<ProjectCoordinatorContext, 'dataDir' | 'chatId' | 'larkAppId'>,
  ): Promise<boolean> {
    return queued(`${context.dataDir}:${context.chatId}`, async () => {
      const current = readGroupCollaborationMode(context.dataDir, context.chatId)?.onboardingCard;
      if (!current) return false;
      if (current.larkAppId !== context.larkAppId) throw new Error('project_onboarding_coordinator_mismatch');
      if (current.pinned) {
        try {
          await this.transport.unpinMessage(context.larkAppId, current.messageId);
        } catch (error) {
          if (!this.transport.isMessageWithdrawn(error)) throw error;
        }
      }
      await writeProjectOnboardingCard(context.dataDir, context.chatId, undefined);
      return true;
    });
  }

  run(context: ProjectCoordinatorContext, action: ProjectCoordinatorAction, beforeApply?: () => void): Promise<ProjectGroupState> {
    return queued(`${context.dataDir}:${context.chatId}`, async () => {
      beforeApply?.();
      if (action.action === 'status') {
        const current = readProjectGroup(context.dataDir, context.chatId);
        if (!current) throw new Error('project_not_found');
        return current;
      }
      const project = action.action === 'refresh'
        ? this.readCardProject(context) : await this.apply(context, action, beforeApply);
      if (context.cardPublication === 'deferred') return project;
      const prepared = await this.prepareCard(context, project);
      return (await this.publish(context, prepared, {
        repostOnExpired: context.cardPublication === 'repost',
      })).project;
    });
  }

  refreshCard(context: ProjectCoordinatorContext, target: ProjectCardSyncTarget): Promise<ProjectCardPublication | undefined> {
    return queued(`${context.dataDir}:${context.chatId}`, async () => {
      const prepared = await this.prepareSyncCard(context, target);
      if (!prepared) return undefined;
      return this.publish(context, prepared, {
        repostOnExpired: false, canPublish: () => this.canSyncProjectCard(context),
      });
    });
  }

  /** Background recovery uses the same queue as commands. Only replace the
   * card whose edit budget ran out, not a newer card published by a command. */
  repostExpiredCard(context: ProjectCoordinatorContext, target: ProjectCardSyncTarget): Promise<ProjectCardPublication | undefined> {
    return queued(`${context.dataDir}:${context.chatId}`, async () => {
      const prepared = await this.prepareSyncCard(context, target);
      if (!prepared) return undefined;
      const canRepost = () => this.canSyncProjectCard(context);
      await this.unpinExpiredCard(context, prepared.project);
      // Dashboard mode changes are not serialized by the project queue.
      if (!canRepost()) return undefined;
      return this.sendAndPinCard(context, prepared, canRepost);
    });
  }

  retryPendingCardPin(context: ProjectCoordinatorContext, messageId: string): Promise<ProjectGroupState | undefined> {
    return queued(`${context.dataDir}:${context.chatId}`, async () => {
      const card = this.readCardProject(context).card;
      if (card?.messageId !== messageId || card.pinned || card.pinRetryAt === undefined
        || card.pinRetryAt > Date.now() || !this.canSyncProjectCard(context)) return undefined;
      // Reserve the next interval before sending so an interrupted retry
      // cannot immediately repeat after a daemon restart.
      const project = await mutateProjectGroup(context.dataDir, context.chatId, current => {
        if (current?.card?.messageId === messageId && !current.card.pinned) {
          current.card.pinRetryAt = Date.now() + PROJECT_CARD_PIN_RETRY_MS;
        }
        return current;
      });
      if (project?.card?.messageId !== messageId || !this.canSyncProjectCard(context)) return undefined;
      return this.confirmCardPin(context, project);
    });
  }

  private readCardProject(context: ProjectCoordinatorContext): ProjectGroupState {
    const current = readProjectGroup(context.dataDir, context.chatId);
    if (!current) throw new Error('project_not_found');
    if (current.larkAppId !== context.larkAppId) throw new Error('project_coordinator_mismatch');
    return current;
  }

  private canSyncProjectCard(context: ProjectCoordinatorContext): boolean {
    const mode = readGroupCollaborationMode(context.dataDir, context.chatId);
    // Legacy projects can have a durable owner and card without a mode row.
    return !mode || (mode.mode === 'project' && mode.coordinatorAppId === context.larkAppId);
  }

  private async prepareSyncCard(context: ProjectCoordinatorContext, target: ProjectCardSyncTarget): Promise<PreparedProjectCard | undefined> {
    const current = this.readCardProject(context);
    if (current.card?.messageId !== target.messageId || !this.canSyncProjectCard(context)) return undefined;
    const prepared = await this.prepareCard(context, current);
    // A newer render must not spend another digest's PATCH or repost budget.
    if (prepared.digest !== target.digest || !this.canSyncProjectCard(context)) return undefined;
    return prepared;
  }

  private async apply(
    context: ProjectCoordinatorContext,
    action: Exclude<ProjectCoordinatorAction, { action: 'status' | 'refresh' }>,
    beforeApply?: () => void,
  ): Promise<ProjectGroupState> {
    const next = await mutateProjectGroup(context.dataDir, context.chatId, current => {
      beforeApply?.();
      const now = nowIso();
      if (action.action === 'init') {
        if (current) throw new Error('project_already_exists');
        const title = boundedText(action.title, 80);
        const goal = boundedText(action.goal, 500);
        if (!title || !goal) throw new Error('title_and_goal_required');
        return {
          schemaVersion: 1, revision: 1,
          chatId: context.chatId, larkAppId: context.larkAppId,
          coordinatorSessionId: context.coordinatorSessionId,
          title, goal,
          phase: boundedText(action.phase, 80, '规划'),
          focus: boundedText(action.focus, 300, '拆解并派发首批子任务'),
          status: 'active' as ProjectGroupStatus,
          ...(boundedText(action.remaining, 160) ? { remaining: boundedText(action.remaining, 160) } : {}),
          blockers: [], workstreams: [], milestones: [], createdAt: now, updatedAt: now,
        };
      }
      if (!current) throw new Error('project_not_found');
      if (current.larkAppId !== context.larkAppId) {
        throw new Error('project_coordinator_mismatch');
      }
      if (action.action === 'report' && action.expectedAttachment
        && current.coordinatorSessionId !== action.expectedAttachment.coordinatorSessionId) {
        throw new Error('project_attachment_revision_conflict');
      }
      // A chat-scope session may be recreated after an explicit close or daemon
      // migration. The authenticated live session for the same bot+chat becomes
      // the new report target; topic-scoped sessions are rejected by the route.
      current.coordinatorSessionId = context.coordinatorSessionId;
      current.revision += 1;
      current.updatedAt = now;
      if (action.action === 'workstream_rename') {
        const item = current.workstreams.find(candidate => candidate.dispatchRoot === action.dispatchRoot);
        if (!item) throw new Error('workstream_not_found');
        const title = action.title.trim();
        if (!title || title === '子任务' || title === '子项目') throw new Error('project_workstream_title_required');
        if (Array.from(title).length > 24) throw new Error('project_workstream_title_too_long');
        item.title = title;
        item.updatedAt = now;
      } else if (action.action === 'update') {
        if (action.goal !== undefined) current.goal = boundedText(action.goal, 500, current.goal);
        if (action.phase !== undefined) current.phase = boundedText(action.phase, 80, current.phase);
        if (action.focus !== undefined) current.focus = boundedText(action.focus, 300, current.focus);
        const progress = validProgress(action.progress);
        if (action.progress !== undefined && progress === undefined) throw new Error('invalid_progress');
        if (progress !== undefined) current.manualProgress = progress;
        if (action.remaining !== undefined) current.remaining = boundedText(action.remaining, 160) || undefined;
        if (action.clearBlockers) current.blockers = [];
        const blocker = boundedText(action.blocker, 300);
        if (blocker && !current.blockers.includes(blocker)) current.blockers.push(blocker);
        const milestone = boundedText(action.milestone, 300);
        if (milestone) current.milestones.push({ content: milestone, createdAt: now });
        if (action.nextMilestone !== undefined) current.nextMilestone = boundedText(action.nextMilestone, 160) || undefined;
      } else if (action.action === 'close') {
        current.status = 'completed';
        current.manualProgress = 100;
        current.phase = '已完成';
        current.focus = '项目已完成';
        current.blockers = [];
        current.remaining = '无';
        delete current.nextMilestone;
        const milestone = boundedText(action.milestone, 300, '项目完成');
        current.milestones.push({ content: milestone, createdAt: now });
      } else if (action.action === 'resume') {
        current.status = 'active';
        current.phase = boundedText(action.phase, 80, '继续推进');
        current.focus = boundedText(action.focus, 300, '恢复项目推进');
        if (current.manualProgress === 100) delete current.manualProgress;
      } else if (action.action === 'dispatch') {
        const root = action.dispatchRoot.trim();
        if (!/^om_[A-Za-z0-9_-]{1,128}$/.test(root)) throw new Error('invalid_dispatch_root');
        const index = current.workstreams.findIndex(item => item.dispatchRoot === root);
        if (index >= 0) {
          const item = current.workstreams[index]!;
          const requestedTitle = boundedText(action.title, 80);
          if (requestedTitle) {
            if (requestedTitle === '子任务' || requestedTitle === '子项目') throw new Error('project_workstream_title_required');
            if (Array.from(requestedTitle).length > 24) throw new Error('project_workstream_title_too_long');
            item.title = requestedTitle;
          }
          item.purpose = boundedText(action.purpose, 300, item.purpose);
          if (action.owners !== undefined) {
            item.owners = action.owners.map(owner => boundedText(owner, 80)).filter(Boolean).slice(0, 16);
          }
          if (action.status !== undefined || action.progress !== undefined) {
            const status = action.status ?? item.status;
            item.status = status;
            item.progress = statusProgress(status, action.progress, item.progress);
          }
          item.updatedAt = now;
        } else {
          const status = action.status ?? 'pending';
          const title = boundedText(action.title, 80);
          if (!title || title === '子任务' || title === '子项目') throw new Error('project_workstream_title_required');
          if (Array.from(title).length > 24) throw new Error('project_workstream_title_too_long');
          current.workstreams.push({
            dispatchRoot: root,
            title,
            purpose: boundedText(action.purpose, 300, '等待补充任务说明'),
            owners: (action.owners ?? []).map(owner => boundedText(owner, 80)).filter(Boolean).slice(0, 16),
            status,
            progress: statusProgress(status, action.progress),
            createdAt: now, updatedAt: now,
          });
        }
      } else if (action.action === 'report') {
        const item = current.workstreams.find(candidate => candidate.dispatchRoot === action.dispatchRoot);
        if (!item) throw new Error('workstream_not_found');
        if (action.expectedAttachment && (item.attachment?.sourceSessionId !== action.expectedAttachment.sourceSessionId
          || item.attachment.revision !== action.expectedAttachment.revision || item.attachment.state !== 'active'
          || context.coordinatorSessionId !== action.expectedAttachment.coordinatorSessionId)) {
          throw new Error('project_attachment_revision_conflict');
        }
        const status = action.status ?? 'in_progress';
        item.status = status;
        item.progress = statusProgress(status, action.progress, item.progress);
        item.lastReport = boundedText(action.content, 1000);
        item.remaining = boundedText(action.remaining, 300) || undefined;
        item.updatedAt = now;
        if (status === 'blocked' && item.lastReport) {
          const blocker = item.lastReport.slice(0, 300);
          if (item.blocker && item.blocker !== blocker) {
            const previousBlocker = item.blocker;
            const sharedByAnotherWorkstream = current.workstreams.some(candidate => (
              candidate.dispatchRoot !== item.dispatchRoot
              && candidate.status === 'blocked'
              && candidate.blocker === previousBlocker
            ));
            if (!sharedByAnotherWorkstream) {
              current.blockers = current.blockers.filter(currentBlocker => currentBlocker !== previousBlocker);
            }
          }
          item.blocker = blocker;
          if (!current.blockers.includes(blocker)) current.blockers.push(blocker);
        } else if (item.blocker) {
          const previousBlocker = item.blocker;
          const sharedByAnotherWorkstream = current.workstreams.some(candidate => (
            candidate.dispatchRoot !== item.dispatchRoot
            && candidate.status === 'blocked'
            && candidate.blocker === previousBlocker
          ));
          if (!sharedByAnotherWorkstream) {
            current.blockers = current.blockers.filter(blocker => blocker !== previousBlocker);
          }
          delete item.blocker;
        }
        const milestone = boundedText(action.milestone, 300);
        if (milestone) current.milestones.push({ content: milestone, createdAt: now });
      }
      current.milestones = current.milestones.slice(-50);
      if (context.cardPublication === 'deferred' && current.card) current.card.refreshPending = true;
      return current;
    });
    if (!next) throw new Error('project_not_found');
    return next;
  }

  private async prepareCard(context: ProjectCoordinatorContext, initial: ProjectGroupState): Promise<PreparedProjectCard> {
    let project = initial;
    const resolutions = await Promise.all(visibleProjectWorkstreams(project)
      .filter(item => !item.threadId)
      .map(async item => ({ dispatchRoot: item.dispatchRoot, threadId: await this.transport.resolveThreadId(project.larkAppId, item.dispatchRoot) })));
    const found = resolutions.filter((item): item is { dispatchRoot: string; threadId: string } => !!item.threadId);
    if (found.length > 0) {
      const byRoot = new Map(found.map(item => [item.dispatchRoot, item.threadId]));
      project = (await mutateProjectGroup(context.dataDir, context.chatId, current => {
        if (!current) throw new Error('project_not_found');
        for (const item of current.workstreams) item.threadId ??= byRoot.get(item.dispatchRoot);
        current.revision += 1;
        current.updatedAt = nowIso();
        return current;
      }))!;
    }
    const mode = readGroupCollaborationMode(context.dataDir, context.chatId);
    const cardConfig = mode?.progressCard;
    const runtime = await this.transport.resolveCardRuntime?.(project, context.dataDir);
    const cardJson = JSON.stringify(buildProjectGroupCard(project, this.transport.brand(project.larkAppId), cardConfig, runtime));
    return { project, cardJson, runtime, digest: buildProjectGroupCardDigest(project, runtime) };
  }

  private async publish(
    context: ProjectCoordinatorContext,
    prepared: PreparedProjectCard,
    { repostOnExpired, canPublish }: { repostOnExpired: boolean; canPublish?: () => boolean },
  ): Promise<ProjectCardPublication> {
    const { project, cardJson, digest } = prepared;
    if (project.card?.messageId) {
      try {
        await this.transport.updateCard(project.larkAppId, project.card.messageId, cardJson);
      } catch (error) {
        if (this.transport.isMessageWithdrawn(error)) {
          if (canPublish?.() === false) throw new Error('project_coordinator_mismatch');
          return this.sendAndPinCard(context, prepared, canPublish);
        }
        if (repostOnExpired && this.transport.isMessageUpdateExpired(error)) {
          await this.unpinExpiredCard(context, project);
          return this.sendAndPinCard(context, prepared);
        }
        throw error;
      }
      const updated = (await mutateProjectGroup(context.dataDir, context.chatId, current => {
        if (!current) throw new Error('project_not_found');
        if (!current.card || current.card.messageId !== project.card?.messageId) return current;
        current.card.updatedAt = current.updatedAt;
        if (current.revision === project.revision) delete current.card.refreshPending;
        return current;
      }))!;
      // If a previous first-publish attempt persisted and pinned the active
      // card but failed to retire the guide, retry that cleanup on refresh.
      const published = repostOnExpired ? await this.confirmCardPin(context, updated) : updated;
      if (canPublish?.() !== false) await this.retireOnboardingCard(context);
      return { project: published, digest };
    }
    return this.sendAndPinCard(context, prepared);
  }

  private async unpinExpiredCard(context: ProjectCoordinatorContext, project: ProjectGroupState): Promise<void> {
    const old = project.card;
    // A failed pin call can have landed remotely. Until it is resolved, the
    // old message ID is just as important as the ID of a confirmed pin.
    if (!old || (!old.pinned && old.pinRetryAt === undefined)) return;
    try {
      if (!await this.transport.unpinMessage(project.larkAppId, old.messageId)) {
        throw new Error('project_card_unpin_unconfirmed');
      }
    } catch (error) {
      logger.warn(`[project] Could not unpin expired card ${old.messageId}: ${error}`);
      // Dropping the old ID now would lose the only reference to its pin.
      throw error;
    }
    // Keep the old ID, but record the confirmed unpin even if the POST fails.
    // Pin metadata is not card content and must not reset the edit budget.
    await mutateProjectGroup(context.dataDir, context.chatId, current => {
      if (current?.card?.messageId === old.messageId) {
        current.card.pinned = false;
        delete current.card.pinRetryAt;
      }
      return current;
    });
  }

  private async sendAndPinCard(
    context: ProjectCoordinatorContext,
    { project, cardJson, runtime }: PreparedProjectCard,
    canRepost?: () => boolean,
  ): Promise<ProjectCardPublication> {
    // Starting a project must be visible at the current point in the chat.
    // Never transform the older onboarding guide in place: publish and pin a
    // fresh formal card and retire the guide only after publication. Record the
    // new ID before pinning so a failed store write cannot leave an orphan pin.
    const sendUuid = replacementSendUuid(project);
    const messageId = sendUuid
      ? await this.transport.sendCard(project.larkAppId, project.chatId, cardJson, sendUuid)
      : await this.transport.sendCard(project.larkAppId, project.chatId, cardJson);
    const published = (await mutateProjectGroup(context.dataDir, context.chatId, current => {
      if (!current) throw new Error('project_not_found');
      const refreshPending = current.revision !== project.revision && current.card?.refreshPending;
      current.revision += 1;
      current.updatedAt = nowIso();
      current.card = {
        messageId, pinned: false, updatedAt: current.updatedAt,
        pinRetryAt: Date.now() + PROJECT_CARD_PIN_RETRY_MS,
        ...(refreshPending ? { refreshPending: true } : {}),
      };
      return current;
    }))!;
    // A deduplicated send can return the message created by an earlier attempt
    // with older content. Converge that same message before recording the digest.
    if (sendUuid && (!canRepost || canRepost())) {
      await this.transport.updateCard(project.larkAppId, messageId, cardJson);
    }
    const pinned = !canRepost || canRepost() ? await this.confirmCardPin(context, published) : published;
    if (!canRepost || canRepost()) await this.retireOnboardingCard(context);
    // The new card adds one revision. If another write bumped the revision
    // during publication, its content has not been rendered yet.
    return { project: pinned, digest: buildProjectGroupCardDigest({ ...project, revision: project.revision + 1 }, runtime) };
  }

  private async confirmCardPin(context: ProjectCoordinatorContext, project: ProjectGroupState): Promise<ProjectGroupState> {
    const card = project.card;
    if (!card || card.pinned) return project;
    if (!await this.transport.pinMessage(project.larkAppId, card.messageId)) {
      logger.warn(`[project] Could not pin card ${card.messageId}: pin not confirmed`);
      return project;
    }
    return (await mutateProjectGroup(context.dataDir, context.chatId, current => {
      if (!current) throw new Error('project_not_found');
      if (current.card?.messageId === card.messageId) {
        current.card.pinned = true;
        delete current.card.pinRetryAt;
      }
      return current;
    }))!;
  }
}
