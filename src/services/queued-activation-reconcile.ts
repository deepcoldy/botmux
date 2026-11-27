import type { ExecutionPhase } from './session-contract.js';
import type { Session } from '../types.js';

export type SubmissionGateBlockReason =
  | 'admitted_mismatch'
  | 'ambiguous_execution'
  | 'local_submission'
  | 'persisted_non_queued';

export interface SubmissionGateInspection {
  canSubmit: boolean;
  reason?: SubmissionGateBlockReason;
  phase?: ExecutionPhase;
  terminal?: boolean;
}

export interface ReconcileQueuedActivationHint {
  turnId: string;
  dispatchAttempt?: number;
  phase: ExecutionPhase;
  rawInput?: true;
  /** `submitting`/`reconciling` is only an intent-to-write marker. Require
   *  independent backend/transcript evidence before acknowledging the token. */
  evidenceRequired?: true;
  /** Exact retained bytes used only for read-only proof matching/bookkeeping. */
  submittedText?: string;
}

export function isExecutionPhasePastQueued(phase?: ExecutionPhase): boolean {
  return phase !== undefined && phase !== 'queued';
}

/** True for phases that prove input ingestion beyond a process-birth submitting
 *  marker (used by durableInitialPromptViaArgs adapters like OpenCode/MiMoCode,
 *  whose birth-time argv hook advances to 'submitting'/'reconciling' before DB
 *  confirmation). */
export function isExecutionPhaseConfirmedBeyondSubmitting(phase?: ExecutionPhase): boolean {
  return phase === 'accepted'
    || phase === 'running'
    || phase === 'succeeded'
    || phase === 'failed'
    || phase === 'cancelled';
}

export function isDurableArgvCliId(cliId?: string): boolean {
  return cliId === 'opencode' || cliId === 'mimocode';
}

/** Cursor and MTR structured bridges have no journal replay on Turn-1 persistent
 *  reattach; forcing resume=true on a fresh first turn skips to EOF and absorbs
 *  Turn 1's reply. */
export function shouldSkipResumeForReconciledBridge(input: {
  reattachLiveBackend: boolean;
  hasHistory: boolean;
  cliId?: string;
}): boolean {
  return input.reattachLiveBackend
    && !input.hasHistory
    && (input.cliId === 'cursor' || input.cliId === 'mtr');
}

export function resolveQueuedActivationEffectiveTurn(
  session: Pick<
    Session,
    | 'queuedActivationInput'
    | 'queuedActivationTurnId'
    | 'queuedActivationDispatchAttempt'
    | 'queuedActivationRawInput'
    | 'queuedActivationRawTurnId'
    | 'pendingRepoSetup'
  >,
  opts?: {
    initTurnId?: string;
    initDispatchAttempt?: number;
    pendingRawInput?: string;
    pendingRawTurnId?: string;
    prompt?: string;
  },
): {
  turnId?: string;
  dispatchAttempt?: number;
  isRawInput: boolean;
  hasTextPrompt: boolean;
  hasRawInput: boolean;
} {
  const hasTextPrompt = Boolean(
    (opts?.prompt && opts.prompt.length > 0)
    || (session.queuedActivationInput?.content && session.queuedActivationInput.content.length > 0),
  );
  const hasRawInput = Boolean(
    opts?.pendingRawInput
    || session.queuedActivationRawInput
    || session.pendingRepoSetup?.rawInput,
  );
  const isRawInput = hasRawInput && !hasTextPrompt;
  if (isRawInput) {
    const turnId = session.queuedActivationRawTurnId
      ?? opts?.pendingRawTurnId
      ?? session.queuedActivationTurnId
      ?? session.pendingRepoSetup?.turnId
      ?? opts?.initTurnId;
    return {
      ...(turnId ? { turnId } : {}),
      isRawInput: true,
      hasTextPrompt,
      hasRawInput,
    };
  }
  const turnId = session.queuedActivationTurnId ?? opts?.initTurnId;
  const dispatchAttempt = session.queuedActivationDispatchAttempt ?? opts?.initDispatchAttempt;
  return {
    ...(turnId ? { turnId } : {}),
    ...(dispatchAttempt !== undefined ? { dispatchAttempt } : {}),
    isRawInput: false,
    hasTextPrompt,
    hasRawInput,
  };
}

