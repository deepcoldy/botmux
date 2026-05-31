import * as Lark from '@larksuiteoapi/node-sdk';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import type { CliId } from './adapters/cli/types.js';
import { logger } from './utils/logger.js';
import { isLocale, setBotLookup, type Locale } from './i18n/index.js';

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
  /** Optional process-name suffix; the daemon's process name is rendered as `botmux-<name>` (defaults to `botmux-<index>`). */
  name?: string;
  cliId: CliId;
  cliPathOverride?: string;
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
  backendType?: 'pty' | 'tmux';
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
}

export interface BotState {
  config: BotConfig;
  client: Lark.Client;
  botOpenId?: string;
  botName?: string;       // Lark app display name (from /bot/v3/info)
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
function safeStringify(v: unknown): string {
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v); } catch { return String(v); }
}
const fmtLark = (msg: any[]) => msg.map(safeStringify).join(' ');
const larkLogger = {
  error: (...msg: any[]) => logger.error(`[lark] ${fmtLark(msg)}`),
  warn:  (...msg: any[]) => logger.warn(`[lark] ${fmtLark(msg)}`),
  info:  (...msg: any[]) => logger.info(`[lark] ${fmtLark(msg)}`),
  debug: (...msg: any[]) => logger.debug(`[lark] ${fmtLark(msg)}`),
  trace: (..._msg: any[]) => { /* SDK trace dropped entirely — uninteresting per-byte WS frames */ },
};

export function registerBot(cfg: BotConfig): BotState {
  const client = new Lark.Client({
    appId: cfg.larkAppId,
    appSecret: cfg.larkAppSecret,
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

export function getAllBots(): BotState[] {
  return Array.from(bots.values());
}

/** Lookup the oncall binding for a given bot+chat, if any. */
export function findOncallChat(larkAppId: string, chatId: string): OncallChat | undefined {
  const bot = bots.get(larkAppId);
  return bot?.config.oncallChats?.find(c => c.chatId === chatId);
}

// Cross-bot oncall chat check — cached by config-file mtime.
//
// /oncall bind is per-bot, but oncall is meant to be a chat-level property:
// once any bot in a multi-bot deployment binds the chat, every sibling bot
// should treat that chat as an oncall workspace too (otherwise unbound bots
// fall back to allowedUsers and reply "⚠️ 无操作权限" when @-mentioned).
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

    configs.push({
      larkAppId: entry.larkAppId,
      larkAppSecret: entry.larkAppSecret,
      name: typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : undefined,
      cliId: entry.cliId ?? 'claude-code',
      cliPathOverride: entry.cliPathOverride,
      model: typeof entry.model === 'string' && entry.model.trim()
        ? entry.model.trim()
        : undefined,
      disableCliBypass: entry.disableCliBypass === true,
      backendType: entry.backendType,
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
      chatGrants,
      globalGrants,
      messageQuota,
      quotaState,
      restrictGrantCommands: entry.restrictGrantCommands === true || undefined,
      lang: isLocale(entry.lang) ? entry.lang : undefined,
      // Preserve '' distinctly from undefined: '' means "brand off", undefined
      // means "use default botmux brand". Don't trim-to-undefined here.
      brandLabel: typeof entry.brandLabel === 'string' ? entry.brandLabel : undefined,
      disableStreamingCard: entry.disableStreamingCard === true || undefined,
      writableTerminalLinkInCard: entry.writableTerminalLinkInCard === true || undefined,
      privateCard: entry.privateCard === true || undefined,
      autoStartOnGroupJoin: entry.autoStartOnGroupJoin === true || undefined,
      // Preserve the configured prompt verbatim; trim-to-undefined when blank
      // so an empty string doesn't linger in bots.json.
      autoStartOnGroupJoinPrompt: typeof entry.autoStartOnGroupJoinPrompt === 'string' && entry.autoStartOnGroupJoinPrompt.trim()
        ? entry.autoStartOnGroupJoinPrompt
        : undefined,
      autoStartOnNewTopic: entry.autoStartOnNewTopic === true || undefined,
    });
  }

  return configs;
}
