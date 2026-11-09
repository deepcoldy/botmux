import { describe, expect, it, vi } from 'vitest';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';
import { resolveCodexAppFinalTurnIdentity } from '../src/adapters/cli/codex-app-turn.js';
import { isCodexAppCliId } from '../src/adapters/cli/types.js';
import { normalizeFinalUsage } from '../src/services/codex-app-runner-protocol.js';
import { bridgePostText } from '../src/services/bridge-fallback-gate.js';
import { runnerFinalOutcome } from '../src/services/runner-final-outcome.js';
import { InflightInputTracker } from '../src/core/inflight-input-tracker.js';

function runner(cliId = 'minimax') {
  const send = vi.fn();
  const terminal = vi.fn();
  // The real production function retires the finalized turn here; use the real
  // tracker (not a stub) so a final actually moves replay state the tests can
  // assert on.
  const inflightInputs = new InflightInputTracker();
  const scope = {
    lastInitConfig: { cliId }, isCodexAppCliId, normalizeFinalUsage,
    resolveCodexAppFinalTurnIdentity, bridgePostText, runnerFinalOutcome,
    currentBotmuxTurnId: 'om_current', currentBotmuxDispatchAttempt: 2,
    send, emitTurnTerminal: terminal, log: vi.fn(), cliName: () => cliId,
    inflightInputs,
  };
  return { scope, send, terminal, inflightInputs, final: loadWorkerFunction<(kind: string, payload: Record<string, unknown>) => Promise<boolean>>(
    'handleTrustedCodexAppMarker', scope,
  ) };
}

describe('MiniMax final marker downstream settlement', () => {
  it.each(['unrecognized', null, { code: 'cancelled' }])('fails closed for unknown MiniMax error %j', async errorCode => {
    const worker = runner();
    await worker.final('final', { content: 'diagnostic', errorCode, turnId: 'om_current' });
    expect(worker.terminal.mock.calls[0].slice(0, 4)).toEqual(['om_current', 'failed', 'execution_failed', 2]);
  });

  it('does not impose MiniMax error semantics on other runners', async () => {
    const worker = runner('dsh');
    await worker.final('final', { content: 'answer', errorCode: 'cancelled', turnId: 'om_current' });
    expect(worker.terminal.mock.calls[0].slice(0, 4)).toEqual(['om_current', 'completed', undefined, 2]);
  });
  it.each(['turn_budget_exhausted', 'execution_failed'])('forwards %s as a diagnostic and a failed terminal', async errorCode => {
    const worker = runner();
    expect(await worker.final('final', { content: 'native diagnostic', errorCode, turnId: 'om_current' })).toBe(true);
    expect(worker.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'final_output', turnId: 'om_current', dispatchAttempt: 2,
      content: 'native diagnostic', turnFailed: true, turnFailureCode: errorCode,
    }));
    expect(worker.terminal).toHaveBeenCalledWith('om_current', 'failed', errorCode, 2, undefined, undefined, expect.any(Number));
    // Recovery is a new turn: no error state leaks into its successful final.
    worker.scope.currentBotmuxTurnId = 'om_next';
    await worker.final('final', { content: 'recovered', turnId: 'om_next' });
    expect(worker.send.mock.calls.at(-1)?.[0].turnFailed).toBeUndefined();
    expect(worker.terminal.mock.calls.at(-1)?.slice(0, 4)).toEqual(['om_next', 'completed', undefined, 2]);
  });

  it('settles cancellation without forwarding an error message as a successful answer', async () => {
    const worker = runner();
    await worker.final('final', { content: 'stopped', errorCode: 'cancelled', turnId: 'om_current' });
    expect(worker.send).not.toHaveBeenCalled();
    expect(worker.terminal.mock.calls[0].slice(0, 4)).toEqual(['om_current', 'cancelled', 'cancelled', 2]);
  });

  it('does not let earlier explicit output suppress a native failure diagnostic', async () => {
    const worker = runner();
    await worker.final('final', { content: 'native diagnostic', errorCode: 'turn_budget_exhausted',
      turnId: 'om_current', startedAtMs: Date.now() - 100 });
    expect(worker.send).toHaveBeenCalledWith(expect.objectContaining({ turnFailed: true, turnFailureCode: 'turn_budget_exhausted' }));
  });

  it.each(['minimax', 'dsh', 'mira'])('preserves ordinary %s success', async cli => {
    const worker = runner(cli);
    // A trusted final settles the turn: it must leave replay tracking (a later
    // CLI exit must not carry this input into a fresh session). The filter is
    // exact-turn, so a different in-flight input survives.
    worker.inflightInputs.onWrite({ turnId: 'om_current' });
    worker.inflightInputs.onWrite({ turnId: 'om_queued' });
    await worker.final('final', { content: 'answer', turnId: 'om_current' });
    expect(worker.send.mock.calls[0][0]).toMatchObject({ content: 'answer', turnId: 'om_current' });
    expect(worker.send.mock.calls[0][0].turnFailed).toBeUndefined();
    expect(worker.terminal.mock.calls[0].slice(0, 4)).toEqual(['om_current', 'completed', undefined, 2]);
    expect(worker.inflightInputs.onCliExit()).toBe(1);
    expect(worker.inflightInputs.takeCarryOver().map(item => item.turnId)).toEqual(['om_queued']);
  });

  it.each([{ turnId: 'om_old' }, { turnId: 'om_current', dispatchAttempt: 1 }])('rejects stale failure identity %j', async identity => {
    const worker = runner();
    expect(await worker.final('final', { content: 'late', errorCode: 'execution_failed', ...identity })).toBe(false);
    expect(worker.send).not.toHaveBeenCalled();
    expect(worker.terminal).not.toHaveBeenCalled();
  });
});