export type QueuedActivationInitPlan =
  | { action: 'none' }
  | { action: 'codex_app_ledger' }
  | { action: 'replay_queued' }
  | { action: 'probe_submission'; hint: ReconcileQueuedActivationHint }
  | { action: 'reconcile_already_submitted'; hint: ReconcileQueuedActivationHint };

export function classifyQueuedActivationInitPlan(input: {
  queuedActivationPending: boolean;
  queuedActivationToken?: string;
  isCodexApp: boolean;
  hasUnsettledCodexAppDispatch?: boolean;
  isDurableArgvCli?: boolean;
  hasTextPrompt: boolean;
  hasRawInput: boolean;
  turnId?: string;
  dispatchAttempt?: number;
  hasContract: boolean;
  contractPhase?: ExecutionPhase;
}): QueuedActivationInitPlan {
  if (!input.queuedActivationPending || !input.queuedActivationToken) {
    return { action: 'none' };
  }
  // Codex App is governed exclusively by codexAppDispatchLedger ('accepted' vs
  // 'prepared'). Never reconcile via ExecutionContract because an 'untouched'
  // pre-write refusal rolls the ledger back to 'accepted' for replay. However,
  // if the ledger is already completely drained (e.g. crash/upgrade split after
  // settlement commit) and no raw slash command is pending, converge instead of
  // stranding the activation gate forever.
  if (input.isCodexApp) {
    if (input.hasUnsettledCodexAppDispatch === false && !input.hasRawInput) {
      return {
        action: 'reconcile_already_submitted',
        hint: {
          turnId: input.turnId ?? 'codex-app-drained',
          ...(input.dispatchAttempt !== undefined ? { dispatchAttempt: input.dispatchAttempt } : {}),
          phase: 'succeeded',
        },
      };
    }
    return { action: 'codex_app_ledger' };
  }
  // Durable-argv adapters (OpenCode/MiMoCode) publish turn_execution_started at
  // process birth before their SQLite store confirms `--prompt` ingestion. Keep
  // 'submitting'/'reconciling' on the replay path so live reattach probes their
  // store with ownership verification and cold-restore replays unconfirmed opens.
  if (input.isDurableArgvCli && !input.hasRawInput
    && !isExecutionPhaseConfirmedBeyondSubmitting(input.contractPhase)) {
    return { action: 'replay_queued' };
  }
  if (input.hasContract && input.turnId && isExecutionPhasePastQueued(input.contractPhase)) {
    const confirmed = isExecutionPhaseConfirmedBeyondSubmitting(input.contractPhase);
    return {
      action: confirmed ? 'reconcile_already_submitted' : 'probe_submission',
      hint: {
        turnId: input.turnId,
        ...(input.dispatchAttempt !== undefined ? { dispatchAttempt: input.dispatchAttempt } : {}),
        phase: input.contractPhase!,
        ...(input.hasRawInput && !input.hasTextPrompt ? { rawInput: true } : {}),
        ...(!confirmed ? { evidenceRequired: true as const } : {}),
      },
    };
  }
  return { action: 'replay_queued' };
}

export function classifyOfflineColdRestoreSettlement(input: {
  queuedActivationPending: boolean;
  isCodexApp: boolean;
  isRemoteBackend: boolean;
  isDurableArgvCli?: boolean;
  isRawInput?: boolean;
  backingMode: 'cold_restore' | 'live_reattach' | 'unknown_probe';
  hasContract: boolean;
  turnId?: string;
  contractPhase?: ExecutionPhase;
}): 'settle_offline' | 'defer_to_fork' {
  if (!input.queuedActivationPending || input.isCodexApp || input.isRemoteBackend) {
    return 'defer_to_fork';
  }
  if (input.backingMode !== 'cold_restore') {
    return 'defer_to_fork';
  }
  if (input.isDurableArgvCli && !input.isRawInput
    && !isExecutionPhaseConfirmedBeyondSubmitting(input.contractPhase)) {
    return 'defer_to_fork';
  }
  if (!input.hasContract || !input.turnId || !isExecutionPhaseConfirmedBeyondSubmitting(input.contractPhase)) {
    return 'defer_to_fork';
  }
  return 'settle_offline';
}

