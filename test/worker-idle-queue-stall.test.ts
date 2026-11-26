import { admitScheduledInput } from '../src/core/scheduled-input-admission.js';
import { describe, expect, it, vi } from 'vitest';
import { decideQueuedReadyTransition } from '../src/core/queued-ready-transition.js';
import { ActiveTurnAuthority } from '../src/core/active-turn-authority.js';
import { pendingInputAllowsTypeAhead, pendingInputMayFlush, promoteInteractiveInputPastSchedules } from '../src/utils/pending-input-queue.js';
import { programStatusBlockHoldsTypeAhead } from '../src/core/program-status-gate.js';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';
import { AsyncSerialQueue } from '../src/utils/async-serial-queue.js';
import { runAdoptQueuedWriteSequence } from '../src/services/adopt-input-sequence.js';

function harness(cliId = 'codex') {
  const caller = { requestUserOpenId: 'owner', requestLarkAppId: 'app', senderType: 'user' as const };
  const authority = new ActiveTurnAuthority();
  authority.reserve({ turnId: 'old-attribution', caller });
  authority.markStarted({ turnId: 'old-attribution', caller });
  const scope: Record<string, any> = {
    isPromptReady: true, isFlushing: false, durableTurnInFlight: false,
    preserveActiveTurnAuthorityForReady: false,
    lastInitConfig: { cliId }, effectiveBackendType: 'tmux',
    activeTurnAuthority: authority,
    pendingMessages: [
      { turnId: 'schedule:tick', content: 'scheduled work', queueAfterActiveTurn: true, trustedCaller: { ...caller, source: 'schedule_creator' } },
      { turnId: 'human-question', content: 'question', trustedCaller: caller },
    ],
    pendingRawInputs: [], pendingAdoptMessages: [], pendingSessionRename: null,
    pendingInjections: [], commandLineWritesPending: 0,
    isCodexAppCliId: (id: string) => id === 'codex-app',
    isRemoteBackendType: (id: string) => ['riff', 'mojo', 'remote-runner'].includes(id),
    hasStructuredLifecycleBlock: () => false,
    directRpcTurnBlocksTypeAhead: () => false,
    bridgeHeadTurnAwaitingTerminal: () => false,
    crossPrincipalIsolationOn: () => false,
    releaseActiveTurnAuthority: vi.fn(() => authority.clear()),
    codexModelMigrationCheckNeeded: () => false,
    idleDetector: { isStartupPending: () => false },
    shouldHoldCodexRunnerInput: () => false,
    backend: {}, cliAdapter: {},
    currentInputDeliveryQuarantine: () => false,
    nativeSessionForkPending: () => false,
    holdForNativeSessionFork: () => false,
    releaseInterruptedStructuredBridgeOnFirstPrompt: () => {},
    bridgeQueue: { cliQueueDrained: () => {} },
    currentCodexObservedPid: () => {},
    hasPendingInputForFlush: () => scope.pendingMessages.length > 0,
    resetTraexAutoModelBeforePendingTurn: () => false,
    sessionRenameInFlight: () => false,
    shouldDeferUserFlush: () => false,
    refreshHookReviewInputHold: () => {},
    hookReviewHoldsQueuedWrite: () => false,
    pendingInputMayFlush, pendingInputAllowsTypeAhead, promoteInteractiveInputPastSchedules, programStatusBlockHoldsTypeAhead,

    rpcLifecycleFailClosedOwners: new Set(),
    probeStartupBlocker: () => false,
    readyGate: { shouldHold: () => false },
    codexBridgeFallbackActive: () => false,
    runtimePtyInputPolicy: () => ({ supportsTypeAhead: true, allowBackToBackWrites: true }),
    CodexAppFlushPromptReplay: class { consumeAfterFlush() { return false; } },
    bareShellChecked: true,
    firstWriteMayProceed: () => true,
    hasRunStartupCommands: true,
    traexAutoModelRuntimeEligible: () => false,
    beginCliWriteCycle: vi.fn(() => { scope.isPromptReady = false; }),
    log: vi.fn(),
  };
  scope.turnAuthorityIdentity = loadWorkerFunction('turnAuthorityIdentity', scope);
  scope.activeTurnBlocks = loadWorkerFunction('activeTurnBlocks', scope);
  scope.programStatusBlockedHoldsTypeAhead = loadWorkerFunction('programStatusBlockedHoldsTypeAhead', scope);
  scope.promotePendingHumanInterruption = loadWorkerFunction('promotePendingHumanInterruption', scope);
  scope.flushPending = loadWorkerFunction('flushPending', scope);
  return scope;
}

