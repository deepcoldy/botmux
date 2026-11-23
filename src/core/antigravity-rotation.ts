/**
 * Daemon-side orchestration for Antigravity (`agy`) quota-limit auto-rotation.
 *
 * Pure state machine with injected I/O seams so every interleaving (manual user
 * intervention during restart, multi-hop rotation budget exhaustion, concurrent
 * session rotation, restart failure/cancellation, worker-reported account
 * override) can be verified deterministically without live PTYs or Lark APIs.
 */
import { randomUUID } from 'node:crypto';
import type { CliUsageLimitState } from '../utils/cli-usage-limit.js';
import { usageLimitStateKey } from '../utils/cli-usage-limit.js';
import type { RestartObserverStatus } from './restart-coordinator.js';
import {
  maskAntigravityEmail,
  type AntigravityAccountsInspection,
  type QuotaRotateAntigravityParams,
  type QuotaRotateAntigravityResult,
} from '../services/antigravity-accounts.js';

export const MAX_ANTIGRAVITY_ROTATIONS_PER_TURN = 8;

export interface AntigravitySessionRotationState {
  /** Logical turn being recovered (groups multi-hop retries across accounts). */
  logicalTurnId: string;
  /** Account IDs already tried in this logical turn (prevents ping-pong loops). */
  attemptedAccountIds: string[];
  /** Number of auto-rotation hops started for this logical turn. */
  rotationsUsed: number;
  /** Unique token for the currently in-flight rotate -> restart -> replay transaction. */
  inFlightToken?: string;
  /** Target account ID being restarted into. */
  pendingAccountId?: string;
  /** Turn ID of the last auto-replayed input (links a replayed turn's limit back to logicalTurnId). */
  lastReplayTurnId?: string;
  /** Restart attempt whose worker account observation may settle this rotation. */
  restartAttemptId?: string;
  /** Session lastMessageAt snapshot when rotation started (detects manual intervention). */
  startedAtLastMessageAt?: number;
  /** Set when worker reports the authoritative post-spawn account ID during restart.
   *  `null` explicitly signals that pre-spawn reconciliation failed on the worker. */
  workerReportedAccountId?: string | null;
  /** Set when the user explicitly ran `/stop` during an in-flight rotation restart. */
  replayCancelledByUser?: boolean;
  /** A replay may already have been accepted, but its receipt/state could not be
   * persisted. The same logical turn must not be replayed again automatically. */
  replayUncertain?: boolean;
}

/** Mark an in-flight rotation restart so it adopts the new account without auto-replaying. */
export function cancelAntigravityRotationReplay(
  state: AntigravitySessionRotationState | undefined,
): boolean {
  if (!state?.inFlightToken) return false;
  state.replayCancelledByUser = true;
  return true;
}

/** Strip in-flight transaction fields when a worker generation is replaced or retired,
 *  preserving per-turn history so subsequent turns are not wedged. */
export function clearInFlightAntigravityRotation(
  state: AntigravitySessionRotationState | undefined,
): AntigravitySessionRotationState | undefined {
  if (!state) return undefined;
  return {
    logicalTurnId: state.logicalTurnId,
    attemptedAccountIds: state.attemptedAccountIds,
    rotationsUsed: state.rotationsUsed,
    ...(state.lastReplayTurnId ? { lastReplayTurnId: state.lastReplayTurnId } : {}),
    ...(state.replayUncertain ? { replayUncertain: true } : {}),
  };
}

export interface AntigravityReplayPayload {
  sourceTurnId?: string;
  cliInput: string;
  userPrompt: string;
}

export interface AntigravityAutoRotateEligibilityInput {
  effectiveCliId: string;
  usageLimit?: CliUsageLimitState;
  suppressRecoveryCard?: boolean;
  isAdoptSession?: boolean;
  isRemoteBackend?: boolean;
  isTransferring?: boolean;
  hasProtectedMutation?: boolean;
  hasPendingFork?: boolean;
  restartInFlight?: boolean;
  currentRotation?: AntigravitySessionRotationState;
}

/** Fail-closed eligibility gate: only genuine native Antigravity quota errors on
 *  local, owned, non-transferring sessions may trigger automatic rotation. */
