import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { traexActiveEmptyComposerReady, traexSessionRenameSurface } from '../src/adapters/cli/traex-footer.js';
import { pendingInputAllowsTypeAhead, pendingInputMayFlush, inputForcesSerialTurn, shouldStopPendingBatch } from '../src/utils/pending-input-queue.js';
import { ActiveTurnAuthority } from '../src/core/active-turn-authority.js';
import { createTraexAdapter } from '../src/adapters/cli/traex.js';
import { stripAnsiScreenText } from '../src/utils/idle-detector.js';
import { shouldWriteNow, decideFirstWriteLiveness } from '../src/utils/input-gate.js';
import { loadWorkerFunction, loadWorkerMessageHandler } from './helpers/worker-function-harness.js';
import { workerSubmitHarness } from './helpers/worker-submit-harness.js';

const busy = readFileSync(new URL('./fixtures/session-rename/traex-0.216.0-renamed-while-busy.txt', import.meta.url), 'utf8');
const caller = { senderType: 'user' as const, requestUserOpenId: 'owner', requestLarkAppId: 'app' };
const input = () => ({ content: 'correct the current task', turnId: 'om_correction', trustedCaller: caller });

function reattachHarness() {
  const h = workerSubmitHarness();
  const authority = new ActiveTurnAuthority();
  authority.reserve({ turnId: 'om_running', caller, controller: caller });
  authority.markStarted({ turnId: 'om_running', caller, controller: caller });
  h.scope.pendingMessages.splice(0, 1, input());
  Object.assign(h.scope, {
    lastSpawnPersistentReattach: true, effectiveBackendType: 'tmux',
    lastInitConfig: { cliId: 'traex', nativeSessionTitle: 'restored title', cliSessionId: 'wrong-config-id' },
    isPromptReady: false, awaitingFirstPrompt: true,
    idleDetector: { isStartupPending: () => false, isStartupComplete: () => false, programStatusHeldWorking: () => false },
    sessionRenamePhase: 'idle', sessionRenameReattachRecoveryGeneration: -1,
    sessionRenameReattachRetryTimer: null, sessionRenameSentAtMs: 0,
    sessionRenameHoldLogged: false, sessionRenameHoldNoticeSent: false,
    armSessionRenameReattachRecoveryRetry: vi.fn(), armSessionRenameIdleTimeout: vi.fn(),
    notifySessionRenameInputHeld: vi.fn(), backendScreenEvidenceIsAuthoritativeForMutation: () => true,
    webTerminalInputGeneration: 3, captureBackendScreen: () => busy,
    currentTraexObservedPid: () => 123, findTraexRolloutSetByPid: () => new Set(['owned-native-id']),
    findTraexRolloutByPid: () => ({ cliSessionId: 'owned-native-id' }),
    inputDeliveryObservedCliSessionId: undefined,
    traexActiveEmptyComposerReady, pendingInputAllowsTypeAhead, pendingInputMayFlush, shouldWriteNow, inputForcesSerialTurn,
    durableTurnInFlight: false, initPromptMaterialized: true,
    commandLineWritesPending: 0, cliLifetimeNonce: 2,
    traexNativeStartupInputPending: false, traexFirstInputAdmissionPending: false,
    firstWriteLivenessConfirmed: false, firstWriteSpawnedAtMs: Date.now(),
    firstWriteLivenessHeld: false, firstWriteCaptureAtMs: 0, firstWriteCapturedViewport: undefined,
    FIRST_WRITE_CAPTURE_INTERVAL_MS: 1000, firstWriteLivenessTimer: null,
    firstWriteLivenessNotifiedPastCap: false, stopFirstWriteLivenessRecheck: vi.fn(), decideFirstWriteLiveness, stripAnsiScreenText,
    activeTurnAuthority: authority, crossPrincipalIsolationOn: () => true, shouldStopPendingBatch,
    currentBotmuxTurnId: 'om_running',
    rememberTurnLinkRefMode: vi.fn(), preemptActiveTurnForNewMessage: () => false,
    deferTurnInputCommitUntilSubmission: () => false, maybeQueuePostSubmitNativeSessionTitle: () => false,
    sessionRenameInFlight: () => h.scope.sessionRenamePhase !== 'idle',
    traexQuestionBridgeActive: () => false,
  });
  h.scope.backend.captureInputState = vi.fn(() => ({ viewport: busy }));
  h.scope.backend.captureViewport = () => busy;
  Object.assign(h.scope.cliAdapter, {
    buildSessionRenameCommand: (title: string) => `/rename ${title}`,
    readyPattern: createTraexAdapter('/bin/true').readyPattern,
    sessionRenameSurface: ({ viewport }: { viewport: string }, command: string) => traexSessionRenameSurface(viewport, command),
    watchSessionRename: vi.fn(),
    writeInput: vi.fn(async (_target, _content, context) => { context?.submitGuard?.beforeWrite?.(); return { submitted: true }; }),
  });
  h.scope.sessionRenameNativeSessionIdNow = loadWorkerFunction('sessionRenameNativeSessionIdNow', h.scope);
  h.scope.inputBoxJudgeable = loadWorkerFunction('inputBoxJudgeable', h.scope);
  h.scope.adapterInputBoxReady = loadWorkerFunction('adapterInputBoxReady', h.scope);
  h.scope.firstWriteScreen = loadWorkerFunction('firstWriteScreen', h.scope);
  h.scope.firstWriteMayProceed = loadWorkerFunction('firstWriteMayProceed', h.scope);
  h.scope.traexNativeStartupInputIsPending = loadWorkerFunction('traexNativeStartupInputIsPending', h.scope);
  h.scope.turnAuthorityIdentity = loadWorkerFunction('turnAuthorityIdentity', h.scope);
  h.scope.activeTurnBlocks = loadWorkerFunction('activeTurnBlocks', h.scope);
  h.scope.requeueUnsubmittedQueuedActivation = loadWorkerFunction('requeueUnsubmittedQueuedActivation', h.scope);
  h.scope.runAmbiguousSubmissionTransaction = async (_backend: unknown, write: () => Promise<unknown>, _accepted: unknown, prepare?: () => void) => { prepare?.(); return { result: await write() }; };
  h.scope.sessionRenameSurfaceNow = loadWorkerFunction('sessionRenameSurfaceNow', h.scope);
  h.scope.traexPersistentReattachBusyComposerFence = loadWorkerFunction('traexPersistentReattachBusyComposerFence', h.scope);
  h.scope.traexPersistentReattachSteeringFence = loadWorkerFunction('traexPersistentReattachSteeringFence', h.scope);
  h.scope.recoverSessionRenameAfterPersistentReattach = loadWorkerFunction('recoverSessionRenameAfterPersistentReattach', h.scope);
  h.scope.freshnessInputQueue.enqueueNormal = (item: unknown) => h.scope.pendingMessages.push(item);
  h.scope.flushPending = vi.fn(() => h.flush());
  h.scope.sendToPty = loadWorkerFunction('sendToPty', h.scope);
  return h;
}

