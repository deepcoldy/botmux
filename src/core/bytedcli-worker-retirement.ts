interface PendingBytedcliWorkerRetirement {
  readonly generation: number;
  readonly continuation: () => void;
}

const retirements = new Map<string, PendingBytedcliWorkerRetirement>();

export function bytedcliWorkerRetirementPending(sessionId: string): boolean {
  return retirements.has(sessionId);
}

/** Start one cleanup for a strict replacement. Callers reserve the successor
 * generation BEFORE invoking this helper, so the old authority can never become
 * admissible again after cleanup. A concurrent request is rejected by `fail`,
 * never allowed to overwrite the pending cleanup. */
export function deferBytedcliWorkerRetirement(input: {
  readonly sessionId: string;
  readonly workerGeneration?: number;
  readonly strict: boolean;
  readonly retire?: () => void | Promise<void>;
  readonly continue: () => void;
  readonly fail: (error: unknown) => void;
}): boolean {
  if (!input.strict || !input.workerGeneration || !input.retire) return false;
  if (retirements.has(input.sessionId)) {
    input.fail(new Error('ByteCloud broker retirement is already pending'));
    return true;
  }
  const gate: PendingBytedcliWorkerRetirement = { generation: input.workerGeneration, continuation: input.continue };
  retirements.set(input.sessionId, gate);
  void Promise.resolve().then(input.retire).then(() => {
    if (retirements.get(input.sessionId) !== gate) return;
    retirements.delete(input.sessionId);
    try { gate.continuation(); } catch (error) { input.fail(error); }
  }, error => {
    if (retirements.get(input.sessionId) !== gate) return;
    retirements.delete(input.sessionId);
    input.fail(error);
  });
  return true;
}

export function __testOnly_resetBytedcliWorkerRetirement(): void {
  retirements.clear();
}
