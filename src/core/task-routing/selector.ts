/**
 * 任务分配选人引擎（纯函数核心 + 可注入语义裁判 seam）。
 *
 * 两阶段架构：
 * 1. 规则硬过滤 & 基线排序（纯函数、确定性）：
 *    - 严格排除管家 / apiOnly / 未参与分配 / owner 排除 / 离线 / 飞书断连 /
 *      额度耗尽(含 agy 全冷却) / 限额冷却中 / 预算超硬上限 / 并发满载。
 *    - 基线序：--prefer（若可用）→ 空闲优先（working+queued 升序）→ 成本档位（low→medium→high）→ 配置序。
 * 2. 语义匹配（可选，仅在配置了 `matcher.mode === 'bot'` 时运行）：
 *    - 裁判只能在 Stage 1 合法候选中选择；
 *    - 可将明确不匹配的候选标为 `profile_mismatch` 移入 excluded 并记清理由；
 *    - 裁判超时、报错、非法输出或返回 `confidence: 'low'` 时，自动回退 Stage 1 基线序（拿不准选便宜的）。
 */

import {
  COST_TIER_ORDER,
  costTierLabelZh,
  formatDurationShortZh,
  type BotLiveRuntime,
  type BotRuntimeSnapshot,
  type CandidateEvaluation,
  type TaskRoutingConfidence,
  type TaskRoutingConstraints,
  type TaskRoutingDecision,
  type TaskRoutingExclusionCode,
  type TaskRoutingMatcherConfig,
} from './model.js';

export interface SemanticMatchRequest {
  task: string;
  policy?: string;
  preferAppId?: string;
  candidates: readonly CandidateEvaluation[];
}

export interface SemanticMatchRawResult {
  selectedAppId: string;
  fallbackOrder?: string[];
  unsuitable?: Array<{ appId: string; reason: string }>;
  confidence: TaskRoutingConfidence;
  reason: string;
}

export type SemanticMatchInvokeResult =
  | { ok: true; match: SemanticMatchRawResult }
  | { ok: false; errorCode: string; detail: string };

export type SemanticMatcherFn = (request: SemanticMatchRequest) => Promise<SemanticMatchInvokeResult>;

export interface SelectBotForTaskInput {
  task: string;
  snapshots: readonly BotRuntimeSnapshot[];
  constraints?: TaskRoutingConstraints;
  policy?: string;
  matcherConfig?: TaskRoutingMatcherConfig;
  noLlm?: boolean;
  callerReason?: string;
  nowMs?: number;
  invokeMatcher?: SemanticMatcherFn;
}

export function buildRuntimeSummary(runtime: BotLiveRuntime, nowMs: number): string {
  if (!runtime.online || runtime.probeStatus !== 'ok') {
    if (runtime.probeStatus === 'unauthorized') return 'IPC 鉴权失败';
    if (runtime.probeStatus === 'unreachable') return '守护进程无响应';
    return '离线';
  }
  const parts: string[] = ['在线'];
  if (runtime.larkConnected === false) parts.push('飞书断连');

  if (typeof runtime.workingCount === 'number' && typeof runtime.queuedCount === 'number') {
    if (runtime.workingCount === 0 && runtime.queuedCount === 0) {
      parts.push('空闲');
    } else {
      const busyBits: string[] = [];
      if (runtime.workingCount > 0) busyBits.push(`忙 ${runtime.workingCount}`);
      if (runtime.queuedCount > 0) busyBits.push(`排队 ${runtime.queuedCount}`);
      parts.push(busyBits.join(' / '));
    }
  } else {
    parts.push('忙闲未知');
  }

  if (runtime.maxLiveWorkers !== null && typeof runtime.residentCount === 'number') {
    parts.push(`会话 ${runtime.residentCount}/${runtime.maxLiveWorkers}`);
  }

  if (runtime.agyAccounts?.managed) {
    const { availableCount, enabledCount, earliestRecoveryMs } = runtime.agyAccounts;
    if (enabledCount === 0) {
      parts.push('agy 0/0 可用（无有效启用账号）');
    } else if (availableCount === 0) {
      const eta = earliestRecoveryMs && earliestRecoveryMs > nowMs
        ? `，约 ${formatDurationShortZh(earliestRecoveryMs - nowMs)}后恢复`
        : '';
      parts.push(`agy 0/${enabledCount} 可用（全冷却${eta}）`);
    } else {
      parts.push(`agy ${availableCount}/${enabledCount} 可用`);
    }
  }

  if (runtime.limitedUntilMs !== undefined && runtime.limitedUntilMs > nowMs) {
    const kind = runtime.limitedKind === 'rate' ? '限流' : '额度';
    parts.push(`${kind}冷却中（约 ${formatDurationShortZh(runtime.limitedUntilMs - nowMs)}）`);
  } else if (typeof runtime.limitedCount === 'number' && runtime.limitedCount > 0) {
    parts.push(`受限会话 ${runtime.limitedCount}`);
  }

  if (runtime.budget) {
    parts.push(`本月预算 ${Math.round(runtime.budget.percent)}%`);
  }

  return parts.join(' · ');
}

