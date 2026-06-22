import * as Lark from '@larksuiteoapi/node-sdk';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import type { BackendType } from './adapters/backend/types.js';
import type { CliId } from './adapters/cli/types.js';
import { logger } from './utils/logger.js';
import { isLocale, setBotLookup, type Locale } from './i18n/index.js';
import type { VoiceConfig } from './services/voice/types.js';
import { type Brand, sdkDomain, normalizeBrand } from './im/lark/lark-hosts.js';
import type { BotSkillPolicy, SkillSelector } from './core/skills/types.js';
import { normalizeStartupCommandList } from './core/startup-commands.js';
import { sanitizePerBotEnv } from './core/per-bot-env.js';

export type ChatReplyMode = 'chat' | 'new-topic' | 'shared';

function normalizeChatReplyModeConfig(raw: unknown): ChatReplyMode | undefined {
  if (typeof raw !== 'string') return undefined;
  const v = raw.trim().toLowerCase();
  if (v === 'chat') return 'chat';
  if (v === 'new-topic' || v === 'newtopic' || v === 'thread') return 'new-topic';
  if (v === 'topic' || v === 'shared' || v === 'share' || v === 'alias' || v === 'topic-alias' || v === 'topic_alias') return 'shared';
  return undefined;
}

export interface OncallChat {
  /** Lark chat_id (oc_xxx) the bot was pulled into. */
  chatId: string;
  /** Default working directory used for every new topic spawned in this chat. */
  workingDir: string;
}

/**
 * Per-bot default for new group chats:
 *   - `enabled`     — when true, group chats first observed after `since` are
 *                     auto-bound to oncall on their first new-topic.
 *   - `workingDir`  — the working directory used for the auto-bind. Required
 *                     when enabled (oncall semantics: chatId ↔ workingDir).
 *   - `since`       — epoch ms when the flag was switched on. Used to gate
 *                     "new vs old" against chat-first-seen-store. Chats that
 *                     existed before `since` are left untouched, matching
 *                     "新群聊生效，老群聊不变".
 */
export interface BotDefaultOncall {
  enabled: boolean;
  workingDir: string;
  since: number;
}

