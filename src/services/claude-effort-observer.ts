import {
  isClaudeStatuslineEffort,
  readStatuslineSnapshot,
  type ClaudeStatuslineEffort,
} from './statusline-snapshot.js';

/** Effort-only observation: a missing reading must never erase the serving model. */
export interface ClaudeEffortObservation {
  claudeSessionId: string;
  reasoningEffort: ClaudeStatuslineEffort | null;
}

/** Reads the existing statusline file, independent of PTY output and transcript turns.
 * Only the current native session and CLI generation may supply a runtime value.
 * The reader's expiry also clears a previously observed level when reporting stops. */
export class ClaudeEffortObserver {
  private lastKey: string | undefined;

  reset(): void {
    this.lastKey = undefined;
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
    const reasoningEffort = usable && isClaudeStatuslineEffort(snap.reasoningEffort)
      ? snap.reasoningEffort : null;
    // A newly written snapshot republishes the same value too: the daemon may
    // have rejected its predecessor while native-session binding was in flight.
    // Repeated reads of the same file still dedupe without extra card patches.
    const key = JSON.stringify([binding.claudeSessionId, reasoningEffort, usable ? snap.ts : null]);
    if (this.lastKey === key) return undefined;
    this.lastKey = key;
    return { claudeSessionId: binding.claudeSessionId, reasoningEffort };
  }
}
