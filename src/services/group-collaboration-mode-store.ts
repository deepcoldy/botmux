import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { withFileLock } from '../utils/file-lock.js';
import type { ProjectProgressCardConfig } from './project-progress-card-config.js';

export const GROUP_COLLABORATION_MODE_STORE_FILE = 'group-collaboration-modes.json';

export type GroupCollaborationMode = 'standard' | 'project';

export interface ProjectOnboardingCardState {
  messageId: string;
  larkAppId: string;
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface GroupCollaborationModeConfig {
  schemaVersion: 1;
  chatId: string;
  mode: GroupCollaborationMode;
  coordinatorAppId?: string;
  workerAppIds?: string[];
  /** Whether newly joined locally managed Bots should automatically become Workers. */
  autoEnrollWorkers?: boolean;
  progressCard?: ProjectProgressCardConfig;
  /** Internal projection state for the pinned "waiting to start" guide. */
  onboardingCard?: ProjectOnboardingCardState;
  createdAt: string;
  updatedAt: string;
}

interface GroupCollaborationModeRegistry {
  schemaVersion: 1;
  configs: Record<string, GroupCollaborationModeConfig>;
}

export type ProjectDispatchPolicyDecision =
  | { ok: true; projectMode: boolean }
  | {
      ok: false;
      error:
        | 'project_coordinator_required'
        | 'project_cross_chat_dispatch_forbidden'
        | 'project_dispatch_requires_app_ids'
        | 'project_dispatch_title_required'
        | 'project_dispatch_title_too_long'
        | 'project_worker_not_allowed';
      disallowedAppIds?: string[];
    };

function registryPath(dataDir: string): string {
  return join(dataDir, GROUP_COLLABORATION_MODE_STORE_FILE);
}

function emptyRegistry(): GroupCollaborationModeRegistry {
  return { schemaVersion: 1, configs: {} };
}

function readRegistry(path: string): GroupCollaborationModeRegistry {
  if (!existsSync(path)) return emptyRegistry();
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${GROUP_COLLABORATION_MODE_STORE_FILE} must contain an object`);
  }
  const raw = parsed as Partial<GroupCollaborationModeRegistry>;
  if (raw.schemaVersion !== 1 || !raw.configs || typeof raw.configs !== 'object' || Array.isArray(raw.configs)) {
    throw new Error(`${GROUP_COLLABORATION_MODE_STORE_FILE} has an unsupported schema`);
  }
  return raw as GroupCollaborationModeRegistry;
}

function writeRegistry(path: string, registry: GroupCollaborationModeRegistry): void {
  atomicWriteFileSync(path, JSON.stringify(registry, null, 2), {
    mode: 0o600,
    followTargetSymlink: false,
  });
}

export function readGroupCollaborationMode(
  dataDir: string,
  chatId: string,
): GroupCollaborationModeConfig | undefined {
  const config = readRegistry(registryPath(dataDir)).configs[chatId];
  return config ? structuredClone(config) : undefined;
}

export function listGroupCollaborationModes(dataDir: string): GroupCollaborationModeConfig[] {
  return Object.values(readRegistry(registryPath(dataDir)).configs).map(config => structuredClone(config));
}

export async function writeGroupCollaborationMode(
  dataDir: string,
  input: {
    chatId: string;
    mode: GroupCollaborationMode;
    coordinatorAppId?: string;
    workerAppIds?: string[];
    autoEnrollWorkers?: boolean;
    progressCard?: ProjectProgressCardConfig;
  },
): Promise<GroupCollaborationModeConfig> {
  const path = registryPath(dataDir);
  let result!: GroupCollaborationModeConfig;
  await withFileLock(path, async () => {
    const registry = readRegistry(path);
    const current = registry.configs[input.chatId];
    const now = new Date().toISOString();
    const progressCard = input.progressCard ?? current?.progressCard;
    result = {
      schemaVersion: 1,
      chatId: input.chatId,
      mode: input.mode,
      ...(input.mode === 'project'
        ? {
            coordinatorAppId: input.coordinatorAppId,
            workerAppIds: [...new Set(input.workerAppIds ?? [])],
            autoEnrollWorkers: input.autoEnrollWorkers ?? current?.autoEnrollWorkers ?? false,
          }
        : {}),
      ...(progressCard ? { progressCard: structuredClone(progressCard) } : {}),
      ...(current?.onboardingCard ? { onboardingCard: structuredClone(current.onboardingCard) } : {}),
      createdAt: current?.createdAt ?? now,
      updatedAt: now,
    };
    registry.configs[input.chatId] = result;
    writeRegistry(path, registry);
  });
  return structuredClone(result);
}

/** Enroll a Bot that has just joined a project group configured for automatic enrollment.
 *
 * This is intentionally independent from the Bot's auto-start-on-join setting:
 * joining the project roster is control-plane state, while auto-start decides
 * whether the Bot should immediately create a conversation session. Groups with
 * an explicitly curated Worker subset remain unchanged.
 */
export async function addProjectWorkerIfNeeded(
  dataDir: string,
  chatId: string,
  larkAppId: string,
): Promise<GroupCollaborationModeConfig | undefined> {
  const workerAppId = larkAppId.trim();
  if (!workerAppId) return undefined;

  const path = registryPath(dataDir);
  let result: GroupCollaborationModeConfig | undefined;
  await withFileLock(path, async () => {
    const registry = readRegistry(path);
    const current = registry.configs[chatId];
    if (
      !current
      || current.mode !== 'project'
      || current.autoEnrollWorkers !== true
      || current.coordinatorAppId === workerAppId
      || (current.workerAppIds ?? []).includes(workerAppId)
    ) {
      return;
    }

    result = {
      ...current,
      workerAppIds: [...(current.workerAppIds ?? []), workerAppId],
      updatedAt: new Date().toISOString(),
    };
    registry.configs[chatId] = result;
    writeRegistry(path, registry);
  });
  return result ? structuredClone(result) : undefined;
}

/** Persist or clear the internal guide-card projection without rewriting the
 * user-owned collaboration policy. */
export async function writeProjectOnboardingCard(
  dataDir: string,
  chatId: string,
  card: ProjectOnboardingCardState | undefined,
): Promise<GroupCollaborationModeConfig> {
  const path = registryPath(dataDir);
  let result!: GroupCollaborationModeConfig;
  await withFileLock(path, async () => {
    const registry = readRegistry(path);
    const current = registry.configs[chatId];
    if (!current) throw new Error('group_collaboration_mode_not_found');
    if (card && (current.mode !== 'project' || current.coordinatorAppId !== card.larkAppId)) {
      throw new Error('project_onboarding_coordinator_mismatch');
    }
    result = { ...current, updatedAt: new Date().toISOString() };
    if (card) result.onboardingCard = structuredClone(card);
    else delete result.onboardingCard;
    registry.configs[chatId] = result;
    writeRegistry(path, registry);
  });
  return structuredClone(result);
}

export function evaluateProjectDispatchPolicy(input: {
  config: GroupCollaborationModeConfig | undefined;
  sourceAppId: string;
  sourceChatId: string;
  targetChatId: string;
  targetAppIds: string[];
  hasLegacyBots: boolean;
  title?: string;
  existingDispatch?: boolean;
}): ProjectDispatchPolicyDecision {
  const config = input.config;
  if (!config || config.mode !== 'project') return { ok: true, projectMode: false };
  if (config.coordinatorAppId !== input.sourceAppId) {
    return { ok: false, error: 'project_coordinator_required' };
  }
  if (input.sourceChatId !== config.chatId || input.targetChatId !== config.chatId) {
    return { ok: false, error: 'project_cross_chat_dispatch_forbidden' };
  }
  if (input.hasLegacyBots) return { ok: false, error: 'project_dispatch_requires_app_ids' };
  if (!input.existingDispatch) {
    const title = input.title?.trim() ?? '';
    if (!title || title === '子任务' || title === '子项目') {
      return { ok: false, error: 'project_dispatch_title_required' };
    }
    if (Array.from(title).length > 24) {
      return { ok: false, error: 'project_dispatch_title_too_long' };
    }
  }
  const allowed = new Set(config.workerAppIds ?? []);
  const disallowedAppIds = [...new Set(input.targetAppIds.filter(appId => !allowed.has(appId)))];
  if (disallowedAppIds.length > 0) {
    return { ok: false, error: 'project_worker_not_allowed', disallowedAppIds };
  }
  return { ok: true, projectMode: true };
}