function numericLoad(runtime: BotLiveRuntime): number {
  const working = typeof runtime.workingCount === 'number' ? runtime.workingCount : null;
  const queued = typeof runtime.queuedCount === 'number' ? runtime.queuedCount : null;
  if (working === null && queued === null) return Number.POSITIVE_INFINITY;
  return (working ?? 0) + (queued ?? 0);
}

function effectiveStrengths(snapshot: BotRuntimeSnapshot): string | undefined {
  if (snapshot.profile.strengths) return snapshot.profile.strengths;
  const fallbackParts = [
    snapshot.profile.legacyCapability?.trim(),
    snapshot.profile.legacySpecialties?.length
      ? `专长标签：${snapshot.profile.legacySpecialties.join('、')}`
      : undefined,
  ].filter(Boolean);
  return fallbackParts.length > 0 ? fallbackParts.join('；') : undefined;
}

function evaluateOne(
  snapshot: BotRuntimeSnapshot,
  constraints: TaskRoutingConstraints,
  nowMs: number,
): CandidateEvaluation {
  const excludeSet = new Set(constraints.exclude ?? []);
  const onlySet = constraints.only?.length ? new Set(constraints.only) : null;
  // Only `--only` explicitly pins a bot outside the opt-in pool; `--prefer` is a
  // ranking preference among participating bots and never bypasses `enabled: false`.
  const explicitlyNamed = onlySet?.has(snapshot.larkAppId) ?? false;

  const base: Omit<CandidateEvaluation, 'eligible' | 'exclusionCode' | 'exclusionReason'> = {
    larkAppId: snapshot.larkAppId,
    name: snapshot.name,
    cliId: snapshot.cliId,
    ...(snapshot.model ? { model: snapshot.model } : {}),
    costTier: snapshot.profile.costTier,
    participating: snapshot.profile.enabled,
    runtimeSummary: buildRuntimeSummary(snapshot.runtime, nowMs),
    ...(effectiveStrengths(snapshot) ? { strengths: effectiveStrengths(snapshot) } : {}),
    ...(snapshot.profile.limitations ? { limitations: snapshot.profile.limitations } : {}),
    runtime: snapshot.runtime,
  };

  const reject = (code: TaskRoutingExclusionCode, reason: string): CandidateEvaluation => ({
    ...base,
    eligible: false,
    exclusionCode: code,
    exclusionReason: reason,
  });

  // 1. Structural exclusions: steward & apiOnly are always excluded (even if hand-edited).
  if (snapshot.isSteward) {
    return reject('steward_bot', '管家 Bot 默认不参与执行任务分配');
  }
  if (snapshot.apiOnly) {
    return reject('api_only', 'apiOnly Bot 无飞书通道，不能建群或接收派发');
  }

  // 2. Caller explicit constraints.
  if (excludeSet.has(snapshot.larkAppId)) {
    return reject('excluded_by_caller', '本次调用显式排除了该 Bot');
  }
  if (onlySet && !onlySet.has(snapshot.larkAppId)) {
    return reject('not_in_only_filter', '不在本次 --only 指定范围内');
  }

  // 3. Opt-in participation gate (default empty; owner must enable per bot unless explicitly named via --only/--prefer).
  if (!snapshot.profile.enabled && !explicitlyNamed) {
    return reject('not_participating', '未在 Bot 配置中开启「参与任务分配」');
  }

  // 4. Live runtime health & liveness.
  if (!snapshot.runtime.online || snapshot.runtime.probeStatus !== 'ok') {
    const why = snapshot.runtime.probeStatus === 'unauthorized'
      ? 'daemon IPC 鉴权失败，无法确认状态'
      : snapshot.runtime.probeStatus === 'unreachable'
        ? 'daemon 无响应或探测超时'
        : 'Bot daemon 当前离线';
    return reject('offline', why);
  }
  if (snapshot.runtime.larkConnected === false) {
    return reject('lark_disconnected', '飞书长连接已断开，当前无法稳定收发消息');
  }

  // 5. Quota & cooldown checks.
  const agy = snapshot.runtime.agyAccounts;
  if (agy?.managed && agy.availableCount === 0) {
    if (agy.enabledCount === 0) {
      return reject('quota_exhausted', 'agy 托管账号池无有效启用账号');
    }
    const eta = agy.earliestRecoveryMs && agy.earliestRecoveryMs > nowMs
      ? `，预计 ${formatDurationShortZh(agy.earliestRecoveryMs - nowMs)}后恢复`
      : '';
    return reject('quota_exhausted', `agy ${agy.enabledCount}/${agy.enabledCount} 个账号均在冷却中${eta}`);
  }
  if (snapshot.runtime.limitedUntilMs !== undefined && snapshot.runtime.limitedUntilMs > nowMs) {
    const kind = snapshot.runtime.limitedKind === 'rate' ? '限流' : '额度';
    const eta = formatDurationShortZh(snapshot.runtime.limitedUntilMs - nowMs);
    return reject('in_cooldown', `当前处于${kind}冷却中，预计 ${eta}后恢复`);
  }
  if (
    snapshot.runtime.limitedUntilMs === undefined
    && typeof snapshot.runtime.limitedCount === 'number'
    && snapshot.runtime.limitedCount > 0
  ) {
    return reject('in_cooldown', `当前有 ${snapshot.runtime.limitedCount} 个活跃会话处于限额受限态`);
  }
  if (snapshot.runtime.budget?.exceeded && snapshot.runtime.budget.hardStop) {
    return reject(
      'budget_exceeded',
      `本月花费 ¥${snapshot.runtime.budget.spentCny.toFixed(2)} 已达硬上限 ¥${snapshot.runtime.budget.monthlyCny.toFixed(2)}`,
    );
  }

  // 6. Concurrency capacity check.
  if (
    snapshot.runtime.maxLiveWorkers !== null
    && typeof snapshot.runtime.residentCount === 'number'
    && snapshot.runtime.residentCount >= snapshot.runtime.maxLiveWorkers
  ) {
    return reject(
      'at_capacity',
      `并发已满载（活跃会话 ${snapshot.runtime.residentCount}/${snapshot.runtime.maxLiveWorkers}）`,
    );
  }

  return { ...base, eligible: true };
}

