const DEFAULT_MIR_RUNNER_TIMEOUT_MS = 12 * 60 * 1000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/**
 * Keep the outer runner timeout active even when an operator supplies a
 * malformed override. Node coerces timers above its signed 32-bit ceiling to
 * 1ms, while the runner previously treated non-positive/non-finite values as
 * "no timeout"; both outcomes defeat the 12-minute safety budget.
 */
export function resolveMirRunnerTimeoutMs(raw: string | undefined): number {
  const parsed = raw?.trim() ? Number(raw) : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= MAX_TIMER_DELAY_MS
    ? parsed
    : DEFAULT_MIR_RUNNER_TIMEOUT_MS;
}
