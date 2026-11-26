import { buildProjectGroupCardDigest, type ProjectGroupCardRuntime } from '../im/lark/project-group-card.js';
import type { GroupCollaborationModeConfig } from './group-collaboration-mode-store.js';
import type { ProjectCardPublication, ProjectCardSyncTarget } from './project-coordinator.js';
import type { ProjectGroupState } from './project-group-store.js';

const CHAT_ID_RE = /^oc_[A-Za-z0-9_-]{1,128}$/;
const APP_ID_OWNER_RE = /^cli_[A-Za-z0-9_-]{1,128}$/u;

/**
 * 同一份卡片摘要最多连续刷新 3 次，约覆盖 1.5 分钟的瞬时故障。预算耗尽后停止 PATCH。
 * 窗口内出现过飞书编辑过期（230031）才允许后台重发，每个摘要一次、每群间隔至少 10 分钟。
 */
export const PROJECT_CARD_REFRESH_ATTEMPTS_PER_DIGEST = 3;
const PROJECT_CARD_REPOST_COOLDOWN_MS = 10 * 60_000;

export interface ProjectCardRuntimeSyncDeps {
  /** 本 daemon 的 Bot；只刷新它当主控的项目卡。 */
  larkAppId: string;
  listProjects(): ProjectGroupState[];
  readMode(chatId: string): GroupCollaborationModeConfig | undefined;
  resolveRuntime(project: ProjectGroupState): Promise<ProjectGroupCardRuntime | undefined>;
  /** Undefined if the queued publication no longer matches the target. */
  refresh(project: ProjectGroupState, target: ProjectCardSyncTarget): Promise<ProjectCardPublication | undefined>;
  isMessageUpdateExpired(error: unknown): boolean;
  repostExpiredCard(project: ProjectGroupState, target: ProjectCardSyncTarget): Promise<ProjectCardPublication | undefined>;
  retryPendingCardPin(project: ProjectGroupState, messageId: string): Promise<ProjectGroupState | undefined>;
  /** 主控在本机别的 daemon 上：只把群 ID 转过去，由主控自己重读状态。 */
  forwardToCoordinator(coordinatorAppId: string, chatId: string): void;
  onDeferred?(chatId: string, error: unknown): void;
}

export interface ProjectCardRuntimeSync {
  sync(chatId?: string): Promise<void>;
  schedule(chatId?: string, delayMs?: number): void;
  notify(chatId: string | undefined): void;
}

function hasDynamicWorkstreams(project: ProjectGroupState): boolean {
  return project.workstreams.some(item => !!item.attachment
    || item.owners.some(owner => APP_ID_OWNER_RE.test(owner.trim())));
}

type CardSyncState = ProjectCardSyncTarget & (
  | { status: 'published' | 'pinPending' }
  | { status: 'failed'; failures: number; sawExpired: boolean }
);

/**
 * 主控置顶卡的运行态刷新：会话状态变化事件、迁入关联变化与 30 秒兜底 tick 都走这里。
 * 同群刷新串行。摘要变化时重新计数，过期重发与 PATCH 分开限频。
 */
