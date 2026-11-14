import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActiveTurnAuthority } from '../src/core/active-turn-authority.js';
import { TraexAutoModelController, traexAutoModelPreflightEnabled } from '../src/services/traex-auto-model.js';
import { traexCapacityQueueVisible, traexModelProgressVisible, traexQueuedTypeAheadVisible } from '../src/adapters/cli/traex.js';
import { loadWorkerFunction, loadWorkerMessageHandler } from './helpers/worker-function-harness.js';
import { workerSubmitHarness } from './helpers/worker-submit-harness.js';
import { beginRuntimeWriteCycle } from '../src/utils/runtime-screen-status.js';
import { finalizeRawCommandDelivery } from '../src/core/raw-command-writer.js';
import { programStatusBlockHoldsTypeAhead } from '../src/core/program-status-gate.js';
import { pendingInputAllowsTypeAhead } from '../src/utils/pending-input-queue.js';
import { sendTuiKeySequence, submitTuiTextInput } from '../src/utils/tui-input-delivery.js';

afterEach(() => { vi.useRealTimers(); });

function idleAdmissionHarness() {
  const h = workerSubmitHarness();
  const { scope } = h;
  const controller = new TraexAutoModelController({
    enabled: true, trigger: 'capacity', models: ['core', 'backup'],
    reselectPerTurn: false, preflightLoadCheck: false, queueTimeoutMs: 5_000,
  });
  controller.beginTurn('previous');
  scope.pendingMessages.splice(0, scope.pendingMessages.length, { content: 'follow-up', turnId: 'next' });
  Object.assign(scope, {
    backend: { captureViewportAsync: vi.fn(async () => '❯ Use /skills to list available skills') },
    traexAutoModelRuntimeEligible: () => true,
    traexAutoModelController: controller, traexAutoModelSwitching: false,
    traexAutoModelTurnReplayForbidden: false, traexAutoModelPreflightPending: false,
    traexAutoModelPreflightEnabled, activeTurnAuthority: new ActiveTurnAuthority(),
    currentBotmuxTurnId: 'previous', backendScreenRevision: 0, observedPaneGridRevision: 0,
    renderer: null, backendScreenEvidenceIsAuthoritativeForMutation: () => true,
    commandLineWritesPending: 0, injectionFlushing: false,
    currentPostTerminalInputFence: () => null, retryTraexAutoModelAdmission: vi.fn(),
    traexCapacityQueueVisible, traexModelProgressVisible, traexQueuedTypeAheadVisible,
    traexAutoModelInputHold: () => false,
    promptReadinessRevision: 0, webTerminalInputGeneration: 0,
    beginRuntimeWriteCycle, backgroundTaskTracker: { noteMainTurn: vi.fn() },
    publishActiveRuntime: vi.fn(), markTurnRetired: vi.fn(),
    acknowledgeTurnInputCommitted: vi.fn(),
    maybeQueuePostSubmitNativeSessionTitle: vi.fn(),
  });
  scope.resetTraexAutoModelBeforePendingTurn = loadWorkerFunction('resetTraexAutoModelBeforePendingTurn', scope);
  scope.admitTraexAutoModelPendingInput = loadWorkerFunction('admitTraexAutoModelPendingInput', scope);
  scope.deferNativeCodexInputCommit = loadWorkerFunction('deferNativeCodexInputCommit', scope);
  scope.deferTurnInputCommitUntilSubmission = loadWorkerFunction('deferTurnInputCommitUntilSubmission', scope);
  scope.idleDetector.reset = vi.fn();
  scope.revokePromptReadiness = loadWorkerFunction('revokePromptReadiness', scope);
  scope.beginCliWriteCycle = loadWorkerFunction('beginCliWriteCycle', scope);
  scope.cliAdapter.writeInput = vi.fn(async () => ({ submitted: true }));
  return h;
}

