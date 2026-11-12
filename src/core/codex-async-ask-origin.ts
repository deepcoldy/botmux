import { sameRuntime, sameWorker } from '../services/session-contract.js';
import { controllerForSession } from './session-controller.js';
import type { DaemonSession } from './types.js';

/** Pin a native question to the live execution host, independently of the
 * legacy cli_session_id observation (which can lose a runtime rebind race). */
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
      || runtime.identity?.nativeSessionId !== threadId
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
