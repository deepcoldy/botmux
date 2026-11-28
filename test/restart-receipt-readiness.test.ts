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
    cliAdapter: { reliableTurnTerminal: true },
    pendingTopicEffortRestart: undefined,
    lastInitConfig: { cliId: 'claude-code' },
    pendingRawInputs: [],
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

  it.each([true, false])('reports the actual adapter turn-terminal capability (%s) with the successful receipt', reliableTurnTerminal => {
    const { scope, live } = relayRebound();
    const run = harness(scope);
    run.state.cliAdapter = { reliableTurnTerminal };
    scope.run(live, () => run.settle('prompt-ready'));
    expect(run.sent.map(entry => entry.msg.type)).toEqual(['restart_result']);
    expect(run.sent[0]!.msg).toMatchObject({
      attemptId: ATTEMPT,
      status: 'succeeded',
      reliableTurnTerminal,
    });
  });

  it.each([
    ['same-process rebind', false],
    ['explicit republish', true],
  ])('keeps the MiniMax compact gate closed during %s', (_kind, explicit) => {
    const { scope, launcher, live } = relayRebound();
    const run = harness(scope);
    run.state.lastInitConfig = { cliId: 'minimax' };
    run.state.pendingRawInputs = [{ content: ' /compact ' }];
    const callback = explicit ? live : launcher;
    scope.run(callback, () => run.settle('restart continuation finished at the prompt', explicit ? { republishPromptReady: true } : undefined));

    expect(run.sent.map(entry => entry.msg.type)).toEqual(['restart_result']);
    expect(run.state.activeRestartAttemptId).toBeUndefined();
    expect(run.state.pendingRawInputs).toEqual([{ content: ' /compact ' }]);
  });
});

/**
 * Call-site wiring for the receipt's envelope. settle() hands the receipt to the
 * real send() without an explicit origin, so the re-scope actually happens here,
 * in sessionEventMetadata — a helper-only test cannot see it, and deleting the
 * restart_result branch there silently resurrects the retired-binding timeout.
 */
describe('sessionEventMetadata stamps the receipt with the live origin', () => {
  const receipt = { type: 'restart_result', attemptId: ATTEMPT, status: 'succeeded', category: 'prompt_ready' } as never;

  it('names the live binding and its runtime when the callback captured the retired one', () => {
    const { scope, launcher, live } = relayRebound();
    const metadata = loadWorkerFunction<(msg: never) => { sessionContract: { bindingId?: string; scope: { runtime?: unknown; operationId?: string } } }>(
      'sessionEventMetadata', { workerSessionEventScope: scope });
    const payload = scope.run(launcher, () => metadata(receipt));
    expect(payload.sessionContract.bindingId).toBe(live.bindingId);
    expect(payload.sessionContract.scope.runtime).toEqual({ runtimeId: 'runtime-real-cli', epoch: 2 });
    // The host's restart_operation_mismatch fence still has to pass.
    expect(payload.sessionContract.scope.operationId).toBe(ATTEMPT);
  });

  it('keeps the stale fence for a callback of a replaced process', () => {
    const scope = new WorkerSessionEventScope({ appId: 'app', sessionId: 'session' }, { workerId: 'worker-1', generation: 1 });
    const replaced = scope.beginRuntime(ATTEMPT, 'cli-process-1');
    scope.assign(replaced.bindingId, { runtimeId: 'runtime-replaced', epoch: 1 });
    replaced.identity = identity;
    const respawned = scope.beginRuntime(ATTEMPT, 'cli-process-2');
    scope.assign(respawned.bindingId, { runtimeId: 'runtime-respawned', epoch: 2 });
    const metadata = loadWorkerFunction<(msg: never) => { sessionContract: { bindingId?: string } }>(
      'sessionEventMetadata', { workerSessionEventScope: scope });
    const payload = scope.run(replaced, () => metadata(receipt));
    expect(payload.sessionContract.bindingId).toBe(replaced.bindingId);
    expect(payload.sessionContract.bindingId).not.toBe(respawned.bindingId);
  });

  it('names the current binding when the callback carries no binding at all', () => {
    const { scope, live } = relayRebound();
    const metadata = loadWorkerFunction<(msg: never) => { sessionContract: { bindingId?: string } }>(
      'sessionEventMetadata', { workerSessionEventScope: scope });
    expect(metadata(receipt).sessionContract.bindingId).toBe(live.bindingId);
  });
});
