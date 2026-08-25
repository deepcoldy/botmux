import type { CliId } from '../adapters/cli/types.js';
import {
  normalizeCliRuntimeConfig,
  type CliRuntimeConfig,
} from '../adapters/cli/runtime.js';
import { sanitizePerBotEnv } from '../core/per-bot-env.js';

export const CLI_ID_CHOICES: Record<string, CliId> = {
  '1': 'claude-code',
  '2': 'aiden',
  '3': 'coco',
  '4': 'codex',
  '5': 'cursor',
  '6': 'gemini',
  '7': 'opencode',
  '8': 'antigravity',
  '9': 'mtr',
  '10': 'hermes',
  '11': 'codex-app',
  '12': 'mira',
  '13': 'seed',
  '14': 'traex',
  '15': 'pi',
  '16': 'copilot',
  '17': 'oh-my-pi',
  '18': 'relay',
  '19': 'mir',
  '20': 'kimi',
  // 新增 CLI 一律追加到尾部：序号是脚本化 setup（非 TTY 管道喂数字）的稳定接口，
  // 插位会让老脚本静默选错 CLI。
  '21': 'genius',
  '22': 'grok',
  '23': 'kiro-cli',
  '24': 'riff',
  '25': 'reasonix',
  '26': 'opencode2',
  // 新增 CLI 一律追加到尾部：序号是脚本化 setup（非 TTY 管道喂数字）的稳定接口，
  // 插位会让老脚本静默选错 CLI。
  '27': 'dsh',
  // 上游 #858 先占用了 27（dsh），mojo 顺延到 28：序号是脚本化 setup 的稳定
  // 接口，插位会让老脚本静默选错 CLI（见本表顶部约定）。mojo 已三次让位
  // （25→reasonix、26→opencode2、27→dsh）。
  '28': 'mojo',
};

const VALID_CLI_IDS: ReadonlySet<string> = new Set(Object.values(CLI_ID_CHOICES));

/**
 * CLI 展示名. 与 worker.ts 的 CLI_DISPLAY_NAMES / card-builder.ts 的
 * cliDisplayNames 保持一致——这三处是已知的展示名复制点 (见 CLAUDE.md
 * "添加新 CLI 适配器" 清单), 新增 CLI 时一并更新.
 */
const CLI_DISPLAY_LABELS: Record<CliId, string> = {
  'claude-code': 'Claude',
  'aiden': 'Aiden',
  'coco': 'CoCo',
  'codex': 'Codex',
  'cursor': 'Cursor',
  'gemini': 'Gemini',
  'genius': 'Genius',
  'opencode': 'OpenCode',
  'opencode2': 'OpenCode 2',
  'antigravity': 'Antigravity',
  'mtr': 'MTR',
  'hermes': 'Hermes',
  'codex-app': 'Codex App',
  'mira': 'Mira',
  'seed': 'Seed',
  'traex': 'TRAE',
  'pi': 'Pi',
  'copilot': 'Copilot',
  'oh-my-pi': 'Oh My Pi',
  'relay': 'Relay',
  'mir': 'Mir CLI',
  'kimi': 'Kimi',
  'grok': 'Grok Build',
  'kiro-cli': 'Kiro',
  'riff': 'Riff',
  'reasonix': 'Reasonix',
  'dsh': 'DeepSeek Harness',
  'dsh-tui': 'DeepSeek Harness TUI',
  'mojo': 'Mojo',
};

/**
 * 有序 CLI 选项 (id + 展示名), 顺序与 setup 交互菜单 (CLI_ID_CHOICES 序号)
 * 一致. dashboard "添加机器人" 的 CLI 下拉直接读这里, 避免再抄一份
 * 列表. 单一事实源: CLI_ID_CHOICES 的值序.
 */
export const CLI_OPTIONS: ReadonlyArray<{ id: CliId; label: string }> =
  Object.values(CLI_ID_CHOICES).map(id => ({ id, label: CLI_DISPLAY_LABELS[id] ?? id }));