export function isAntigravityQuotaAutoRotateEligible(input: AntigravityAutoRotateEligibilityInput): boolean {
  if (input.effectiveCliId !== 'antigravity') return false;
  if (!input.usageLimit?.limited) return false;
  if (input.usageLimit.kind !== 'usage') return false;
  if (input.usageLimit.source !== 'antigravity-error-composer'
    && input.usageLimit.source !== 'antigravity-native-log') return false;
  if (input.suppressRecoveryCard) return false;
  if (input.isAdoptSession) return false;
  if (input.isRemoteBackend) return false;
  if (input.isTransferring) return false;
  if (input.hasProtectedMutation) return false;
  if (input.hasPendingFork) return false;
  if (input.restartInFlight) return false;
  if (input.currentRotation?.inFlightToken) return false;
  return true;
}

export interface AntigravityQuotaAutoRotateDeps {
  effectiveCliId: string;
  usageLimit?: CliUsageLimitState;
  suppressRecoveryCard?: boolean;
  isAdoptSession?: boolean;
  isRemoteBackend?: boolean;
  isTransferring?: boolean;
  hasProtectedMutation?: boolean;
  hasPendingFork?: boolean;
  restartInFlight?: boolean;
  /** Active account ID bound to this session's running `agy` process (if known). */
  sessionAccountId?: string;
  /** Turn ID associated with the screen_update (if proven). */
  screenTurnId?: string;
  /** Last CLI input turn ID on the session. */
  lastCliInputTurnId?: string;
  /** Current session lastMessageAt (epoch ms). */
  lastMessageAt: number;
  /** Exact failed input to replay after restart, if available. */
  replayPayload?: AntigravityReplayPayload;
  /** Hard per-turn rotation cap (defaults to MAX_ANTIGRAVITY_ROTATIONS_PER_TURN). */
  maxRotationsPerTurn?: number;
  createToken?: () => string;
  getRotationState: () => AntigravitySessionRotationState | undefined;
  setRotationState: (state: AntigravitySessionRotationState | undefined) => void;
  rotateAccount: (params: QuotaRotateAntigravityParams) => QuotaRotateAntigravityResult;
  requestRestart: (onSettled: (status: RestartObserverStatus) => void | Promise<void>) => { started: boolean; attemptId?: string };
  /** True while the original worker generation still owns this active session. */
  isStillOwned: () => boolean;
  /** True while the logical session is still active in the daemon (even if the
   *  worker process just exited during restart and `ds.worker` became null). */
  isSessionActive?: () => boolean;
  hasManualIntervention: (startedAtLastMessageAt: number, capturedTurnId?: string) => boolean;
  updateSessionAccount: (accountId: string) => void;
  clearUsageLimit: () => void;
  replayTurn: (payload: AntigravityReplayPayload) => {
    accepted: boolean;
    retryTurnId?: string;
    /** Accepted by the worker, but a post-acceptance state write failed. */
    persistenceError?: string;
  };
  notifySwitching: (info: {
    fromId?: string;
    toId: string;
    toEmail?: string;
    alreadyRotated: boolean;
    willAutoReplay: boolean;
  }) => void;
  notifyRestartFailed: (info: { toId: string; toEmail?: string; status: Exclude<RestartObserverStatus, 'in_progress' | 'succeeded' | 'cancelled'> }) => void;
  notifyManualReplayNeeded: (info: { toId: string; toEmail?: string }) => void;
  notifyReplayFailed: (info: { toId: string; toEmail?: string }) => void;
  /** Restart succeeded, but account/limit settlement failed before any replay. */
  notifySettleFailed: (info: { toId: string; toEmail?: string; error: string }) => void;
  /** Replay acceptance/receipt is ambiguous; users must inspect before retrying. */
  notifyReplayUncertain: (info: { toId: string; toEmail?: string; error: string }) => void;
}

export type AntigravityQuotaAutoRotateDecision =
  | { outcome: 'ineligible' }
  | { outcome: 'disabled' }
  | { outcome: 'identity_unknown' }
  | { outcome: 'started'; fromId?: string; toId: string; toEmail?: string; alreadyRotated: boolean }
  | {
      outcome: 'exhausted';
      reason: 'all_in_cooldown' | 'turn_budget_exhausted';
      fromId?: string;
      fromEmail?: string;
      earliestRecoveryMs?: number;
      enabledCount?: number;
    }
  | { outcome: 'write_failed'; error: string }
  | { outcome: 'restart_refused'; toId: string };

