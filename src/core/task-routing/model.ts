/**
 * Bot 任务分配（Task Routing）核心数据模型与配置校验（纯函数、无 I/O）。
 *
 * 设计要点：
 * - 全局默认关闭（`config.json` 的 `taskRouting.enabled !== true` 即关）。
 * - 语义裁判仅支持 `rule`（纯规则）和 `bot`（借本机某个 bot 的 CLI one-shot），
 *   刻意不支持外部 http 端点、不保存任何外部 apiKey。
 * - 每 bot 默认不参与自动分配（`taskRouting.enabled !== true`）；管家 bot 与
 *   apiOnly bot 始终排除，防止把开发活派给管家或无飞书通道的 bot。
 */

export const TASK_ROUTING_COST_TIERS = ['low', 'medium', 'high'] as const;
export type TaskRoutingCostTier = typeof TASK_ROUTING_COST_TIERS[number];

export const COST_TIER_ORDER: Readonly<Record<TaskRoutingCostTier, number>> = {
  low: 0,
  medium: 1,
  high: 2,
};

export const TASK_ROUTING_MATCHER_MODES = ['rule', 'bot'] as const;
export type TaskRoutingMatcherMode = typeof TASK_ROUTING_MATCHER_MODES[number];

export const TASK_ROUTING_DISPATCH_MODES = ['group', 'topic'] as const;
export type TaskRoutingDispatchMode = typeof TASK_ROUTING_DISPATCH_MODES[number];

export const TASK_ROUTING_LIMITS = {
  maxStrengthsChars: 1_000,
  maxLimitationsChars: 1_000,
  maxPolicyChars: 2_000,
  maxTaskSummaryChars: 500,
  maxReasonChars: 600,
  minMatcherTimeoutMs: 1_000,
  defaultMatcherTimeoutMs: 15_000,
  maxMatcherTimeoutMs: 60_000,
} as const;

const LARK_APP_ID_RE = /^cli_[A-Za-z0-9_-]{1,128}$/;

/** Per-bot task routing profile persisted in `bots.json` under `taskRouting`. */
export interface BotTaskRoutingConfig {
  /** Opt-in switch: only bots with `enabled === true` enter the automatic candidate pool. */
  enabled: boolean;
  /** Cost tier for rule baseline ordering; omitted behaves as `'medium'`. */
  costTier?: TaskRoutingCostTier;
  /** Natural language description of strengths and suitable tasks. */
  strengths?: string;
  /** Natural language description of weaknesses, constraints, and limits. */
  limitations?: string;
}

/** Semantic matcher config inside global `taskRouting` (`~/.botmux/config.json`). */
export interface TaskRoutingMatcherConfig {
  mode: TaskRoutingMatcherMode;
  /** Local bot larkAppId whose CLI one-shot runs semantic matching (only when mode === 'bot'). */
  botAppId?: string;
  /** One-shot timeout in milliseconds (1s..60s, default 15s). */
  timeoutMs?: number;
}

/** Machine-wide task routing settings in `~/.botmux/config.json`. */
export interface TaskRoutingGlobalConfig {
  /** Machine-wide kill-switch. Missing / !== true means OFF. */
  enabled?: boolean;
  /** Optional natural-language global routing preference written by the owner. */
  policy?: string;
  /** Optional semantic matcher config. Absent or mode='rule' uses rules only. */
  matcher?: TaskRoutingMatcherConfig;
}

export type TaskRoutingExclusionCode =
  | 'not_participating'
  | 'steward_bot'
  | 'api_only'
  | 'excluded_by_caller'
  | 'not_in_only_filter'
  | 'offline'
  | 'lark_disconnected'
  | 'at_capacity'
  | 'quota_exhausted'
  | 'in_cooldown'
  | 'budget_exceeded'
  | 'profile_mismatch';

export type TaskRoutingMatcherKind = 'rule' | 'bot' | 'caller_override';
export type TaskRoutingConfidence = 'high' | 'medium' | 'low';
export type TaskRoutingCallerKind = 'host_cli' | 'owner_turn' | 'steward_session';
export type TaskRoutingOutcome = 'pending' | 'dispatched' | 'fallback_dispatched' | 'failed';

export interface BotAgyAccountsRuntime {
  managed: boolean;
  availableCount: number;
  enabledCount: number;
  earliestRecoveryMs?: number;
}

export interface BotBudgetRuntime {
  monthlyCny: number;
  spentCny: number;
  percent: number;
  hardStop: boolean;
  exceeded: boolean;
}

