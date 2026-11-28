import { describe, expect, it, vi } from 'vitest';
import { loadWorkerFunction, loadWorkerMessageHandler } from './helpers/worker-function-harness.js';

function shutdownHarness(existingAppServerEndpoint?: string) {
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const engine = { appServerPid: 4242, stopAndWait: vi.fn(() => barrier) };
  const scope: Record<string, any> = {
    stopScreenshotLoop: vi.fn(),
    lastInitConfig: { existingAppServerEndpoint },
    sessionId: 'sid-rpc-shutdown',
    effectiveBackendType: 'tmux',
    isRemoteBackendType: () => false,
    log: vi.fn(), cleanup: vi.fn(), killCli: vi.fn(),
    process: { exit: vi.fn() },
    sandboxTreeOutlivesWorker: false,
    codexRpcEngine: engine,
    codexBridgeQueue: { peek: () => [], stopRpcActive: vi.fn(), dropPendingTurn: vi.fn() },
    traexRpcLeaseContext: undefined,
    clearRpcEnginePidMarker: vi.fn(),
    stopStructuredStartGraceRecheck: vi.fn(),
    saveUnsentInputsForSuccessor: vi.fn(),
    cliOutlivesWorker: false, backend: null, retiredRuntimeBackend: null, currentBotmuxTurnId: null,
    isCodexAppCliId: () => false, handsCliPidMarkerToSuccessor: vi.fn(() => false),
    cancelRetiredRuntimeExit: vi.fn(),
    sendAndFlush: vi.fn(async () => {}),
    stopBridgeWatcher: vi.fn(), stopCodexBridge: vi.fn(),
    stopOwnedSessionScope: vi.fn(), clearSendMarkers: vi.fn(), clearBridgeTurnJournalFile: vi.fn(),
  };
  scope.stopCodexRpcEngine = loadWorkerFunction('stopCodexRpcEngine', scope);
  const shutdown = loadWorkerFunction<(reason: string, code: number) => Promise<void>>(
    'shutdownWorkerForParentExitImpl', scope,
  );
  const close = loadWorkerMessageHandler('close', scope);
  return { scope, engine, release, shutdown, close };
}

function unprovenLease(scope: Record<string, any>) {
  const markDeathUnproven = vi.fn(async () => {});
  scope.traexRpcLeaseContext = { settled: false, lease: { markDeathUnproven } };
  return markDeathUnproven;
}

describe('worker RPC shutdown barrier', () => {
  it('keeps the worker alive until detached app-server cleanup finishes', async () => {
    const h = shutdownHarness();
    const result = h.shutdown('disconnect', 0);
    expect(h.engine.stopAndWait).toHaveBeenCalledOnce();
    expect(h.scope.process.exit).not.toHaveBeenCalled();
    expect(h.scope.killCli).not.toHaveBeenCalled();
    h.release();
    await result;
    expect(h.scope.killCli).toHaveBeenCalledOnce();
    expect(h.scope.handsCliPidMarkerToSuccessor).toHaveBeenCalledWith(expect.objectContaining({ rpcEngineEngaged: true }));
    expect(h.scope.process.exit).toHaveBeenCalledWith(0);
  });

  it('preserves a user-owned existing app-server during parent shutdown', async () => {
    const h = shutdownHarness('ws://example.test');
    await h.shutdown('disconnect', 0);
    expect(h.engine.stopAndWait).not.toHaveBeenCalled();
    expect(h.scope.killCli).not.toHaveBeenCalled();
    expect(h.scope.process.exit).toHaveBeenCalledWith(0);
  });

  it.each(['false', 'throw'] as const)('records unproven parent-exit teardown and still finishes remaining cleanup (%s)', async mode => {
    const h = shutdownHarness();
    const markDeathUnproven = unprovenLease(h.scope);
    if (mode === 'throw') h.engine.stopAndWait.mockRejectedValue(new Error('unverified group'));
    else h.engine.stopAndWait.mockResolvedValue(false as any);
    await h.shutdown('disconnect', 0);
    expect(markDeathUnproven).toHaveBeenCalledWith(4242);
    expect(h.scope.saveUnsentInputsForSuccessor).toHaveBeenCalledOnce();
    expect(h.scope.killCli).toHaveBeenCalledOnce();
    expect(h.scope.process.exit).toHaveBeenCalledWith(0);
  });

  it.each(['false', 'throw'] as const)('marks unproven local-close teardown before failing the close (%s)', async mode => {
    const h = shutdownHarness();
    const markDeathUnproven = unprovenLease(h.scope);
    if (mode === 'throw') h.engine.stopAndWait.mockRejectedValue(new Error('unverified group'));
    else h.engine.stopAndWait.mockResolvedValue(false as any);
    await h.close({ type: 'close' });
    expect(markDeathUnproven).toHaveBeenCalledWith(4242);
    expect(h.scope.process.exit).toHaveBeenCalledWith(1);
    expect(h.scope.killCli).not.toHaveBeenCalled();
    expect(h.scope.clearSendMarkers).not.toHaveBeenCalled();
  });
});