export function decidePendingRawInputAction(input: {
  isCodexApp: boolean;
  hasContract: boolean;
  contractPhase?: ExecutionPhase;
  hasQueuedActivationToken: boolean;
}): 'send_raw_input' | 'reconcile_already_submitted' | 'skip_already_submitted' {
  if (!input.isCodexApp && input.hasContract && isExecutionPhaseConfirmedBeyondSubmitting(input.contractPhase)) {
    return input.hasQueuedActivationToken
      ? 'reconcile_already_submitted'
      : 'skip_already_submitted';
  }
  return 'send_raw_input';
}

export function decideOrdinaryImRejectionAction(
  reason?: string,
): 'clear_without_retry' | 'default' {
  return reason === 'execution_reconciliation_required'
    ? 'clear_without_retry'
    : 'default';
}

export function decideCodexAppSettlementActivationToken(input: {
  queuedActivationPending: boolean;
  queuedActivationToken?: string;
  queuedActivationTurnId?: string;
  queuedActivationDispatchAttempt?: number;
  hasPendingRepoRawInput?: boolean;
  hasPendingRawInput?: boolean;
  isDurableReplayCancel?: boolean;
  settledEntry?: {
    queuedActivationToken?: string;
    turnId?: string;
    dispatchAttempt?: number;
  };
  ledgerDrained: boolean;
}): string | undefined {
  if (!input.queuedActivationPending || !input.queuedActivationToken) return undefined;
  if (input.isDurableReplayCancel) return undefined;
  const hasPendingRaw = Boolean(input.hasPendingRawInput || input.hasPendingRepoRawInput);
  if (input.settledEntry?.queuedActivationToken) {
    return input.settledEntry.queuedActivationToken === input.queuedActivationToken
      ? input.queuedActivationToken
      : undefined;
  }
  if (input.settledEntry?.turnId && input.queuedActivationTurnId) {
    return input.settledEntry.turnId === input.queuedActivationTurnId
      && input.settledEntry.dispatchAttempt === input.queuedActivationDispatchAttempt
      ? input.queuedActivationToken
      : undefined;
  }
  if (input.ledgerDrained && !hasPendingRaw) {
    return input.queuedActivationToken;
  }
  return undefined;
}

export function decidePromotedActivationMessageHandling(input: {
  hasQueuedActivationToken: boolean;
  explicitQueueAfterActiveTurn: boolean;
  reattachOpenTurnGate: boolean;
  remoteRunnerRecoveredTurnInFlight: boolean;
  activeTurnBlocks: boolean;
  activeTurnStartedOnDifferentTurn: boolean;
}): {
  queueAfterActiveTurn: boolean;
  reason:
    | 'none'
    | 'explicit'
    | 'reattach_open_turn_gate'
    | 'remote_recovered_turn'
    | 'active_turn_blocks'
    | 'active_turn_started';
} {
  if (input.explicitQueueAfterActiveTurn) {
    return { queueAfterActiveTurn: true, reason: 'explicit' };
  }
  if (!input.hasQueuedActivationToken) {
    return { queueAfterActiveTurn: false, reason: 'none' };
  }
  if (input.reattachOpenTurnGate) {
    return { queueAfterActiveTurn: true, reason: 'reattach_open_turn_gate' };
  }
  if (input.remoteRunnerRecoveredTurnInFlight) {
    return { queueAfterActiveTurn: true, reason: 'remote_recovered_turn' };
  }
  if (input.activeTurnBlocks) {
    return { queueAfterActiveTurn: true, reason: 'active_turn_blocks' };
  }
  if (input.activeTurnStartedOnDifferentTurn) {
    return { queueAfterActiveTurn: true, reason: 'active_turn_started' };
  }
  return { queueAfterActiveTurn: false, reason: 'none' };
}

export function shouldAllowTypeAheadOnReattach(
  reattachOpenTurnGate: boolean,
  runtimeSupportsTypeAhead: boolean,
): boolean {
  return !reattachOpenTurnGate && runtimeSupportsTypeAhead;
}