/**
 * 把 setup 里"CLI 适配器"那一格的原始输入解析成合法的 CliId.
 *   - 空 → undefined (调用方决定 "preserve current" 还是套默认 'claude-code')
 *   - 序号 (CLI_ID_CHOICES 的键) → 映射成 cliId
 *   - 已是合法 cliId 字面值 → 原样返回
 *   - 其它 → throw (typo 不该静默落盘成 cliId)
 */
export function resolveCliId(input: string | undefined): CliId | undefined {
  const raw = trimmed(input);
  if (!raw) return undefined;
  const mapped = CLI_ID_CHOICES[raw];
  if (mapped) return mapped;
  if (VALID_CLI_IDS.has(raw)) return raw as CliId;
  // 序号上界从 CLI_ID_CHOICES 派生, 新增 CLI 时自动跟随, 不再手写硬编码区间.
  const maxChoice = Object.keys(CLI_ID_CHOICES).length;
  throw new Error(
    `Unknown CLI 适配器 "${raw}"。请输入序号 1-${maxChoice} 或合法 ID 之一: ${[...VALID_CLI_IDS].join(', ')}`,
  );
}

/** 完整邮箱（含 @ 和域名）。用于区分"完整邮箱"与"邮箱前缀"——后者解析时会被静默丢弃。 */
const FULL_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * 手机号 allowedUsers 条目。飞书 batch_get_id 的 `mobiles` 字段：中国大陆号
 * 可直接填 11 位（无需 +86）；非大陆号必须带 `+` 国家/地区码。为避免把邮箱
 * 前缀/随手输入误判成手机号，规则收紧为二选一：
 *   - `+` 开头的 E.164：`+` 后跟 6–15 位数字（E.164 规范上限 15 位，如
 *     +14155550123、+8613011112222、+123456789012345）
 *   - 纯 11 位大陆号，以 1 开头（如 13011112222）
 * 允许中间出现空格/连字符，判定前先归一化掉。
 */
const MOBILE_RE = /^(?:\+\d{6,15}|1\d{10})$/;

/** 去掉手机号里的空格与连字符（用户可能填 "+86 130-1111-2222"），便于校验/解析。 */
export function normalizeMobileEntry(entry: string): string {
  return entry.trim().replace(/[\s-]/g, '');
}

/** 是否是手机号形式的 allowedUsers 条目（已归一化空格/连字符后判定）。 */
export function isMobileEntry(entry: string): boolean {
  return MOBILE_RE.test(normalizeMobileEntry(entry));
}

/**
 * 手机号规范化匹配键：把一个已归一化的手机号折叠成**唯一**的 E.164 数字键，用于
 * 把飞书 `batch_get_id` 响应里回带的号码对回本地请求的号码。请求侧和响应侧都过
 * 本函数，键相等即同一号码。
 *
 * 规则（**不能像早期实现那样无脑剥 `+` 再一律当中国裸号**——那会让美国 `+1 3XX…`
 * 与中国裸号 `13X…` 折叠成同键，把 owner 绑到错的人 / 顶掉另一个 owner）：
 *   - `+` 开头：`+` 是权威国家码，直接剥掉 `+` 得到「国家码+号码」的 E.164 数字串
 *     （`+8613011112222`→`8613011112222`，`+14155550123`→`14155550123`）。
 *   - 无 `+` 的纯 11 位、以 1 开头：按配置契约（MOBILE_RE：裸号只接受中国 11 位）
 *     判定为中国大陆号，补 `86`（`13011112222`→`8613011112222`），从而与带 `+86`
 *     的请求/响应对齐。
 *   - 其它（已带 `86` 前缀等）：原样。
 *
 * 安全取舍：若飞书对海外号回带时**丢掉了 `+`**，海外裸号会被误判成中国号而与请求
 * 不等 → 判 definitive miss（owner 用邮箱/union_id 兜底），这是 fail-closed 的**漏配**；
 * 绝不会把两个不同的人折叠成同一 owner（那才是危险的错配）。宁可漏配不可错配。
 */