describe('scheduled queue heads do not swallow human input', () => {
  it.each(['codex', 'claude-code'])('admits the controlling human past a blocked %s schedule, retaining authority and schedule', async cli => {
    const h = harness(cli);
    const oldAuthority = h.activeTurnAuthority.snapshot();
    const schedule = h.pendingMessages[0];
    const human = h.pendingMessages[1];
    // Halt at the real dequeue boundary. Selection is production code; this
    // fake boundary records exactly one next item, without executing a CLI.
    h.freshnessInputQueue = { takeNormal: vi.fn(() => {
      expect(h.pendingMessages[0]).toBe(human);
      h.pendingMessages.shift();
      return undefined;
    }) };
    await h.flushPending();
    expect(h.freshnessInputQueue.takeNormal).toHaveBeenCalledOnce();
    expect(h.pendingMessages).toEqual([schedule]);
    expect(h.activeTurnAuthority.snapshot()).toEqual(oldAuthority);
  });

  // These pin the end-to-end "no reorder, no dequeue" behaviour. The
  // durable/quarantined/startup cases return at flushPending's own earlier
  // gates (pendingInputMayFlush / currentInputDeliveryQuarantine /
  // isStartupPending), before the promotion call is reached — they do not
  // exercise the duplicate guards inside promotePendingHumanInterruption.
  it.each([
    ['durable in flight', { durableTurnInFlight: true }],
    ['RPC active', { directRpcTurnBlocksTypeAhead: () => true }],
    ['remote backend', { effectiveBackendType: 'remote-runner' }],
    ['Codex App', { lastInitConfig: { cliId: 'codex-app' } }],
    ['non-typeahead CLI', { runtimePtyInputPolicy: () => ({ supportsTypeAhead: false }) }],
    ['delivery quarantined', { currentInputDeliveryQuarantine: () => true }],
    ['startup pending', { idleDetector: { isStartupPending: () => true } }],
  ])('does not reorder or dequeue behind %s', async (_name, overrides) => {
    const h = harness(); Object.assign(h, overrides);
    const before = [...h.pendingMessages];
    h.freshnessInputQueue = { takeNormal: vi.fn() };
    await h.flushPending();
    expect(h.pendingMessages).toEqual(before);
    expect(h.freshnessInputQueue.takeNormal).not.toHaveBeenCalled();
    expect(h.activeTurnAuthority.snapshot()?.turnId).toBe('old-attribution');
  });

  it('lets an owner interrupt even while the preserved predecessor-ready attribution is live', async () => {
    const h = harness();
    // isPromptReady can refer to A while the identity already names B. The
    // fix must retain B and use authenticated steer, not manufacture a terminal.
    h.hasStructuredLifecycleBlock = () => true;
    h.bridgeHeadTurnAwaitingTerminal = () => true;
    h.isPromptReady = false;
    h.freshnessInputQueue = { takeNormal: vi.fn(() => { h.pendingMessages.shift(); return undefined; }) };
    await h.flushPending();
    expect(h.freshnessInputQueue.takeNormal).toHaveBeenCalledOnce();
    expect(h.pendingMessages.map((x: any) => x.turnId)).toEqual(['schedule:tick']);
    expect(h.activeTurnAuthority.snapshot()?.turnId).toBe('old-attribution');
    expect(h.releaseActiveTurnAuthority).not.toHaveBeenCalled();
  });

  it('retains marker-promoted B through the real predecessor-ready transition and the next user drain', async () => {
    const h = harness();
    const pending = h.pendingMessages;
    Object.assign(h, {
      isPromptReady: false, pendingMessages: [],
      queuedTurnAdvanceConsumedForPrompt: { outputGeneration: 5, promotedTurnId: 'old-attribution' },
      ptyOutputGeneration: { snapshot: () => 5 }, queuedTypeAheadTurns: [], promptReadyEdges: 0,
      decideQueuedReadyTransition, inflightInputs: { onTurnComplete: vi.fn() },
      backgroundTaskTracker: { pendingTurnAgents: () => 0 },
    });
    h.freshnessInputQueue = { onPromptReady: vi.fn() };
    h.idleDetector.adoptPromptReady = vi.fn();
    for (const name of ['traexFirstPromptViewportRejects', 'currentPostTerminalInputFence',
      'spawnArgvTurnStartGateHolds', 'syncQueuedTurnsFromMarkerDisk', 'shouldFlushInjectionsFirst']) h[name] = () => false;
    for (const name of ['stopStructuredStartGraceRecheck', 'stopBusyPatternIdleProbe',
      'judgeClaudeBridgeTurn', 'settleSessionRenameOnPrompt', 'releaseRawInputRestartGate',
      'maybeEmitWorkflowTranscriptOutput', 'send', 'refreshBackgroundWait', 'settleRestartAttemptOnReady']) h[name] = vi.fn();
    const flush = h.flushPending;
    h.flushPending = vi.fn();
    loadWorkerFunction('markPromptReady', h)();
    expect(h.isPromptReady).toBe(true);
    expect(h.activeTurnAuthority.snapshot()?.turnId).toBe('old-attribution');
    h.pendingMessages = pending;
    h.flushPending = flush;
    h.freshnessInputQueue = { takeNormal: vi.fn(() => { h.pendingMessages.shift(); return undefined; }) };
    await h.flushPending();
    expect(h.freshnessInputQueue.takeNormal).toHaveBeenCalledOnce();
    expect(h.pendingMessages.map((x: any) => x.turnId)).toEqual(['schedule:tick']);
    expect(h.activeTurnAuthority.snapshot()?.turnId).toBe('old-attribution');
    expect(h.releaseActiveTurnAuthority).not.toHaveBeenCalled();
  });

  it('allows the authenticated task controller to interrupt a bot while retaining its authority', async () => {
    const h = harness(); const owner = h.pendingMessages[1].trustedCaller;
    h.activeTurnAuthority.clear();
    const active = { turnId: 'bot-work', caller: { ...owner, senderType: 'bot', requestUserOpenId: 'bot' }, controller: owner };
    h.activeTurnAuthority.reserve(active); h.activeTurnAuthority.markStarted(active);
    h.freshnessInputQueue = { takeNormal: vi.fn(() => { h.pendingMessages.shift(); return undefined; }) };
    await h.flushPending();
    expect(h.freshnessInputQueue.takeNormal).toHaveBeenCalledOnce();
    expect(h.activeTurnAuthority.snapshot()?.turnId).toBe('bot-work');
    expect(h.pendingMessages.map((x: any) => x.turnId)).toEqual(['schedule:tick']);
  });

  it('never lets an unrelated human bypass authority even with the ordinary isolation gate disabled', async () => {
    const h = harness();
    h.pendingMessages[1].trustedCaller = { requestUserOpenId: 'stranger', requestLarkAppId: 'app', senderType: 'user' };
    const before = [...h.pendingMessages];
    h.freshnessInputQueue = { takeNormal: vi.fn() };
    await h.flushPending();
    expect(h.pendingMessages).toEqual(before);
    expect(h.freshnessInputQueue.takeNormal).not.toHaveBeenCalled();
  });

  it('types nothing ahead while the CLI reports an approval block; a question block drains like no block', async () => {
    // The live owner's message sits behind a scheduled head the active turn
    // blocks, so flushPending would type it ahead into the running turn. An
    // approval dialog on screen would take that text and its Enter as the
    // answer; a question is answered by exactly that message.
    const run = async (block: { kind?: string } | null) => {
      const h = harness();
      h.isPromptReady = false; // the turn that raised the dialog is running
      h.cliAdapter = { programStatusBlockedHoldsInput: true };
      h.idleDetector = { isStartupPending: () => false, programStatusBlock: () => block };
      h.freshnessInputQueue = { takeNormal: vi.fn(() => { h.pendingMessages.shift(); return undefined; }) };
      await h.flushPending();
      return { taken: h.freshnessInputQueue.takeNormal.mock.calls.length, writes: h.beginCliWriteCycle.mock.calls.length };
    };
    const unblocked = await run(null);
    expect(unblocked.taken).toBeGreaterThan(0);
    expect(await run({ kind: 'permission' })).toEqual({ taken: 0, writes: 0 });
    expect(await run({})).toEqual({ taken: 0, writes: 0 });
    expect(await run({ kind: 'question' })).toEqual(unblocked);
  });

  it('drains the schedule first in FIFO order when no active turn blocks the head (CLI idle)', async () => {
    const h = harness();
    // No active turn means the head is not blocked, so the head gate must keep
    // promotion from firing even though a human waits behind a schedule: the
    // fix only reorders past a head that an active task genuinely blocks.
    h.activeTurnAuthority.clear();
    const human = h.pendingMessages[1];
    h.freshnessInputQueue = { takeNormal: vi.fn(() => { h.pendingMessages.shift(); return undefined; }) };
    await h.flushPending();
    expect(h.freshnessInputQueue.takeNormal).toHaveBeenCalledOnce();
    expect(h.pendingMessages).toEqual([human]);
  });

  it('does not re-kick flush from the finally clause when the drain wrote nothing', async () => {
    const h = harness();
    // The write loop dequeues nothing (a freshness hold) but, while that
    // iteration runs, a blocked schedule prefix and an authorized human
    // arrive, so promotion becomes possible exactly at the finally boundary.
    // The itemsWrittenInThisFlush > 0 condition must suppress the microtask
    // re-kick: removing it re-drives flushPending, which really promotes the
    // human and enters the write loop a second time.
    const schedule = { ...h.pendingMessages[0]! };
    const human = { ...h.pendingMessages[1]! };
    h.pendingMessages = [{ ...human, turnId: 'human-at-entry' }];
    let seeded = false;
    h.freshnessInputQueue = { takeNormal: vi.fn(() => {
      if (!seeded) {
        seeded = true;
        h.pendingMessages.shift();
        h.pendingMessages.push(schedule, human);
      }
      return undefined;
    }) };
    await h.flushPending();
    await Promise.resolve();
    expect(h.freshnessInputQueue.takeNormal).toHaveBeenCalledOnce();
    expect(h.pendingMessages.map((x: any) => x.turnId)).toEqual(['schedule:tick', 'human-question']);
  });
});

