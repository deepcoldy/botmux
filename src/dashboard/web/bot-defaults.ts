import { store } from './store.js';
import type { CliRuntimeConfig as SharedCliRuntimeConfig } from '../../adapters/cli/runtime.js';
import type { FeedbackPolicyLayer } from '../../services/feedback-policy-resolver.js';

export type CliOption = {
  id: string;
  label: string;
  gateway?: 'ttadk';
  acceptsModel?: boolean;
  available?: boolean;
  command?: string;
  availabilityReason?: string;
  /** 静态模型候选（后端精选列表；不支持模型的 CLI 为 []）。live 探测结果走 /api/cli-options/models。 */
  modelChoices?: readonly string[];
};

export type CliOptionsState = {
  options: CliOption[];
  ttadkModelDefault: string;
  ttadkModelSuggestions: string[];
};

/** Keep the browser payload contract tied to the daemon's canonical schema. */
export type CliRuntimeConfig = SharedCliRuntimeConfig;
export type CliRuntimeUpdateProvider = NonNullable<SharedCliRuntimeConfig['update']>['provider'];

export type BotSubstituteTarget = {
  openId?: string;
  userId?: string;
  unionId?: string;
  email?: string;
  name?: string;
  avatarUrl?: string;
};

export type BotSubstituteMode = {
  enabled: boolean;
  targets: BotSubstituteTarget[];
  disclosure: 'prefix' | 'none';
  chats?: string[];
  excludedChats?: string[];
  replyMode?: 'thread' | 'quote';
  disableControlCard?: boolean;
  /** 话题群支持（缺省 true；显式 false 关）。 */
  topicGroups?: boolean;
  /** 话题里已有本 bot 活跃会话时是否仍触发替身（缺省 true）。 */
  topicActiveSessionTrigger?: boolean;
};

export type BotDefaultsRow = {
  larkAppId: string;
  botName?: string;
  cliId?: string;
  /** 租户品牌，决定飞书后台深链的 host（feishu.cn vs larksuite.com）。
   *  缺省（旧 payload / 未注册）→ larkConsoleUrl 内 normalizeBrand 兜底 feishu。 */
  brand?: string;
  /** Absent/null is the built-in runtime. Older dashboard payloads omit it. */
  cliRuntime?: CliRuntimeConfig | null;
  /** Legacy path-only executable override, returned only by private Bot Defaults APIs. */
  cliPathOverride?: string | null;
  wrapperCli?: string | null;
  model?: string;
  reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
  /** dsh runner turn timeout (ms); rendered as a dsh-only field. */
  turnTimeoutMs?: number;
  /** dsh runtime variant: 'official' (JSON-RPC runner) or 'tui' (dsh-tui PTY). */
  dshRuntime?: 'official' | 'tui' | null;
  agentSelectionKey?: string;
  defaultOncall?: { enabled?: boolean; workingDir?: string; since?: number };
  defaultWorkingDir?: string | null;
  defaultWorkingDirAutoWorktree?: boolean;
  autoboundChatCount?: number;
  brandLabel?: string | null;
  sandbox?: boolean;
  codexAuthSync?: 'shared' | 'isolated';
  /** Three-tier sandbox path whitelist (highest-precedence FsPolicy layer).
   *  null/absent = none configured (pure deny-by-default baseline). */
  sandboxPaths?: { readWrite: string[]; readOnly: string[]; deny: string[] } | null;
  /** Whether the unified file sandbox ALSO applies cross-bot read isolation for
   *  this bot's sessions — true when the CLI (claude/codex) + platform (macOS/Linux)
   *  + no wrapper can enforce it. Drives the capability label under the toggle. */
  readIsolationSupported?: boolean;
  backendType?: string | null;
  usageDisplay?: 'streaming' | 'footer' | 'off';
  usageSupported?: boolean;
  disableStreamingCard?: boolean;
  silentTurnReactions?: boolean;
  codexAppCleanInput?: boolean;
  writableTerminalLinkInCard?: boolean;
  privateCard?: boolean;
  /** Bot-level master switch for the native CoT (thinking process) message.
   *  Default ON — only an explicit false means disabled. */
  thinkingCard?: boolean;
  /** Whether each turn carries the `<sender>` speaker tag. Default ON — only an
   *  explicit false means the tag is suppressed. */
  senderTag?: boolean;
  overloadAlert?: boolean;
  botToBotSameDir?: boolean;
  summaryRange?: { limit?: number; sinceHours?: number };
  summaryMemory?: boolean;
  summaryMemoryPath?: string;
  p2pMode?: string;
  /** #794: per-turn 上下文注入方式。'auto' = 支持的 CLI 走 hook 注入；缺省/'off' = 内联。 */
  envelopeInjection?: 'auto' | 'off' | null;
  regularGroupReplyMode?: string;
  regularGroupMentionMode?: string;
  substituteMode?: BotSubstituteMode | null;
  feedback?: FeedbackPolicyLayer | null;
  docSubscribeDefaultMode?: string;
  maxLiveWorkers?: number | null;
  logicalSessionCount?: number;
  residentSessionCount?: number;
  dormantSessionCount?: number;
  sessionOwnerReminder?: {
    enabled: boolean;
    intervalMinutes: number;
    text: string;
    states: Array<'idle' | 'dormant' | 'pending_repo' | 'tui_prompt' | 'agent_attention' | 'limited'>;
  } | null;
  startupCommands?: string;
  customPassthroughCommands?: string;
  canTalkDaemonCommands?: string;
  launchShell?: string;
  env?: string;
  riff?: Record<string, unknown> | null;
  autoStartOnGroupJoin?: boolean;
  autoStartOnGroupJoinPrompt?: string;
  autoStartOnNewTopic?: boolean;
  autoGrantRequestCards?: boolean;
  restrictGrantCommands?: boolean;
  p2pOpen?: boolean;
  grantDefaultDurationMs?: number | null;
  messageQuotaDefaultLimit?: number | null;
  skillInjectionSupport?: 'dynamic' | 'global' | 'none' | string;
  skillInjection?: 'global' | 'prompt' | 'off' | null | string;
  skillInjectionDefault?: 'global' | 'prompt' | 'off' | string;
  displayName?: string | null;
  larkBotName?: string | null;
  teamRole?: string;
  teamRoleLoading?: boolean;
  error?: string;
};

