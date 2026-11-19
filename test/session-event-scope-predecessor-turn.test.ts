/**
 * Which of a worker's callbacks may hand a turn's answer to the daemon.
 *
 * A re-attached worker inherits a running turn that a predecessor submitted
 * under a runtime this worker never bound. Its answer comes back on the
 * callback of the live CLI this worker attached to; whether that CLI's runtime
 * is the one the turn ran on is the daemon's decision — it holds events of an
 * unconfirmed binding and refuses, with a notice to the group, a turn it cannot
 * tie to this runtime. Dropping the answer in the worker would leave the group
 * with neither the reply nor the notice. A callback left by an earlier CLI of
 * this same worker stays silent: it no longer speaks for any live process.
 */
import { describe, expect, it } from 'vitest';
import { WorkerSessionEventScope } from '../src/services/session-event-scope.js';

const predecessorRuntime = { runtimeId: 'runtime-of-the-predecessor', epoch: 1 };
const turn = { executionId: 'exec-1', turnId: 'om_turn' };

/** A worker that knows the turn only from the contract bootstrap: submitted
 *  and running on a runtime of the worker generation before it. */
function reattachedWorker() {
  const scope = new WorkerSessionEventScope({ appId: 'app', sessionId: 'session' }, { workerId: 'worker-2', generation: 2 });
  scope.noteAdmission({ ref: turn, runtime: predecessorRuntime, phase: 'reconciling' });
  return scope;
}

describe('a turn a predecessor worker submitted', () => {
  it('is handed to the daemon from the live CLI this worker re-attached, confirmed or not', () => {
    const scope = reattachedWorker();
    const live = scope.beginRuntime(undefined, 'pane-cli');
    expect(scope.run(live, () => scope.ownsExecutionEvent(turn.turnId))).toBe(true);
    scope.assign(live.bindingId, { runtimeId: 'runtime-of-this-worker', epoch: 2 });
    expect(scope.run(live, () => scope.ownsExecutionEvent(turn.turnId))).toBe(true);
  });

  it('is not handed over by a callback of an earlier CLI of this worker', () => {
    const scope = reattachedWorker();
    const earlier = scope.beginRuntime(undefined, 'earlier-cli');
    scope.beginRuntime(undefined, 'respawned-cli');
    expect(scope.run(earlier, () => scope.ownsExecutionEvent(turn.turnId))).toBe(false);
  });

  it('is not handed over once this worker bound the turn\'s runtime to another CLI', () => {
    const scope = reattachedWorker();
    const executor = scope.beginRuntime(undefined, 'cli-that-ran-it');
    scope.assign(executor.bindingId, predecessorRuntime);
    const live = scope.beginRuntime(undefined, 'respawned-cli');
    expect(scope.run(live, () => scope.ownsExecutionEvent(turn.turnId))).toBe(false);
    expect(scope.run(executor, () => scope.ownsExecutionEvent(turn.turnId))).toBe(true);
  });
});