export interface BotConfig {
  larkAppId: string;
  larkAppSecret: string;
  /**
   * 租户品牌：`'feishu'`（中国版，open.feishu.cn）或 `'lark'`（国际版，
   * open.larksuite.com）。缺省 / 旧 bots.json 无此字段 → 视为 `'feishu'`
   * （见 {@link normalizeBrand}），向后兼容。决定 SDK Client / WSClient 的
   * domain、所有裸 fetch 的 host、OAuth / applink 深链等——全部从这一个字段
   * 派生（见 im/lark/lark-hosts.ts）。setup 时自动识别后落盘；brand 绑定到
   * 具体 app/租户，不在运行时切换（要换平台 = 重新配/加一个 bot）。
   */
  brand?: Brand;
  /** Optional process-name suffix; the daemon's process name is rendered as `botmux-<name>` (defaults to `botmux-<index>`). */
  name?: string;
  cliId: CliId;
  cliPathOverride?: string;
  /**
   * 通用启动前缀（按空格拆 token）：worker spawn 时把启动命令拼成
   * `<wrapperCli> <CLI 参数>`（首 token 当 bin 走 PATH 解析），无需 wrapper 脚本、跨系统。
   * 典型值 `"aiden x claude"` / `"aiden x codex"`（内网网关 aiden-aiproxy + SSO），也能
   * 承载 ccr / claude-w 等任意启动器。`cliId` 仍是底层适配器（claude→claude-code、
   * codex→codex），所有适配器机制（hook / bridge / resume）照常工作；设了 wrapperCli 后
   * 它的首 token 取代 cliId 的默认 bin（cliPathOverride 不再生效）。检测到前缀是
   * `aiden x claude` 时自动剥掉 aiden 拒收的 --settings。见 src/setup/cli-selection.ts。
   */
  wrapperCli?: string;
  /**
   * Optional model name passed to the CLI at spawn time (e.g. `claude --model
   * opus`). Each adapter decides how to inject it — adapters whose CLI has no
   * `--model` flag silently ignore the field. When unset, the CLI uses its own
   * default model. Multiple bots sharing the same `cliId` can therefore run
   * different models without resorting to wrapper scripts. See each adapter's
   * `modelChoices` for the curated candidates surfaced in `botmux setup`.
   */
  model?: string;
  /**
   * If true, botmux does not add CLI-default approval/sandbox bypass flags
   * such as --yolo or --dangerously-*. Missing/false preserves legacy behavior.
   */
  disableCliBypass?: boolean;
  /**
   * Run this bot's CLI inside a per-session file sandbox (bubblewrap, Linux):
   * the agent sees only a clone of the project + a de-identified config dir,
   * never the host home/secrets/other sessions. Intended for oncall bots shared
   * with semi-trusted users. Linux-only; ignored elsewhere. Env BOTMUX_SANDBOX=1
   * forces it on regardless (testing).
   */
  sandbox?: boolean;
  /**
   * Per-bot privacy masks for the sandbox: absolute paths blanked inside the
   * overlay sandbox (dirs → empty tmpfs; files → empty placeholder). OPT-IN with
   * NO defaults — the agent reads the entire real fs natively unless a path is
   * listed here. Only meaningful when `sandbox` is true. Linux-only.
   */
  sandboxHidePaths?: string[];
  backendType?: BackendType;
  /**
   * Max simultaneously-LIVE sessions for this bot. When the bot's live session
   * count exceeds this, the idle-worker sweeper suspends its longest-idle,
   * not-currently-busy sessions (resumable backends only) down to the cap — the
   * worker AND the CLI are killed to reclaim memory, and the session
   * cold-resumes from its on-disk transcript on the next message. Unset → the
   * built-in default {@link DEFAULT_MAX_LIVE_WORKERS} (30); an explicit positive
   * integer overrides it. Pure count-based: there is NO idle-time threshold.
   * Configured per bot from the dashboard (Groups & Bots → bot card). Adopted
   * sessions are never suspended. See core/idle-worker-sweeper.ts.
   */
  maxLiveWorkers?: number;
  workingDir?: string;
  workingDirs?: string[];
  allowedUsers?: string[];
  allowedChatGroups?: string[];
  /** Oncall bindings: chat_id → default workingDir. Any group member can talk; allowedUsers still gates card buttons / daemon commands. */
  oncallChats?: OncallChat[];
  /** UI language for this bot: 'zh' or 'en'. Falls back to BOTMUX_LANG / LANG env when unset. */
  lang?: Locale;
  /**
   * Per-bot default working directory. When set, new topics that have no
   * oncall binding and no sibling-session inheritance skip the repo-select
   * card and spawn the CLI directly in this directory. `/cd <path>` still
   * works to switch mid-session; the next new topic falls back to this default.
   *
   * Pure runtime fallback — does NOT write any state to bots.json and does
   * NOT change the canTalk / canOperate permission model (unlike defaultOncall).
   */
  defaultWorkingDir?: string;
  /** Per-bot default: auto-bind every new group chat to oncall on first new-topic. */
  defaultOncall?: BotDefaultOncall;
  /**
   * Chat IDs that have ever been auto-bound by `defaultOncall`. Append-only.
   * Once a chat appears here, the default is permanently "spent" for it — even
   * if the user later unbinds via Groups & Bots / `/oncall unbind`, the
   * default will not re-bind it. This preserves the manual-override semantics
   * Codex flagged in review.
   */
  defaultOncallAutoboundChats?: string[];
  /** Per-chat reply mode: chat_id → 普通群 @bot 后回复形态。缺省为 chat（保持现状）。 */
  chatReplyModes?: { [chatId: string]: ChatReplyMode };
  /** Per-chat per-user grants: chat_id → 被授权的 open_id 列表。仅放行 canTalk，不给管理命令权。 */
  chatGrants?: { [chatId: string]: string[] };
  /**
   * 全局对话授权名单：被授权在**任意群**与本 bot 对话的 open_id 列表（人或 bot 通用）。
   * 与 chatGrants 同属 talk-only —— 仅放行 canTalk / bot 路由闸，**canOperate 绝不读它**
   * （敏感操作仍仅限 allowedUsers）。这是 chatGrants 的全局版：作用域升到全局，talk-only
   * 性质不变。可由 /grant 卡片「全局」按钮写入，也可在 bots.json 手配 open_id。
   */
  globalGrants?: string[];
  /**
   * 消息额度机制（默认关闭）。`defaultLimit` 的"是否配置"本身就是开关：
   *   • 未配置（undefined）→ 关闭：无显式数字的 /grant 仍是"无限授权"（当前行为）。
   *   • 配置正整数 D    → 开启默认额度：`/grant @x`（不带数字）套用 D 条额度。
   * 显式 `/grant @x N` 的 N **恒生效**，与本字段是否配置无关（见 {@link quotaState}）。
   * 仅约束 chatGrants / globalGrants 这类 per-user talk 授权，绝不影响 canOperate。
   */
  messageQuota?: { defaultLimit?: number };
  /**
   * scope-aware 消息额度计数（运行时状态，随授权一起持久化进 bots.json）。
   * key = `chat:${chatId}:${openId}` | `global:${openId}`，value = { limit, used }。
   * 仅在 /grant 带额度（显式数字，或开启 default 时取 default）时建记录；
   * used 达到 limit 后自动收回**对应 scope** 的授权并删除本记录。纯 talk-only。
   */
  quotaState?: { [quotaKey: string]: { limit: number; used: number } };
  /**
   * 开启后：仅靠 per-user 授权（chatGrants / globalGrants）放行的发送者，禁止使用**任何
   * 斜杠命令**——botmux 自身的 DAEMON 命令、透传（PASSTHROUGH）命令、全部 `/workflow`
   * 子命令、`/introduce`、`/t`/`/topic` —— 只能普通对话。owner / allowedUsers / oncall /
   * allowedChatGroup 整群成员不受影响。判定以 slash-command invocation 命中为准（不是"凡以
   * `/` 开头的文本"，避免误伤讨论命令用法的普通对话）。默认 false（保持现状：被授权人可用透传）。
   */
  restrictGrantCommands?: boolean;
  /**
   * 用户自定义、额外放行透传给 CLI 的 slash 命令 —— 在固定的 PASSTHROUGH_COMMANDS
   * 之上扩展（例如把 CLI 支持但默认不放行的 `/goal`、`/export` 加进来）。每项必须
   * `/` 开头、小写、仅含 [a-z0-9:_-]；解析时归一化（缺失的 `/` 自动补、转小写、去重、
   * 丢弃非法项与会遮蔽 botmux daemon 命令的项）。与内置白名单合并后由
   * {@link resolvePassthroughCommands} 生效；`/list-slash-command` 可查看完整放行清单。
   * 未配置（undefined）→ 仅用内置白名单（保持现状）。
   */
  customPassthroughCommands?: string[];
  /**
   * Optional per-bot startup commands: slash-command lines the worker types into
   * a freshly spawned CLI right after it's ready, BEFORE the user's first prompt
   * (e.g. `/effort ultracode`, `/model opus`). Sent in order, one submit each,
   * via the same literal-input path as a passthrough slash command (no prompt
   * wrapping). Re-applied on every fresh spawn (incl. resume) — so session-only
   * settings like `/effort ultracode` survive a resume. Skipped in adopt mode
   * (we observe the user's existing session, not drive a fresh one). Each entry
   * is trimmed and gets a leading `/` if missing; arguments (spaces) preserved.
   */
  startupCommands?: string[];
  /**
   * Optional per-bot environment variables, injected into THIS bot's CLI
   * process (e.g. `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` to run the bot
   * on GLM / a third-party Anthropic-compatible provider, an `HTTPS_PROXY`, or
   * a CLI feature flag). Sanitized at load via {@link sanitizePerBotEnv}
   * (valid env-var names + string/number/boolean values; botmux-reserved keys
   * dropped). Delivered per-session as SpawnOpts.injectEnv so it never pollutes
   * the shared tmux/zellij server env. Missing/empty → undefined.
   */
  env?: Record<string, string>;
  /**
   * Optional per-bot priority skill policy. Missing means botmux does not alter
   * the underlying CLI's native skill discovery or spawn arguments.
   */
  skills?: BotSkillPolicy;
  /**
   * Custom footer brand label for cards this bot sends. Three states:
   *   • `undefined` (unset)  → default `[botmux](github)` link
   *   • `''` (empty)         → brand suppressed (footer shows only 发送给 if any)
   *   • any other string     → rendered verbatim (markdown allowed)
   * Resolved via {@link resolveBrandLabel}. Pure cosmetic — does not affect
   * routing or permissions.
   */
  brandLabel?: string;
  /**
   * When true, suppress the live streaming session card entirely. The web
   * terminal still runs and the final answer still arrives via `botmux send`;
   * only the auto-updating status card is never posted/patched. Default
   * (undefined) keeps the streaming card. For users who find the live card noisy.
   */
  disableStreamingCard?: boolean;
  /**
   * Conversation mode for 1:1 private chats (DMs) with the bot:
   *   - 'thread' (default, stored as undefined): every top-level DM message
   *     starts a fresh thread-scoped session — the official/legacy behavior,
   *     keeps 1:1 chatter out of one long-running CLI process.
   *   - 'chat': route DMs as one flat, continuous chat-scoped session (all
   *     messages share the same context, similar to Hermes/OpenClaw).
   * Editable at runtime via `/botconfig p2pMode chat|thread` (owner/admin).
   */
  p2pMode?: 'thread' | 'chat';
  /** chat_id list: chats where the live streaming card is suppressed (status falls back to master's pending-card morph). Written by `/card off|on`. */
  noCardChats?: string[];
  /**
   * When true, the streaming card embeds a directly-usable WRITABLE terminal
   * link in its body (token included → anyone who can see the card can drive
   * the terminal). Default (undefined) keeps the write link behind the
   * "get write link" button, which DMs it privately to the clicker. Moot when
   * {@link disableStreamingCard} is on (no card to embed it in).
   */
  writableTerminalLinkInCard?: boolean;
  /**
   * When true, `/card` sends a **private** static snapshot card via the ephemeral
   * API, visible only to the bot's `allowedUsers` (owner / co-owners), instead of
   * the group-visible live streaming card. Talk-only grants (globalGrants /
   * chatGrants) and a bare triggerer do NOT receive it — it's owner-only. Only
   * works in plain `group` chats (topic/thread/p2p fail closed) and cannot
   * live-update (ephemeral cards can't be patched). Scoped to the `/card` command
   * only — the auto streaming card is unaffected. Default (undefined) keeps
   * `/card` group-visible & live.
   */
  privateCard?: boolean;
  /**
   * 主动开工 — 场景①. When true, the bot auto-starts a session when it is added
   * to a new chat that contains at least one of its allowedUsers (see
   * docs/specs/20260529-proactive-auto-start/). Default (undefined) = passive
   * (only spawns on @mention). Requires the `im.chat.member.bot.added_v1` event
   * to be subscribed for the app in the Feishu console.
   */
  autoStartOnGroupJoin?: boolean;
  /**
   * 主动开工 — 场景① optional pre-configured first-turn prompt. When set, it
   * becomes the user_message of the auto-started session; when unset/blank the
   * session starts with an empty user_message and the bot reads the group
   * context itself. Moot when {@link autoStartOnGroupJoin} is off.
   */
  autoStartOnGroupJoinPrompt?: string;
  /**
   * 主动开工 — 场景②. When true, in a 话题群 (topic mode) every new topic's first
   * message auto-starts a session even without an @mention (the default role +
   * the user's first message form the prompt). No effect in regular groups.
   * Default (undefined) = passive.
   */
  autoStartOnNewTopic?: boolean;
  /**
   * Worktree picker mode on the repo-select card. When true, the worktree
   * control renders the multi-repo selector (pick N repos + branch) instead of
   * the single-select dropdown. Toggled from the card's 「切换多仓库选择器」button;
   * persists so all of this bot's future sessions default to it. Default false.
   */
  worktreeMultiPicker?: boolean;
  /**
   * Per-bot DEFAULT session mode for regular Lark groups (overridable per-chat
   * via `/reply-mode` → `chatReplyModes`). Resolved by
   * `chat-reply-mode-store.regularGroupDefaultMode`.
   *   • 'chat' (or undefined) — whole group shares one flat chat-scope session
   *   • 'new-topic'           — each top-level @mention forks its own thread-scope session
   *   • 'shared'              — replies fold into a topic but reuse the one chat-scope session
   */
  regularGroupReplyMode?: ChatReplyMode;
  /**
   * Per-bot (bot-global) policy for when an @mention is required to get a reply
   * in regular Lark groups — a 3-tier ladder:
   *   • 'always' (or undefined) — @ required everywhere, including inside the
   *                               bot's own shared topics (the safe default).
   *   • 'topic'                 — @ required to start / at top level, but NOT
   *                               inside the bot's shared topics (non-@ replies
   *                               there continue the session).
   *   • 'never'                 — @ never required: non-@ messages in groups
   *                               where the bot has talk access are answered too.
   * Governs the shared-topic fold-back + the top-level @ gate. `new-topic` /
   * 话题群 topics own their own thread and continue without @ regardless (that
   * is the mode's defining behavior, not affected by this policy).
   */
  regularGroupMentionMode?: 'always' | 'topic' | 'never';
  /**
   * 飞书文档订阅入口（/subscribe-lark-doc）新订阅的默认评论触发范围：
   *   • 'mention-only'（或 undefined）— 仅评论里 @bot 才触发（默认，防噪声）
   *   • 'all'                        — 该文档所有新评论都触发
   * 单条订阅的触发范围之后可在 dashboard 逐文档改（doc-subscriptions 表）。
   */
  docSubscribeDefaultMode?: 'mention-only' | 'all';
  /**
   * Per-bot voice-engine override for the voice-summary feature. Merged OVER
   * the global `voice` block in ~/.botmux/config.json (per-bot wins field by
   * field). When this bot has usable voice creds (here or globally), its reply
   * cards render the "🔊 语音总结" button. See services/voice/types.ts.
   */
  voice?: VoiceConfig;
}