/**
 * Pure Stage-1 evaluation: split all bots into baseline-ranked eligible candidates
 * and excluded bots with explicit reasons.
 */
export function evaluateCandidates(
  snapshots: readonly BotRuntimeSnapshot[],
  constraints: TaskRoutingConstraints = {},
  nowMs = Date.now(),
): { eligible: CandidateEvaluation[]; excluded: CandidateEvaluation[] } {
  const orderByApp = new Map(snapshots.map((s, index) => [s.larkAppId, s.configOrder ?? index]));
  const evaluated = snapshots.map(s => evaluateOne(s, constraints, nowMs));
  const eligible = evaluated.filter(item => item.eligible);
  const excluded = evaluated.filter(item => !item.eligible);

  eligible.sort((a, b) => {
    // 1. Caller --prefer always ranks first among eligible bots.
    const preferA = constraints.prefer === a.larkAppId ? 0 : 1;
    const preferB = constraints.prefer === b.larkAppId ? 0 : 1;
    if (preferA !== preferB) return preferA - preferB;

    // 2. Idle / lower live load first (working + queued ascending; unknown sorts after known).
    const loadA = numericLoad(a.runtime);
    const loadB = numericLoad(b.runtime);
    if (loadA !== loadB) return loadA - loadB;

    // 3. Lower cost tier first ("拿不准时选便宜的").
    const costDiff = COST_TIER_ORDER[a.costTier] - COST_TIER_ORDER[b.costTier];
    if (costDiff !== 0) return costDiff;

    // 4. Stable bots.json traversal order.
    return (orderByApp.get(a.larkAppId) ?? 0) - (orderByApp.get(b.larkAppId) ?? 0);
  });

  return { eligible, excluded };
}

