import { createCliAdapterSync } from '../../adapters/cli/registry.js';
import type { CliId } from '../../adapters/cli/types.js';
import { formatLarkError, getBotClient } from '../../bot-registry.js';
import { PASSTHROUGH_COMMANDS } from '../../core/passthrough-commands.js';

export const APP_SLASH_COMMAND_READ_SCOPE = 'application:app_slash_command:read';
export const APP_SLASH_COMMAND_WRITE_SCOPE = 'application:app_slash_command:write';
export const APP_SLASH_COMMAND_SCOPES = [
  APP_SLASH_COMMAND_READ_SCOPE,
  APP_SLASH_COMMAND_WRITE_SCOPE,
] as const;

export const APP_SLASH_COMMANDS_PATH = '/open-apis/application/v7/app_slash_commands';
export const APP_SLASH_COMMAND_LIMIT = 100;

export interface AppSlashCommandDescription {
  default_value: string;
  i18n?: Record<string, string>;
}

export type AppSlashCommandSource = 'botmux' | 'passthrough' | 'adapter' | 'custom';

export interface AppSlashCommandSpec {
  /** Command name without the leading slash, as required by the Lark API. */
  command: string;
  description: AppSlashCommandDescription;
  source: AppSlashCommandSource;
}

export interface RemoteAppSlashCommand {
  command_id: string;
  command: string;
  description?: Partial<AppSlashCommandDescription>;
}

export type AppSlashCommandSyncStatus = 'synced' | 'missing' | 'outdated' | 'unknown';

export interface AppSlashCommandView extends AppSlashCommandSpec {
  status: AppSlashCommandSyncStatus;
  commandId?: string;
}

export interface AppSlashCommandSnapshot {
  commands: AppSlashCommandView[];
  summary: {
    total: number;
    synced: number;
    missing: number;
    outdated: number;
    remoteExtra: number;
  };
}

export interface AppSlashCommandPlan {
  toCreate: AppSlashCommandSpec[];
  toUpdate: Array<{ spec: AppSlashCommandSpec; commandId: string }>;
  unchanged: AppSlashCommandSpec[];
  remoteExtra: RemoteAppSlashCommand[];
}

export interface AppSlashCommandApplyOutcome {
  action: 'create' | 'update';
  command: string;
  ok: boolean;
  code?: number;
  message?: string;
}

export interface AppSlashCommandApplyReport {
  outcomes: AppSlashCommandApplyOutcome[];
  created: number;
  updated: number;
  failed: number;
}

export interface AppSlashCommandSyncResult {
  report: AppSlashCommandApplyReport;
  snapshot: AppSlashCommandSnapshot;
}

interface LarkApiEnvelope {
  code: number;
  msg: string;
  data?: unknown;
  log_id?: string;
}

export type AppSlashCommandRequester = (payload: {
  method: 'GET' | 'POST' | 'PATCH';
  url: string;
  data?: unknown;
}) => Promise<unknown>;

function commandSpec(command: string, zhCn: string, enUs: string): AppSlashCommandSpec {
  return {
    command,
    source: 'botmux',
    description: {
      default_value: zhCn,
      i18n: { zh_cn: zhCn, en_us: enUs },
    },
  };
}

/**
 * App-wide botmux command catalog. Aliases remain explicit because Lark's native
 * slash panel dispatches the selected command text verbatim and users may rely
 * on either spelling. Per-CLI passthrough commands are appended separately by
 * {@link buildAppSlashCommandCatalog}.
 */