export interface BotState {
  config: BotConfig;
  client: Lark.Client;
  botOpenId?: string;
  botName?: string;       // Lark app display name (from /bot/v3/info)
  botAvatarUrl?: string;  // Lark app avatar URL (from /bot/v3/info)
  resolvedAllowedUsers: string[];
  /** raw allowedUsers 条目 → 解析后的 open_id。供 /revoke 反查并删除 email 形式的 raw 条目。 */
  rawAllowedUserResolution: Map<string, string>;
}

const bots = new Map<string, BotState>();

// Wire the i18n lookup so `localeForBot()` can resolve per-bot locale without
// a hard import cycle between `i18n` and `bot-registry`.
setBotLookup((id) => bots.get(id));

/** Path of the bot config file we loaded (so `/oncall` can persist bindings back). */
let loadedConfigPath: string | undefined;
export function getLoadedConfigPath(): string | undefined {
  return loadedConfigPath;
}

// Route Lark SDK output through our logger so it inherits the same sink
// rules (info/debug → daemon.log in daemon mode, → stderr in CLI mode,
// dropped when CLI is silent). The default SDK logger calls console.log,
// which would corrupt CLI stdout consumers.
//
// Volume control: the SDK is chatty at info/debug ("client ready", request
// traces, etc.); without DEBUG=1 those become no-ops in the CLI path and
// stay in daemon.log on the daemon path — pm2's error.log no longer sees
// "[lark:info] client ready" floods.
// Cap raw dumps so an unrecognized error shape can never flood the log the way
// the SDK's full AxiosError blob (stack + config + headers) did — that bloated
// pm2's error.log past 1GB and, worse, leaked the `Authorization: Bearer t-…`
// access token on every request failure.
const MAX_FALLBACK_LEN = 300;
function safeStringify(v: unknown): string {
  if (typeof v === 'string') return v;
  let s: string;
  try { s = JSON.stringify(v) ?? String(v); } catch { s = String(v); }
  return s.length > MAX_FALLBACK_LEN ? `${s.slice(0, MAX_FALLBACK_LEN)}…(+${s.length - MAX_FALLBACK_LEN})` : s;
}

