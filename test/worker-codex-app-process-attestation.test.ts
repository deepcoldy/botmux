import { describe, expect, it, vi } from 'vitest';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';

function fixture() {
  const identity = { launcherPid: 60, launcherProcStart: '600', enginePid: 70, engineProcStart: '700' };
  const scope: Record<string, any> = {
    lastInitConfig: { cliId: 'codex-app' }, isCodexAppCliId: (id: string) => id === 'codex-app',
    backend: { getChildPid: () => 40 }, codexAppRunnerProcessIdentity: undefined,
    codexAppControlProven: true,
    captureAttachedCodexAppProcessIdentity: vi.fn(),
    codexAppEngineHasExited: vi.fn(() => true), codexAppCompletionAwaitingFinal: false,
    verifyCodexAppProcessIdentity: vi.fn(() => identity), publishLocalProcessAttestation: vi.fn(),
    rejectCodexAppControlMarker: vi.fn(), codexAppSignedStateReadiness: () => 'ready',
    applyTrustedCodexAppStateMarker: () => ({ accepted: true, busy: true }),
    codexAppTurnLiveness: {}, codexAppReadyAuthority: {}, codexAppProofDeadline: { clear: vi.fn() },
    cleanupCodexAppControlBootstrap: vi.fn(), awaitingFirstPrompt: false,
    restoreCodexAppAttestedTurn: vi.fn(),
    idleDetector: { reset: vi.fn() }, queueMicrotask: vi.fn(),
  };
  return { identity, scope, handle: loadWorkerFunction<(kind: string, payload: any,
    control?: { generation: string; seq: number }) => Promise<boolean>>('handleTrustedCodexAppMarker', scope) };
}

