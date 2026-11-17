import { describe, expect, it } from 'vitest';
import { TraexAutoModelController } from '../src/services/traex-auto-model.js';

const config = { enabled: true as const, models: ['core', 'removed', 'backup'], queueTimeoutMs: 5_000 };
function queued(controller: TraexAutoModelController, turnId = 'turn') {
  controller.beginTurn(turnId, { retainCurrentModel: true });
  controller.observeCapacityQueue({ turnId, queued: true, nowMs: 0 });
  expect(controller.observeCapacityQueue({ turnId, queued: true, nowMs: 5_000 }).kind).toBe('load_check');
}

describe('catalog-aware TraeX automatic selection', () => {
  it('skips a removed backup instead of treating its missing load as an invitation to try it', () => {
    const c = new TraexAutoModelController(config);
    c.observeModelCatalog(new Set(['core', 'backup']));
    queued(c);
    expect(c.resolveModelLoads('turn', new Map([['core', 120], ['backup', 60]])))
      .toMatchObject({ kind: 'switch', reason: 'available_model', toModel: 'backup', loadPercent: 60 });
  });

  it('still permits a listed model whose load is unknown', () => {
    const c = new TraexAutoModelController(config);
    c.observeModelCatalog(new Set(['core', 'removed', 'backup']));
    queued(c);
    expect(c.resolveModelLoads('turn', new Map([['core', 120]])))
      .toMatchObject({ kind: 'switch', toModel: 'removed', reason: 'capacity_timeout' });
  });

  it('repairs a retired first model at cold admission and refuses stale switch proposals', () => {
    const c = new TraexAutoModelController(config);
    c.observeModelCatalog(new Set(['backup']));
    const choice = c.catalogAdmissionDecision('new');
    expect(choice).toMatchObject({ kind: 'switch', toModel: 'backup' });
    if (choice.kind !== 'switch') throw new Error('fixture');
    expect(c.commitSwitch(choice)).toBe(true);
    expect(c.currentModel()).toBe('backup');
    expect(c.commitSwitch({ ...choice, fromModel: 'backup', toModel: 'removed', toIndex: 1 })).toBe(false);
  });

  it('never reactivates a permanently removed model merely because it reappears in the directory', () => {
    const c = new TraexAutoModelController(config);
    const pruned = { ...config, models: ['core', 'backup'] };
    c.markCatalogPruned(['removed'], pruned);
    c.observeModelCatalog(new Set(config.models));
    queued(c);
    expect(c.resolveModelLoads('turn', new Map([['core', 120], ['removed', 1], ['backup', 60]])))
      .toMatchObject({ toModel: 'backup' });
    const state = c.runtimeState('native');
    expect(new TraexAutoModelController(pruned, state).currentModel()).toBe('core');
  });

  it('holds a failed query flow but allows a new independent request to query again', () => {
    const c = new TraexAutoModelController(config);
    queued(c);
    c.catalogQueryFailed('turn');
    expect(c.observeCapacityQueue({ turnId: 'turn', queued: true, nowMs: 60_000 })).toEqual({ kind: 'none' });
    queued(c, 'new');
  });
});
