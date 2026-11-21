import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';
import { TraexAutoModelController, traexAutoModelPolicyKey } from '../src/services/traex-auto-model.js';
import type { TraexModelPoolPruneResult } from '../src/services/traex-model-pool-prune.js';

afterEach(() => vi.useRealTimers());

describe('native catalog single-flight across generation changes', () => {
  it('shares the current read and cancels the old helper before querying a replacement generation', async () => {
    const results: Array<(value: null) => void> = [];
    const read = vi.fn(() => new Promise<null>(resolve => results.push(resolve)));
    const scope: Record<string, any> = {
      cliAdapter: { resolvedBin: 'synthetic-native' }, cliSpawnGeneration: 1,
      lastInitConfig: { workingDir: '/synthetic' }, readTraexModelLoadSnapshot: read,
      process: { env: {} }, buildSessionChildEnv: () => ({}), botInjectedEnv: () => ({}),
    };
    const current = loadWorkerFunction<(timeout: number) => Promise<null>>('currentTraexLoadSnapshot', scope);
    const first = current(8_000);
    expect(current(8_000)).toBe(first);
    expect(read).toHaveBeenCalledOnce();
    const firstSignal = (read.mock.calls[0] as any)[0].signal as AbortSignal;
    scope.cliSpawnGeneration = 2;
    const replacement = current(8_000);
    expect(firstSignal.aborted).toBe(true);
    expect(read).toHaveBeenCalledTimes(2);
    results[0]!(null); await first;
    expect(current(8_000)).toBe(replacement);
    results[1]!(null); await replacement;
  });
});

describe('deferred startup catalog retry lifetime', () => {
  it('stops retrying after the current model starts working', async () => {
    vi.useFakeTimers();
    const pool = { enabled: true as const, models: ['core'], queueTimeoutMs: 5_000 };
    const controller = new TraexAutoModelController(pool);
    controller.beginTurn('cold');
    const cfg = { traexAutoModel: pool, turnId: 'cold', prompt: 'synthetic' };
    const read = vi.fn(async () => null);
    const scope: Record<string, any> = {
      traexAutoModelController: controller, cliSpawnGeneration: 1, lastInitConfig: cfg,
      traexAutoModelRuntimeEligible: () => true, cliAdapter: {}, backend: undefined,
      currentTraexLoadSnapshot: read, TRAEX_AUTO_MODEL_DEFAULT_PREFLIGHT_TIMEOUT_MS: 8_000,
      send: vi.fn(), t: (key: string) => key, log: vi.fn(),
    };
    const preflight = loadWorkerFunction<any>('preflightTraexAutoModelBeforeSpawn', scope);
    await preflight(cfg, { spawnGeneration: 1, willReattachPersistent: false });
    expect(read).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(read).toHaveBeenCalledTimes(2);
    scope.backend = {}; // The native model is now running, with no queue.
    await vi.advanceTimersByTimeAsync(90_000);
    expect(read).toHaveBeenCalledTimes(2);
    expect(scope.traexCatalogRetryPending).toBeUndefined();
  });
});

describe('worker catalog reconciliation after a pending host commit', () => {
  const pool = { enabled: true as const, models: ['core', 'retired', 'backup'], queueTimeoutMs: 5_000 };
  const catalog = { catalogModels: new Set(['backup']), loads: new Map(), reasoningEfforts: new Map() };

  function fixture() {
    vi.useFakeTimers();
    const controller = new TraexAutoModelController(pool);
    controller.beginTurn('turn');
    const cfg = { traexAutoModel: pool };
    let current = true;
    const pending = new Map<string, any>();
    const scope = {
      lastInitConfig: cfg, pendingTraexModelPoolPrunes: pending,
      randomUUID: () => 'synthetic-prune', process: { send: vi.fn() },
      send: vi.fn(), t: (key: string) => key, traexAutoModelPolicyKey,
    };
    const reconcile = loadWorkerFunction<any>('reconcileTraexModelCatalog', scope);
    const done = reconcile(catalog, controller, cfg, () => current, 'turn');
    const reply = (result: TraexModelPoolPruneResult) => {
      const entry = pending.get('synthetic-prune');
      clearTimeout(entry.timeout); pending.delete('synthetic-prune'); entry.resolve(result);
    };
    return { done, cfg, controller, reply, cancel: () => { current = false; } };
  }

  it.each([false, true])('rejects a superseded CAS without adopting manual policy or stale catalog (new policy=%s)', async withConfig => {
    const f = fixture();
    const before = f.controller.runtimeState('synthetic-native');
    f.reply({
      status: 'superseded', removedModels: [],
      ...(withConfig ? { config: { ...pool, models: ['manual'], queueTimeoutMs: 60_000 } } : {}),
    });
    expect(await f.done).toBe(false);
    expect(f.cfg.traexAutoModel).toBe(pool);
    expect(f.controller.runtimeState('synthetic-native')).toEqual(before);
    expect(f.controller.catalogAdmissionDecision('turn').kind).toBe('none');
  });

  it('discards a commit response after the owning flow is cancelled', async () => {
    const f = fixture();
    f.cancel();
    f.reply({ status: 'applied', removedModels: ['core', 'retired'], config: { ...pool, models: ['backup'] } });
    expect(await f.done).toBe(false);
    expect(f.cfg.traexAutoModel).toBe(pool);
    expect(f.controller.catalogAdmissionDecision('turn').kind).toBe('none');
  });
});
