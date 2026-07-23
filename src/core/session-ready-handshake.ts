type PendingAck = {
  resolve: (acknowledged: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
};

const pendingAcks = new Map<string, PendingAck>();

/**
 * Register the daemon side of a SessionStart worker acknowledgement before the
 * IPC message is sent. The timeout is deliberately fail-open: older or
 * overloaded workers must not leave Claude's SessionStart hook stuck forever.
 */
export function waitForSessionReadyAck(requestId: string, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const previous = pendingAcks.get(requestId);
    if (previous) {
      clearTimeout(previous.timer);
      previous.resolve(false);
    }
    const timer = setTimeout(() => {
      pendingAcks.delete(requestId);
      resolve(false);
    }, timeoutMs);
    pendingAcks.set(requestId, { resolve, timer });
  });
}

/** Resolve a live acknowledgement. Unknown/duplicate ids are harmless. */
export function acknowledgeSessionReady(requestId: string): boolean {
  const pending = pendingAcks.get(requestId);
  if (!pending) return false;
  pendingAcks.delete(requestId);
  clearTimeout(pending.timer);
  pending.resolve(true);
  return true;
}

/** Fail a waiter immediately when forwarding to the worker itself failed. */
export function cancelSessionReadyAck(requestId: string): boolean {
  const pending = pendingAcks.get(requestId);
  if (!pending) return false;
  pendingAcks.delete(requestId);
  clearTimeout(pending.timer);
  pending.resolve(false);
  return true;
}
