/**
 * 飞书应用级原生 Slash 命令（`/open-apis/application/v7/app_slash_commands`）的
 * 清单推导、远端 diff、逐条同步/删除。只服务 Dashboard 的「飞书原生命令面板」，
 * **不参与**运行时斜杠命令路由（路由判定只在 command-router / command-schema）。
 *
 * 候选清单**只从 `core/command-schema.ts` 的 COMMANDS 推导**（名字/别名/help 键）：
 * - 不手写命令集合；新增/删除命令时清单自动跟随，`test/app-slash-commands.test.ts`
 *   与 doc-sync 守卫兜底。
 * - CLI 透传类命令（PASSTHROUGH_COMMANDS / adapter 默认 / customPassthroughCommands）
 *   **暂不进入候选**：全局透传白名单是 best-effort，不代表具体 CLI × 输入后端真的支持
 *   （见 issue #839）。等透传能力按 CLI × backend 声明落地后再基于那份声明扩展。
 *
 * 所需权限 `application:app_slash_command:{read,write}` 是**可选**的
 * （见 setup/verify-permissions.ts 的 APP_SLASH_COMMAND_FEATURE_SCOPES）：缺失时
 * {@link classifyAppSlashCommandUnavailable} 把错误归为「不可用」，面板降级而不是报错。
 */
import { formatLarkError, getBotClient } from '../../bot-registry.js';
import { COMMANDS, type CommandSpec } from '../../core/command-schema.js';
import { messages as enMessages } from '../../i18n/en.js';
import { messages as zhMessages } from '../../i18n/zh.js';
import type { Locale } from '../../i18n/types.js';
import {
  APP_SLASH_COMMAND_READ_SCOPE,
  APP_SLASH_COMMAND_WRITE_SCOPE,
} from '../../setup/verify-permissions.js';

export { APP_SLASH_COMMAND_READ_SCOPE, APP_SLASH_COMMAND_WRITE_SCOPE };
export const APP_SLASH_COMMAND_SCOPES = [
  APP_SLASH_COMMAND_READ_SCOPE,
  APP_SLASH_COMMAND_WRITE_SCOPE,
] as const;

export const APP_SLASH_COMMANDS_PATH = '/open-apis/application/v7/app_slash_commands';
export const APP_SLASH_COMMAND_LIMIT = 100;
/** 描述截断上限：help 行很长，原生面板只需要一句话。 */
export const APP_SLASH_COMMAND_DESCRIPTION_MAX = 60;

export interface AppSlashCommandDescription {
  default_value: string;
  i18n?: Record<string, string>;
}

export type AppSlashCommandSource = 'botmux' | 'remote';

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

export type AppSlashCommandSyncStatus = 'synced' | 'missing' | 'outdated' | 'unknown' | 'remote-extra';

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
  action: 'create' | 'update' | 'delete';
  command: string;
  ok: boolean;
  code?: number;
  message?: string;
  /**
   * true = 写请求没拿到明确答复（超时、连接重置、5xx…），远端是否已生效未知。
   * 只在 ok:false 时出现；刷新后的快照才是远端真实状态。服务端明确的 4xx 拒绝
   * 不算 uncertain。
   */
  uncertain?: boolean;
  /** 写请求被拒且响应不是飞书业务信封时的 HTTP 状态（如裸 403/404）。 */
  httpStatus?: number;
}

export interface AppSlashCommandApplyReport {
  outcomes: AppSlashCommandApplyOutcome[];
  created: number;
  updated: number;
  deleted: number;
  failed: number;
}

export interface AppSlashCommandSyncResult {
  report: AppSlashCommandApplyReport;
  snapshot: AppSlashCommandSnapshot;
  /**
   * 写操作完成后重新读取远端清单失败时的错误说明。此时 `report` 仍是已确认的
   * 写结果，`snapshot` 退化为 unknown —— 是「清单没刷新出来」，不是写失败。
   */
  refreshError?: string;
}

