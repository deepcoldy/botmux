import type { CliId } from '../adapters/cli/types.js';

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
  'opencode': 'OpenCode',
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
};

/**
 * 有序 CLI 选项 (id + 展示名), 顺序与 setup 交互菜单 (CLI_ID_CHOICES 序号
 * 1..16) 一致. dashboard "添加机器人" 的 CLI 下拉直接读这里, 避免再抄一份
 * 列表. 单一事实源: CLI_ID_CHOICES 的值序.
 */
export const CLI_OPTIONS: ReadonlyArray<{ id: CliId; label: string }> =
  Object.values(CLI_ID_CHOICES).map(id => ({ id, label: CLI_DISPLAY_LABELS[id] ?? id }));

/**
 * 把 setup 里"CLI 适配器"那一格的原始输入解析成合法的 CliId.
 *   - 空 → undefined (调用方决定 "preserve current" 还是套默认 'claude-code')
 *   - "1".."16" → CLI_ID_CHOICES 映射
 *   - 已是合法 cliId 字面值 → 原样返回
 *   - 其它 → throw (typo 不该静默落盘成 cliId)
 */
export function resolveCliId(input: string | undefined): CliId | undefined {
  const raw = trimmed(input);
  if (!raw) return undefined;
  const mapped = CLI_ID_CHOICES[raw];
  if (mapped) return mapped;
  if (VALID_CLI_IDS.has(raw)) return raw as CliId;
  throw new Error(
    `Unknown CLI 适配器 "${raw}"。请输入序号 1-17 或合法 ID 之一: ${[...VALID_CLI_IDS].join(', ')}`,
  );
}

/** 完整邮箱（含 @ 和域名）。用于区分"完整邮箱"与"邮箱前缀"——后者解析时会被静默丢弃。 */
const FULL_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * 合法的 allowedUsers 条目：
 *   - on_xxx  union_id  — 跨应用稳定，推荐
 *   - 完整邮箱          — 人类可读，推荐
 *   - ou_xxx  open_id   — 仅对签发该 ID 的同一应用有效，不推荐跨 bot 复用
 * 裸邮箱前缀（如 "alice"）不合法：解析器只认 ou_/on_ 或完整邮箱。
 */
export function isValidAllowedUserEntry(entry: string): boolean {
  const s = entry.trim();
  return s.startsWith('ou_') || s.startsWith('on_') || FULL_EMAIL_RE.test(s);
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
   * Model 字段三态语义：
   *   - undefined → 这次编辑没问过 model（adapter 没声明 modelChoices 自动跳过），保持原值
   *   - string    → 设为这个 model
   *   - null      → 清空（删字段，回到 CLI 默认）
   */
  model?: string | null;
  backendType?: string;
  workingDir?: string;
  allowedUsers?: string;
  allowedChatGroups?: string;
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

  const byProcessName = bots.findIndex((b, i) => botProcessName(b, i) === raw);
  return byProcessName >= 0 ? byProcessName : undefined;
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

  applyOptionalString(out, 'cliPathOverride', input.cliPathOverride);

  // Model 字段：null = 清空，string = 设置，undefined = 不动。promptModel 已经
  // 把"adapter 不支持 model"折叠成 undefined 直接跳过；这里不再去查 adapter。
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
      if (backendType !== 'pty' && backendType !== 'tmux' && backendType !== 'herdr' && backendType !== 'zellij') {
        throw new Error(`backendType must be "pty", "tmux", "herdr", or "zellij": ${backendType}`);
      }
      out.backendType = backendType;
    }
  }

  applyOptionalString(out, 'workingDir', input.workingDir);

  if (input.allowedUsers !== undefined) {
    const allowedUsers = input.allowedUsers.trim();
    if (allowedUsers === '-') {
      delete out.allowedUsers;
    } else if (allowedUsers) {
      const entries = allowedUsers.split(',').map(s => s.trim()).filter(Boolean);
      const invalid = findInvalidAllowedUserEntries(entries);
      if (invalid.length > 0) {
        throw new Error(
          `allowedUsers 条目必须是完整邮箱（如 alice@example.com）或 open_id（ou_xxx），不能是邮箱前缀: ${invalid.join(', ')}`,
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

  return normalizeBotConfig(out) as T;
}