export function canonicalMobileKey(normalized: string): string {
  if (normalized.startsWith('+')) return normalized.slice(1);
  if (/^1\d{10}$/.test(normalized)) return '86' + normalized; // 中国大陆裸号 → 补国家码
  return normalized;
}

/**
 * 单个 allowedUsers 条目是否需要「启动/刷新时经飞书 contact API 解析成本 app
 * 的 open_id」。运行时权限（canTalk/canOperate）只认原生 ou_，故 email / union_id
 * (on_) / 手机号 / 甚至字面 ou_（要做跨 app 诊断）都要走一次解析；只有无法寻址
 * 的裸串（邮箱前缀等）不需要。
 *
 * 这是解析闸的**唯一真源**——daemon 启动闸、throw 兜底、allowed-users-apply 的
 * needsContactResolve 全都调它，避免「新增一种身份格式后各处平行谓词漏改」导致
 * 该格式在入口校验通过、却在某个解析闸被静默跳过（手机号 owner 冷启动自锁即
 * 此类 bug）。新增身份格式时**只改这里**。
 */
export function entryNeedsContactResolve(entry: string): boolean {
  return entry.includes('@') || entry.startsWith('on_') || entry.startsWith('ou_') || isMobileEntry(entry);
}

/**
 * 合法的 allowedUsers 条目：
 *   - on_xxx  union_id  — 跨应用稳定，推荐
 *   - 完整邮箱          — 人类可读，推荐
 *   - 手机号            — 大陆号直填 11 位；海外号带 + 区号。适合无企业邮箱的个人用户
 *   - ou_xxx  open_id   — 仅对签发该 ID 的同一应用有效，不推荐跨 bot 复用
 * 裸邮箱前缀（如 "alice"）不合法：解析器只认 ou_/on_、完整邮箱或手机号。
 */
export function isValidAllowedUserEntry(entry: string): boolean {
  const s = entry.trim();
  return s.startsWith('ou_') || s.startsWith('on_') || FULL_EMAIL_RE.test(s) || isMobileEntry(s);
}

/** 返回非法的 allowedUsers 条目（既不是 ou_ 也不是完整邮箱，典型是裸邮箱前缀）。 */
export function findInvalidAllowedUserEntries(entries: string[]): string[] {
  return entries.map(e => e.trim()).filter(e => e && !isValidAllowedUserEntry(e));
}

/**
 * 是否存在能解析成 owner 的 allowedUsers 条目（ou_ 或完整邮箱）。
 * owner = resolvedAllowedUsers 里第一个 ou_；完整邮箱会在启动时解析成 ou_，故二者都可作 owner。
 */
export function hasOwnerEntry(allowedUsers: string[] | undefined): boolean {
  return !!allowedUsers?.some(isValidAllowedUserEntry);
}

