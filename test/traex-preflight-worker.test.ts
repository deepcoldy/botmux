import { describe, expect, it, vi } from 'vitest';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';
import {
  TraexAutoModelController,
  traexAutoModelPreflightEnabled,
} from '../src/services/traex-auto-model.js';
import { ActiveTurnAuthority } from '../src/core/active-turn-authority.js';

describe('TraeX Worker independent-turn preflight seams', () => {
  it('selects the cold-start model before spawn arguments are built', async () => {
    const controller = new TraexAutoModelController({ enabled: true, models: ['core', 'backup'],
      queueTimeoutMs: 5_000, preflightLoadCheck: true });
    const cfg: any = { type: 'init', cliId: 'traex', prompt: 'original', turnId: 'turn',
      workingDir: '/tmp', model: 'core' };
    const scope: Record<string, any> = {
      traexAutoModelController: controller,
      traexAutoModelRuntimeEligible: () => true,
      traexAutoModelPreflightEnabled,
      cliAdapter: { resolvedBin: 'traex' },
      readTraexModelLoadSnapshot: vi.fn(async () => ({
        loads: new Map([['core', 101], ['backup', 100]]),
        reasoningEfforts: new Map([['backup', ['xhigh']]]),
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
    await preflight(cfg, { willReattachPersistent: false });
    expect(cfg.model).toBe('backup');
    expect(controller.currentModel()).toBe('backup');
    expect(scope.readTraexModelLoadSnapshot).toHaveBeenCalledOnce();
    expect(scope.notifyTraexPreflightDecision).toHaveBeenCalledOnce();
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
    const controller = new TraexAutoModelController({ enabled: true, models: ['core', 'backup'],
      queueTimeoutMs: 5_000, preflightLoadCheck: true });
    const item: any = { content: 'independent', turnId: 'next' };
    const scope: Record<string, any> = {
      traexAutoModelController: controller, pendingMessages: [item],
      cliSpawnGeneration: 1, traexAutoModelPreflightPending: undefined,
      currentTraexLoadSnapshot: vi.fn(async () => ({ loads: new Map([['core', 101], ['backup', 100]]),
        reasoningEfforts: new Map([['backup', ['xhigh']]]) })),
      TRAEX_AUTO_MODEL_DEFAULT_PREFLIGHT_TIMEOUT_MS: 8_000,
      TRAEX_AUTO_MODEL_DEFAULT_OVERLOAD_THRESHOLD_PERCENT: 100,
      isPromptReady: true, cliRestartInProgress: false, activeTurnAuthority: new ActiveTurnAuthority(),
      rememberTraexModelLoadSnapshot: vi.fn(), logTraexPreflightDecision: vi.fn(),
      executeTraexAutoModelSwitch: vi.fn((decision: any) => controller.commitSwitch(decision)),
      applyTraexAutoModelSettings: vi.fn(), notifyTraexPreflightDecision: vi.fn(),
      flushPending: vi.fn(), log: vi.fn(),
    };
    const select = loadWorkerFunction<(head: any) => boolean>('selectTraexCapacityModelBeforeTurn', scope);
    expect(select(item)).toBe(true);
    await vi.waitFor(() => expect(scope.executeTraexAutoModelSwitch).toHaveBeenCalledOnce());
    expect(item.traexAutoModelPreflightDone).toBe(true);
    expect(scope.pendingMessages).toEqual([item]);
    expect(controller.currentModel()).toBe('backup');
    expect(scope.flushPending).not.toHaveBeenCalled();
  });
});