function isContinuingLogicalTurn(
  prev: AntigravitySessionRotationState | undefined,
  screenTurnId: string | undefined,
  lastCliInputTurnId: string | undefined,
  limitKey: string,
): boolean {
  if (!prev) return false;
  if (prev.lastReplayTurnId !== undefined
    && (screenTurnId === prev.lastReplayTurnId || lastCliInputTurnId === prev.lastReplayTurnId)) {
    return true;
  }
  if (screenTurnId !== undefined && screenTurnId === prev.logicalTurnId) {
    return true;
  }
  // Direct Web Terminal turns have no daemon turn ID. Receiving the identical
  // native quota episode after a restart is the same recovery attempt, not a
  // fresh budget. A new direct submission clears the settled state in the pool.
  if (screenTurnId === undefined && lastCliInputTurnId === undefined) {
    return prev.logicalTurnId === limitKey;
  }
  return false;
}

/**
 * Attempt quota-limit auto-rotation for one Antigravity session.
 *
 * Returns `started` when rotation + restart is now owned by this coordinator
 * (caller should suppress duplicate `@owner` limit spam and backup-bot handoff).
 * Returns `disabled` / `exhausted` / `write_failed` / `restart_refused` when
 * normal owner notifications and `quotaFallbackBot` should proceed.
 */