export interface BotLiveRuntime {
  online: boolean;
  probeStatus: 'ok' | 'offline' | 'unreachable' | 'unauthorized';
  larkConnected: boolean | 'unknown';
  workingCount: number | 'unknown';
  /** Parked backlog sessions + active queued turns (when observable). */
  queuedCount: number | 'unknown';
  residentCount: number | 'unknown';
  maxLiveWorkers: number | null;
  limitedCount: number | 'unknown';
  limitedUntilMs?: number;
  limitedKind?: 'usage' | 'rate';
  limitedLabel?: string;
  agyAccounts?: BotAgyAccountsRuntime;
  budget?: BotBudgetRuntime;
}

export interface BotRuntimeSnapshot {
  larkAppId: string;
  name: string;
  cliId: string;
  model?: string;
  defaultWorkingDir?: string;
  autoWorktree?: boolean;
  isSteward: boolean;
  apiOnly: boolean;
  /** Original bots.json traversal order for deterministic tie-breaking. */
  configOrder: number;
  profile: {
    enabled: boolean;
    costTier: TaskRoutingCostTier;
    strengths?: string;
    limitations?: string;
    /** Fallback context from existing `{dataDir}/bot-profiles/{appId}.json`. */
    legacyCapability?: string;
    legacySpecialties?: string[];
  };
  runtime: BotLiveRuntime;
}

export interface TaskRoutingConstraints {
  prefer?: string;
  only?: string[];
  exclude?: string[];
  workingDir?: string;
}

export interface CandidateEvaluation {
  larkAppId: string;
  name: string;
  cliId: string;
  model?: string;
  costTier: TaskRoutingCostTier;
  participating: boolean;
  eligible: boolean;
  exclusionCode?: TaskRoutingExclusionCode;
  exclusionReason?: string;
  runtimeSummary: string;
  strengths?: string;
  limitations?: string;
  runtime: BotLiveRuntime;
}

export interface TaskRoutingDecision {
  selectedAppId: string | null;
  selectedName: string | null;
  /** Ordered eligible larkAppIds to attempt, starting with selectedAppId. */
  fallbackOrder: string[];
  matcherKind: TaskRoutingMatcherKind;
  confidence: TaskRoutingConfidence;
  reason: string;
  fallbackFromMatcher?: string;
  candidates: CandidateEvaluation[];
  excluded: CandidateEvaluation[];
}

export interface TaskRoutingAttempt {
  appId: string;
  name: string;
  outcome: 'dispatched' | 'skipped' | 'failed';
  reason: string;
  at: number;
  chatId?: string;
  sessionId?: string;
  rootMessageId?: string;
}

export interface TaskRoutingRecord {
  id: string;
  createdAt: number;
  updatedAt: number;
  mode: TaskRoutingDispatchMode;
  taskSummary: string;
  callerKind: TaskRoutingCallerKind;
  callerAppId?: string;
  callerSessionId?: string;
  callerTurnId?: string;
  constraints: TaskRoutingConstraints;
  selectedAppId: string | null;
  selectedName: string | null;
  matcherKind: TaskRoutingMatcherKind;
  confidence: TaskRoutingConfidence;
  reason: string;
  fallbackFromMatcher?: string;
  candidates: CandidateEvaluation[];
  excluded: CandidateEvaluation[];
  attempts: TaskRoutingAttempt[];
  outcome: TaskRoutingOutcome;
  targetChatId?: string;
  targetSessionId?: string;
  targetRootMessageId?: string;
  error?: string;
}

// ─── Normalization & Validation ──────────────────────────────────────────────

export function isTaskRoutingCostTier(value: unknown): value is TaskRoutingCostTier {
  return value === 'low' || value === 'medium' || value === 'high';
}

function normalizeOptionalText(
  raw: unknown,
  field: string,
  maxChars: number,
): { ok: true; value: string | undefined } | { ok: false; reason: string } {
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  if (typeof raw !== 'string') return { ok: false, reason: `${field} must be a string` };
  if (raw.includes('\0')) return { ok: false, reason: `${field} must not contain NUL bytes` };
  const trimmed = raw.trim();
  if (!trimmed) return { ok: true, value: undefined };
  if (Array.from(trimmed).length > maxChars) {
    return { ok: false, reason: `${field} must be at most ${maxChars} characters` };
  }
  return { ok: true, value: trimmed };
}

const ALLOWED_BOT_TASK_ROUTING_KEYS = new Set(['enabled', 'costTier', 'strengths', 'limitations']);

