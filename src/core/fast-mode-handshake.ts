import type { FastModeApplyResult, WorkerToDaemon } from '../types.js';

type PendingFastModeResult = {
  resolve: (result: FastModeApplyResult) => void;
  timer: ReturnType<typeof setTimeout>;
};

const pendingResults = new Map<string, PendingFastModeResult>();

/** Register before sending set_fast_mode. Timeout is deliberately fail-closed:
 * the daemon must never persist or report a state the worker did not ACK. */
export function waitForFastModeResult(
  requestId: string,
  timeoutMs: number,
): Promise<FastModeApplyResult> {
  return new Promise(resolve => {
    const previous = pendingResults.get(requestId);
    if (previous) {
      clearTimeout(previous.timer);
      previous.resolve({ ok: false, reason: 'not_ready' });
    }
    const timer = setTimeout(() => {
      pendingResults.delete(requestId);
      resolve({ ok: false, reason: 'not_ready' });
    }, timeoutMs);
    pendingResults.set(requestId, { resolve, timer });
  });
}

/** Resolve an exact worker ACK. Unknown, duplicate, and stale ids are harmless. */
export function acknowledgeFastModeResult(
  message: Extract<WorkerToDaemon, { type: 'fast_mode_result' }>,
): boolean {
  const pending = pendingResults.get(message.requestId);
  if (!pending) return false;
  pendingResults.delete(message.requestId);
  clearTimeout(pending.timer);
  pending.resolve(message.ok
    ? {
        ok: true,
        enabled: message.enabled,
        ...(message.serviceTier ? { serviceTier: message.serviceTier } : {}),
      }
    : {
        ok: false,
        reason: message.reason,
        ...(message.message ? { message: message.message } : {}),
      });
  return true;
}

/** Fail immediately when IPC send itself failed. */
export function cancelFastModeResult(requestId: string): boolean {
  const pending = pendingResults.get(requestId);
  if (!pending) return false;
  pendingResults.delete(requestId);
  clearTimeout(pending.timer);
  pending.resolve({ ok: false, reason: 'not_ready' });
  return true;
}
