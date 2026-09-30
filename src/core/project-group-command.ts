import type { ChatBotMember, ChatMode } from '../im/lark/client.js';
import type {
  GroupCollaborationModeConfig,
} from '../services/group-collaboration-mode-store.js';
import type { ProjectGroupState } from '../services/project-group-store.js';

export type ProjectGroupSlashSubcommand = 'help' | 'enable' | 'status' | 'roles' | 'disable';

export type ProjectGroupSlashParseResult =
  | { ok: true; subcommand: ProjectGroupSlashSubcommand }
  | { ok: false; error: 'unknown_subcommand' | 'unexpected_arguments'; value: string };

export type ProjectGroupSlashResult =
  | { kind: 'help' }
  | {
      kind: 'enabled';
      alreadyEnabled: boolean;
      config: GroupCollaborationModeConfig;
      project: ProjectGroupState | undefined;
      cardRefresh: 'updated' | 'deferred' | 'not_needed';
      cardRefreshError?: string;
    }
  | {
      kind: 'status';
      config: GroupCollaborationModeConfig | undefined;
      project: ProjectGroupState | undefined;
    }
  | {
      kind: 'roles';
      config: GroupCollaborationModeConfig;
    }
  | {
      kind: 'disabled';
      alreadyDisabled: boolean;
      projectRetained: boolean;
    }
  | {
      kind: 'error';
      error:
        | 'chat_lookup_failed'
        | 'ordinary_group_required'
        | 'bot_roster_unavailable'
        | 'coordinator_not_in_chat'
        | 'coordinator_conflict'
        | 'project_mode_required'
        | 'unknown_subcommand'
        | 'unexpected_arguments';
      detail?: string;
    };

export interface ProjectGroupSlashDeps {
  dataDir: string;
  getChatMode(larkAppId: string, chatId: string): Promise<ChatMode | 'unknown'>;
  listChatBotMembers(larkAppId: string, chatId: string): Promise<ChatBotMember[]>;
  readConfig(dataDir: string, chatId: string): GroupCollaborationModeConfig | undefined;
  writeConfig(
    dataDir: string,
    input: {
      chatId: string;
      mode: 'standard' | 'project';
      coordinatorAppId?: string;
      workerAppIds?: string[];
      autoEnrollWorkers?: boolean;
    },
  ): Promise<GroupCollaborationModeConfig>;
  readProject(dataDir: string, chatId: string): ProjectGroupState | undefined;
  ensureOnboardingCard(
    context: { dataDir: string; chatId: string; larkAppId: string },
    input: { coordinatorName: string; workerNames: string[] },
  ): Promise<unknown>;
  clearOnboardingCard(
    context: { dataDir: string; chatId: string; larkAppId: string },
  ): Promise<unknown>;
}

export function parseProjectGroupSlashCommand(content: string): ProjectGroupSlashParseResult {
  const args = content.replace(/^\/project(?:\s+|$)/i, '').trim();
  if (!args) return { ok: true, subcommand: 'help' };
  const tokens = args.split(/\s+/u);
  const raw = tokens[0]!.toLowerCase();
  const aliases: Record<string, ProjectGroupSlashSubcommand> = {
    help: 'help',
    enable: 'enable',
    on: 'enable',
    status: 'status',
    get: 'status',
    roles: 'roles',
    role: 'roles',
    disable: 'disable',
    off: 'disable',
  };
  const subcommand = aliases[raw];
  if (!subcommand) return { ok: false, error: 'unknown_subcommand', value: raw };
  if (tokens.length > 1) {
    return { ok: false, error: 'unexpected_arguments', value: tokens.slice(1).join(' ') };
  }
  return { ok: true, subcommand };
}

async function ordinaryGroupError(
  input: { larkAppId: string; chatId: string },
  deps: ProjectGroupSlashDeps,
): Promise<ProjectGroupSlashResult | undefined> {
  let mode: ChatMode | 'unknown';
  try {
    mode = await deps.getChatMode(input.larkAppId, input.chatId);
  } catch (error) {
    return { kind: 'error', error: 'chat_lookup_failed', detail: error instanceof Error ? error.message : String(error) };
  }
  if (mode === 'unknown') return { kind: 'error', error: 'chat_lookup_failed' };
  if (mode !== 'group') return { kind: 'error', error: 'ordinary_group_required' };
  return undefined;
}

function configuredRoster(members: ChatBotMember[]): ChatBotMember[] {
  const seen = new Set<string>();
  return members.filter(member => {
    if (!member.larkAppId || seen.has(member.larkAppId)) return false;
    seen.add(member.larkAppId);
    return true;
  });
}

