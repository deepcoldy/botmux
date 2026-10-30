export interface QueuedReadyTransitionInput {
  observedOutputGeneration?: number;
  currentOutputGeneration: number;
  durableTurnInFlight: boolean;
  preserveActiveTurnAuthority: boolean;
  syncedFromDisk: boolean;
  hasQueuedTurn: boolean;
}

export interface QueuedReadyTransitionDecision {
  observationBelongsToReady: boolean;
  releaseActiveTurnAuthority: boolean;
  advanceQueuedTurn: boolean;
}

/** Decide the two state mutations surrounding one prompt-ready edge.
 *
 * A marker promotion observed on this exact PTY generation means the ready
 * still belongs to its predecessor: keep the promoted authority and do not
 * consume another queued turn. A newer generation expires that observation.
 */
export function decideQueuedReadyTransition(
  input: QueuedReadyTransitionInput,
): QueuedReadyTransitionDecision {
  const observationBelongsToReady = input.observedOutputGeneration !== undefined
    && input.observedOutputGeneration === input.currentOutputGeneration;
  return {
    observationBelongsToReady,
    releaseActiveTurnAuthority: !input.durableTurnInFlight
      && !input.preserveActiveTurnAuthority
      && !observationBelongsToReady,
    advanceQueuedTurn: !input.syncedFromDisk
      && !observationBelongsToReady
      && input.hasQueuedTurn,
  };
}
