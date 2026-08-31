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
import { normalizeMojoConfig } from '../adapters/backend/mojo-types.js';
import type { BotConfig } from '../bot-registry.js';
import { getBot, readBotSkillPolicy } from '../bot-registry.js';
import { republishResolvedAllowedUsersDescriptor, scheduleAllowedUsersResolveRetryFromMutation } from '../bot-registry.js';
import { config } from '../config.js';
import { writeAllowedUsersResolveCache } from '../utils/allowed-users-cache.js';
import { rmwBotEntry } from './config-store.js';
import { resolveAllowedUsersWithMap } from '../im/lark/client.js';
import { CLI_OPTIONS, resolveCliId } from '../setup/bot-config-editor.js';
import { expandHomePath } from '../utils/working-dir.js';
import { resolveTeamRoleFile } from '../core/role-resolver.js';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { sendCredFilePath } from '../adapters/cli/read-isolation.js';
import { logger } from '../utils/logger.js';
import { parseCustomPassthroughInput, parseCanTalkDaemonCommandsInput } from '../core/passthrough-commands.js';
import { parseStartupCommandsInput } from '../core/startup-commands.js';
import { isReservedPerBotEnvKey, sanitizePerBotEnv } from '../core/per-bot-env.js';
import { normalizeFeedbackPolicy } from './feedback-policy.js';
import { normalizeFeedbackPolicyLayer, type FeedbackPolicyLayer } from './feedback-policy-resolver.js';
import {
  notifyPinStreamingCardChanged,
  serializePinStreamingCardConfigChange,
} from './pin-streaming-card-change.js';
import {
  cliModelSupportsReasoningEffort,
  isCodexReasoningEffort,
  isConfigurableReasoningCliId,
} from './codex-reasoning-effort.js';

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
  /** kind==='boolean' 且默认值为 ON 的字段：持久化取反（只写显式 false，true
   *  删 key），展示时缺省渲染为 on。缺省（undefined）保持默认 OFF 语义。 */
  defaultOn?: boolean;
  /** kind==='enum' 时的合法取值（已小写）。 */
  enumValues?: readonly string[];
  /** kind==='string' 的最大长度（trim 后计），超出 coerce 报 too_long。缺省不限。 */
  maxLen?: number;
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
  { key: 'displayName', configKey: 'displayName', kind: 'string', effect: 'immediate', clearable: true, maxLen: 64, hint: '自定义展示名（dashboard 名册/会话列表用，≤64 字符）；不改飞书群内应用名；unset 回飞书名称' },
  { key: 'model', configKey: 'model', kind: 'string', effect: 'next-session', clearable: true, hint: 'CLI 模型名（如 opus）；unset 回 CLI 默认' },
  { key: 'reasoningEffort', configKey: 'reasoningEffort', kind: 'enum', effect: 'next-session', clearable: true, enumValues: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], hint: '支持的 CLI 上新会话默认思考强度 low|medium|high|xhigh|max|ultra；unset 回 CLI 默认' },
  { key: 'cli', configKey: 'cliId', kind: 'cli', effect: 'next-session', clearable: false, hint: 'CLI 适配器（序号 1-16 或 id，如 claude-code）' },
  { key: 'launchShell', configKey: 'launchShell', kind: 'string', effect: 'next-session', clearable: true, hint: '启动 CLI 用的 shell（zsh|bash|fish|sh 或绝对路径），覆盖 $SHELL；用于 .bashrc/.zshrc 里 exec 切到别的 shell 导致会话起不来的场景；fish 用户把 PATH/nvm 放进 ~/.config/fish/config.fish，无需回填 bash/zsh；unset 回 $SHELL' },
  { key: 'lang', configKey: 'lang', kind: 'enum', effect: 'immediate', clearable: true, enumValues: ['zh', 'en'], hint: '机器人 UI 语言 zh|en；unset 回全局默认' },
  { key: 'skillInjection', configKey: 'skillInjection', kind: 'enum', effect: 'next-session', clearable: true, enumValues: ['global', 'prompt', 'off'], hint: 'botmux skills 注入方式（仅影响 codex/gemini 等全局 skills 目录的 CLI）：prompt=注入会话不落全局盘(默认)｜global=装进 CLI 全局目录(会被独立 CLI 看到)｜off=只留提示+botmux --help；切到/离开 global 需重启 daemon 才完全生效；unset 回机器级默认' },
  { key: 'defaultWorkingDir', configKey: 'defaultWorkingDir', kind: 'dir', effect: 'next-session', clearable: true, hint: '新话题默认工作目录（跳过仓库选择卡片）' },
  { key: 'brandLabel', configKey: 'brandLabel', kind: 'string', effect: 'immediate', clearable: true, hint: '卡片页脚品牌文案；unset 回默认 botmux 链接' },
  { key: 'usageDisplay', configKey: 'usageDisplay', kind: 'enum', effect: 'immediate', clearable: true, enumValues: ['streaming', 'footer', 'off'], hint: '用量显示位置:streaming=流式卡正文(默认)｜footer=回复卡页脚｜off=不显示' },
  { key: 'autoStartPrompt', configKey: 'autoStartOnGroupJoinPrompt', kind: 'string', effect: 'immediate', clearable: true, hint: '被拉进新群主动开工的首轮 prompt（配合 autoStartOnGroupJoin）' },
  { key: 'allowedUsers', configKey: 'allowedUsers', kind: 'allowedUsers', effect: 'immediate', clearable: false, hint: '管理员名单（邮箱/on_/ou_，逗号或空格分隔）；改后需加 确认' },
  { key: 'skills', configKey: 'skills', kind: 'json', effect: 'next-session', clearable: true, hint: 'bot 级 skill policy JSON；unset 回底层 CLI 默认行为' },
  { key: 'feedback', configKey: 'feedback', kind: 'json', effect: 'immediate', clearable: true, hint: '最终回答反馈 JSON；默认关闭，enabled=true 后按本 bot 启用；unset 关闭' },
  { key: 'disableStreamingCard', configKey: 'disableStreamingCard', kind: 'boolean', effect: 'immediate', clearable: false, hint: '关闭实时流式卡片 on|off' },
  { key: 'pinStreamingCard', configKey: 'pinStreamingCard', kind: 'boolean', effect: 'immediate', clearable: false, hint: '置顶当前公开实时卡片 on|off（失败不影响会话）' },
  { key: 'thinkingCard', configKey: 'thinkingCard', kind: 'boolean', effect: 'immediate', clearable: false, defaultOn: true, hint: '思考过程消息 on|off（默认 on）：turn 进行中把模型思考过程以飞书原生 CoT 消息（message_cot）流式展示（客户端需 PC ≥7.70 / 移动端 ≥7.74；当前支持 claude-code / codex）。这是 bot 级总开关，单个群可用 /cot off 关闭' },
  { key: 'silentTurnReactions', configKey: 'silentTurnReactions', kind: 'boolean', effect: 'immediate', clearable: false, hint: '关闭无卡片模式下的 GoGoGo/DONE 消息 reaction on|off' },
  { key: 'writableTerminalLinkInCard', configKey: 'writableTerminalLinkInCard', kind: 'boolean', effect: 'immediate', clearable: false, hint: '卡片内嵌可写终端链接 on|off' },
  { key: 'privateCard', configKey: 'privateCard', kind: 'boolean', effect: 'immediate', clearable: false, hint: '/card 发 owner-only 私有快照 on|off' },
  { key: 'summaryMemory', configKey: 'summaryMemory', kind: 'boolean', effect: 'immediate', clearable: false, hint: '/summary 写入当前项目 summary.md 的问题解决记录 on|off' },
  { key: 'summaryMemoryPath', configKey: 'summaryMemoryPath', kind: 'string', effect: 'immediate', clearable: true, hint: '/summary 记忆文件路径，支持相对当前项目根目录或绝对路径；unset 回 summary.md' },
  { key: 'autoStartOnGroupJoin', configKey: 'autoStartOnGroupJoin', kind: 'boolean', effect: 'immediate', clearable: false, hint: '被拉进新群即主动开工 on|off' },
  { key: 'autoStartOnNewTopic', configKey: 'autoStartOnNewTopic', kind: 'boolean', effect: 'immediate', clearable: false, hint: '话题群每个新话题自动开工 on|off' },
  { key: 'worktreeMultiPicker', configKey: 'worktreeMultiPicker', kind: 'boolean', effect: 'immediate', clearable: false, hint: 'repo 卡片 worktree 选择器默认多仓库模式 on|off（卡片「切换多仓库选择器」按钮同款）' },
  { key: 'disableCliBypass', configKey: 'disableCliBypass', kind: 'boolean', effect: 'next-session', clearable: false, hint: '不加 CLI 审批/sandbox 绕过参数 on|off' },
  { key: 'codexAppCleanInput', configKey: 'codexAppCleanInput', kind: 'boolean', effect: 'immediate', clearable: false, hint: '实验性：Codex App 用户气泡只保留真实输入，Botmux 元数据走隐藏上下文；默认 off，从下一次 turn 派发生效，不改已有历史' },
  { key: 'envelopeInjection', configKey: 'envelopeInjection', kind: 'enum', effect: 'immediate', clearable: true, enumValues: ['auto', 'off'], hint: '每轮上下文注入方式：auto=支持的 CLI（claude-code）把提醒/白板经 hook 注入为系统提醒，输入框只留消息本身，不支持的自动回退｜off=内联（默认）；unset 回 off' },
  { key: 'senderTag', configKey: 'senderTag', kind: 'boolean', effect: 'immediate', clearable: false, defaultOn: true, hint: '每轮注入 <sender> 发言人标签 on|off（默认 on）：标注本轮是谁在说话（open_id/姓名/邮箱）。关掉后模型看不到发言人身份，多人会话里无法区分谁说的；--mention-back 不受影响（走 daemon 侧独立记录）。代价：/adopt 少一条识别本 bot 自产会话的指纹，dashboard 洞察无法从标签判断发言人类型与 A2A 对方名字' },
  { key: 'restrictGrantCommands', configKey: 'restrictGrantCommands', kind: 'boolean', effect: 'immediate', clearable: false, hint: '被授权人仅能纯对话、拦截斜杠命令 on|off' },
  { key: 'p2pOpen', configKey: 'p2pOpen', kind: 'boolean', effect: 'immediate', clearable: false, hint: '私聊对话全开 on|off：任何能看到本 bot 的人都可私聊（只放行对话；管理操作默认仍只认 allowedUsers，被 canTalkDaemonCommands 显式降级的命令除外）；不影响群聊' },
  { key: 'p2pMode', configKey: 'p2pMode', kind: 'enum', effect: 'immediate', clearable: true, enumValues: ['thread', 'chat', 'group'], hint: '私聊单聊模式 thread|chat|group；默认 chat=扁平连续会话，thread=每条 DM 独立会话，group=每条 DM 自动建专属会话群（chat/unset 回默认）' },
  { key: 'maxLiveWorkers', configKey: 'maxLiveWorkers', kind: 'number', effect: 'immediate', clearable: true, hint: '最大常驻会话数；超过后最久未用的会话自动休眠（退出后台进程和 CLI、回收内存，下条消息冷恢复）；unset=默认 30' },
  { key: 'customPassthroughCommands', configKey: 'customPassthroughCommands', kind: 'stringList', effect: 'immediate', clearable: true, hint: '额外放行透传给 CLI 的 slash 命令（逗号/空格分隔，如 /goal /export）；unset 回仅内置白名单' },
  { key: 'canTalkDaemonCommands', configKey: 'canTalkDaemonCommands', kind: 'stringList', effect: 'immediate', clearable: true, parseList: parseCanTalkDaemonCommandsInput, hint: '把列出的 daemon 命令权限从 canOperate（仅管理员）降到 canTalk（对话放行即可用），如 /status /help；仅认 daemon 命令，透传命令无效；unset 回全部仅管理员' },
  { key: 'startupCommands', configKey: 'startupCommands', kind: 'stringList', effect: 'next-session', clearable: true, parseList: parseStartupCommandsInput, hint: '开会话后、首条消息前自动发给 CLI 的命令（逗号/换行分隔，可带参数，如 /effort ultracode）；unset 回不发' },
  { key: 'env', configKey: 'env', kind: 'json', effect: 'next-session', clearable: true, hint: 'per-bot 环境变量 JSON（如 {"ANTHROPIC_BASE_URL":"…","ANTHROPIC_AUTH_TOKEN":"…"} 让本 bot 走 GLM/第三方服务商，或设 HTTPS_PROXY）；注入到本 bot 的 CLI 进程，下个会话生效；值不显示（脱敏）；unset 清除' },
  { key: 'codexAuthSync', configKey: 'codexAuthSync', kind: 'enum', effect: 'next-session', clearable: true, enumValues: ['shared', 'isolated'], hint: 'Codex 鉴权策略：shared=保持旧行为（非沙箱直接使用全局 ~/.codex；沙箱冷启动同步全局 auth 到 per-bot CODEX_HOME）｜isolated=无论是否启用沙箱都使用 per-bot CODEX_HOME，绝不复制全局凭证，需在该目录单独执行 codex login --with-api-key' },
  { key: 'backendType', configKey: 'backendType', kind: 'enum', effect: 'next-session', clearable: true, enumValues: ['pty', 'tmux', 'herdr', 'zellij', 'zmx', 'riff', 'mojo'], hint: '会话后端类型：pty=本地 PTY 子进程（默认）｜tmux=tmux 会话｜herdr=herdr 终端复用｜zellij=zellij 多路复用｜zmx=ZMX >=0.7.0 纯文本持久会话（无 Web TUI）｜riff=远程 riff agent 服务｜mojo=远程 mojo agent（headless mojo CLI）；选 riff 时需配置 riff 字段，mojo 字段可选；unset 回 pty' },
  { key: 'riff', configKey: 'riff', kind: 'json', effect: 'next-session', clearable: true, hint: 'riff 后端配置 JSON（baseUrl/agent/model/jwt 等），仅 backendType=riff 时生效；unset 清除' },
  { key: 'mojo', configKey: 'mojo', kind: 'json', effect: 'next-session', clearable: true, hint: 'mojo 后端配置 JSON，仅 backendType=mojo 时生效，全部可选：cloud/localDaemon/baseUrl/ppeEnv/workspaceId/agentId/idleTimeoutSec/stream/systemPrompt/jwt/jwtEnv/env；model 与二进制路径请用顶层 model / cliPathOverride（写在此处会被拒绝）；unset 清除' },
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
  if (spec.kind === 'boolean') return (spec.defaultOn ? value !== false : value === true) ? 'on' : 'off';
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
  // riff / mojo 配置可含 secret（jwt / env 值）。聊天可见渲染（/config get、配置卡）
  // 与 applyConfigField 的变更日志都走本函数——结构可见、值打码。
  // ⚠️ 漏掉任一个都会让它落进下面的通用 json 分支被 JSON.stringify 原样输出，
  // 即把 jwt 明文发到聊天里。新增带 secret 的后端配置块时必须同步加进来。
  if (spec.configKey === 'riff' || spec.configKey === 'mojo') {
    const obj = value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>) : null;
    if (!obj || Object.keys(obj).length === 0) return '∅';
    return Object.entries(obj).map(([k, v]) => {
      if (k === 'jwt') return 'jwt=••••';
      if (k === 'env') {
        const keys = v && typeof v === 'object' && !Array.isArray(v) ? Object.keys(v as object) : [];
        return `env={${keys.map(x => `${x}=••••`).join(', ')}}`;
      }
      return `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`;
    }).join(', ');
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