describe('interactive selection preserves queue boundaries', () => {
  it('moves only the first human across a schedule prefix and keeps all other relative order', () => {
    const h = harness();
    const [s1, u1] = h.pendingMessages;
    const s2 = { ...s1, turnId: 'schedule:second' };
    const u2 = { ...u1, turnId: 'human-second' };
    const pending = [s1, s2, u1, u2];
    expect(promoteInteractiveInputPastSchedules(pending, () => true)).toBe(true);
    expect(pending).toEqual([u1, s1, s2, u2]);
    expect(promoteInteractiveInputPastSchedules(pending, () => true)).toBe(false);
  });

  it.each([
    { dispatchAttempt: 2 }, { durablePrimaryInbox: true }, { queuedActivationToken: 'receipt' },
    { vcMeetingImTurnOrigin: {} }, { taskContinuation: {} }, { noReplay: true },
    { trustedCaller: { source: undefined } },
  ])('does not cross a protected queue head: %j', flags => {
    const h = harness(); Object.assign(h.pendingMessages[0], flags);
    const before = [...h.pendingMessages];
    expect(promoteInteractiveInputPastSchedules(h.pendingMessages, () => true)).toBe(false);
    expect(h.pendingMessages).toEqual(before);
  });

  it.each([
    { dispatchAttempt: 1 }, { durablePrimaryInbox: true }, { codexAppDispatchId: 'dispatch' },
    { queuedActivationToken: 'receipt' }, { vcMeetingImTurnOrigin: {} },
    { taskContinuation: {} }, { noReplay: true }, { traexAutoModelRecovery: true },
    { queueAfterActiveTurn: true },
    { trustedCaller: { senderType: 'bot' } },
    { trustedCaller: { senderType: 'user', source: 'failed_turn_recovery' } },
    { trustedCaller: { senderType: 'user', source: 'schedule_creator' } },
  ])('does not promote non-interactive or serial input: %j', flags => {
    const h = harness(); Object.assign(h.pendingMessages[1], flags);
    const before = [...h.pendingMessages];
    expect(promoteInteractiveInputPastSchedules(h.pendingMessages, () => true)).toBe(false);
    expect(h.pendingMessages).toEqual(before);
  });

  it('does not skip an unauthorized first human to reach an authorized later human', () => {
    const h = harness();
    h.pendingMessages.push({ ...h.pendingMessages[1], turnId: 'later-owner' });
    const before = [...h.pendingMessages];
    expect(promoteInteractiveInputPastSchedules(h.pendingMessages, input => input.turnId === 'later-owner')).toBe(false);
    expect(h.pendingMessages).toEqual(before);
  });
});


