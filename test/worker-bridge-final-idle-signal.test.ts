/**
 * A structured bridge drain that consumes a turn's final must leave an idle
 * signal behind, whichever caller ran it.
 *
 * The watcher/poller drains with the signal on. A flush's post-terminal fence
 * check (and an interrupt drain) drain with it off, so a final they happen to
 * consume used to vanish without one: a prompt-ready edge rejected while that
 * turn was open was then never re-driven on a static composer, and the input
 * queued behind it stayed stranded (#3479).
 */
import { describe, expect, it, vi } from 'vitest';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';

function bridge(events: Array<{ kind: string }>) {
  const fireIdle = vi.fn();
  const backend = {};
  const scope: Record<string, unknown> = {
    rpcTranscriptIngestBlockedByAwaitingActivation: () => false,
    rpcTurnsAwaitingActivation: new Map(),
    structuredBridgeIs: (id: string) => id === 'traex',
    codexBridgeRolloutPath: '/sessions/rollout.jsonl',
    codexBridgeBaselineDone: true,
    codexBridgePendingSessionId: undefined,
    structuredBridgeIngestPath: () => ({ events, newOffset: 64, pendingTail: '' }),
    codexBridgeOffset: 0,
    codexBridgePendingTail: '',
    bridgeSpecFor: () => undefined,
    lastInitConfig: { cliId: 'traex' },
    publishActiveRuntime() {},
    publishedActiveRuntime: {},
    lastStructuredBridgeActivityAtMs: 0,
    backend,
    OrcaBackend: class {},
    codexBridgeQueue: { ingest() {}, peek: () => [] },
    observeStructuredBackgroundTasks() {},
    cliAdapter: { postTerminalPromptFence: true },
    armPostTerminalInputFence() {},
    noteSpawnArgvTurnStartTranscriptEvidence() {},
    pruneExpiredStructuredHeadsAndEmit() {},
    emitReadyCodexTurns() {},
    idleDetector: { fireIdle },
    cliSpawnGeneration: 1,
    cliRestartInProgress: false,
  };
  scope.deferFinalIdleSignal = loadWorkerFunction('deferFinalIdleSignal', scope);
  const ingest = loadWorkerFunction<(opts?: { signalIdle?: boolean }) => void>('codexBridgeIngest', scope);
  return { scope, ingest, fireIdle };
}

const nextTick = () => new Promise<void>(resolve => setImmediate(resolve));
const FINAL = [{ kind: 'assistant_final' }];

describe('structured bridge final → idle signal', () => {
  it('signals idle at once when the watcher or poller consumes the final', () => {
    const run = bridge(FINAL);
    run.ingest();
    expect(run.fireIdle).toHaveBeenCalledTimes(1);
  });

  it('still owes the signal when a non-signalling drain consumes the final', async () => {
    const run = bridge(FINAL);
    run.ingest({ signalIdle: false });
    // Never inside the caller's own critical section (the flush that drained).
    expect(run.fireIdle).not.toHaveBeenCalled();
    await nextTick();
    expect(run.fireIdle).toHaveBeenCalledTimes(1);
  });

  it('drops the owed signal once the CLI that wrote the final is gone', async () => {
    for (const change of [
      (scope: Record<string, unknown>) => { scope.cliSpawnGeneration = 2; },
      (scope: Record<string, unknown>) => { scope.cliRestartInProgress = true; },
      (scope: Record<string, unknown>) => { scope.backend = {}; },
    ]) {
      const run = bridge(FINAL);
      run.ingest({ signalIdle: false });
      change(run.scope);
      await nextTick();
      expect(run.fireIdle).not.toHaveBeenCalled();
    }
  });

  it('owes nothing for a drain without a final', async () => {
    const run = bridge([{ kind: 'user_message' }]);
    run.ingest({ signalIdle: false });
    run.ingest();
    await nextTick();
    expect(run.fireIdle).not.toHaveBeenCalled();
  });
});
