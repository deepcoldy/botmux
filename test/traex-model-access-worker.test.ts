import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';
import { TraexAutoModelController, TRAEX_AUTO_MODEL_DEFAULT_PREFLIGHT_TIMEOUT_MS, TRAEX_AUTO_MODEL_DEFAULT_OVERLOAD_THRESHOLD_PERCENT } from '../src/services/traex-auto-model.js';
import { TRAEX_MODEL_ACCESS_ERROR_CODE } from '../src/services/traex-model-access.js';
import { TRAEX_QUOTA_ERROR_CODE } from '../src/services/traex-quota.js';
import { ActiveTurnAuthority } from '../src/core/active-turn-authority.js';
import { InflightInputTracker } from '../src/core/inflight-input-tracker.js';
import { traexCapacityQueueVisible, traexCapacityQueuePosition, traexModelProgressVisible, traexQueuedTypeAheadVisible } from '../src/adapters/cli/traex.js';
import { sendCriticalControlKey, isCriticalInterruptKey, TERMINAL_CANCEL_COOLDOWN_MS } from '../src/adapters/backend/critical-control-key.js';

const models = ['GPT-6.1-Sol', 'GPT-5.6-Sol', 'DeepSeek-V4-Flash'];
afterEach(() => vi.useRealTimers());
function fixture(extra: Record<string, unknown> = {}) {
  const controller = new TraexAutoModelController({ enabled: true, models, queueTimeoutMs: 5000 });
  controller.beginTurn('turn');
  const authority = new ActiveTurnAuthority();
  authority.reserve({ turnId: 'turn' }); authority.markStarted({ turnId: 'turn' });
  const tracker = new InflightInputTracker(); tracker.onWrite({ content: 'original task', turnId: 'turn' });
  const retirement = vi.spyOn(tracker, 'retireTurn');
  let resolve!: (value: any) => void;
  const catalog = new Promise<any>(done => { resolve = done; });
  const scope: Record<string, any> = {
    traexAutoModelRuntimeEligible: () => true, traexAutoModelController: controller,
    activeTurnAuthority: authority, currentBotmuxTurnId: 'turn', cliSpawnGeneration: 1,
    lastInitConfig: { cliSessionId: 'native', model: models[0] }, backend: {},
    TRAEX_MODEL_ACCESS_ERROR_CODE, TRAEX_QUOTA_ERROR_CODE, TRAEX_AUTO_MODEL_DEFAULT_PREFLIGHT_TIMEOUT_MS, TRAEX_AUTO_MODEL_DEFAULT_OVERLOAD_THRESHOLD_PERCENT,
    currentTraexLoadSnapshot: vi.fn(() => catalog), currentTraexQuotas: vi.fn(), rememberTraexModelLoadSnapshot: vi.fn(),
    publishActiveRuntime: vi.fn(), emitReadyCodexTurns: vi.fn(), idleDetector: { fireIdle: vi.fn() },
    inflightInputs: tracker, pendingMessages: [], currentBotmuxCallerOpenId: 'caller',
    applyTraexAutoModelSettings: (cfg: any, _pool: unknown, model: string) => { cfg.model = model; },
    restartCliProcess: vi.fn(async () => {}), log: vi.fn(), send: vi.fn(), t: (key: string) => key,
    traexAutoModelSwitching: false, cliRestartInProgress: false, isFlushing: false,
    currentInputDeliveryQuarantine: () => null,
    ...extra,
  };
  scope.holdTraexRecoveryForStop = loadWorkerFunction('holdTraexRecoveryForStop', scope);
  scope.settleStoppedTraexRecovery = loadWorkerFunction('settleStoppedTraexRecovery', scope);
  scope.enqueueTraexAutoModelRecovery = loadWorkerFunction('enqueueTraexAutoModelRecovery', scope);
  scope.executeTraexAutoModelSwitch = loadWorkerFunction('executeTraexAutoModelSwitch', scope);
  const recover = loadWorkerFunction<(turn: any) => boolean>('recoverTraexQuotaTurn', scope);
  const notify = loadWorkerFunction<(turnId: string, queued: boolean, progressing: boolean, completed?: boolean) => void>('notifyTraexModelAccessSwitchActivity', scope);
  const turn = { turnId: 'turn', sourceTurnId: 'native-turn', terminalStatus: 'failed', terminalErrorCode: TRAEX_MODEL_ACCESS_ERROR_CODE };
  return { scope, controller, authority, retirement, recover, notify, turn, resolve };
}
function loads() { return { loads: new Map(models.map((model, index) => [model.toLowerCase(), index * 10])) }; }
async function switched(f: ReturnType<typeof fixture>) {
  f.resolve(loads());
  await vi.waitFor(() => expect(f.scope.restartCliProcess).toHaveBeenCalledOnce());
}
function replacementReady(f: ReturnType<typeof fixture>) {
  f.scope.traexAutoModelSwitching = false; f.scope.cliRestartInProgress = false; f.scope.backend = {};
}