describe('idle auto-model input after a transient admission refusal', () => {
  it('uses the real timeout and retry timer to recover without another idle event', async () => {
    vi.useFakeTimers();
    const h = idleAdmissionHarness();
    h.scope.flushPending = h.flush;
    h.scope.retryTraexAutoModelAdmission = loadWorkerFunction('retryTraexAutoModelAdmission', h.scope);
    h.scope.backend.captureViewportAsync.mockImplementationOnce(() => new Promise(() => {}));
    const first = h.flush();
    await vi.advanceTimersByTimeAsync(1_200);
    await first;
    expect(h.scope.cliAdapter.writeInput).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    expect(h.scope.cliAdapter.writeInput).toHaveBeenCalledOnce();
    expect(h.scope.pendingMessages).toEqual([]);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.scope.cliAdapter.writeInput).toHaveBeenCalledOnce();
  });

  it.each(['viewport race', 'empty capture'] as const)('retries %s on a static composer and submits exactly once', async refusal => {
    const h = idleAdmissionHarness();
    const { scope } = h;
    const item = scope.pendingMessages[0];
    scope.backend.captureViewportAsync.mockImplementationOnce(async () => {
      if (refusal === 'viewport race') scope.backendScreenRevision++;
      return refusal === 'empty capture' ? '' : '❯ Use /skills to list available skills';
    });
    await h.flush();
    expect(scope.cliAdapter.writeInput).not.toHaveBeenCalled();
    expect(scope.pendingMessages).toEqual([item]);
    expect(scope.retryTraexAutoModelAdmission).toHaveBeenCalledOnce();
    // No new CLI idle event or manual readiness assignment between attempts.
    await h.flush();
    expect(scope.backend.captureViewportAsync).toHaveBeenCalledTimes(2);
    expect(scope.cliAdapter.writeInput).toHaveBeenCalledOnce();
    expect(scope.pendingMessages).toEqual([]);
    await h.flush();
    expect(scope.cliAdapter.writeInput).toHaveBeenCalledOnce();
    expect(scope.emitTurnTerminal).not.toHaveBeenCalled();
  });

  it.each(['backend replacement', 'generation change', 'restart'] as const)('does not restore stale readiness across %s', async change => {
    const h = idleAdmissionHarness();
    const { scope } = h;
    scope.backend.captureViewportAsync.mockImplementationOnce(async () => {
      if (change === 'backend replacement') scope.backend = {};
      else if (change === 'generation change') scope.cliSpawnGeneration++;
      else scope.cliRestartInProgress = true;
      return '❯ Use /skills to list available skills';
    });
    await h.flush();
    expect(scope.isPromptReady).toBe(false);
    expect(scope.cliAdapter.writeInput).not.toHaveBeenCalled();
    expect(scope.pendingMessages).toHaveLength(1);
  });

  it('keeps capacity-queued input outside the CLI until a later capture proves the composer', async () => {
    const h = idleAdmissionHarness();
    const { scope } = h;
    scope.backend.captureViewportAsync.mockResolvedValue('◆ Queued for capacity (2s • esc to interrupt)');
    await h.flush();
    await h.flush();
    expect(scope.cliAdapter.writeInput).not.toHaveBeenCalled();
    expect(scope.pendingMessages).toHaveLength(1);
    scope.backend.captureViewportAsync.mockResolvedValue('❯ Use /skills to list available skills');
    await h.flush();
    expect(scope.cliAdapter.writeInput).toHaveBeenCalledOnce();
    expect(scope.pendingMessages).toEqual([]);
  });

  it('does not invent prompt readiness for a busy type-ahead input', async () => {
    const h = idleAdmissionHarness();
    const { scope } = h;
    scope.isPromptReady = false;
    scope.activeTurnAuthority.reserve({ turnId: 'previous' });
    scope.activeTurnAuthority.markStarted({ turnId: 'previous' });
    scope.backend.captureViewportAsync.mockResolvedValue('');
    await h.flush();
    expect(scope.isPromptReady).toBe(false);
    expect(scope.cliAdapter.writeInput).not.toHaveBeenCalled();
    expect(scope.pendingMessages).toHaveLength(1);
  });

  it.each(['manual', 'previous'])('does not send a queued rename after a real raw command for %s supersedes capture', async rawTurnId => {
    vi.useFakeTimers();
    const h = idleAdmissionHarness();
    const { scope } = h;
    scope.flushPending = h.flush;
    scope.retryTraexAutoModelAdmission = loadWorkerFunction('retryTraexAutoModelAdmission', scope);
    let release!: (screen: string) => void;
    scope.backend.captureViewportAsync.mockImplementationOnce(() => new Promise<string>(resolve => { release = resolve; }));
    Object.assign(scope, {
      openingInputBoxSettled: true, finalizeRawCommandDelivery,
      sendRawCommandLineWithRecoveryFence: vi.fn(async (_backend, _text, beforeWrite) => { beforeWrite?.(); }),
      setCaptureIdentity: (turnId: string) => { scope.currentBotmuxTurnId = turnId; },
      stampMojoTurnMark: vi.fn(), claudeSwitchKindForCommand: () => null,
      claudeBtwQuestion: () => null, traexQuestionBridgeActive: () => false,
      armSessionRenameIdleTimeout: vi.fn(),
    });
    const first = h.flush();
    expect(scope.backend.captureViewportAsync).toHaveBeenCalledOnce();
    await loadWorkerFunction('deliverRawInput', scope)({ type: 'raw_input', content: '/btw question', turnId: rawTurnId });
    expect(scope.isPromptReady).toBe(false);
    scope.pendingSessionRename = 'later-title';
    scope.cliAdapter.buildSessionRenameCommand = (title: string) => `/rename ${title}`;
    release('❯ Use /skills to list available skills');
    await first;
    expect(scope.isPromptReady).toBe(false);
    expect(scope.cliAdapter.writeInput).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    expect(scope.sendRawCommandLineWithRecoveryFence).toHaveBeenCalledOnce();
    expect(scope.sendRawCommandLineWithRecoveryFence.mock.calls[0][1]).toBe('/btw question');
    expect(scope.traexAutoModelController.currentTurnId()).toBe('previous');
    expect(scope.currentBotmuxTurnId).toBe(rawTurnId);
    expect(scope.pendingSessionRename).toBe('later-title');
  });

  it('preserves a new approval block after the old capture is refused', async () => {
    const h = idleAdmissionHarness();
    const { scope } = h;
    let release!: (screen: string) => void;
    scope.backend.captureViewportAsync.mockImplementationOnce(() => new Promise<string>(resolve => { release = resolve; }));
    const first = h.flush();
    scope.activeTurnAuthority.reserve({ turnId: 'manual' });
    scope.activeTurnAuthority.markStarted({ turnId: 'manual' });
    scope.currentBotmuxTurnId = 'manual';
    scope.cliAdapter.programStatusBlockedHoldsInput = true;
    scope.idleDetector.programStatusBlock = () => ({ kind: 'approval' });
    scope.programStatusBlockHoldsTypeAhead = programStatusBlockHoldsTypeAhead;
    scope.programStatusBlockedHoldsTypeAhead = loadWorkerFunction('programStatusBlockedHoldsTypeAhead', scope);
    scope.pendingInputAllowsTypeAhead = pendingInputAllowsTypeAhead;
    scope.revokePromptReadiness();
    release('❯ Use /skills to list available skills');
    await first;
    await h.flush();
    expect(scope.isPromptReady).toBe(false);
    expect(scope.cliAdapter.writeInput).not.toHaveBeenCalled();
    expect(scope.pendingMessages).toHaveLength(1);
  });

  it('does not restore readiness after direct Web terminal input during capture', async () => {
    const h = idleAdmissionHarness();
    const { scope } = h;
    scope.terminalInputSubmits = () => false;
    scope.backend.captureViewportAsync.mockImplementationOnce(async () => {
      loadWorkerFunction('noteWebTerminalInput', scope)('x');
      return '❯ Use /skills to list available skills';
    });
    await h.flush();
    expect(scope.isPromptReady).toBe(false);
    expect(scope.cliAdapter.writeInput).not.toHaveBeenCalled();
    expect(scope.pendingMessages).toHaveLength(1);
  });

  it('invalidates capture when a later key in a paused control sequence is written', async () => {
    vi.useFakeTimers();
    const h = idleAdmissionHarness();
    const { scope } = h;
    Object.assign(scope, {
      cliLifetimeNonce: 1, logError: vi.fn(), KEY_TO_ANSI: {}, sendTuiKeySequence,
    });
    scope.backend.sendSpecialKeys = vi.fn(() => true);
    scope.runAfterAmbiguousSubmissionWrites = loadWorkerFunction('runAfterAmbiguousSubmissionWrites', scope);
    scope.handleTuiKeysDirect = loadWorkerFunction('handleTuiKeysDirect', scope);
    const keys = loadWorkerFunction('handleTuiKeys', scope)(['Down', 'Enter'], true);
    await vi.advanceTimersByTimeAsync(0);
    expect(scope.backend.sendSpecialKeys).toHaveBeenCalledWith('Down');
    let release!: (screen: string) => void;
    scope.backend.captureViewportAsync.mockImplementationOnce(() => new Promise<string>(resolve => { release = resolve; }));
    const first = h.flush();
    await vi.advanceTimersByTimeAsync(100);
    expect(scope.backend.sendSpecialKeys).toHaveBeenCalledWith('Enter');
    scope.backendScreenRevision++;
    release('❯ Use /skills to list available skills');
    await first;
    expect(scope.isPromptReady).toBe(false);
    expect(scope.cliAdapter.writeInput).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(await keys).toBe(true);
  });

  it.each(['final keys', 'quick Enter', 'native question', 'text answer', 'prompt submitted', 'busy event'] as const)(
    'does not send rename after %s invalidates an in-flight capture', async control => {
      vi.useFakeTimers();
      const h = idleAdmissionHarness();
      const { scope } = h;
      scope.flushPending = h.flush;
      scope.retryTraexAutoModelAdmission = loadWorkerFunction('retryTraexAutoModelAdmission', scope);
      Object.assign(scope, {
        cliLifetimeNonce: 1, logError: vi.fn(), KEY_TO_ANSI: { Enter: '\r' },
        sendTuiKeySequence, strictInputHandle: (backend: unknown) => backend,
        // bun:test 的假定时器接不住导入 ESM 模块异步续体里调度的 setTimeout
        // （跨模块边界时该定时器既不被 advance 触发也不按墙钟触发，用例挂到超时），
        // 注入无定时器的 pause，与 tui-input-delivery.test.ts 的做法一致；
        // 真实写入、追踪代理与失效计数路径全部保留。
        submitTuiTextInput: (options: Parameters<typeof submitTuiTextInput>[0]) =>
          submitTuiTextInput({ ...options, pause: async () => {} }),
        bindSessionObservation: (callback: unknown) => callback,
        noteClaudeBridgeTurnStarted: vi.fn(), publishScreenStatus: vi.fn(),
        writtenInputs: { takeSubmitted: () => undefined }, armSessionRenameIdleTimeout: vi.fn(),
        sendRawCommandLineWithRecoveryFence: vi.fn(async () => {}),
        isCriticalInterruptKey: () => false, PTY_SEQ_MAP: { enter: '\r' },
        TMUX_KEY_MAP: { enter: 'Enter' }, scheduleOneShotAfterAction: vi.fn(),
      });
      scope.runAfterAmbiguousSubmissionWrites = loadWorkerFunction('runAfterAmbiguousSubmissionWrites', scope);
      scope.handleTuiKeysDirect = loadWorkerFunction('handleTuiKeysDirect', scope);
      scope.sendTermActionOnce = loadWorkerFunction('sendTermActionOnce', scope);
      scope.backend.write = vi.fn(() => true);
      let release!: (screen: string) => void;
      scope.backend.captureViewportAsync.mockImplementationOnce(() => new Promise<string>(resolve => { release = resolve; }));
      const first = h.flush();
      if (control === 'final keys') {
        const keys = loadWorkerFunction('handleTuiKeys', scope)(['Enter'], true);
        await vi.advanceTimersByTimeAsync(100);
        expect(await keys).toBe(true);
        expect(scope.backend.write).toHaveBeenCalledWith('\r');
      } else if (control === 'quick Enter') {
        await loadWorkerFunction('handleTermAction', scope)('enter');
        expect(scope.backend.write).toHaveBeenCalledWith('\r');
      } else if (control === 'native question') {
        expect(await loadWorkerFunction('traexQuestionWrite', scope)(
          (input: { write: (data: string) => boolean }) => input.write('\r'),
        )).toBe(true);
        expect(scope.backend.write).toHaveBeenCalledWith('\r');
      } else if (control === 'text answer') {
        const text = loadWorkerFunction('handleTuiTextInput', scope)([], 'answer');
        await vi.advanceTimersByTimeAsync(200);
        expect(await text).toBe(true);
        expect(scope.cliAdapter.writeInput).toHaveBeenCalledOnce();
      } else if (control === 'prompt submitted') {
        await loadWorkerMessageHandler('prompt_submitted', scope)({ type: 'prompt_submitted' });
      } else {
        let busy!: () => void;
        loadWorkerFunction('wireIdleDetectorBusyTransition', scope)(
          { onBusy: (callback: () => void) => { busy = callback; } }, 'test',
        );
        busy();
      }
      const writesAfterControl = scope.cliAdapter.writeInput.mock.calls.length;
      scope.pendingSessionRename = 'after-answer';
      scope.cliAdapter.buildSessionRenameCommand = (title: string) => `/rename ${title}`;
      scope.backendScreenRevision++;
      release('❯ Use /skills to list available skills');
      await first;
      expect(scope.isPromptReady).toBe(false);
      expect(scope.cliAdapter.writeInput).toHaveBeenCalledTimes(writesAfterControl);
      await vi.advanceTimersByTimeAsync(200);
      expect(scope.sendRawCommandLineWithRecoveryFence).not.toHaveBeenCalled();
      expect(scope.pendingSessionRename).toBe('after-answer');
    },
  );
});
