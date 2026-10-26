import { describe, expect, it, vi } from 'vitest';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';

function fixture() {
  const identity = { launcherPid: 60, launcherProcStart: '600', enginePid: 70, engineProcStart: '700' };
  const scope: Record<string, any> = {
    lastInitConfig: { cliId: 'codex-app' }, isCodexAppCliId: (id: string) => id === 'codex-app',
    backend: { getChildPid: () => 40 }, codexAppRunnerProcessIdentity: undefined,
    captureAttachedCodexAppProcessIdentity: vi.fn(),
    codexAppEngineHasExited: vi.fn(() => true), codexAppCompletionAwaitingFinal: false,
    verifyCodexAppProcessIdentity: vi.fn(() => identity), publishLocalProcessAttestation: vi.fn(),
    rejectCodexAppControlMarker: vi.fn(), codexAppSignedStateReadiness: () => 'ready',
    applyTrustedCodexAppStateMarker: () => ({ accepted: true, busy: true }),
    codexAppTurnLiveness: {}, codexAppReadyAuthority: {}, codexAppProofDeadline: { clear: vi.fn() },
    cleanupCodexAppControlBootstrap: vi.fn(), awaitingFirstPrompt: false,
    idleDetector: { reset: vi.fn() }, queueMicrotask: vi.fn(),
  };
  return { identity, scope, handle: loadWorkerFunction<(kind: string, payload: any) => Promise<boolean>>('handleTrustedCodexAppMarker', scope) };
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
    { processIdentityBoundary: 'idle_restart', busy: true },
    { processIdentityBoundary: 'idle_restart', busy: false, tracksTurn: false },
    { processIdentityBoundary: 'idle_restart', busy: true, tracksTurn: false, acceptingInput: false },
  ])('rejects a replacement without an authenticated pre-submit idle boundary: %j', async marker => {
    const { identity, scope, handle } = fixture();
    scope.codexAppRunnerProcessIdentity = { ...identity, enginePid: 69, engineProcStart: '690' };
    expect(await handle('state', { acceptingInput: true, ...marker, processIdentity: identity })).toBe(false);
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