function buildBaselineReason(
  winner: CandidateEvaluation,
  constraints: TaskRoutingConstraints,
  fallbackFromMatcher?: string,
  callerReason?: string,
): string {
  if (callerReason?.trim()) return callerReason.trim();
  const tier = costTierLabelZh(winner.costTier);
  const status = winner.runtimeSummary;
  if (constraints.only?.length === 1 && constraints.only[0] === winner.larkAppId) {
    return `按调用方 --only 显式指定选用 ${winner.name}（${tier}档，${status}）`;
  }
  if (constraints.prefer === winner.larkAppId) {
    return `按调用方 --prefer 优先选用 ${winner.name}（${tier}档，${status}）`;
  }
  if (fallbackFromMatcher) {
    return `语义裁判${fallbackFromMatcher}，按规则回退到更经济且低负载的 ${winner.name}（${tier}档，${status}）`;
  }
  return `按规则基线选择 ${winner.name}（${tier}档，${status}）`;
}

function sanitizeMatcherOrder(
  selectedAppId: string,
  requestedFallback: readonly string[] | undefined,
  eligible: readonly CandidateEvaluation[],
  unsuitableIds: ReadonlySet<string>,
): string[] {
  const allowed = new Set(eligible.map(c => c.larkAppId).filter(id => !unsuitableIds.has(id)));
  const ordered: string[] = [selectedAppId];
  const seen = new Set<string>([selectedAppId]);
  for (const id of requestedFallback ?? []) {
    if (allowed.has(id) && !seen.has(id)) {
      ordered.push(id);
      seen.add(id);
    }
  }
  // Append remaining suitable candidates in baseline order so fallback chain is complete.
  for (const candidate of eligible) {
    if (allowed.has(candidate.larkAppId) && !seen.has(candidate.larkAppId)) {
      ordered.push(candidate.larkAppId);
      seen.add(candidate.larkAppId);
    }
  }
  return ordered;
}

/**
 * Full two-stage bot selection (Stage 1 deterministic rules + Stage 2 optional bot semantic matcher).
 */
