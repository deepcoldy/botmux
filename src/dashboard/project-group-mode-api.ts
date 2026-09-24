import {
  readGroupCollaborationMode,
  writeGroupCollaborationMode,
  type GroupCollaborationModeConfig,
} from '../services/group-collaboration-mode-store.js';
import {
  projectOverallProgress,
  projectRemainingSummary,
  readProjectGroup,
  type ProjectGroupState,
} from '../services/project-group-store.js';
import {
  parseProjectProgressCardConfig,
  resolveProjectProgressCardConfig,
} from '../services/project-progress-card-config.js';

export interface ProjectGroupModeApiDeps {
  dataDir: string;
  groups: () => Promise<{ chats: Array<Record<string, unknown>> }>;
  readConfig?: (dataDir: string, chatId: string) => GroupCollaborationModeConfig | undefined;
  writeConfig?: typeof writeGroupCollaborationMode;
  readProject?: (dataDir: string, chatId: string) => ProjectGroupState | undefined;
  refreshProjectCard?: (chatId: string, coordinatorAppId: string) => Promise<ProjectGroupState>;
  ensureOnboardingCard?: (
    chatId: string,
    coordinatorAppId: string,
    input: { coordinatorName: string; workerNames: string[] },
  ) => Promise<unknown>;
  clearOnboardingCard?: (chatId: string, coordinatorAppId: string) => Promise<void>;
}

export interface ProjectRuntimeSummary {
  status: ProjectGroupState['status'];
  phase: string;
  focus: string;
  progress: number;
  remaining: string;
  workstreamCount: number;
  completedWorkstreamCount: number;
  blockerCount: number;
  cardPinned: boolean;
  updatedAt: string;
}

export interface ProjectGroupModeApiResult {
  status: number;
  body: Record<string, unknown>;
}

export function summarizeProjectRuntime(project: ProjectGroupState | undefined): ProjectRuntimeSummary | null {
  if (!project) return null;
  return {
    status: project.status,
    phase: project.phase,
    focus: project.focus,
    progress: projectOverallProgress(project),
    remaining: projectRemainingSummary(project),
    workstreamCount: project.workstreams.length,
    completedWorkstreamCount: project.workstreams.filter(item => item.status === 'completed').length,
    blockerCount: project.blockers.length,
    cardPinned: project.card?.pinned === true,
    updatedAt: project.updatedAt,
  };
}

function responseBody(
  chatId: string,
  config: GroupCollaborationModeConfig | undefined,
  project: ProjectGroupState | undefined,
  extra?: Record<string, unknown>,
): Record<string, unknown> {
  const publicConfig = config
    ? (({ onboardingCard: _onboardingCard, ...rest }) => rest)(config)
    : undefined;
  const effectiveConfig = publicConfig?.mode === 'project'
    ? {
        ...publicConfig,
        autoEnrollWorkers: publicConfig.autoEnrollWorkers === true,
        progressCard: resolveProjectProgressCardConfig(publicConfig.progressCard),
      }
    : publicConfig ?? { schemaVersion: 1, chatId, mode: 'standard' };
  return {
    ok: true,
    config: effectiveConfig,
    project: summarizeProjectRuntime(project),
    ...extra,
  };
}

function bad(error: string, status = 400, detail?: Record<string, unknown>): ProjectGroupModeApiResult {
  return { status, body: { ok: false, error, ...detail } };
}

export async function getProjectGroupMode(
  chatId: string,
  deps: ProjectGroupModeApiDeps,
): Promise<ProjectGroupModeApiResult> {
  const readConfig = deps.readConfig ?? readGroupCollaborationMode;
  const readProject = deps.readProject ?? readProjectGroup;
  return { status: 200, body: responseBody(chatId, readConfig(deps.dataDir, chatId), readProject(deps.dataDir, chatId)) };
}

