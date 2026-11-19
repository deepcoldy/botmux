import { describe, expect, it, vi } from 'vitest';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';

function shutdownHarness(existingAppServerEndpoint?: string) {
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const scope = {
    stopScreenshotLoop: vi.fn(),
    lastInitConfig: { existingAppServerEndpoint },
    log: vi.fn(), cleanup: vi.fn(), killCli: vi.fn(),
    process: { exit: vi.fn() },
    sandboxTreeOutlivesWorker: false,
    codexRpcEngine: { stopAndWait: vi.fn(() => barrier) },
    saveUnsentInputsForSuccessor: vi.fn(),
    cliOutlivesWorker: false, backend: null, currentBotmuxTurnId: null,
    isCodexAppCliId: () => false, handsCliPidMarkerToSuccessor: () => false,
  };
  const shutdown = loadWorkerFunction<(reason: string, code: number) => Promise<void>>(
    'shutdownWorkerForParentExitImpl', scope,
  );
  return { scope, release, shutdown };
}

describe('worker RPC shutdown barrier', () => {
  it('keeps the worker alive until detached app-server cleanup finishes', async () => {
    const h = shutdownHarness();
    const result = h.shutdown('disconnect', 0);
    expect(h.scope.codexRpcEngine.stopAndWait).toHaveBeenCalledOnce();
    expect(h.scope.process.exit).not.toHaveBeenCalled();
    expect(h.scope.killCli).not.toHaveBeenCalled();
    h.release();
    await result;
    expect(h.scope.killCli).toHaveBeenCalledOnce();
    expect(h.scope.process.exit).toHaveBeenCalledWith(0);
  });

  it('preserves a user-owned existing app-server during parent shutdown', async () => {
    const h = shutdownHarness('ws://example.test');
    await h.shutdown('disconnect', 0);
    expect(h.scope.codexRpcEngine.stopAndWait).not.toHaveBeenCalled();
    expect(h.scope.killCli).not.toHaveBeenCalled();
    expect(h.scope.process.exit).toHaveBeenCalledWith(0);
  });

  it('does not claim successful shutdown when the cleanup barrier rejects', async () => {
    const h = shutdownHarness();
    h.scope.codexRpcEngine.stopAndWait.mockImplementation(() => Promise.reject(new Error('unverified group')));
    await expect(h.shutdown('disconnect', 0)).rejects.toThrow('unverified group');
    expect(h.scope.process.exit).not.toHaveBeenCalled();
  });
});