export async function selectBotForTask(input: SelectBotForTaskInput): Promise<TaskRoutingDecision> {
  const nowMs = input.nowMs ?? Date.now();
  const constraints = input.constraints ?? {};
  const { eligible, excluded } = evaluateCandidates(input.snapshots, constraints, nowMs);

  if (eligible.length === 0) {
    const anyParticipating = input.snapshots.some(s => s.profile.enabled && !s.isSteward && !s.apiOnly);
    const reason = !anyParticipating && !constraints.only?.length && !constraints.prefer
      ? '尚未配置任何参与任务分配的 Bot（请在 Bot 配置中开启 taskRouting.enabled）'
      : '当前没有可用的候选 Bot（全部候选均被规则排除，详见 excluded 列表）';
    return {
      selectedAppId: null,
      selectedName: null,
      fallbackOrder: [],
      matcherKind: 'rule',
      confidence: 'low',
      reason,
      candidates: [],
      excluded,
    };
  }

  const singleOnly = constraints.only?.length === 1 && eligible[0]!.larkAppId === constraints.only[0];
  const callerPreferredWithExplicitReason = Boolean(
    constraints.prefer
    && eligible[0]!.larkAppId === constraints.prefer
    && input.callerReason?.trim(),
  );

  // Skip LLM matcher when caller explicitly pinned the bot or disabled LLM or configured rule-only.
  const shouldInvokeMatcher = Boolean(
    input.matcherConfig?.mode === 'bot'
    && input.matcherConfig.botAppId
    && input.invokeMatcher
    && !input.noLlm
    && !singleOnly
    && !callerPreferredWithExplicitReason
    && eligible.length > 1,
  );

  if (!shouldInvokeMatcher) {
    const winner = eligible[0]!;
    const isOverride = singleOnly || (constraints.prefer === winner.larkAppId);
    return {
      selectedAppId: winner.larkAppId,
      selectedName: winner.name,
      fallbackOrder: eligible.map(c => c.larkAppId),
      matcherKind: isOverride ? 'caller_override' : 'rule',
      confidence: isOverride ? 'high' : 'medium',
      reason: buildBaselineReason(winner, constraints, undefined, input.callerReason),
      candidates: eligible,
      excluded,
    };
  }

  // Stage 2: invoke bot semantic matcher with strict output validation and fail-safe fallback.
  let matcherOutcome: SemanticMatchInvokeResult;
  try {
    matcherOutcome = await input.invokeMatcher!({
      task: input.task,
      ...(input.policy ? { policy: input.policy } : {}),
      ...(constraints.prefer ? { preferAppId: constraints.prefer } : {}),
      candidates: eligible,
    });
  } catch (err) {
    matcherOutcome = {
      ok: false,
      errorCode: 'matcher_exception',
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  const fallbackToRule = (matcherNote: string): TaskRoutingDecision => {
    const winner = eligible[0]!;
    return {
      selectedAppId: winner.larkAppId,
      selectedName: winner.name,
      fallbackOrder: eligible.map(c => c.larkAppId),
      matcherKind: 'rule',
      confidence: 'low',
      reason: buildBaselineReason(winner, constraints, matcherNote, input.callerReason),
      fallbackFromMatcher: matcherNote,
      candidates: eligible,
      excluded,
    };
  };

  if (!matcherOutcome.ok) {
    return fallbackToRule(`调用失败（${matcherOutcome.errorCode}）`);
  }

  const match = matcherOutcome.match;
  const eligibleById = new Map(eligible.map(c => [c.larkAppId, c]));
  const selected = eligibleById.get(match.selectedAppId);
  if (!selected) {
    return fallbackToRule('返回了不在合法候选池内的 Bot');
  }

  // "拿不准时选便宜的": low-confidence matcher verdict falls back to cheapest/idle baseline.
  if (match.confidence === 'low') {
    return fallbackToRule('置信度低（拿不准）');
  }

  // Apply profile_mismatch exclusions reported by the matcher (never excluding the winner or caller --prefer).
  const unsuitableMap = new Map<string, string>();
  for (const item of match.unsuitable ?? []) {
    if (!item || typeof item.appId !== 'string') continue;
    if (item.appId === selected.larkAppId) continue;
    if (constraints.prefer && item.appId === constraints.prefer) continue;
    if (!eligibleById.has(item.appId)) continue;
    const reason = item.reason?.trim() || '画像与当前任务不匹配';
    unsuitableMap.set(item.appId, reason);
  }

  // Guard: never let matcher empty out every candidate.
  const remainingCandidates = eligible.filter(c => !unsuitableMap.has(c.larkAppId));
  const profileExcluded: CandidateEvaluation[] = eligible
    .filter(c => unsuitableMap.has(c.larkAppId))
    .map(c => ({
      ...c,
      eligible: false,
      exclusionCode: 'profile_mismatch' as const,
      exclusionReason: unsuitableMap.get(c.larkAppId)!,
    }));

  const fallbackOrder = sanitizeMatcherOrder(
    selected.larkAppId,
    match.fallbackOrder,
    eligible,
    new Set(unsuitableMap.keys()),
  );

  // Reorder candidates array to match fallbackOrder so callers see ranked order directly.
  const orderedCandidates = fallbackOrder
    .map(id => remainingCandidates.find(c => c.larkAppId === id))
    .filter((c): c is CandidateEvaluation => Boolean(c));

  const cleanReason = input.callerReason?.trim()
    || match.reason.trim()
    || `语义裁判选择 ${selected.name}（${costTierLabelZh(selected.costTier)}档）`;

  return {
    selectedAppId: selected.larkAppId,
    selectedName: selected.name,
    fallbackOrder,
    matcherKind: 'bot',
    confidence: match.confidence,
    reason: cleanReason,
    candidates: orderedCandidates,
    excluded: [...excluded, ...profileExcluded],
  };
}
