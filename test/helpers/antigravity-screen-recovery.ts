import { vi } from 'vitest';
import { loadWorkerFunction } from './worker-function-harness.js';
import { PromptSuggestionPublisher } from '../../src/utils/prompt-suggestion-publisher.js';
import { ClaudeModelRequestClock } from '../../src/services/claude-transcript.js';
import { createUsageLimitTracker } from '../../src/utils/usage-limit-tracker.js';
import { reconcileUsageLimitState, detectCliUsageLimit, cliUsageLimitEpisodeKey, usageLimitEvidenceKey } from '../../src/utils/cli-usage-limit.js';
import { stripAnsiScreenText } from '../../src/utils/idle-detector.js';
import { ANTIGRAVITY_QUOTA_HISTORY_LIMIT, annotateAntigravityUsageLimit, isAntigravityWorkingScreen,
  isAntigravityReadyComposerScreen, rememberAntigravityQuota } from '../../src/adapters/cli/antigravity.js';
import type { WorkerToDaemon } from '../../src/types.js';

/** Real timer, classifier and capture/upload function; only terminal/network
 * boundaries are fake. Consumers can route every emitted frame to the real
 * daemon handler and SQLite, rather than hand-authoring recovery IPC. */
export function antigravityScreenProducer(send: (frame: WorkerToDaemon) => void) {
  let native = '';
  let display = 'unchanged filtered snapshot';
  let failCapture = false;
  const capture = vi.fn(() => { if (failCapture) throw new Error('capture unavailable'); return native; });
  const scope: Record<string, any> = {
    renderCols: 80, renderRows: 24, backend: {}, cliSpawnGeneration: 1,
    TerminalRenderer: class { rawSnapshot() { return display; } },
    awaitingFirstPrompt: false, lastInitConfig: { cliId: 'antigravity' }, cliAdapter: { id: 'antigravity' },
    observedPaneGridRevision: 0, lastPtyActivityAtMs: 0, lastAnalyzerSnapshot: '',
    shouldCaptureScreen: () => true, isScreenSelfDriven: () => false,
    snapshotToText: async (_backend: unknown, _cols: number, _rows: number, opts: { filter: boolean }) =>
      ({ content: opts.filter ? display : native, ansi: display, cols: 80, rows: 24 }),
    snapshotToPng: async () => ({ content: display, ansi: display, cols: 80, rows: 24, png: Buffer.from('image') }),
    projectedRuntimeScreenStatus: () => 'idle',
    traexQuestionBridgeActive: () => false, observeTraexAutoModelCapacity() {}, publishNativeReasoningFooter() {},
    settleBackgroundTasksFromSiblings() {}, refreshBackgroundWait() {}, startupInputHeld: () => false,
    backgroundWaitTasks: 0, backgroundWaitPayload: () => ({}), modelRequestPayload: () => ({}), modelRequestClock: new ClaudeModelRequestClock(), PromptSuggestionPublisher,
    currentBotmuxTurnId: undefined, currentBotmuxDispatchAttempt: undefined, foldedTypeAheadTurn: undefined,
    turnTerminalEmitted: false, promptSuggestionReportTurn: () => undefined,
    SCREEN_UPDATE_INTERVAL_MS: 100, backendScreenEvidenceIsAuthoritativeForMutation: () => true,
    captureBackendScreen: capture, stripAnsiScreenText, isAntigravityWorkingScreen, isAntigravityReadyComposerScreen,
    readAntigravityNativeQuota: () => undefined,
    withAntigravityDirectFailureProof: (limit: any) => limit, detectCliUsageLimit, cliUsageLimitEpisodeKey, usageLimitEvidenceKey,
    annotateAntigravityUsageLimit, usageLimitTracker: createUsageLimitTracker({ isRateKindSuppressed: () => false, isOutputActive: () => false }),
    reconcileUsageLimitState, rememberAntigravityQuota, antigravityQuotaHistory: undefined,
    unconfirmedAntigravityQuotas: new Map(), ANTIGRAVITY_QUOTA_HISTORY_LIMIT,
    displayMode: 'screenshot', captureRevision: 0, screenshotDisplayGeneration: 0,
    apiOnlyForUpload: false, larkAppIdForUpload: 'app', larkAppSecretForUpload: 'secret',
    screenshotCaptureInFlight: false, lastShotHash: '', lastUploadLogAtMs: 0,
    uploadImageBuffer: vi.fn(async () => 'image-key'),
    send, log() {}, logError(error: string) { throw new Error(error); }, logScreenshotSkip() {},
  };
  scope.snapshotWithLatestRuntimeStatus = loadWorkerFunction('snapshotWithLatestRuntimeStatus', scope);
  scope.classifyUsageLimitWithNativeEvidence = loadWorkerFunction('classifyUsageLimitWithNativeEvidence', scope);
  scope.classifyScreenUsageLimit = loadWorkerFunction('classifyScreenUsageLimit', scope);
  return {
    scope, capture,
    start: loadWorkerFunction<() => void>('startScreenUpdates', scope),
    screenshot: loadWorkerFunction<() => Promise<void>>('captureAndUpload', scope),
    screen(text: string, captureFails = false, displayText = display) { native = text; failCapture = captureFails; display = displayText; },
  };
}