export interface BotConfigEditInput {
  name?: string;
  larkAppId?: string;
  larkAppSecret?: string;
  cliChoice?: string;
  cliPathOverride?: string;
  /**
   * Structured compatible-runtime edit. Three states:
   *   - undefined -> preserve current value
   *   - object    -> validate/set it and write an equal legacy path shadow
   *   - null      -> clear it and its equal legacy path shadow
   */
  cliRuntime?: CliRuntimeConfig | null;
  /**
   * 通用启动前缀（如 "aiden x claude"）。三态：
   *   - undefined → 不动
   *   - string    → 设置（空串 / "-" 视为清空）
   *   - null      → 清空（选了普通 CLI 时清掉旧的 aiden×* 前缀）
   * 调用方（setup picker / dashboard）用 resolveCliSelection 解析选择项后传入，
   * 避免 bot-config-editor 反向依赖 cli-selection（会成循环 import）。
   */
  wrapperCli?: string | null;
  /**
   * Model 字段三态语义（setup 不再交互式询问 model，此字段仅由切换 CLI 时的
   * 强制清空逻辑设 null；改 model 走 /config 卡片或手动编辑 bots.json）：
   *   - undefined → 这次编辑不动 model，保持原值
   *   - string    → 设为这个 model
   *   - null      → 清空（删字段，回到 CLI 默认）
   */
  model?: string | null;
  backendType?: string;
  workingDir?: string;
  /**
   * 固定默认目录：新话题直接在此目录启动、不弹仓库选择卡片（与 /config 的
   * defaultWorkingDir 同字段）。与 workingDir（仓库选择卡片的扫描根）互补：
   * 留空不动；输入 - 清空、回到弹卡模式。目录存在性由调用方在写盘前校验。
   */
  defaultWorkingDir?: string;
  allowedUsers?: string;
  allowedChatGroups?: string;
  /**
   * 平台团队页是否展示这个 bot（默认 ON）。三态字符串：
   *   - undefined → 不动
   *   - 'true' / 'false' → 设置（'true' 落盘为删字段=默认 ON；'false' 落盘 false）
   *   - '' / '-' → 清空（回到默认 ON）
   */
  showInTeam?: string;
}

/**
 * 校验：配置了 allowedChatGroups 就必须有 owner。
 * 否则群成员只拿到 canTalk，没人在 allowedUsers 里 → canOperate 对所有人关闭（连 owner 都没有），
 * /restart、/close、获取写链接、/grant 等敏感操作全不可用。setup 写盘前调用，抛错由调用方捕获中止写盘。
 */
export function assertOwnerWhenChatGroups(
  config: { allowedUsers?: string[]; allowedChatGroups?: string[] },
): void {
  if ((config.allowedChatGroups?.length ?? 0) > 0 && !hasOwnerEntry(config.allowedUsers)) {
    throw new Error(
      '配置了 allowedChatGroups 时必须同时在 allowedUsers 配置至少一个 owner（完整邮箱、union_id on_xxx 或 open_id ou_xxx），' +
      '否则群成员能对话但没人能执行 /restart、/close 等敏感操作，/grant 也不可用。',
    );
  }
}

export interface RemoveBotConfigResult<T> {
  bots: T[];
  removed: T;
  index: number;
}

function trimmed(v: string | undefined): string | undefined {
  if (v === undefined) return undefined;
  const s = v.trim();
  return s ? s : undefined;
}

export function normalizeBotProcessName(input: string | undefined): string | undefined {
  const raw = trimmed(input);
  if (!raw) return undefined;
  const slug = raw
    .replace(/^botmux-/i, '')
    .replace(/[^\p{L}\p{N}_.-]+/gu, '-')
    .replace(/-+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '');
  return slug || undefined;
}

export function botProcessName(
  bot: { name?: unknown },
  index: number,
  prefix = 'botmux',
): string {
  const name = typeof bot.name === 'string' ? normalizeBotProcessName(bot.name) : undefined;
  return `${prefix}-${name ?? index}`;
}

/**
 * Sanitize a bot entry's `env` object into a clean `KEY -> string` map (valid
 * env-var names + string/number/boolean values; botmux-reserved keys dropped).
 * Thin wrapper over {@link sanitizePerBotEnv} for callers that hold a bot entry.
 */
export function botProcessEnv(bot: { env?: unknown }): Record<string, string> {
  return sanitizePerBotEnv(bot?.env);
}

export function normalizeBotConfig<T extends Record<string, any>>(bot: T): T {
  const out: Record<string, any> = { ...bot };
  if (typeof out.name !== 'string') return out as T;

  const name = normalizeBotProcessName(out.name);
  if (name) out.name = name;
  else delete out.name;
  return out as T;
}