export function tryAntigravityQuotaAutoRotate(
  deps: AntigravityQuotaAutoRotateDeps,
): AntigravityQuotaAutoRotateDecision {
  const prev = deps.getRotationState();
  if (!isAntigravityQuotaAutoRotateEligible({
    effectiveCliId: deps.effectiveCliId,
    usageLimit: deps.usageLimit,
    suppressRecoveryCard: deps.suppressRecoveryCard,
    isAdoptSession: deps.isAdoptSession,
    isRemoteBackend: deps.isRemoteBackend,
    isTransferring: deps.isTransferring,
    hasProtectedMutation: deps.hasProtectedMutation,
    hasPendingFork: deps.hasPendingFork,
    restartInFlight: deps.restartInFlight,
    currentRotation: prev,
  })) {
    return { outcome: 'ineligible' };
  }

  const limit = deps.usageLimit!;
  const limitKey = usageLimitStateKey(limit);
  const maxRotations = deps.maxRotationsPerTurn ?? MAX_ANTIGRAVITY_ROTATIONS_PER_TURN;
  const continuing = isContinuingLogicalTurn(prev, deps.screenTurnId, deps.lastCliInputTurnId, limitKey);
  // Once replay acceptance is uncertain, never run the same logical turn again
  // automatically. A genuinely new user turn starts a fresh rotation state.
  if (continuing && prev?.replayUncertain) return { outcome: 'disabled' };
  const logicalTurnId = continuing
    ? prev!.logicalTurnId
    : (deps.screenTurnId ?? deps.lastCliInputTurnId ?? limitKey);
  const attempted = continuing ? [...prev!.attemptedAccountIds] : [];
  const rotationsUsed = continuing ? prev!.rotationsUsed : 0;

  if (deps.sessionAccountId && !attempted.includes(deps.sessionAccountId)) {
    attempted.push(deps.sessionAccountId);
  }

  if (rotationsUsed >= maxRotations) {
    return {
      outcome: 'exhausted',
      reason: 'turn_budget_exhausted',
      fromId: deps.sessionAccountId,
    };
  }

  let rotation: QuotaRotateAntigravityResult;
  try {
    rotation = deps.rotateAccount({
      failedAccountId: deps.sessionAccountId,
      cooldownUntilMs: limit.retryAtMs,
      reason: 'usage_limit',
      excludeAccountIds: attempted,
    });
  } catch (err) {
    return {
      outcome: 'write_failed',
      error: err instanceof Error ? err.message : String(err),
    };
  }

  if (rotation.outcome === 'disabled') {
    return { outcome: 'disabled' };
  }
  if (rotation.outcome === 'identity_unknown') {
    return { outcome: 'identity_unknown' };
  }
  if (rotation.outcome === 'write_failed') {
    return { outcome: 'write_failed', error: rotation.error };
  }
  if (rotation.outcome === 'exhausted') {
    const updatedAttempted = rotation.fromId && !attempted.includes(rotation.fromId)
      ? [...attempted, rotation.fromId]
      : attempted;
    deps.setRotationState({
      logicalTurnId,
      attemptedAccountIds: updatedAttempted,
      rotationsUsed,
      ...(continuing && prev?.lastReplayTurnId ? { lastReplayTurnId: prev.lastReplayTurnId } : {}),
    });
    return {
      outcome: 'exhausted',
      reason: 'all_in_cooldown',
      fromId: rotation.fromId,
      fromEmail: rotation.fromEmail,
      earliestRecoveryMs: rotation.earliestRecoveryMs,
      enabledCount: rotation.enabledCount,
    };
  }

  const nextAttempted = [...attempted];
  const targetAlreadyAttempted = nextAttempted.includes(rotation.toId);
  if (rotation.fromId && !nextAttempted.includes(rotation.fromId)) nextAttempted.push(rotation.fromId);
  if (!nextAttempted.includes(rotation.toId)) nextAttempted.push(rotation.toId);

  const inFlightToken = (deps.createToken ?? randomUUID)();
  const capturedTurnId = deps.replayPayload?.sourceTurnId ?? deps.screenTurnId ?? deps.lastCliInputTurnId;
  const startedAtLastMessageAt = deps.lastMessageAt;

  const nextState: AntigravitySessionRotationState = {
    logicalTurnId,
    attemptedAccountIds: nextAttempted,
    rotationsUsed: rotationsUsed + 1,
    inFlightToken,
    pendingAccountId: rotation.toId,
    startedAtLastMessageAt,
    ...(continuing && prev?.lastReplayTurnId ? { lastReplayTurnId: prev.lastReplayTurnId } : {}),
  };
  deps.setRotationState(nextState);

  const onRestartSettled = (status: RestartObserverStatus): void => {
    if (status === 'in_progress') return;
    const current = deps.getRotationState();
    if (current?.inFlightToken !== inFlightToken) return;

    if (status !== 'succeeded') {
      // Always release the in-flight fence even if worker.on('exit') already
      // nulled ds.worker before this microtask ran, so the session never wedges.
      deps.setRotationState(clearInFlightAntigravityRotation(current));
      const sessionAlive = deps.isSessionActive ? deps.isSessionActive() : deps.isStillOwned();
      if (status !== 'cancelled' && sessionAlive) {
        deps.notifyRestartFailed({ toId: rotation.toId, toEmail: rotation.toEmail, status });
      }
      return;
    }

    if (!deps.isStillOwned()) {
      deps.setRotationState(clearInFlightAntigravityRotation(current));
      return;
    }

    // A missing report is just as unproven as an explicit reconcile failure:
    // never substitute the requested target for an actual worker observation.
    if (current.workerReportedAccountId == null) {
      deps.setRotationState(clearInFlightAntigravityRotation(current));
      deps.notifyRestartFailed({ toId: rotation.toId, toEmail: rotation.toEmail, status: 'failed' });
      return;
    }

    const effectiveAccountId = current.workerReportedAccountId;
    const effectiveEmail = effectiveAccountId === rotation.toId ? rotation.toEmail : undefined;
    const settledState: AntigravitySessionRotationState = {
      logicalTurnId: current.logicalTurnId,
      attemptedAccountIds: current.attemptedAccountIds.includes(effectiveAccountId)
        ? current.attemptedAccountIds
        : [...current.attemptedAccountIds, effectiveAccountId],
      rotationsUsed: current.rotationsUsed,
      ...(current.lastReplayTurnId ? { lastReplayTurnId: current.lastReplayTurnId } : {}),
    };
    deps.setRotationState(settledState);

    try {
      deps.updateSessionAccount(effectiveAccountId);
      deps.clearUsageLimit();
    } catch (err) {
      // RestartCoordinator deliberately isolates observer exceptions. Handle
      // them HERE so a settled fence never turns into silent non-replay.
      deps.notifySettleFailed({
        toId: effectiveAccountId,
        toEmail: effectiveEmail,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    if (current.replayCancelledByUser || deps.hasManualIntervention(startedAtLastMessageAt, capturedTurnId)) {
      return;
    }

    if (!deps.replayPayload || !deps.replayPayload.cliInput.trim()) {
      deps.notifyManualReplayNeeded({ toId: effectiveAccountId, toEmail: effectiveEmail });
      return;
    }

    let replay: ReturnType<AntigravityQuotaAutoRotateDeps['replayTurn']>;
    try {
      replay = deps.replayTurn(deps.replayPayload);
    } catch (err) {
      // The callback contract cannot prove whether IPC accepted the input when
      // it throws. Block this logical turn from another automatic attempt.
      deps.setRotationState({ ...settledState, replayUncertain: true });
      deps.notifyReplayUncertain({
        toId: effectiveAccountId,
        toEmail: effectiveEmail,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    if (!replay.accepted) {
      deps.notifyReplayFailed({ toId: effectiveAccountId, toEmail: effectiveEmail });
      return;
    }

    const persistenceError = replay.persistenceError
      ?? (replay.retryTurnId ? undefined : 'replay accepted without a retry turn ID');
    deps.setRotationState({
      ...settledState,
      ...(replay.retryTurnId ? { lastReplayTurnId: replay.retryTurnId } : {}),
      ...(persistenceError ? { replayUncertain: true } : {}),
    });
    if (persistenceError) {
      deps.notifyReplayUncertain({ toId: effectiveAccountId, toEmail: effectiveEmail, error: persistenceError });
    }
  };

  let restartResult: { started: boolean; attemptId?: string };
  try {
    restartResult = deps.requestRestart(onRestartSettled);
  } catch {
    restartResult = { started: false };
  }

  if (!restartResult.started) {
    // Release the in-flight fence immediately so the session is never wedged.
    const current = deps.getRotationState();
    if (current?.inFlightToken === inFlightToken) {
      deps.setRotationState({
        logicalTurnId: current.logicalTurnId,
        attemptedAccountIds: targetAlreadyAttempted
          ? current.attemptedAccountIds
          : current.attemptedAccountIds.filter(id => id !== rotation.toId),
        rotationsUsed: Math.max(0, current.rotationsUsed - 1),
        ...(current.lastReplayTurnId ? { lastReplayTurnId: current.lastReplayTurnId } : {}),
      });
    }
    return { outcome: 'restart_refused', toId: rotation.toId };
  }

  if (restartResult.attemptId) {
    const current = deps.getRotationState();
    if (current?.inFlightToken === inFlightToken) current.restartAttemptId = restartResult.attemptId;
  }

  const willAutoReplay = Boolean(deps.replayPayload && deps.replayPayload.cliInput.trim());
  deps.notifySwitching({
    fromId: rotation.fromId,
    toId: rotation.toId,
    toEmail: rotation.toEmail,
    alreadyRotated: rotation.outcome === 'already_rotated',
    willAutoReplay,
  });

  return {
    outcome: 'started',
    fromId: rotation.fromId,
    toId: rotation.toId,
    toEmail: rotation.toEmail,
    alreadyRotated: rotation.outcome === 'already_rotated',
  };
}

/** Format a remaining duration (ms) concisely for notices and CLI output. */
export function formatAntigravityCooldown(ms: number, locale: 'zh' | 'en' = 'zh'): string {
  const sec = Math.max(1, Math.ceil(ms / 1000));
  const days = Math.floor(sec / 86_400);
  const hours = Math.floor((sec % 86_400) / 3_600);
  const mins = Math.floor((sec % 3_600) / 60);
  if (locale === 'en') {
    if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
    if (hours > 0) return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
    if (mins > 0) return `${mins}m`;
    return `${sec}s`;
  }
  if (days > 0) return hours > 0 ? `${days} 天 ${hours} 小时` : `${days} 天`;
  if (hours > 0) return mins > 0 ? `${hours} 小时 ${mins} 分钟` : `${hours} 小时`;
  if (mins > 0) return `${mins} 分钟`;
  return `${sec} 秒`;
}

/** Build the single `/status` line for an Antigravity session (undefined when nothing to show). */
export function formatAntigravityStatusLine(input: {
  sessionAccountId?: string;
  inspection: AntigravityAccountsInspection;
}): string | undefined {
  const { inspection } = input;
  if (inspection.stateError) return 'Antigravity account: state unavailable (corrupt state.json)';
  if (!inspection.managed) {
    if (!inspection.liveMaskedEmail) return undefined;
    return `Antigravity account: ${inspection.liveMaskedEmail} (unmanaged)`;
  }

  const sessionId = input.sessionAccountId ?? inspection.activeId ?? undefined;
  const sessionEntry = sessionId ? inspection.accounts.find(a => a.id === sessionId) : undefined;
  const emailLabel = sessionEntry?.maskedEmail ?? (sessionEntry?.email ? maskAntigravityEmail(sessionEntry.email) : undefined);
  const head = sessionId
    ? `${sessionId}${emailLabel ? ` (${emailLabel})` : ''}`
    : (inspection.liveMaskedEmail ?? 'none');
  const nextSuffix = sessionId && inspection.activeId && sessionId !== inspection.activeId
    ? ` → active: ${inspection.activeId}`
    : '';
  const autoLabel = inspection.autoRotate ? 'on' : 'off';
  return `Antigravity account: ${head}${nextSuffix} (pool ${inspection.availableCount}/${inspection.enabledCount} ready, auto-rotate: ${autoLabel})`;
}
