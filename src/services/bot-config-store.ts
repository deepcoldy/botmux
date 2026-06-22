/**
 * `/config` 远程编辑 bot 运营字段。与 oncall-store / grant-prefs-store / brand-store
 * 同款：跨进程文件锁 + bots.json 原子写（rmwBotEntry），外加内存 registry 同步——
 * 因此 **无需重启 daemon**：读取实时配置的字段立即生效，spawn 时才读取的字段
 * （model / cliId / disableCliBypass / defaultWorkingDir）下一个新会话生效。
 *
 * 刻意只覆盖「运营字段」。secret（larkAppSecret / voice 凭证）绝不经此路径修改——
 * 聊天通道会被 IM 侧记录，引导新 bot / 换密钥仍走本机 `botmux setup`。授权额度
 * （grants / quota）由既有 `/grant` 负责，不在此重复。
 */
import type { BotConfig } from '../bot-registry.js';
import { getBot, readBotSkillPolicy } from '../bot-registry.js';
import { rmwBotEntry } from './config-store.js';
import { resolveAllowedUsersWithMap } from '../im/lark/client.js';
import { CLI_OPTIONS, resolveCliId } from '../setup/bot-config-editor.js';
import { expandHomePath } from '../utils/working-dir.js';
import { resolveTeamRoleFile } from '../core/role-resolver.js';
import { statSync } from 'node:fs';
import { logger } from '../utils/logger.js';
import { parseCustomPassthroughInput } from '../core/passthrough-commands.js';
import { parseStartupCommandsInput } from '../core/startup-commands.js';
import { sanitizePerBotEnv } from '../core/per-bot-env.js';

/**
 * 生效时机：
 *   • immediate     — 运行时读取实时 `bot.config`，热更新后下一条消息/事件即生效。
 *   • next-session  — spawn CLI 时才读取，当前运行中的会话需 `/restart` 重启才换新值；
 *                     新会话直接用新值。
 */
export type ConfigEffect = 'immediate' | 'next-session';

export type ConfigFieldKind = 'string' | 'stringList' | 'boolean' | 'number' | 'enum' | 'cli' | 'dir' | 'allowedUsers' | 'json';

export interface ConfigFieldSpec {
  /** 用户面命令里用的字段名（大小写不敏感匹配，见 {@link findConfigField}）。 */
  key: string;
  /** bots.json / 内存 BotConfig 上的实际字段。 */
  configKey: keyof BotConfig;
  kind: ConfigFieldKind;
  effect: ConfigEffect;
  /** 是否支持 `/config unset <field>`（清回默认）。boolean 字段用 `set off` 即可，无需 unset。 */
  clearable: boolean;
  /** kind==='enum' 时的合法取值（已小写）。 */
  enumValues?: readonly string[];
  /** kind==='stringList' 的自定义解析器（自由文本 → 归一化数组）。缺省用
   *  customPassthroughCommands 的逗号/空格分隔解析；带参数的命令行字段
   *  （如 startupCommands）须指定按逗号/换行分隔、保留内部空格的解析器。 */
  parseList?: (raw: string) => string[];
  /** 一句话说明，进 `/config help` / `/config get`。 */
  hint: string;
}

/**
 * Phase 1 可编辑的运营字段。**不含** allowedUsers 之外的权限字段、secret、brand
 * （绑定租户、需重启重建 client）、name（pm2 进程名，启动期绑定）。allowedUsers
 * 在此登记但走 {@link setBotAllowedUsers} 的专用异步路径（重解析 + 防自锁）。
 */