export async function putProjectGroupMode(
  chatId: string,
  body: unknown,
  deps: ProjectGroupModeApiDeps,
): Promise<ProjectGroupModeApiResult> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return bad('body_must_be_object');
  const record = body as Record<string, unknown>;
  const supported = new Set(['mode', 'coordinatorAppId', 'workerAppIds', 'autoEnrollWorkers', 'progressCard']);
  const unsupported = Object.keys(record).filter(key => !supported.has(key));
  if (unsupported.length > 0) return bad('unsupported_field', 400, { fields: unsupported });
  if (record.mode !== 'standard' && record.mode !== 'project') return bad('invalid_mode');

  const groups = await deps.groups();
  const chat = groups.chats.find(candidate => candidate.chatId === chatId);
  if (!chat) return bad('group_not_found', 404);
  if (chat.sessionGroup === true) return bad('session_group_not_supported', 409);
  if (chat.chatMode !== 'group') return bad('project_mode_requires_ordinary_group', 409);

  const writeConfig = deps.writeConfig ?? writeGroupCollaborationMode;
  const readProject = deps.readProject ?? readProjectGroup;
  const currentConfig = (deps.readConfig ?? readGroupCollaborationMode)(deps.dataDir, chatId);
  if (record.mode === 'standard') {
    if (record.progressCard !== undefined) return bad('progress_card_requires_project_mode');
    if (currentConfig?.onboardingCard && deps.clearOnboardingCard) {
      try {
        await deps.clearOnboardingCard(chatId, currentConfig.onboardingCard.larkAppId);
      } catch (error) {
        return bad('onboarding_card_cleanup_failed', 502, {
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const config = await writeConfig(deps.dataDir, { chatId, mode: 'standard' });
    return { status: 200, body: responseBody(chatId, config, readProject(deps.dataDir, chatId)) };
  }

  const coordinatorAppId = typeof record.coordinatorAppId === 'string' ? record.coordinatorAppId.trim() : '';
  const workerAppIds = Array.isArray(record.workerAppIds)
    ? record.workerAppIds.filter((value): value is string => typeof value === 'string').map(value => value.trim()).filter(Boolean)
    : null;
  if (!coordinatorAppId) return bad('coordinator_required');
  if (!workerAppIds || workerAppIds.length > 64 || new Set(workerAppIds).size !== workerAppIds.length) {
    return bad('invalid_worker_app_ids');
  }
  if (workerAppIds.includes(coordinatorAppId)) return bad('coordinator_cannot_be_worker');
  if (record.autoEnrollWorkers !== undefined && typeof record.autoEnrollWorkers !== 'boolean') {
    return bad('invalid_auto_enroll_workers');
  }
  const autoEnrollWorkers = record.autoEnrollWorkers === true;
  const progressCardParsed = record.progressCard === undefined
    ? { ok: true as const, value: resolveProjectProgressCardConfig(currentConfig?.progressCard) }
    : parseProjectProgressCardConfig(record.progressCard);
  if (!progressCardParsed.ok) return bad(progressCardParsed.error);

  const inChat = new Set(
    (Array.isArray(chat.memberBots) ? chat.memberBots : [])
      .filter(member => member && typeof member === 'object' && (member as Record<string, unknown>).inChat === true)
      .map(member => (member as Record<string, unknown>).larkAppId)
      .filter((value): value is string => typeof value === 'string'),
  );
  if (!inChat.has(coordinatorAppId)) return bad('coordinator_not_in_chat', 409);
  const unavailableWorkerAppIds = workerAppIds.filter(appId => !inChat.has(appId));
  if (unavailableWorkerAppIds.length > 0) {
    return bad('worker_not_in_chat', 409, { unavailableWorkerAppIds });
  }
  const project = readProject(deps.dataDir, chatId);
  if (project && project.larkAppId !== coordinatorAppId) {
    return bad('project_coordinator_conflict', 409, { currentCoordinatorAppId: project.larkAppId });
  }
  if (currentConfig?.onboardingCard && currentConfig.onboardingCard.larkAppId !== coordinatorAppId) {
    if (!deps.clearOnboardingCard) return bad('onboarding_card_cleanup_unavailable', 503);
    try {
      await deps.clearOnboardingCard(chatId, currentConfig.onboardingCard.larkAppId);
    } catch (error) {
      return bad('onboarding_card_cleanup_failed', 502, {
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const config = await writeConfig(deps.dataDir, {
    chatId,
    mode: 'project',
    coordinatorAppId,
    workerAppIds,
    autoEnrollWorkers,
    progressCard: progressCardParsed.value,
  });
  if (!project) {
    if (!deps.ensureOnboardingCard) {
      return { status: 200, body: responseBody(chatId, config, project, { cardRefresh: 'deferred' }) };
    }
    const members = (Array.isArray(chat.memberBots) ? chat.memberBots : [])
      .filter(member => member && typeof member === 'object')
      .map(member => member as Record<string, unknown>);
    const nameByAppId = new Map(members.map(member => [
      typeof member.larkAppId === 'string' ? member.larkAppId : '',
      typeof member.botName === 'string' && member.botName.trim() ? member.botName.trim() : undefined,
    ]));
    try {
      await deps.ensureOnboardingCard(chatId, coordinatorAppId, {
        coordinatorName: nameByAppId.get(coordinatorAppId) ?? coordinatorAppId,
        workerNames: workerAppIds.map(appId => nameByAppId.get(appId) ?? appId),
      });
      return { status: 200, body: responseBody(chatId, config, project, { cardRefresh: 'updated' }) };
    } catch (error) {
      return {
        status: 200,
        body: responseBody(chatId, config, project, {
          cardRefresh: 'deferred',
          cardRefreshError: error instanceof Error ? error.message : String(error),
        }),
      };
    }
  }
  if (!deps.refreshProjectCard) {
    return { status: 200, body: responseBody(chatId, config, project, { cardRefresh: 'deferred' }) };
  }
  try {
    const refreshed = await deps.refreshProjectCard(chatId, coordinatorAppId);
    return { status: 200, body: responseBody(chatId, config, refreshed, { cardRefresh: 'updated' }) };
  } catch (error) {
    return {
      status: 200,
      body: responseBody(chatId, config, project, {
        cardRefresh: 'deferred',
        cardRefreshError: error instanceof Error ? error.message : String(error),
      }),
    };
  }
}
