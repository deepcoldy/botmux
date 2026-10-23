import { describe, expect, it, vi } from 'vitest';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';
import { TraexAutoModelController, resolveTraexAutoModelSettings, validTraexAutoModelRuntime } from '../src/services/traex-auto-model.js';
import { knownTraexReasoningEffortsForModel } from '../src/services/codex-reasoning-effort.js';
import { buildSessionChildEnv, botInjectedEnv } from '../src/core/env-policy.js';
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
    knownTraexReasoningEffortsForModel, cliModelSupportsReasoningEffort: () => true, send: vi.fn(), log: vi.fn(),
    resolveTraexAutoModelSettings, validTraexAutoModelRuntime,
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


describe('Auto live follow-up input policy', () => {
  it('holds follow-ups through the resumed continuation until its first model activity', async () => {
    const { traexCapacityQueueVisible, traexModelProgressVisible } = await import('../src/adapters/cli/traex.js');
    const h = harness();
    h.controller.commitSwitch(action);
    let frame = '❯ Ask anything';
    Object.assign(h.scope, { isPromptReady: false, backend: {}, commandLineWritesPending: 0,
      currentBotmuxTurnId: 'turn', captureBackendScreen: () => frame,
      traexCapacityQueueVisible, traexModelProgressVisible, traexCapacityQueuePosition: () => undefined,
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
    { eligible: true, switching: false, ready: false, screen: 'Working…', hold: false },
    { eligible: true, switching: false, ready: false, screen: '◆ Queued for capacity (20s • esc to interrupt)' + '\n'.repeat(50), hold: true },
    { eligible: true, switching: true, ready: true, screen: '', hold: true },
    { eligible: true, switching: false, ready: true, screen: '◆ Queued for capacity (20s • esc to interrupt)' , hold: false },
    { eligible: false, switching: false, ready: false, screen: '◆ Queued for capacity (20s • esc to interrupt)' , hold: false },
  ])('holds only an active Auto capacity transition (%j)', async ({ eligible, switching, ready, screen, hold }) => {
    const { traexCapacityQueueVisible } = await import('../src/adapters/cli/traex.js');
    const scope = { traexAutoModelRuntimeEligible: () => eligible,
      traexAutoModelSwitching: switching, isPromptReady: ready, backend: {},
      captureBackendScreen: () => screen, traexCapacityQueueVisible };
    expect(loadWorkerFunction<() => boolean>('traexAutoModelInputHold', scope)()).toBe(hold);
  });

  it.each([false, true])('lets a running follow-up keep its current model (reselect=%s)', reselectPerTurn => {
    const controller = new TraexAutoModelController({ enabled: true, models: ['core', 'backup'],
      queueTimeoutMs: 5_000, reselectPerTurn });
    controller.beginTurn('turn');
    controller.commitSwitch(action);
    const scope = { traexAutoModelController: controller, traexAutoModelRuntimeEligible: () => true,
      pendingMessages: [{ turnId: 'followup' }], traexAutoModelSwitching: false,
      isPromptReady: false, traexAutoModelInputHold: () => false,
      lastInitConfig: { cliSessionId: 'native' }, executeTraexAutoModelSwitch: vi.fn(() => true) };
    const reset = loadWorkerFunction<() => boolean>('resetTraexAutoModelBeforePendingTurn', scope);
    expect(reset()).toBe(false);
    expect(controller.currentModel()).toBe('backup');
    expect(scope.executeTraexAutoModelSwitch).not.toHaveBeenCalled();
    scope.isPromptReady = true;
    expect(reset()).toBe(reselectPerTurn);
    expect(scope.executeTraexAutoModelSwitch).toHaveBeenCalledTimes(reselectPerTurn ? 1 : 0);
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
      traexModelProgressVisible: () => false, readTraexModelLoads: read,
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