describe('adopt refork initial continuation waits for the actual pane', () => {
  it.each(['codex', 'claude-code'])('does not treat a reserved %s init turn as an idle pane', async cli => {
    const h = harness(cli);
    const trustedCaller = {
      requestUserOpenId: 'ou_reply_bot', requestLarkAppId: 'app', senderType: 'bot' as const,
      taskContinuation: {
        appId: 'app', openId: 'ou_source', sourceSessionId: 'source', sourceTurnId: 'om_source',
      },
    };
    // Adopt init reserves B in the replacement worker even while the external
    // pane is still running A. Authority matches B, but is not readiness proof.
    const item = { content: 'continuation B', turnId: 'om_reply_b', trustedCaller };
    h.activeTurnAuthority.clear();
    expect(h.activeTurnAuthority.reserve({ turnId: item.turnId, caller: trustedCaller })).toBe(true);
    h.lastInitConfig = { cliId: cli, adoptMode: true };
    h.pendingMessages = [item];
    h.isPromptReady = false;
    h.freshnessInputQueue = { takeNormal: vi.fn(() => {
      h.pendingMessages.shift();
      return undefined;
    }) };
    expect(h.activeTurnBlocks(item)).toBe(false);

    await h.flushPending();
    expect(h.freshnessInputQueue.takeNormal).not.toHaveBeenCalled();
    expect(h.beginCliWriteCycle).not.toHaveBeenCalled();
    expect(h.pendingMessages).toEqual([item]);

    // The same item remains recoverable and drains once the real pane is idle.
    h.isPromptReady = true;
    await h.flushPending();
    expect(h.freshnessInputQueue.takeNormal).toHaveBeenCalledOnce();
    expect(h.pendingMessages).toEqual([]);
  });
});

