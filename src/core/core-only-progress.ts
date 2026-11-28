import { usageLimitStateKey, type CliUsageLimitState } from '../utils/cli-usage-limit.js';
import type { DaemonSession } from './types.js';
import type { CotEntry } from '../types.js';
import type { NativeGoalState } from '../services/native-goal-state.js';

/**
 * Usage shown beside a native gateway's progress. The IPC progress route copies
 * it from the daemon's card usage snapshot (`getDaemonSessionUsageSnapshot`),
 * the same facts the Lark streaming card renders:
 * - `context`: the latest context-window measurement;
 * - `tokens`: the session's cumulative `in` / `out`; `cacheReadTokens` and
 *   `cacheCreateTokens`, when present, are subsets of `in`;
 * - `turnTokens`: the latest user turn's delta, null when the CLI does not track it.
 * Some producers also put cost-accounting fields (`inputTokens`, …) inside
 * `tokens`; others (Remote Runner) do not, so a reader must not rely on them.
 */
export interface CoreOnlyProgressUsage {
  context: { usedTokens: number; windowTokens?: number; percentUsed?: number } | null;
  tokens: { in: number; out: number; cacheReadTokens?: number; cacheCreateTokens?: number } | null;
  turnTokens: { in: number; out: number } | null;
}

export interface CoreOnlyProgress {
  turnId: string;
  workerGeneration: number;
  entries: CotEntry[];
  limit?: { kind: 'usage' | 'rate'; retryAtMs: number; key: string };
  model?: string;
  lastProgressAtMs?: number;
  goal?: NativeGoalState | null;
  executionStartedAtMs?: number;
  dispatchAttempt?: number;
  /** Added by the IPC progress route; the projection below never sets it. */
  usage?: CoreOnlyProgressUsage;
}

type ProgressSession = Pick<DaemonSession, 'workerGeneration' | 'lastThinkingUpdate' | 'replyExecutionStarts' | 'asyncTriggerResults' | 'principalLaneRunningTurn' | 'activeInteractiveTurn' | 'turnDispatchAttemptHighWater' | 'nativeGatewayLimit' | 'usageLimit'> & {
  lastNativeGatewayGoal?: { goal: NativeGoalState | null; turnId: string; dispatchAttempt?: number; workerGeneration: number };
};
function ownsPendingTurn(ds: ProgressSession, triggerId: string): boolean {
  if (!triggerId || !ds.workerGeneration || ds.asyncTriggerResults?.get(triggerId)?.status !== 'pending') return false;
  const turn = ds.principalLaneRunningTurn;
  return turn ? turn.turnId === triggerId && turn.workerGeneration === ds.workerGeneration : ds.activeInteractiveTurn?.turnId === triggerId;
}
function ownsAttempt(ds: ProgressSession, turnId: string, attempt: number | undefined): boolean {
  const highWater = ds.turnDispatchAttemptHighWater;
  return !highWater || highWater.turnId !== turnId || attempt === highWater.dispatchAttempt;
}
/** Caller has already checked current worker ownership. No disk, timer or IM effects. */
export function rememberCoreOnlyGoal(ds: ProgressSession & { initConfig?: { apiOnly?: boolean } }, message: { goal: NativeGoalState | null; turnId?: string; dispatchAttempt?: number }, workerGeneration: number | undefined): boolean {
  if (ds.initConfig?.apiOnly !== true || !message.turnId || workerGeneration !== ds.workerGeneration
    || !ownsPendingTurn(ds, message.turnId) || !ownsAttempt(ds, message.turnId, message.dispatchAttempt)) return false;
  ds.lastNativeGatewayGoal = { goal: structuredClone(message.goal), turnId: message.turnId, dispatchAttempt: message.dispatchAttempt, workerGeneration: workerGeneration! };
  return true;
}
/**
 * Record the structured usage / rate limit a native gateway may show for one
 * turn. Caller has already checked current worker ownership and proved that
 * `turnId` is the turn this screen belongs to. An ordinary (non-API-only)
 * session never records one. No disk, timer or IM effects.
 */
export function rememberCoreOnlyLimit(
  ds: Pick<DaemonSession, 'nativeGatewayLimit'> & { initConfig?: { apiOnly?: boolean } },
  message: { structuredNativeGatewayLimit?: boolean; usageLimit?: CliUsageLimitState; dispatchAttempt?: number },
  turnId: string | undefined,
  workerGeneration: number | undefined,
): boolean {
  const limit = message.usageLimit;
  if (ds.initConfig?.apiOnly !== true || !turnId || !message.structuredNativeGatewayLimit || !limit || !workerGeneration) {
    return false;
  }
  ds.nativeGatewayLimit = {
    turnId,
    workerGeneration,
    dispatchAttempt: message.dispatchAttempt,
    key: usageLimitStateKey(limit),
    kind: limit.kind,
    retryAtMs: limit.retryAtMs,
  };
  return true;
}
/** Read-only, exact-turn projection. Caller proves apiOnly + owning bot + HTTP
 * virtual session. Never infer current output from a previous turn or worker. */
export function projectCoreOnlyProgress(ds: ProgressSession, triggerId: string): CoreOnlyProgress | undefined {
  if (!ownsPendingTurn(ds, triggerId)) return;
  const cached = ds.lastThinkingUpdate?.turnId === triggerId ? ds.lastThinkingUpdate : undefined;
  const thinking = cached && cached.workerGeneration === ds.workerGeneration && ownsAttempt(ds, triggerId, cached.dispatchAttempt) ? cached : undefined;
  const attempt = ds.turnDispatchAttemptHighWater?.turnId === triggerId ? ds.turnDispatchAttemptHighWater.dispatchAttempt : thinking?.dispatchAttempt;
  const execution = ds.replyExecutionStarts?.get(JSON.stringify([triggerId, attempt ?? null]));
  const goal = ds.lastNativeGatewayGoal;
  // The recorded limit counts only while it is still the session's current,
  // unexpired limit for this exact turn, worker generation and attempt.
  const recordedLimit = ds.nativeGatewayLimit;
  const limitIsCurrent = recordedLimit?.turnId === triggerId
    && recordedLimit.workerGeneration === ds.workerGeneration
    && ownsAttempt(ds, triggerId, recordedLimit.dispatchAttempt)
    && !!ds.usageLimit
    && !ds.usageLimit.retryReady
    && recordedLimit.key === usageLimitStateKey(ds.usageLimit);
  return {
    turnId: triggerId, workerGeneration: ds.workerGeneration!,
    ...(limitIsCurrent && recordedLimit
      ? { limit: { kind: recordedLimit.kind, retryAtMs: recordedLimit.retryAtMs, key: recordedLimit.key } }
      : {}),
    entries: structuredClone(thinking?.entries ?? []).slice(-80),
    ...(execution && !execution.completed && execution.workerGeneration === ds.workerGeneration ? { executionStartedAtMs: execution.startedAtMs, ...(attempt === undefined ? {} : { dispatchAttempt: attempt }) } : {}),
    ...(goal?.turnId === triggerId && goal.workerGeneration === ds.workerGeneration && ownsAttempt(ds, triggerId, goal.dispatchAttempt) ? { goal: structuredClone(goal.goal) } : {}),
    ...(execution && execution.workerGeneration === ds.workerGeneration && execution.lastProgressAtMs !== undefined
      ? { lastProgressAtMs: execution.lastProgressAtMs } : {}),
  };
}