export const BOTMUX_APP_SLASH_COMMANDS: readonly AppSlashCommandSpec[] = [
  commandSpec('close', '关闭当前会话', 'Close the current session'),
  commandSpec('restart', '重启当前 CLI 会话', 'Restart the current CLI session'),
  commandSpec('status', '查看当前会话状态', 'Show the current session status'),
  commandSpec('help', '显示 botmux 命令帮助', 'Show botmux command help'),
  commandSpec('cd', '切换当前会话工作目录', 'Change the session working directory'),
  commandSpec('repo', '选择或切换代码仓库', 'Select or switch repository'),
  commandSpec('rename', '重命名当前会话', 'Rename the current session'),
  commandSpec('schedule', '管理定时任务', 'Manage scheduled tasks'),
  commandSpec('role', '查看或管理角色', 'View or manage roles'),
  commandSpec('botconfig', '查看或修改机器人配置', 'View or edit bot configuration'),
  commandSpec('skills', '查看或管理机器人技能', 'View or manage bot skills'),
  commandSpec('pair', '绑定 Dashboard 登录配对码', 'Pair a Dashboard login code'),
  commandSpec('login', '进行飞书用户授权', 'Authorize a Lark user'),
  commandSpec('adopt', '接入已有 CLI 会话', 'Adopt an existing CLI session'),
  commandSpec('detach', '断开已接入的 CLI 会话', 'Detach an adopted CLI session'),
  commandSpec('disconnect', '断开已接入会话（同 /detach）', 'Detach an adopted session (alias of /detach)'),
  commandSpec('oncall', '查看或管理 Oncall 绑定', 'View or manage on-call binding'),
  commandSpec('group', '创建新的会话群', 'Create a new session group'),
  commandSpec('g', '创建新的会话群（同 /group）', 'Create a session group (alias of /group)'),
  commandSpec('relay', '把其它会话接力到当前群', 'Relay another session into this chat'),
  commandSpec('fork', '把当前会话分身到新话题或群', 'Fork the current session to a topic or chat'),
  commandSpec('forklist', '显示当前会话的分身任务', 'Show forked tasks for this session'),
  commandSpec('card', '召唤当前会话流式卡片', 'Show the current streaming card'),
  commandSpec('term', '获取当前会话可操作终端', 'Get the operable terminal for this session'),
  commandSpec('list-slash-command', '列出当前可用 Slash 命令', 'List currently available slash commands'),
  commandSpec('slash', '列出当前可用 Slash 命令', 'List currently available slash commands'),
  commandSpec('subscribe-lark-doc', '订阅飞书文档评论', 'Subscribe to Lark document comments'),
  commandSpec('watch-comment', '管理飞书文档评论监听', 'Manage Lark document comment watches'),
  commandSpec('vc', '管理会议智能体准备任务', 'Manage meeting-agent preparation'),
  commandSpec('vc-auth', '管理会议临时指令授权', 'Manage meeting instruction grants'),
  commandSpec('insight', '查看当前会话洞察摘要', 'Show the current session insight summary'),
  commandSpec('dashboard', '打开飞书 Dashboard 控制卡片', 'Open Dashboard controls in Lark'),
  commandSpec('issue', '打开或管理平台 Issue', 'Open or manage a platform issue'),
  commandSpec('reply-mode', '查看或切换群回复模式', 'View or change chat reply mode'),
  commandSpec('substitute', '查看或切换替身模式', 'View or change substitute mode'),
  commandSpec('grant', '授予群内对话权限', 'Grant chat access'),
  commandSpec('revoke', '撤销群内对话权限', 'Revoke chat access'),
  commandSpec('introduce', '登记群内机器人身份', 'Register bots in the current chat'),
  commandSpec('summary', '总结当前话题或群消息', 'Summarize the current topic or chat'),
  commandSpec('t', '在普通群强制新开话题', 'Start a new topic in a regular chat'),
  commandSpec('topic', '在普通群强制新开话题', 'Start a new topic in a regular chat'),
  commandSpec('workflow', '运行或管理 Workflow', 'Run or manage workflows'),
  commandSpec('template', '查看旧模板命令迁移提示', 'Show the legacy template migration notice'),
  commandSpec('invite', '邀请机器人加入当前群', 'Invite bots into the current chat'),
];