export type LoadBotsResult = {
  bots: BotDefaultsRow[];
  error: string | null;
};

export const fallbackCliOptions: CliOption[] = [
  { id: 'claude-code', label: 'Claude' },
  { id: 'codex', label: 'Codex' },
  { id: 'traex', label: 'traex' },
];

export const fallbackCliOptionsState: CliOptionsState = {
  options: fallbackCliOptions,
  ttadkModelDefault: 'glm-5.1',
  ttadkModelSuggestions: [],
};

export function displayCliId(bot: Pick<BotDefaultsRow, 'cliId'> | null | undefined, sessionFallback: string): string {
  return typeof bot?.cliId === 'string' && bot.cliId ? bot.cliId : sessionFallback;
}

/** Fallback for old /api/bots payloads: infer from the bot's recent sessions. */
export function cliIdOf(appId: string): string {
  let best: any = null;
  for (const s of store.sessions.values()) {
    if (s.larkAppId !== appId || !s.cliId) continue;
    if (!best || Number(s.lastMessageAt ?? 0) > Number(best.lastMessageAt ?? 0)) best = s;
  }
  return best?.cliId ?? '';
}

export function agentSelectionKey(bot: BotDefaultsRow, sessionFallback: string): string {
  const explicit = typeof bot.agentSelectionKey === 'string' && bot.agentSelectionKey ? bot.agentSelectionKey : '';
  if (explicit) return explicit;
  const cli = displayCliId(bot, sessionFallback);
  return cli || 'claude-code';
}

export function selectedCliOption(options: CliOption[], key: string): CliOption | undefined {
  return options.find(o => o.id === key);
}

export function modelSuggestionsForOption(opt: CliOption | undefined, cliState: CliOptionsState): string[] {
  if (opt?.gateway === 'ttadk' && opt.acceptsModel !== false) return cliState.ttadkModelSuggestions;
  return [...(opt?.modelChoices ?? [])];
}

/**
 * 合并模型候选：detected（后端已合并静态+live 去重）优先；detected 缺失时回退 static。
 * 两份列表再做一次去重保序，防御后端合并遗漏。纯函数，供单测。
 */
