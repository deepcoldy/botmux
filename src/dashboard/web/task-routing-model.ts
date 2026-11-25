/**
 * 任务分配页面（#/assign）纯前端视图模型与格式化函数（零 DOM / 零网络，便于单测）。
 */

import type {
  CandidateEvaluation,
  TaskRoutingAttempt,
  TaskRoutingCallerKind,
  TaskRoutingConfidence,
  TaskRoutingConstraints,
  TaskRoutingCostTier,
  TaskRoutingDecision,
  TaskRoutingExclusionCode,
  TaskRoutingMatcherKind,
  TaskRoutingOutcome,
  TaskRoutingRecord,
} from '../../core/task-routing/model.js';

/** 全局设置页切换「启用 Bot 任务分配」后发此事件，通知 app.tsx 立即刷新侧边栏可见性。 */
export const TASK_ROUTING_CHANGED_EVENT = 'botmux:task-routing-changed';

export function dispatchTaskRoutingChanged(enabled?: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    window.dispatchEvent(new CustomEvent(TASK_ROUTING_CHANGED_EVENT, {
      detail: typeof enabled === 'boolean' ? { enabled } : undefined,
    }));
  } catch {
    // 非浏览器环境或测试桩无 CustomEvent 时退回普通 Event
    try { window.dispatchEvent(new Event(TASK_ROUTING_CHANGED_EVENT)); } catch { /* ignore */ }
  }
}

export interface TaskRoutingStatusResponse {
  ok: true;
  enabled: boolean;
  matcherMode: 'rule' | 'bot' | string;
  matcherBotAppId: string | null;
  matcherBotName?: string | null;
  matcherTimeoutMs: number;
  policy: string;
  eligible: CandidateEvaluation[];
  excluded: CandidateEvaluation[];
}

export interface TaskRoutingHistoryResponse {
  ok: true;
  enabled: boolean;
  records: TaskRoutingRecord[];
}

export interface TaskRoutingRecommendResponse {
  ok: true;
  decision: TaskRoutingDecision;
  constraints: TaskRoutingConstraints;
}

export type TaskRoutingTranslate = (key: string, params?: Record<string, string | number>) => string;

export type TaskRoutingBadgeTone = 'ok' | 'warn' | 'danger' | 'info' | 'muted' | 'accent';

export function costTierLabelKey(tier: TaskRoutingCostTier): string {
  switch (tier) {
    case 'low': return 'taskRouting.tierLow';
    case 'medium': return 'taskRouting.tierMedium';
    case 'high': return 'taskRouting.tierHigh';
  }
}

export function costTierTone(tier: TaskRoutingCostTier): TaskRoutingBadgeTone {
  switch (tier) {
    case 'low': return 'ok';
    case 'medium': return 'info';
    case 'high': return 'accent';
  }
}

export function outcomeLabelKey(outcome: TaskRoutingOutcome): string {
  switch (outcome) {
    case 'dispatched': return 'taskRouting.outcomeDispatched';
    case 'fallback_dispatched': return 'taskRouting.outcomeFallback';
    case 'failed': return 'taskRouting.outcomeFailed';
    case 'pending': return 'taskRouting.outcomePending';
  }
}

export function outcomeTone(outcome: TaskRoutingOutcome): TaskRoutingBadgeTone {
  switch (outcome) {
    case 'dispatched': return 'ok';
    case 'fallback_dispatched': return 'warn';
    case 'failed': return 'danger';
    case 'pending': return 'info';
  }
}

export function matcherKindLabelKey(kind: TaskRoutingMatcherKind): string {
  switch (kind) {
    case 'rule': return 'taskRouting.matcherKindRule';
    case 'bot': return 'taskRouting.matcherKindBot';
    case 'caller_override': return 'taskRouting.matcherKindOverride';
  }
}

export function confidenceLabelKey(confidence: TaskRoutingConfidence): string {
  switch (confidence) {
    case 'high': return 'taskRouting.confidenceHigh';
    case 'medium': return 'taskRouting.confidenceMedium';
    case 'low': return 'taskRouting.confidenceLow';
  }
}