describe('scheduled admission at the real worker drain', () => {
  const turnId = 'schedule:a1b2c3d4:12345678-1234-1234-1234-123456789abc';
  const scheduled = () => ({ turnId, content: 'latest complete envelope', queueAfterActiveTurn: true as const,
    scheduledRun: { taskId: 'a1b2c3d4', runId: 'run-1', turnId, trigger: 'scheduler' as const } });
  function ready() {
    const h = harness(); h.activeTurnAuthority.clear(); h.pendingMessages = [scheduled()];
    h.send = vi.fn(); h.freshnessInputQueue = { takeNormal: vi.fn(() => { h.pendingMessages.shift(); return undefined; }) };
    return h;
  }

  it.each(['done', 'paused', 'revoked', 'superseded'])('never dequeues a queued schedule when host reports %s', async state => {
    const h = ready(); const task: any = { id: 'a1b2c3d4', lastRunId: 'run-1', enabled: true };
    if (state === 'done') task.untilDone = { status: 'done' };
    if (state === 'paused') { task.enabled = false; task.disabledReason = 'manual'; }
    if (state === 'superseded') task.lastRunId = 'run-2';
    h.requestScheduledInputAdmission = vi.fn(async () => admitScheduledInput(
      { scheduledRun: scheduled().scheduledRun } as any, 'app', turnId, () => state === 'revoked' ? undefined : task));
    await h.flushPending();
    expect(h.freshnessInputQueue.takeNormal).not.toHaveBeenCalled();
    expect(h.pendingMessages).toEqual([]);
    expect(h.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'turn_input_rejected', turnId }));
  });

  it('rechecks after busy becomes idle and retains ordinary input after a rejected automatic input', async () => {
    const h = ready(); h.isPromptReady = false;
    h.requestScheduledInputAdmission = vi.fn(async () => 'reject');
    await h.flushPending(); expect(h.requestScheduledInputAdmission).not.toHaveBeenCalled();
    const human = { turnId: 'om_human', content: 'continue ordinary work' };
    h.pendingMessages.push(human); h.isPromptReady = true;
    await h.flushPending();
    expect(h.requestScheduledInputAdmission).toHaveBeenCalledOnce();
    expect(h.freshnessInputQueue.takeNormal).toHaveBeenCalledOnce();
    expect(h.pendingMessages).toEqual([]);
  });

  it('does not dequeue while an asynchronous host decision is pending', async () => {
    const h = ready(); const task: any = { id: 'a1b2c3d4', lastRunId: 'run-1', enabled: true };
    let reply!: () => void;
    h.requestScheduledInputAdmission = () => new Promise(resolve => {
      reply = () => resolve(admitScheduledInput({ scheduledRun: scheduled().scheduledRun } as any, 'app', turnId, () => task));
    });
    const flush = h.flushPending(); await Promise.resolve();
    expect(h.freshnessInputQueue.takeNormal).not.toHaveBeenCalled();
    task.enabled = false; task.disabledReason = 'manual'; reply(); await flush;
    expect(h.freshnessInputQueue.takeNormal).not.toHaveBeenCalled();
  });

  it.each(['backend', 'generation', 'head', 'web epoch'])('refuses a stale allowed ACK after %s changes during admission', async change => {
    const h = ready(); const original = h.pendingMessages[0];
    h.requestScheduledInputAdmission = vi.fn(async () => {
      if (change === 'backend') h.backend = {};
      if (change === 'generation') h.cliSpawnGeneration = 2;
      if (change === 'head' && h.requestScheduledInputAdmission.mock.calls.length === 1) h.pendingMessages[0] = { ...original, content: 'replacement head' };
      if (change === 'web epoch') h.webTerminalInputGeneration = 1;
      return change === 'head' && h.requestScheduledInputAdmission.mock.calls.length > 1 ? 'retain' : 'allow';
    });
    await h.flushPending();
    expect(h.freshnessInputQueue.takeNormal).not.toHaveBeenCalled();
    expect(h.pendingMessages).toHaveLength(1);
    expect(h.isPromptReady).toBe(true);
  });

  it('retains the exact head when host authority is unavailable', async () => {
    const h = ready(); h.requestScheduledInputAdmission = async () => 'retain';
    const before = [...h.pendingMessages]; await h.flushPending();
    expect(h.pendingMessages).toEqual(before);
    expect(h.freshnessInputQueue.takeNormal).not.toHaveBeenCalled();
    expect(h.isPromptReady).toBe(true);
  });

  it('retries a retained admission on a generation-fenced timer without an external ready edge', async () => {
    vi.useFakeTimers();
    try {
      const h = ready();
      h.requestScheduledInputAdmission = vi.fn()
        .mockResolvedValueOnce('retain').mockResolvedValueOnce('allow');
      await h.flushPending();
      expect(h.requestScheduledInputAdmission).toHaveBeenCalledOnce();
      expect(h.pendingMessages).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(h.requestScheduledInputAdmission).toHaveBeenCalledTimes(2);
      expect(h.freshnessInputQueue.takeNormal).toHaveBeenCalledOnce();
      expect(h.pendingMessages).toEqual([]);
    } finally { vi.useRealTimers(); }
  });

  it('does not drain an automatic backlog while a confirmed quota limit remains active', async () => {
    const h = ready(); h.usageLimitTracker = { currentTurn: () => 4, detectedThisTurn: () => true };
    h.requestScheduledInputAdmission = vi.fn(async () => 'allow');
    for (let n = 0; n < 3; n++) { h.isPromptReady = true; await h.flushPending(); }
    expect(h.requestScheduledInputAdmission).not.toHaveBeenCalled();
    expect(h.freshnessInputQueue.takeNormal).not.toHaveBeenCalled();
    expect(h.pendingMessages).toHaveLength(1);
    h.pendingMessages[0].scheduledRun.trigger = 'dashboard';
    await h.flushPending(); expect(h.freshnessInputQueue.takeNormal).toHaveBeenCalledOnce();
  });

  it.each([true, false])('lets an authorized human past the quota-held automatic head (typeAhead=%s)', async supportsTypeAhead => {
    const h = ready();
    const human = { turnId: 'om_human', content: 'urgent question', trustedCaller: {
      requestUserOpenId: 'owner', requestLarkAppId: 'app', senderType: 'user' as const,
    } };
    h.pendingMessages.push(human);
    h.usageLimitTracker = { currentTurn: () => 4, detectedThisTurn: () => true };
    h.runtimePtyInputPolicy = () => ({ supportsTypeAhead, allowBackToBackWrites: true });
    h.requestScheduledInputAdmission = vi.fn(async () => 'allow');
    await h.flushPending();
    expect(h.freshnessInputQueue.takeNormal).toHaveBeenCalledOnce();
    expect(h.pendingMessages.map((x: any) => x.turnId)).toEqual([turnId]);
    expect(h.requestScheduledInputAdmission).not.toHaveBeenCalled();
  });

  it.each([
    ['ownerless automatic input without a serial marker', 'tmux', false],
    ['idle remote-runner', 'remote-runner', true],
  ])('lets an authorized human past a quota-held %s', async (_name, backendType, serial) => {
    const h = ready();
    if (!serial) delete h.pendingMessages[0].queueAfterActiveTurn;
    h.effectiveBackendType = backendType;
    h.pendingMessages.push({ turnId: 'om_human', content: 'urgent question', trustedCaller: {
      requestUserOpenId: 'owner', requestLarkAppId: 'app', senderType: 'user' as const,
    } });
    h.usageLimitTracker = { currentTurn: () => 4, detectedThisTurn: () => true };
    h.runtimePtyInputPolicy = () => ({ supportsTypeAhead: false, allowBackToBackWrites: true });
    await h.flushPending();
    expect(h.freshnessInputQueue.takeNormal).toHaveBeenCalledOnce();
    expect(h.pendingMessages.map((x: any) => x.turnId)).toEqual([turnId]);
  });

  it('STOP clears the associated automatic backlog while ordinary, manual and other-task inputs stay usable', async () => {
    const h = ready(); h.currentBotmuxTurnId = turnId;
    const manual = { ...scheduled(), turnId: 'schedule:a1b2c3d4:aaaaaaaa-1234-1234-1234-123456789abc',
      scheduledRun: { ...scheduled().scheduledRun, turnId: 'schedule:a1b2c3d4:aaaaaaaa-1234-1234-1234-123456789abc', trigger: 'dashboard' } };
    const other = { ...scheduled(), turnId: 'schedule:bbbbbbbb:12345678-1234-1234-1234-123456789abc',
      scheduledRun: { ...scheduled().scheduledRun, taskId: 'bbbbbbbb', turnId: 'schedule:bbbbbbbb:12345678-1234-1234-1234-123456789abc' } };
    const human = { turnId: 'om_human', content: 'ordinary' };
    const unknownManual = { ...scheduled(), turnId: 'schedule:a1b2c3d4:bbbbbbbb-1234-1234-1234-123456789abc',
      scheduledRun: { ...scheduled().scheduledRun, turnId: 'schedule:a1b2c3d4:bbbbbbbb-1234-1234-1234-123456789abc', trigger: undefined } };
    h.pendingMessages.push(human, manual, other, unknownManual);
    h.effectiveBackendType = 'remote-runner'; // exits after the real stop queue cleanup; never drives a real terminal
    await loadWorkerFunction<any>('handleTermAction', h)('ctrlc');
    expect(h.pendingMessages).toEqual([human, manual, other, unknownManual]);
    h.effectiveBackendType = 'tmux'; h.isPromptReady = true;
    await h.flushPending(); expect(h.freshnessInputQueue.takeNormal).toHaveBeenCalledOnce();
    expect(h.pendingMessages).toEqual([manual, other, unknownManual]);
  });

  it('STOP discards ordinary recovery but preserves an independent dashboard manual run', async () => {
    const h = ready(); h.currentBotmuxTurnId = turnId;
    const recoveryTurn = 'schedule:a1b2c3d4:aaaaaaaa-1234-1234-1234-123456789abc';
    const recovery = { ...scheduled(), turnId: recoveryTurn,
      scheduledRun: { ...scheduled().scheduledRun, turnId: recoveryTurn, trigger: 'dashboard' as const, recoveryOfTurnId: turnId } };
    const manualTurn = 'schedule:a1b2c3d4:bbbbbbbb-1234-1234-1234-123456789abc';
    const manual = { ...scheduled(), turnId: manualTurn,
      scheduledRun: { ...scheduled().scheduledRun, turnId: manualTurn, trigger: 'dashboard' as const } };
    h.pendingMessages.push(recovery, manual);
    h.effectiveBackendType = 'remote-runner';
    await loadWorkerFunction<any>('handleTermAction', h)('ctrlc');
    expect(h.pendingMessages).toEqual([manual]);
  });

  it('STOP during a human turn preserves every scheduled task backlog', async () => {
    const h = ready(); h.currentBotmuxTurnId = 'om_active_human';
    const other = { ...scheduled(), turnId: 'schedule:bbbbbbbb:12345678-1234-1234-1234-123456789abc',
      scheduledRun: { ...scheduled().scheduledRun, taskId: 'bbbbbbbb', turnId: 'schedule:bbbbbbbb:12345678-1234-1234-1234-123456789abc' } };
    const human = { turnId: 'om_next_human', content: 'ordinary' };
    h.pendingMessages.push(other, human);
    const before = [...h.pendingMessages];
    h.effectiveBackendType = 'remote-runner';
    await loadWorkerFunction<any>('handleTermAction', h)('ctrlc');
    expect(h.pendingMessages).toEqual(before);
    expect(h.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'turn_input_rejected' }));
  });

  it('times out an authenticated IPC admission without releasing the head', async () => {
    vi.useFakeTimers();
    try {
      const h = ready(); const request = loadWorkerFunction<any>('requestScheduledInputAdmission', h)(h.pendingMessages[0]);
      expect(h.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'admit_scheduled_input', turnId }));
      await vi.advanceTimersByTimeAsync(5_000); expect(await request).toBe('retain');
    } finally { vi.useRealTimers(); }
  });
});


