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

export interface AutoCompactObservation {
  sessionId: string;
  idle: boolean;
  threshold: number | undefined;
  readThreshold: () => number | undefined;
  readPercent: () => number | undefined;
  eligible: () => boolean;
  trigger: (threshold: number) => boolean;
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
    && !input.adopted
    && !input.headless
    && !input.vcMeetingReceiver
    && !input.remoteRunner
    && input.supportsCompact;
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
    const initialPercent = input.readPercent();
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