export const CONFIG_FIELDS: readonly ConfigFieldSpec[] = [
  { key: 'model', configKey: 'model', kind: 'string', effect: 'next-session', clearable: true, hint: 'CLI 模型名（如 opus）；unset 回 CLI 默认' },
  { key: 'cli', configKey: 'cliId', kind: 'cli', effect: 'next-session', clearable: false, hint: 'CLI 适配器（序号 1-16 或 id，如 claude-code）' },
  { key: 'lang', configKey: 'lang', kind: 'enum', effect: 'immediate', clearable: true, enumValues: ['zh', 'en'], hint: '机器人 UI 语言 zh|en；unset 回全局默认' },
  { key: 'defaultWorkingDir', configKey: 'defaultWorkingDir', kind: 'dir', effect: 'next-session', clearable: true, hint: '新话题默认工作目录（跳过仓库选择卡片）' },
  { key: 'brandLabel', configKey: 'brandLabel', kind: 'string', effect: 'immediate', clearable: true, hint: '卡片页脚品牌文案；unset 回默认 botmux 链接' },
  { key: 'autoStartPrompt', configKey: 'autoStartOnGroupJoinPrompt', kind: 'string', effect: 'immediate', clearable: true, hint: '被拉进新群主动开工的首轮 prompt（配合 autoStartOnGroupJoin）' },
  { key: 'allowedUsers', configKey: 'allowedUsers', kind: 'allowedUsers', effect: 'immediate', clearable: false, hint: '管理员名单（邮箱/on_/ou_，逗号或空格分隔）；改后需加 确认' },
  { key: 'skills', configKey: 'skills', kind: 'json', effect: 'next-session', clearable: true, hint: 'bot 级 skill policy JSON；unset 回底层 CLI 默认行为' },
  { key: 'disableStreamingCard', configKey: 'disableStreamingCard', kind: 'boolean', effect: 'immediate', clearable: false, hint: '关闭实时流式卡片 on|off' },
  { key: 'writableTerminalLinkInCard', configKey: 'writableTerminalLinkInCard', kind: 'boolean', effect: 'immediate', clearable: false, hint: '卡片内嵌可写终端链接 on|off' },
  { key: 'privateCard', configKey: 'privateCard', kind: 'boolean', effect: 'immediate', clearable: false, hint: '/card 发 owner-only 私有快照 on|off' },
  { key: 'autoStartOnGroupJoin', configKey: 'autoStartOnGroupJoin', kind: 'boolean', effect: 'immediate', clearable: false, hint: '被拉进新群即主动开工 on|off' },
  { key: 'autoStartOnNewTopic', configKey: 'autoStartOnNewTopic', kind: 'boolean', effect: 'immediate', clearable: false, hint: '话题群每个新话题自动开工 on|off' },
  { key: 'worktreeMultiPicker', configKey: 'worktreeMultiPicker', kind: 'boolean', effect: 'immediate', clearable: false, hint: 'repo 卡片 worktree 选择器默认多仓库模式 on|off（卡片「切换多仓库选择器」按钮同款）' },
  { key: 'disableCliBypass', configKey: 'disableCliBypass', kind: 'boolean', effect: 'next-session', clearable: false, hint: '不加 CLI 审批/sandbox 绕过参数 on|off' },
  { key: 'restrictGrantCommands', configKey: 'restrictGrantCommands', kind: 'boolean', effect: 'immediate', clearable: false, hint: '被授权人仅能纯对话、拦截斜杠命令 on|off' },
  { key: 'p2pMode', configKey: 'p2pMode', kind: 'enum', effect: 'immediate', clearable: true, enumValues: ['thread', 'chat'], hint: '私聊单聊模式 thread|chat；chat=扁平连续会话，thread/unset 回默认（每条 DM 独立会话）' },
  { key: 'maxLiveWorkers', configKey: 'maxLiveWorkers', kind: 'number', effect: 'immediate', clearable: true, hint: '最大同时活跃会话数；超过后最久未用的会话自动休眠（杀 worker+CLI 回收内存，下条消息冷恢复）；unset=默认 30' },
  { key: 'customPassthroughCommands', configKey: 'customPassthroughCommands', kind: 'stringList', effect: 'immediate', clearable: true, hint: '额外放行透传给 CLI 的 slash 命令（逗号/空格分隔，如 /goal /export）；unset 回仅内置白名单' },
  { key: 'startupCommands', configKey: 'startupCommands', kind: 'stringList', effect: 'next-session', clearable: true, parseList: parseStartupCommandsInput, hint: '开会话后、首条消息前自动发给 CLI 的命令（逗号/换行分隔，可带参数，如 /effort ultracode）；unset 回不发' },
  { key: 'env', configKey: 'env', kind: 'json', effect: 'next-session', clearable: true, hint: 'per-bot 环境变量 JSON（如 {"ANTHROPIC_BASE_URL":"…","ANTHROPIC_AUTH_TOKEN":"…"} 让本 bot 走 GLM/第三方服务商，或设 HTTPS_PROXY）；注入到本 bot 的 CLI 进程，下个会话生效；值不显示（脱敏）；unset 清除' },
];

/** 大小写不敏感地按 key 找字段 spec。 */
export function findConfigField(key: string): ConfigFieldSpec | undefined {
  const k = key.trim().toLowerCase();
  return CONFIG_FIELDS.find(f => f.key.toLowerCase() === k);
}

/** 可设置字段名列表（用于报错提示 / help）。 */
export function settableFieldKeys(): string[] {
  return CONFIG_FIELDS.map(f => f.key);
}