it('checks host schedule authority before an adopted pane opens or writes the turn', async () => {
  const turnId = 'schedule:a1b2c3d4:12345678-1234-1234-1234-123456789abc';
  const backend = { write: vi.fn() };
  const scope = { backend, cliAdapter: {}, rememberTurnLinkRefMode: () => {},
    captureAdoptWriteFence: () => ({ backend }), adoptWriteFenceIsCurrent: () => true,
    requestScheduledInputAdmission: vi.fn(async () => 'reject'), send: vi.fn(),
    renderer: { markNewTurn: vi.fn() },
  };
  const result = await loadWorkerFunction<any>('writeAdoptMessage', scope)('scheduled prompt', turnId,
    undefined, undefined, undefined, undefined, undefined, undefined, true);
  expect(result).toBe('admission-rejected');
  expect(backend.write).not.toHaveBeenCalled();
  expect(scope.renderer.markNewTurn).not.toHaveBeenCalled();
});

describe('adopt admission rejection queue release', () => {
  it.each([
    ['admission-rejected', 2, 0],
    ['refused-before-write', 1, 1],
  ])('re-drives ready peers only for %s', async (outcome, expectedCalls, remaining) => {
    const h = harness(); h.activeTurnAuthority.clear();
    h.lastInitConfig = { cliId: 'codex', adoptMode: true };
    const rejected = { turnId: 'schedule:a1b2c3d4:12345678-1234-1234-1234-123456789abc', content: 'scheduled' };
    const human = { turnId: 'om_adopt_human', content: 'next' };
    h.pendingMessages = []; h.pendingAdoptMessages = [rejected, human];
    h.hasPendingInputForFlush = () => h.pendingAdoptMessages.length > 0;
    h.runAdoptMessageForCapturedGeneration = vi.fn(async () => outcome);
    await h.flushPending();
    await Promise.resolve(); await Promise.resolve();
    expect(h.runAdoptMessageForCapturedGeneration).toHaveBeenCalledTimes(expectedCalls);
    expect(h.pendingAdoptMessages).toHaveLength(remaining);
  });
});