interface LarkApiEnvelope {
  code: number;
  msg: string;
  data?: unknown;
  log_id?: string;
  /** SDK 拒绝对象同时带 HTTP 状态与飞书信封时的 HTTP 状态（如 404/5xx）。 */
  httpStatus?: number;
}

export type AppSlashCommandRequester = (payload: {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  url: string;
  data?: unknown;
}) => Promise<unknown>;

// ─── Catalog: derived from command-schema ─────────────────────────────────

const HELP_DICTIONARIES: Record<Locale, Record<string, string>> = { zh: zhMessages, en: enMessages };
/** help 行里 `{cliName}` 等占位符：应用级清单不随 Bot 当前 CLI 变化，统一用中性词。 */
const PLACEHOLDER_FALLBACK: Record<string, string> = { cliName: 'CLI' };

/**
 * 把一条 `/help` 行压成一句话说明：取 `<用法> - <说明>` 的说明部分，去掉括注，截到第一个
 * 强分句标点（`；。` / `; . —`），替换占位符；仍超长时中文在最后一个逗号处收尾、英文在
 * 词边界截断加省略号。返回 null = 无法提取。
 */
export function summarizeHelpLine(line: string | undefined): string | null {
  if (!line) return null;
  const match = /^.*?\s[-—]\s+(.+)$/s.exec(line);
  let text = (match ? match[1]! : line).trim();
  text = text.replace(/\{(\w+)\}/g, (_, key: string) => PLACEHOLDER_FALLBACK[key] ?? '');
  text = text.replace(/`/g, '');
  // 括注是补充说明（「（保留 session）」「(write-enabled)」），原生面板里一律去掉。
  text = text.replace(/（[^（）]*）/g, '').replace(/\s*\([^()]*\)/g, '');
  // `：/cot off …` 这类冒号后紧跟子命令清单的，也在冒号处收尾。
  const cut = text.search(/[；。]|;|\.\s|\s—\s|[:：]\s*\//);
  if (cut > 0) text = text.slice(0, cut);
  text = text.replace(/\s+/g, ' ').trim();
  if (!text) return null;
  const max = APP_SLASH_COMMAND_DESCRIPTION_MAX;
  if (text.length > max) {
    const head = text.slice(0, max - 1);
    const zhComma = head.lastIndexOf('，');
    const space = head.lastIndexOf(' ');
    if (zhComma >= 8) text = head.slice(0, zhComma);
    else if (space >= 8) text = `${head.slice(0, space).replace(/[,;:]$/, '')}…`;
    else text = `${head}…`;
  }
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function describeSpec(spec: CommandSpec, locale: Locale): string | null {
  const key = spec.help[0];
  return key ? summarizeHelpLine(HELP_DICTIONARIES[locale][key]) : null;
}

/** Lark 命令名：小写字母数字开头，只含 `[a-z0-9_-]`（不支持 `:`）。 */
const LARK_COMMAND_NAME = /^[a-z0-9][a-z0-9_-]*$/;

export interface BuildAppSlashCommandCatalogOptions {
  /** 当前 Bot 的 CLI；只用于纳入 `cliId` 限定的 daemon 命令（如 codex-app 的 /effort）。 */
  cliId?: string;
  /** `default_value` 用哪种语言；`i18n` 总是同时给中英文。 */
  locale?: Locale;
}

/**
 * 从 command-schema 推导应用级候选清单：
 * - 只收 botmux 自有命令（COMMANDS）及其别名；`cliId` 限定项仅在 Bot 的 CLI 匹配时收；
 * - 与 `DAEMON_COMMANDS`（= GLOBAL_COMMANDS）口径一致，排除 `claimWithoutSessionOnly`
 *   的元命令（如 `/resume`：仅无会话时回收已关闭会话，有会话时透传给 CLI 自带的
 *   `/resume`——属 #839 的 CLI × 后端透传能力，不进应用级面板）；
 * - `help` 为空的隐藏命令（如 `/cli`）不收——`/help` 都不展示的不该进原生面板；
 * - 命令名不符合 Lark 命名规则的跳过。
 */
export function buildAppSlashCommandCatalog(
  options: BuildAppSlashCommandCatalogOptions = {},
): AppSlashCommandSpec[] {
  const locale: Locale = options.locale ?? 'zh';
  const byName = new Map<string, AppSlashCommandSpec>();
  for (const spec of COMMANDS) {
    if (spec.cliId && spec.cliId !== options.cliId) continue;
    if (spec.claimWithoutSessionOnly) continue;
    const zh = describeSpec(spec, 'zh');
    const en = describeSpec(spec, 'en');
    if (!zh || !en) continue;
    const primary = spec.name.replace(/^\/+/, '');
    const names = [spec.name, ...(spec.aliases ?? [])];
    for (const raw of names) {
      const command = raw.replace(/^\/+/, '').toLowerCase();
      if (!LARK_COMMAND_NAME.test(command) || byName.has(command)) continue;
      const isAlias = command !== primary;
      const zhText = isAlias ? `${zh}（同 /${primary}）` : zh;
      const enText = isAlias ? `${en} (alias of /${primary})` : en;
      byName.set(command, {
        command,
        source: 'botmux',
        description: {
          default_value: locale === 'en' ? enText : zhText,
          i18n: { zh_cn: zhText, en_us: enText },
        },
      });
      if (byName.size >= APP_SLASH_COMMAND_LIMIT) return [...byName.values()];
    }
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
  const catalogCommands: AppSlashCommandView[] = catalog.map(spec => {
    const remote = remoteByName.get(spec.command);
    return {
      ...spec,
      status: missing.has(spec.command) ? 'missing' : outdated.has(spec.command) ? 'outdated' : 'synced',
      ...(remote?.command_id ? { commandId: remote.command_id } : {}),
    };
  });
  const remoteCommands: AppSlashCommandView[] = plan.remoteExtra.map(remote => ({
    command: remote.command,
    source: 'remote',
    description: {
      default_value: remote.description?.default_value?.trim() || '飞书后台已有命令',
      ...(remote.description?.i18n ? { i18n: remote.description.i18n } : {}),
    },
    status: 'remote-extra',
    commandId: remote.command_id,
  }));
  return {
    commands: [...catalogCommands, ...remoteCommands],
    summary: {
      total: catalogCommands.length,
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
    ...(typeof candidate.response?.status === 'number' ? { httpStatus: candidate.response.status } : {}),
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

/**
 * 写操作边界：把飞书业务错误与「请求本身抛异常」都折成一条逐条结果，绝不让一条
 * 命令的超时/连接重置中止整批、丢掉已成功的变更。抛异常的那条标 `uncertain`。
 */
async function writeOutcome(
  requester: AppSlashCommandRequester,
  payload: Parameters<AppSlashCommandRequester>[0],
  action: AppSlashCommandApplyOutcome['action'],
  command: string,
): Promise<{ outcome: AppSlashCommandApplyOutcome; envelope?: LarkApiEnvelope }> {
  let envelope: LarkApiEnvelope;
  try {
    envelope = await call(requester, payload);
  } catch (error) {
    const httpStatus = httpStatusOf(error);
    // 服务端给了明确的 4xx：请求被拒、没有生效；无响应或 5xx 才是真正「结果未确认」。
    const definiteRejection = httpStatus !== undefined && httpStatus >= 400 && httpStatus < 500;
    return {
      outcome: {
        action,
        command,
        ok: false,
        ...(definiteRejection ? {} : { uncertain: true }),
        ...(httpStatus !== undefined ? { httpStatus } : {}),
        message: formatLarkError(error) ?? (error instanceof Error ? error.message : String(error)),
      },
    };
  }
  return {
    envelope,
    outcome: {
      action,
      command,
      ok: envelope.code === 0,
      ...(envelope.code !== 0 ? { code: envelope.code, message: envelope.msg } : {}),
      // 带信封的 5xx 仍是「结果未确认」；带信封的 4xx 保留状态供归类（如 404 → not_enabled）。
      ...(envelope.code !== 0 && envelope.httpStatus !== undefined ? { httpStatus: envelope.httpStatus } : {}),
      ...(envelope.code !== 0 && envelope.httpStatus !== undefined && envelope.httpStatus >= 500 ? { uncertain: true } : {}),
    },
  };
}

function httpStatusOf(error: unknown): number | undefined {
  const status = (error as { response?: { status?: unknown } } | null)?.response?.status;
  return typeof status === 'number' ? status : undefined;
}

/**
 * PATCH 用的描述：botmux 只管理 default_value 与本地给出的语言（zh_cn/en_us）；
 * 远端人工补的其它语言（如 ja_jp）原样保留——与 {@link descriptionsEqual} 的
 * 「额外语言不归 botmux 管」口径一致，否则每次同步都会把它们抹掉。
 */
function mergedDescription(
  local: AppSlashCommandDescription,
  remote: RemoteAppSlashCommand['description'] | undefined,
): AppSlashCommandDescription {
  const i18n = { ...(remote?.i18n ?? {}), ...(local.i18n ?? {}) };
  return {
    default_value: local.default_value,
    ...(Object.keys(i18n).length ? { i18n } : {}),
  };
}

/** 写完之后刷新远端清单；失败时保留写报告，把刷新错误单独暴露。 */
async function finishWithSnapshot(
  larkAppId: string,
  outcomes: AppSlashCommandApplyOutcome[],
  catalog: readonly AppSlashCommandSpec[],
  requester: AppSlashCommandRequester,
): Promise<AppSlashCommandSyncResult> {
  const report = reportFromOutcomes(outcomes);
  try {
    return { report, snapshot: await inspectAppSlashCommands(larkAppId, catalog, requester) };
  } catch (error) {
    return {
      report,
      snapshot: unknownAppSlashCommandSnapshot(catalog),
      refreshError: appSlashCommandErrorMessage(error),
    };
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

function reportFromOutcomes(outcomes: AppSlashCommandApplyOutcome[]): AppSlashCommandApplyReport {
  return {
    outcomes,
    created: outcomes.filter(outcome => outcome.action === 'create' && outcome.ok).length,
    updated: outcomes.filter(outcome => outcome.action === 'update' && outcome.ok).length,
    deleted: outcomes.filter(outcome => outcome.action === 'delete' && outcome.ok).length,
    failed: outcomes.filter(outcome => !outcome.ok).length,
  };
}

async function syncSelectedAppSlashCommands(
  larkAppId: string,
  selected: readonly AppSlashCommandSpec[],
  snapshotCatalog: readonly AppSlashCommandSpec[],
  requester: AppSlashCommandRequester = requesterFor(larkAppId),
): Promise<AppSlashCommandSyncResult> {
  const existing = await listRemoteAppSlashCommands(larkAppId, requester);
  const plan = diffAppSlashCommands(selected, existing);
  const outcomes: AppSlashCommandApplyOutcome[] = [];
  const existingByName = new Map(existing.map(item => [item.command, item]));
  let remoteIndex: Map<string, RemoteAppSlashCommand> | null = null;

  const resolveRemote = async (command: string): Promise<RemoteAppSlashCommand | undefined> => {
    if (!remoteIndex) {
      const latest = await listRemoteAppSlashCommands(larkAppId, requester).catch(() => []);
      remoteIndex = new Map(latest.map(item => [item.command, item]));
    }
    return remoteIndex.get(command);
  };

  for (const spec of plan.toCreate) {
    const created = await writeOutcome(requester, {
      method: 'POST',
      url: APP_SLASH_COMMANDS_PATH,
      data: { command: spec.command, description: spec.description },
    }, 'create', spec.command);
    if (created.envelope && created.envelope.code !== 0 && ALREADY_EXISTS.test(created.envelope.msg)) {
      const remote = await resolveRemote(spec.command);
      if (remote) {
        const patched = await writeOutcome(requester, {
          method: 'PATCH',
          url: `${APP_SLASH_COMMANDS_PATH}/${encodeURIComponent(remote.command_id)}`,
          data: { description: mergedDescription(spec.description, remote.description) },
        }, 'update', spec.command);
        outcomes.push(patched.outcome);
        continue;
      }
    }
    outcomes.push(created.outcome);
  }

  for (const { spec, commandId } of plan.toUpdate) {
    const patched = await writeOutcome(requester, {
      method: 'PATCH',
      url: `${APP_SLASH_COMMANDS_PATH}/${encodeURIComponent(commandId)}`,
      data: { description: mergedDescription(spec.description, existingByName.get(spec.command)?.description) },
    }, 'update', spec.command);
    outcomes.push(patched.outcome);
  }

  return finishWithSnapshot(larkAppId, outcomes, snapshotCatalog, requester);
}

export async function syncAppSlashCommands(
  larkAppId: string,
  catalog: readonly AppSlashCommandSpec[],
  requester: AppSlashCommandRequester = requesterFor(larkAppId),
): Promise<AppSlashCommandSyncResult> {
  return syncSelectedAppSlashCommands(larkAppId, catalog, catalog, requester);
}

function normalizedSelection(command: string): string | null {
  const normalized = command.trim().replace(/^\/+/, '').toLowerCase();
  return /^[a-z0-9][a-z0-9_-]*$/.test(normalized) ? normalized : null;
}

export async function syncAppSlashCommand(
  larkAppId: string,
  catalog: readonly AppSlashCommandSpec[],
  command: string,
  requester: AppSlashCommandRequester = requesterFor(larkAppId),
): Promise<AppSlashCommandSyncResult> {
  const normalized = normalizedSelection(command);
  const spec = normalized ? catalog.find(candidate => candidate.command === normalized) : undefined;
  if (!spec) throw new Error('slash_command_not_in_catalog');
  return syncSelectedAppSlashCommands(larkAppId, [spec], catalog, requester);
}

export async function deleteAppSlashCommand(
  larkAppId: string,
  catalog: readonly AppSlashCommandSpec[],
  command: string,
  requester: AppSlashCommandRequester = requesterFor(larkAppId),
): Promise<AppSlashCommandSyncResult> {
  // 删除按远端**原始名称**解析（保留大小写）：远端可能有人工建的 `HELP`，小写化后
  // 精确匹配会找不到它。
  const name = command.trim().replace(/^\/+/, '');
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(name)) throw new Error('invalid_slash_command');
  const existing = await listRemoteAppSlashCommands(larkAppId, requester);
  const remote = existing.find(candidate => candidate.command === name);
  const outcomes: AppSlashCommandApplyOutcome[] = [];
  if (remote) {
    const deleted = await writeOutcome(requester, {
      method: 'DELETE',
      url: `${APP_SLASH_COMMANDS_PATH}/${encodeURIComponent(remote.command_id)}`,
    }, 'delete', remote.command);
    outcomes.push(deleted.outcome);
  } else {
    // 没有可删的目标必须报失败：否则不发 DELETE 却 failed:0，面板会显示「已删除」。
    outcomes.push({ action: 'delete', command: name, ok: false, message: 'slash_command_not_found' });
  }
  return finishWithSnapshot(larkAppId, outcomes, catalog, requester);
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

// ─── Optional-scope degradation ───────────────────────────────────────────

/**
 * 应用身份缺 scope（99991672）/ 用户身份缺 scope（99991679）/ v7 Slash 命令接口
 * 缺权限时返回的 99991640（msg: "lacks permission"）。
 */
const SCOPE_DENIED_CODES = new Set([99991640, 99991672, 99991679]);
/**
 * 兜底识别非标准错误码的同类拒绝：只认明确的权限拒绝措辞，或**完整** scope 标识。
 * 刻意不匹配裸资源名 `app_slash_command`——「invalid app_slash_command parameter」
 * 「app_slash_command already exists」「app_slash_command count exceeds limit」这类
 * 参数/重复/上限错误都会带它，误判成缺权限会把真实故障藏进「暂不可用」。
 */
const SCOPE_DENIED_TEXT = new RegExp([
  String.raw`\bpermission\s+denied\b`,
  String.raw`\blacks?\s+(?:the\s+)?permissions?\b`,
  String.raw`\bno\s+permissions?\b`,
  String.raw`\binsufficient\s+permissions?\b`,
  String.raw`\baccess\s+denied\b`,
  String.raw`\bapplication:app_slash_command:(?:read|write)\b`,
  '权限不足',
  '无权限',
].join('|'), 'i');

/**
 * - `missing_scope`：缺可选 scope；
 * - `not_enabled`：租户未进飞书灰度 / OpenAPI 不存在；
 * - `core_only`：Bot 是 core-only（apiOnly），没有任何飞书连接，由 IPC 层在解析 client 前判定。
 */
export type AppSlashCommandUnavailableReason = 'missing_scope' | 'not_enabled' | 'core_only';

export interface AppSlashCommandUnavailable {
  reason: AppSlashCommandUnavailableReason;
  /** 需开通的可选 scope；`not_enabled`（租户未进灰度）时为空。 */
  missingScopes: string[];
}

function isScopeDenied(code: number | undefined, message: string | undefined): boolean {
  if (code === undefined || code === 0) return false;
  return SCOPE_DENIED_CODES.has(code) || (!!message && SCOPE_DENIED_TEXT.test(message));
}

/**
 * 把读取/写入远端清单时的错误归为「功能不可用」（而非故障）：
 * - 缺 `application:app_slash_command:*` → `missing_scope`（附需开通的 scope）；
 * - 接口 404（租户未进灰度、OpenAPI 不存在）→ `not_enabled`。
 * 其它错误（网络、5xx、未知业务码）返回 null，由调用方按普通错误展示。
 *
 * `op` 决定缺哪个 scope：读清单只需 read；新增/更新/删除需要 write。
 */
export function classifyAppSlashCommandUnavailable(
  error: unknown,
  op: 'read' | 'write' = 'read',
): AppSlashCommandUnavailable | null {
  const scopeFor = op === 'read' ? APP_SLASH_COMMAND_READ_SCOPE : APP_SLASH_COMMAND_WRITE_SCOPE;
  if (error instanceof AppSlashCommandApiError) {
    if (isScopeDenied(error.code, error.message)) return { reason: 'missing_scope', missingScopes: [scopeFor] };
    if (error.code === 404) return { reason: 'not_enabled', missingScopes: [] };
    return classifyHttpStatus(error.envelope.httpStatus, scopeFor);
  }
  return classifyHttpStatus(httpStatusOf(error), scopeFor);
}

/** 不带飞书业务信封的裸 HTTP 拒绝：读写两侧共用同一口径。 */
function classifyHttpStatus(status: number | undefined, scopeFor: string): AppSlashCommandUnavailable | null {
  if (status === 404) return { reason: 'not_enabled', missingScopes: [] };
  if (status === 401 || status === 403) return { reason: 'missing_scope', missingScopes: [scopeFor] };
  return null;
}

/**
 * 写操作的逐条结果归类：飞书缺 write scope 的业务码/措辞、或裸 HTTP 401/403 →
 * missing_scope；裸 HTTP 404 → not_enabled。缺权限优先（更可操作）。
 */
export function classifyAppSlashCommandReport(
  report: AppSlashCommandApplyReport,
): AppSlashCommandUnavailable | null {
  const failed = report.outcomes.filter(outcome => !outcome.ok);
  const verdicts = failed.map(outcome => (
    isScopeDenied(outcome.code, outcome.message)
      ? { reason: 'missing_scope' as const, missingScopes: [APP_SLASH_COMMAND_WRITE_SCOPE] }
      : classifyHttpStatus(outcome.httpStatus, APP_SLASH_COMMAND_WRITE_SCOPE)
  )).filter((verdict): verdict is AppSlashCommandUnavailable => verdict !== null);
  return verdicts.find(verdict => verdict.reason === 'missing_scope') ?? verdicts[0] ?? null;
}
