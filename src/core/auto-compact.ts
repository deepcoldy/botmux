/**
 * Debounced admission for daemon-initiated native `/compact` turns.
 *
 * The coordinator deliberately knows nothing about workers, IM delivery, or
 * transcript formats.  Callers provide a fresh percentage read and a final
 * eligibility check at fire time, so a user turn admitted during the debounce
 * window always wins over maintenance work.
 */

export const AUTO_COMPACT_DEFAULT_DELAY_MS = 5_000;
export const AUTO_COMPACT_DEFAULT_COOLDOWN_MS = 10 * 60_000;

/** CLIs whose native interactive command set is known to include `/compact`.
 * Human passthrough remains intentionally best-effort across a wider roster;
 * unattended maintenance is narrower because an unknown command would consume
 * a turn without doing useful work. */
const NATIVE_AUTO_COMPACT_CLIS = new Set(['claude-code', 'codex']);

export function supportsNativeAutoCompact(cliId: string): boolean {
  return NATIVE_AUTO_COMPACT_CLIS.has(cliId);
}

/** Runtime capability for unattended native compaction.
 *
 * Codex needs a live terminal cursor + viewport snapshot for its positive
 * empty-composer proof. Only the tmux and hc backends expose that
 * authoritative input state today, and RPC-input sessions use the pane as a
 * viewer rather than an input surface. Claude keeps its existing renderer-based evidence. */
export function supportsNativeAutoCompactRuntime(
  cliId: string,
  backendType: string | undefined,
  codexRpcInput: boolean,
): boolean {
  if (!supportsNativeAutoCompact(cliId)) return false;
  if (cliId !== 'codex') return true;
  return (backendType === 'tmux' || backendType === 'hc') && !codexRpcInput;
}

export interface AutoCompactObservation {
  sessionId: string;
  idle: boolean;
  threshold: number | undefined;
  readThreshold: () => number | undefined;
  readPercent: () => number | undefined;
  eligible: () => boolean;
  trigger: (threshold: number) => boolean;
  onError?: (error: unknown) => void;
}

export interface AutoCompactEligibilitySnapshot {
  sessionActive: boolean;
  workerAlive: boolean;
  workerReady: boolean;
  cliReady: boolean;
  idle: boolean;
  streamCardSettled: boolean;
  transferring: boolean;
  protectedMutation: boolean;
  pendingTurns: boolean;
  pendingPrompt: boolean;
  pendingRawInput: boolean;
  pendingFollowUpInput: boolean;
  queuedActivationCount: number;
  cascadeInFlight: boolean;
  usageLimited: boolean;
  agentAttention: boolean;
  finalDeliveriesInFlight: number;
  backgroundTaskCount: number;
  /** Claude's one-shot away summary is waiting or blurred. Maintenance input
   *  must not restore focus and cancel it. Optional for older producers. */
  awaySummaryPending?: boolean;
  adopted: boolean;
  headless: boolean;
  vcMeetingReceiver: boolean;
  remoteRunner: boolean;
  supportsCompact: boolean;
}

/** One reason the fire-time gate says no, as it is logged. */
export type AutoCompactBlocker =
  | 'session_inactive' | 'no_worker' | 'worker_not_ready' | 'cli_not_ready' | 'not_idle'
  | 'stream_card_pending' | 'transferring' | 'protected_mutation' | 'pending_turns'
  | 'pending_prompt' | 'pending_raw_input' | 'pending_follow_up_input' | 'queued_activation'
  | 'cascade_in_flight' | 'usage_limited' | 'agent_attention' | 'final_delivery_in_flight'
  | 'background_tasks' | 'away_summary_pending' | 'adopted' | 'headless' | 'vc_meeting_receiver' | 'remote_runner'
  | 'compact_unsupported';

const AUTO_COMPACT_GATE: ReadonlyArray<readonly [AutoCompactBlocker, (s: AutoCompactEligibilitySnapshot) => boolean]> = [
  ['session_inactive', s => !s.sessionActive],
  ['no_worker', s => !s.workerAlive],
  ['worker_not_ready', s => !s.workerReady],
  ['cli_not_ready', s => !s.cliReady],
  ['not_idle', s => !s.idle],
  ['stream_card_pending', s => !s.streamCardSettled],
  ['transferring', s => s.transferring],
  ['protected_mutation', s => s.protectedMutation],
  ['pending_turns', s => s.pendingTurns],
  ['pending_prompt', s => s.pendingPrompt],
  ['pending_raw_input', s => s.pendingRawInput],
  ['pending_follow_up_input', s => s.pendingFollowUpInput],
  ['queued_activation', s => s.queuedActivationCount !== 0],
  ['cascade_in_flight', s => s.cascadeInFlight],
  ['usage_limited', s => s.usageLimited],
  ['agent_attention', s => s.agentAttention],
  ['final_delivery_in_flight', s => s.finalDeliveriesInFlight !== 0],
  ['background_tasks', s => s.backgroundTaskCount !== 0],
  ['away_summary_pending', s => s.awaySummaryPending === true],
  ['adopted', s => s.adopted],
  ['headless', s => s.headless],
  ['vc_meeting_receiver', s => s.vcMeetingReceiver],
  ['remote_runner', s => s.remoteRunner],
  ['compact_unsupported', s => !s.supportsCompact],
];

/** Every exclusion the snapshot hits, in a fixed order; empty = eligible. */
export function autoCompactBlockers(input: AutoCompactEligibilitySnapshot): AutoCompactBlocker[] {
  return AUTO_COMPACT_GATE.filter(([, blocks]) => blocks(input)).map(([name]) => name);
}

/** Pure fire-time gate for daemon-initiated maintenance. Every field is
 * explicit so each exclusion remains independently testable. */
