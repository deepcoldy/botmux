import { describe, expect, it, vi } from 'vitest';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';
import { TraexAutoModelController, resolveTraexAutoModelSettings } from '../src/services/traex-auto-model.js';
import { ActiveTurnAuthority } from '../src/core/active-turn-authority.js';
import { InflightInputTracker } from '../src/core/inflight-input-tracker.js';

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
    cliModelSupportsReasoningEffort: () => true, send: vi.fn(), log: vi.fn(),
    resolveTraexAutoModelSettings,
    restartCliProcess: vi.fn(async () => {}), t: (key: string) => key,
    ...extra,
  };
  scope.enqueueTraexAutoModelRecovery = loadWorkerFunction('enqueueTraexAutoModelRecovery', scope);
  return { scope, controller, tracker, switchModel: loadWorkerFunction<(action: any, options: any) => boolean>('executeTraexAutoModelSwitch', scope) };
}
const action = { kind: 'switch', reason: 'lowest_load', turnId: 'turn', fromModel: 'core', toModel: 'backup', toIndex: 1, loadPercent: 120 };

describe('auto-model Worker admission and original-input retirement', () => {
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
    }));
    expect(h.switchModel(action, { resumeCurrentTurn: true })).toBe(false);
    expect(h.scope.pendingMessages).toHaveLength(1);
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
