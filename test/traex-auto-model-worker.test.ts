import { describe, expect, it, vi } from 'vitest';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';
import { TraexAutoModelController, resolveTraexAutoModelSettings, validTraexAutoModelRuntime } from '../src/services/traex-auto-model.js';
import { knownTraexReasoningEffortsForModel } from '../src/services/codex-reasoning-effort.js';
import { buildSessionChildEnv, botInjectedEnv } from '../src/core/env-policy.js';
import { ActiveTurnAuthority } from '../src/core/active-turn-authority.js';
import { InflightInputTracker } from '../src/core/inflight-input-tracker.js';
import { execFileSync } from 'node:child_process';
import { createReadStream, mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { TmuxPipeBackend } from '../src/adapters/backend/tmux-pipe-backend.js';
import { traexCapacityQueueVisible, traexModelProgressVisible, traexQueuedTypeAheadVisible } from '../src/adapters/cli/traex.js';
import { TerminalRenderer } from '../src/utils/terminal-renderer.js';
import { restartInterruptionNote, restartInterruptionNotice, restartNoteMayPrefix, prefixRestartNote } from '../src/services/restart-interruption.js';

function harness(extra: Record<string, unknown> = {}) {
  const controller = new TraexAutoModelController({ enabled: true, models: ['core', 'backup'], queueTimeoutMs: 5_000, reselectPerTurn: true });
  controller.beginTurn('turn');
  const authority = new ActiveTurnAuthority();
  authority.reserve({ turnId: 'turn' });
  authority.markStarted({ turnId: 'turn' });
  const tracker = new InflightInputTracker();
  tracker.onWrite({ content: 'original', turnId: 'turn' });
  const scope: Record<string, any> = {
    traexAutoModelRuntimeEligible: () => true, traexAutoModelSwitching: false,
    cliRestartInProgress: false, isFlushing: false, traexAutoModelTurnReplayForbidden: false,
    lastInitConfig: { cliId: 'traex', cliSessionId: 'native', model: 'core' },
    activeTurnAuthority: authority, traexAutoModelController: controller,
    inflightInputs: tracker, currentBotmuxCallerOpenId: 'caller', pendingMessages: [],
    knownTraexReasoningEffortsForModel, cliModelSupportsReasoningEffort: () => true, send: vi.fn(), log: vi.fn(),
    resolveTraexAutoModelSettings, validTraexAutoModelRuntime,
    restartCliProcess: vi.fn(async () => {}), t: (key: string) => key,
    ...extra,
  };
  scope.enqueueTraexAutoModelRecovery = loadWorkerFunction('enqueueTraexAutoModelRecovery', scope);
  return { scope, controller, tracker, switchModel: loadWorkerFunction<(action: any, options: any) => boolean>('executeTraexAutoModelSwitch', scope) };
}
const action = { kind: 'switch', reason: 'lowest_load', turnId: 'turn', fromModel: 'core', toModel: 'backup', toIndex: 1, loadPercent: 120 };

function admissionHarness(extra: Record<string, unknown> = {}) {
  const item = { content: 'follow-up', turnId: 'next', trustedCaller: { requestUserOpenId: 'original-caller' } };
  const scope: Record<string, any> = {
    traexAutoModelRuntimeEligible: () => true, traexAutoModelSwitching: false,
    backend: { captureViewportAsync: vi.fn(async () => '◆ Working… (2s • esc to interrupt)') },
    traexAutoModelController: new TraexAutoModelController({ enabled: true, models: ['core', 'backup'], queueTimeoutMs: 5_000 }),
    cliSpawnGeneration: 1, currentBotmuxTurnId: 'turn', pendingMessages: [item],
    renderer: null, backendScreenRevision: 0, observedPaneGridRevision: 0,
    cliRestartInProgress: false, backendScreenEvidenceIsAuthoritativeForMutation: () => true,
    commandLineWritesPending: 0, injectionFlushing: false, sessionRenameInFlight: () => false,
    currentInputDeliveryQuarantine: () => null, activeTurnBlocks: () => false,
    currentPostTerminalInputFence: () => null, pendingInjections: [], shouldDeferUserFlush: () => false,
    retryTraexAutoModelAdmission: vi.fn(), traexCapacityQueueVisible,
    traexModelProgressVisible, traexQueuedTypeAheadVisible,
    captureBackendScreen: (be: any) => be.captureViewport?.() ?? '',
    ...extra,
  };
  const admit = loadWorkerFunction<(item: any) => Promise<boolean>>('admitTraexAutoModelPendingInput', scope);
  return { scope, item, admit: () => admit(scope.pendingMessages[0]) };
}

describe('auto-model Worker admission and original-input retirement', () => {
  it('does not admit a follow-up on the stale composer after the first input was submitted', async () => {
    const h = admissionHarness({ backend: { captureViewportAsync: async () => '❯ Ask anything' } });
    const controller = h.scope.traexAutoModelController as TraexAutoModelController;
    controller.beginTurn('turn');
    controller.markInputSubmitted('turn');
    expect(await h.admit()).toBe(false);
    expect(h.scope.pendingMessages).toEqual([h.item]);
    h.scope.backend.captureViewportAsync = async () => '◆ Working… (2s • esc to interrupt)';
    expect(await h.admit()).toBe(true);
    expect(controller.awaitingModelActivity()).toBe(false);
  });
  it.each([
    { name: 'Herdr viewport', authoritative: true, capture: 'captureViewport' },
    { name: 'Herdr current screen', authoritative: true, capture: 'captureCurrentScreen' },
    { name: 'ZMX snapshot', authoritative: false, capture: 'captureViewport' },
  ])('$name holds successors until activity or terminal, while permitting exact recovery', async ({ authoritative, capture }) => {
    for (const waiting of ['submitted', 'switched']) {
      const syncRead = vi.fn(() => '❯ Ask anything');
      const h = admissionHarness({ backend: { [capture]: syncRead },
        backendScreenEvidenceIsAuthoritativeForMutation: () => authoritative });
      const controller = h.scope.traexAutoModelController as TraexAutoModelController;
      controller.beginTurn('turn');
      if (waiting === 'submitted') controller.markInputSubmitted('turn');
      else expect(controller.commitSwitch(action)).toBe(true);
      expect(controller.awaitingModelActivity()).toBe(true);
      expect(await h.admit()).toBe(false);
      expect(h.scope.pendingMessages).toEqual([h.item]);
      h.scope.pendingMessages[0] = { content: 'continue', turnId: 'turn', traexAutoModelRecovery: true };
      expect(await h.admit()).toBe(true);
      h.scope.pendingMessages[0] = { content: 'unrelated recovery', turnId: 'other', traexAutoModelRecovery: true };
      expect(await h.admit()).toBe(false);
      h.scope.pendingMessages[0] = h.item;
      controller.observeCapacityQueue({ turnId: 'turn', queued: false, progressing: true, nowMs: 1 });
      expect(await h.admit()).toBe(true);
      controller.markInputSubmitted('turn');
      expect(await h.admit()).toBe(false);
      controller.endTurn('turn');
      expect(await h.admit()).toBe(true);
      expect(syncRead).not.toHaveBeenCalled();
    }
  });

  it('releases a parked legacy successor once model activity clears the awaiting latch', async () => {
    const h = harness();
    h.controller.commitSwitch(action);
    const screen = '⠋ Any second now…\nQueued for next turn\nContext 65% left';
    expect(traexModelProgressVisible(screen)).toBe(false);
    expect(traexQueuedTypeAheadVisible(screen)).toBe(true);
    Object.assign(h.scope, { isPromptReady: false, currentBotmuxTurnId: 'turn',
      traexCapacityQueueVisible, traexCapacityQueuePosition: () => undefined,
      traexModelProgressVisible, traexQueuedTypeAheadVisible, flushPending: vi.fn() });
    const observe = loadWorkerFunction<(screen: string) => void>('observeTraexAutoModelCapacity', h.scope);
    observe(screen);
    expect(h.controller.awaitingModelActivity()).toBe(false);
    expect(h.scope.flushPending).toHaveBeenCalledOnce();
    observe(screen);
    expect(h.scope.flushPending).toHaveBeenCalledOnce();
  });

  it('rejects an async viewport result captured before a model switch', async () => {
    let finish!: (screen: string) => void;
    const h = admissionHarness({ backend: { captureViewportAsync: () => new Promise<string>(resolve => { finish = resolve; }) } });
    const controller = h.scope.traexAutoModelController as TraexAutoModelController;
    controller.beginTurn('turn');
    const pending = h.admit();
    expect(controller.commitSwitch(action)).toBe(true);
    finish('◆ Working… (2s • esc to interrupt)');
    expect(await pending).toBe(false);
    expect(controller.currentModel()).toBe('backup');
    expect(controller.awaitingModelActivity()).toBe(true);
    expect(h.scope.pendingMessages).toEqual([h.item]);
  });

  it('uses the authoritative terminal to release awaiting input when the ready observer is skipped', async () => {
    const h = harness();
    h.controller.markInputSubmitted('turn');
    Object.assign(h.scope, { isPromptReady: true });
    loadWorkerFunction<(screen: string) => void>('observeTraexAutoModelCapacity', h.scope)('◆ Working… (2s • esc to interrupt)');
    expect(h.controller.awaitingModelActivity()).toBe(true);
    const admission = admissionHarness({ traexAutoModelController: h.controller,
      backend: { captureViewportAsync: async () => '❯ Ask anything' } });
    expect(await admission.admit()).toBe(false);
    h.controller.endTurn('turn');
    expect(h.controller.awaitingModelActivity()).toBe(false);
    expect(await admission.admit()).toBe(true);
  });

  it('recovers the actual live model and its settings after a worker upgrade, and persists a same-model hold change', () => {
    const controller = new TraexAutoModelController({ enabled: true, models: ['core', 'backup'], queueTimeoutMs: 5_000,
      modelSettings: { core: { reasoningEffort: 'high', modelBackendVariant: 'max' },
        backup: { reasoningEffort: 'xhigh', modelBackendVariant: 'standard' } } });
    const scope = { traexAutoModelRuntimeEligible: () => true, traexAutoModelController: controller,
      traexAutoModelSwitching: false, lastInitConfig: { cliSessionId: 'native', model: 'core',
        reasoningEffort: 'high', modelBackendVariant: 'max' },
      resolveTraexAutoModelSettings, deliveredPluginSkillCatalogFingerprint: undefined,
      activeRuntimePublished: false, publishedActiveRuntime: {}, publishedAutoModelVariant: undefined,
      publishedAutoModelStateKey: undefined, send: vi.fn() };
    const publish = loadWorkerFunction<(runtime: any) => void>('publishActiveRuntime', scope);
    publish({ model: 'backup', reasoningEffort: 'xhigh' });
    expect(scope.lastInitConfig).toMatchObject({ model: 'backup', modelBackendVariant: 'standard', reasoningEffort: 'xhigh' });
    controller.beginTurn('turn');
    controller.observeCapacityQueue({ turnId: 'turn', queued: true, nowMs: 0 });
    controller.observeCapacityQueue({ turnId: 'turn', queued: true, nowMs: 5_000 });
    controller.resolveModelLoads('turn', new Map([['core', 200], ['backup', 100]]));
    publish({ model: 'backup', reasoningEffort: 'xhigh' });
    expect(scope.send).toHaveBeenCalledTimes(2);
    expect(scope.send).toHaveBeenLastCalledWith(expect.objectContaining({
      traexAutoModelRuntime: expect.objectContaining({ model: 'backup', waitingOnFinalModel: true }) }));
  });

  it('delivers an actual catalog change on a recovery write rather than deferring it to a later user', () => {
    const scope = { deferredPluginSkillCatalog: '<botmux_skills_refresh>changed</botmux_skills_refresh>',
      deferredPluginSkillCatalogFingerprint: 'changed-hash', deliveredPluginSkillCatalogFingerprint: 'old-hash',
      lastInitConfig: { adoptMode: false }, log: vi.fn(), withCodexAppContext: vi.fn() };
    const attach = loadWorkerFunction<(item: any) => void>('attachDeferredPluginSkillCatalog', scope);
    const recovery = { content: 'continue', traexAutoModelRecovery: true };
    attach(recovery);
    expect(recovery).toMatchObject({ content: 'continue\n\n<botmux_skills_refresh>changed</botmux_skills_refresh>',
      logicalContent: 'continue' });
    expect(scope.deliveredPluginSkillCatalogFingerprint).toBe('changed-hash');
    const next = { content: 'next ask' };
    attach(next);
    expect(next.content).toBe('next ask');
  });

  it('retires the original transport input and requests exact native resume with one attributed continuation', () => {
    const h = harness();
    expect(h.switchModel(action, { resumeCurrentTurn: true })).toBe(true);
    expect(h.scope.pendingMessages).toEqual([expect.objectContaining({
      turnId: 'turn', traexAutoModelRecovery: true, noReplay: true,
    })]);
    expect(h.tracker.onCliExit()).toBe(0);
    expect(h.scope.restartCliProcess).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      exactResumeSessionId: 'native', skipRestartBudget: true, preservePending: true,
      restartCause: 'traex-auto-model',
    }));
    expect(h.switchModel(action, { resumeCurrentTurn: true })).toBe(false);
    expect(h.scope.pendingMessages).toHaveLength(1);
  });

  it('keeps interruption scanning enabled when rename timeout resets the model with an unfinished predecessor', async () => {
    vi.useFakeTimers();
    try {
      const successor = { content: 'next ask', turnId: 'next' };
      const h = harness({ pendingMessages: [successor] });
      expect(h.controller.commitSwitch(action)).toBe(true);
      h.scope.lastInitConfig.model = 'backup';
      Object.assign(h.scope, {
        isPromptReady: false, queuedTypeAheadTurns: [], traexAutoModelInputHold: () => true,
        sessionRenamePhase: 'sent', sessionRenameIdleTimer: null, SESSION_RENAME_IDLE_TIMEOUT_MS: 5_000,
        executeTraexAutoModelSwitch: h.switchModel,
      });
      const reset = loadWorkerFunction<() => boolean>('resetTraexAutoModelBeforePendingTurn', h.scope);
      h.scope.flushPending = vi.fn(() => reset());
      expect(h.scope.activeTurnAuthority.snapshot()).toMatchObject({ turnId: 'turn', started: true });
      loadWorkerFunction<() => void>('armSessionRenameIdleTimeout', h.scope)();
      // advanceTimersToNextTimerAsync is available on both vitest and the
      // bun:test shim (runOnlyPendingTimersAsync is not); here the rename
      // timeout is the single pending timer, so they are equivalent.
      await vi.advanceTimersToNextTimerAsync();

      expect(h.scope.flushPending).toHaveBeenCalledOnce();
      expect(h.controller.currentModel()).toBe('core');
      expect(h.scope.pendingMessages).toEqual([successor]);
      expect(h.scope.restartCliProcess).toHaveBeenCalledOnce();
      const restartOptions = h.scope.restartCliProcess.mock.calls[0][1];
      expect(restartOptions.exactResumeSessionId).toBe('native');
      expect(restartOptions).not.toHaveProperty('restartCause');
    } finally {
      vi.useRealTimers();
    }
  });

  it('still delivers unfinished work saved by an earlier crash when an Auto continuation is queued', () => {
    const h = harness();
    const work = { turnOpen: true, tasks: [{ taskId: 'previous-task', kind: 'shell' as const }] };
    Object.assign(h.scope, {
      pendingRestartInterruption: work, reportedInterruptedTaskIds: new Set(),
      restartInterruptionNote, restartInterruptionNotice, restartNoteMayPrefix, prefixRestartNote,
      cliName: () => 'TRAE',
    });
    expect(h.switchModel(action, { resumeCurrentTurn: true })).toBe(true);
    const recovery = h.scope.pendingMessages[0];
    loadWorkerFunction<() => void>('deliverRestartInterruptionNote', h.scope)();
    expect(h.scope.pendingMessages).toEqual([recovery]);
    expect(recovery).toMatchObject({
      turnId: 'turn', traexAutoModelRecovery: true, noReplay: true,
      logicalContent: 'worker.traex_auto_model.continue_prompt',
    });
    expect(recovery.content).toBe(`${restartInterruptionNote(work)}\n\n${recovery.logicalContent}`);
    expect(h.scope.send).toHaveBeenLastCalledWith({
      type: 'user_notify', turnId: 'turn',
      message: restartInterruptionNotice(work, { cliName: 'TRAE', noteDelivered: true }),
    });
    expect(h.scope.pendingRestartInterruption).toBeUndefined();
    expect(h.scope.reportedInterruptedTaskIds.has('previous-task')).toBe(true);
  });

  it.each([
    { isFlushing: true }, { cliRestartInProgress: true }, { traexAutoModelTurnReplayForbidden: true },
    { lastInitConfig: { cliId: 'traex', model: 'core' } },
    { traexAutoModelRuntimeEligible: () => false },
  ])('does not advance the model or enqueue recovery when the runtime cannot safely resume (%j)', extra => {
    const h = harness(extra);
    expect(h.switchModel(action, { resumeCurrentTurn: true })).toBe(false);
    expect(h.controller.currentModel()).toBe('core');
    expect(h.scope.pendingMessages).toEqual([]);
    expect(h.scope.restartCliProcess).not.toHaveBeenCalled();
  });

  it('does not switch an exact durable delivery', () => {
    const authority = new ActiveTurnAuthority();
    authority.reserve({ turnId: 'turn', dispatchAttempt: 1 });
    authority.markStarted({ turnId: 'turn', dispatchAttempt: 1 });
    const h = harness({ activeTurnAuthority: authority });
    expect(h.switchModel(action, { resumeCurrentTurn: true })).toBe(false);
    expect(h.controller.currentModel()).toBe('core');
  });

  it('applies each model settings and clears old overrides for a native-default model', () => {
    const h = harness();
    h.controller.config.modelSettings = { core: {}, backup: { reasoningEffort: 'ultra', modelBackendVariant: 'max' } };
    expect(h.switchModel(action, { resumeCurrentTurn: true })).toBe(true);
    expect(h.scope.lastInitConfig).toMatchObject({ model: 'backup', reasoningEffort: 'ultra', modelBackendVariant: 'max' });
    h.scope.traexAutoModelSwitching = false;
    const reset = h.controller.beginTurn('next-turn');
    expect(h.switchModel(reset, { resumeCurrentTurn: false })).toBe(true);
    expect(h.scope.lastInitConfig.reasoningEffort).toBeUndefined();
    expect(h.scope.lastInitConfig.modelBackendVariant).toBeUndefined();
  });
});


