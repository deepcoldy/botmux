interface PendingBytedcliWorkerRetirement {
  readonly generation: number;
  readonly continuation: () => void;
  completed: boolean;
}

const retirements = new Map<string, PendingBytedcliWorkerRetirement>();

/** Serialize a strict replacement behind cleanup of the exact previous broker
 * generation. Like device-isolation, only the first spawn is replayed; later
 * inputs stay in the session's normal pending-input machinery instead of
 * repeatedly killing the successor. */
export function deferBytedcliWorkerRetirement(input: {
  readonly sessionId: string;
  readonly workerGeneration?: number;
  readonly strict: boolean;
  readonly retire?: () => void | Promise<void>;
  readonly continue: () => void;
  readonly fail: (error: unknown) => void;
}): boolean {
  if (!input.strict || !input.workerGeneration || !input.retire) return false;
  const current = retirements.get(input.sessionId);
  if (current?.generation === input.workerGeneration) {
    if (!current.completed) return true;
    retirements.delete(input.sessionId);
    return false;
  }
  const gate: PendingBytedcliWorkerRetirement = { generation: input.workerGeneration, continuation: input.continue, completed: false };
  retirements.set(input.sessionId, gate);
  void Promise.resolve().then(input.retire).then(() => {
    if (retirements.get(input.sessionId) !== gate) return;
    gate.completed = true;
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