/**
 * Validate and normalize per-bot `taskRouting` config.
 * Returns `{ ok: true, value: null }` when cleared/empty so `bots.json` stays sparse.
 */
export function normalizeBotTaskRoutingConfig(
  raw: unknown,
): { ok: true; value: BotTaskRoutingConfig | null } | { ok: false; reason: string } {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: 'taskRouting must be an object' };
  }
  const obj = raw as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!ALLOWED_BOT_TASK_ROUTING_KEYS.has(key)) {
      return { ok: false, reason: `unknown field: ${key}` };
    }
  }
  if (obj.enabled !== undefined && typeof obj.enabled !== 'boolean') {
    return { ok: false, reason: 'enabled must be a boolean' };
  }
  const enabled = obj.enabled === true;

  let costTier: TaskRoutingCostTier | undefined;
  if (obj.costTier !== undefined && obj.costTier !== null && obj.costTier !== '') {
    if (!isTaskRoutingCostTier(obj.costTier)) {
      return { ok: false, reason: 'costTier must be low, medium, or high' };
    }
    costTier = obj.costTier;
  }

  const strengths = normalizeOptionalText(obj.strengths, 'strengths', TASK_ROUTING_LIMITS.maxStrengthsChars);
  if (!strengths.ok) return strengths;
  const limitations = normalizeOptionalText(obj.limitations, 'limitations', TASK_ROUTING_LIMITS.maxLimitationsChars);
  if (!limitations.ok) return limitations;

  // Sparse storage: disabled with no saved draft text/tier removes the key completely.
  if (!enabled && costTier === undefined && !strengths.value && !limitations.value) {
    return { ok: true, value: null };
  }

  return {
    ok: true,
    value: {
      enabled,
      ...(costTier ? { costTier } : {}),
      ...(strengths.value ? { strengths: strengths.value } : {}),
      ...(limitations.value ? { limitations: limitations.value } : {}),
    },
  };
}

const ALLOWED_GLOBAL_TASK_ROUTING_KEYS = new Set(['enabled', 'policy', 'matcher']);
const ALLOWED_MATCHER_KEYS = new Set(['mode', 'botAppId', 'timeoutMs']);

/**
 * Strict validation for global `taskRouting` writes.
 * Explicitly rejects `http` mode, `apiKey`, `baseUrl`, or any unknown field.
 */
export function validateGlobalTaskRoutingConfig(
  raw: unknown,
): { ok: true; value: TaskRoutingGlobalConfig | null } | { ok: false; reason: string } {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: 'taskRouting must be an object' };
  }
  const obj = raw as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!ALLOWED_GLOBAL_TASK_ROUTING_KEYS.has(key)) {
      return { ok: false, reason: `unknown field: ${key}` };
    }
  }
  if (obj.enabled !== undefined && typeof obj.enabled !== 'boolean') {
    return { ok: false, reason: 'enabled must be a boolean' };
  }
  const policy = normalizeOptionalText(obj.policy, 'policy', TASK_ROUTING_LIMITS.maxPolicyChars);
  if (!policy.ok) return policy;

  let matcher: TaskRoutingMatcherConfig | undefined;
  if (obj.matcher !== undefined && obj.matcher !== null) {
    if (typeof obj.matcher !== 'object' || Array.isArray(obj.matcher)) {
      return { ok: false, reason: 'matcher must be an object' };
    }
    const m = obj.matcher as Record<string, unknown>;
    for (const key of Object.keys(m)) {
      if (!ALLOWED_MATCHER_KEYS.has(key)) {
        return { ok: false, reason: `unsupported matcher field: ${key}` };
      }
    }
    if (m.mode !== 'rule' && m.mode !== 'bot') {
      return { ok: false, reason: 'matcher.mode must be rule or bot' };
    }
    let botAppId: string | undefined;
    if (m.botAppId !== undefined && m.botAppId !== null && m.botAppId !== '') {
      if (typeof m.botAppId !== 'string' || !LARK_APP_ID_RE.test(m.botAppId.trim())) {
        return { ok: false, reason: 'matcher.botAppId must be a valid cli_ application id' };
      }
      botAppId = m.botAppId.trim();
    }
    if (m.mode === 'bot' && !botAppId) {
      return { ok: false, reason: 'matcher.botAppId is required when matcher.mode is bot' };
    }
    let timeoutMs: number | undefined;
    if (m.timeoutMs !== undefined && m.timeoutMs !== null) {
      if (typeof m.timeoutMs !== 'number' || !Number.isInteger(m.timeoutMs)
        || m.timeoutMs < TASK_ROUTING_LIMITS.minMatcherTimeoutMs
        || m.timeoutMs > TASK_ROUTING_LIMITS.maxMatcherTimeoutMs) {
        return {
          ok: false,
          reason: `matcher.timeoutMs must be an integer between ${TASK_ROUTING_LIMITS.minMatcherTimeoutMs} and ${TASK_ROUTING_LIMITS.maxMatcherTimeoutMs}`,
        };
      }
      timeoutMs = m.timeoutMs;
    }
    matcher = {
      mode: m.mode,
      ...(botAppId ? { botAppId } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    };
  }

  const out: TaskRoutingGlobalConfig = {
    ...(typeof obj.enabled === 'boolean' ? { enabled: obj.enabled } : {}),
    ...(policy.value ? { policy: policy.value } : {}),
    ...(matcher ? { matcher } : {}),
  };

  if (out.enabled !== true && !out.policy && !out.matcher) {
    return { ok: true, value: null };
  }
  return { ok: true, value: out };
}

