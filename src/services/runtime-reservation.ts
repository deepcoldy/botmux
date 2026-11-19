/**
 * A worker's wait for the daemon to answer `runtime_binding_started`.
 *
 * The daemon answers every start it admits, granting or refusing it, once its
 * durable commit is done; under load that answer can come late (the last
 * re-attaches of the 2026-11-09 fleet restart were answered 16 s after they
 * asked). A late answer is still the answer. Only a start that stays unanswered
 * past the deadline fails, and it fails as a startup failure: nothing else
 * would ever start this runtime.
 */

/** Twice the ~60 s a restart herd took to drain on 2026-08-23, about seven
 *  times the 16 s answer lag of 2026-11-09: a live daemon answers well inside it. */
export const RUNTIME_RESERVATION_DEADLINE_MS = 120_000;

/** When a start still unanswered is logged, so a slow daemon shows in the
 *  worker log while the start is waiting on it. */
export const RUNTIME_RESERVATION_SLOW_LOG_MS = 15_000;

/** The daemon's startup-retry classifier recognises this text in the worker's
 *  fatal startup reason. */
export const RUNTIME_RESERVATION_UNCONFIRMED = 'runtime reservation was not confirmed by the daemon';

/** The daemon's refusal text, matched by the startup-retry classifier. */
export const RUNTIME_RESERVATION_UNOWNED = 'runtime reservation was refused by the daemon and no lifecycle operation took the start over';

/** `unowned`: the daemon refused the start and nothing else will start this
 *  session's CLI, so the worker must fail instead of waiting for a takeover. */
export type RuntimeReservationOutcome = 'granted' | 'refused' | 'unowned' | 'expired';
export type RuntimeStartRefusal = 'unowned';

export class RuntimeReservationRefusedError extends Error {
  constructor() {
    super(`CLI ${RUNTIME_RESERVATION_UNOWNED}`);
    this.name = 'RuntimeReservationRefusedError';
  }
}

/**
 * Does a refused start have a lifecycle operation that takes the session over?
 *
 * A refusal normally hands the start to the operation that owns the session: a
 * close or suspend in flight retires this worker, a restart or resume starts
 * its own runtime. Nobody takes over when the contract the worker was bound to
 * is retired (`closed`/`suspended`) with no operation in flight while the
 * daemon still holds this worker as the live owner of an active session: a
 * replacement worker that was bound to its closed predecessor's contract
 * (2026-11-18, every /repo switch on daemon v3.59.10). Waiting for a takeover
 * there leaves a session that looks online and idle with no CLI at all.
 */
export function runtimeStartRefusal(input: {
  mayStart: boolean;
  lifecycle: string;
  activeOperationId?: string;
  workerIsLiveOwner: boolean;
}): RuntimeStartRefusal | undefined {
  if (input.mayStart || !input.workerIsLiveOwner || input.activeOperationId) return undefined;
  return input.lifecycle === 'closed' || input.lifecycle === 'suspended' ? 'unowned' : undefined;
}

export class RuntimeReservationExpiredError extends Error {
  constructor() {
    super(`CLI ${RUNTIME_RESERVATION_UNCONFIRMED} within ${RUNTIME_RESERVATION_DEADLINE_MS / 1000}s`);
    this.name = 'RuntimeReservationExpiredError';
  }
}

/** Register the answer handler for `bindingId` in `pending` (the daemon's
 *  `runtime_contract_reserved` calls it) and resolve with what came of it. */
export function awaitRuntimeReservation(
  pending: Map<string, (mayStart: boolean, refusal?: RuntimeStartRefusal) => void>,
  bindingId: string,
  onSlow: () => void,
): Promise<RuntimeReservationOutcome> {
  return new Promise(resolve => {
    const settle = (outcome: RuntimeReservationOutcome): void => {
      clearTimeout(slow);
      clearTimeout(deadline);
      pending.delete(bindingId);
      resolve(outcome);
    };
    const slow = setTimeout(onSlow, RUNTIME_RESERVATION_SLOW_LOG_MS);
    const deadline = setTimeout(() => settle('expired'), RUNTIME_RESERVATION_DEADLINE_MS);
    slow.unref?.();
    deadline.unref?.();
    pending.set(bindingId, (mayStart, refusal) => settle(mayStart ? 'granted' : refusal === 'unowned' ? 'unowned' : 'refused'));
  });
}