const PASSTHROUGH_DESCRIPTIONS: Record<string, { zh: string; en: string }> = {
  compact: { zh: '压缩底层 CLI 会话上下文', en: 'Compact the underlying CLI context' },
  model: { zh: '切换底层 CLI 模型', en: 'Switch the underlying CLI model' },
  clear: { zh: '清理底层 CLI 会话', en: 'Clear the underlying CLI session' },
  plugin: { zh: '管理底层 CLI 插件', en: 'Manage underlying CLI plugins' },
  usage: { zh: '查看底层 CLI 用量', en: 'Show underlying CLI usage' },
  new: { zh: '开启新的底层 CLI 会话', en: 'Start a new underlying CLI session' },
  context: { zh: '查看底层 CLI 上下文', en: 'Show underlying CLI context' },
  cost: { zh: '查看底层 CLI 成本', en: 'Show underlying CLI cost' },
  mcp: { zh: '查看底层 CLI MCP 状态', en: 'Show underlying CLI MCP status' },
  diff: { zh: '查看底层 CLI 工作区改动', en: 'Show underlying CLI workspace changes' },
  'code-review': { zh: '运行底层 CLI 代码审查', en: 'Run an underlying CLI code review' },
  'security-review': { zh: '运行底层 CLI 安全审查', en: 'Run an underlying CLI security review' },
  review: { zh: '运行底层 CLI 审查', en: 'Run an underlying CLI review' },
  btw: { zh: '向当前 CLI 会话追加旁注', en: 'Add a side note to the current CLI session' },
  effort: { zh: '切换底层 CLI 推理强度', en: 'Change underlying CLI reasoning effort' },
  fast: { zh: '切换 Codex Fast 模式', en: 'Toggle Codex Fast mode' },
};

function dynamicCommandSpec(
  rawCommand: string,
  source: Exclude<AppSlashCommandSource, 'botmux'>,
  cliName: string,
): AppSlashCommandSpec | null {
  const command = rawCommand.replace(/^\/+/, '').trim().toLowerCase();
  // Lark command names are app-wide identifiers. Keep the native panel to the
  // portable subset; CLI-only names containing ':' (for example MCP prompts)
  // remain available through botmux but are not registered remotely.
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(command)) return null;
  const known = PASSTHROUGH_DESCRIPTIONS[command];
  const zh = known?.zh ?? `透传给 ${cliName}`;
  const en = known?.en ?? `Pass through to ${cliName}`;
  return {
    command,
    source,
    description: { default_value: zh, i18n: { zh_cn: zh, en_us: en } },
  };
}

export interface BuildAppSlashCommandCatalogOptions {
  cliId?: string;
  cliPathOverride?: string;
  cliDisplayName?: string;
  customPassthroughCommands?: readonly string[];
}

export function buildAppSlashCommandCatalog(
  options: BuildAppSlashCommandCatalogOptions = {},
): AppSlashCommandSpec[] {
  const cliName = options.cliDisplayName?.trim() || options.cliId?.trim() || 'CLI';
  const candidates: AppSlashCommandSpec[] = [...BOTMUX_APP_SLASH_COMMANDS];

  for (const command of PASSTHROUGH_COMMANDS) {
    const spec = dynamicCommandSpec(command, 'passthrough', cliName);
    if (spec) candidates.push(spec);
  }

  if (options.cliId) {
    try {
      const adapter = createCliAdapterSync(options.cliId as CliId, options.cliPathOverride);
      for (const command of adapter.defaultPassthroughCommands ?? []) {
        const spec = dynamicCommandSpec(command, 'adapter', cliName);
        if (spec) candidates.push(spec);
      }
    } catch {
      // A missing/invalid local CLI must not hide the static botmux catalog.
    }
  }

  for (const command of options.customPassthroughCommands ?? []) {
    const spec = dynamicCommandSpec(command, 'custom', cliName);
    if (spec) candidates.push(spec);
  }

  const byName = new Map<string, AppSlashCommandSpec>();
  for (const candidate of candidates) {
    if (!byName.has(candidate.command)) byName.set(candidate.command, candidate);
    if (byName.size >= APP_SLASH_COMMAND_LIMIT) break;
  }
  return [...byName.values()];
}

function descriptionsEqual(
  local: AppSlashCommandDescription,
  remote: RemoteAppSlashCommand['description'],
): boolean {
  if (!remote || remote.default_value !== local.default_value) return false;
  const remoteI18n = remote.i18n ?? {};
  return Object.entries(local.i18n ?? {}).every(([locale, value]) => remoteI18n[locale] === value);
}