describe('adopt scheduled queue recovery', () => {
  const adoptTurn = 'schedule:a1b2c3d4:12345678-1234-1234-1234-123456789abc';
  const automatic = () => ({ turnId: adoptTurn, content: 'automatic',
    scheduledRun: { taskId: 'a1b2c3d4', runId: 'run-1', turnId: adoptTurn, trigger: 'scheduler' as const } });

  it('lets an authorized human past a quota-held automatic adopt head', async () => {
    const h = harness(); h.activeTurnAuthority.clear();
    h.lastInitConfig = { cliId: 'codex', adoptMode: true };
    const tick = automatic(); const human = { turnId: 'om_adopt_human', content: 'urgent', trustedCaller: {
      requestUserOpenId: 'owner', requestLarkAppId: 'app', senderType: 'user' as const,
    } };
    h.pendingMessages = []; h.pendingAdoptMessages = [tick, human];
    h.hasPendingInputForFlush = () => h.pendingAdoptMessages.length > 0;
    h.usageLimitTracker = { currentTurn: () => 4, detectedThisTurn: () => true };
    h.runAdoptMessageForCapturedGeneration = vi.fn(async (item: any, requeue: () => void) => {
      if (item === human) return 'completed';
      requeue();
      return 'stale-before-write';
    });
    await h.flushPending(); await Promise.resolve(); await Promise.resolve();
    expect(h.runAdoptMessageForCapturedGeneration.mock.calls[0][0]).toBe(human);
    expect(h.pendingAdoptMessages).toEqual([tick]);
  });

  it('retries a retained adopt admission against the original queue item', async () => {
    vi.useFakeTimers();
    try {
      const h = harness(); h.activeTurnAuthority.clear();
      const tick = automatic();
      h.send = vi.fn();
      h.pendingMessages = []; h.pendingAdoptMessages = [tick];
      h.lastInitConfig = { cliId: 'codex', adoptMode: true };
      h.hasPendingInputForFlush = () => h.pendingAdoptMessages.length > 0;
      h.rememberTurnLinkRefMode = () => {};
      h.captureAdoptWriteFence = () => ({ backend: h.backend });
      h.adoptWriteFenceIsCurrent = () => true;
      h.runAdoptQueuedWriteSequence = runAdoptQueuedWriteSequence;
      h.adoptWriteQueue = new AsyncSerialQueue();
      h.writeAdoptMessage = loadWorkerFunction('writeAdoptMessage', h);
      h.runAdoptMessageForCapturedGeneration = loadWorkerFunction('runAdoptMessageForCapturedGeneration', h);
      h.requestScheduledInputAdmission = vi.fn()
        .mockResolvedValueOnce('retain').mockResolvedValueOnce('reject');
      await h.flushPending();
      expect(h.pendingAdoptMessages).toEqual([tick]);
      expect(h.requestScheduledInputAdmission).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1_000);
      await Promise.resolve(); await Promise.resolve();
      expect(h.requestScheduledInputAdmission).toHaveBeenCalledTimes(2);
      expect(h.pendingAdoptMessages).toEqual([]);
    } finally { vi.useRealTimers(); }
  });
});

describe('schedule admission after terminal write mutex', () => {
  it.each(['pause', 'unavailable', 'stop', 'generation'])('refuses a write after an earlier ACK when %s intervenes during mutex wait', async state => {
    const turnId = 'schedule:a1b2c3d4:12345678-1234-1234-1234-123456789abc';
    const item = { turnId, content: 'queued schedule', queueAfterActiveTurn: true as const,
      scheduledRun: { taskId: 'a1b2c3d4', runId: 'run-1', turnId, trigger: 'scheduler' as const } };
    const task: any = { id: 'a1b2c3d4', enabled: true, lastRunId: 'run-1' };
    let release!: () => void; let current = true;
    const prepare = vi.fn(); const write = vi.fn(async () => ({ submitted: true })); const held: string[] = [];
    const backend = { captureAmbiguousSubmissionFence: () => 1 };
    const scope: any = { backend, cliSubmissionInFlight: { item, scheduledWritePending: true },
      requestScheduledInputAdmission: vi.fn(async () => state === 'unavailable' && !task.enabled ? 'retain'
        : admitScheduledInput({ scheduledRun: item.scheduledRun } as any, 'app', turnId, () => task)),
      ambiguousSubmissionWriteTail: new Promise<void>(resolve => { release = resolve; }),
      webTerminalInputWireDirty: () => false,
      captureAmbiguousSubmissionFence: () => 1,
      confirmAmbiguousSubmissionAfterSuccess: () => undefined,
      cancelAmbiguousSubmissionAfterFailure: vi.fn(() => undefined),
      AmbiguousSubmissionBlockedError: class extends Error {},
      rewrapSubmissionFailure: (err: Error, recovery: unknown, started: boolean) => ({ message: err.message, recoveryFailureReason: recovery, submissionStarted: started }),
      SubmissionWriteError: class extends Error {},
    };
    const gate = loadWorkerFunction<any>('runScheduledCliInputWrite', scope);
    const transaction = loadWorkerFunction<any>('runAmbiguousSubmissionTransaction', scope);
    expect(await scope.requestScheduledInputAdmission(item)).toBe('allow');
    const pending = transaction(backend, () => gate(item, () => current, prepare, write, (decision: string) => held.push(decision)));
    const caught = pending.catch((error: Error) => error);
    await Promise.resolve(); expect(write).not.toHaveBeenCalled();
    if (state === 'generation') current = false;
    else if (state === 'stop') scope.cliSubmissionInFlight.scheduledWriteCancelled = true;
    else { task.enabled = false; task.disabledReason = 'manual'; }
    release(); await caught;
    expect(scope.requestScheduledInputAdmission).toHaveBeenCalledTimes(2);
    expect(prepare).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled();
    expect(held).toEqual([state === 'unavailable' || state === 'generation' ? 'retain' : 'reject']);
    expect(scope.cancelAmbiguousSubmissionAfterFailure).toHaveBeenCalledOnce();
  });
});

