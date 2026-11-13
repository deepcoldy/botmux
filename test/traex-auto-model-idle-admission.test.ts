import { describe, expect, it, vi } from 'vitest';
import { ActiveTurnAuthority } from '../src/core/active-turn-authority.js';
import { TraexAutoModelController, traexAutoModelPreflightEnabled } from '../src/services/traex-auto-model.js';
import { traexCapacityQueueVisible, traexModelProgressVisible, traexQueuedTypeAheadVisible } from '../src/adapters/cli/traex.js';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';
import { workerSubmitHarness } from './helpers/worker-submit-harness.js';

function idleAdmissionHarness() {
  const h = workerSubmitHarness();
  const { scope } = h;
  const controller = new TraexAutoModelController({
    enabled: true, trigger: 'capacity', models: ['core', 'backup'],
    reselectPerTurn: false, preflightLoadCheck: false, queueTimeoutMs: 5_000,
  });
  controller.beginTurn('previous');
  scope.pendingMessages.splice(0, scope.pendingMessages.length, { content: 'follow-up', turnId: 'next' });
  Object.assign(scope, {
    backend: { captureViewportAsync: vi.fn(async () => '❯ Use /skills to list available skills') },
    traexAutoModelRuntimeEligible: () => true,
    traexAutoModelController: controller, traexAutoModelSwitching: false,
    traexAutoModelTurnReplayForbidden: false, traexAutoModelPreflightPending: false,
    traexAutoModelPreflightEnabled, activeTurnAuthority: new ActiveTurnAuthority(),
    currentBotmuxTurnId: 'previous', backendScreenRevision: 0, observedPaneGridRevision: 0,
    renderer: null, backendScreenEvidenceIsAuthoritativeForMutation: () => true,
    commandLineWritesPending: 0, injectionFlushing: false,
    currentPostTerminalInputFence: () => null, retryTraexAutoModelAdmission: vi.fn(),
    traexCapacityQueueVisible, traexModelProgressVisible, traexQueuedTypeAheadVisible,
    traexAutoModelInputHold: () => false,
    beginCliWriteCycle: vi.fn(() => { scope.isPromptReady = false; }),
    publishActiveRuntime: vi.fn(), markTurnRetired: vi.fn(),
    acknowledgeTurnInputCommitted: vi.fn(),
    maybeQueuePostSubmitNativeSessionTitle: vi.fn(),
  });
  scope.resetTraexAutoModelBeforePendingTurn = loadWorkerFunction('resetTraexAutoModelBeforePendingTurn', scope);
  scope.admitTraexAutoModelPendingInput = loadWorkerFunction('admitTraexAutoModelPendingInput', scope);
  scope.deferNativeCodexInputCommit = loadWorkerFunction('deferNativeCodexInputCommit', scope);
  scope.deferTurnInputCommitUntilSubmission = loadWorkerFunction('deferTurnInputCommitUntilSubmission', scope);
  scope.cliAdapter.writeInput = vi.fn(async () => ({ submitted: true }));
  return h;
}

describe('idle auto-model input after a transient admission refusal', () => {
  it.each(['viewport race', 'empty capture'] as const)('retries %s on a static composer and submits exactly once', async refusal => {
    const h = idleAdmissionHarness();
    const { scope } = h;
    const item = scope.pendingMessages[0];
    scope.backend.captureViewportAsync.mockImplementationOnce(async () => {
      if (refusal === 'viewport race') scope.backendScreenRevision++;
      return refusal === 'empty capture' ? '' : '❯ Use /skills to list available skills';
    });
    await h.flush();
    expect(scope.cliAdapter.writeInput).not.toHaveBeenCalled();
    expect(scope.pendingMessages).toEqual([item]);
    expect(scope.retryTraexAutoModelAdmission).toHaveBeenCalledOnce();
    // No new CLI idle event or manual readiness assignment between attempts.
    await h.flush();
    expect(scope.backend.captureViewportAsync).toHaveBeenCalledTimes(2);
    expect(scope.cliAdapter.writeInput).toHaveBeenCalledOnce();
    expect(scope.pendingMessages).toEqual([]);
    await h.flush();
    expect(scope.cliAdapter.writeInput).toHaveBeenCalledOnce();
    expect(scope.emitTurnTerminal).not.toHaveBeenCalled();
  });

  it.each(['backend replacement', 'generation change', 'restart'] as const)('does not restore stale readiness across %s', async change => {
    const h = idleAdmissionHarness();
    const { scope } = h;
    scope.backend.captureViewportAsync.mockImplementationOnce(async () => {
      if (change === 'backend replacement') scope.backend = {};
      else if (change === 'generation change') scope.cliSpawnGeneration++;
      else scope.cliRestartInProgress = true;
      return '❯ Use /skills to list available skills';
    });
    await h.flush();
    expect(scope.isPromptReady).toBe(false);
    expect(scope.cliAdapter.writeInput).not.toHaveBeenCalled();
    expect(scope.pendingMessages).toHaveLength(1);
  });

  it('keeps capacity-queued input outside the CLI until a later capture proves the composer', async () => {
    const h = idleAdmissionHarness();
    const { scope } = h;
    scope.backend.captureViewportAsync.mockResolvedValue('◆ Queued for capacity (2s • esc to interrupt)');
    await h.flush();
    await h.flush();
    expect(scope.cliAdapter.writeInput).not.toHaveBeenCalled();
    expect(scope.pendingMessages).toHaveLength(1);
    scope.backend.captureViewportAsync.mockResolvedValue('❯ Use /skills to list available skills');
    await h.flush();
    expect(scope.cliAdapter.writeInput).toHaveBeenCalledOnce();
    expect(scope.pendingMessages).toEqual([]);
  });

  it('does not invent prompt readiness for a busy type-ahead input', async () => {
    const h = idleAdmissionHarness();
    const { scope } = h;
    scope.isPromptReady = false;
    scope.activeTurnAuthority.reserve({ turnId: 'previous' });
    scope.activeTurnAuthority.markStarted({ turnId: 'previous' });
    scope.backend.captureViewportAsync.mockResolvedValue('');
    await h.flush();
    expect(scope.isPromptReady).toBe(false);
    expect(scope.cliAdapter.writeInput).not.toHaveBeenCalled();
    expect(scope.pendingMessages).toHaveLength(1);
  });
});
