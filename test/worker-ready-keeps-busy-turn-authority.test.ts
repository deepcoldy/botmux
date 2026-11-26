import { afterEach, describe, expect, it, vi } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decideQueuedReadyTransition } from '../src/core/queued-ready-transition.js';
import { ClaudeModelRequestClock } from '../src/services/claude-transcript.js';
import { ActiveTurnAuthority } from '../src/core/active-turn-authority.js';
import { isAntigravityInterruptedScreen, parseAntigravityFooterBackgroundTasks } from '../src/adapters/cli/antigravity.js';
import {
  hasAntigravityPendingTasks,
  hasAntigravityTranscriptPendingTasks,
  resolveAntigravityTranscriptPath,
  type AntigravityTranscriptState,
} from '../src/services/antigravity-transcript.js';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';

/**
 * A prompt-ready edge that the worker itself turns back into `working` is not
 * the turn's terminal boundary (#1723): the turn is quiet only while its
 * background agents/tasks run, or the argv-baked first prompt is still executing.
 * Releasing the turn's authority there revokes the live origin the still
 * running work reports through, so its `botmux report` is refused as stale.
 */
function harness(opts: {
  cliId?: string;
  backgroundAgents?: number;
  antigravityState?: AntigravityTranscriptState;
  onAntigravityDrain?: (state: AntigravityTranscriptState) => void;
  argvPromptBusy?: boolean;
  pendingMessages?: unknown[];
  queuedTypeAheadTurns?: unknown[];
} = {}) {
  const caller = { requestUserOpenId: 'owner', requestLarkAppId: 'app', senderType: 'user' as const };
  const authority = new ActiveTurnAuthority();
  authority.reserve({ turnId: 'turn-a', caller });
  authority.markStarted({ turnId: 'turn-a', caller });
  const cliId = opts.cliId ?? 'claude-code';
  const agyState: AntigravityTranscriptState = { ...(opts.antigravityState ?? {}) };
  const codexBridgeDrainAndMaybeEmit = vi.fn(() => {
    opts.onAntigravityDrain?.(agyState);
  });
  const scope: Record<string, any> = {
    isPromptReady: false, isFlushing: false, durableTurnInFlight: false,
    preserveActiveTurnAuthorityForReady: false,
    lastInitConfig: { cliId }, effectiveBackendType: 'tmux',
    activeTurnAuthority: authority,
    releaseActiveTurnAuthority: vi.fn(() => authority.clear()),
    pendingMessages: opts.pendingMessages ?? [], pendingRawInputs: [], pendingAdoptMessages: [], pendingSessionRename: null,
    pendingInjections: [],
    queuedTurnAdvanceConsumedForPrompt: undefined,
    ptyOutputGeneration: { snapshot: () => 1 }, queuedTypeAheadTurns: opts.queuedTypeAheadTurns ?? [], promptReadyEdges: 0,
    decideQueuedReadyTransition,
    inflightInputs: { onTurnComplete: vi.fn() },
    backgroundTaskTracker: { pendingTurnAgents: () => opts.backgroundAgents ?? 0 },
    structuredBridgeIs: (id: string) => cliId === id,
    antigravityBridgeState: () => agyState,
    hasAntigravityPendingTasks,
    codexBridgeDrainAndMaybeEmit,
    revokePromptReadiness: () => { scope.isPromptReady = false; },
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
    backgroundWaitPayload: () => ({}), modelRequestPayload: () => ({}), modelRequestClock: new ClaudeModelRequestClock(),
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

  it('keeps it while an Antigravity background command is still pending (including when newly drained on ready)', () => {
    const h = harness({
      cliId: 'antigravity',
      onAntigravityDrain: (state) => { state.hasPendingTask = true; },
    });
    loadWorkerFunction('markPromptReady', h)();
    expect(h.codexBridgeDrainAndMaybeEmit).toHaveBeenCalledWith({ signalIdle: false });
    expect(h.isPromptReady).toBe(false);
    expect(h.publishScreenStatus).toHaveBeenCalledWith('working');
    expect(h.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'screen_update' }));
    expect(h.releaseActiveTurnAuthority).not.toHaveBeenCalled();
    expect(h.activeTurnAuthority.snapshot()?.turnId).toBe('turn-a');
  });

  it('keeps it while an Antigravity subagent is still pending', () => {
    const h = harness({
      cliId: 'antigravity',
      antigravityState: { pendingSubagentIds: ['conv-sub-1'] },
    });
    loadWorkerFunction('markPromptReady', h)();
    expect(h.isPromptReady).toBe(false);
    expect(h.publishScreenStatus).toHaveBeenCalledWith('working');
    expect(h.releaseActiveTurnAuthority).not.toHaveBeenCalled();
    expect(h.activeTurnAuthority.snapshot()?.turnId).toBe('turn-a');
  });

  it.each([
    ['a queued message', { pendingMessages: [{ content: 'next' }] }],
    ['a queued type-ahead turn', { queuedTypeAheadTurns: [{ turnId: 'turn-b' }] }],
  ])('still releases Antigravity authority when the ready hands the CLI to %s', (_label, queued) => {
    const h = harness({
      cliId: 'antigravity',
      antigravityState: { hasPendingTask: true },
      ...queued,
    });
    loadWorkerFunction('markPromptReady', h)();
    expect(h.releaseActiveTurnAuthority).toHaveBeenCalledWith('prompt_ready');
  });

  it('releases Antigravity authority once pending tasks and subagents have cleared', () => {
    const h = harness({
      cliId: 'antigravity',
      antigravityState: { hasPendingTask: false, pendingSubagentIds: [] },
    });
    loadWorkerFunction('markPromptReady', h)();
    expect(h.isPromptReady).toBe(true);
    expect(h.publishScreenStatus).toHaveBeenCalledWith('idle');
    expect(h.releaseActiveTurnAuthority).toHaveBeenCalledWith('prompt_ready');
    expect(h.activeTurnAuthority.snapshot()).toBeUndefined();
  });
});