/** 把 on/off 类输入解析成布尔，无法识别 → undefined。 */
export function parseBooleanValue(raw: string): boolean | undefined {
  const v = raw.trim().toLowerCase();
  if (['on', 'true', '1', 'yes', 'y', 'enable', 'enabled', '开', '是'].includes(v)) return true;
  if (['off', 'false', '0', 'no', 'n', 'disable', 'disabled', '关', '否'].includes(v)) return false;
  return undefined;
}

/** 展示某字段当前值的人类可读文本。 */
function formatFieldValue(spec: ConfigFieldSpec, value: unknown): string {
  if (spec.kind === 'boolean') return value === true ? 'on' : 'off';
  if (spec.kind === 'allowedUsers' || spec.kind === 'stringList') {
    const arr = Array.isArray(value) ? value : [];
    return arr.length ? arr.join(', ') : '∅';
  }
  // env may hold secrets (e.g. ANTHROPIC_AUTH_TOKEN). NEVER render the values
  // anywhere chat-visible (/config get): show key names with masked values only.
  if (spec.configKey === 'env') {
    const obj = value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>) : null;
    const keys = obj ? Object.keys(obj) : [];
    return keys.length ? keys.map(k => `${k}=••••`).join(', ') : '∅';
  }
  if (spec.kind === 'json') {
    return value === undefined || value === null ? '∅' : JSON.stringify(value);
  }
  if (value === undefined || value === null || value === '') return '∅';
  return String(value);
}

export interface ConfigSnapshotRow {
  key: string;
  value: string;
  effect: ConfigEffect;
}

/** 当前可编辑字段的快照（供 `/config get`）。不含 secret。 */
export function getConfigSnapshot(larkAppId: string): {
  ok: true;
  rows: ConfigSnapshotRow[];
  info: { cliId: string; brand: string; resolvedAdmins: number; workingDirs: string[] };
} | { ok: false } {
  let bot;
  try { bot = getBot(larkAppId); } catch { return { ok: false }; }
  const cfg = bot.config;
  const rows: ConfigSnapshotRow[] = CONFIG_FIELDS.map(spec => ({
    key: spec.key,
    value: formatFieldValue(spec, (cfg as any)[spec.configKey]),
    effect: spec.effect,
  }));
  return {
    ok: true,
    rows,
    info: {
      cliId: cfg.cliId,
      brand: cfg.brand ?? 'feishu',
      resolvedAdmins: bot.resolvedAllowedUsers.length,
      workingDirs: cfg.workingDirs ?? (cfg.workingDir ? [cfg.workingDir] : []),
    },
  };
}

export type ApplyFieldResult =
  | { ok: true; oldText: string; newText: string; effect: ConfigEffect }
  | { ok: false; reason: 'bot_not_registered' | 'bot_not_in_config' | string };

/**
 * 写入并热更新一个**已解析**的字段值（string / boolean / null=清除）。
 * 调用方负责按 kind 校验后再传值；本函数只负责落盘 + 同步内存。
 * 不处理 allowedUsers（异步，见 {@link setBotAllowedUsers}）。
 */
export async function applyConfigField(
  larkAppId: string,
  spec: ConfigFieldSpec,
  value: unknown,
): Promise<ApplyFieldResult> {
  if (spec.kind === 'allowedUsers') return { ok: false, reason: 'use_setBotAllowedUsers' };
  let bot;
  try { bot = getBot(larkAppId); } catch { return { ok: false, reason: 'bot_not_registered' }; }
  const oldText = formatFieldValue(spec, (bot.config as any)[spec.configKey]);

  // 空数组（stringList 全被过滤）等价清除，bots.json 保持干净。
  const effective = spec.kind === 'stringList' && Array.isArray(value) && value.length === 0 ? null : value;

  const r = await rmwBotEntry<null>(larkAppId, (entry) => {
    if (effective === null) {
      delete entry[spec.configKey];
    } else if (spec.kind === 'boolean') {
      // 与 parseBotConfigsFromText 一致：true 才写，false → 删 key（bots.json 保持干净）。
      if (effective === true) entry[spec.configKey] = true;
      else delete entry[spec.configKey];
    } else if (spec.kind === 'json') {
      entry[spec.configKey] = effective as any;
    } else {
      entry[spec.configKey] = effective;
    }
    return { write: true, result: null };
  });
  if (!r.ok) return { ok: false, reason: r.reason };

  // 同步内存 config（与 oncall/grant-prefs store 一致，路由/spawn 不重启即生效）。
  if (effective === null) {
    (bot.config as any)[spec.configKey] = undefined;
  } else if (spec.kind === 'boolean') {
    (bot.config as any)[spec.configKey] = effective || undefined;
  } else if (spec.kind === 'json') {
    (bot.config as any)[spec.configKey] = effective;
  } else {
    (bot.config as any)[spec.configKey] = effective;
  }
  const newText = formatFieldValue(spec, (bot.config as any)[spec.configKey]);
  logger.info(`[config:${larkAppId}] set ${spec.key}: ${oldText} -> ${newText}`);
  return { ok: true, oldText, newText, effect: spec.effect };
}