export function isAutoCompactEligible(input: AutoCompactEligibilitySnapshot): boolean {
  return autoCompactBlockers(input).length === 0;
}

export interface AutoCompactRefusalProjection {
  streamCardPending?: boolean;
  streamCardPendingTurnId?: string;
}

export interface AutoCompactMaintenanceMessage {
  type?: string;
  turnId?: string;
  requireSafeComposer?: true;
}

/** Both automatic compact paths carry an `auto-compact:` turn id and require a
 *  safe composer. While a one-shot recap is active, that maintenance input must
 *  be deferred BEFORE the worker restores terminal focus. Human passthrough
 *  deliberately does not match, even when it happens to use the same command. */
export function shouldDeferAutoCompactForAwaySummary(
  msg: AutoCompactMaintenanceMessage,
  awaySummaryPending: boolean,
): boolean {
  return awaySummaryPending
    && msg.type === 'raw_input'
    && msg.requireSafeComposer === true
    && msg.turnId?.startsWith('auto-compact:') === true;
}

export function isAutoCompactSafeComposerRefusal(
  terminal: { turnId: string; status: string; errorCode?: string },
): boolean {
  return terminal.turnId.startsWith('auto-compact:')
    && terminal.status === 'failed'
    && terminal.errorCode === 'safe_composer_required';
}

/** Clear the synthetic turn's pending-card marker after the worker rejects an
 * unattended write for missing live composer evidence. The refusal is an
 * expected fail-closed maintenance outcome, not a user turn that may remain
 * pending until the next message arrives. */
export function settleAutoCompactSafeComposerRefusal(
  state: AutoCompactRefusalProjection,
  terminal: { turnId: string; status: string; errorCode?: string },
): boolean {
  if (!isAutoCompactSafeComposerRefusal(terminal)) return false;
  if (state.streamCardPendingTurnId === terminal.turnId) {
    state.streamCardPending = false;
    state.streamCardPendingTurnId = undefined;
  }
  return true;
}

interface AutoCompactState {
  timer?: NodeJS.Timeout;
  lastAttemptAt?: number;
}

export class AutoCompactCoordinator {
  private readonly states = new Map<string, AutoCompactState>();

  constructor(
    private readonly delayMs = AUTO_COMPACT_DEFAULT_DELAY_MS,
    private readonly cooldownMs = AUTO_COMPACT_DEFAULT_COOLDOWN_MS,
    private readonly now: () => number = Date.now,
  ) {}

  observe(input: AutoCompactObservation): void {
    const threshold = input.threshold;
    if (threshold === undefined || !Number.isFinite(threshold)
      || threshold < 1 || threshold > 100) {
      this.cancel(input.sessionId);
      return;
    }
    if (!input.idle) {
      this.cancelTimer(input.sessionId);
      return;
    }
    let initialPercent: number | undefined;
    try {
      initialPercent = input.readPercent();
    } catch (error) {
      input.onError?.(error);
      this.cancel(input.sessionId);
      return;
    }
    if (initialPercent === undefined || initialPercent < threshold) {
      this.cancel(input.sessionId);
      return;
    }

    const state = this.states.get(input.sessionId) ?? {};
    if (state.timer) return;
    if (state.lastAttemptAt !== undefined
      && this.now() - state.lastAttemptAt < this.cooldownMs) return;

    state.timer = setTimeout(() => {
      state.timer = undefined;
      try {
        const freshThreshold = input.readThreshold();
        const freshPercent = input.readPercent();
        if (freshThreshold === undefined || !Number.isFinite(freshThreshold)
          || freshThreshold < 1 || freshThreshold > 100
          || freshPercent === undefined || freshPercent < freshThreshold
          || !input.eligible()) return;
        // Claim the cooldown before dispatch. Even a rejected worker send must not
        // create a tight retry loop on every idle/status observation.
        state.lastAttemptAt = this.now();
        input.trigger(freshThreshold);
      } catch (error) {
        // Timer callbacks are daemon background work. Never let a transient
        // registry/store failure escape as an uncaught exception and terminate
        // the process.
        input.onError?.(error);
      }
    }, this.delayMs);
    state.timer.unref?.();
    this.states.set(input.sessionId, state);
  }

  cancel(sessionId: string): void {
    const state = this.states.get(sessionId);
    if (state?.timer) clearTimeout(state.timer);
    this.states.delete(sessionId);
  }

  /** An away-summary refusal is a deferral, not a spent compact attempt. Clear
   *  only that attempt; the next eligible observation re-arms the normal
   *  debounce. Other safe-composer refusals keep their cooldown. */
  defer(sessionId: string): void {
    const state = this.states.get(sessionId);
    if (state) state.lastAttemptAt = undefined;
  }

  private cancelTimer(sessionId: string): void {
    const state = this.states.get(sessionId);
    if (!state?.timer) return;
    clearTimeout(state.timer);
    state.timer = undefined;
  }
}

export interface AutoCompactAwaySummaryDeferralState {
  awaySummaryPending?: boolean;
  autoCompactAwaySummaryDeferred?: boolean;
}

/** Reconcile a threshold refusal after the recap settles. The worker may have
 *  refused before its pending frame reached the daemon, so the false frame must
 *  clear the spent attempt and let THIS observation re-arm the debounce. */
export function reconcileAutoCompactAwaySummaryDeferral(
  state: AutoCompactAwaySummaryDeferralState,
  coordinator: Pick<AutoCompactCoordinator, 'defer'>,
  sessionId: string,
): void {
  if (!state.autoCompactAwaySummaryDeferred || state.awaySummaryPending) return;
  state.autoCompactAwaySummaryDeferred = undefined;
  coordinator.defer(sessionId);
}
