import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';
import { createUsageLimitTracker } from '../src/utils/usage-limit-tracker.js';
import { ClaudeModelRequestClock } from '../src/services/claude-transcript.js';
import { reconcileUsageLimitState, detectCliUsageLimit, cliUsageLimitEpisodeKey, usageLimitEvidenceKey, type CliUsageLimitState } from '../src/utils/cli-usage-limit.js';
import { stripAnsiScreenText } from '../src/utils/idle-detector.js';
import { snapshotWithLatestRuntimeStatus } from '../src/utils/runtime-screen-status.js';
import {
  ANTIGRAVITY_QUOTA_HISTORY_LIMIT,
  annotateAntigravityUsageLimit,
  isAntigravityReadyComposerScreen,
  isAntigravityWorkingScreen,
  rememberAntigravityQuota,
} from '../src/adapters/cli/antigravity.js';

const nativeError = '⚠ Individual quota reached. Resets in 124h24m15s.\nError ID: old\n────\n>\n────\n';
// Old agy omitted the footer on the error page and added it back on recovery.
// The native log remains on disk; that alone must not turn recovery into a new
// quota episode.
const recovered = nativeError + '? for shortcuts';

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('Antigravity recovery delivery through the real screen sampler', () => {
  it('sends a recovery edge after a degraded idle frame, then deduplicates it', async () => {
    vi.useFakeTimers();
    let captures = 0;
    const captureBackendScreen = () => {
      captures += 1;
      if (captures === 1) return nativeError;
      if (captures === 2) throw new Error('transient native capture failure');
      return recovered;
    };
    const usageLimitTracker = createUsageLimitTracker({ isRateKindSuppressed: () => false, isOutputActive: () => false });
    const classify = loadWorkerFunction<(content: string, status: 'idle') => any>('classifyUsageLimitWithNativeEvidence', {
      cliAdapter: { id: 'antigravity' }, backend: {}, captureBackendScreen,
      backendScreenEvidenceIsAuthoritativeForMutation: () => true,
      stripAnsiScreenText, isAntigravityWorkingScreen, isAntigravityReadyComposerScreen, annotateAntigravityUsageLimit,
      readAntigravityNativeQuota: () => ({ key: 'native-old', text: nativeError }),
      withAntigravityDirectFailureProof: (limit: CliUsageLimitState) => limit, detectCliUsageLimit, cliUsageLimitEpisodeKey,
      usageLimitTracker, reconcileUsageLimitState, rememberAntigravityQuota, antigravityQuotaHistory: undefined,
      lastConfirmedAntigravityQuota: undefined,
      recoveredAntigravityQuotaKey: undefined,
      unconfirmedAntigravityQuotas: new Map(), ANTIGRAVITY_QUOTA_HISTORY_LIMIT,
    });
    let snapshotReads = 0;
    class FakeRenderer {
      snapshot() { snapshotReads += 1; return { content: 'display without quota text', changed: snapshotReads <= 2 }; }
      rawSnapshot() { return recovered; }
      dispose() {}
    }
    class FakePromptSuggestions { observe() {} take() { return undefined; } }
    const messages: Array<Record<string, unknown>> = [];
    const startScreenUpdates = loadWorkerFunction<() => void>('startScreenUpdates', {
      TerminalRenderer: FakeRenderer, PromptSuggestionPublisher: FakePromptSuggestions,
      renderCols: 80, renderRows: 24, screenUpdateTimer: undefined, SCREEN_UPDATE_INTERVAL_MS: 100,
      backend: {}, cliSpawnGeneration: 1, awaitingFirstPrompt: false, observedPaneGridRevision: 0,
      lastPtyActivityAtMs: 0, shouldCaptureScreen: () => true, isScreenSelfDriven: () => false,
      snapshotToText: async () => null, snapshotWithLatestRuntimeStatus, projectedRuntimeScreenStatus: () => 'idle',
      classifyUsageLimitWithNativeEvidence: classify, cliAdapter: { id: 'antigravity' }, usageLimitEvidenceKey,
      lastInitConfig: { cliId: 'antigravity' }, lastAnalyzerSnapshot: '',
      traexQuestionBridgeActive: () => false, traexQuestionFlowVisible: () => false,
      observeTraexAutoModelCapacity: () => {}, publishNativeReasoningFooter: () => {},
      promptSuggestionReportTurn: () => undefined, settleBackgroundTasksFromSiblings: () => {},
      refreshBackgroundWait: () => {}, backgroundWaitTasks: 0, startupInputHeld: () => false,
      backgroundWaitPayload: () => ({}), modelRequestPayload: () => ({}), modelRequestClock: new ClaudeModelRequestClock(), currentBotmuxTurnId: undefined, currentBotmuxDispatchAttempt: undefined, webTerminalInputGeneration: 0,
      send: (message: Record<string, unknown>) => messages.push(message), log: () => {},
    });

    startScreenUpdates();
    await vi.advanceTimersByTimeAsync(100);
    expect(messages).toEqual([expect.objectContaining({ status: 'limited' })]);
    await vi.advanceTimersByTimeAsync(100);
    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({ status: 'idle' });
    expect(messages[1]?.usageLimitRecovery).toBeUndefined();

    await vi.advanceTimersByTimeAsync(100);
    expect(messages).toHaveLength(3);
    expect(messages[2]).toMatchObject({ status: 'idle', usageLimitRecovery: 'antigravity-ready-composer' });

    await vi.advanceTimersByTimeAsync(400);
    expect(messages).toHaveLength(3);
  });

  it('sends late and revoked direct-failure proof through unchanged text frames', async () => {
    vi.useFakeTimers();
    const usageLimit: CliUsageLimitState = {
      limited: true, kind: 'usage', retryAtMs: Date.now() + 60_000, retryLabel: '1m', retryReady: false,
      relativeResetKey: 'usage:60000:proof', nativeEpisodeKey: 'log:proof', source: 'antigravity-native-log',
    };
    let usageAware: Record<string, unknown> = { status: 'limited', usageLimit };
    class FakeRenderer {
      snapshot() { return { content: 'same-native-text', changed: false }; }
      rawSnapshot() { return 'same-native-text'; }
      dispose() {}
    }
    class FakePromptSuggestions { observe() {} take() { return undefined; } }
    const messages: Array<Record<string, any>> = [];
    const startScreenUpdates = loadWorkerFunction<() => void>('startScreenUpdates', {
      TerminalRenderer: FakeRenderer, PromptSuggestionPublisher: FakePromptSuggestions,
      renderCols: 80, renderRows: 24, screenUpdateTimer: undefined, SCREEN_UPDATE_INTERVAL_MS: 100,
      backend: {}, cliSpawnGeneration: 1, awaitingFirstPrompt: false, observedPaneGridRevision: 0,
      lastPtyActivityAtMs: 0, shouldCaptureScreen: () => true, isScreenSelfDriven: () => false,
      snapshotToText: async () => null, snapshotWithLatestRuntimeStatus, projectedRuntimeScreenStatus: () => 'idle',
      classifyUsageLimitWithNativeEvidence: () => usageAware, cliAdapter: { id: 'antigravity' }, usageLimitEvidenceKey,
      lastInitConfig: { cliId: 'antigravity' }, lastAnalyzerSnapshot: '',
      traexQuestionBridgeActive: () => false, traexQuestionFlowVisible: () => false,
      observeTraexAutoModelCapacity: () => {}, publishNativeReasoningFooter: () => {},
      promptSuggestionReportTurn: () => undefined, settleBackgroundTasksFromSiblings: () => {},
      refreshBackgroundWait: () => {}, backgroundWaitTasks: 0, startupInputHeld: () => false,
      backgroundWaitPayload: () => ({}), modelRequestPayload: () => ({}), modelRequestClock: new ClaudeModelRequestClock(),
      currentBotmuxTurnId: 'turn-proof', currentBotmuxDispatchAttempt: 1, webTerminalInputGeneration: 0,
      send: (message: Record<string, unknown>) => messages.push(message), log: () => {},
    });

    startScreenUpdates();
    await vi.advanceTimersByTimeAsync(100);
    expect(messages).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(messages).toHaveLength(1);

    usageAware = { status: 'limited', usageLimit: { ...usageLimit, directFailure: true as const } };
    await vi.advanceTimersByTimeAsync(100);
    expect(messages).toHaveLength(2);
    expect(messages[1]?.usageLimit.directFailure).toBe(true);
    await vi.advanceTimersByTimeAsync(100);
    expect(messages).toHaveLength(2);

    usageAware = { status: 'limited', usageLimit };
    await vi.advanceTimersByTimeAsync(100);
    expect(messages).toHaveLength(3);
    expect(messages[2]?.usageLimit.directFailure).toBeUndefined();
  });

  it('deduplicates a stable non-agy limit while its wall-clock deadline is recomputed', async () => {
    vi.useFakeTimers();
    let retryReady = false;
    class FakeRenderer {
      snapshot() { return { content: 'same-generic-limit', changed: false }; }
      rawSnapshot() { return 'same-generic-limit'; }
      dispose() {}
    }
    class FakePromptSuggestions { observe() {} take() { return undefined; } }
    const messages: Array<Record<string, any>> = [];
    const startScreenUpdates = loadWorkerFunction<() => void>('startScreenUpdates', {
      TerminalRenderer: FakeRenderer, PromptSuggestionPublisher: FakePromptSuggestions,
      renderCols: 80, renderRows: 24, screenUpdateTimer: undefined, SCREEN_UPDATE_INTERVAL_MS: 20,
      backend: {}, cliSpawnGeneration: 1, awaitingFirstPrompt: false, observedPaneGridRevision: 0,
      lastPtyActivityAtMs: 0, shouldCaptureScreen: () => true, isScreenSelfDriven: () => false,
      snapshotToText: async () => null, snapshotWithLatestRuntimeStatus, projectedRuntimeScreenStatus: () => 'idle',
      classifyUsageLimitWithNativeEvidence: () => ({
        status: 'limited',
        usageLimit: {
          limited: true, kind: 'usage', retryAtMs: Date.now() + 60_000,
          retryLabel: '1m', retryReady, relativeResetKey: 'usage:stable-generic-limit',
        },
      }),
      cliAdapter: { id: 'traex' }, usageLimitEvidenceKey, lastInitConfig: { cliId: 'traex' }, lastAnalyzerSnapshot: '',
      traexQuestionBridgeActive: () => false, traexQuestionFlowVisible: () => false,
      observeTraexAutoModelCapacity: () => {}, publishNativeReasoningFooter: () => {},
      promptSuggestionReportTurn: () => undefined, settleBackgroundTasksFromSiblings: () => {},
      refreshBackgroundWait: () => {}, backgroundWaitTasks: 0, startupInputHeld: () => false,
      backgroundWaitPayload: () => ({}), modelRequestPayload: () => ({}), modelRequestClock: new ClaudeModelRequestClock(),
      currentBotmuxTurnId: 'turn-generic', currentBotmuxDispatchAttempt: 1, webTerminalInputGeneration: 0,
      send: (message: Record<string, unknown>) => messages.push(message), log: () => {},
    });

    startScreenUpdates();
    await vi.advanceTimersByTimeAsync(20);
    expect(messages).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(messages).toHaveLength(1);

    retryReady = true;
    await vi.advanceTimersByTimeAsync(20);
    expect(messages).toHaveLength(2);
    expect(messages[1]?.usageLimit.retryReady).toBe(true);
    await vi.advanceTimersByTimeAsync(40);
    expect(messages).toHaveLength(2);
  });
});