export function diffAppSlashCommands(
  catalog: readonly AppSlashCommandSpec[],
  existing: readonly RemoteAppSlashCommand[],
): AppSlashCommandPlan {
  const remoteByName = new Map(existing.map(command => [command.command, command]));
  const catalogNames = new Set(catalog.map(command => command.command));
  const toCreate: AppSlashCommandSpec[] = [];
  const toUpdate: Array<{ spec: AppSlashCommandSpec; commandId: string }> = [];
  const unchanged: AppSlashCommandSpec[] = [];

  for (const spec of catalog) {
    const remote = remoteByName.get(spec.command);
    if (!remote) {
      toCreate.push(spec);
    } else if (descriptionsEqual(spec.description, remote.description)) {
      unchanged.push(spec);
    } else {
      toUpdate.push({ spec, commandId: remote.command_id });
    }
  }

  return {
    toCreate,
    toUpdate,
    unchanged,
    remoteExtra: existing.filter(command => !catalogNames.has(command.command)),
  };
}

function snapshotFromPlan(
  catalog: readonly AppSlashCommandSpec[],
  existing: readonly RemoteAppSlashCommand[],
  plan: AppSlashCommandPlan,
): AppSlashCommandSnapshot {
  const remoteByName = new Map(existing.map(command => [command.command, command]));
  const missing = new Set(plan.toCreate.map(command => command.command));
  const outdated = new Set(plan.toUpdate.map(({ spec }) => spec.command));
  const commands: AppSlashCommandView[] = catalog.map(spec => {
    const remote = remoteByName.get(spec.command);
    return {
      ...spec,
      status: missing.has(spec.command) ? 'missing' : outdated.has(spec.command) ? 'outdated' : 'synced',
      ...(remote?.command_id ? { commandId: remote.command_id } : {}),
    };
  });
  return {
    commands,
    summary: {
      total: commands.length,
      synced: plan.unchanged.length,
      missing: plan.toCreate.length,
      outdated: plan.toUpdate.length,
      remoteExtra: plan.remoteExtra.length,
    },
  };
}

function toEnvelope(value: unknown): LarkApiEnvelope | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Record<string, any>;
  const body = candidate.response?.data && typeof candidate.response.data === 'object'
    ? candidate.response.data as Record<string, any>
    : candidate;
  if (typeof body.code !== 'number') return null;
  return {
    code: body.code,
    msg: typeof body.msg === 'string' ? body.msg : `Lark API error ${body.code}`,
    ...(body.data !== undefined ? { data: body.data } : {}),
    ...(typeof body.log_id === 'string' ? { log_id: body.log_id } : {}),
  };
}

export class AppSlashCommandApiError extends Error {
  readonly code: number;
  readonly logId?: string;

  constructor(readonly envelope: LarkApiEnvelope) {
    super(envelope.msg || `Lark API error ${envelope.code}`);
    this.name = 'AppSlashCommandApiError';
    this.code = envelope.code;
    this.logId = envelope.log_id;
  }
}

async function call(
  requester: AppSlashCommandRequester,
  payload: Parameters<AppSlashCommandRequester>[0],
): Promise<LarkApiEnvelope> {
  try {
    const result = await requester(payload);
    const envelope = toEnvelope(result);
    if (!envelope) throw new Error('Unexpected Lark slash-command response');
    return envelope;
  } catch (error) {
    const envelope = toEnvelope(error);
    if (envelope) return envelope;
    throw error;
  }
}

function requesterFor(larkAppId: string): AppSlashCommandRequester {
  const client = getBotClient(larkAppId) as any;
  return payload => client.request(payload);
}

export async function listRemoteAppSlashCommands(
  larkAppId: string,
  requester: AppSlashCommandRequester = requesterFor(larkAppId),
): Promise<RemoteAppSlashCommand[]> {
  const envelope = await call(requester, { method: 'GET', url: APP_SLASH_COMMANDS_PATH });
  if (envelope.code !== 0) throw new AppSlashCommandApiError(envelope);
  const items = (envelope.data as { items?: unknown } | undefined)?.items;
  if (!Array.isArray(items)) return [];
  return items.filter((item): item is RemoteAppSlashCommand => {
    if (!item || typeof item !== 'object') return false;
    const command = item as Record<string, unknown>;
    return typeof command.command_id === 'string'
      && typeof command.command === 'string';
  });
}