function capacityObserver(f: ReturnType<typeof fixture>, result: Promise<any>) {
  Object.assign(f.scope, { isPromptReady: false, commandLineWritesPending: 0,
    cliAdapter: { resolvedBin: 'unused-probe' }, buildSessionChildEnv: () => ({}), botInjectedEnv: () => ({}),
    readTraexModelLoadSnapshot: vi.fn(() => result), traexCapacityQueueVisible, traexCapacityQueuePosition,
    traexModelProgressVisible, traexQueuedTypeAheadVisible, flushPending: vi.fn(),
  });
  f.scope.notifyTraexModelAccessSwitchActivity = f.notify;
  return loadWorkerFunction<(screen: string) => void>('observeTraexAutoModelCapacity', f.scope);
}
const queuedScreen = '◆ Queued for capacity (20s • esc to interrupt)\n  You are in the queue at position 30.\nContext 99% left';
async function drainPromises() { for (let i = 0; i < 12; i++) await Promise.resolve(); }

describe('model access recovery Worker boundary', () => {
  it('records the confirmed refusal before a pending directory read or process loss', () => {
    const f = fixture(); f.recover(f.turn);
    const persisted = JSON.parse(JSON.stringify(f.controller.runtimeState('native')));
    expect(persisted.modelAccessRecovery).toMatchObject({ blockedModels: [models[0]], turnId: 'turn' });
    const restored = new TraexAutoModelController(f.controller.config, persisted);
    const next = restored.observeModelAccessFailure('turn', null);
    expect(next).toMatchObject({ kind: 'switch', toModel: models[1] });
    expect(f.scope.restartCliProcess).not.toHaveBeenCalled();
  });
  it('does not launch fresh capacity reads while an access failure is held', async () => {
    const f = fixture(); const observe = capacityObserver(f, new Promise(() => {}));
    vi.useFakeTimers(); f.recover(f.turn);
    observe(queuedScreen); await vi.advanceTimersByTimeAsync(6000); observe(queuedScreen);
    expect(f.scope.readTraexModelLoadSnapshot).not.toHaveBeenCalled();
    expect(f.scope.restartCliProcess).not.toHaveBeenCalled();
  });
  it('rejects an older in-flight capacity result after admitting an access refusal', async () => {
    const f = fixture(); let capacityResult!: (value: any) => void;
    const observe = capacityObserver(f, new Promise(resolve => { capacityResult = resolve; }));
    vi.useFakeTimers(); observe(queuedScreen);
    await vi.advanceTimersByTimeAsync(5001); observe(queuedScreen);
    expect(f.scope.readTraexModelLoadSnapshot).toHaveBeenCalledOnce();
    f.recover(f.turn); capacityResult(loads()); await drainPromises();
    expect(f.scope.restartCliProcess).not.toHaveBeenCalled();
    expect(f.scope.rememberTraexModelLoadSnapshot).not.toHaveBeenCalled();
    expect(f.controller.currentModel()).toBe(models[0]);
    expect(f.controller.runtimeState('native').modelAccessRecovery?.blockedModels).toEqual([models[0]]);
    f.resolve(loads()); await drainPromises();
    expect(f.scope.restartCliProcess).toHaveBeenCalledOnce();
    expect(f.controller.currentModel()).toBe(models[1]);
  });
  it('continues an active access search when the next model reports confirmed quota exhaustion', async () => {
    const f = fixture(); f.recover(f.turn); await switched(f); replacementReady(f);
    f.scope.currentTraexLoadSnapshot.mockResolvedValue(loads());
    expect(f.recover({ ...f.turn, sourceTurnId: 'quota-candidate', terminalErrorCode: TRAEX_QUOTA_ERROR_CODE })).toBe(true);
    await vi.waitFor(() => expect(f.scope.restartCliProcess).toHaveBeenCalledTimes(2));
    expect(f.controller.currentModel()).toBe(models[2]);
    expect(f.controller.runtimeState('native').modelAccessRecovery?.blockedModels).toEqual(models.slice(0, 2));
    expect(f.scope.currentTraexQuotas).not.toHaveBeenCalled();
  });
  it('preserves ordinary capacity-mode quota behavior outside an access search', () => {
    const f = fixture(); expect(f.recover({ ...f.turn, terminalErrorCode: TRAEX_QUOTA_ERROR_CODE })).toBe(false);
    expect(f.scope.currentTraexLoadSnapshot).not.toHaveBeenCalled();
    expect(f.scope.currentTraexQuotas).not.toHaveBeenCalled();
  });
  it('holds one failed terminal, retires the original and requests exact native continuation', async () => {
    const f = fixture();
    expect(f.recover(f.turn)).toBe(true); expect(f.recover(f.turn)).toBe(true);
    expect(f.scope.currentTraexLoadSnapshot).toHaveBeenCalledOnce();
    expect(f.scope.currentTraexQuotas).not.toHaveBeenCalled();
    await switched(f);
    expect(f.controller.currentModel()).toBe(models[1]);
    expect(f.retirement).toHaveBeenCalledWith('turn');
    expect(f.scope.pendingMessages).toEqual([expect.objectContaining({ turnId: 'turn', noReplay: true, traexAutoModelRecovery: true })]);
    expect(f.scope.pendingMessages[0].content).not.toBe('original task');
    expect(f.scope.restartCliProcess).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      exactResumeSessionId: 'native', preservePending: true, skipRestartBudget: true, restartCause: 'traex-auto-model',
    }));
    expect(f.scope.emitReadyCodexTurns).not.toHaveBeenCalled();
  });
  it('continues through consecutive failures without duplicating the attributed recovery input', async () => {
    const f = fixture(); f.recover(f.turn); await switched(f); replacementReady(f);
    f.scope.currentTraexLoadSnapshot.mockResolvedValue(loads());
    expect(f.recover({ ...f.turn, sourceTurnId: 'next-native-turn' })).toBe(true);
    await vi.waitFor(() => expect(f.scope.restartCliProcess).toHaveBeenCalledTimes(2));
    expect(f.controller.currentModel()).toBe(models[2]);
    expect(f.scope.pendingMessages).toHaveLength(1);
    expect(f.controller.runtimeState('native').modelAccessRecovery?.blockedModels).toEqual(models.slice(0, 2));
  });
  it('does not announce a non-queued success before actual replacement activity', async () => {
    const f = fixture(); f.recover(f.turn); await switched(f);
    expect(f.scope.send).toHaveBeenCalledWith(expect.objectContaining({ message: 'worker.traex_auto_model.access_search' }));
    f.notify('turn', false, true);
    expect(f.scope.send).toHaveBeenCalledTimes(1);
    replacementReady(f); f.notify('turn', false, false);
    expect(f.scope.send).toHaveBeenCalledTimes(1);
    vi.useFakeTimers();
    f.controller.observeCapacityQueue({ turnId: 'turn', queued: false, progressing: true, nowMs: Date.now() });
    f.notify('turn', false, true);
    expect(f.scope.send).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(2001);
    f.controller.observeCapacityQueue({ turnId: 'turn', queued: false, progressing: true, nowMs: Date.now() });
    f.notify('turn', false, true);
    expect(f.scope.send).toHaveBeenLastCalledWith(expect.objectContaining({ message: 'worker.traex_auto_model.access_available_model' }));
    f.notify('turn', false, true);
    expect(f.scope.send).toHaveBeenCalledTimes(2);
  });
  it('confirms a fast candidate from its successful native terminal', async () => {
    const f = fixture(); f.recover(f.turn); await switched(f); replacementReady(f);
    f.notify('turn', false, true, true);
    expect(f.scope.send).toHaveBeenLastCalledWith(expect.objectContaining({ message: 'worker.traex_auto_model.access_available_model' }));
  });
  it('announces real queueing rather than a misleading free-model success from low catalog load', async () => {
    const f = fixture(); f.recover(f.turn); await switched(f); replacementReady(f);
    f.notify('turn', true, false);
    expect(f.scope.send).toHaveBeenLastCalledWith(expect.objectContaining({ message: 'worker.traex_auto_model.access_queued_model' }));
  });
  it('announces a final queued wait without claiming immediate availability', async () => {
    const f = fixture(); f.recover(f.turn); await switched(f); replacementReady(f);
    f.scope.traexAutoModelController = new TraexAutoModelController(f.controller.config, {
      ...f.controller.runtimeState('native'), waitingOnFinalModel: true,
    });
    f.notify('turn', true, false);
    expect(f.scope.send).toHaveBeenLastCalledWith(expect.objectContaining({ message: 'worker.traex_auto_model.access_wait' }));
  });
  it('does not relabel a final queue candidate as a newly discovered first-free model when it completes', async () => {
    const f = fixture(); f.recover(f.turn); await switched(f); replacementReady(f);
    f.scope.traexAutoModelController = new TraexAutoModelController(f.controller.config, {
      ...f.controller.runtimeState('native'), waitingOnFinalModel: true,
    });
    f.notify('turn', false, true, true);
    expect(f.scope.send).toHaveBeenLastCalledWith(expect.objectContaining({ message: 'worker.traex_auto_model.access_selected_model' }));
  });
  it('does not publish a stale candidate success after its native turn fails', async () => {
    const f = fixture(); f.recover(f.turn); await switched(f); replacementReady(f);
    f.scope.currentTraexLoadSnapshot.mockReturnValue(new Promise(() => {}));
    expect(f.recover({ ...f.turn, sourceTurnId: 'candidate-failed' })).toBe(true);
    expect(f.scope.traexModelAccessSwitchNotice).toBeUndefined();
    f.notify('turn', false, true);
    expect(f.scope.send).toHaveBeenCalledTimes(1);
  });
  it.each(['generation', 'session', 'backend', 'cancel', 'authority'])('ignores a late directory result after %s changes', async change => {
    const f = fixture(); expect(f.recover(f.turn)).toBe(true);
    if (change === 'generation') f.scope.cliSpawnGeneration++;
    if (change === 'session') f.scope.lastInitConfig.cliSessionId = 'other';
    if (change === 'backend') f.scope.backend = {};
    if (change === 'cancel') f.scope.traexQuotaPending = undefined;
    if (change === 'authority') f.scope.activeTurnAuthority = new ActiveTurnAuthority();
    f.resolve(loads()); await new Promise(resolve => setImmediate(resolve));
    expect(f.scope.restartCliProcess).not.toHaveBeenCalled();
    expect(f.scope.emitReadyCodexTurns).not.toHaveBeenCalled();
  });
  it('settles the original failure if Auto is disabled during directory IO', async () => {
    const f = fixture(); f.recover(f.turn); f.scope.traexAutoModelController = null;
    f.resolve(loads()); await vi.waitFor(() => expect(f.scope.emitReadyCodexTurns).toHaveBeenCalledWith([f.turn]));
    expect(f.scope.restartCliProcess).not.toHaveBeenCalled();
  });
  it.each([
    { traexAutoModelTurnReplayForbidden: true }, { cliRestartInProgress: true },
    { traexAutoModelRuntimeEligible: () => false }, { lastInitConfig: {} },
  ])('does not recover an unsafe runtime: %j', extra => {
    const f = fixture(extra); expect(f.recover(f.turn)).toBe(false);
    expect(f.scope.currentTraexLoadSnapshot).not.toHaveBeenCalled();
  });
  it.each([
    { terminalErrorCode: 'codex_upstream_error' }, { terminalErrorCode: 'codex_auth_failed' },
    { terminalStatus: 'completed' }, { sourceTurnId: undefined }, { isLocal: true },
    { dispatchAttempt: 1 }, { supersededTurns: [{ turnId: 'steer' }] },
  ])('does not recover an unrelated or unsafe terminal: %j', extra => {
    const f = fixture(); expect(f.recover({ ...f.turn, ...extra })).toBe(false);
    expect(f.scope.currentTraexLoadSnapshot).not.toHaveBeenCalled();
  });
  it('settles all-restricted exhaustion once, without another restart', async () => {
    const f = fixture();
    for (let i = 0; i < models.length - 1; i++) {
      const action = f.controller.observeModelAccessFailure('turn', null);
      if (action.kind === 'switch') f.controller.commitSwitch(action);
    }
    f.recover(f.turn); f.resolve(null);
    await vi.waitFor(() => expect(f.scope.emitReadyCodexTurns).toHaveBeenCalledOnce());
    expect(f.turn).toMatchObject({ terminalErrorSummary: 'worker.traex_auto_model.access_exhausted' });
    expect(f.scope.restartCliProcess).not.toHaveBeenCalled();
  });
  it('does not treat a bare Escape menu key as a request to stop ordinary Auto recovery', async () => {
    const f = fixture({ backend: { sendSpecialKeys: () => true }, cliAdapter: { id: 'traex' },
      isRemoteBackendType: () => false, isCriticalInterruptKey, sendCriticalControlKey,
      TMUX_KEY_MAP: { esc: 'Escape' }, scheduleOneShotAfterAction: vi.fn(),
      retireDoubaoBridgeTurnOnInterrupt: () => false,
    });
    f.scope.nativeSessionForkPending = loadWorkerFunction('nativeSessionForkPending', f.scope);
    f.scope.runAfterAmbiguousSubmissionWrites = loadWorkerFunction('runAfterAmbiguousSubmissionWrites', f.scope);
    f.scope.sendTermActionOnce = loadWorkerFunction('sendTermActionOnce', f.scope);
    await loadWorkerFunction<(key: string) => Promise<void>>('handleTermAction', f.scope)('esc');
    expect(f.controller.recoveryStopped('turn')).toBe(false);
  });
  it.each([true, false])('stop retry wins over lookup completion, with second delivery=%s', async secondDelivery => {
    const f = fixture({ backend: { sendSpecialKeys: vi.fn().mockReturnValueOnce(false).mockReturnValue(secondDelivery) },
      cliAdapter: { id: 'traex' }, isRemoteBackendType: () => false,
      isCriticalInterruptKey, sendCriticalControlKey, retireDoubaoBridgeTurnOnInterrupt: () => false,
      TMUX_KEY_MAP: { ctrlc: 'C-c' }, PTY_SEQ_MAP: { ctrlc: '\u0003' }, cliName: () => 'TRAE',
      scheduleOneShotAfterAction: vi.fn(),
    });
    f.scope.nativeSessionForkPending = loadWorkerFunction('nativeSessionForkPending', f.scope);
    f.scope.runAfterAmbiguousSubmissionWrites = loadWorkerFunction('runAfterAmbiguousSubmissionWrites', f.scope);
    f.scope.sendTermActionOnce = vi.fn(loadWorkerFunction('sendTermActionOnce', f.scope));
    f.scope.restartCliProcess.mockImplementation(async () => { f.scope.backend = {}; f.scope.cliSpawnGeneration++; });
    vi.useFakeTimers(); f.recover(f.turn);
    const stopping = loadWorkerFunction<(key: string) => Promise<void>>('handleTermAction', f.scope)('ctrlc');
    expect(f.scope.sendTermActionOnce).toHaveBeenCalledOnce();
    f.resolve(loads()); await drainPromises();
    expect(f.scope.restartCliProcess).not.toHaveBeenCalled();
    expect(f.scope.traexQuotaPending.stopRequested).toBe(true);
    expect(f.controller.runtimeState('native').stoppedRecoveryTurnId).toBe('turn');
    await vi.advanceTimersByTimeAsync(TERMINAL_CANCEL_COOLDOWN_MS + 1); await stopping;
    expect(f.scope.sendTermActionOnce).toHaveBeenCalledTimes(2);
    expect(f.scope.emitReadyCodexTurns).toHaveBeenCalledOnce();
    expect(f.scope.traexQuotaPending).toBeUndefined();
    expect(f.scope.restartCliProcess).not.toHaveBeenCalled();
    const warnings = f.scope.send.mock.calls.filter(([message]: any[]) => message.message === 'worker.interrupt_unconfirmed');
    expect(warnings).toHaveLength(secondDelivery ? 0 : 1);
  });
  it('an exact-turn stop also holds recovery throughout real key retries', async () => {
    const f = fixture({ backend: { sendSpecialKeys: vi.fn().mockReturnValueOnce(false).mockReturnValue(true) },
      cliAdapter: { id: 'traex' }, isRemoteBackendType: () => false, isCodexAppCliId: () => false,
      sendCriticalControlKey, retireDoubaoBridgeTurnOnInterrupt: () => false,
      TMUX_KEY_MAP: { ctrlc: 'C-c' }, PTY_SEQ_MAP: { ctrlc: '\u0003' }, scheduleOneShotAfterAction: vi.fn(),
    });
    f.scope.nativeSessionForkPending = loadWorkerFunction('nativeSessionForkPending', f.scope);
    f.scope.runAfterAmbiguousSubmissionWrites = loadWorkerFunction('runAfterAmbiguousSubmissionWrites', f.scope);
    f.scope.sendTermActionOnce = vi.fn(loadWorkerFunction('sendTermActionOnce', f.scope));
    vi.useFakeTimers(); f.recover(f.turn);
    const stopping = loadWorkerFunction<(id: string, turnId: string) => Promise<void>>('handleExactTurnInterrupt', f.scope)('request', 'turn');
    f.resolve(loads()); await drainPromises(); expect(f.scope.restartCliProcess).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(TERMINAL_CANCEL_COOLDOWN_MS + 1); await stopping;
    expect(f.scope.emitReadyCodexTurns).toHaveBeenCalledOnce();
    expect(f.scope.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'turn_interrupt_result', delivered: true }));
    expect(f.scope.traexQuotaPending).toBeUndefined();
  });
  it('a delivered stop key cancels the held failure and its late lookup', async () => {
    const f = fixture({ cliAdapter: { id: 'traex' }, isRemoteBackendType: () => false,
      isCriticalInterruptKey: () => true, retireDoubaoBridgeTurnOnInterrupt: () => false,
      runAfterAmbiguousSubmissionWrites: async (_be: unknown, action: () => unknown) => action(),
      sendCriticalControlKey: async (_key: string, action: () => unknown) => action(),
      sendTermActionOnce: vi.fn(() => true), scheduleOneShotAfterAction: vi.fn(),
    });
    f.scope.nativeSessionForkPending = loadWorkerFunction('nativeSessionForkPending', f.scope);
    f.recover(f.turn);
    await loadWorkerFunction<(key: string) => Promise<void>>('handleTermAction', f.scope)('ctrlc');
    expect(f.scope.emitReadyCodexTurns).toHaveBeenCalledOnce();
    f.resolve(loads()); await new Promise(resolve => setImmediate(resolve));
    expect(f.scope.restartCliProcess).not.toHaveBeenCalled();
  });
});
