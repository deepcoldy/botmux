/**
 * Project worker runtime facts into the status consumed by Lark cards and the
 * Dashboard. A structured transcript lifecycle outranks screen readiness:
 * prompt glyphs and PTY quiescence are UI hints, while a transcript-started
 * turn without assistant_final is explicit evidence that work is still running;
 * a verified submit also blocks during its bounded transcript-start hand-off.
 */
export function projectRuntimeScreenStatus(state: {
  promptReady: boolean;
  analyzing: boolean;
  structuredTurnBlocking: boolean;
}): 'idle' | 'working' | 'analyzing' {
  if (state.analyzing) return 'analyzing';
  if (state.structuredTurnBlocking) return 'working';
  return state.promptReady ? 'idle' : 'working';
}

/** Await an asynchronous screen snapshot before reading runtime status. A
 *  periodic tick can spend measurable time in tmux/observe capture; projecting
 *  first lets a turn that starts during that await receive a late, stale idle
 *  update. Keeping the ordering in one helper makes the race deterministic in
 *  tests and forces callers to read lifecycle state at send time. */
export async function snapshotWithLatestRuntimeStatus<T>(
  capture: () => Promise<T>,
  projectStatus: () => ReturnType<typeof projectRuntimeScreenStatus>,
): Promise<{ snapshot: T; status: ReturnType<typeof projectRuntimeScreenStatus> }> {
  const snapshot = await capture();
  return { snapshot, status: projectStatus() };
}

/** Monotonic evidence for PTY chunks fed to readiness detection. Wall-clock
 *  milliseconds are not unique: two redraw chunks can land in the same ms,
 *  making timestamp equality falsely claim that no output followed a rejected
 *  ready signal. A generation changes for every observed chunk instead. */
export class PtyOutputGeneration {
  private generation = 0;

  observe(): number {
    this.generation++;
    return this.generation;
  }

  snapshot(): number {
    return this.generation;
  }

  isCurrent(snapshot: number): boolean {
    return this.generation === snapshot;
  }

  reset(): void {
    this.generation = 0;
  }
}

/** Validate a callback captured for one CLI/backend generation. A restart can
 * invalidate the generation before async teardown swaps out the backend
 * object, so backend identity alone is not a sufficient fence. */
export function isCliBackendGenerationCurrent<T>(
  fence: { generation: number; backend: T },
  current: { generation: number; backend: T; restartInProgress: boolean },
): boolean {
  return fence.generation === current.generation
    && fence.backend === current.backend
    && !current.restartInProgress;
}

/** Enter a fresh CLI-write cycle synchronously, before the adapter is allowed
 *  to yield. This ordering matters for fast turns: transcript final can arrive
 *  while writeInput is still polling submit history, and IdleDetector must be
 *  re-armed before that final edge rather than reset after it. */
export function beginRuntimeWriteCycle(hooks: {
  setPromptReady: (ready: boolean) => void;
  resetIdleDetector: () => void;
}): void {
  hooks.setPromptReady(false);
  hooks.resetIdleDetector();
}
