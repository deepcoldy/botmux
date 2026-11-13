import { sameRuntime, sameWorker, type ContractSessionRef, type RuntimeContract } from '../services/session-contract.js';
import type { SessionContractStore } from '../services/session-contract-store.js';
import { controllerForSession } from './session-controller.js';
import type { DaemonSession } from './types.js';

/** Whether the live runtime is the question's native thread. Its own recorded
 * native id is authoritative. A runner warm-reattached after a daemon restart
 * is a new runtime of the same proven process that never re-sends its already
 * acknowledged thread marker, so that process's latest record names it. Only
 * a process with no record falls back to the legacy mirror, which is all the
 * previous check consulted. */
function runtimeOwnsThread(
  ds: DaemonSession, store: SessionContractStore, ref: ContractSessionRef, runtime: RuntimeContract, threadId: string,
): boolean {
  const own = runtime.identity?.nativeSessionId;
  if (own !== undefined) return own === threadId;
  const recorded = store.physicalRuntimes(ref, runtime.ref)
    .filter(sibling => sibling.identity?.nativeSessionId !== undefined)
    .sort((left, right) => right.ref.epoch - left.ref.epoch)[0];
  if (recorded) return recorded.identity!.nativeSessionId === threadId;
  return ds.session.cliSessionId === threadId;
}

/** Pin a native question to the live execution host. A recorded native id
 * overrides the legacy cli_session_id observation (which can lose a runtime
 * rebind race); see runtimeOwnsThread for a runtime that has none. */
export function captureCodexAsyncAskOrigin(ds: DaemonSession, threadId: string): (() => boolean) | undefined {
  const worker = ds.worker;
  const generation = ds.workerGeneration;
  const sessionGeneration = ds.session.workerGeneration;
  if (!worker || worker.killed || ds.session.status !== 'active') return undefined;
  const workerIsCurrent = () => ds.session.status === 'active' && ds.worker === worker && !worker.killed
    && ds.workerGeneration === generation && ds.session.workerGeneration === sessionGeneration;
  const controller = controllerForSession(ds);
  if (!controller) {
    const legacyIsCurrent = () => workerIsCurrent() && !controllerForSession(ds) && ds.session.cliSessionId === threadId;
    return legacyIsCurrent() ? legacyIsCurrent : undefined;
  }

  const { store, ref } = controller;
  const readCurrent = () => {
    if (!workerIsCurrent()) return undefined;
    const state = store.read(ref);
    const runtime = store.runtime(ref);
    if (!state || state.lifecycle !== 'active' || state.activeOperationId
      || !runtime || !sameRuntime(runtime.ref, state.activeRuntime)
      || !sameWorker(runtime.worker, state.worker) || runtime.worker.generation !== generation
      || runtime.worker.generation !== sessionGeneration
      || (runtime.phase !== 'ready' && runtime.phase !== 'starting')
      || !runtimeOwnsThread(ds, store, ref, runtime, threadId)
      || store.hasPendingRuntimeReplacement(ref, runtime.ref)) return undefined;
    return runtime;
  };
  const origin = readCurrent();
  if (!origin) return undefined;
  return () => {
    const current = readCurrent();
    return !!current && sameRuntime(origin.ref, current.ref) && sameWorker(origin.worker, current.worker);
  };
}