it.each(['structured', 'raw'])('leaves %s adopted authority untouched after a late pause refusal and starts the next resumed schedule normally', async transport => {
  const taskId = 'a1b2c3d4';
  const turn = (suffix: string) => `schedule:${taskId}:${suffix}-1234-1234-1234-123456789abc`;
  const firstTurn = turn('12345678'); const nextTurn = turn('aaaaaaaa');
  const caller = { requestUserOpenId: 'ou_owner', requestLarkAppId: 'app', senderType: 'user' as const,
    source: 'schedule_creator' as const, taskId };
  const task: any = { id: taskId, enabled: true, lastRunId: 'run-1' };
  let release!: () => void;
  const authority = new ActiveTurnAuthority();
  const writeInput = vi.fn(async () => ({ submitted: true }));
  const backend = { captureAmbiguousSubmissionFence: () => 1, sendText: vi.fn(), sendSpecialKeys: vi.fn() };
  const calls: any[] = [];
  const scope: any = {
    backend, lastInitConfig: { cliId: 'codex', adoptMode: true }, cliAdapter: { writeInput },
    activeTurnAuthority: authority, crossPrincipalIsolationOn: () => true,
    rememberTurnLinkRefMode: () => {}, captureAdoptWriteFence: () => ({ backend }), adoptWriteFenceIsCurrent: () => true,
    requestScheduledInputAdmission: vi.fn(async (item: any) => admitScheduledInput({
      scheduledRun: { taskId, runId: task.lastRunId, turnId: item.turnId, trigger: 'scheduler' },
    } as any, 'app', item.turnId, () => task)),
    renderer: { markNewTurn: vi.fn() }, writeCliPidMarker: vi.fn(), publishSandboxRelayCapability: vi.fn(),
    markTurnRetired: vi.fn(), supersedeBackgroundAuthorityHold: vi.fn(), markTurnExecutionStart: vi.fn(),
    beginCliWriteCycle: vi.fn(), adoptComposerConflict: () => undefined, codexBridgeFallbackActive: () => false,
    isStructuredBridgeAdoptInputCli: () => transport === 'structured', adapterInputHandle: () => backend,
    settleVerifiableSubmissionForJournal: () => true,
    redriveRejectedStructuredReady: vi.fn(), send: (msg: any) => calls.push(msg), log: vi.fn(),
    ambiguousSubmissionWriteTail: new Promise<void>(resolve => { release = resolve; }),
    webTerminalInputWireDirty: () => false, captureAmbiguousSubmissionFence: () => 1,
    confirmAmbiguousSubmissionAfterSuccess: () => undefined, cancelAmbiguousSubmissionAfterFailure: () => undefined,
    AmbiguousSubmissionBlockedError: class extends Error {},
    rewrapSubmissionFailure: (err: Error, recovery: unknown, started: boolean) => ({ message: err.message, recoveryFailureReason: recovery, submissionStarted: started }),
    SubmissionWriteError: class extends Error {},
  };
  scope.turnAuthorityIdentity = loadWorkerFunction('turnAuthorityIdentity', scope);
  scope.markActiveTurnStarted = loadWorkerFunction('markActiveTurnStarted', scope);
  scope.setCaptureIdentity = loadWorkerFunction('setCaptureIdentity', scope);
  scope.runAmbiguousSubmissionTransaction = loadWorkerFunction('runAmbiguousSubmissionTransaction', scope);
  const write = loadWorkerFunction<any>('writeAdoptMessage', scope);
  const pending = write('first scheduled envelope', firstTurn, undefined, undefined, undefined, caller,
    undefined, undefined, true, { taskId, runId: 'run-1', turnId: firstTurn, trigger: 'scheduler' });
  await Promise.resolve(); await Promise.resolve();
  expect(scope.requestScheduledInputAdmission).toHaveBeenCalledOnce();
  expect(authority.snapshot()).toBeUndefined();
  expect(scope.currentBotmuxTurnId).toBeUndefined();
  expect(scope.renderer.markNewTurn).not.toHaveBeenCalled();
  task.enabled = false; task.disabledReason = 'manual'; release();
  expect(await pending).toBe('admission-rejected');
  expect(writeInput).not.toHaveBeenCalled();
  expect(backend.sendText).not.toHaveBeenCalled(); expect(backend.sendSpecialKeys).not.toHaveBeenCalled();
  expect(authority.snapshot()).toBeUndefined();
  expect(scope.currentBotmuxTurnId).toBeUndefined();
  expect(calls.filter(msg => msg.type === 'capture_identity')).toEqual([]);
  expect(scope.usageLimitTracker.currentTurn()).toBe(0);
  expect(scope.writeCliPidMarker).not.toHaveBeenCalled();
  expect(scope.publishSandboxRelayCapability).not.toHaveBeenCalled();

  task.enabled = true; task.disabledReason = undefined; task.lastRunId = 'run-2';
  expect(await write('resumed scheduled envelope', nextTurn, undefined, undefined, undefined, caller,
    undefined, undefined, true, { taskId, runId: 'run-2', turnId: nextTurn, trigger: 'scheduler' })).toBe('completed');
  if (transport === 'structured') expect(writeInput).toHaveBeenCalledExactlyOnceWith(backend, 'resumed scheduled envelope', undefined);
  else {
    expect(backend.sendText).toHaveBeenCalledExactlyOnceWith('resumed scheduled envelope');
    expect(backend.sendSpecialKeys).toHaveBeenCalledExactlyOnceWith('Enter');
  }
  expect(authority.snapshot()).toMatchObject({ turnId: nextTurn, started: true });
  expect(scope.currentBotmuxTurnId).toBe(nextTurn);
  expect(scope.usageLimitTracker.currentTurn()).toBe(1);
});