export function shouldAdoptPidMarkerWithoutRetiringCurrent(input: {
  initialInputOwnershipPending: boolean;
  pendingCurrentTurnQueued?: boolean;
  activeTurnStarted?: boolean;
  currentTurnId?: string;
  diskTurnId: string;
}): boolean {
  return (input.initialInputOwnershipPending || input.pendingCurrentTurnQueued === true)
    && input.activeTurnStarted === false
    && Boolean(input.currentTurnId)
    && input.currentTurnId !== input.diskTurnId;
}

export function shouldPrepareInitialPromptArg(input: {
  hasPrompt: boolean;
  willReattachPersistent: boolean;
  adoptMode: boolean;
}): boolean {
  return input.hasPrompt && !input.willReattachPersistent && !input.adoptMode;
}

export function decideDurableArgvReattachSubmission(input: {
  probeResult?: { submitted: boolean; cliSessionId?: string; unreadable?: boolean } | null;
  expectedCliSessionId?: string;
  ownedCliSessionId?: string;
  promptContainsSessionId: boolean;
}): { action: 'already_submitted'; cliSessionId?: string } | { action: 'replay' } {
  const probe = input.probeResult;
  if (!probe || probe.unreadable || !probe.submitted) {
    return { action: 'replay' };
  }
  const expectedMatches = Boolean(
    input.expectedCliSessionId && probe.cliSessionId && probe.cliSessionId === input.expectedCliSessionId,
  );
  const ownedMatches = Boolean(
    input.ownedCliSessionId && probe.cliSessionId && probe.cliSessionId === input.ownedCliSessionId,
  );
  if (expectedMatches || ownedMatches || input.promptContainsSessionId) {
    return {
      action: 'already_submitted',
      ...(probe.cliSessionId ? { cliSessionId: probe.cliSessionId } : {}),
    };
  }
  return { action: 'replay' };
}

export function decideFlushSubmissionRejectionSettlement(input: {
  isCodexApp: boolean;
  hasToken: boolean;
  gate?: SubmissionGateInspection;
}): 'settle_already_submitted' | 'observe_only' | 'retain' {
  if (input.isCodexApp || !input.hasToken) return 'retain';
  if (input.gate?.canSubmit === false && input.gate.reason === 'persisted_non_queued') {
    return isExecutionPhaseConfirmedBeyondSubmitting(input.gate.phase)
      ? 'settle_already_submitted'
      : 'observe_only';
  }
  return 'retain';
}

export function decideRawInputSubmissionReconciliation(input: {
  isCodexApp: boolean;
  hasToken: boolean;
  gate?: SubmissionGateInspection;
}): 'deliver' | 'observe_only' | 'skip_and_ack' | 'skip' {
  if (!input.isCodexApp
    && input.gate?.canSubmit === false
    && input.gate.reason === 'persisted_non_queued') {
    if (!isExecutionPhaseConfirmedBeyondSubmitting(input.gate.phase)) return 'observe_only';
    return input.hasToken ? 'skip_and_ack' : 'skip';
  }
  return 'deliver';
}

export function reconcileRemoteRecoveredTurnQueue<
  T extends { turnId?: string; dispatchAttempt?: number; queuedActivationToken?: string },
>(
  pendingMessages: readonly T[],
  recoveredTurn: { turnId: string; dispatchAttempt?: number },
  initConfig?: { turnId?: string; dispatchAttempt?: number; queuedActivationToken?: string } | null,
): {
  remaining: T[];
  matchedTokens: string[];
  matchedInitTurn: boolean;
} {
  const matchedTokens = new Set<string>();
  const remaining: T[] = [];
  for (const item of pendingMessages) {
    if (item.turnId === recoveredTurn.turnId
      && item.dispatchAttempt === recoveredTurn.dispatchAttempt) {
      if (item.queuedActivationToken) matchedTokens.add(item.queuedActivationToken);
      continue;
    }
    remaining.push(item);
  }
  const matchedInitTurn = Boolean(
    initConfig
    && initConfig.turnId === recoveredTurn.turnId
    && initConfig.dispatchAttempt === recoveredTurn.dispatchAttempt,
  );
  if (matchedInitTurn && initConfig?.queuedActivationToken) {
    matchedTokens.add(initConfig.queuedActivationToken);
  }
  return {
    remaining,
    matchedTokens: [...matchedTokens],
    matchedInitTurn,
  };
}