describe('plain TRAE busy input after persistent worker reattach', () => {
  it('flushes a fresh human correction without a new idle event or rename recovery', async () => {
    const h = reattachHarness();
    await h.flush();
    expect(h.scope.cliAdapter.writeInput).toHaveBeenCalledOnce();
    expect(h.scope.pendingMessages).toHaveLength(0);
    expect(h.scope.sessionRenamePhase).toBe('idle');
    expect(h.scope.sessionRenameReattachRecoveryGeneration).toBe(-1);
    expect(h.scope.cliAdapter.watchSessionRename).not.toHaveBeenCalled();
    expect(h.scope.isPromptReady).toBe(false);
    expect(h.scope.awaitingFirstPrompt).toBe(true);
  });

  it('kicks the real flush from sendToPty before first idle on the replacement worker', async () => {
    const h = reattachHarness();
    h.scope.pendingMessages.length = 0;
    const correction = input();
    expect(h.scope.sendToPty(correction.content, correction.turnId, { trustedCaller: correction.trustedCaller })).toBe(true);
    expect(h.scope.flushPending).toHaveBeenCalledOnce();
    await h.scope.flushPending.mock.results[0].value;
    expect(h.scope.cliAdapter.writeInput).toHaveBeenCalledOnce();
    expect(h.scope.sessionRenamePhase).toBe('idle');
    expect(h.scope.isPromptReady).toBe(false);
    expect(h.scope.awaitingFirstPrompt).toBe(true);
  });

  it('admits the native busy footer when a long cwd truncates the Context cell', async () => {
    const h = reattachHarness();
    const viewport = busy.replace(/^  fake-model[^\r\n]*Context[^\r\n]*$/m, '  Seed-Evolving · ~/dev/workspaces/long-merchant-subsi…');
    h.scope.backend.captureInputState = () => ({ viewport });
    await h.flush();
    expect(h.scope.cliAdapter.writeInput).toHaveBeenCalledOnce();
    expect(h.scope.pendingMessages).toHaveLength(0);
    expect(h.scope.sessionRenamePhase).toBe('idle');
    expect(h.scope.isPromptReady).toBe(false);
  });

  it.each([
    ['rename draft', (h: ReturnType<typeof reattachHarness>) => { h.scope.backend.captureInputState = () => ({ viewport: busy.replace('Run /review on my current changes', '/rename restored title') }); }],
    ['rename dialog', (h: ReturnType<typeof reattachHarness>) => { h.scope.backend.captureInputState = () => ({ viewport: readFileSync(new URL('./fixtures/session-rename/traex-0.216.0-rename-dialog.txt', import.meta.url), 'utf8') }); }],
    ['ordinary draft', (h: ReturnType<typeof reattachHarness>) => { h.scope.backend.captureInputState = () => ({ viewport: busy.replace('Run /review on my current changes', 'unfinished user draft') }); }],
    ['unknown viewport', (h: ReturnType<typeof reattachHarness>) => { h.scope.backend.captureInputState = () => ({ viewport: '' }); }],
    ['missing owned session', (h: ReturnType<typeof reattachHarness>) => { h.scope.findTraexRolloutSetByPid = () => undefined; }],
    ['warm but foreign identity cache', (h: ReturnType<typeof reattachHarness>) => { h.scope.inputDeliveryObservedCliSessionId = 'foreign-id'; }],
    ['cold startup', (h: ReturnType<typeof reattachHarness>) => { h.scope.lastSpawnPersistentReattach = false; h.scope.idleDetector.isStartupPending = () => true; }],
    ['real startup hold', (h: ReturnType<typeof reattachHarness>) => { h.scope.traexNativeStartupInputIsPending = () => true; }],
    ['durable owner', (h: ReturnType<typeof reattachHarness>) => { h.scope.durableTurnInFlight = true; }],
    ['permission status', (h: ReturnType<typeof reattachHarness>) => { h.scope.programStatusBlockedHoldsTypeAhead = () => true; }],
    ['in-flight rename', (h: ReturnType<typeof reattachHarness>) => { h.scope.sessionRenamePhase = 'sent'; }],
  ])('retains input behind %s', async (_label, change) => {
    const h = reattachHarness();
    const head = h.scope.pendingMessages[0];
    change(h);
    await h.flush();
    expect(h.scope.pendingMessages[0]).toBe(head);
    expect(h.scope.cliAdapter.writeInput).not.toHaveBeenCalled();
    expect(h.scope.emitTurnTerminal).not.toHaveBeenCalled();
  });

  it.each([
    ['durable', { dispatchAttempt: 1 }],
    ['FIFO', { queueAfterActiveTurn: true }],
    ['schedule', { trustedCaller: { ...caller, source: 'schedule_creator' } }],
    ['automatic recovery', { trustedCaller: { ...caller, source: 'failed_turn_recovery' } }],
    ['bot', { trustedCaller: { ...caller, senderType: 'bot' } }],
    ['unattributed', { trustedCaller: undefined }],
    ['at-most-once', { noReplay: true }],
    ['cross principal', { trustedCaller: { ...caller, requestUserOpenId: 'someone-else' } }],
    ['task continuation', { taskContinuation: {} }],
    ['meeting', { vcMeetingImTurnOrigin: {} }],
    ['queued activation', { queuedActivationToken: 'queued' }],
  ])('does not use busy reattach admission for %s', async (_label, patch) => {
    const h = reattachHarness();
    const head = Object.assign(h.scope.pendingMessages[0], patch);
    await h.flush();
    expect(h.scope.pendingMessages[0]).toBe(head);
    expect(h.scope.cliAdapter.writeInput).not.toHaveBeenCalled();
  });

  it('holds raw and rename administration while delivering an ordinary correction despite stale readiness', async () => {
    const h = reattachHarness();
    h.scope.isPromptReady = true;
    const raw = { content: '/status', turnId: 'raw-admin' };
    h.scope.pendingRawInputs.push(raw);
    h.scope.pendingSessionRename = 'new title';
    await h.flush();
    expect(h.scope.cliAdapter.writeInput).toHaveBeenCalledOnce();
    expect(h.scope.pendingRawInputs).toEqual([raw]);
    expect(h.scope.pendingSessionRename).toBe('new title');
    expect(h.scope.cliAdapter.watchSessionRename).not.toHaveBeenCalled();
  });

  it('keeps administrator recovery pending without inventing a rename hold before the next correction', async () => {
    const h = reattachHarness();
    expect(h.scope.recoverSessionRenameAfterPersistentReattach()).toBe(true);
    expect(h.scope.sessionRenamePhase).toBe('idle');
    expect(h.scope.sessionRenameReattachRecoveryGeneration).toBe(-1);
    expect(h.scope.cliAdapter.watchSessionRename).not.toHaveBeenCalled();
    await h.flush();
    expect(h.scope.cliAdapter.writeInput).toHaveBeenCalledOnce();
  });

  it.each([
    ['viewport draft', (h: ReturnType<typeof reattachHarness>) => { h.scope.backend.captureInputState = () => ({ viewport: busy.replace('Run /review on my current changes', 'late draft') }); }],
    ['native ownership', (h: ReturnType<typeof reattachHarness>) => { h.scope.findTraexRolloutSetByPid = () => new Set(['foreign-id']); }],
    ['backend', (h: ReturnType<typeof reattachHarness>) => { h.scope.backend = {}; }],
    ['generation', (h: ReturnType<typeof reattachHarness>) => { h.scope.cliSpawnGeneration++; }],
    ['CLI lifetime', (h: ReturnType<typeof reattachHarness>) => { h.scope.cliLifetimeNonce++; }],
    ['Web epoch', (h: ReturnType<typeof reattachHarness>) => { h.scope.webTerminalInputGeneration++; }],
    ['queue head', (h: ReturnType<typeof reattachHarness>) => { h.scope.pendingMessages.unshift({ ...input(), turnId: 'om_new_head' }); }],
  ])('rechecks %s after awaited composer setup before dequeue', async (_label, change) => {
    const h = reattachHarness();
    const head = h.scope.pendingMessages[0];
    h.scope.inputBoxJudgeable = () => true;
    h.scope.cliAdapter.settleInputBox = async () => { await Promise.resolve(); change(h); };
    await h.flush();
    expect(h.scope.pendingMessages).toContain(head);
    expect(h.scope.cliAdapter.writeInput).not.toHaveBeenCalled();
    expect(h.scope.markActiveTurnStarted).not.toHaveBeenCalled();
    expect(h.scope.emitTurnTerminal).not.toHaveBeenCalled();
  });

  it('rechecks after backend submission serialization without committing the dequeued input', async () => {
    const h = reattachHarness();
    const head = h.scope.pendingMessages[0];
    h.scope.runAmbiguousSubmissionTransaction = async (_target: unknown, write: () => Promise<unknown>) => {
      await Promise.resolve();
      h.scope.webTerminalInputGeneration++;
      return { result: await write() };
    };
    await h.flush();
    expect(h.scope.pendingMessages[0]).toBe(head);
    expect(h.scope.markActiveTurnStarted).not.toHaveBeenCalled();
    expect(h.scope.emitTurnTerminal).not.toHaveBeenCalled();
  });

  it('rechecks after adapter setup before paste and keeps changed draft untouched', async () => {
    const h = reattachHarness();
    const head = h.scope.pendingMessages[0];
    const paste = vi.fn();
    h.scope.cliAdapter.writeInput = vi.fn(async (_target, _content, context) => {
      await Promise.resolve();
      h.scope.backend.captureInputState = () => ({ viewport: busy.replace('Run /review on my current changes', 'late native draft') });
      context.submitGuard.beforeWrite();
      paste();
      return { submitted: true };
    });
    await h.flush();
    expect(paste).not.toHaveBeenCalled();
    expect(h.scope.pendingMessages[0]).toBe(head);
    expect(h.scope.markActiveTurnStarted).not.toHaveBeenCalled();
    expect(h.scope.emitTurnTerminal).not.toHaveBeenCalled();
  });

  it('uses the real TRAE adapter pre-paste guard after its asynchronous viewport setup', async () => {
    const h = reattachHarness();
    const head = h.scope.pendingMessages[0];
    const paste = vi.fn();
    const enter = vi.fn();
    Object.assign(h.scope.backend, {
      write: vi.fn(), pasteText: paste, sendSpecialKeys: enter,
      captureViewportAsync: async () => {
        await Promise.resolve();
        const draft = busy.replace('Run /review on my current changes', 'untouched native draft');
        h.scope.backend.captureInputState = () => ({ viewport: draft });
        return draft;
      },
    });
    h.scope.cliAdapter.writeInput = createTraexAdapter('/bin/true').writeInput;
    await h.flush();
    expect(paste).not.toHaveBeenCalled();
    expect(enter).not.toHaveBeenCalled();
    expect(h.scope.pendingMessages[0]).toBe(head);
    expect(h.scope.markActiveTurnStarted).not.toHaveBeenCalled();
    expect(h.scope.emitTurnTerminal).not.toHaveBeenCalled();
  });

  it('keeps the real adapter from pressing Enter when Web input changes after paste', async () => {
    const h = reattachHarness();
    const enter = vi.fn();
    const paste = vi.fn(() => { h.scope.webTerminalInputGeneration++; });
    Object.assign(h.scope.backend, { write: vi.fn(), pasteText: paste, sendSpecialKeys: enter });
    h.scope.cliAdapter.writeInput = createTraexAdapter('/bin/true').writeInput;
    await h.flush();
    expect(paste).toHaveBeenCalledOnce();
    expect(enter).not.toHaveBeenCalled();
  });

  it.each(['rename state', 'automatic next write'])
    ('handles another correction during an ordinary pasted write: %s', async check => {
      const h = reattachHarness();
      let viewport = busy;
      h.scope.backend.captureInputState = () => ({ viewport });
      let entered!: () => void;
      const enteredWrite = new Promise<void>(resolve => { entered = resolve; });
      let finish!: () => void;
      const finishWrite = new Promise<void>(resolve => { finish = resolve; });
      let writes = 0;
      h.scope.cliAdapter.writeInput = vi.fn(async (_target, _content, context) => {
        context.submitGuard.beforeWrite();
        if (++writes === 1) {
          viewport = busy.replace('Run /review on my current changes', '[Pasted Content 120 chars]');
          entered();
          await finishWrite;
          viewport = busy;
        }
        return { submitted: true };
      });
      const flushing = h.flush();
      await enteredWrite;
      expect(h.scope.sendToPty('second correction', 'om_second_correction', { trustedCaller: caller })).toBe(true);
      const phaseWhileWriting = h.scope.sessionRenamePhase;
      finish();
      await flushing;
      if (check === 'rename state') {
        expect(phaseWhileWriting).toBe('idle');
        expect(h.scope.cliAdapter.watchSessionRename).not.toHaveBeenCalled();
      } else {
        expect(h.scope.cliAdapter.writeInput).toHaveBeenCalledTimes(2);
        expect(h.scope.pendingMessages).toHaveLength(0);
      }
      expect(h.scope.isPromptReady).toBe(false);
      expect(h.scope.emitTurnTerminal).not.toHaveBeenCalled();
    });

  it('re-drives the second correction when the first receipt settles before the composer redraw', async () => {
    vi.useFakeTimers();
    try {
      const h = reattachHarness();
      let viewport = busy;
      h.scope.backend.captureInputState = () => ({ viewport });
      Object.assign(h.scope, {
        SESSION_RENAME_FAST_RECHECK_WINDOW_MS: 30_000, SESSION_RENAME_RECHECK_MS: 2_000,
        SESSION_RENAME_SLOW_RECHECK_MS: 10_000,
      });
      h.scope.armSessionRenameReattachRecoveryRetry = loadWorkerFunction('armSessionRenameReattachRecoveryRetry', h.scope);
      let writes = 0;
      h.scope.cliAdapter.writeInput = vi.fn(async (_target, _content, context) => {
        context.submitGuard.beforeWrite();
        if (++writes === 1) {
          viewport = busy.replace('Run /review on my current changes', '[Pasted Content 120 chars]');
          h.scope.sendToPty('second correction', 'om_second_correction', { trustedCaller: caller });
          expect(h.scope.recoverSessionRenameAfterPersistentReattach()).toBe(true);
        }
        return { submitted: true };
      });
      await h.flush();
      expect(h.scope.cliAdapter.writeInput).toHaveBeenCalledOnce();
      expect(h.scope.pendingMessages).toHaveLength(1);
      expect(h.scope.sessionRenamePhase).toBe('idle');
      viewport = busy;
      await vi.advanceTimersByTimeAsync(2_001);
      await h.scope.flushPending.mock.results.at(-1).value;
      expect(h.scope.cliAdapter.writeInput).toHaveBeenCalledTimes(2);
      expect(h.scope.pendingMessages).toHaveLength(0);
      expect(h.scope.cliAdapter.watchSessionRename).not.toHaveBeenCalled();
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it.each(['reserved', 'writing', 'sent'])
    ('preserves a real %s rename while another writer holds the composer', phase => {
      const h = reattachHarness();
      h.scope.pendingMessages.length = 0;
      h.scope.sessionRenamePhase = phase;
      h.scope.isFlushing = true;
      expect(h.scope.sendToPty('correction', 'om_correction', { trustedCaller: caller })).toBe(true);
      expect(h.scope.sessionRenamePhase).toBe(phase);
      expect(h.scope.pendingMessages).toHaveLength(1);
      expect(h.scope.flushPending).not.toHaveBeenCalled();
      expect(h.scope.cliAdapter.watchSessionRename).not.toHaveBeenCalled();
    });

  it('queues real raw_input IPC while an ordinary correction owns the pasted composer', async () => {
    const h = reattachHarness();
    Object.assign(h.scope, {
      unattendedRawInputRefusal: () => undefined, discardDeploymentContinuation: vi.fn(),
      hookReviewAdmissionScreen: () => undefined, codexModelMigrationHoldsRawInput: () => false,
      startupCommandAckHold: null, openingInputBoxSettled: true,
      deliverRawInput: vi.fn(async () => {}),
    });
    h.scope.freshnessInputQueue.enqueueRaw = (item: unknown) => h.scope.pendingRawInputs.push(item);
    const rawHandler = loadWorkerMessageHandler('raw_input', h.scope);
    const raw = { type: 'raw_input', content: '/status', turnId: 'raw-admin' };
    h.scope.cliAdapter.writeInput = vi.fn(async (_target, _content, context) => {
      context.submitGuard.beforeWrite();
      const draft = busy.replace('Run /review on my current changes', '[Pasted Content 120 chars]');
      h.scope.backend.captureInputState = () => ({ viewport: draft });
      await rawHandler(raw);
      return { submitted: true };
    });
    await h.flush();
    expect(h.scope.deliverRawInput).not.toHaveBeenCalled();
    expect(h.scope.pendingRawInputs).toEqual([raw]);
    expect(h.scope.sessionRenamePhase).toBe('idle');
    expect(h.scope.cliAdapter.watchSessionRename).not.toHaveBeenCalled();
  });
});