export function callerKindLabelKey(kind: TaskRoutingCallerKind): string {
  switch (kind) {
    case 'host_cli': return 'taskRouting.callerHostCli';
    case 'owner_turn': return 'taskRouting.callerOwnerTurn';
    case 'steward_session': return 'taskRouting.callerSteward';
  }
}

export function exclusionCodeLabelKey(code: TaskRoutingExclusionCode): string {
  switch (code) {
    case 'not_participating': return 'taskRouting.exNotParticipating';
    case 'steward_bot': return 'taskRouting.exStewardBot';
    case 'api_only': return 'taskRouting.exApiOnly';
    case 'excluded_by_caller': return 'taskRouting.exExcludedByCaller';
    case 'not_in_only_filter': return 'taskRouting.exNotInOnlyFilter';
    case 'offline': return 'taskRouting.exOffline';
    case 'lark_disconnected': return 'taskRouting.exLarkDisconnected';
    case 'at_capacity': return 'taskRouting.exAtCapacity';
    case 'quota_exhausted': return 'taskRouting.exQuotaExhausted';
    case 'in_cooldown': return 'taskRouting.exInCooldown';
    case 'budget_exceeded': return 'taskRouting.exBudgetExceeded';
    case 'profile_mismatch': return 'taskRouting.exProfileMismatch';
  }
}

export function attemptOutcomeLabelKey(outcome: TaskRoutingAttempt['outcome']): string {
  switch (outcome) {
    case 'dispatched': return 'taskRouting.attemptDispatched';
    case 'skipped': return 'taskRouting.attemptSkipped';
    case 'failed': return 'taskRouting.attemptFailed';
  }
}

export function attemptOutcomeTone(outcome: TaskRoutingAttempt['outcome']): TaskRoutingBadgeTone {
  switch (outcome) {
    case 'dispatched': return 'ok';
    case 'skipped': return 'warn';
    case 'failed': return 'danger';
  }
}

export interface RuntimePill {
  id: string;
  label: string;
  tone: TaskRoutingBadgeTone;
}

/** 将候选 Bot 的实时运行态转成一组简洁状态胶囊，供桌面卡片与窄侧栏共用。 */
export function buildBotRuntimePills(candidate: CandidateEvaluation, tr: TaskRoutingTranslate): RuntimePill[] {
  const rt = candidate.runtime;
  const pills: RuntimePill[] = [];

  if (!rt.online) {
    pills.push({ id: 'online', label: tr('taskRouting.pillOffline'), tone: 'danger' });
    return pills;
  }

  if (rt.larkConnected === false) {
    pills.push({ id: 'lark', label: tr('taskRouting.pillLarkDisconnected'), tone: 'danger' });
  }

  if (typeof rt.workingCount === 'number') {
    const queued = typeof rt.queuedCount === 'number' ? rt.queuedCount : 0;
    if (rt.workingCount === 0 && queued === 0) {
      pills.push({ id: 'load', label: tr('taskRouting.pillIdle'), tone: 'ok' });
    } else if (queued > 0) {
      pills.push({
        id: 'load',
        label: tr('taskRouting.pillBusyQueued', { working: rt.workingCount, queued }),
        tone: 'warn',
      });
    } else {
      pills.push({
        id: 'load',
        label: tr('taskRouting.pillWorking', { working: rt.workingCount }),
        tone: 'info',
      });
    }
  } else {
    pills.push({ id: 'load', label: tr('taskRouting.pillOnline'), tone: 'info' });
  }

  if (rt.maxLiveWorkers != null && typeof rt.residentCount === 'number') {
    const atCap = rt.residentCount >= rt.maxLiveWorkers;
    pills.push({
      id: 'capacity',
      label: tr('taskRouting.pillCapacity', { resident: rt.residentCount, max: rt.maxLiveWorkers }),
      tone: atCap ? 'danger' : 'muted',
    });
  }

  if (rt.agyAccounts?.managed) {
    const { availableCount, enabledCount } = rt.agyAccounts;
    pills.push({
      id: 'agy',
      label: tr('taskRouting.pillAgy', { available: availableCount, enabled: enabledCount }),
      tone: availableCount === 0 ? 'danger' : availableCount < enabledCount ? 'warn' : 'ok',
    });
  }

  if (typeof rt.limitedCount === 'number' && rt.limitedCount > 0) {
    pills.push({
      id: 'cooldown',
      label: tr('taskRouting.pillCooldown', { count: rt.limitedCount }),
      tone: 'warn',
    });
  }

  if (rt.budget) {
    pills.push({
      id: 'budget',
      label: tr('taskRouting.pillBudget', {
        spent: Math.round(rt.budget.spentCny),
        limit: Math.round(rt.budget.monthlyCny),
      }),
      tone: rt.budget.exceeded ? 'danger' : rt.budget.percent >= 80 ? 'warn' : 'muted',
    });
  }

  return pills;
}

