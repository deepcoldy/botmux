import { describe, expect, it, vi } from 'vitest';
import { decideQueuedReadyTransition } from '../src/core/queued-ready-transition.js';
import { ActiveTurnAuthority } from '../src/core/active-turn-authority.js';
import { pendingInputAllowsTypeAhead, pendingInputMayFlush, promoteInteractiveInputPastSchedules } from '../src/utils/pending-input-queue.js';
import { programStatusBlockHoldsTypeAhead } from '../src/core/program-status-gate.js';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';

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