export function parseBotConfigsJson<T extends Record<string, any> = Record<string, any>>(
  content: string,
  filePath = 'bots.json',
): T[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err: any) {
    throw new Error(`Failed to parse ${filePath}: ${err?.message ?? String(err)}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error(`${filePath} must contain a JSON array of bot configs.`);
  }
  return parsed as T[];
}

export function assertUniqueBotProcessNames(
  bots: Array<{ name?: unknown }>,
  prefix = 'botmux',
): void {
  const seen = new Map<string, number>();
  const reserved = new Set([`${prefix}-dashboard`]);
  for (let i = 0; i < bots.length; i++) {
    const name = botProcessName(bots[i], i, prefix);
    if (reserved.has(name)) {
      throw new Error(`进程名 "${name}" 是保留名, 请改用其他 "name" 值.`);
    }
    const firstIndex = seen.get(name);
    if (firstIndex !== undefined) {
      throw new Error(
        `进程名 "${name}" 在 bots.json 第 ${firstIndex + 1} 条和第 ${i + 1} 条重复. ` +
        '请改 "name" 让进程名唯一, 或清空其中一个后再重启.',
      );
    }
    seen.set(name, i);
  }
}

function applyOptionalString(
  out: Record<string, any>,
  key: string,
  raw: string | undefined,
): void {
  if (raw === undefined) return;
  const s = raw.trim();
  if (!s) return;
  if (s === '-') {
    delete out[key];
    return;
  }
  out[key] = s;
}

/**
 * Apply a tri-state boolean edit to a bot config object.
 *   - raw === undefined → leave untouched
 *   - '' / '-'          → delete the key (revert to default)
 *   - 'true' / 'false' (case-insensitive, also 1/0/yes/no/on/off) → set bool
 *
 * `persistDefault` is the value that equals "default" — when the parsed bool
 * equals it, the key is deleted instead of stored, mirroring how the bot-registry
 * parser keeps bots.json clean (default ON fields store only `false`, default OFF
 * fields store only `true`). Unparseable values throw.
 */
function applyOptionalBoolean(
  out: Record<string, any>,
  key: string,
  raw: string | undefined,
  persistDefault: boolean,
): void {
  if (raw === undefined) return;
  const s = raw.trim().toLowerCase();
  if (!s || s === '-') {
    delete out[key];
    return;
  }
  let value: boolean;
  if (s === 'true' || s === '1' || s === 'yes' || s === 'on') value = true;
  else if (s === 'false' || s === '0' || s === 'no' || s === 'off') value = false;
  else throw new Error(`${key} 必须是 true / false（或留空 / - 恢复默认）: ${raw}`);
  if (value === persistDefault) delete out[key];
  else out[key] = value;
}

export function parseBotSelection(
  input: string,
  bots: Array<{ larkAppId?: string; name?: unknown }>,
): number | undefined {
  const raw = input.trim();
  if (!raw) return undefined;

  const pm2Match = /^botmux-(\d+)$/.exec(raw);
  if (pm2Match) {
    const idx = Number(pm2Match[1]);
    if (Number.isInteger(idx) && idx >= 0 && idx < bots.length && botProcessName(bots[idx], idx) === raw) {
      return idx;
    }
  }

  const byAppId = bots.findIndex(b => b.larkAppId === raw);
  if (byAppId >= 0) return byAppId;

  const byConfiguredName = bots.findIndex(b => (
    typeof b.name === 'string' && normalizeBotProcessName(b.name) === raw
  ));
  if (byConfiguredName >= 0) return byConfiguredName;

  const byProcessName = bots.findIndex((b, i) => botProcessName(b, i) === raw);
  return byProcessName >= 0 ? byProcessName : undefined;
}

/**
 * 把源 Bot 的行为配置覆盖到刚创建的目标 Bot，同时保留目标应用自己的身份。
 * Dashboard 与 CLI clone 共用这里，避免两条入口各维护一份排除字段。
 */
export function cloneBotConfig(
  source: Record<string, any>,
  target: Record<string, any>,
): Record<string, any> {
  const cloned: Record<string, any> = { ...target, ...source };

  for (const key of [
    'apiOnly',
    'name',
    'displayName',
    'messageListeners',
    'oncallChats',
    'allowedChatGroups',
    'chatGrants',
    'globalGrants',
    'quotaState',
    'grantExpiryState',
    'sessionGroup',
    'chatReplyModes',
    'noCardChats',
    'activationPending',
    'activationDeactivating',
    'activationStarting',
    'activationCommitted',
  ]) {
    delete cloned[key];
  }

  for (const key of ['larkAppId', 'larkAppSecret', 'brand', 'allowedUsers', 'ownerOpenId']) {
    if (Object.prototype.hasOwnProperty.call(target, key) && target[key] !== undefined) {
      cloned[key] = target[key];
    } else {
      delete cloned[key];
    }
  }

  return cloned;
}

/** 只允许 daemon 已认证的 source open_id 进入共享的跨应用 owner 归一化。 */
export function cloneOwnerEntries(
  source: Record<string, any>,
  sourceAppId?: string,
  sourceOwnerOpenId?: string,
): string[] {
  const managedOwner = sourceAppId === source.larkAppId ? sourceOwnerOpenId : undefined;
  if (!Array.isArray(source.allowedUsers)) return [];
  return source.allowedUsers.filter((entry: unknown): entry is string => (
    typeof entry === 'string' && (!entry.startsWith('ou_') || entry === managedOwner)
  ));
}

export function removeBotConfig<T extends { larkAppId?: string; name?: unknown }>(
  bots: T[],
  selection: string,
): RemoveBotConfigResult<T> | undefined {
  const index = parseBotSelection(selection, bots);
  if (index === undefined) return undefined;

  const nextBots = bots.slice();
  const [removed] = nextBots.splice(index, 1);
  return { bots: nextBots, removed: removed as T, index };
}

export function applyBotConfigEdits<T extends Record<string, any>>(
  bot: T,
  input: BotConfigEditInput,
): T {
  const out: Record<string, any> = { ...bot };

  const appId = trimmed(input.larkAppId);
  if (appId) out.larkAppId = appId;

  const name = normalizeBotProcessName(input.name);
  if (input.name !== undefined) {
    if (input.name.trim() === '-') delete out.name;
    else if (name) out.name = name;
  }

  const appSecret = trimmed(input.larkAppSecret);
  if (appSecret) out.larkAppSecret = appSecret;

  const cliId = resolveCliId(input.cliChoice);
  if (cliId) out.cliId = cliId;

  // The edit API keeps one explicit executable source. Persisted structured
  // runtimes additionally carry an equal cliPathOverride shadow so rolling
  // back to a pre-cliRuntime BotMux still launches the same distribution.
  // Interactive setup always supplies the path prompt as a string; an empty
  // answer means "preserve", not "replace the structured runtime with its
  // legacy shadow". Only a non-empty value (including "-" for clear) is an
  // actual path edit.
  const cliPathOverrideEdited = input.cliPathOverride !== undefined
    && input.cliPathOverride.trim().length > 0;
  if (input.cliRuntime !== undefined && input.cliRuntime !== null && cliPathOverrideEdited) {
    throw new Error('cliRuntime conflicts with cliPathOverride; configure only one executable source');
  }
  const explicitlySettingRuntime = input.cliRuntime !== undefined && input.cliRuntime !== null;
  if (input.cliRuntime === null) {
    const oldRuntimeExecutable = out.cliRuntime && typeof out.cliRuntime === 'object'
      ? out.cliRuntime.executable
      : undefined;
    delete out.cliRuntime;
    if (oldRuntimeExecutable && out.cliPathOverride === oldRuntimeExecutable) delete out.cliPathOverride;
  } else if (input.cliRuntime !== undefined) {
    out.cliRuntime = normalizeCliRuntimeConfig(input.cliRuntime, 'cliRuntime');
    out.cliPathOverride = out.cliRuntime.executable;
  }
  if (cliPathOverrideEdited) {
    applyOptionalString(out, 'cliPathOverride', input.cliPathOverride);
    delete out.cliRuntime;
  }

  // The first supported custom-runtime family is Codex. Switching a bot to a
  // different adapter must not strand a stale Codex distribution descriptor
  // that a later edit or old client could accidentally revive.
  if (out.cliId !== 'codex') {
    if (explicitlySettingRuntime) throw new Error('cliRuntime is currently supported only for cliId "codex"');
    const oldRuntimeExecutable = out.cliRuntime && typeof out.cliRuntime === 'object'
      ? out.cliRuntime.executable
      : undefined;
    delete out.cliRuntime;
    if (oldRuntimeExecutable && out.cliPathOverride === oldRuntimeExecutable) delete out.cliPathOverride;
  }

  if (out.cliRuntime) {
    out.cliRuntime = normalizeCliRuntimeConfig(out.cliRuntime, 'cliRuntime');
    if (out.cliPathOverride !== undefined && out.cliPathOverride !== out.cliRuntime.executable) {
      throw new Error('cliPathOverride must exactly match cliRuntime.executable when both are present');
    }
    out.cliPathOverride = out.cliRuntime.executable;
  }

  // wrapperCli 三态：null = 清空，string = 设置（空 / "-" 也清空），undefined = 不动。
  if (input.wrapperCli === null) {
    delete out.wrapperCli;
  } else if (typeof input.wrapperCli === 'string') {
    const v = input.wrapperCli.trim();
    if (!v || v === '-') delete out.wrapperCli;
    else out.wrapperCli = v;
  }
  if (out.cliRuntime && out.wrapperCli) {
    throw new Error('cliRuntime cannot be combined with wrapperCli');
  }

  // Model 字段：null = 清空，string = 设置，undefined = 不动。
  if (input.model === null) {
    delete out.model;
  } else if (typeof input.model === 'string') {
    const v = input.model.trim();
    if (v === '-') delete out.model;
    else if (v) out.model = v;
    else delete out.model;
  }

  if (input.backendType !== undefined) {
    const backendType = input.backendType.trim();
    if (backendType === '-') {
      delete out.backendType;
    } else if (backendType) {
      if (backendType !== 'pty' && backendType !== 'tmux' && backendType !== 'herdr' && backendType !== 'zellij' && backendType !== 'zmx' && backendType !== 'riff' && backendType !== 'mojo') {
        throw new Error(`backendType must be "pty", "tmux", "herdr", "zellij", "zmx", "riff", or "mojo": ${backendType}`);
      }
      out.backendType = backendType;
    }
  }

  applyOptionalString(out, 'workingDir', input.workingDir);
  applyOptionalString(out, 'defaultWorkingDir', input.defaultWorkingDir);

  if (input.allowedUsers !== undefined) {
    const allowedUsers = input.allowedUsers.trim();
    if (allowedUsers === '-') {
      delete out.allowedUsers;
    } else if (allowedUsers) {
      const entries = allowedUsers.split(',').map(s => s.trim()).filter(Boolean);
      const invalid = findInvalidAllowedUserEntries(entries);
      if (invalid.length > 0) {
        throw new Error(
          `allowedUsers 条目必须是完整邮箱（如 alice@example.com）、手机号（大陆号直填 11 位，海外号带 + 区号）、union_id（on_xxx）或 open_id（ou_xxx），不能是邮箱前缀: ${invalid.join(', ')}`,
        );
      }
      out.allowedUsers = entries;
    }
  }

  if (input.allowedChatGroups !== undefined) {
    const allowedChatGroups = input.allowedChatGroups.trim();
    if (allowedChatGroups === '-') {
      delete out.allowedChatGroups;
    } else if (allowedChatGroups) {
      out.allowedChatGroups = allowedChatGroups.split(',').map(s => s.trim()).filter(Boolean);
    }
  }

  // 平台团队展示默认 ON → 只把显式 false 落盘。
  applyOptionalBoolean(out, 'showInTeam', input.showInTeam, true);

  return normalizeBotConfig(out) as T;
}
