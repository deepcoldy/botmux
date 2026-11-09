import { describe, expect, it, vi } from 'vitest';
import { isCodexAppCliId } from '../src/adapters/cli/types.js';
import { resolvePtyInputPolicy } from '../src/utils/pty-input-policy.js';
import { codexAppSignedStateReadiness } from '../src/utils/codex-app-control.js';
import { CodexAppReadyAuthority, CodexAppTurnLiveness, applyTrustedCodexAppStateMarker } from '../src/utils/codex-app-turn-liveness.js';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';
import { workerSubmitHarness } from './helpers/worker-submit-harness.js';

function harness(cliId = 'codex-app') {
  const h = workerSubmitHarness();
  Object.assign(h.scope, {
    lastInitConfig: { cliId },
    cliAdapter: { ...h.scope.cliAdapter, id: cliId, supportsTypeAhead: true },
    isCodexAppCliId, codexAppControlProven: false, codexAppSignedStateObserved: false, codexAppInputReady: false,
    backendScreenEvidenceIsAuthoritativeForMutation: () => true,
    isTypeAheadBlockedByBypass: () => false, resolvePtyInputPolicy,
    traexAutoModelInputHold: () => false,
  });
  h.scope.codexAppRuntimeTypeAheadReady = loadWorkerFunction('codexAppRuntimeTypeAheadReady', h.scope);
  h.scope.runtimePtyInputPolicy = loadWorkerFunction('runtimePtyInputPolicy', h.scope);
  const takeNormal = vi.fn(() => undefined);
  h.scope.freshnessInputQueue.takeNormal = takeNormal;
  return { ...h, takeNormal };
}