export type SetAllowedUsersResult =
  | { ok: true; raw: string[]; resolved: string[] }
  | { ok: false; reason: 'bot_not_registered' | 'bot_not_in_config' | 'self_lockout' | 'empty_resolved' | string };

/**
 * 改 allowedUsers（管理员名单）。这是动信任根的敏感操作，与普通字段分开：
 *   1. 用 bot 凭证把邮箱/on_ 解析成 open_id（与启动期同一路径）。
 *   2. **防自锁**：解析后名单必须仍含发起人的 open_id，否则拒绝——避免把自己踢出管理员。
 *   3. 解析后非空才写。
 *   4. 落盘原始条目（邮箱/on_/ou_，与 setup 一致），并同步内存 resolvedAllowedUsers /
 *      rawAllowedUserResolution（与 daemon 启动期赋值同口径），无需重启。
 *
 * confirm 二次确认由调用方（command-handler）处理，本函数只做校验 + 落盘。
 */
export async function setBotAllowedUsers(
  larkAppId: string,
  rawEntries: string[],
  senderOpenId: string | undefined,
): Promise<SetAllowedUsersResult> {
  let bot;
  try { bot = getBot(larkAppId); } catch { return { ok: false, reason: 'bot_not_registered' }; }

  const { resolved, map } = await resolveAllowedUsersWithMap(larkAppId, rawEntries);
  if (resolved.length === 0) return { ok: false, reason: 'empty_resolved' };
  if (senderOpenId && !resolved.includes(senderOpenId)) return { ok: false, reason: 'self_lockout' };

  const r = await rmwBotEntry<null>(larkAppId, (entry) => {
    entry.allowedUsers = rawEntries;
    return { write: true, result: null };
  });
  if (!r.ok) return { ok: false, reason: r.reason };

  bot.config.allowedUsers = rawEntries;
  bot.resolvedAllowedUsers = resolved;
  bot.rawAllowedUserResolution = map;
  logger.info(`[config:${larkAppId}] allowedUsers updated: ${rawEntries.length} entries, ${resolved.length} resolved`);
  return { ok: true, raw: rawEntries, resolved };
}

export type CoerceResult =
  | { ok: true; value: unknown }
  | { ok: false; reason: 'invalid_bool' | 'invalid_enum' | 'invalid_cli' | 'invalid_dir' | 'invalid_number' | 'invalid_json' | 'empty' };

/**
 * 把一个**原始**字段值（来自卡片下拉/输入或别处）按字段 kind 解析校验成可落盘的
 * string|boolean。dir 在此做存在性检查（无 locale，返回结构化 reason，调用方再本地化）。
 * allowedUsers 不走这里（异步，见 {@link setBotAllowedUsers}）。
 */