// Drop the protocol+host (and `/open-apis/` prefix) so the line shows just the
// API path that matters for triage, never the bearer token in the URL/headers.
function shortLarkPath(url: unknown): string {
  if (typeof url !== 'string' || !url) return '';
  const path = url.replace(/^https?:\/\/[^/]+/, '').replace(/^\/open-apis\//, '');
  return path || url;
}

/**
 * Condense a Lark SDK error into one readable line, preserving just the fields
 * needed to triage (HTTP status + business `code`/`msg`/`log_id`). Returns null
 * when the value isn't an axios-shaped error, so callers fall back to
 * length-capped stringify. Never serializes `config`/`headers`/`stack`, so the
 * access token can't leak.
 */
export function formatLarkError(v: any): string | null {
  if (!v || typeof v !== 'object') return null;
  const isAxios = v.isAxiosError === true || v.name === 'AxiosError' || (v.config && (v.response || v.status != null));
  if (!isAxios) return null;
  const method = String(v.config?.method ?? '').toUpperCase();
  const path = shortLarkPath(v.config?.url);
  const httpStatus = v.response?.status ?? v.status;
  // Lark business error lives in the response body; some shapes surface it on
  // the error object directly.
  const data = v.response?.data ?? {};
  const code = data.code ?? v.code;
  const msg = data.msg ?? v.msg;
  const logId = data.log_id ?? data.logId;
  const parts: string[] = [];
  if (method) parts.push(method);
  if (path) parts.push(path);
  if (httpStatus != null || method || path) parts.push(`→ ${httpStatus ?? '?'}`);
  if (typeof code === 'number') parts.push(`code=${code}`);
  if (typeof msg === 'string' && msg) parts.push(`"${msg}"`);
  if (logId) parts.push(`log_id=${logId}`);
  if (!parts.length) return null;
  return parts.join(' ');
}

const fmtLark = (msg: any[]) => msg.map((m) => formatLarkError(m) ?? safeStringify(m)).join(' ');
const larkLogger = {
  // SDK request failures arrive here as raw AxiosError objects — condense to a
  // single triage line (status + lark code/msg/log_id) instead of dumping the
  // stack/config blob. Demoted to warn: nearly all are environmental and already
  // handled at the call site (rate limits, bot-not-in-chat, stale threads).
  error: (...msg: any[]) => logger.warn(`[lark] ${fmtLark(msg)}`),
  warn:  (...msg: any[]) => logger.warn(`[lark] ${fmtLark(msg)}`),
  info:  (...msg: any[]) => logger.info(`[lark] ${fmtLark(msg)}`),
  debug: (...msg: any[]) => logger.debug(`[lark] ${fmtLark(msg)}`),
  trace: (..._msg: any[]) => { /* SDK trace dropped entirely — uninteresting per-byte WS frames */ },
};

export function registerBot(cfg: BotConfig): BotState {
  const client = new Lark.Client({
    appId: cfg.larkAppId,
    appSecret: cfg.larkAppSecret,
    // brand → SDK domain。缺省走 feishu，国际版租户走 larksuite.com。
    // 这一行同时修好了所有经由 SDK 的调用（发消息 / 文件 / contact 等）。
    domain: sdkDomain(normalizeBrand(cfg.brand)),
    logger: larkLogger,
  });
  const state: BotState = {
    config: cfg,
    client,
    resolvedAllowedUsers: [...(cfg.allowedUsers ?? [])],
    rawAllowedUserResolution: new Map(),
  };
  bots.set(cfg.larkAppId, state);
  return state;
}

export function getBot(larkAppId: string): BotState {
  const state = bots.get(larkAppId);
  if (!state) {
    throw new Error(`Bot not registered: ${larkAppId}`);
  }
  return state;
}

export function getBotClient(larkAppId: string): Lark.Client {
  return getBot(larkAppId).client;
}

/** Owner = bot 首个已授权 open_id，与「缺权限警告私信对象」同口径（见 admin 解析）。 */
export function getOwnerOpenId(larkAppId: string): string | undefined {
  return bots.get(larkAppId)?.resolvedAllowedUsers.find(u => u.startsWith('ou_'));
}

/** Bot 自身的 open_id（用于在 mention 解析时排除自己）。 */
export function getBotOpenId(larkAppId: string): string | undefined {
  return bots.get(larkAppId)?.botOpenId;
}

/**
 * 安全地按 appId 取 brand。未注册（如跨进程 dashboard 聚合到别的 daemon 的
 * 会话）→ 归一为 'feishu'。仅用于派生 applink 等 host，缺省 feishu 安全。
 */
export function getBotBrand(larkAppId: string | undefined): Brand {
  return normalizeBrand(larkAppId ? bots.get(larkAppId)?.config.brand : undefined);
}

export function getAllBots(): BotState[] {
  return Array.from(bots.values());
}

/** Lookup the oncall binding for a given bot+chat, if any. */
export function findOncallChat(larkAppId: string, chatId: string): OncallChat | undefined {
  const bot = bots.get(larkAppId);
  return bot?.config.oncallChats?.find(c => c.chatId === chatId);
}

// Cross-bot oncall chat discovery — cached by config-file mtime.
//
// /oncall bind is per-bot for talk authorization: receiving-bot gates must use
// findOncallChat(larkAppId, chatId). This cross-bot lookup remains for paths
// that need deployment-wide discovery/inheritance, such as pinned working-dir
// resolution and default-oncall checks.
//
// Multi-daemon deployments run one bot per process, so the in-memory `bots`
// map only sees this daemon's own bot — sibling bots' bindings live only on
// disk in the shared bots.json. Re-read that file lazily, keyed by mtime,
// so the hot path is a single stat() once the cache is warm.
let oncallChatCache: { mtimeMs: number; chats: Map<string, OncallChat> } | null = null;

export function findOncallChatForAnyBot(chatId: string): OncallChat | undefined {
  // Fast path: this daemon's own bot(s). Covers single-daemon setups and any
  // case where the receiving bot itself is bound.
  for (const bot of bots.values()) {
    const entry = bot.config.oncallChats?.find(c => c.chatId === chatId);
    if (entry) return entry;
  }
  // Slow path: scan the shared bots.json for sibling bots' bindings.
  const path = loadedConfigPath;
  if (!path) return undefined;
  try {
    const stat = statSync(path);
    if (!oncallChatCache || oncallChatCache.mtimeMs !== stat.mtimeMs) {
      const raw = JSON.parse(readFileSync(path, 'utf-8'));
      const chats = new Map<string, OncallChat>();
      if (Array.isArray(raw)) {
        for (const entry of raw) {
          if (!Array.isArray(entry?.oncallChats)) continue;
          for (const c of entry.oncallChats) {
            if (c && typeof c.chatId === 'string' && typeof c.workingDir === 'string') {
              chats.set(c.chatId, { chatId: c.chatId, workingDir: c.workingDir });
            }
          }
        }
      }
      oncallChatCache = { mtimeMs: stat.mtimeMs, chats };
    }
    return oncallChatCache.chats.get(chatId);
  } catch {
    return undefined;
  }
}

export function isChatOncallBoundForAnyBot(chatId: string): boolean {
  return !!findOncallChatForAnyBot(chatId);
}

// Per-bot brand label, mtime-cached for the disk fallback. Keyed by larkAppId →
// the configured value (undefined when the bot has no brandLabel key).
let brandLabelCache: { mtimeMs: number; map: Map<string, string | undefined> } | null = null;

/** Resolve the bots.json path the same way loadBotConfigs does, without
 *  requiring the registry to have been loaded (works in one-shot CLI processes
 *  like `botmux send`). Returns null when no config file exists. */
function botsConfigDiskPath(): string | null {
  const env = process.env.BOTS_CONFIG;
  if (env) { const r = resolve(env); return existsSync(r) ? r : null; }
  const d = resolve(homedir(), '.botmux', 'bots.json');
  return existsSync(d) ? d : null;
}

/**
 * The configured brand label for a bot, or `undefined` when unset (`''` = off
 * is preserved). Prefers the in-memory registry (daemon hot path); falls back
 * to a mtime-cached read of bots.json so the CLI process — which never loads
 * the registry — still resolves the sending bot's brand. Callers feed the
 * result into {@link brandFooterSegment} for the unset→default / ''→off rule.
 */
export function resolveBrandLabel(larkAppId: string): string | undefined {
  const inMem = bots.get(larkAppId);
  if (inMem) return inMem.config.brandLabel;
  const path = loadedConfigPath ?? botsConfigDiskPath();
  if (!path) return undefined;
  try {
    const stat = statSync(path);
    if (!brandLabelCache || brandLabelCache.mtimeMs !== stat.mtimeMs) {
      const raw = JSON.parse(readFileSync(path, 'utf-8'));
      const map = new Map<string, string | undefined>();
      if (Array.isArray(raw)) {
        for (const e of raw) {
          if (e && typeof e.larkAppId === 'string') {
            map.set(e.larkAppId, typeof e.brandLabel === 'string' ? e.brandLabel : undefined);
          }
        }
      }
      brandLabelCache = { mtimeMs: stat.mtimeMs, map };
    }
    return brandLabelCache.map.get(larkAppId);
  } catch {
    return undefined;
  }
}

/**
 * Load bot configurations from one of (in priority order):
 * 1. BOTS_CONFIG env var — path to a JSON file
 * 2. ~/.botmux/bots.json — default config path
 */
export function loadBotConfigs(): BotConfig[] {
  // 1. BOTS_CONFIG env var
  const botsConfigPath = process.env.BOTS_CONFIG;
  if (botsConfigPath) {
    const resolved = resolve(botsConfigPath);
    if (!existsSync(resolved)) {
      throw new Error(`BOTS_CONFIG file not found: ${resolved}`);
    }
    loadedConfigPath = resolved;
    return parseBotConfigFile(resolved);
  }

  // 2. ~/.botmux/bots.json
  const defaultPath = resolve(homedir(), '.botmux', 'bots.json');
  if (existsSync(defaultPath)) {
    loadedConfigPath = defaultPath;
    return parseBotConfigFile(defaultPath);
  }

  throw new Error(
    'No bot configuration found. Set BOTS_CONFIG or create ~/.botmux/bots.json.\nSee README for config format.'
  );
}

function parseBotConfigFile(filePath: string): BotConfig[] {
  const raw = readFileSync(filePath, 'utf-8');
  try {
    return parseBotConfigsFromText(raw);
  } catch (err: any) {
    // Preserve the file path in JSON-parse / shape errors for easier debugging.
    throw new Error(`${err?.message ?? err} (file: ${filePath})`);
  }
}

/** Pure parser: bots.json text → BotConfig[]. Exported for testing & reuse. */
export function parseBotConfigsFromText(jsonText: string): BotConfig[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new Error(`Invalid JSON in bot config file`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error(`Bot config file must contain a JSON array`);
  }

  const configs: BotConfig[] = [];
  for (let i = 0; i < parsed.length; i++) {
    const entry = parsed[i];
    if (!entry.larkAppId || typeof entry.larkAppId !== 'string') {
      throw new Error(`Bot config [${i}]: larkAppId is required and must be a string`);
    }
    if (!entry.larkAppSecret || typeof entry.larkAppSecret !== 'string') {
      throw new Error(`Bot config [${i}]: larkAppSecret is required and must be a string`);
    }

    // Parse workingDirs from comma-separated workingDir if workingDirs not explicitly set
    let workingDirs = entry.workingDirs;
    if (!workingDirs && entry.workingDir) {
      workingDirs = String(entry.workingDir).split(',').map((s: string) => s.trim()).filter(Boolean);
    }

    let oncallChats: OncallChat[] | undefined;
    if (Array.isArray(entry.oncallChats)) {
      oncallChats = entry.oncallChats
        .filter((c: any) => c && typeof c.chatId === 'string' && typeof c.workingDir === 'string')
        .map((c: any) => ({
          chatId: c.chatId,
          workingDir: c.workingDir,
        }));
    }

    let allowedChatGroups: string[] | undefined;
    if (Array.isArray(entry.allowedChatGroups)) {
      allowedChatGroups = entry.allowedChatGroups
        .filter((x: any): x is string => typeof x === 'string' && x.trim().length > 0)
        .map((x: string) => x.trim());
    }

    // defaultOncall: per-bot default for auto-binding new group chats.
    // Tolerate missing fields: an entry with `enabled:true` but no workingDir
    // is treated as disabled (dashboard PUT enforces workingDir on save, but
    // hand-edited bots.json could be inconsistent — never crash on parse).
    let defaultOncall: BotDefaultOncall | undefined;
    const rawDefault = entry.defaultOncall;
    if (rawDefault && typeof rawDefault === 'object') {
      const enabled = rawDefault.enabled === true;
      const workingDir = typeof rawDefault.workingDir === 'string' ? rawDefault.workingDir : '';
      const since = typeof rawDefault.since === 'number' && Number.isFinite(rawDefault.since)
        ? rawDefault.since
        : 0;
      defaultOncall = { enabled: enabled && !!workingDir, workingDir, since };
    }

    let defaultOncallAutoboundChats: string[] | undefined;
    if (Array.isArray(entry.defaultOncallAutoboundChats)) {
      defaultOncallAutoboundChats = entry.defaultOncallAutoboundChats
        .filter((x: any): x is string => typeof x === 'string');
    }

    // chatReplyModes：只保留每群显式设置，非法值丢弃。三态 chat｜new-topic｜
    // shared 都保留解析；写入路径会删除「与 per-bot 默认相同」的条目以保持
    // bots.json 干净（见 chat-reply-mode-store.setChatReplyMode）。
    let chatReplyModes: { [chatId: string]: ChatReplyMode } | undefined;
    if (entry.chatReplyModes && typeof entry.chatReplyModes === 'object' && !Array.isArray(entry.chatReplyModes)) {
      const out: { [chatId: string]: ChatReplyMode } = {};
      for (const [cid, mode] of Object.entries(entry.chatReplyModes)) {
        if (typeof cid !== 'string' || !cid.trim()) continue;
        const normalizedMode = normalizeChatReplyModeConfig(mode);
        if (normalizedMode) out[cid] = normalizedMode;
      }
      if (Object.keys(out).length > 0) chatReplyModes = out;
    }

    // chatGrants：只保留 { [chatId:string]: string[] }，逐项校验 typeof === 'string'，
    // 丢弃空列表。未配置或全部非法 → undefined。
    let chatGrants: { [chatId: string]: string[] } | undefined;
    if (entry.chatGrants && typeof entry.chatGrants === 'object' && !Array.isArray(entry.chatGrants)) {
      const out: { [chatId: string]: string[] } = {};
      for (const [cid, arr] of Object.entries(entry.chatGrants)) {
        if (!Array.isArray(arr)) continue;
        const ids = (arr as any[]).filter((x): x is string => typeof x === 'string');
        if (ids.length > 0) out[cid] = ids;
      }
      if (Object.keys(out).length > 0) chatGrants = out;
    }

    // globalGrants：只保留非空 string[]（open_id 列表），逐项校验 typeof === 'string'。
    // 未配置或全部非法 → undefined。
    let globalGrants: string[] | undefined;
    if (Array.isArray(entry.globalGrants)) {
      const ids = (entry.globalGrants as any[]).filter((x): x is string => typeof x === 'string' && x.trim().length > 0);
      if (ids.length > 0) globalGrants = ids;
    }

    // messageQuota.defaultLimit：仅保留正整数；非法/缺省 → undefined（= 默认额度关闭）。
    let messageQuota: { defaultLimit?: number } | undefined;
    const rawMq = entry.messageQuota;
    if (rawMq && typeof rawMq === 'object' && !Array.isArray(rawMq)) {
      const d = rawMq.defaultLimit;
      if (typeof d === 'number' && Number.isInteger(d) && d > 0) messageQuota = { defaultLimit: d };
    }

    // quotaState：scope-aware 计数。逐项校验 key 形如 `chat:*:*` / `global:*`，
    // value 为 { limit, used } 正整数（used 允许 0）。非法项丢弃；全空 → undefined。
    let quotaState: { [k: string]: { limit: number; used: number } } | undefined;
    if (entry.quotaState && typeof entry.quotaState === 'object' && !Array.isArray(entry.quotaState)) {
      const out: { [k: string]: { limit: number; used: number } } = {};
      for (const [k, v] of Object.entries(entry.quotaState)) {
        if (!/^(chat:.+:.+|global:.+)$/.test(k)) continue;
        if (!v || typeof v !== 'object') continue;
        const limit = (v as any).limit, used = (v as any).used;
        if (typeof limit !== 'number' || !Number.isInteger(limit) || limit <= 0) continue;
        if (typeof used !== 'number' || !Number.isInteger(used) || used < 0) continue;
        out[k] = { limit, used };
      }
      if (Object.keys(out).length > 0) quotaState = out;
    }

    // customPassthroughCommands：用户额外放行透传的 slash 命令。归一化：转小写、
    // 自动补前导 `/`、按 /^\/[a-z0-9][a-z0-9:_-]*$/ 过滤、去重。非法/缺省 → undefined。
    // 注意：与 daemon 命令的冲突过滤放在 resolvePassthroughCommands（运行时合并）做，
    // 这里只保证条目本身格式合法，避免在解析期耦合 command-handler 的命令清单。
    let customPassthroughCommands: string[] | undefined;
    if (Array.isArray(entry.customPassthroughCommands)) {
      const normalized = entry.customPassthroughCommands
        .filter((x: any): x is string => typeof x === 'string')
        .map((x: string) => x.trim().toLowerCase())
        .map((x: string) => (x.startsWith('/') ? x : `/${x}`))
        .filter((x: string) => /^\/[a-z0-9][a-z0-9:_-]*$/.test(x));
      const uniq = [...new Set<string>(normalized)];
      if (uniq.length > 0) customPassthroughCommands = uniq;
    }

    // startupCommands：开会话后、首条 prompt 前自动敲进 CLI 的 slash 命令行（可带
    // 参数，如 `/effort ultracode`）。归一化：去多余空白、补前导 `/`、去重；空 →
    // undefined（与 customPassthroughCommands 同款"不写空数组保持干净"）。
    const startupCommandsList = normalizeStartupCommandList(entry.startupCommands);
    const startupCommands = startupCommandsList.length > 0 ? startupCommandsList : undefined;

    // env：per-bot 环境变量（如代理 / 第三方服务商端点 ANTHROPIC_BASE_URL+AUTH_TOKEN）。
    // sanitizePerBotEnv 过滤非法/保留键、字符串化基本类型；空 → undefined（保持 bots.json 干净）。
    const sanitizedEnv = sanitizePerBotEnv(entry.env);
    const env = Object.keys(sanitizedEnv).length > 0 ? sanitizedEnv : undefined;

    const skills = readBotSkillPolicy(entry.skills);

    // voice：per-bot 语音引擎覆盖。结构化保留（engine ∈ sami|openai，sami/openai
    // 为对象，speaker/rate 透传）；非对象或 engine 非法 → undefined。深度校验
    // （凭证是否可用）在 resolveVoiceConfig 做，这里只挡明显垃圾。
    let voice: VoiceConfig | undefined;
    const rawVoice = entry.voice;
    if (rawVoice && typeof rawVoice === 'object' && !Array.isArray(rawVoice)) {
      const eng = (rawVoice as any).engine;
      if (eng === undefined || eng === 'sami' || eng === 'openai') {
        const v: VoiceConfig = {};
        if (eng) v.engine = eng;
        if (typeof (rawVoice as any).speaker === 'string') v.speaker = (rawVoice as any).speaker;
        if (typeof (rawVoice as any).rate === 'number') v.rate = (rawVoice as any).rate;
        const s = (rawVoice as any).sami;
        if (s && typeof s === 'object') v.sami = { accessKey: s.accessKey, secretKey: s.secretKey, appkey: s.appkey, tokenUrl: s.tokenUrl, wsUrl: s.wsUrl };
        const o = (rawVoice as any).openai;
        if (o && typeof o === 'object') v.openai = { baseUrl: o.baseUrl, apiKey: o.apiKey, model: o.model };
        if (v.engine || v.sami || v.openai || v.speaker) voice = v;
      }
    }

    configs.push({
      larkAppId: entry.larkAppId,
      larkAppSecret: entry.larkAppSecret,
      // brand：只认精确的 'lark'，其余 → undefined（下游 normalizeBrand 当
      // feishu）。feishu 故意存成 undefined，保持旧 bots.json 干净、不写死字段。
      brand: entry.brand === 'lark' ? 'lark' : undefined,
      name: typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : undefined,
      cliId: entry.cliId ?? 'claude-code',
      cliPathOverride: entry.cliPathOverride,
      wrapperCli: typeof entry.wrapperCli === 'string' && entry.wrapperCli.trim()
        ? entry.wrapperCli.trim()
        : undefined,
      model: typeof entry.model === 'string' && entry.model.trim()
        ? entry.model.trim()
        : undefined,
      disableCliBypass: entry.disableCliBypass === true,
      sandbox: entry.sandbox === true,
      sandboxHidePaths: Array.isArray(entry.sandboxHidePaths)
        ? entry.sandboxHidePaths.filter((p: unknown): p is string => typeof p === 'string' && !!p.trim())
        : [],
      backendType: entry.backendType,
      // Positive integer only; ≤0 / non-int / absent → undefined (= no cap).
      maxLiveWorkers: typeof entry.maxLiveWorkers === 'number'
        && Number.isInteger(entry.maxLiveWorkers) && entry.maxLiveWorkers > 0
        ? entry.maxLiveWorkers
        : undefined,
      workingDir: workingDirs?.[0] ?? entry.workingDir,
      workingDirs,
      allowedUsers: entry.allowedUsers,
      allowedChatGroups,
      oncallChats,
      defaultOncall,
      defaultOncallAutoboundChats,
      defaultWorkingDir: typeof entry.defaultWorkingDir === 'string' && entry.defaultWorkingDir.trim()
        ? entry.defaultWorkingDir.trim()
        : undefined,
      chatReplyModes,
      chatGrants,
      globalGrants,
      messageQuota,
      quotaState,
      restrictGrantCommands: entry.restrictGrantCommands === true || undefined,
      customPassthroughCommands,
      startupCommands,
      env,
      skills,
      lang: isLocale(entry.lang) ? entry.lang : undefined,
      // Preserve '' distinctly from undefined: '' means "brand off", undefined
      // means "use default botmux brand". Don't trim-to-undefined here.
      brandLabel: typeof entry.brandLabel === 'string' ? entry.brandLabel : undefined,
      disableStreamingCard: entry.disableStreamingCard === true || undefined,
      // Only 'chat' is meaningful; 'thread' (and anything else) normalizes to
      // undefined — the legacy thread-per-message default. Keeps bots.json clean.
      p2pMode: entry.p2pMode === 'chat' ? 'chat' : undefined,
      noCardChats: Array.isArray(entry.noCardChats)
        ? entry.noCardChats.filter((x: any): x is string => typeof x === 'string' && x.trim().length > 0).map((x: string) => x.trim())
        : undefined,
      writableTerminalLinkInCard: entry.writableTerminalLinkInCard === true || undefined,
      privateCard: entry.privateCard === true || undefined,
      autoStartOnGroupJoin: entry.autoStartOnGroupJoin === true || undefined,
      // Preserve the configured prompt verbatim; trim-to-undefined when blank
      // so an empty string doesn't linger in bots.json.
      autoStartOnGroupJoinPrompt: typeof entry.autoStartOnGroupJoinPrompt === 'string' && entry.autoStartOnGroupJoinPrompt.trim()
        ? entry.autoStartOnGroupJoinPrompt
        : undefined,
      autoStartOnNewTopic: entry.autoStartOnNewTopic === true || undefined,
      worktreeMultiPicker: entry.worktreeMultiPicker === true || undefined,
      // Per-bot regular-group default mode. Only 'new-topic' | 'shared' are
      // meaningful; 'chat' (the flat default) and anything else normalize to
      // undefined so bots.json stays clean.
      regularGroupReplyMode: (() => {
        const mode = normalizeChatReplyModeConfig(entry.regularGroupReplyMode);
        return mode === 'new-topic' || mode === 'shared' ? mode : undefined;
      })(),
      // 3-tier @ policy. Only 'topic' | 'never' are meaningful; 'always' (the
      // default) and anything else normalize to undefined so bots.json stays clean.
      regularGroupMentionMode: entry.regularGroupMentionMode === 'topic' || entry.regularGroupMentionMode === 'never'
        ? entry.regularGroupMentionMode
        : undefined,
      // 文档订阅默认触发范围。只 'all' 有意义；'mention-only'（默认）归一化为
      // undefined 让 bots.json 保持干净。
      docSubscribeDefaultMode: entry.docSubscribeDefaultMode === 'all' ? 'all' : undefined,
      voice,
    });
  }

  return configs;
}

function readStringArray(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const values = raw
    .map((v) => typeof v === 'string' ? v.trim() : '')
    .filter(Boolean);
  return values.length > 0 ? values : undefined;
}

function readDirectSkillSelectors(raw: unknown): SkillSelector[] | undefined {
  const values = readStringArray(raw);
  if (!values) return undefined;
  const selectors = values.filter((value): value is SkillSelector => /^skill:.+$/.test(value));
  return selectors.length > 0 ? selectors : undefined;
}

export function readBotSkillPolicy(raw: unknown): BotSkillPolicy | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const out: BotSkillPolicy = {};
  const include = readDirectSkillSelectors(r.include);
  if (include) out.include = include;
  return Object.keys(out).length > 0 ? out : undefined;
}
