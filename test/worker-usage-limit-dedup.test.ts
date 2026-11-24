import { describe, expect, it, vi } from 'vitest';
import { createUsageLimitTracker } from '../src/utils/usage-limit-tracker.js';
import { usageLimitEvidenceKey, type CliUsageLimitState } from '../src/utils/cli-usage-limit.js';
import { snapshotWithLatestRuntimeStatus } from '../src/utils/runtime-screen-status.js';
import { ClaudeModelRequestClock } from '../src/services/claude-transcript.js';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';

const quota = '⚠ Individual quota reached. Resets in 5m.\n';

class FakeRenderer {
  snapshot() { return { content: quota, changed: false }; }
  rawSnapshot() { return quota; }
  dispose() {}
}
class FakePromptSuggestions {
  observe() {}
  take() { return undefined; }
}

describe('worker usage-limit frame identity', () => {
  it('deduplicates a relative countdown while its deadline is recomputed each tick', async () => {
    vi.useFakeTimers();
    const usageLimitTracker = createUsageLimitTracker({ isRateKindSuppressed: () => false, isOutputActive: () => false });
    const messages: Array<Record<string, any>> = [];
    const scope: Record<string, any> = {
      TerminalRenderer: FakeRenderer, PromptSuggestionPublisher: FakePromptSuggestions,
      renderCols: 80, renderRows: 24, screenUpdateTimer: undefined, SCREEN_UPDATE_INTERVAL_MS: 20,
      backend: {}, cliSpawnGeneration: 1, awaitingFirstPrompt: false, observedPaneGridRevision: 0,
      lastPtyActivityAtMs: 0, shouldCaptureScreen: () => true, isScreenSelfDriven: () => false,
      snapshotToText: async () => null, snapshotWithLatestRuntimeStatus, projectedRuntimeScreenStatus: () => 'idle',
      classifyUsageLimitWithNativeEvidence: (content: string, status: string) => usageLimitTracker.classify(content, status),
      usageLimitEvidenceKey,
      cliAdapter: { id: 'codex' }, lastInitConfig: { cliId: 'codex' }, lastAnalyzerSnapshot: '',
      traexQuestionBridgeActive: () => false, traexQuestionFlowVisible: () => false,
      observeTraexAutoModelCapacity: () => {}, publishNativeReasoningFooter: () => {},
      promptSuggestionReportTurn: () => undefined, settleBackgroundTasksFromSiblings: () => {},
      refreshBackgroundWait: () => {}, backgroundWaitTasks: 0, startupInputHeld: () => false,
      backgroundWaitPayload: () => ({}), modelRequestPayload: () => ({}), modelRequestClock: new ClaudeModelRequestClock(),
      currentBotmuxTurnId: 'turn-1', currentBotmuxDispatchAttempt: 1,
      send: (message: Record<string, unknown>) => messages.push(message), log: () => {},
    };
    try {
      const startScreenUpdates = loadWorkerFunction<() => void>('startScreenUpdates', scope);
      startScreenUpdates();
      await vi.advanceTimersByTimeAsync(115);
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({ type: 'screen_update', status: 'limited' });
    } finally {
      if (scope.screenUpdateTimer) clearInterval(scope.screenUpdateTimer);
      vi.useRealTimers();
    }
  });

  it('drops dynamic deadlines only when a stable episode owns the identity', () => {
    const base: CliUsageLimitState = {
      limited: true, kind: 'usage', retryAtMs: 100_000, retryLabel: '1m', retryReady: false,
      relativeResetKey: 'usage:60000:episode', source: 'antigravity-native-log', nativeEpisodeKey: 'log:episode',
    };
    expect(usageLimitEvidenceKey(base)).toBe(usageLimitEvidenceKey({ ...base, retryAtMs: 200_000 }));
    expect(usageLimitEvidenceKey(base)).not.toBe(usageLimitEvidenceKey({ ...base, retryReady: true }));

    const { relativeResetKey, nativeEpisodeKey, ...withoutEpisode } = base;
    expect(usageLimitEvidenceKey(withoutEpisode)).not.toBe(usageLimitEvidenceKey({ ...withoutEpisode, retryAtMs: 200_000 }));
  });
});