async function ensureGuide(
  input: { larkAppId: string; chatId: string },
  config: GroupCollaborationModeConfig,
  members: ChatBotMember[],
  deps: ProjectGroupSlashDeps,
): Promise<Pick<Extract<ProjectGroupSlashResult, { kind: 'enabled' }>, 'cardRefresh' | 'cardRefreshError'>> {
  const byAppId = new Map(members.map(member => [member.larkAppId, member]));
  const coordinatorName = byAppId.get(input.larkAppId)?.displayName ?? input.larkAppId;
  const workerNames = (config.workerAppIds ?? []).map(appId => byAppId.get(appId)?.displayName ?? appId);
  try {
    await deps.ensureOnboardingCard({ dataDir: deps.dataDir, chatId: input.chatId, larkAppId: input.larkAppId }, {
      coordinatorName,
      workerNames,
    });
    return { cardRefresh: 'updated' };
  } catch (error) {
    return {
      cardRefresh: 'deferred',
      cardRefreshError: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function runProjectGroupSlashCommand(
  input: { content: string; larkAppId: string; chatId: string },
  deps: ProjectGroupSlashDeps,
): Promise<ProjectGroupSlashResult> {
  const parsed = parseProjectGroupSlashCommand(input.content);
  if (!parsed.ok) return { kind: 'error', error: parsed.error, detail: parsed.value };
  if (parsed.subcommand === 'help') return { kind: 'help' };

  const topologyError = await ordinaryGroupError(input, deps);
  if (topologyError) return topologyError;

  const currentConfig = deps.readConfig(deps.dataDir, input.chatId);
  const project = deps.readProject(deps.dataDir, input.chatId);

  if (parsed.subcommand === 'status') {
    return { kind: 'status', config: currentConfig, project };
  }

  if (parsed.subcommand === 'roles') {
    if (!currentConfig || currentConfig.mode !== 'project') {
      return { kind: 'error', error: 'project_mode_required' };
    }
    if (currentConfig.coordinatorAppId !== input.larkAppId) {
      return { kind: 'error', error: 'coordinator_conflict', detail: currentConfig.coordinatorAppId };
    }
    return { kind: 'roles', config: currentConfig };
  }

  if (parsed.subcommand === 'disable') {
    if (!currentConfig || currentConfig.mode !== 'project') {
      return { kind: 'disabled', alreadyDisabled: true, projectRetained: !!project };
    }
    if (currentConfig.coordinatorAppId !== input.larkAppId) {
      return { kind: 'error', error: 'coordinator_conflict', detail: currentConfig.coordinatorAppId };
    }
    if (currentConfig.onboardingCard) {
      await deps.clearOnboardingCard({ dataDir: deps.dataDir, chatId: input.chatId, larkAppId: input.larkAppId });
    }
    await deps.writeConfig(deps.dataDir, { chatId: input.chatId, mode: 'standard' });
    return { kind: 'disabled', alreadyDisabled: false, projectRetained: !!project };
  }

  if (currentConfig?.mode === 'project' && currentConfig.coordinatorAppId !== input.larkAppId) {
    return { kind: 'error', error: 'coordinator_conflict', detail: currentConfig.coordinatorAppId };
  }
  if (project && project.larkAppId !== input.larkAppId) {
    return { kind: 'error', error: 'coordinator_conflict', detail: project.larkAppId };
  }

  let members: ChatBotMember[];
  try {
    members = configuredRoster(await deps.listChatBotMembers(input.larkAppId, input.chatId));
  } catch (error) {
    return { kind: 'error', error: 'bot_roster_unavailable', detail: error instanceof Error ? error.message : String(error) };
  }
  if (!members.some(member => member.larkAppId === input.larkAppId)) {
    return { kind: 'error', error: 'coordinator_not_in_chat' };
  }

  const alreadyEnabled = currentConfig?.mode === 'project';
  const config = alreadyEnabled
    ? currentConfig
    : await deps.writeConfig(deps.dataDir, {
        chatId: input.chatId,
        mode: 'project',
        coordinatorAppId: input.larkAppId,
        workerAppIds: members.map(member => member.larkAppId).filter(appId => appId !== input.larkAppId),
        autoEnrollWorkers: true,
      });

  if (project) {
    return { kind: 'enabled', alreadyEnabled, config, project, cardRefresh: 'not_needed' };
  }
  const card = await ensureGuide(input, config, members, deps);
  return { kind: 'enabled', alreadyEnabled, config, project, ...card };
}