export interface TaskRoutingPoolSummary {
  eligibleCount: number;
  idleCount: number;
  busyCount: number;
  excludedCount: number;
  participatingExcludedCount: number;
  nonParticipatingCount: number;
}

export function summarizeTaskRoutingPool(
  status: Pick<TaskRoutingStatusResponse, 'eligible' | 'excluded'>,
): TaskRoutingPoolSummary {
  let idleCount = 0;
  let busyCount = 0;
  for (const c of status.eligible) {
    const working = typeof c.runtime.workingCount === 'number' ? c.runtime.workingCount : 0;
    const queued = typeof c.runtime.queuedCount === 'number' ? c.runtime.queuedCount : 0;
    if (working === 0 && queued === 0) idleCount++;
    else busyCount++;
  }
  let participatingExcludedCount = 0;
  let nonParticipatingCount = 0;
  for (const c of status.excluded) {
    if (c.participating) participatingExcludedCount++;
    else nonParticipatingCount++;
  }
  return {
    eligibleCount: status.eligible.length,
    idleCount,
    busyCount,
    excludedCount: status.excluded.length,
    participatingExcludedCount,
    nonParticipatingCount,
  };
}

/** 排序展示被排除 Bot：已参与分配但因实时故障/额度/满载被排除的排前面，未参与/管家/仅 API 排后面。 */
export function sortExcludedCandidates(excluded: readonly CandidateEvaluation[]): CandidateEvaluation[] {
  return [...excluded].sort((a, b) => {
    if (a.participating !== b.participating) return a.participating ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

export function hasFallbackSwitch(record: Pick<TaskRoutingRecord, 'outcome' | 'attempts'>): boolean {
  return record.outcome === 'fallback_dispatched' || record.attempts.length > 1;
}

export function filterTaskRoutingRecords(
  records: readonly TaskRoutingRecord[],
  filter: { botAppId?: string; outcome?: TaskRoutingOutcome | 'all' },
): TaskRoutingRecord[] {
  const bot = filter.botAppId?.trim() || '';
  const outcome = filter.outcome && filter.outcome !== 'all' ? filter.outcome : '';
  return records.filter(record => {
    if (outcome && record.outcome !== outcome) return false;
    if (bot) {
      const hitSelected = record.selectedAppId === bot;
      const hitAttempt = record.attempts.some(a => a.appId === bot);
      if (!hitSelected && !hitAttempt) return false;
    }
    return true;
  });
}

export function formatRoutingTime(ms: number, nowMs: number, tr: TaskRoutingTranslate): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  const diffSec = Math.max(0, Math.floor((nowMs - ms) / 1_000));
  if (diffSec < 60) return tr('taskRouting.timeJustNow');
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return tr('taskRouting.timeMinutes', { n: diffMin });
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return tr('taskRouting.timeHours', { n: diffHour });
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