describe('Codex App input waits for signed connection readiness', () => {
  it.each([
    { codexAppControlProven: false, codexAppSignedStateObserved: false, codexAppInputReady: false },
    { codexAppControlProven: true, codexAppSignedStateObserved: false, codexAppInputReady: false },
    { codexAppControlProven: true, codexAppSignedStateObserved: true, codexAppInputReady: false },
    { codexAppControlProven: false, codexAppSignedStateObserved: true, codexAppInputReady: true },
    { codexAppControlProven: true, codexAppSignedStateObserved: false, codexAppInputReady: true },
  ])('retains the queue even after terminal timeout advertises prompt ready: %j', async state => {
    const h = harness(); Object.assign(h.scope, state);
    const before = [...h.scope.pendingMessages];
    expect(h.scope.isPromptReady).toBe(true);
    expect(h.scope.runtimePtyInputPolicy().supportsTypeAhead).toBe(true);
    await h.flush();
    expect(h.takeNormal).not.toHaveBeenCalled();
    expect(h.scope.pendingMessages).toEqual(before);
    expect(h.scope.cliAdapter.writeInput).not.toHaveBeenCalled();
    expect(h.scope.publishSandboxRelayCapability).not.toHaveBeenCalled();
  });

  it('releases the same queue once signed state has proved the current connection', async () => {
    const h = harness(); const head = h.scope.pendingMessages[0];
    await h.flush(); expect(h.takeNormal).not.toHaveBeenCalled();
    Object.assign(h.scope, { codexAppControlProven: true, codexAppSignedStateObserved: true, codexAppInputReady: true });
    await h.flush();
    expect(h.takeNormal).toHaveBeenCalledOnce();
    expect(h.scope.pendingMessages[0]).toBe(head);
  });

  it('retains the queue when the connection loses proof during awaited startup work', async () => {
    const h = harness(); const before = [...h.scope.pendingMessages];
    Object.assign(h.scope, { codexAppControlProven: true, codexAppSignedStateObserved: true, codexAppInputReady: true,
      hasRunStartupCommands: false,
      runStartupCommands: async () => { h.scope.codexAppSignedStateObserved = false; return true; },
      runInitialNativeRename: async () => {},
    });
    await h.flush();
    expect(h.takeNormal).not.toHaveBeenCalled();
    expect(h.scope.pendingMessages).toEqual(before);
    h.scope.codexAppSignedStateObserved = true;
    await h.flush(); expect(h.takeNormal).toHaveBeenCalledOnce();
  });

  it('does not apply the signed-runner barrier to Claude input', async () => {
    const h = harness('claude-code');
    await h.flush(); expect(h.takeNormal).toHaveBeenCalledOnce();
  });

  it('does not run startup commands before signed proof even if a terminal timeout raised readiness', async () => {
    const h = harness();
    h.scope.hasRunStartupCommands = false;
    h.scope.runStartupCommands = vi.fn(async () => true);
    h.scope.runInitialNativeRename = vi.fn(async () => {});
    await h.flush();
    expect(h.scope.runStartupCommands).not.toHaveBeenCalled();
    expect(h.scope.runInitialNativeRename).not.toHaveBeenCalled();
  });

  it.each(['raw', 'rename'] as const)('retains %s input when proof is withdrawn during startup commands', async kind => {
    const h = harness(); h.scope.pendingMessages.length = 0;
    Object.assign(h.scope, { codexAppControlProven: true, codexAppSignedStateObserved: true, codexAppInputReady: true,
      hasPendingInputForFlush: () => true, hasRunStartupCommands: false,
      runStartupCommands: async () => { h.scope.codexAppSignedStateObserved = false; return true; },
      runInitialNativeRename: async () => {}, deliverRawInput: vi.fn(async () => {}),
      sendRawCommandLineWithRecoveryFence: vi.fn(async () => {}),
      freshnessInputQueue: { takeRaw: vi.fn(() => h.scope.pendingRawInputs.shift()) },
    });
    const raw = { content: '/help', turnId: 'raw-turn' };
    if (kind === 'raw') h.scope.pendingRawInputs.push(raw);
    else { h.scope.pendingSessionRename = 'new title'; h.scope.cliAdapter.buildSessionRenameCommand = vi.fn(() => '/rename new title'); }
    await h.flush();
    expect(h.scope.deliverRawInput).not.toHaveBeenCalled();
    expect(h.scope.sendRawCommandLineWithRecoveryFence).not.toHaveBeenCalled();
    if (kind === 'raw') expect(h.scope.pendingRawInputs).toEqual([raw]);
    else expect(h.scope.pendingSessionRename).toBe('new title');
  });

  it('retains the next head if proof is withdrawn while rejecting a reconciled queued turn', async () => {
    const h = harness(); const head = h.scope.pendingMessages[0];
    const next = { turnId: 'next', dispatchAttempt: 2, content: 'next payload' };
    h.scope.pendingMessages.push(next);
    Object.assign(h.scope, { codexAppControlProven: true, codexAppSignedStateObserved: true, codexAppInputReady: true,
      workerSessionEventScope: { canSubmit: vi.fn(() => { h.scope.codexAppSignedStateObserved = false; return false; }) },
    });
    h.takeNormal.mockImplementation(() => h.scope.pendingMessages.shift());
    await h.flush();
    expect(h.takeNormal).toHaveBeenCalledOnce();
    expect(h.scope.workerSessionEventScope.canSubmit).toHaveBeenCalledWith(head.turnId, head.dispatchAttempt);
    expect(h.scope.pendingMessages).toEqual([next]);
  });

  it('re-drives input held across a control reconnect once the new connection publishes signed idle', async () => {
    const h = harness();
    const flushPending = vi.fn(() => h.flush());
    Object.assign(h.scope, {
      flushPending, codexAppControlProven: true, codexAppRunnerProcessIdentity: { launcherPid: 100 },
      codexAppTurnLiveness: new CodexAppTurnLiveness(), codexAppReadyAuthority: new CodexAppReadyAuthority(),
      codexAppSignedStateReadiness, applyTrustedCodexAppStateMarker, codexAppCompletionAwaitingFinal: false,
      codexAppTurnDispatchQueue: { recoveredPrefix: () => [] }, codexAppProofDeadline: { clear: vi.fn() },
      cleanupCodexAppControlBootstrap: vi.fn(), rejectCodexAppControlMarker: vi.fn(), failCodexAppControlGeneration: vi.fn(),
      codexAppUnprovenPromptDeferred: false, awaitingFirstPrompt: false, traexFirstPromptViewportRejects: () => false,
      currentPostTerminalInputFence: () => null, stopStructuredStartGraceRecheck: vi.fn(),
    });
    h.scope.markPromptReady = loadWorkerFunction('markPromptReady', h.scope);
    const marker = loadWorkerFunction('handleTrustedCodexAppMarker', h.scope);
    // The authenticated socket of an idle session closed; its prompt stays ready.
    h.scope.codexAppReadyAuthority.beginWork(); h.scope.codexAppTurnLiveness.beginReattachObservation();
    expect(h.scope.isPromptReady).toBe(true);
    await h.flush();
    expect(h.takeNormal).not.toHaveBeenCalled();
    expect(await marker('state', { busy: false, acceptingInput: true }, { generation: 'generation', seq: 2 })).toBe(true);
    for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
    expect(flushPending).toHaveBeenCalled();
    expect(h.takeNormal).toHaveBeenCalledOnce();
  });
});