describe('worker Codex App process attestation', () => {
  it('publishes the signed, kernel-verified engine before releasing input readiness', async () => {
    const { identity, scope, handle } = fixture();
    scope.publishLocalProcessAttestation.mockImplementation(() => {
      expect(scope.codexAppInputReady).not.toBe(true);
      expect(scope.codexAppRunnerProcessIdentity).toEqual(identity);
    });
    expect(await handle('state', { processIdentity: identity, acceptingInput: true })).toBe(true);
    expect(scope.verifyCodexAppProcessIdentity).toHaveBeenCalledWith(identity, 40);
    expect(scope.publishLocalProcessAttestation).toHaveBeenCalledWith(40);
    expect(scope.codexAppInputReady).toBe(true);
    await handle('state', { processIdentity: identity, acceptingInput: true });
    expect(scope.publishLocalProcessAttestation).toHaveBeenCalledTimes(1);
  });

  it('keeps invalid or changed runtime identities from releasing readiness or replacing the proof', async () => {
    const { identity, scope, handle } = fixture();
    scope.verifyCodexAppProcessIdentity.mockReturnValueOnce(undefined);
    expect(await handle('state', { processIdentity: identity, acceptingInput: true })).toBe(false);
    expect(scope.codexAppInputReady).not.toBe(true);
    expect(scope.publishLocalProcessAttestation).not.toHaveBeenCalled();
    scope.codexAppRunnerProcessIdentity = { ...identity, engineProcStart: 'old' };
    expect(await handle('state', { processIdentity: identity, acceptingInput: true })).toBe(false);
    expect(scope.codexAppRunnerProcessIdentity.engineProcStart).toBe('old');
  });

  it('leaves other signed runner state and legacy RPC behavior unchanged', async () => {
    const { scope, handle } = fixture();
    expect(await handle('state', { acceptingInput: true })).toBe(true);
    expect(scope.publishLocalProcessAttestation).not.toHaveBeenCalled();
  });

  it('uses the signed reply turn on older runners thinking records for warm recovery', async () => {
    const { scope, handle } = fixture();
    const proof = { generation: 'g1', seq: 6 };
    scope.normalizeCodexAppCotMarker = () => ({ turnId: 'om_original', entries: [] });
    scope.codexAppTurnDispatchQueue = { findByTurnId: () => ({ turnId: 'om_original' }) };
    scope.observeCotEntries = vi.fn();
    expect(await handle('thinking', {}, proof)).toBe(true);
    expect(scope.restoreCodexAppAttestedTurn).toHaveBeenCalledWith('om_original', proof);
  });

  it('rotates a verified idle replacement before its queued input without publishing ready', async () => {
    const { identity, scope, handle } = fixture();
    scope.codexAppRunnerProcessIdentity = { ...identity, enginePid: 69, engineProcStart: '690' };
    scope.applyTrustedCodexAppStateMarker = () => ({ accepted: true, busy: true });
    const state = { processIdentity: identity, processIdentityBoundary: 'idle_restart',
      busy: true, tracksTurn: false, acceptingInput: true };
    expect(await handle('state', state)).toBe(true);
    expect(scope.codexAppRunnerProcessIdentity).toEqual(identity);
    expect(scope.publishLocalProcessAttestation).toHaveBeenCalledTimes(1);
    await handle('state', state); // Replayed state must not resnapshot live tools.
    expect(scope.publishLocalProcessAttestation).toHaveBeenCalledTimes(1);
  });

  it.each([
    { busy: true },
    { busy: true, tracksTurn: false },
    { processIdentityBoundary: 'idle_restart', busy: true },
    { processIdentityBoundary: 'idle_restart', busy: false, tracksTurn: false },
    { processIdentityBoundary: 'idle_restart', busy: true, tracksTurn: false, acceptingInput: false },
  ])('rejects a replacement without an authenticated pre-submit idle boundary: %j', async marker => {
    const { identity, scope, handle } = fixture();
    const previous = { ...identity, enginePid: 69, engineProcStart: '690' };
    scope.codexAppRunnerProcessIdentity = previous;
    expect(await handle('state', { acceptingInput: true, ...marker, processIdentity: identity })).toBe(false);
    expect(scope.codexAppRunnerProcessIdentity).toEqual(previous);
    expect(scope.publishLocalProcessAttestation).not.toHaveBeenCalled();
  });

  it.each(['live-engine', 'unfinished-final', 'invalid-kernel-proof'])('rejects an unsafe idle rotation: %s', async reason => {
    const { identity, scope, handle } = fixture();
    scope.codexAppRunnerProcessIdentity = { ...identity, enginePid: 69, engineProcStart: '690' };
    if (reason === 'live-engine') scope.codexAppEngineHasExited.mockReturnValue(false);
    if (reason === 'unfinished-final') scope.codexAppCompletionAwaitingFinal = true;
    if (reason === 'invalid-kernel-proof') scope.verifyCodexAppProcessIdentity.mockReturnValue(undefined);
    expect(await handle('state', { processIdentity: identity, processIdentityBoundary: 'idle_restart',
      busy: true, tracksTurn: false, acceptingInput: true })).toBe(false);
    expect(scope.codexAppRunnerProcessIdentity.enginePid).toBe(69);
    expect(scope.publishLocalProcessAttestation).not.toHaveBeenCalled();
  });

  it('can reattest an older authenticated runner once without resnapshotting mid-turn tools', async () => {
    const { identity, scope, handle } = fixture();
    scope.captureAttachedCodexAppProcessIdentity.mockReturnValue(identity);
    expect(await handle('state', { acceptingInput: true })).toBe(true);
    expect(scope.codexAppRunnerProcessIdentity).toEqual(identity);
    await handle('state', { acceptingInput: true });
    expect(scope.captureAttachedCodexAppProcessIdentity).toHaveBeenCalledTimes(1);
    expect(scope.publishLocalProcessAttestation).toHaveBeenCalledTimes(1);
  });

  it('retains the frozen engine start token rather than blessing a reused PID', () => {
    const scope: Record<string, any> = {
      codexRpcEngine: undefined,
      codexAppRunnerProcessIdentity: { enginePid: 70, engineProcStart: '700' },
      readProcessStartIdentity: (pid: number) => pid === 70 ? 'REUSED' : '400',
      send: vi.fn(), effectiveBackendType: 'tmux', currentCliCredentialIsolated: false,
      currentBotmuxTurnId: undefined,
    };
    loadWorkerFunction<(pid: number) => void>('publishLocalProcessAttestation', scope)(40);
    expect(scope.send).toHaveBeenCalledWith(expect.objectContaining({ cliPid: 40, enginePid: 70, engineProcStart: '700' }));
    scope.codexAppRunnerProcessIdentity = undefined;
    scope.codexRpcEngine = { appServerPid: 71 };
    loadWorkerFunction<(pid: number) => void>('publishLocalProcessAttestation', scope)(40);
    expect(scope.send).toHaveBeenLastCalledWith(expect.objectContaining({ enginePid: 71, engineProcStart: '400' }));
  });
});

