import { describe, expect, it, vi } from 'vitest';
import { decideQueuedReadyTransition } from '../src/core/queued-ready-transition.js';
import { ActiveTurnAuthority } from '../src/core/active-turn-authority.js';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';

/**
 * A prompt-ready edge that the worker itself turns back into `working` is not
 * the turn's terminal boundary (#1723): the turn is quiet only while its
 * background agents run, or the argv-baked first prompt is still executing.
 * Releasing the turn's authority there revokes the live origin the still
 * running work reports through, so its `botmux report` is refused as stale.
 */
function harness(opts: {
  backgroundAgents?: number;
  argvPromptBusy?: boolean;
  pendingMessages?: unknown[];
  queuedTypeAheadTurns?: unknown[];
} = {}) {
  const caller = { requestUserOpenId: 'owner', requestLarkAppId: 'app', senderType: 'user' as const };
  const authority = new ActiveTurnAuthority();
  authority.reserve({ turnId: 'turn-a', caller });
  authority.markStarted({ turnId: 'turn-a', caller });
  const scope: Record<string, any> = {
    isPromptReady: false, isFlushing: false, durableTurnInFlight: false,
    preserveActiveTurnAuthorityForReady: false,
    lastInitConfig: { cliId: 'claude-code' }, effectiveBackendType: 'tmux',
    activeTurnAuthority: authority,
    releaseActiveTurnAuthority: vi.fn(() => authority.clear()),
    pendingMessages: opts.pendingMessages ?? [], pendingRawInputs: [], pendingAdoptMessages: [], pendingSessionRename: null,
    pendingInjections: [],
    queuedTurnAdvanceConsumedForPrompt: undefined,
    ptyOutputGeneration: { snapshot: () => 1 }, queuedTypeAheadTurns: opts.queuedTypeAheadTurns ?? [], promptReadyEdges: 0,
    decideQueuedReadyTransition,
    inflightInputs: { onTurnComplete: vi.fn() },
    backgroundTaskTracker: { pendingTurnAgents: () => opts.backgroundAgents ?? 0 },
    spawnArgvInitialPromptBusy: opts.argvPromptBusy === true,
    spawnArgvNeedsWorkingSeed: false,
    renderer: { snapshot: () => ({ content: '' }) },
    idleDetector: { isStartupPending: () => false, adoptPromptReady: vi.fn(), reset: vi.fn() },
    freshnessInputQueue: { onPromptReady: vi.fn() },
    isCodexAppCliId: () => false,
    hasStructuredLifecycleBlock: () => false,
    releaseInterruptedStructuredBridgeOnFirstPrompt: () => {},
    bridgeQueue: { cliQueueDrained: () => {} },
    currentCodexObservedPid: () => {},
    currentInputDeliveryQuarantine: () => false,
    holdForNativeSessionFork: () => false,
    probeStartupBlocker: () => false,
    readyGate: { shouldHold: () => false },
    publishScreenStatus: vi.fn(),
    classifyUsageLimitWithNativeEvidence: () => ({}),
    projectedRuntimeScreenStatus: () => 'idle',
    backgroundWaitPayload: () => ({}),
    flushPending: vi.fn(),
    log: vi.fn(),
  };
  for (const name of ['traexFirstPromptViewportRejects', 'currentPostTerminalInputFence',
    'spawnArgvTurnStartGateHolds', 'syncQueuedTurnsFromMarkerDisk', 'shouldFlushInjectionsFirst']) scope[name] = () => false;
  for (const name of ['stopStructuredStartGraceRecheck', 'stopBusyPatternIdleProbe',
    'judgeClaudeBridgeTurn', 'settleSessionRenameOnPrompt', 'releaseRawInputRestartGate',
    'maybeEmitWorkflowTranscriptOutput', 'send', 'refreshBackgroundWait', 'settleRestartAttemptOnReady',
    'advanceQueuedTypeAheadTurn']) scope[name] = vi.fn();
  return scope;
}

describe('a prompt-ready edge that is not the turn boundary keeps the turn authority', () => {
  it('keeps it while background agents of the turn are still running', () => {
    const h = harness({ backgroundAgents: 1 });
    loadWorkerFunction('markPromptReady', h)();
    expect(h.isPromptReady).toBe(false);
    expect(h.publishScreenStatus).toHaveBeenCalledWith('working');
    expect(h.releaseActiveTurnAuthority).not.toHaveBeenCalled();
    expect(h.activeTurnAuthority.snapshot()?.turnId).toBe('turn-a');
  });

  it('keeps it while the argv-baked first prompt is still running', () => {
    const h = harness({ argvPromptBusy: true });
    loadWorkerFunction('markPromptReady', h)();
    expect(h.isPromptReady).toBe(false);
    expect(h.releaseActiveTurnAuthority).not.toHaveBeenCalled();
    expect(h.activeTurnAuthority.snapshot()?.turnId).toBe('turn-a');
  });

  it.each([
    ['a queued message', { pendingMessages: [{ content: 'next' }] }],
    ['a queued type-ahead turn', { queuedTypeAheadTurns: [{ turnId: 'turn-b' }] }],
  ])('still releases it when the ready hands the CLI to %s', (_label, queued) => {
    const h = harness({ backgroundAgents: 1, ...queued });
    loadWorkerFunction('markPromptReady', h)();
    expect(h.releaseActiveTurnAuthority).toHaveBeenCalledWith('prompt_ready');
  });

  it('still releases it at a real end-of-turn ready', () => {
    const h = harness();
    loadWorkerFunction('markPromptReady', h)();
    expect(h.isPromptReady).toBe(true);
    expect(h.publishScreenStatus).toHaveBeenCalledWith('idle');
    expect(h.releaseActiveTurnAuthority).toHaveBeenCalledWith('prompt_ready');
    expect(h.activeTurnAuthority.snapshot()).toBeUndefined();
  });
});
