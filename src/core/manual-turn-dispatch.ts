import type { DaemonSession } from './types.js';
import type { CliTurnPayload } from '../types.js';
// Keep this helper outside the worker-pool runtime dependency cycle.
// Entry points supply the fork operation they already own.
import type { forkWorker, WorkerForkAdmission } from './worker-pool.js';

/** Manual actions commit their input/cooldown only after synchronous admission.
 * A handled refusal can return true from forkWorker, so its admission callback
 * is authoritative. Do not schedule speculative device/memory waiters after the
 * action has returned: a refused action must remain available for the user.
 * Already-owned transfer/activation queues still report deferred and keep the
 * exact input and routing; they are accepted for this purpose. */
export function forkManualTurn(
  ds: DaemonSession, input: CliTurnPayload, turnId: string, fork: typeof forkWorker,
): boolean {
  let admission: WorkerForkAdmission | undefined;
  const handled = fork(ds, input, { resume: ds.hasHistory, turnId }, {
    deferDuringDeviceIsolation: false,
    onAdmission: value => { admission = value; },
  });
  return handled && (admission === 'accepted' || admission === 'deferred');
}
