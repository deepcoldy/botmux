/** Classify an observed exit, never impose a startup timeout on a live CLI. */
export function isCliStartupFailure(input: {
  code: number | null;
  fresh: boolean;
  ready: boolean;
  argvTurnUnstarted: boolean;
  structuredInputWaiting: boolean;
  nativeInputSeen: boolean;
  elapsedMs: number;
}): boolean {
  if (!input.fresh || input.code == null || input.code === 0) return false;
  if (input.nativeInputSeen) return false;
  if (!input.ready || input.argvTurnUnstarted) return true;
  // A dead pane can pass a quiescence/timeout-based composer check before the
  // liveness probe detects its exit. With a pending structured turn, only real
  // native input evidence disproves a fast startup failure, not that heuristic.
  return input.elapsedMs < 30_000 && input.structuredInputWaiting;
}
