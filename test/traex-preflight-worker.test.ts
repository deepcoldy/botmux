import { describe, expect, it, vi } from 'vitest';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';
import {
  TraexAutoModelController,
  traexAutoModelPreflightEnabled,
} from '../src/services/traex-auto-model.js';
import { ActiveTurnAuthority } from '../src/core/active-turn-authority.js';

class CliSpawnSupersededError extends Error {}

function coldStartPreflight(controller: TraexAutoModelController, loads = new Map([['core', 101], ['backup', 100]])) {
  const cfg: any = { type: 'init', cliId: 'traex', prompt: 'original', turnId: 'turn',
    workingDir: '/tmp', model: 'core' };
  const scope: Record<string, any> = {
    traexAutoModelController: controller,
    lastInitConfig: cfg,
    pendingMessages: [],
    cliSpawnGeneration: 1, CliSpawnSupersededError,
    traexAutoModelRuntimeEligible: () => true,
    traexAutoModelPreflightEnabled,
    cliAdapter: { resolvedBin: 'traex' },
    readTraexModelLoadSnapshot: vi.fn(async () => ({
      loads, reasoningEfforts: new Map([['backup', ['xhigh']]]),
    })),
    TRAEX_AUTO_MODEL_DEFAULT_PREFLIGHT_TIMEOUT_MS: 8_000,
    TRAEX_AUTO_MODEL_DEFAULT_OVERLOAD_THRESHOLD_PERCENT: 100,
    buildSessionChildEnv: () => ({}), botInjectedEnv: () => ({}),
    rememberTraexModelLoadSnapshot: vi.fn(), logTraexPreflightDecision: vi.fn(),
    applyTraexAutoModelSettings: vi.fn((target: any, _controller: any, model: string) => { target.model = model; }),
    notifyTraexPreflightDecision: vi.fn(), log: vi.fn(),
  };
  const preflight = loadWorkerFunction<(cfg: any, options: any) => Promise<void>>(
    'preflightTraexAutoModelBeforeSpawn', scope,
  );
  return { cfg, scope, run: () => preflight(cfg, { willReattachPersistent: false, spawnGeneration: 1 }) };
}

function warmPreflight(controller: TraexAutoModelController, loads: Map<string, number>, switchAccepted: boolean) {
  const item: any = { content: 'independent', turnId: 'next' };
  const scope: Record<string, any> = {
    traexAutoModelController: controller, pendingMessages: [item],
    traexAutoModelRuntimeEligible: () => true,
    cliSpawnGeneration: 1, traexAutoModelPreflightPending: undefined,
    currentTraexLoadSnapshot: vi.fn(async () => ({ loads, reasoningEfforts: new Map([['backup', ['xhigh']]]) })),
    TRAEX_AUTO_MODEL_DEFAULT_PREFLIGHT_TIMEOUT_MS: 8_000,
    TRAEX_AUTO_MODEL_DEFAULT_OVERLOAD_THRESHOLD_PERCENT: 100,
    isPromptReady: true, cliRestartInProgress: false, activeTurnAuthority: new ActiveTurnAuthority(),
    rememberTraexModelLoadSnapshot: vi.fn(), logTraexPreflightDecision: vi.fn(),
    executeTraexAutoModelSwitch: vi.fn((decision: any) => switchAccepted && controller.commitSwitch(decision)),
    applyTraexAutoModelSettings: vi.fn(), notifyTraexPreflightDecision: vi.fn(),
    flushPending: vi.fn(), log: vi.fn(), lastInitConfig: undefined,
  };
  const select = loadWorkerFunction<(head: any) => boolean>('selectTraexCapacityModelBeforeTurn', scope);
  return { item, scope, run: () => select(item) };
}

const preflightController = () => new TraexAutoModelController({ enabled: true, models: ['core', 'backup'],
  queueTimeoutMs: 5_000, preflightLoadCheck: true });

