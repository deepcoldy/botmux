import {
  isClaudeStatuslineEffort,
  readStatuslineSnapshot,
  type ClaudeStatuslineEffort,
} from './statusline-snapshot.js';

/** Effort-only observation: a missing reading must never erase the serving model. */
export interface ClaudeEffortObservation {
  claudeSessionId: string;
  reasoningEffort: ClaudeStatuslineEffort | null;
  userSelection?: import('./terminal-effort-choice.js').TerminalEffortChoice;
}

/** Reads the existing statusline file, independent of PTY output and transcript turns.
 * Only the current native session and CLI generation may supply a runtime value.
 * The reader's expiry also clears a previously observed level when reporting stops. */
export class ClaudeEffortObserver {
  private lastKey: string | undefined;
  lastObservedAtMs: number | undefined;
  lastObservation: ClaudeEffortObservation | undefined;
  lastModel: string | undefined;

  reset(): void {
    this.lastKey = undefined;
    this.lastObservedAtMs = undefined;
    this.lastObservation = undefined;
    this.lastModel = undefined;
  }

  observe(
    dataDir: string,
    sessionId: string,
    binding: { claudeSessionId: string; notBefore: number; now?: number },
  ): ClaudeEffortObservation | undefined {
    const now = binding.now ?? Date.now();
    const snap = readStatuslineSnapshot(dataDir, sessionId, { now });
    const usable = snap && snap.claudeSessionId === binding.claudeSessionId
      && snap.ts >= binding.notBefore && snap.ts <= now;
    this.lastObservedAtMs = usable ? snap.ts : undefined;
    this.lastModel = usable ? snap.model : undefined;
    const reasoningEffort = usable && isClaudeStatuslineEffort(snap.reasoningEffort)
      ? snap.reasoningEffort : null;
    // A newly written snapshot republishes the same value too: the daemon may
    // have rejected its predecessor while native-session binding was in flight.
    // Repeated reads of the same file still dedupe without extra card patches.
    const key = JSON.stringify([binding.claudeSessionId, reasoningEffort, usable ? snap.ts : null]);
    this.lastObservation = { claudeSessionId: binding.claudeSessionId, reasoningEffort };
    if (this.lastKey === key) return undefined;
    this.lastKey = key;
    return { claudeSessionId: binding.claudeSessionId, reasoningEffort };
  }
}
