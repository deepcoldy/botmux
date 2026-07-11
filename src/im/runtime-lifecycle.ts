import type { PlatformRuntime } from './ports.js';

export type PlatformStopFailureHandler = (
  error: unknown,
  attempt: number,
  maxAttempts: number,
) => void;

/**
 * Stop a runtime with a bounded retry. Runtime stop implementations retain
 * their dispatcher after a failed close specifically so the caller can retry;
 * returning false lets shutdown keep the runtime bindings alive until its
 * final process-exit cleanup.
 */
export async function stopPlatformRuntimeWithRetry(
  runtime: PlatformRuntime,
  maxAttempts: number = 2,
  onFailure?: PlatformStopFailureHandler,
): Promise<boolean> {
  const attempts = Math.max(1, Math.floor(maxAttempts));
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await runtime.stop();
      return true;
    } catch (error) {
      onFailure?.(error, attempt, attempts);
    }
  }
  return false;
}
