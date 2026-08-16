import { describe, expect, it } from 'vitest';
import {
  beginRuntimeWriteCycle,
  isCliBackendGenerationCurrent,
  PtyOutputGeneration,
  projectRuntimeScreenStatus,
  snapshotWithLatestRuntimeStatus,
} from '../src/utils/runtime-screen-status.js';
import { CodexBridgeQueue } from '../src/services/codex-bridge-queue.js';
import { IdleDetector } from '../src/utils/idle-detector.js';
import type { CliAdapter } from '../src/adapters/cli/types.js';

function makeIdleAdapter(): CliAdapter {
  return {
    id: 'runtime-write-cycle-test',
    resolvedBin: '/bin/true',
    buildArgs: () => [],
    writeInput: async () => {},
    systemHints: [],
    altScreen: false,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => { resolve = res; });
  return { promise, resolve };
}

describe('projectRuntimeScreenStatus', () => {
  it('keeps an unfinished structured turn working even when a prompt is visible', () => {
    expect(projectRuntimeScreenStatus({
      promptReady: true,
      analyzing: false,
      structuredTurnBlocking: true,
    })).toBe('working');
  });

  it('returns idle only after lifecycle completion and prompt readiness agree', () => {
    expect(projectRuntimeScreenStatus({
      promptReady: true,
      analyzing: false,
      structuredTurnBlocking: false,
    })).toBe('idle');
  });

  it('preserves analyzing while a screen analyzer is active', () => {
    expect(projectRuntimeScreenStatus({
      promptReady: true,
      analyzing: true,
      structuredTurnBlocking: true,
    })).toBe('analyzing');
  });

  it('projects periodic status after an asynchronous snapshot, using a turn that started meanwhile', async () => {
    let structuredTurnBlocking = false;
    const capture = deferred<string>();
    const pending = snapshotWithLatestRuntimeStatus(
      () => capture.promise,
      () => projectRuntimeScreenStatus({
        promptReady: true,
        analyzing: false,
        structuredTurnBlocking,
      }),
    );

    // The tick began while idle, but the next turn starts before tmux/observe
    // capture resolves. The late update must read the new lifecycle state.
    structuredTurnBlocking = true;
    capture.resolve('captured screen');

    await expect(pending).resolves.toEqual({
      snapshot: 'captured screen',
      status: 'working',
    });
  });

  it('invalidates rejected-ready evidence for a second PTY chunk in the same millisecond', () => {
    const activity = new PtyOutputGeneration();
    const fixedTimestampMs = 123_456;
    let lastPtyOutputAtMs = fixedTimestampMs;

    activity.observe();
    const readyEvidence = activity.snapshot();
    expect(activity.isCurrent(readyEvidence)).toBe(true);

    // A second chunk can share the timestamp; the old equality check would
    // still trust the first prompt. Generation evidence must reject it.
    lastPtyOutputAtMs = fixedTimestampMs;
    activity.observe();
    expect(lastPtyOutputAtMs).toBe(fixedTimestampMs);
    expect(activity.isCurrent(readyEvidence)).toBe(false);
  });

  it('rejects a grace callback during the same-backend restart gap', () => {
    const sameBackend = { id: 'old-backend-object' };
    const fence = { generation: 7, backend: sameBackend };

    expect(isCliBackendGenerationCurrent(fence, {
      generation: 7,
      backend: sameBackend,
      restartInProgress: false,
    })).toBe(true);
    // restartCliProcess increments generation and raises the restart fence
    // before its jitter/async teardown replaces the backend object.
    expect(isCliBackendGenerationCurrent(fence, {
      generation: 8,
      backend: sameBackend,
      restartInProgress: true,
    })).toBe(false);
    expect(isCliBackendGenerationCurrent(fence, {
      generation: 7,
      backend: sameBackend,
      restartInProgress: true,
    })).toBe(false);
  });

  it('stays working when prompt-ready races ahead of in-flight submit verification', () => {
    const queue = new CodexBridgeQueue();
    queue.mark('race', 'prompt still polling history', 100);
    queue.beginSubmitVerification('race', 200);

    expect(projectRuntimeScreenStatus({
      promptReady: true,
      analyzing: false,
      structuredTurnBlocking: queue.hasBlockingTurn(201),
    })).toBe('working');

    queue.finishSubmitVerification('race');
    expect(projectRuntimeScreenStatus({
      promptReady: true,
      analyzing: false,
      structuredTurnBlocking: queue.hasBlockingTurn(202),
    })).toBe('idle');
  });

  it('re-arms before await so a final arriving during submit verification is retained', async () => {
    let promptReady = true;
    const detector = new IdleDetector(makeIdleAdapter());
    detector.onIdle(() => {
      // Mirrors markPromptReady's duplicate-ready guard.
      if (promptReady) return;
      promptReady = true;
    });

    // Model the previous turn's detector state: it already published idle.
    detector.fireIdle();
    const verification = deferred<'confirmed'>();
    beginRuntimeWriteCycle({
      setPromptReady: ready => { promptReady = ready; },
      resetIdleDetector: () => detector.reset(),
    });
    const writeResult = verification.promise;

    expect(promptReady).toBe(false);
    // The transcript closes before history polling resolves. Because reset
    // happened before the await, this edge is delivered instead of no-op'd.
    detector.fireIdle();
    expect(promptReady).toBe(true);

    verification.resolve('confirmed');
    await expect(writeResult).resolves.toBe('confirmed');
    // Await completion must not overwrite the final-driven ready state.
    expect(promptReady).toBe(true);
    detector.dispose();
  });

  it('re-arms every item when two type-ahead writes both finish before verification returns', async () => {
    let promptReady = true;
    let completedEdges = 0;
    const detector = new IdleDetector(makeIdleAdapter());
    detector.onIdle(() => {
      if (promptReady) return;
      promptReady = true;
      completedEdges++;
    });
    detector.fireIdle();

    for (const result of ['first', 'second'] as const) {
      const verification = deferred<typeof result>();
      beginRuntimeWriteCycle({
        setPromptReady: ready => { promptReady = ready; },
        resetIdleDetector: () => detector.reset(),
      });
      const writeResult = verification.promise;

      expect(promptReady).toBe(false);
      detector.fireIdle();
      expect(promptReady).toBe(true);
      verification.resolve(result);
      await expect(writeResult).resolves.toBe(result);
    }

    expect(completedEdges).toBe(2);
    detector.dispose();
  });
});