describe('hasLiveAntigravityPendingTasks across send mode and adopt/zero-prompt bridge mode', () => {
  const idleFooter = '────────\n>\n────────\n? for shortcuts';
  const pendingFooter = `${idleFooter} · gemini-4-neon · 1 task(s) · /tasks`;
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function sendModeHarness(opts: {
    records: any[];
    awaitingFirstPrompt?: boolean;
    turnStarted?: boolean;
    screen?: string;
    bridgeActive?: boolean;
    bridgeAttached?: boolean;
  }) {
    const fakeHome = mkdtempSync(join(tmpdir(), 'bmx-agy-send-authority-'));
    dirs.push(fakeHome);
    const cid = '22222222-2222-2222-2222-222222222222';
    const logsDir = join(fakeHome, '.gemini', 'antigravity-cli', 'brain', cid, '.system_generated', 'logs');
    mkdirSync(logsDir, { recursive: true });
    const transcriptPath = join(logsDir, 'transcript.jsonl');
    writeFileSync(transcriptPath, opts.records.map(r => JSON.stringify(r)).join('\n') + '\n');

    const h = harness({ cliId: 'antigravity' });
    if (opts.turnStarted === false) {
      h.activeTurnAuthority.clear();
    }
    h.lastInitConfig = { cliId: 'antigravity', workingDir: fakeHome, env: { HOME: fakeHome } };
    h.lastSpawnEffectiveCliSessionId = cid;
    h.awaitingFirstPrompt = opts.awaitingFirstPrompt ?? false;
    h.clearPostHookEvidenceFallback = vi.fn();
    h.deliverRestartInterruptionNote = vi.fn();
    h.requeuedInflightAtSpawn = 0;
    h.renderer = { snapshot: () => ({ content: '' }), markNewTurn: vi.fn() };
    h.inflightInputs = { onTurnComplete: vi.fn(), takeStartedCarryOver: () => [] };
    h.cliAdapter = {
      id: 'antigravity',
      runnerFramedInput: false,
      resolveActiveSessionId: () => cid,
    };
    h.backend = opts.screen !== undefined ? {} : undefined;
    h.backendScreenEvidenceIsAuthoritativeForMutation = () => opts.screen !== undefined;
    h.captureBackendScreen = () => opts.screen ?? '';
    h.isAntigravityInterruptedScreen = isAntigravityInterruptedScreen;
    h.parseAntigravityFooterBackgroundTasks = parseAntigravityFooterBackgroundTasks;
    h.codexBridgeFallbackActive = () => opts.bridgeActive === true;
    h.codexBridgeRolloutPath = opts.bridgeAttached ? transcriptPath : undefined;
    h.codexBridgeBaselineDone = opts.bridgeAttached === true;
    h.currentAntigravityObservedPid = () => undefined;
    h.findAntigravityConversationIdByPid = () => undefined;
    h.resolveAntigravityTranscriptPath = resolveAntigravityTranscriptPath;
    h.resolveFileBridgePath = () => undefined;
    h.hasAntigravityTranscriptPendingTasks = hasAntigravityTranscriptPendingTasks;
    h.join = join;
    h.resolveLiveAntigravityTranscriptPath = loadWorkerFunction('resolveLiveAntigravityTranscriptPath', h);
    h.hasLiveAntigravityPendingTasks = loadWorkerFunction('hasLiveAntigravityPendingTasks', h);
    return { h, cid, transcriptPath };
  }

  it('keeps the card working when only the live footer shows a running task, then settles when it clears', () => {
    const { h } = sendModeHarness({
      screen: pendingFooter,
      records: [
        { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', content: 'Run the tests' },
        { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: 'Waiting for the tests.' },
      ],
    });
    const markReady = loadWorkerFunction('markPromptReady', h);
    markReady();

    expect(h.publishScreenStatus).toHaveBeenCalledWith('working');
    expect(h.publishScreenStatus).not.toHaveBeenCalledWith('idle');
    expect(h.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'screen_update', status: 'idle' }));
    expect(h.releaseActiveTurnAuthority).not.toHaveBeenCalled();
    expect(h.activeTurnAuthority.snapshot()?.turnId).toBe('turn-a');

    h.captureBackendScreen = () => idleFooter;
    markReady();

    expect(h.publishScreenStatus).toHaveBeenCalledWith('idle');
    expect(h.releaseActiveTurnAuthority).toHaveBeenCalledWith('prompt_ready');
  });

  it('keeps active turn authority when a background run_command is still running even though the structured bridge is inactive', () => {
    const cid = '22222222-2222-2222-2222-222222222222';
    const { h, transcriptPath } = sendModeHarness({
      records: [
        { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', content: '<USER_REQUEST>\n升级环境\n</USER_REQUEST>' },
        { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [{ name: 'run_command', args: { CommandLine: '"bytedcli env service upgrade-tce"' } }] },
        { step_index: 2, source: 'MODEL', type: 'GENERIC', status: 'RUNNING', content: `Created At: 2026-11-23T03:15:07Z\nTool is running as a background task with task id: ${cid}/task-178\n` },
        { step_index: 3, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: '等待 BOE 与 PPE 升级工单下发返回结果。' },
      ],
    });

    loadWorkerFunction('markPromptReady', h)();
    expect(h.codexBridgeDrainAndMaybeEmit).not.toHaveBeenCalled();
    expect(h.isPromptReady).toBe(false);
    expect(h.publishScreenStatus).toHaveBeenCalledWith('working');
    expect(h.releaseActiveTurnAuthority).not.toHaveBeenCalled();
    expect(h.activeTurnAuthority.snapshot()?.turnId).toBe('turn-a');

    // Once the background task completes and the planner finishes, the next prompt-ready releases authority.
    appendFileSync(transcriptPath, [
      JSON.stringify({
        step_index: 4, source: 'SYSTEM', type: 'SYSTEM_MESSAGE', status: 'DONE',
        content: `<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-23T03:15:50Z sender=${cid}/task-178 priority=MESSAGE_PRIORITY_HIGH content=Task id "${cid}/task-178" finished with result: code 0\n</SYSTEM_MESSAGE>`,
      }),
      JSON.stringify({ step_index: 5, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: '升级全部完成。' }),
    ].join('\n') + '\n');

    loadWorkerFunction('markPromptReady', h)();
    expect(h.isPromptReady).toBe(true);
    expect(h.publishScreenStatus).toHaveBeenCalledWith('idle');
    expect(h.releaseActiveTurnAuthority).toHaveBeenCalledWith('prompt_ready');
    expect(h.activeTurnAuthority.snapshot()).toBeUndefined();
  });

  it('does not hold a cold/resumed idle startup with no started turn even if the old transcript has a dangling RUNNING task', () => {
    const cid = '22222222-2222-2222-2222-222222222222';
    const { h } = sendModeHarness({
      awaitingFirstPrompt: true,
      turnStarted: false,
      screen: pendingFooter,
      records: [
        { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', content: '<USER_REQUEST>\n旧会话任务\n</USER_REQUEST>' },
        { step_index: 1, source: 'MODEL', type: 'GENERIC', status: 'RUNNING', content: `Tool is running as a background task with task id: ${cid}/task-old\n` },
      ],
    });

    loadWorkerFunction('markPromptReady', h)();
    expect(h.isPromptReady).toBe(true);
    expect(h.publishScreenStatus).toHaveBeenCalledWith('idle');
  });

  it('does not hold a later idle edge with no started turn when an old transcript still has RUNNING', () => {
    const cid = '22222222-2222-2222-2222-222222222222';
    const { h } = sendModeHarness({
      awaitingFirstPrompt: false,
      turnStarted: false,
      records: [
        { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', content: '<USER_REQUEST>\n旧会话任务\n</USER_REQUEST>' },
        { step_index: 1, source: 'MODEL', type: 'GENERIC', status: 'RUNNING', content: `Tool is running as a background task with task id: ${cid}/task-old\n` },
      ],
    });

    loadWorkerFunction('markPromptReady', h)();
    expect(h.isPromptReady).toBe(true);
    expect(h.publishScreenStatus).toHaveBeenCalledWith('idle');
    expect(h.publishScreenStatus).not.toHaveBeenCalledWith('working');
  });

  it('releases authority when the authoritative viewport explicitly shows an interrupted turn', () => {
    const cid = '22222222-2222-2222-2222-222222222222';
    const interruptedScreen = [
      '● Bash(bytedcli env service upgrade-tce)',
      '  ⎿  Interrupted · What should Antigravity CLI do instead?',
      '────────',
      '>',
      '────────',
      '? for shortcuts · gemini-4-neon · 1 task(s) · /tasks',
      '',
    ].join('\n');
    const { h } = sendModeHarness({
      screen: interruptedScreen,
      records: [
        { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', content: '<USER_REQUEST>\n升级环境\n</USER_REQUEST>' },
        { step_index: 1, source: 'MODEL', type: 'GENERIC', status: 'RUNNING', content: `Tool is running as a background task with task id: ${cid}/task-178\n` },
        { step_index: 2, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: '等待中' },
      ],
    });

    loadWorkerFunction('markPromptReady', h)();
    expect(h.isPromptReady).toBe(true);
    expect(h.releaseActiveTurnAuthority).toHaveBeenCalledWith('prompt_ready');
    expect(h.activeTurnAuthority.snapshot()).toBeUndefined();
  });

  it('never lets a footer task count veto the ready edge in adopt/zero-prompt bridge mode without a botmux-started turn', () => {
    const { h } = sendModeHarness({
      screen: pendingFooter,
      bridgeActive: true,
      bridgeAttached: true,
      turnStarted: false,
      records: [
        { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', content: 'human turn before attach' },
        { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: 'settled before the bridge attached' },
      ],
    });

    // In adopt/zero-prompt the baselined bridge owns turn boundaries. The live
    // footer's task count belongs to no botmux-started turn, so it must not hold
    // this edge; only the bridge/transcript path may decide.
    expect(h.hasLiveAntigravityPendingTasks()).toBe(false);

    loadWorkerFunction('markPromptReady', h)();
    expect(h.isPromptReady).toBe(true);
    expect(h.publishScreenStatus).toHaveBeenCalledWith('idle');
    expect(h.releaseActiveTurnAuthority).toHaveBeenCalledWith('prompt_ready');
  });
});
