/**
 * The readiness that rides a restart receipt.
 *
 * One startup callback publishes `prompt_ready` and then the attempt's receipt.
 * Both are judged by the binding that callback captured, and the relay has
 * usually superseded it in process by then (spawnCli's binding proves the
 * launcher pid, a second binding proves the real CLI behind it). Re-scoping only
 * the receipt left the daemon with a confirmed restart and `cliReady` false: the
 * card said 已重启 while the next passthrough cascade sat out its whole 120s idle
 * budget against an idle screen (2026-11-23 review of #3734).
 *
 * So the receipt's proven origin carries a readiness publish with it — and only
 * then: a callback of a REPLACED process gets no live origin and still cannot
 * announce the new process ready.
 */
import { describe, expect, it } from 'vitest';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';
import { WorkerSessionEventScope } from '../src/services/session-event-scope.js';
import { decideRestartReceipt } from '../src/core/restart-followup-policy.js';

const ATTEMPT = 'restart-attempt-1';
const identity = { backend: 'tmux', physicalId: '100:1', proof: 'process_start' } as never;

function harness(scope: WorkerSessionEventScope) {
  const sent: Array<{ msg: { type: string; attemptId?: string; status?: string }; origin?: { bindingId: string } }> = [];
  const state: Record<string, unknown> = {
    activeRestartAttemptId: ATTEMPT,
    backend: {},
    codexAutoUpgrade: undefined,
    pendingTopicEffortRestart: undefined,
    isPromptReady: true,
    workerSessionEventScope: scope,
    decideRestartReceipt,
    log: () => {},
    send: (msg: never, origin?: never) => { sent.push({ msg, origin }); },
  };
  return { sent, state, settle: loadWorkerFunction<(trigger: string, opts?: { republishPromptReady?: boolean }) => void>('settleRestartAttemptOnReady', state) };
}

/** spawnCli's binding proved the launcher; the relay then bound the real CLI. */
function relayRebound() {
  const scope = new WorkerSessionEventScope({ appId: 'app', sessionId: 'session' }, { workerId: 'worker-1', generation: 1 });
  const launcher = scope.beginRuntime(ATTEMPT, 'cli-process');
  scope.assign(launcher.bindingId, { runtimeId: 'runtime-launcher', epoch: 1 });
  launcher.identity = identity;
  const live = scope.beginRuntime(ATTEMPT, launcher.physicalId);
  scope.assign(live.bindingId, { runtimeId: 'runtime-real-cli', epoch: 2 });
  return { scope, launcher, live };
}

describe('a restart receipt from a callback the relay superseded', () => {
  it('publishes readiness under the same proven origin, before the receipt', () => {
    const { scope, launcher, live } = relayRebound();
    const run = harness(scope);
    scope.run(launcher, () => run.settle('prompt-ready'));
    expect(run.sent.map(entry => entry.msg.type)).toEqual(['prompt_ready', 'restart_result']);
    expect(run.sent[0]!.origin?.bindingId).toBe(live.bindingId);
    expect(run.sent[1]!.msg).toMatchObject({ attemptId: ATTEMPT, status: 'succeeded' });
    expect(run.state.activeRestartAttemptId).toBeUndefined();
  });

  it('does not duplicate readiness when the callback already runs on the live binding', () => {
    const { scope, live } = relayRebound();
    const run = harness(scope);
    scope.run(live, () => run.settle('prompt-ready'));
    expect(run.sent.map(entry => entry.msg.type)).toEqual(['restart_result']);
  });

  it('stays silent about readiness for a callback of a replaced process', () => {
    const scope = new WorkerSessionEventScope({ appId: 'app', sessionId: 'session' }, { workerId: 'worker-1', generation: 1 });
    const replaced = scope.beginRuntime(ATTEMPT, 'cli-process-1');
    scope.assign(replaced.bindingId, { runtimeId: 'runtime-replaced', epoch: 1 });
    replaced.identity = identity;
    const respawned = scope.beginRuntime(ATTEMPT, 'cli-process-2');
    scope.assign(respawned.bindingId, { runtimeId: 'runtime-respawned', epoch: 2 });
    const run = harness(scope);
    scope.run(replaced, () => run.settle('prompt-ready'));
    expect(run.sent.map(entry => entry.msg.type)).toEqual(['restart_result']);
  });

  it('keeps the explicit republish for callers that ask for it', () => {
    const { scope, live } = relayRebound();
    const run = harness(scope);
    scope.run(live, () => run.settle('restart continuation finished at the prompt', { republishPromptReady: true }));
    expect(run.sent.map(entry => entry.msg.type)).toEqual(['prompt_ready', 'restart_result']);
  });
});