export function coerceConfigValue(spec: ConfigFieldSpec, raw: unknown): CoerceResult {
  if (spec.kind === 'boolean') {
    if (typeof raw === 'boolean') return { ok: true, value: raw };
    const b = parseBooleanValue(String(raw ?? ''));
    return b === undefined ? { ok: false, reason: 'invalid_bool' } : { ok: true, value: b };
  }
  if (spec.kind === 'number') {
    const n = typeof raw === 'number' ? raw : Number(String(raw ?? '').trim());
    return Number.isInteger(n) && n > 0 ? { ok: true, value: n } : { ok: false, reason: 'invalid_number' };
  }
  const s = String(raw ?? '').trim();
  if (!s) return { ok: false, reason: 'empty' };
  switch (spec.kind) {
    case 'stringList': {
      const arr = (spec.parseList ?? parseCustomPassthroughInput)(s);
      return arr.length ? { ok: true, value: arr } : { ok: false, reason: 'empty' };
    }
    case 'enum':
      return spec.enumValues?.includes(s.toLowerCase())
        ? { ok: true, value: s.toLowerCase() }
        : { ok: false, reason: 'invalid_enum' };
    case 'cli': {
      try {
        const id = resolveCliId(s);
        return id ? { ok: true, value: id } : { ok: false, reason: 'invalid_cli' };
      } catch { return { ok: false, reason: 'invalid_cli' }; }
    }
    case 'dir': {
      try { if (statSync(expandHomePath(s)).isDirectory()) return { ok: true, value: s }; } catch { /* not a dir */ }
      return { ok: false, reason: 'invalid_dir' };
    }
    case 'json': {
      try {
        const parsed = JSON.parse(s);
        if (spec.configKey === 'skills') {
          const policy = readBotSkillPolicy(parsed);
          return policy ? { ok: true, value: policy } : { ok: false, reason: 'invalid_json' };
        }
        if (spec.configKey === 'env') {
          // Must be a JSON object; sanitize to valid env keys + primitive values
          // (botmux-reserved keys dropped). Nothing valid left → reject (empty
          // text is handled as "clear" by the caller before reaching coerce).
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, reason: 'invalid_json' };
          const sanitized = sanitizePerBotEnv(parsed);
          return Object.keys(sanitized).length ? { ok: true, value: sanitized } : { ok: false, reason: 'invalid_json' };
        }
        return { ok: true, value: parsed };
      } catch {
        return { ok: false, reason: 'invalid_json' };
      }
    }
    default: // 'string'
      return { ok: true, value: s };
  }
}

/**
 * 渲染交互配置卡片所需的纯数据视图。card-builder 只吃这个（不反向 import store），
 * 避免循环依赖。`modelChoices` 由调用方按 cliId 解析后传入（command-handler /
 * card-handler 已 import CLI 适配器），缺省空数组 → 不渲染 model 下拉。
 */
export interface ConfigCardData {
  larkAppId: string;
  botName: string;
  cliId: string;
  cliOptions: Array<{ id: string; label: string }>;
  model: string | null;
  modelChoices: string[];
  lang: string | null;
  /** 私聊单聊模式 p2pMode（'chat' | 'thread'）；null = 未设（默认 thread）。 */
  p2pMode: string | null;
  brandLabel: string | null;
  defaultWorkingDir: string | null;
  /** 入群主动开工首轮 prompt（autoStartOnGroupJoinPrompt）。 */
  autoStartPrompt: string | null;
  /** 额外放行透传的 slash 命令（customPassthroughCommands），空格分隔；null = 未设。 */
  customPassthroughCommands: string | null;
  /** 开会话后自动发的命令（startupCommands），逗号分隔（命令自带空格参数，故不能空格分隔）；null = 未设。 */
  startupCommands: string | null;
  /** team 级默认角色文本（不在 bots.json，存独立角色文件）。 */
  teamRole: string | null;
  /** messageQuota.defaultLimit（被授权人默认消息额度）；null = 不限。 */
  quota: number | null;
  admins: number;
  booleans: Array<{ key: string; on: boolean }>;
}

export function getConfigCardData(larkAppId: string, modelChoices: readonly string[] = []): ConfigCardData | null {
  let bot;
  try { bot = getBot(larkAppId); } catch { return null; }
  const cfg = bot.config;
  const q = cfg.messageQuota?.defaultLimit;
  return {
    larkAppId,
    botName: bot.botName ?? cfg.cliId,
    cliId: cfg.cliId,
    cliOptions: CLI_OPTIONS.map(o => ({ id: o.id, label: o.label })),
    model: cfg.model ?? null,
    modelChoices: [...modelChoices],
    lang: cfg.lang ?? null,
    p2pMode: cfg.p2pMode ?? null,
    brandLabel: cfg.brandLabel ?? null,
    defaultWorkingDir: cfg.defaultWorkingDir ?? null,
    autoStartPrompt: cfg.autoStartOnGroupJoinPrompt ?? null,
    customPassthroughCommands: cfg.customPassthroughCommands?.length ? cfg.customPassthroughCommands.join(' ') : null,
    // Join with ', ' (not space): each command carries space-delimited args.
    startupCommands: cfg.startupCommands?.length ? cfg.startupCommands.join(', ') : null,
    teamRole: resolveTeamRoleFile(larkAppId),
    quota: typeof q === 'number' && Number.isInteger(q) && q > 0 ? q : null,
    admins: bot.resolvedAllowedUsers.length,
    booleans: CONFIG_FIELDS.filter(f => f.kind === 'boolean').map(f => ({
      key: f.key, on: (cfg as any)[f.configKey] === true,
    })),
  };
}