describe('Auto live follow-up input policy', () => {
  it.each([
    { backend: {} }, { cliSpawnGeneration: 2 }, { currentBotmuxTurnId: 'other' },
    { renderer: {} }, { backendScreenRevision: 1 }, { observedPaneGridRevision: 1 },
    { cliRestartInProgress: true }, { traexAutoModelSwitching: true },
    { commandLineWritesPending: 1 }, { injectionFlushing: true },
    { sessionRenameInFlight: () => true }, { currentInputDeliveryQuarantine: () => ({}) },
    { currentPostTerminalInputFence: () => ({}) }, { shouldDeferUserFlush: () => true },
    { activeTurnBlocks: () => true },
  ])('rejects a late healthy read after its admission boundary changed (%j)', async changed => {
    let finish!: (screen: string) => void;
    const h = admissionHarness({ backend: { captureViewportAsync: () => new Promise<string>(resolve => { finish = resolve; }) } });
    const pending = h.admit();
    Object.assign(h.scope, changed);
    finish('◆ Working… (2s • esc to interrupt)');
    expect(await pending).toBe(false);
    expect(h.scope.pendingMessages).toEqual([h.item]);
    expect(h.item.trustedCaller.requestUserOpenId).toBe('original-caller');
    expect(h.scope.retryTraexAutoModelAdmission).toHaveBeenCalledOnce();
  });

  it.each(['head', 'pool'])('rejects a read for a replaced %s identity', async replaced => {
    let finish!: (screen: string) => void;
    const h = admissionHarness({ backend: { captureViewportAsync: () => new Promise<string>(resolve => { finish = resolve; }) } });
    const pending = h.admit();
    if (replaced === 'head') h.scope.pendingMessages[0] = { content: 'new', turnId: 'replacement' };
    else h.scope.traexAutoModelController.beginTurn('replacement');
    finish('◆ Working… (2s • esc to interrupt)');
    expect(await pending).toBe(false);
    expect(h.scope.pendingMessages).toHaveLength(1);
  });

  it('uses a separate fresh read for each consecutive input', async () => {
    const h = admissionHarness();
    const capture = h.scope.backend.captureViewportAsync;
    capture.mockResolvedValueOnce('◆ Working… (2s • esc to interrupt)')
      .mockResolvedValueOnce('◆ Queued for capacity (20s • esc to interrupt)');
    expect(await h.admit()).toBe(true);
    h.scope.pendingMessages.shift();
    h.scope.pendingMessages.push({ content: 'third', turnId: 'third' });
    expect(await h.admit()).toBe(false);
    expect(h.scope.pendingMessages[0].content).toBe('third');
  });

  it.each(['', 'unrecognized frame', '│ model: loading │\n❯ Ask anything', 'error', 'timeout'])(
    'retains unreadable input and retries successfully after %s', async frame => {
      vi.useFakeTimers();
      try {
        const read = vi.fn(() => frame === 'error' ? Promise.reject(new Error('capture failed'))
          : frame === 'timeout' ? new Promise<string>(() => {})
          : Promise.resolve(frame));
        const h = admissionHarness({ backend: { captureViewportAsync: read },
          cliAdapter: { startupPendingPattern: /│[ \t]+model:[ \t]+loading\b/ } });
        const pending = h.admit();
        if (frame === 'timeout') await vi.advanceTimersByTimeAsync(1_201);
        expect(await pending).toBe(false);
        expect(h.scope.pendingMessages).toEqual([h.item]);
        expect(h.scope.retryTraexAutoModelAdmission).toHaveBeenCalledOnce();
        read.mockImplementation(() => Promise.resolve('❯ Ask anything'));
        expect(await h.admit()).toBe(true);
        expect(h.scope.pendingMessages).toEqual([h.item]);
      } finally { vi.useRealTimers(); }
    });

  it('drains actual xterm parsing before judging a PTY repaint', async () => {
    const renderer = new TerminalRenderer(100, 24);
    try {
      const h = admissionHarness({ backend: {}, renderer });
      await renderer.writeAndFlush('◆ Working… (2s • esc to interrupt)');
      expect(await h.admit()).toBe(true);
      renderer.write('\x1b[2J\x1b[H◆ Queued for capacity (20s • esc to interrupt)');
      expect(await h.admit()).toBe(false);
      expect(h.scope.pendingMessages).toEqual([h.item]);
      renderer.write('\x1b[2J\x1b[H◆ Working… (3s • esc to interrupt)');
      expect(await h.admit()).toBe(true);
    } finally { renderer.dispose(); }
  });

  it('only admits the attributed recovery while waiting for first model activity', async () => {
    const h = admissionHarness({ backend: { captureViewportAsync: async () => '❯ Ask anything' } });
    h.scope.traexAutoModelController.beginTurn('turn');
    h.scope.traexAutoModelController.commitSwitch(action);
    expect(await h.admit()).toBe(false);
    Object.assign(h.item, { traexAutoModelRecovery: true, turnId: 'turn', noReplay: true });
    expect(await h.admit()).toBe(true);
    expect(h.item).toMatchObject({ noReplay: true, trustedCaller: { requestUserOpenId: 'original-caller' } });
  });

  it('does not release a healthy read if recovery starts while it is in flight', async () => {
    let finish!: (screen: string) => void;
    const h = admissionHarness({ backend: { captureViewportAsync: () => new Promise<string>(resolve => { finish = resolve; }) } });
    h.scope.traexAutoModelController.beginTurn('turn');
    const pending = h.admit();
    h.scope.traexAutoModelController.commitSwitch(action);
    finish('◆ Working… (2s • esc to interrupt)');
    expect(await pending).toBe(false);
    expect(h.scope.pendingMessages).toEqual([h.item]);
  });

  it('re-drives one held queue without replaying a consumed item', async () => {
    vi.useFakeTimers();
    const scope = { traexAutoModelAdmissionRetry: undefined, traexAutoModelRuntimeEligible: () => true,
      backend: {}, pendingMessages: [{}], flushPending: vi.fn() };
    try {
      const retry = loadWorkerFunction<() => void>('retryTraexAutoModelAdmission', scope);
      retry(); retry();
      await vi.advanceTimersByTimeAsync(201);
      expect(scope.flushPending).toHaveBeenCalledOnce();
      retry();
      scope.pendingMessages.length = 0;
      await vi.advanceTimersByTimeAsync(201);
      expect(scope.flushPending).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });

  it('holds a queued native viewport before ordinary FIFO delivery advances the Worker revision', async () => {
    const root = mkdtempSync(join(tmpdir(), 'auto-admission-'));
    const socket = `auto-admission-${process.pid}-${Date.now()}`;
    const fifo = join(root, 'output');
    const originalPath = process.env.PATH;
    const tmux = (...args: string[]) => execFileSync('tmux', ['-L', socket, ...args], { encoding: 'utf8', timeout: 2_000 });
    let reader: ReturnType<typeof createReadStream> | undefined;
    try {
      tmux('new-session', '-d', '-s', 'test', '-x', '100', '-y', '24',
        'stty -echo; while IFS= read -r line; do printf "\\033[2J\\033[H%s\\r\\n" "$line"; done');
      execFileSync('mkfifo', [fifo]);
      reader = createReadStream(fifo, { flags: 'r+' });
      let revision = 0;
      reader.on('data', () => { revision++; });
      tmux('pipe-pane', '-O', '-t', 'test:0.0', `cat > '${fifo}'`);
      const be = new TmuxPipeBackend('test:0.0', { socketName: socket });
      const repaint = (frame: string) => {
        tmux('send-keys', '-t', 'test:0.0', '-l', frame);
        tmux('send-keys', '-t', 'test:0.0', 'Enter');
        const deadline = Date.now() + 2_000;
        while (!tmux('capture-pane', '-p', '-t', 'test:0.0').includes(frame)) {
          if (Date.now() > deadline) throw new Error('native repaint did not arrive');
        }
      };
      const h = admissionHarness({ backend: be });
      repaint('◆ Working… (2s • esc to interrupt)');
      await new Promise(resolve => setTimeout(resolve, 50));
      const cachedAdmission = await h.admit();
      const before = revision;
      repaint('◆ Queued for capacity (20s • esc to interrupt)');
      expect(revision).toBe(before);
      expect(cachedAdmission).toBe(true);
      expect(await h.admit()).toBe(false);
      expect(h.scope.pendingMessages).toEqual([h.item]);
      const started = performance.now();
      let ticks = 0;
      const heartbeat = setInterval(() => { ticks++; }, 5);
      try {
        for (let i = 0; i < 30; i++) expect(await h.admit()).toBe(false);
      } finally { clearInterval(heartbeat); }
      expect(ticks).toBeGreaterThan(0);
      console.log(JSON.stringify({ measurement: 'async-auto-admission', count: 30, elapsedMs: performance.now() - started, heartbeatTicks: ticks }));

      // Slow the client before forwarding to the same real tmux server.
      // A timer wrapping sync capture would still freeze this heartbeat.
      const tmuxBin = execFileSync('which', ['tmux'], { encoding: 'utf8' }).trim();
      const wrapper = join(root, 'tmux');
      writeFileSync(wrapper, `#!/bin/sh\nsleep 0.2\nexec '${tmuxBin.replaceAll("'", "'\\''")}' "$@"\n`);
      chmodSync(wrapper, 0o755);
      process.env.PATH = `${root}${delimiter}${originalPath ?? ''}`;
      let slowTicks = 0;
      const slowHeartbeat = setInterval(() => { slowTicks++; }, 5);
      const slowStarted = performance.now();
      try {
        expect(await h.admit()).toBe(false);
      } finally { clearInterval(slowHeartbeat); }
      expect(slowTicks).toBeGreaterThan(5);
      console.log(JSON.stringify({ measurement: 'slow-native-client', elapsedMs: performance.now() - slowStarted, heartbeatTicks: slowTicks }));
      writeFileSync(wrapper, '#!/bin/sh\nexit 77\n');
      expect(await h.admit()).toBe(false);
      expect(h.scope.pendingMessages).toEqual([h.item]);
      process.env.PATH = originalPath;
      repaint('◆ Working… (3s • esc to interrupt)');
      expect(await h.admit()).toBe(true);
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      reader?.destroy();
      try { tmux('kill-server'); } catch { /* isolated server already gone */ }
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('holds follow-ups through the resumed continuation until its first model activity', async () => {
    const { traexCapacityQueueVisible, traexModelProgressVisible } = await import('../src/adapters/cli/traex.js');
    const h = harness();
    h.controller.commitSwitch(action);
    let frame = '❯ Ask anything';
    Object.assign(h.scope, { isPromptReady: false, backend: {}, commandLineWritesPending: 0,
      currentBotmuxTurnId: 'turn', captureBackendScreen: () => frame,
      traexCapacityQueueVisible, traexModelProgressVisible, traexQueuedTypeAheadVisible, traexCapacityQueuePosition: () => undefined,
      flushPending: vi.fn(async () => {}), publishActiveRuntime: vi.fn() });
    const hold = loadWorkerFunction<() => boolean>('traexAutoModelInputHold', h.scope);
    const observe = loadWorkerFunction<(screen: string) => void>('observeTraexAutoModelCapacity', h.scope);
    expect(hold()).toBe(true);
    observe(frame);
    expect(hold()).toBe(true);
    frame = '◆ Working… (2s • esc to interrupt)';
    observe(frame);
    expect(hold()).toBe(false);
    expect(h.scope.flushPending).toHaveBeenCalledOnce();
  });

  it.each([
    { eligible: true, switching: false, ready: false, screen: 'Working…', hold: false, admitted: true },
    { eligible: true, switching: false, ready: false, screen: '◆ Queued for capacity (20s • esc to interrupt)' + '\n'.repeat(50), hold: false, admitted: false },
    { eligible: true, switching: true, ready: true, screen: '', hold: true, admitted: false },
    { eligible: true, switching: false, ready: true, screen: '◆ Queued for capacity (20s • esc to interrupt)', hold: false, admitted: false },
    { eligible: false, switching: false, ready: false, screen: '◆ Queued for capacity (20s • esc to interrupt)', hold: false, admitted: true },
  ])('keeps synchronous policy screen-free while async admission fences capacity (%j)', async ({ eligible, switching, ready, screen, hold, admitted }) => {
    const { traexCapacityQueueVisible } = await import('../src/adapters/cli/traex.js');
    const scope = { traexAutoModelRuntimeEligible: () => eligible,
      traexAutoModelSwitching: switching, isPromptReady: ready, backend: {},
      captureBackendScreen: vi.fn(() => { throw new Error('synchronous hot-path capture'); }), traexCapacityQueueVisible };
    expect(loadWorkerFunction<() => boolean>('traexAutoModelInputHold', scope)()).toBe(hold);
    expect(scope.captureBackendScreen).not.toHaveBeenCalled();
    const h = admissionHarness({ traexAutoModelRuntimeEligible: () => eligible, traexAutoModelSwitching: switching,
      backend: { captureViewportAsync: async () => screen.replace(/^Working/, '◆ Working') } });
    expect(await h.admit()).toBe(admitted);
  });

  it.each([false, true])('lets a running follow-up keep its current model (reselect=%s)', reselectPerTurn => {
    const controller = new TraexAutoModelController({ enabled: true, models: ['core', 'backup'],
      queueTimeoutMs: 5_000, reselectPerTurn });
    controller.beginTurn('turn');
    controller.commitSwitch(action);
    const activeTurnAuthority = new ActiveTurnAuthority();
    activeTurnAuthority.reserve({ turnId: 'turn' });
    activeTurnAuthority.markStarted({ turnId: 'turn' });
    const scope = { traexAutoModelController: controller, traexAutoModelRuntimeEligible: () => true,
      pendingMessages: [{ turnId: 'followup' }], traexAutoModelSwitching: false,
      isPromptReady: false, traexAutoModelInputHold: () => false, activeTurnAuthority,
      queuedTypeAheadTurns: [],
      lastInitConfig: { cliSessionId: 'native' }, executeTraexAutoModelSwitch: vi.fn(() => true) };
    const reset = loadWorkerFunction<() => boolean>('resetTraexAutoModelBeforePendingTurn', scope);
    expect(reset()).toBe(false);
    expect(controller.currentModel()).toBe('backup');
    expect(scope.executeTraexAutoModelSwitch).not.toHaveBeenCalled();
    scope.isPromptReady = true;
    expect(reset()).toBe(reselectPerTurn);
    expect(scope.executeTraexAutoModelSwitch).toHaveBeenCalledTimes(reselectPerTurn ? 1 : 0);
  });

  it('holds a queued successor on a fallback until the composer after the predecessor terminal', () => {
    const controller = new TraexAutoModelController({ enabled: true, models: ['core', 'backup'],
      queueTimeoutMs: 5_000, reselectPerTurn: true });
    controller.beginTurn('turn');
    controller.commitSwitch(action);
    // The structured terminal has released the predecessor, but the PTY
    // composer has not been re-observed yet (isPromptReady stays false).
    const activeTurnAuthority = new ActiveTurnAuthority();
    const scope = { traexAutoModelController: controller, traexAutoModelRuntimeEligible: () => true,
      pendingMessages: [{ turnId: 'followup' }], traexAutoModelSwitching: false,
      isPromptReady: false, traexAutoModelInputHold: () => false, activeTurnAuthority,
      queuedTypeAheadTurns: [],
      lastInitConfig: { cliSessionId: 'native' }, executeTraexAutoModelSwitch: vi.fn(() => true) };
    const reset = loadWorkerFunction<() => boolean>('resetTraexAutoModelBeforePendingTurn', scope);
    expect(reset()).toBe(true);
    expect(scope.executeTraexAutoModelSwitch).not.toHaveBeenCalled();
    // Once the composer is observed, the normal switch branch restarts core.
    scope.isPromptReady = true;
    expect(reset()).toBe(true);
    expect(scope.executeTraexAutoModelSwitch).toHaveBeenCalledOnce();
  });

  it('holds a post-terminal successor even when per-turn reselection is disabled', () => {
    // The predecessor turn is gone and the composer is not back: the message
    // is a new independent turn, not a steer. Waiting for the idle edge is
    // required for correct turn attribution regardless of model reselection.
    const controller = new TraexAutoModelController({ enabled: true, models: ['core', 'backup'],
      queueTimeoutMs: 5_000, reselectPerTurn: false });
    controller.beginTurn('turn');
    controller.commitSwitch(action);
    const scope = { traexAutoModelController: controller, traexAutoModelRuntimeEligible: () => true,
      pendingMessages: [{ turnId: 'followup' }], traexAutoModelSwitching: false,
      isPromptReady: false, traexAutoModelInputHold: () => false,
      activeTurnAuthority: new ActiveTurnAuthority(), queuedTypeAheadTurns: [],
      lastInitConfig: { cliSessionId: 'native' }, executeTraexAutoModelSwitch: vi.fn(() => true) };
    const reset = loadWorkerFunction<() => boolean>('resetTraexAutoModelBeforePendingTurn', scope);
    expect(reset()).toBe(true);
    expect(scope.executeTraexAutoModelSwitch).not.toHaveBeenCalled();
    // With reselection off, the composer edge releases the write without a switch.
    scope.isPromptReady = true;
    expect(reset()).toBe(false);
    expect(scope.executeTraexAutoModelSwitch).not.toHaveBeenCalled();
  });

  it('still steers a successor already written as type-ahead after the predecessor terminal', () => {
    // A predecessor terminal releases the authority while a type-ahead
    // successor keeps running natively; BotMux's authority for it only
    // advances at the next prompt edge. The non-empty type-ahead queue keeps
    // the next correction flowing as a steer instead of holding for a
    // composer that will not arrive until the successor ends.
    const controller = new TraexAutoModelController({ enabled: true, models: ['core', 'backup'],
      queueTimeoutMs: 5_000, reselectPerTurn: true });
    controller.beginTurn('turn');
    controller.commitSwitch(action);
    const scope = { traexAutoModelController: controller, traexAutoModelRuntimeEligible: () => true,
      pendingMessages: [{ turnId: 'followup' }], traexAutoModelSwitching: false,
      isPromptReady: false, traexAutoModelInputHold: () => false,
      activeTurnAuthority: new ActiveTurnAuthority(),
      queuedTypeAheadTurns: [{ turnId: 'successor-turn' }],
      lastInitConfig: { cliSessionId: 'native' }, executeTraexAutoModelSwitch: vi.fn(() => true) };
    const reset = loadWorkerFunction<() => boolean>('resetTraexAutoModelBeforePendingTurn', scope);
    expect(reset()).toBe(false);
    expect(scope.executeTraexAutoModelSwitch).not.toHaveBeenCalled();
  });
});


describe('Worker Auto configuration boundary', () => {
  const pool = { enabled: true, models: ['core', 'backup'], queueTimeoutMs: 5_000 };
  function configure(extra: Record<string, unknown> = {}) {
    const cfg: any = { cliId: 'traex', model: 'auto', codexRpcInput: true, traexAutoModel: pool, prompt: '', ...extra };
    const scope: Record<string, any> = { lastInitConfig: { ...cfg }, TraexAutoModelController,
      resolveTraexAutoModelSettings, validTraexAutoModelRuntime: () => false };
    loadWorkerFunction<(cfg: any) => void>('configureTraexAutoModel', scope)(cfg);
    return { cfg, scope };
  }
  it('selects a concrete managed model and adapts the old RPC preference before launch', () => {
    const { cfg, scope } = configure();
    expect(cfg).toMatchObject({ model: 'core', codexRpcInput: false });
    expect(scope.lastInitConfig).toMatchObject({ model: 'core', codexRpcInput: false });
    expect(scope.traexAutoModelController.currentModel()).toBe('core');
  });
  it.each([
    { adoptMode: true }, { wrapperCli: 'wrapper' }, { cliLaunchMode: 'forge-traex' },
    { existingAppServerEndpoint: 'ws://localhost:1234' }, { cliId: 'codex' },
    { traexAutoModel: undefined },
  ])('keeps non-managed launches outside the controller (%j)', extra => {
    const { cfg, scope } = configure(extra);
    expect(scope.traexAutoModelController).toBeNull();
    expect(cfg.codexRpcInput).toBe(true);
    expect(cfg.model).toBe('auto');
    expect(scope.lastInitConfig.codexRpcInput).toBe(true);
  });
});

describe('Worker read-only capacity query', () => {
  function query() {
    const controller = new TraexAutoModelController({ enabled: true, models: ['core', 'backup'], queueTimeoutMs: 5_000 });
    controller.beginTurn('turn');
    const authority = new ActiveTurnAuthority();
    authority.reserve({ turnId: 'turn' }); authority.markStarted({ turnId: 'turn' });
    let resolveLoads!: (loads: Map<string, number>) => void;
    const loads = new Promise<Map<string, number>>(resolve => { resolveLoads = resolve; });
    const read = vi.fn((_options: any) => loads);
    const scope: Record<string, any> = {
      traexAutoModelController: controller, traexAutoModelRuntimeEligible: () => true,
      traexAutoModelSwitching: false, cliRestartInProgress: false, isFlushing: false,
      isPromptReady: false, traexAutoModelTurnReplayForbidden: false, commandLineWritesPending: 0,
      lastInitConfig: { cliSessionId: 'native', workingDir: '/workspace',
        env: { EXPLICIT: 'bot-value' }, envUnset: ['HTTP_PROXY', 'API_TOKEN'] },
      activeTurnAuthority: authority, currentBotmuxTurnId: 'turn', backend: {}, cliSpawnGeneration: 1,
      cliAdapter: { resolvedBin: 'traex' }, buildSessionChildEnv, botInjectedEnv,
      process: { env: { HTTP_PROXY: 'host-proxy', API_TOKEN: 'host-token', KEEP: 'yes' } },
      traexCapacityQueueVisible: () => true, traexCapacityQueuePosition: () => undefined,
      traexModelProgressVisible: () => false, traexQueuedTypeAheadVisible: () => false, readTraexModelLoads: read,
      executeTraexAutoModelSwitch: vi.fn(), publishActiveRuntime: vi.fn(), send: vi.fn(), log: vi.fn(),
    };
    const observe = loadWorkerFunction<(screen: string) => void>('observeTraexAutoModelCapacity', scope);
    vi.useFakeTimers(); vi.setSystemTime(0); observe('queue');
    vi.setSystemTime(5_000); observe('queue'); vi.useRealTimers();
    return { scope, read, resolveLoads, observe };
  }
  it('uses the composed set and unset layers for the read-only helper', async () => {
    const h = query();
    expect(h.read).toHaveBeenCalledOnce();
    const options = h.read.mock.calls[0]![0] as any;
    expect(options.env).toMatchObject({ KEEP: 'yes', EXPLICIT: 'bot-value' });
    expect(options.env).not.toHaveProperty('HTTP_PROXY');
    expect(options.env).not.toHaveProperty('API_TOKEN');
    h.resolveLoads(new Map([['core', 180], ['backup', 100]]));
    await Promise.resolve(); await Promise.resolve();
    expect(h.scope.executeTraexAutoModelSwitch).toHaveBeenCalledWith(expect.objectContaining({ toModel: 'backup' }), { resumeCurrentTurn: true });
  });
  it.each([
    { currentBotmuxTurnId: 'passthrough' }, { commandLineWritesPending: 1 },
    { traexAutoModelTurnReplayForbidden: true }, { isFlushing: true },
  ])('ignores a completed query after the input boundary changed (%j)', async changed => {
    const h = query(); Object.assign(h.scope, changed);
    h.resolveLoads(new Map([['core', 180], ['backup', 100]]));
    await Promise.resolve(); await Promise.resolve();
    expect(h.scope.executeTraexAutoModelSwitch).not.toHaveBeenCalled();
  });
  it.each([
    { currentBotmuxTurnId: 'passthrough' }, { commandLineWritesPending: 1 },
    { traexAutoModelTurnReplayForbidden: true }, { isFlushing: true },
  ])('continues ordered fallback after a rejected load reply (%j)', async changed => {
    const h = query();
    const previous = Object.fromEntries(Object.keys(changed).map(key => [key, h.scope[key]]));
    Object.assign(h.scope, changed);
    h.resolveLoads(new Map([['core', 180], ['backup', 100]]));
    await Promise.resolve(); await Promise.resolve();
    expect(h.scope.executeTraexAutoModelSwitch).not.toHaveBeenCalled();
    Object.assign(h.scope, previous);
    vi.useFakeTimers();
    try {
      vi.setSystemTime(10_000);
      h.observe('queue');
      expect(h.scope.executeTraexAutoModelSwitch).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'switch', turnId: 'turn', toModel: 'backup' }),
        { resumeCurrentTurn: true },
      );
    } finally { vi.useRealTimers(); }
  });
  it('checks loads again after queue activity ends and an input boundary rejects the pending reply', async () => {
    const h = query();
    // A real non-queued observation clears queueSinceMs while the helper is
    // still pending. The rejected reply must release that pending check too.
    h.scope.traexCapacityQueueVisible = (screen: string) => screen === 'queue';
    h.observe('working');
    h.scope.isFlushing = true;
    h.resolveLoads(new Map([['core', 180], ['backup', 100]]));
    await Promise.resolve(); await Promise.resolve();
    expect(h.scope.executeTraexAutoModelSwitch).not.toHaveBeenCalled();
    h.scope.isFlushing = false;
    vi.useFakeTimers();
    try {
      vi.setSystemTime(10_000); h.observe('queue');
      expect(h.read).toHaveBeenCalledOnce();
      vi.setSystemTime(15_000); h.observe('queue');
      expect(h.read).toHaveBeenCalledTimes(2);
      await Promise.resolve(); await Promise.resolve();
      expect(h.scope.executeTraexAutoModelSwitch).toHaveBeenCalledWith(
        expect.objectContaining({ turnId: 'turn', toModel: 'backup' }),
        { resumeCurrentTurn: true },
      );
    } finally { vi.useRealTimers(); }
  });
});


describe('Worker extra argv model boundary', () => {
  function extraArgs(value: string, auto = true, allow = true) {
    return loadWorkerFunction<() => string[]>('resolveCliExtraArgs', {
      cliAdapter: { allowExtraArgs: allow }, process: { env: { CLI_EXTRA_ARGS: value } },
      traexAutoModelRuntimeEligible: () => auto,
    })();
  }
  it.each(['-m outside', '-moutside', '--model outside', '--model=outside',
    '-c model=outside', '-cmodel=outside', '--config model=outside', '--config=model=outside', 'model=outside'])
  ('rejects model selection from environment argv (%s)', args => {
    expect(() => extraArgs(args)).toThrow(/cannot be overridden/);
  });
  it('preserves unrelated flags, ordinary model selection and fixed-contract adapters', () => {
    expect(extraArgs('  --verbose   --no-alt-screen  ')).toEqual(['--verbose', '--no-alt-screen']);
    expect(extraArgs('--model outside', false)).toEqual(['--model', 'outside']);
    expect(extraArgs('--model outside', true, false)).toEqual([]);
    expect(extraArgs('')).toEqual([]);
  });
});


describe('Auto input and shared-setting continuity', () => {
  it('marks a busy raw write as unsafe for exact resume before capture attribution changes', async () => {
    const h = harness({ isPromptReady: false });
    Object.assign(h.scope, {
      backend: {}, commandLineWritesPending: 0, pendingRawInputs: [],
      sendRawCommandLineWithRecoveryFence: vi.fn(async (_target, _content, beforeWrite) => beforeWrite()),
      applyMojoLivePatch: vi.fn(), renderer: { markNewTurn: vi.fn() },
      usageLimitTracker: { beginTurn: vi.fn() }, currentUsageLimitSnapshot: () => ({}), tmuxScrolledHalfPages: 0,
      setCaptureIdentity: vi.fn(() => { expect(h.scope.traexAutoModelTurnReplayForbidden).toBe(true); }),
      markTurnRetired: vi.fn(), markTurnExecutionStart: vi.fn(), stampMojoTurnMark: vi.fn(),
      writeCliPidMarker: vi.fn(), publishSandboxRelayCapability: vi.fn(),
      isEffortLevelCommand: () => false, claudeBtwQuestion: () => undefined,
      finalizeRawCommandDelivery: (input: any) => { if (input.accepted) input.onAccepted(); return input.accepted; },
      idleDetector: { reset: vi.fn() }, flushPending: vi.fn(async () => {}),
    });
    await loadWorkerFunction<(msg: any) => Promise<void>>('deliverRawInput', h.scope)({ type: 'raw_input', content: '/btw correction', turnId: 'raw' });
    expect(h.scope.sendRawCommandLineWithRecoveryFence).toHaveBeenCalledOnce();
    expect(h.switchModel(action, { resumeCurrentTurn: true })).toBe(false);
    expect(h.scope.restartCliProcess).not.toHaveBeenCalled();
  });
  it('uses the original shared settings for a model without its own entry', () => {
    const h = harness();
    const cfg = { cliId: 'traex', cliSessionId: 'native', model: 'auto', prompt: '',
      reasoningEffort: 'low', modelBackendVariant: 'standard', traexAutoModel: {
        enabled: true, models: ['core', 'backup'], queueTimeoutMs: 5_000,
        modelSettings: { core: { reasoningEffort: 'high', modelBackendVariant: 'max' } },
      } };
    h.scope.lastInitConfig = cfg;
    h.scope.TraexAutoModelController = TraexAutoModelController;
    loadWorkerFunction<(cfg: any) => void>('configureTraexAutoModel', h.scope)(cfg);
    expect(cfg).toMatchObject({ model: 'core', reasoningEffort: 'high', modelBackendVariant: 'max' });
    h.scope.traexAutoModelController.beginTurn('turn');
    expect(h.switchModel(action, { resumeCurrentTurn: true })).toBe(true);
    expect(cfg).toMatchObject({ model: 'backup', reasoningEffort: 'low', modelBackendVariant: 'standard' });
    // A fresh first init has resume=false; /restart still starts from the
    // last resolved model rather than the original daemon shared settings.
    cfg.traexAutoModel = { ...cfg.traexAutoModel, models: ['core', 'backup', 'new-backup'] };
    loadWorkerFunction<(cfg: any) => void>('configureTraexAutoModel', h.scope)(cfg);
    expect(cfg).toMatchObject({ model: 'core', reasoningEffort: 'high', modelBackendVariant: 'max' });
    h.scope.traexAutoModelController.beginTurn('turn'); h.scope.traexAutoModelSwitching = false;
    expect(h.switchModel(action, { resumeCurrentTurn: true })).toBe(true);
    expect(cfg).toMatchObject({ model: 'backup', reasoningEffort: 'low', modelBackendVariant: 'standard' });

  });
});


describe('same-worker Auto restart model continuity', () => {
  it.each([
    { cliId: 'traex', resume: true, cliSessionId: 'native', eligible: true, preserved: true },
    { cliId: 'traex', resume: true, cliSessionId: 'other', eligible: true, preserved: false },
    { cliId: 'traex', resume: true, cliSessionId: undefined, eligible: true, preserved: false },
    { cliId: 'traex', resume: false, cliSessionId: 'native', eligible: true, preserved: false },
    { cliId: 'traex', resume: true, cliSessionId: 'native', eligible: false, preserved: false },
    { cliId: 'claude-code', resume: true, cliSessionId: 'native', eligible: false, preserved: false },
  ])('passes the delivered catalog only to an eligible same-session Auto resume (%j)', ({ eligible, preserved, ...cfg }) => {
    const prepare = vi.fn(() => ({ prompt: '', diagnostics: [], pluginManifest: { pluginIds: [] } }));
    const scope = { lastInitConfig: { cliSessionId: 'native' },
      traexAutoModelRuntimeEligible: () => eligible,
      deliveredPluginSkillCatalogFingerprint: 'delivered',
      resolvePluginGenerationBot: () => ({ larkAppId: 'app' }), readGlobalConfig: () => ({}),
      prepareCliPluginGeneration: prepare, config: { session: { dataDir: '/data' } }, log: vi.fn() };
    loadWorkerFunction<(cfg: any, adapter: any) => void>('refreshCliPluginGeneration', scope)(
      { ...cfg, sessionId: 'session', workingDir: '/workspace', prompt: '' }, { id: cfg.cliId });
    expect(prepare).toHaveBeenCalledWith(expect.objectContaining({
      previousSkillCatalogFingerprint: preserved ? 'delivered' : undefined,
    }));
  });

  const pool = { enabled: true as const, models: ['core', 'backup'], queueTimeoutMs: 5_000 };
  function waitingController() {
    const controller = new TraexAutoModelController(pool, undefined,
      { reasoningEffort: 'low', modelBackendVariant: 'standard' });
    controller.beginTurn('turn');
    expect(controller.commitSwitch(action)).toBe(true);
    return controller;
  }

  it.each([undefined, false, true])('restores a validated runtime independently of the original resume flag (%s)', resume => {
    const runtime = { ...waitingController().runtimeState('native'), skillCatalogFingerprint: 'delivered' };
    const cfg = { cliId: 'traex', cliSessionId: 'native', resume, model: 'auto', prompt: '',
      traexAutoModel: pool, traexAutoModelRuntime: runtime };
    const scope: Record<string, any> = { lastInitConfig: { ...cfg }, traexAutoModelController: null,
      TraexAutoModelController, resolveTraexAutoModelSettings, validTraexAutoModelRuntime };
    loadWorkerFunction<(cfg: any) => void>('configureTraexAutoModel', scope)(cfg);
    expect(cfg).toMatchObject({ model: 'backup', reasoningEffort: 'low', modelBackendVariant: 'standard' });
    expect(scope.lastInitConfig.model).toBe('backup');
    expect(scope.traexAutoModelController.runtimeState('native')).toMatchObject({ waitingOnFinalModel: true });
    expect(scope.deliveredPluginSkillCatalogFingerprint).toBe('delivered');
    scope.traexAutoModelController.beginTurn('next');
    expect(scope.traexAutoModelController.observeCapacityQueue({ turnId: 'next', queued: true, nowMs: 0 })).toEqual({ kind: 'none' });
    expect(scope.traexAutoModelController.observeCapacityQueue({ turnId: 'next', queued: true, nowMs: 60_000 })).toEqual({ kind: 'none' });
  });

  it.each([false, true])('preserves the live model, hold and newest catalog across a restart IPC configuration (%s)', resume => {
    const stale = { ...new TraexAutoModelController(pool).runtimeState('native'), skillCatalogFingerprint: 'old-catalog' };
    const lastInitConfig = { cliId: 'traex', cliSessionId: 'native', resume, model: 'core', prompt: 'original ask',
      traexAutoModel: pool, traexAutoModelRuntime: stale };
    const scope: Record<string, any> = { lastInitConfig, traexAutoModelController: waitingController(),
      deliveredPluginSkillCatalogFingerprint: 'new-catalog',
      TraexAutoModelController, resolveTraexAutoModelSettings, validTraexAutoModelRuntime };
    loadWorkerFunction<(cfg: any) => void>('configureTraexAutoModel', scope)({ ...lastInitConfig, prompt: '' });
    expect(lastInitConfig.model).toBe('backup');
    expect(scope.traexAutoModelController.runtimeState('native')).toMatchObject({ model: 'backup', waitingOnFinalModel: true });
    expect(scope.deliveredPluginSkillCatalogFingerprint).toBe('new-catalog');
  });

  it.each([
    { nativeSessionId: 'another-native' }, { policyKey: 'different-policy' }, { model: 'outside' },
  ])('rejects an unrelated runtime without adopting its catalog (%j)', changed => {
    const cfg = { cliId: 'traex', cliSessionId: 'native', resume: true, model: 'auto', prompt: '', traexAutoModel: pool,
      traexAutoModelRuntime: { ...waitingController().runtimeState('native'), skillCatalogFingerprint: 'unrelated', ...changed } };
    const scope: Record<string, any> = { lastInitConfig: cfg, traexAutoModelController: null,
      TraexAutoModelController, resolveTraexAutoModelSettings, validTraexAutoModelRuntime };
    loadWorkerFunction<(cfg: any) => void>('configureTraexAutoModel', scope)(cfg);
    expect(cfg.model).toBe('core');
    expect(scope.traexAutoModelController.runtimeState('native').waitingOnFinalModel).toBe(false);
    expect(scope.deliveredPluginSkillCatalogFingerprint).toBeUndefined();
  });

  it('retains the selected model when fresh init did not set resume=true', () => {
    const pool = { enabled: true as const, models: ['core', 'backup'], queueTimeoutMs: 5_000 };
    const controller = new TraexAutoModelController(pool);
    const persisted = controller.runtimeState('native');
    controller.observeRunningModel('backup');
    const cfg = { cliId: 'traex', cliSessionId: 'native', model: 'backup', prompt: '', traexAutoModel: pool,
      traexAutoModelRuntime: persisted };
    const scope: Record<string, any> = { traexAutoModelController: controller, lastInitConfig: cfg,
      TraexAutoModelController, resolveTraexAutoModelSettings, validTraexAutoModelRuntime };
    loadWorkerFunction<(cfg: any) => void>('configureTraexAutoModel', scope)(cfg);
    expect(cfg.model).toBe('backup');
    expect(scope.traexAutoModelController.currentModel()).toBe('backup');
  });
});


describe('live-only model effort on capacity switch', () => {
  it('keeps the shared effort for an unknown model after live settings were accepted', () => {
    const h = harness({ cliModelSupportsReasoningEffort: () => false });
    h.scope.lastInitConfig.reasoningEffort = 'xhigh';
    expect(h.switchModel(action, { resumeCurrentTurn: true })).toBe(true);
    expect(h.scope.lastInitConfig.reasoningEffort).toBe('xhigh');
  });
});


it('preserves handwritten shared effort when switching to a known model with a stale static table', () => {
  const h = harness({ cliModelSupportsReasoningEffort: () => false });
  const controller = new TraexAutoModelController({ enabled: true, models: ['core', 'gpt-6-astra'], queueTimeoutMs: 5_000 },
    undefined, { reasoningEffort: 'ultra' });
  controller.beginTurn('turn');
  h.scope.traexAutoModelController = controller;
  h.scope.lastInitConfig.reasoningEffort = 'ultra';
  expect(h.switchModel({ ...action, toModel: 'gpt-6-astra' }, { resumeCurrentTurn: true })).toBe(true);
  expect(h.scope.lastInitConfig.reasoningEffort).toBe('ultra');
  expect(h.scope.restartCliProcess).toHaveBeenCalledOnce();
});

describe('Auto legacy parked-input admission', () => {
  it.each([
    ['active legacy work with a parked successor', '⠋ Any second now…\nQueued for next turn\nContext 65% left', true],
    ['parking without active work', 'Queued for next turn\nContext 65% left', false],
    ['capacity with a parked successor', '◆ Queued for capacity (10s • esc to interrupt)\nQueued for next turn\nContext 65% left', false],
    ['quoted work above parking', 'A reply quotes ⠋ Any second now…\nQueued for next turn\nContext 65% left', false],
    ['unknown content separating work from parking', '⠋ Any second now…\nunknown surface\nQueued for next turn\nContext 65% left', false],
    ['a draft below a parked successor', '⠋ Any second now…\nQueued for next turn\nmy unsent draft', false],
  ])('%s has the expected input admission', async (_name, screen, expected) => {
    const h = admissionHarness({ backend: { captureViewportAsync: vi.fn(async () => screen) } });
    expect(await h.admit()).toBe(expected);
  });
});

it('holds static capacity text while an otherwise ready composer stays rendered', async () => {
  const screen = "Too many requests right now. You're in the queue at position 3.\n\n❯ Ask anything";
  const h = admissionHarness({ backend: { captureViewportAsync: async () => screen } });
  expect(await h.admit()).toBe(false);
  expect(h.scope.pendingMessages).toEqual([h.item]);
  expect(h.scope.retryTraexAutoModelAdmission).toHaveBeenCalledOnce();
});