export function createProjectCardRuntimeSync(deps: ProjectCardRuntimeSyncDeps): ProjectCardRuntimeSync {
  const states = new Map<string, CardSyncState>();
  const reposts = new Map<string, { revision: number; cooldownUntil: number; digests: Set<string> }>();
  const syncing = new Set<string>();
  const pending = new Map<string, ReturnType<typeof setTimeout>>();

  function rememberPublication({ project, digest }: ProjectCardPublication): void {
    if (!project.card) return;
    states.set(project.chatId, {
      digest, messageId: project.card.messageId,
      status: project.card.pinned ? 'published' : 'pinPending',
    });
  }

  async function repostIfAllowed(project: ProjectGroupState, target: ProjectCardSyncTarget): Promise<void> {
    const { chatId } = project;
    const { digest } = target;
    const previous = reposts.get(chatId);
    if (previous && Date.now() < previous.cooldownUntil) return;
    // The digest includes the monotonically increasing project revision. Keep
    // attempts across runtime changes at this revision, not old revisions.
    const digests = previous?.revision === project.revision ? previous.digests : new Set<string>();
    if (digests.has(digest)) return;
    function rememberAttempt(): void {
      digests.add(digest);
      reposts.set(chatId, {
        revision: project.revision, cooldownUntil: Date.now() + PROJECT_CARD_REPOST_COOLDOWN_MS, digests,
      });
    }
    try {
      const updated = await deps.repostExpiredCard(project, target);
      if (updated) {
        rememberAttempt();
        rememberPublication(updated);
      }
    } catch (error) {
      rememberAttempt();
      states.set(chatId, {
        ...target, status: 'failed', failures: PROJECT_CARD_REFRESH_ATTEMPTS_PER_DIGEST + 1, sawExpired: true,
      });
      deps.onDeferred?.(chatId, error);
    }
  }

  async function retryPinIfDue(project: ProjectGroupState): Promise<void> {
    const { card, chatId } = project;
    if (!card || card.pinned || card.pinRetryAt === undefined || card.pinRetryAt > Date.now()) return;
    try {
      const updated = await deps.retryPendingCardPin(project, card.messageId);
      const state = states.get(chatId);
      if (updated?.card?.messageId === card.messageId && updated.card.pinned
        && state?.status === 'pinPending' && state.messageId === card.messageId) {
        states.set(chatId, { ...state, status: 'published' });
      }
    } catch (error) {
      deps.onDeferred?.(chatId, error);
    }
  }

  async function syncProject(project: ProjectGroupState, messageId: string): Promise<void> {
    const { chatId, card } = project;
    const mode = deps.readMode(chatId);
    if (mode && (mode.mode !== 'project' || mode.coordinatorAppId !== deps.larkAppId)) return;
    if (!mode && !card?.refreshPending && card?.pinRetryAt === undefined) return;
    await retryPinIfDue(project);
    if (!card?.refreshPending && !hasDynamicWorkstreams(project)) return;

    const runtime = await deps.resolveRuntime(project);
    const digest = buildProjectGroupCardDigest(project, runtime);
    const target = { messageId, digest };
    const state = states.get(chatId);
    const last = state?.digest === digest && state.messageId === messageId ? state : undefined;
    // Even with a pin pending, the rendered content does not need another PATCH.
    if (last && last.status !== 'failed') return;
    let failures = last?.failures ?? 0;
    let sawExpired = last?.sawExpired ?? false;
    if (failures < PROJECT_CARD_REFRESH_ATTEMPTS_PER_DIGEST) {
      try {
        const updated = await deps.refresh(project, target);
        if (updated) rememberPublication(updated);
        return;
      } catch (error) {
        failures += 1;
        sawExpired ||= deps.isMessageUpdateExpired(error);
        states.set(chatId, { ...target, status: 'failed', failures, sawExpired });
        deps.onDeferred?.(chatId, error);
      }
    }
    if (failures === PROJECT_CARD_REFRESH_ATTEMPTS_PER_DIGEST && sawExpired) {
      await repostIfAllowed(project, target);
    }
  }

  async function sync(filterChatId?: string): Promise<void> {
    let projects: ProjectGroupState[];
    try {
      projects = deps.listProjects();
    } catch {
      return;
    }
    for (const project of projects) {
      const { chatId } = project;
      const messageId = project.card?.messageId;
      if (project.larkAppId !== deps.larkAppId || !messageId) continue;
      if ((filterChatId && chatId !== filterChatId) || syncing.has(chatId)) continue;
      syncing.add(chatId);
      try {
        await syncProject(project, messageId);
      } catch (error) {
        deps.onDeferred?.(chatId, error);
      } finally {
        syncing.delete(chatId);
      }
    }
  }

  function schedule(chatId?: string, delayMs = 1_200): void {
    const key = chatId ?? '*';
    if (pending.has(key)) return;
    const timer = setTimeout(() => {
      pending.delete(key);
      void sync(chatId);
    }, delayMs);
    timer.unref?.();
    pending.set(key, timer);
  }

  function notify(chatId: string | undefined): void {
    if (!chatId || !CHAT_ID_RE.test(chatId)) return;
    let mode: GroupCollaborationModeConfig | undefined;
    try {
      mode = deps.readMode(chatId);
    } catch {
      return;
    }
    if (mode?.mode !== 'project' || !mode.coordinatorAppId) return;
    if (mode.coordinatorAppId === deps.larkAppId) {
      schedule(chatId, 1_000);
      return;
    }
    deps.forwardToCoordinator(mode.coordinatorAppId, chatId);
  }

  return { sync, schedule, notify };
}
