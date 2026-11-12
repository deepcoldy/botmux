import { buildProjectGroupCardDigest, type ProjectGroupCardRuntime } from '../im/lark/project-group-card.js';
import type { GroupCollaborationModeConfig } from './group-collaboration-mode-store.js';
import type { ProjectGroupState } from './project-group-store.js';

const CHAT_ID_RE = /^oc_[A-Za-z0-9_-]{1,128}$/;
const APP_ID_OWNER_RE = /^cli_[A-Za-z0-9_-]{1,128}$/u;

/**
 * 同一份卡片摘要连续刷新失败到这个次数就停手，等摘要变化（会话状态变了、项目有新写入）再试。
 * 飞书卡片过了 14 天编辑窗口（230031）、主控 Bot 被移出群这类失败不会自己恢复；不设上限时，
 * 每个 30 秒 tick 都会对同一张卡重打一遍飞书接口，永远停不下来。3 次约覆盖 1.5 分钟的瞬时故障。
 */
export const PROJECT_CARD_REFRESH_ATTEMPTS_PER_DIGEST = 3;

export interface ProjectCardRuntimeSyncDeps {
  /** 本 daemon 的 Bot；只刷新它当主控的项目卡。 */
  larkAppId: string;
  listProjects(): ProjectGroupState[];
  readMode(chatId: string): GroupCollaborationModeConfig | undefined;
  resolveRuntime(project: ProjectGroupState): Promise<ProjectGroupCardRuntime | undefined>;
  refresh(project: ProjectGroupState): Promise<ProjectGroupState>;
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

/**
 * 主控置顶卡的运行态刷新：会话状态变化事件、迁入关联变化与 30 秒兜底 tick 都走这里。
 * 只在卡片摘要变化时调飞书；同一摘要失败有上限（见 PROJECT_CARD_REFRESH_ATTEMPTS_PER_DIGEST）。
 */
export function createProjectCardRuntimeSync(deps: ProjectCardRuntimeSyncDeps): ProjectCardRuntimeSync {
  const published = new Map<string, { digest: string; failures: number }>();
  const pending = new Map<string, ReturnType<typeof setTimeout>>();

  async function sync(filterChatId?: string): Promise<void> {
    let projects: ProjectGroupState[];
    try {
      projects = deps.listProjects();
    } catch {
      return;
    }
    for (const project of projects) {
      if (project.larkAppId !== deps.larkAppId || !project.card?.messageId) continue;
      if (filterChatId && project.chatId !== filterChatId) continue;
      try {
        const mode = deps.readMode(project.chatId);
        if (mode?.mode !== 'project' || mode.coordinatorAppId !== deps.larkAppId) continue;
        if (!hasDynamicWorkstreams(project)) continue;
        const digest = buildProjectGroupCardDigest(project, await deps.resolveRuntime(project));
        const last = published.get(project.chatId);
        const failures = last?.digest === digest ? last.failures : 0;
        if (last?.digest === digest
          && (failures === 0 || failures >= PROJECT_CARD_REFRESH_ATTEMPTS_PER_DIGEST)) continue;
        // 先占位：同一摘要的并发同步看到它就跳过。
        published.set(project.chatId, { digest, failures: 0 });
        try {
          const refreshed = await deps.refresh(project);
          published.set(project.chatId, {
            digest: buildProjectGroupCardDigest(refreshed, await deps.resolveRuntime(refreshed)),
            failures: 0,
          });
        } catch (error) {
          published.set(project.chatId, { digest, failures: failures + 1 });
          deps.onDeferred?.(project.chatId, error);
        }
      } catch (error) {
        deps.onDeferred?.(project.chatId, error);
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
