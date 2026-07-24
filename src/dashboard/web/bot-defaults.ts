import { store } from './store.js';

export type CliOption = {
  id: string;
  label: string;
  gateway?: 'ttadk';
  acceptsModel?: boolean;
  available?: boolean;
  command?: string;
  availabilityReason?: string;
};

export type CliOptionsState = {
  options: CliOption[];
  ttadkModelDefault: string;
  ttadkModelSuggestions: string[];
};

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
  wrapperCli?: string | null;
  model?: string;
  agentSelectionKey?: string;
  defaultOncall?: { enabled?: boolean; workingDir?: string; since?: number };
  defaultWorkingDir?: string | null;
  defaultWorkingDirAutoWorktree?: boolean;
  autoboundChatCount?: number;
  brandLabel?: string | null;
  sandbox?: boolean;
  /** Whether the unified file sandbox ALSO applies cross-bot read isolation for
   *  this bot's sessions — true when the CLI (claude/codex) + platform (macOS/Linux)
   *  + no wrapper can enforce it. Drives the capability label under the toggle. */
  readIsolationSupported?: boolean;
  backendType?: string | null;
  disableStreamingCard?: boolean;
  silentTurnReactions?: boolean;
  codexAppCleanInput?: boolean;
  writableTerminalLinkInCard?: boolean;
  privateCard?: boolean;
  botToBotSameDir?: boolean;
  summaryRange?: { limit?: number; sinceHours?: number };
  p2pMode?: string;
  regularGroupReplyMode?: string;
  regularGroupMentionMode?: string;
  substituteMode?: BotSubstituteMode | null;
  docSubscribeDefaultMode?: string;
  maxLiveWorkers?: number | null;
  logicalSessionCount?: number;
  residentSessionCount?: number;
  dormantSessionCount?: number;
  startupCommands?: string;
  launchShell?: string;
  env?: string;
  riff?: Record<string, unknown> | null;
  autoStartOnGroupJoin?: boolean;
  autoStartOnGroupJoinPrompt?: string;
  autoStartOnNewTopic?: boolean;
  autoGrantRequestCards?: boolean;
  restrictGrantCommands?: boolean;
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
  return [];
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
    const options = body.options.filter((o: any): o is CliOption =>
      o && typeof o.id === 'string' && typeof o.label === 'string',
    );
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
