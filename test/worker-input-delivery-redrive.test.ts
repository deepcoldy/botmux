import { describe, expect, it, vi } from 'vitest';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';

function harness() {
  const backend = {};
  const quarantine = { backend, generation: 7, turnId: 'turn-a', dispatchAttempt: 1 };
  const scope = {
    backend,
    cliSpawnGeneration: 7,
    cliRestartInProgress: false,
    isPromptReady: true,
    inputDeliveryQuarantine: quarantine as typeof quarantine | null,
    flushPending: vi.fn(async () => {}),
    idleDetector: { fireIdle: vi.fn() },
    log: vi.fn(),
  };
  const release = loadWorkerFunction<(value: typeof quarantine | null, reason: string,
    opts?: { redriveTerminal?: boolean }) => boolean>('releaseInputDeliveryQuarantine', scope);
  return { scope, quarantine, release };
}

describe('worker input delivery terminal redrive', () => {
  it('flushes queued input once on a ready static screen without waiting for another PTY edge', async () => {
    const { scope, quarantine, release } = harness();
    expect(release(quarantine, 'native completion', { redriveTerminal: true })).toBe(true);
    expect(scope.inputDeliveryQuarantine).toBeNull();
    expect(release(quarantine, 'duplicate completion', { redriveTerminal: true })).toBe(false);
    await Promise.resolve();
    expect(scope.flushPending).toHaveBeenCalledTimes(1);
    expect(scope.idleDetector.fireIdle).not.toHaveBeenCalled();
  });

  it('re-drives the queue and requests idle detection when the composer is not ready', async () => {
    // While the predecessor turn is still open its idle edge is fenced, so
    // fireIdle alone never flushes; type-ahead admission (gated inside
    // flushPending) must be re-driven directly (#2642).
    const { scope, quarantine, release } = harness();
    scope.isPromptReady = false;
    release(quarantine, 'native completion', { redriveTerminal: true });
    await Promise.resolve();
    expect(scope.flushPending).toHaveBeenCalledTimes(1);
    expect(scope.idleDetector.fireIdle).toHaveBeenCalledTimes(1);
  });

  it.each(['restart', 'backend', 'generation'] as const)('does not redrive across a %s change before the microtask', async change => {
    const { scope, quarantine, release } = harness();
    release(quarantine, 'native completion', { redriveTerminal: true });
    if (change === 'restart') scope.cliRestartInProgress = true;
    if (change === 'backend') scope.backend = {};
    if (change === 'generation') scope.cliSpawnGeneration++;
    await Promise.resolve();
    expect(scope.flushPending).not.toHaveBeenCalled();
    expect(scope.idleDetector.fireIdle).not.toHaveBeenCalled();
  });

  it('leaves a newer quarantine alone and does not redrive a plain release', async () => {
    const { scope, quarantine, release } = harness();
    expect(release({ ...quarantine }, 'stale receipt', { redriveTerminal: true })).toBe(false);
    expect(scope.inputDeliveryQuarantine).toBe(quarantine);
    expect(release(quarantine, 'plain receipt')).toBe(true);
    await Promise.resolve();
    expect(scope.flushPending).not.toHaveBeenCalled();
    expect(scope.idleDetector.fireIdle).not.toHaveBeenCalled();
  });
});