describe('authenticated Codex App turn recovery', () => {
  function recoveryFixture() {
    const entry = { state: 'prepared', dispatchId: 'd1', turnId: 'om_original', dispatchAttempt: 1,
      codexAppSteerable: true, replyTargetSenderOpenId: 'ou_original', replyTargetSenderIsBot: false };
    const scope: Record<string, any> = {
      currentBotmuxTurnId: undefined, codexAppRunnerProcessIdentity: { enginePid: 70 },
      codexAppCompletionAwaitingFinal: false,
      codexAppControlProven: true,
      codexAppControlStateValue: { status: 'active', identities: [{ generation: 'g1' }] },
      codexAppGenerationCommits: [{ generation: 'g1', committedThrough: 5 }],
      codexAppRecoveredDispatches: [entry],
      codexAppTurnDispatchQueue: { recoveredPrefix: () => [entry] },
      lastInitConfig: { larkAppId: 'cli_original' },
      adoptInitialActiveTurn: vi.fn(), publishSandboxRelayCapability: vi.fn(), log: vi.fn(),
    };
    return { entry, scope, restore: loadWorkerFunction<(payload: any, control?: any) => void>(
      'restoreCodexAppAttestedTurn', scope) };
  }
  it('restores the exact persisted human caller after a warm worker replacement', () => {
    const { scope, restore } = recoveryFixture();
    restore('om_original', { generation: 'g1', seq: 6 });
    expect(scope.adoptInitialActiveTurn).toHaveBeenCalledWith(expect.objectContaining({
      turnId: 'om_original', trustedCaller: { requestLarkAppId: 'cli_original',
        requestUserOpenId: 'ou_original', senderType: 'user' },
    }));
    expect(scope.publishSandboxRelayCapability).toHaveBeenCalledTimes(1);
  });
  it.each([1, 250])('restores an unfinished first turn with no committed final (sequence %i)', seq => {
    const { scope, restore } = recoveryFixture();
    scope.codexAppGenerationCommits = [];
    restore('om_original', { generation: 'g1', seq });
    expect(scope.adoptInitialActiveTurn).toHaveBeenCalledWith(expect.objectContaining({ turnId: 'om_original' }));
    expect(scope.publishSandboxRelayCapability).toHaveBeenCalledTimes(1);
  });
  it.each(['unproven', 'missing-state', 'pending', 'multiple-identities', 'zero', 'negative', 'fractional', 'nan']) (
    'does not infer authentication from an empty commit history: %s', reason => {
      const { scope, restore } = recoveryFixture();
      scope.codexAppGenerationCommits = [];
      let seq = 1;
      if (reason === 'unproven') scope.codexAppControlProven = false;
      if (reason === 'missing-state') scope.codexAppControlStateValue = undefined;
      if (reason === 'pending') scope.codexAppControlStateValue.status = 'pending';
      if (reason === 'multiple-identities') scope.codexAppControlStateValue.identities.push({ generation: 'g2' });
      if (reason === 'zero') seq = 0;
      if (reason === 'negative') seq = -1;
      if (reason === 'fractional') seq = 1.5;
      if (reason === 'nan') seq = NaN;
      restore('om_original', { generation: 'g1', seq });
      expect(scope.adoptInitialActiveTurn).not.toHaveBeenCalled();
      expect(scope.publishSandboxRelayCapability).not.toHaveBeenCalled();
    },
  );
  it.each(['dispatchId', 'turnId', 'dispatchAttempt'])('rejects a reservation with a mismatched %s', field => {
    const { entry, scope, restore } = recoveryFixture();
    scope.codexAppTurnDispatchQueue.recoveredPrefix = () => [{ ...entry,
      [field]: field === 'dispatchAttempt' ? 2 : 'other' }];
    restore('om_original', { generation: 'g1', seq: 6 });
    expect(scope.adoptInitialActiveTurn).not.toHaveBeenCalled();
    expect(scope.publishSandboxRelayCapability).not.toHaveBeenCalled();
  });
  it.each([
    { signedTurn: null }, { signedTurn: undefined }, { signedTurn: 42 },
    { signedTurn: {} }, { signedTurn: [] }, { signedTurn: '' }, { signedTurn: false },
  ])('rejects a non-string or empty signed turn: %j', ({ signedTurn }) => {
    const { scope, restore } = recoveryFixture();
    restore(signedTurn, { generation: 'g1', seq: 6 });
    expect(scope.adoptInitialActiveTurn).not.toHaveBeenCalled();
    expect(scope.publishSandboxRelayCapability).not.toHaveBeenCalled();
  });
  it.each(['active', 'unsigned', 'generation', 'old-sequence', 'unfinished-final', 'wrong-turn', 'missing-turn', 'engine',
    'ambiguous', 'reservation', 'callerless', 'bot', 'sender'])('does not recover ambiguous or unproven authority: %s', reason => {
    const { entry, scope, restore } = recoveryFixture();
    if (reason === 'active') scope.currentBotmuxTurnId = 'om_current';
    if (reason === 'generation') scope.codexAppControlStateValue.identities[0].generation = 'g2';
    if (reason === 'old-sequence') scope.codexAppGenerationCommits[0].committedThrough = 6;
    if (reason === 'unfinished-final') scope.codexAppCompletionAwaitingFinal = true;
    if (reason === 'engine') scope.codexAppRunnerProcessIdentity = undefined;
    if (reason === 'ambiguous') scope.codexAppRecoveredDispatches.push({ ...entry, dispatchId: 'd2' });
    if (reason === 'reservation') scope.codexAppTurnDispatchQueue.recoveredPrefix = () => [];
    if (reason === 'callerless') entry.codexAppSteerable = false;
    if (reason === 'bot') entry.replyTargetSenderIsBot = true;
    if (reason === 'sender') entry.replyTargetSenderOpenId = '';
    restore(reason === 'wrong-turn' ? 'om_other' : reason === 'missing-turn' ? undefined : 'om_original',
      reason === 'unsigned' ? undefined : { generation: 'g1', seq: 6 });
    expect(scope.adoptInitialActiveTurn).not.toHaveBeenCalled();
    expect(scope.publishSandboxRelayCapability).not.toHaveBeenCalled();
  });
});