export async function inspectAppSlashCommands(
  larkAppId: string,
  catalog: readonly AppSlashCommandSpec[],
  requester: AppSlashCommandRequester = requesterFor(larkAppId),
): Promise<AppSlashCommandSnapshot> {
  const existing = await listRemoteAppSlashCommands(larkAppId, requester);
  return snapshotFromPlan(catalog, existing, diffAppSlashCommands(catalog, existing));
}

const ALREADY_EXISTS = /already\s+exists|duplicate|重复|已存在/i;

export async function syncAppSlashCommands(
  larkAppId: string,
  catalog: readonly AppSlashCommandSpec[],
  requester: AppSlashCommandRequester = requesterFor(larkAppId),
): Promise<AppSlashCommandSyncResult> {
  const existing = await listRemoteAppSlashCommands(larkAppId, requester);
  const plan = diffAppSlashCommands(catalog, existing);
  const outcomes: AppSlashCommandApplyOutcome[] = [];
  let remoteIndex: Map<string, string> | null = null;

  const resolveRemoteId = async (command: string): Promise<string | undefined> => {
    if (!remoteIndex) {
      const latest = await listRemoteAppSlashCommands(larkAppId, requester).catch(() => []);
      remoteIndex = new Map(latest.map(item => [item.command, item.command_id]));
    }
    return remoteIndex.get(command);
  };

  for (const spec of plan.toCreate) {
    const envelope = await call(requester, {
      method: 'POST',
      url: APP_SLASH_COMMANDS_PATH,
      data: { command: spec.command, description: spec.description },
    });
    if (envelope.code === 0) {
      outcomes.push({ action: 'create', command: spec.command, ok: true });
      continue;
    }
    if (ALREADY_EXISTS.test(envelope.msg)) {
      const commandId = await resolveRemoteId(spec.command);
      if (commandId) {
        const patched = await call(requester, {
          method: 'PATCH',
          url: `${APP_SLASH_COMMANDS_PATH}/${encodeURIComponent(commandId)}`,
          data: { description: spec.description },
        });
        outcomes.push({
          action: 'update',
          command: spec.command,
          ok: patched.code === 0,
          ...(patched.code !== 0 ? { code: patched.code, message: patched.msg } : {}),
        });
        continue;
      }
    }
    outcomes.push({
      action: 'create',
      command: spec.command,
      ok: false,
      code: envelope.code,
      message: envelope.msg,
    });
  }

  for (const { spec, commandId } of plan.toUpdate) {
    const envelope = await call(requester, {
      method: 'PATCH',
      url: `${APP_SLASH_COMMANDS_PATH}/${encodeURIComponent(commandId)}`,
      data: { description: spec.description },
    });
    outcomes.push({
      action: 'update',
      command: spec.command,
      ok: envelope.code === 0,
      ...(envelope.code !== 0 ? { code: envelope.code, message: envelope.msg } : {}),
    });
  }

  const report: AppSlashCommandApplyReport = {
    outcomes,
    created: outcomes.filter(outcome => outcome.action === 'create' && outcome.ok).length,
    updated: outcomes.filter(outcome => outcome.action === 'update' && outcome.ok).length,
    failed: outcomes.filter(outcome => !outcome.ok).length,
  };
  const snapshot = await inspectAppSlashCommands(larkAppId, catalog, requester);
  return { report, snapshot };
}

export function appSlashCommandErrorMessage(error: unknown): string {
  if (error instanceof AppSlashCommandApiError) {
    return `${error.message} (code: ${error.code}${error.logId ? `, log_id: ${error.logId}` : ''})`;
  }
  return formatLarkError(error) ?? (error instanceof Error ? error.message : String(error));
}

export function unknownAppSlashCommandSnapshot(
  catalog: readonly AppSlashCommandSpec[],
): AppSlashCommandSnapshot {
  return {
    commands: catalog.map(spec => ({ ...spec, status: 'unknown' })),
    summary: { total: catalog.length, synced: 0, missing: 0, outdated: 0, remoteExtra: 0 },
  };
}