describe('TraeX Worker independent-turn preflight seams', () => {
  it('selects the cold-start model before spawn arguments are built', async () => {
    const controller = preflightController();
    const { cfg, scope, run } = coldStartPreflight(controller);
    await run();
    expect(cfg.model).toBe('backup');
    expect(controller.currentModel()).toBe('backup');
    expect(scope.readTraexModelLoadSnapshot).toHaveBeenCalledOnce();
    expect(scope.notifyTraexPreflightDecision).toHaveBeenCalledOnce();
  });

  it('does not announce a cold-start switch the controller refused', async () => {
    const controller = preflightController();
    vi.spyOn(controller, 'commitSwitch').mockReturnValue(false);
    const { cfg, scope, run } = coldStartPreflight(controller);
    await run();
    expect(cfg.model).toBe('core');
    expect(controller.currentModel()).toBe('core');
    expect(scope.notifyTraexPreflightDecision).not.toHaveBeenCalled();
  });

  it('abandons the cold-start decision when a restart superseded the spawn during the load read', async () => {
    const controller = preflightController();
    const { cfg, scope, run } = coldStartPreflight(controller);
    const read = scope.readTraexModelLoadSnapshot.getMockImplementation();
    scope.readTraexModelLoadSnapshot.mockImplementation(async () => {
      scope.cliSpawnGeneration = 2;
      return read();
    });
    await expect(run()).rejects.toBeInstanceOf(CliSpawnSupersededError);
    expect(cfg.model).toBe('core');
    expect(controller.currentModel()).toBe('core');
    expect(scope.notifyTraexPreflightDecision).not.toHaveBeenCalled();
  });

  it('does not announce a warm switch that was refused', async () => {
    const controller = preflightController();
    const { scope, run } = warmPreflight(controller, new Map([['core', 101], ['backup', 100]]), false);
    expect(run()).toBe(true);
    await vi.waitFor(() => expect(scope.flushPending).toHaveBeenCalledOnce());
    expect(scope.executeTraexAutoModelSwitch).toHaveBeenCalledOnce();
    expect(controller.currentModel()).toBe('core');
    expect(scope.notifyTraexPreflightDecision).not.toHaveBeenCalled();
  });

  it('still announces a warm hold on the least-loaded current model', async () => {
    const controller = preflightController();
    const { scope, run } = warmPreflight(controller, new Map([['core', 102], ['backup', 110]]), true);
    expect(run()).toBe(true);
    await vi.waitFor(() => expect(scope.flushPending).toHaveBeenCalledOnce());
    expect(scope.executeTraexAutoModelSwitch).not.toHaveBeenCalled();
    expect(scope.notifyTraexPreflightDecision).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ kind: 'hold', model: 'core' }), 'next', undefined);
  });

  it('preflights an idle durable dispatch but never a busy type-ahead correction', () => {
    const controller = new TraexAutoModelController({ enabled: true, models: ['core', 'backup'],
      queueTimeoutMs: 5_000, preflightLoadCheck: true });
    controller.beginTurn('active');
    const dispatch = { content: 'dispatch', turnId: 'dispatch', dispatchAttempt: 1 };
    const scope: Record<string, any> = {
      traexAutoModelController: controller, pendingMessages: [dispatch],
      traexAutoModelRuntimeEligible: () => true, traexAutoModelSwitching: false,
      traexQuotaPending: undefined, traexAutoModelPreflightPending: undefined,
      isPromptReady: true, queuedTypeAheadTurns: [], activeTurnAuthority: new ActiveTurnAuthority(),
      traexAutoModelInputHold: () => false, traexAutoModelPreflightEnabled,
      selectTraexQuotaModelBeforeTurn: vi.fn(), selectTraexCapacityModelBeforeTurn: vi.fn(() => true),
      executeTraexAutoModelSwitch: vi.fn(), lastInitConfig: { cliSessionId: 'native' },
    };
    const reset = loadWorkerFunction<() => boolean>('resetTraexAutoModelBeforePendingTurn', scope);
    expect(reset()).toBe(true);
    expect(scope.selectTraexCapacityModelBeforeTurn).toHaveBeenCalledWith(dispatch);

    const activeAuthority = new ActiveTurnAuthority();
    activeAuthority.reserve({ turnId: 'active' });
    activeAuthority.markStarted({ turnId: 'active' });
    scope.pendingMessages = [{ content: 'correction', turnId: 'correction' }];
    scope.activeTurnAuthority = activeAuthority;
    scope.isPromptReady = false;
    scope.selectTraexCapacityModelBeforeTurn.mockClear();
    expect(reset()).toBe(false);
    expect(scope.selectTraexCapacityModelBeforeTurn).not.toHaveBeenCalled();

    scope.pendingMessages = [{ content: 'at-most-once', turnId: 'api-turn', noReplay: true }];
    scope.isPromptReady = true;
    expect(reset()).toBe(false);
    expect(scope.selectTraexCapacityModelBeforeTurn).not.toHaveBeenCalled();
  });

  it('keeps the queued prompt through warm preflight and admits one exact-resume switch', async () => {
    const controller = preflightController();
    const { item, scope, run } = warmPreflight(controller, new Map([['core', 101], ['backup', 100]]), true);
    expect(run()).toBe(true);
    await vi.waitFor(() => expect(scope.executeTraexAutoModelSwitch).toHaveBeenCalledOnce());
    expect(item.traexAutoModelPreflightDone).toBe(true);
    expect(scope.pendingMessages).toEqual([item]);
    expect(controller.currentModel()).toBe('backup');
    expect(scope.flushPending).not.toHaveBeenCalled();
  });

  it('keeps a restart on the controller turn when the init config still carries the first turn', async () => {
    const controller = preflightController();
    controller.beginTurn('init-turn');
    const decision = controller.preflightDecision('next', new Map([['core', 101], ['backup', 100]]));
    expect(decision.kind).toBe('switch');
    expect(controller.commitSwitch(decision as any)).toBe(true);
    expect(controller.currentTurnId()).toBe('next');

    const { cfg, run } = coldStartPreflight(controller, new Map([['core', 101], ['backup', 100]]));
    // The restart spawn is built from the init config: it has no prompt and its
    // turnId is still the message that created the session.
    cfg.prompt = '';
    cfg.turnId = 'init-turn';

    await expect(run()).resolves.toBeUndefined();
  });

  it.each([
    { available: 'backup', attempt: undefined, retry: false },
    { available: 'backup', attempt: 2, retry: false },
    { available: 'core', attempt: undefined, retry: false },
    { available: 'backup', attempt: 2, retry: true },
  ])('attributes restart catalog maintenance to the current turn (available=$available, attempt=$attempt, retry=$retry)', async ({ available, attempt, retry }) => {
    const controller = preflightController();
    controller.beginTurn('init-turn');
    const decision = controller.preflightDecision('next', new Map([['core', 101], ['backup', 100]]));
    if (decision.kind !== 'switch') throw new Error('Expected a model switch');
    expect(controller.commitSwitch(decision)).toBe(true);
    const { cfg, scope, run } = coldStartPreflight(controller);
    Object.assign(cfg, { prompt: '', turnId: 'init-turn', dispatchAttempt: 1, model: 'backup',
      traexAutoModel: controller.config });
    scope.pendingMessages = [{ content: 'next request', turnId: 'next', dispatchAttempt: attempt }];
    scope.pendingTraexModelPoolPrunes = new Map();
    scope.randomUUID = () => 'restart-prune';
    scope.send = vi.fn();
    scope.t = (key: string) => key;
    scope.readTraexModelLoadSnapshot.mockResolvedValue({ loads: new Map([[available, 10]]),
      reasoningEfforts: new Map(), catalogModels: new Set([available]) });
    scope.process = { send: vi.fn((message: any) => {
      const pending = scope.pendingTraexModelPoolPrunes.get(message.requestId);
      clearTimeout(pending.timeout);
      scope.pendingTraexModelPoolPrunes.delete(message.requestId);
      pending.resolve({ status: 'applied', removedModels: controller.config.models.filter(model => model !== available),
        config: { ...controller.config, models: [available] } });
    }) };

    if (retry) {
      vi.useFakeTimers();
      scope.readTraexModelLoadSnapshot.mockResolvedValueOnce(null);
    }
    try {
      await expect(run()).resolves.toBeUndefined();
      if (retry) await vi.advanceTimersByTimeAsync(30_000);
      expect(scope.process.send).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        type: 'traex_model_pool_prune', turnId: 'next',
        ...(attempt === undefined ? {} : { dispatchAttempt: attempt }),
      }));
      expect(scope.process.send.mock.calls[0][0].dispatchAttempt).toBe(attempt);
      expect(controller.currentTurnId()).toBe('next');
      expect(controller.currentModel()).toBe(available);
    } finally {
      if (retry) { vi.clearAllTimers(); vi.useRealTimers(); }
    }
  });
});
