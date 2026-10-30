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
 * empty-composer proof. Only the tmux backend exposes that authoritative
 * input state today, and RPC-input sessions use the pane as a viewer rather
 * than an input surface. Claude keeps its existing renderer-based evidence. */
export function supportsNativeAutoCompactRuntime(
  cliId: string,
  backendType: string | undefined,
  codexRpcInput: boolean,
): boolean {
  if (!supportsNativeAutoCompact(cliId)) return false;
  if (cliId !== 'codex') return true;
  return backendType === 'tmux' && !codexRpcInput;
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
  adopted: boolean;
  headless: boolean;
  vcMeetingReceiver: boolean;
  remoteRunner: boolean;
  supportsCompact: boolean;
}

/** Pure fire-time gate for daemon-initiated maintenance. Every field is
 * explicit so each exclusion remains independently testable. */
export function isAutoCompactEligible(input: AutoCompactEligibilitySnapshot): boolean {
  return input.sessionActive
    && input.workerAlive
    && input.workerReady
    && input.cliReady
    && input.idle
    && input.streamCardSettled
    && !input.transferring
    && !input.protectedMutation
    && !input.pendingTurns
    && !input.pendingPrompt
    && !input.pendingRawInput
    && !input.pendingFollowUpInput
    && input.queuedActivationCount === 0
    && !input.cascadeInFlight
    && !input.usageLimited
    && !input.agentAttention
    && input.finalDeliveriesInFlight === 0
    && input.backgroundTaskCount === 0
    && !input.adopted
    && !input.headless
    && !input.vcMeetingReceiver
    && !input.remoteRunner
    && input.supportsCompact;
}

export interface AutoCompactRefusalProjection {
  streamCardPending?: boolean;
  streamCardPendingTurnId?: string;
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

  private cancelTimer(sessionId: string): void {
    const state = this.states.get(sessionId);
    if (!state?.timer) return;
    clearTimeout(state.timer);
    state.timer = undefined;
  }
}