/**
 * Forgiving read normalizer for `global-config.ts`: bad hand-edits degrade safely
 * to rule-only / disabled rather than breaking unrelated config reads.
 */
export function readGlobalTaskRoutingConfigFromRaw(raw: unknown): TaskRoutingGlobalConfig | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const obj = raw as Record<string, unknown>;
  const out: TaskRoutingGlobalConfig = {};
  if (typeof obj.enabled === 'boolean') out.enabled = obj.enabled;
  const policy = normalizeOptionalText(obj.policy, 'policy', TASK_ROUTING_LIMITS.maxPolicyChars);
  if (policy.ok && policy.value) out.policy = policy.value;

  if (obj.matcher && typeof obj.matcher === 'object' && !Array.isArray(obj.matcher)) {
    const m = obj.matcher as Record<string, unknown>;
    if (m.mode === 'rule' || m.mode === 'bot') {
      const botAppId = typeof m.botAppId === 'string' && LARK_APP_ID_RE.test(m.botAppId.trim())
        ? m.botAppId.trim()
        : undefined;
      const timeoutMs = typeof m.timeoutMs === 'number' && Number.isInteger(m.timeoutMs)
        && m.timeoutMs >= TASK_ROUTING_LIMITS.minMatcherTimeoutMs
        && m.timeoutMs <= TASK_ROUTING_LIMITS.maxMatcherTimeoutMs
        ? m.timeoutMs
        : undefined;
      if (m.mode === 'rule') {
        out.matcher = { mode: 'rule', ...(timeoutMs !== undefined ? { timeoutMs } : {}) };
      } else if (botAppId) {
        out.matcher = { mode: 'bot', botAppId, ...(timeoutMs !== undefined ? { timeoutMs } : {}) };
      }
    }
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

export function truncateTaskSummary(task: string, maxChars = TASK_ROUTING_LIMITS.maxTaskSummaryChars): string {
  const flat = task.replace(/\s+/g, ' ').trim();
  const chars = Array.from(flat);
  return chars.length <= maxChars ? flat : `${chars.slice(0, maxChars).join('')}…`;
}

export function formatDurationShortZh(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '即将恢复';
  const totalSec = Math.ceil(ms / 1_000);
  if (totalSec < 60) return `${totalSec}秒`;
  const totalMin = Math.ceil(ms / 60_000);
  if (totalMin < 60) return `${totalMin}分钟`;
  const hours = Math.floor(totalMin / 60);
  const mins = totalMin % 60;
  return mins > 0 ? `${hours}小时${mins}分钟` : `${hours}小时`;
}

export function costTierLabelZh(tier: TaskRoutingCostTier): string {
  switch (tier) {
    case 'low': return '经济';
    case 'medium': return '均衡';
    case 'high': return '旗舰';
  }
}

export function exclusionCodeLabelZh(code: TaskRoutingExclusionCode): string {
  switch (code) {
    case 'not_participating': return '未参与分配';
    case 'steward_bot': return '管家 Bot';
    case 'api_only': return '仅 API 模式';
    case 'excluded_by_caller': return '已排除';
    case 'not_in_only_filter': return '不在指定范围';
    case 'offline': return '离线';
    case 'lark_disconnected': return '飞书断连';
    case 'at_capacity': return '已满载';
    case 'quota_exhausted': return '额度耗尽';
    case 'in_cooldown': return '限额冷却中';
    case 'budget_exceeded': return '预算已达上限';
    case 'profile_mismatch': return '画像不匹配';
  }
}
