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
import { CodexBridgeQueue } from '../src/services/codex-bridge-queue.js';

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

describe('TRAE native turn completion → transcript terminal evidence', () => {
  const nativeEvent = (kind: 'user' | 'assistant_final', turn: string, timestampMs: number, text = '') => ({
    kind, uuid: `${turn}:${kind}:${timestampMs}`, sourceTurnId: turn,
    sourceSessionId: 'session', timestampMs, text,
  });

  function traexIngest(queue: {
    peek: () => ReadonlyArray<{ started: boolean; finalText: string | undefined }>;
    ingest?: CodexBridgeQueue['ingest'];
  }, emit: () => void = () => {}) {
    const noteTerminal = vi.fn();
    const noteStarted = vi.fn();
    let drain: Array<ReturnType<typeof nativeEvent>> = [];
    const scope: Record<string, unknown> = {
      rpcTranscriptIngestBlockedByAwaitingActivation: () => false,
      rpcTurnsAwaitingActivation: new Map(),
      structuredBridgeIs: (id: string) => id === 'traex',
      codexBridgeRolloutPath: '/sessions/rollout.jsonl',
      codexBridgeBaselineDone: true,
      codexBridgePendingSessionId: undefined,
      structuredBridgeIngestPath: () => ({ events: drain, newOffset: 64, pendingTail: '' }),
      codexBridgeOffset: 0,
      codexBridgePendingTail: '',
      bridgeSpecFor: () => undefined,
      lastInitConfig: { cliId: 'traex' },
      publishActiveRuntime() {},
      publishedActiveRuntime: {},
      lastStructuredBridgeActivityAtMs: 0,
      backend: {},
      OrcaBackend: class {},
      codexBridgeQueue: {
        ingest(events: Parameters<CodexBridgeQueue['ingest']>[0]) { queue.ingest?.(events); },
        peek: () => queue.peek(),
      },
      observeStructuredBackgroundTasks() {},
      cliAdapter: { postTerminalPromptFence: false },
      noteSpawnArgvTurnStartTranscriptEvidence() {},
      pruneExpiredStructuredHeadsAndEmit() {},
      emitReadyCodexTurns: emit,
      idleDetector: { fireIdle: vi.fn(), noteTranscriptTerminal: noteTerminal, noteTranscriptTurnStarted: noteStarted },
      cliSpawnGeneration: 1,
      cliRestartInProgress: false,
    };
    scope.deferFinalIdleSignal = loadWorkerFunction('deferFinalIdleSignal', scope);
    const ingest = loadWorkerFunction<(opts?: { signalIdle?: boolean }) => void>('codexBridgeIngest', scope);
    return {
      feed(events: Array<ReturnType<typeof nativeEvent>>) { drain = events; ingest({ signalIdle: false }); },
      noteTerminal, noteStarted,
    };
  }

  it('records reversed finals when the last open queued turn settles, without another native turn', () => {
    const queue = new CodexBridgeQueue(() => 0);
    queue.mark('d1', 'first', 0);
    queue.mark('d2', 'second', 0);
    queue.mark('d3', 'third', 0);
    const run = traexIngest(queue, () => { queue.drainEmittable(); });
    run.feed([
      nativeEvent('user', 'turn-1', 1, 'first'),
      nativeEvent('user', 'turn-2', 2, 'second'),
      nativeEvent('user', 'turn-3', 3, 'third'),
    ]);
    run.feed([nativeEvent('assistant_final', 'turn-2', 4, 'answer-2')]);
    run.feed([nativeEvent('assistant_final', 'turn-3', 5, 'answer-3')]);
    expect(run.noteTerminal).not.toHaveBeenCalled();
    expect(queue.peek().map(turn => [turn.turnId, turn.finalText !== undefined])).toEqual([
      ['d1', false], ['d2', true], ['d3', true],
    ]);

    run.feed([nativeEvent('assistant_final', 'turn-1', 6, 'answer-1')]);
    expect(queue.peek()).toEqual([]);
    expect(run.noteTerminal).toHaveBeenCalledTimes(1);

    run.feed([]);
    expect(run.noteTerminal).toHaveBeenCalledTimes(1);
  });
});