// 展示名热更新钩子：daemon 启动时注册。displayName 落盘后立即刷新 dashboard
// descriptor + SessionRow.botName（否则要等重启才换名）。放在 store 层是为了
// 让 /config displayName（IM 路径）和 dashboard PUT 共享同一刷新点。
let displayNameRefresher: (() => void) | null = null;
export function setDisplayNameRefresher(fn: (() => void) | null): void {
  displayNameRefresher = fn;
}

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
  if (spec.configKey === 'pinStreamingCard') {
    return serializePinStreamingCardConfigChange(
      larkAppId,
      () => applyConfigFieldInternal(larkAppId, spec, value),
    );
  }
  return applyConfigFieldInternal(larkAppId, spec, value);
}

async function applyConfigFieldInternal(
  larkAppId: string,
  spec: ConfigFieldSpec,
  value: unknown,
): Promise<ApplyFieldResult> {
  if (spec.kind === 'allowedUsers') return { ok: false, reason: 'use_setBotAllowedUsers' };
  let bot;
  try { bot = getBot(larkAppId); } catch { return { ok: false, reason: 'bot_not_registered' }; }
  const previousPinStreamingCard = spec.configKey === 'pinStreamingCard'
    ? bot.config.pinStreamingCard === true
    : undefined;
  const oldText = formatFieldValue(spec, (bot.config as any)[spec.configKey]);

  // 空数组（stringList 全被过滤）等价清除，bots.json 保持干净。
  const effective = spec.kind === 'stringList' && Array.isArray(value) && value.length === 0 ? null : value;

  const r = await rmwBotEntry<string | null>(larkAppId, (entry) => {
    const currentCliId = typeof entry.cliId === 'string' && entry.cliId.trim()
      ? entry.cliId.trim()
      : bot.config.cliId;
    const nextCliId = spec.configKey === 'cliId' && effective !== null && typeof effective === 'string'
      ? effective.trim()
      : currentCliId;
    const currentModel = typeof entry.model === 'string' && entry.model.trim()
      ? entry.model.trim()
      : undefined;
    const nextModel = spec.configKey === 'model'
      ? typeof effective === 'string' && effective.trim()
        ? effective.trim()
        : undefined
      : currentModel;
    const currentReasoningEffort = isCodexReasoningEffort(entry.reasoningEffort)
      ? entry.reasoningEffort
      : undefined;
    const nextReasoningEffort = spec.configKey === 'reasoningEffort'
      ? effective === null
        ? undefined
        : isCodexReasoningEffort(effective)
          ? effective
          : undefined
      : currentReasoningEffort;
    if (spec.configKey === 'reasoningEffort' && effective !== null
        && (!nextReasoningEffort || !isConfigurableReasoningCliId(nextCliId))) {
      return { write: false, result: 'reasoning_effort_not_supported' };
    }
    if (nextReasoningEffort && isConfigurableReasoningCliId(nextCliId)
        && !cliModelSupportsReasoningEffort(nextCliId, nextModel, nextReasoningEffort)) {
      return { write: false, result: 'reasoning_effort_not_supported_by_model' };
    }
    if (effective === null) {
      delete entry[spec.configKey];
    } else if (spec.kind === 'boolean') {
      // 只持久化「非默认」的一侧，bots.json 保持干净：默认 OFF 的字段 true 才写、
      // false 删 key；默认 ON（defaultOn）的字段 false 才写、true 删 key。
      if (spec.defaultOn) {
        if (effective === false) entry[spec.configKey] = false;
        else delete entry[spec.configKey];
      } else if (effective === true) entry[spec.configKey] = true;
      else delete entry[spec.configKey];
    } else if (spec.kind === 'json') {
      entry[spec.configKey] = effective as any;
    } else {
      entry[spec.configKey] = effective;
    }
    if (spec.configKey === 'cliId' && !isConfigurableReasoningCliId(nextCliId)) {
      delete entry.reasoningEffort;
    }
    return { write: true, result: null };
  });
  if (!r.ok) return { ok: false, reason: r.reason };
  if (r.result) return { ok: false, reason: r.result };

  // 同步内存 config（与 oncall/grant-prefs store 一致，路由/spawn 不重启即生效）。
  if (effective === null) {
    (bot.config as any)[spec.configKey] = undefined;
  } else if (spec.kind === 'boolean') {
    (bot.config as any)[spec.configKey] = spec.defaultOn
      ? (effective === false ? false : undefined)
      : (effective || undefined);
  } else if (spec.kind === 'json') {
    (bot.config as any)[spec.configKey] = effective;
  } else {
    (bot.config as any)[spec.configKey] = effective;
  }
  if (spec.configKey === 'cliId' && !isConfigurableReasoningCliId(String(effective ?? bot.config.cliId))) {
    bot.config.reasoningEffort = undefined;
  }
  const newText = formatFieldValue(spec, (bot.config as any)[spec.configKey]);
  if (spec.configKey === 'feedback') {
    try {
      const path = sendCredFilePath(config.session.dataDir, larkAppId);
      if (existsSync(path)) {
        const cred = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
        if (effective === null || (effective as any)?.enabled !== true) delete cred.feedback;
        else cred.feedback = effective;
        atomicWriteFileSync(path, JSON.stringify(cred), { mode: 0o600 });
      }
    } catch (error) {
      logger.warn(`[config:${larkAppId}] failed to refresh sandbox feedback policy: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (spec.configKey === 'displayName') {
    try { displayNameRefresher?.(); } catch { /* best effort */ }
  }
  if (spec.configKey === 'pinStreamingCard' && previousPinStreamingCard !== undefined) {
    const nextPinStreamingCard = bot.config.pinStreamingCard === true;
    if (previousPinStreamingCard !== nextPinStreamingCard) {
      notifyPinStreamingCardChanged(larkAppId, nextPinStreamingCard);
    }
  }
  logger.info(`[config:${larkAppId}] set ${spec.key}: ${oldText} -> ${newText}`);
  return { ok: true, oldText, newText, effect: spec.effect };
}

export type SetFeedbackPolicyResult = { ok: true } | { ok: false; reason: string };

export async function setBotFeedbackPolicy(larkAppId: string, policy: FeedbackPolicyLayer | null): Promise<SetFeedbackPolicyResult> {
  let normalized: FeedbackPolicyLayer | undefined;
  try { normalized = policy === null ? undefined : normalizeFeedbackPolicyLayer(policy); }
  catch { return { ok: false, reason: 'invalid_policy' }; }
  let bot;
  try { bot = getBot(larkAppId); } catch { return { ok: false, reason: 'bot_not_registered' }; }
  const r = await rmwBotEntry<null>(larkAppId, entry => {
    if (normalized === undefined) delete entry.feedback;
    else entry.feedback = normalized;
    return { write: true, result: null };
  });
  if (!r.ok) return { ok: false, reason: r.reason };
  bot.config.feedback = normalized;
  return { ok: true };
}

export async function setChatFeedbackPolicy(larkAppId: string, chatId: string, policy: FeedbackPolicyLayer | null): Promise<SetFeedbackPolicyResult> {
  let normalized: FeedbackPolicyLayer | undefined;
  try { normalized = policy === null ? undefined : normalizeFeedbackPolicyLayer(policy); }
  catch { return { ok: false, reason: 'invalid_policy' }; }
  let bot;
  try { bot = getBot(larkAppId); } catch { return { ok: false, reason: 'bot_not_registered' }; }
  const r = await rmwBotEntry<null>(larkAppId, entry => {
    const current: Record<string, FeedbackPolicyLayer> = entry.chatFeedbackPolicies && typeof entry.chatFeedbackPolicies === 'object' && !Array.isArray(entry.chatFeedbackPolicies)
      ? { ...entry.chatFeedbackPolicies } : {};
    if (normalized === undefined) delete current[chatId];
    else current[chatId] = normalized;
    if (Object.keys(current).length === 0) delete entry.chatFeedbackPolicies;
    else entry.chatFeedbackPolicies = current;
    return { write: true, result: null };
  });
  if (!r.ok) return { ok: false, reason: r.reason };
  const current = { ...(bot.config.chatFeedbackPolicies ?? {}) };
  if (normalized === undefined) delete current[chatId];
  else current[chatId] = normalized;
  bot.config.chatFeedbackPolicies = Object.keys(current).length ? current : undefined;
  return { ok: true };
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

  const { resolved, map, entryStatus } = await resolveAllowedUsersWithMap(larkAppId, rawEntries);
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
  // Keep the last-known-good sidecar + dashboard descriptor in lockstep with the
  // live allowlist. Without this, a hot `set allowedUsers` (e.g. owner switches
  // from email to on_ while contact API is healthy) leaves the new raw key out
  // of the cache; the next clean restart during an API blip would then resolve
  // empty and fail-closed lock the owner out — the exact bug this feature fixes.
  // retainKeys prunes stale keys (old email/union no longer configured);
  // deleteEntries drops entries that resolved DEFINITIVELY-gone in THIS set (e.g.
  // a removed co-owner) so a later transient restart can't revive them from cache.
  const definitiveEntries: string[] = [];
  let anyTransient = false;
  for (const [entry, status] of entryStatus.entries()) {
    if (status === 'definitive') definitiveEntries.push(entry);
    else if (status === 'transient') anyTransient = true;
  }
  writeAllowedUsersResolveCache(config.session.dataDir, larkAppId, {
    map,
    retainKeys: rawEntries,
    deleteEntries: definitiveEntries,
  });
  republishResolvedAllowedUsersDescriptor(larkAppId, resolved);
  // Partial-transient set: the owner (senderOpenId) resolved (self_lockout guard
  // above guarantees it), but some OTHER entry transient-failed. Schedule the
  // same background heal the startup path uses so that entry recovers when the
  // contact API does, instead of silently staying dropped until the next restart.
  if (anyTransient) scheduleAllowedUsersResolveRetryFromMutation(larkAppId);
  logger.info(`[config:${larkAppId}] allowedUsers updated: ${rawEntries.length} entries, ${resolved.length} resolved`);
  return { ok: true, raw: rawEntries, resolved };
}

export type CoerceResult =
  | { ok: true; value: unknown }
  // A few reasons carry detail (e.g. which keys were rejected), so this is a
  // union of literals plus those prefixed forms rather than a closed literal set.
  | { ok: false; reason: 'invalid_bool' | 'invalid_enum' | 'invalid_cli' | 'invalid_dir' | 'invalid_number' | 'invalid_json' | 'reserved_env' | 'empty' | 'too_long' | `invalid_mojo_config: ${string}` };

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
        if (spec.configKey === 'feedback') {
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, reason: 'invalid_json' };
          if ((parsed as { enabled?: unknown }).enabled !== true) return { ok: true, value: { enabled: false } };
          try { return { ok: true, value: normalizeFeedbackPolicy(parsed) }; }
          catch { return { ok: false, reason: 'invalid_json' }; }
        }
        if (spec.configKey === 'env') {
          // Must be a JSON object; sanitize to valid env keys + primitive values.
          // Reserved keys (CODEX_HOME / GROK_HOME / BOTMUX_* / …) are rejected
          // visibly — silent drop would hide split-brain configs (CLI gets a
          // custom home via injectEnv while daemon paths stay on default).
          // Empty text is handled as "clear" by the caller before coerce.
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, reason: 'invalid_json' };
          const reserved = Object.keys(parsed as Record<string, unknown>)
            .filter((k) => isReservedPerBotEnvKey(k));
          if (reserved.length > 0) return { ok: false, reason: 'reserved_env' };
          const sanitized = sanitizePerBotEnv(parsed);
          return Object.keys(sanitized).length ? { ok: true, value: sanitized } : { ok: false, reason: 'invalid_json' };
        }
        if (spec.configKey === 'mojo') {
          // Same SHARED normalizer as the bots.json parser, so the two config
          // doors cannot drift: unknown keys, internal launch-identity keys and
          // wrong types are all rejected, and the reason is surfaced verbatim.
          const normalized = normalizeMojoConfig(parsed);
          if (!normalized.ok) {
            return { ok: false, reason: `invalid_mojo_config: ${normalized.errors.join('; ')}` };
          }
          return { ok: true, value: normalized.value };
        }
        return { ok: true, value: parsed };
      } catch {
        return { ok: false, reason: 'invalid_json' };
      }
    }
    default: // 'string'
      // 长度上限统一在这里生效（spec.maxLen），dashboard PUT 与 IM /config 两个
      // 入口共用，不再各自分叉校验。
      if (spec.maxLen && s.length > spec.maxLen) return { ok: false, reason: 'too_long' };
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
  /** 私聊单聊模式 p2pMode（'chat' | 'thread' | 'group'）；null = 未设（默认 chat）。 */
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
    botName: cfg.displayName ?? bot.botName ?? cfg.cliId,
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