export function mergeModelCandidates(
  staticChoices: readonly string[],
  detected: readonly string[] | null | undefined,
): string[] {
  const primary = detected ?? staticChoices;
  const extra = detected ? staticChoices : [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of primary) {
    if (typeof item !== 'string' || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  for (const item of extra) {
    if (typeof item !== 'string' || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

/**
 * 按需探测某个 CLI 当前可用的模型列表（静态精选 + live 探测合并去重）。
 * fail-soft：任何错误（网络/404/400/形状异常）都返回 null，调用方回退静态候选。
 */
export async function fetchDetectedModels(
  key: string,
): Promise<{ models: string[]; source: 'live' | 'static' } | null> {
  try {
    const r = await fetch(`/api/cli-options/models?key=${encodeURIComponent(key)}`);
    const body = await r.json().catch(() => ({}));
    if (!r.ok || !body || !Array.isArray(body.models)) return null;
    const models = body.models.filter((m: unknown): m is string => typeof m === 'string');
    const source: 'live' | 'static' = body.source === 'live' ? 'live' : 'static';
    return { models, source };
  } catch {
    return null;
  }
}

/**
 * Latest-wins guard for overlapping async refreshes. The Bot 配置 page fires an
 * initial refresh on mount and another on every `bots.changed` SSE event; these
 * can overlap, and a slow earlier `/api/bots` response arriving *after* a newer
 * one ("后发先回") would otherwise clobber the fresher roster and re-hide a
 * just-added bot. Each call bumps a monotonic counter and hands back a `commit`
 * predicate that is only true while this call is still the newest — the caller
 * gates BOTH its state write and its `loading=false` on it. Kept as a tiny
 * pure factory so the race is unit-testable without a DOM.
 */
export function createRefreshGate(): { begin(): { commit(): boolean } } {
  let latest = 0;
  return {
    begin() {
      const seq = ++latest;
      return { commit: () => seq === latest };
    },
  };
}

export async function fetchBotDefaults(): Promise<LoadBotsResult> {
  try {
    const r = await fetch('/api/bots');
    const body = await r.json().catch(() => ({}));
    if (!r.ok) {
      const error = body?.error
        ? `HTTP ${r.status}: ${body.error}${body.path ? ` (${body.path})` : ''}`
        : `HTTP ${r.status}`;
      return { bots: [], error };
    }
    if (!body || !Array.isArray(body.bots)) {
      return { bots: [], error: 'unexpected response shape (no `bots` array)' };
    }
    return { bots: body.bots as BotDefaultsRow[], error: null };
  } catch (e: any) {
    return { bots: [], error: e?.message ?? String(e) };
  }
}

export type SubstituteTargetResolution = {
  input?: string;
  ok?: boolean;
  openId?: string;
  name?: string;
  avatarUrl?: string;
  reason?: 'cross_app_open_id' | 'not_visible' | 'resolve_failed' | 'unresolvable';
};

export async function resolveSubstituteTarget(
  larkAppId: string,
  target: BotSubstituteTarget,
): Promise<{ ok: false; error: string } | { ok: true; resolution: SubstituteTargetResolution }> {
  try {
    const r = await fetch(`/api/bots/${encodeURIComponent(larkAppId)}/substitute-targets/resolve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target }),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) {
      return { ok: false, error: body?.error ? `HTTP ${r.status}: ${body.error}` : `HTTP ${r.status}` };
    }
    return { ok: true, resolution: body?.resolution ?? {} };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) };
  }
}

export async function fetchCliOptions(): Promise<CliOptionsState> {
  try {
    const r = await fetch('/api/cli-options');
    const body = await r.json().catch(() => ({}));
    if (!r.ok || !Array.isArray(body?.options)) return fallbackCliOptionsState;
    const options: CliOption[] = body.options
      .filter((o: any) => o && typeof o.id === 'string' && typeof o.label === 'string')
      .map((o: any) => ({
        ...o,
        // 容错：缺失/非数组 → []，候选合并走 mergeModelCandidates。
        modelChoices: Array.isArray(o.modelChoices)
          ? o.modelChoices.filter((m: unknown): m is string => typeof m === 'string')
          : [],
      }));
    const ttadkModelDefault = typeof body.ttadkModelDefault === 'string' && body.ttadkModelDefault.trim()
      ? body.ttadkModelDefault.trim()
      : fallbackCliOptionsState.ttadkModelDefault;
    const ttadkModelSuggestions = Array.isArray(body.ttadkModelSuggestions)
      ? body.ttadkModelSuggestions.filter((s: unknown): s is string => typeof s === 'string')
      : [];
    return {
      options: options.length ? options : fallbackCliOptions,
      ttadkModelDefault,
      ttadkModelSuggestions,
    };
  } catch {
    return fallbackCliOptionsState;
  }
}

export function fmtSince(since: number): string {
  if (!since) return '—';
  const d = new Date(since);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString();
}
