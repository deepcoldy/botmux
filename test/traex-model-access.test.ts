import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { drainTraexRollout } from '../src/services/traex-transcript.js';
import { isTraexModelAccessError, TRAEX_MODEL_ACCESS_ERROR_CODE } from '../src/services/traex-model-access.js';
import { TraexAutoModelController, type TraexAutoModelAction, type TraexAutoModelConfig } from '../src/services/traex-auto-model.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function terminal(error: unknown) {
  const root = mkdtempSync(join(tmpdir(), 'traex-model-access-'));
  roots.push(root);
  const path = join(root, 'rollout.jsonl');
  writeFileSync(path, JSON.stringify({ timestamp: '2026-11-06T00:00:00Z', type: 'event_msg', payload: {
    type: 'task_complete', turn_id: 'native-turn', last_agent_message: '', error,
  } }) + '\n');
  return drainTraexRollout(path, 0).events.find(event => event.kind === 'assistant_final');
}

describe('native model access restriction terminals', () => {
  it.each([
    { message: 'stream disconnected before completion: Model access temporarily restricted.', codex_error_info: 'other' },
    { message: 'unexpected status 502 Bad Gateway: Model access temporarily restricted., url: http://127.0.0.1:8790/v1/responses', codex_error_info: 'other' },
    { message: JSON.stringify({ error: { type: 'api_error', message: 'Model access temporarily restricted.' } }) },
    { error: { message: 'Model access temporarily restricted.' } },
  ])('preserves model restriction instead of generic upstream failure: %j', error => {
    expect(terminal(error)).toMatchObject({ terminalStatus: 'failed', terminalErrorCode: TRAEX_MODEL_ACCESS_ERROR_CODE });
  });
  it.each([
    'Model access temporarily restricted.',
    'TRAE returned HTTP 502: Model access temporarily restricted.',
    new Error('Model access temporarily restricted.'),
  ])('recognizes the exact native error leaf: %j', error => {
    expect(isTraexModelAccessError(error)).toBe(true);
  });
  it.each([
    { message: 'unexpected status 502 Bad Gateway: upstream unavailable' },
    { message: 'HTTP 403 Forbidden: credentials rejected' },
    { message: 'The tool printed Model access temporarily restricted.' },
    { message: 'Model access temporarily restricted. Example only.' },
    { message: JSON.stringify({ error: ['Model access temporarily restricted.'] }) },
    null,
  ])('does not turn unrelated or malformed errors into model restrictions: %j', error => {
    expect(isTraexModelAccessError(error)).toBe(false);
  });
  it('bounds oversized error leaves and nested provider wrappers', () => {
    expect(isTraexModelAccessError({ message: 'Model access temporarily restricted.' + ' '.repeat(9000) })).toBe(false);
    let error: unknown = 'Model access temporarily restricted.';
    for (let i = 0; i < 10; i++) error = { error };
    expect(isTraexModelAccessError(error)).toBe(false);
  });
  it('leaves an ordinary upstream 502 in the existing failure taxonomy', () => {
    expect(terminal({ message: 'unexpected status 502 Bad Gateway: upstream unavailable' })).toMatchObject({
      terminalStatus: 'failed', terminalErrorCode: 'codex_upstream_error',
    });
  });
  it('does not classify restriction words in a successful user/tool transcript', () => {
    const root = mkdtempSync(join(tmpdir(), 'traex-model-access-text-'));
    roots.push(root);
    const path = join(root, 'rollout.jsonl');
    writeFileSync(path, [
      { type: 'event_msg', payload: { type: 'user_message', turn_id: 'n', message: 'Model access temporarily restricted.' } },
      { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'n', last_agent_message: 'OK', error: null } },
    ].map(value => JSON.stringify(value) + '\n').join(''));
    expect(drainTraexRollout(path, 0).events.find(event => event.kind === 'assistant_final')?.terminalErrorCode).toBeUndefined();
  });
});

const models = ['GPT-6.1-Sol', 'GPT-5.6-Sol', 'DeepSeek-V4-Flash', 'DeepSeek-V4-Pro'];
const config: TraexAutoModelConfig = { enabled: true, models, queueTimeoutMs: 5000 };
const loadMap = (values: number[]) => new Map(models.map((model, index) => [model.toLowerCase(), values[index]!]));
function create(configOverride: Partial<TraexAutoModelConfig> = {}) {
  const pool = new TraexAutoModelController({ ...config, ...configOverride });
  pool.beginTurn('turn');
  return pool;
}
function commit(pool: TraexAutoModelController, action: TraexAutoModelAction) {
  expect(action.kind).toBe('switch');
  if (action.kind !== 'switch') throw new Error('expected a switch');
  expect(pool.commitSwitch(action)).toBe(true);
  return action;
}
function confirmedQueue(pool: TraexAutoModelController, loads: ReadonlyMap<string, number> | null, position?: number) {
  const nowMs = Date.now();
  expect(pool.observeCapacityQueue({ turnId: 'turn', queued: true, nowMs, queuePosition: position })).toEqual({ kind: 'none' });
  vi.advanceTimersByTime(1001);
  expect(pool.observeCapacityQueue({ turnId: 'turn', queued: true, nowMs: Date.now(), queuePosition: position }).kind).toBe('load_check');
  return pool.resolveModelLoads('turn', loads);
}

describe('bounded per-turn model access recovery', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-06T00:00:00Z')); });
  afterEach(() => vi.useRealTimers());

  it('checks consecutive GPT candidates before advancing to a healthy DeepSeek', () => {
    let pool = create();
    const loads = loadMap([10, 20, 30, 40]);
    expect(commit(pool, pool.observeModelAccessFailure('turn', loads))).toMatchObject({ toModel: models[1], restrictionRecovery: true });
    pool = new TraexAutoModelController(config, pool.runtimeState('native'));
    expect(commit(pool, pool.observeModelAccessFailure('turn', loads))).toMatchObject({ toModel: models[2] });
    expect(pool.runtimeState('native').modelAccessRecovery?.blockedModels).toEqual(models.slice(0, 2));
    pool.observeCapacityQueue({ turnId: 'turn', queued: false, progressing: true, nowMs: Date.now() });
    expect(pool.awaitingModelActivity()).toBe(false);
    expect(pool.currentModel()).toBe(models[2]);
  });
  it('skips known busy candidates to try the first later known-available model', () => {
    const pool = create();
    expect(commit(pool, pool.observeModelAccessFailure('turn', loadMap([0, 200, 60, 10])))).toMatchObject({
      toModel: models[2], loadPercent: 60,
    });
  });
  it('tries unknown-load candidates without claiming a non-queued load', () => {
    const pool = create();
    const choice = commit(pool, pool.observeModelAccessFailure('turn', new Map([[models[2]!.toLowerCase(), 20]])));
    expect(choice).toMatchObject({ toModel: models[1], reason: 'model_access_restricted' });
    expect(choice.loadPercent).toBeUndefined();
  });
  it('tries high-load candidates too, because load does not prove access', () => {
    const pool = create();
    const loads = loadMap([1, 180, 160, 140]);
    for (const model of models.slice(1)) expect(commit(pool, pool.observeModelAccessFailure('turn', loads)).toModel).toBe(model);
    expect(pool.observeModelAccessFailure('turn', loads)).toMatchObject({ kind: 'exhausted', restrictionRecovery: true });
    expect(pool.runtimeState('native').modelAccessRecovery?.blockedModels).toEqual(models);
  });
  it('records queued candidates, checks the remainder and holds the lowest-load unblocked model', () => {
    let pool = create();
    const loads = loadMap([1, 2, 180, 160]);
    commit(pool, pool.observeModelAccessFailure('turn', loads));
    commit(pool, pool.observeModelAccessFailure('turn', loads));
    expect(pool.currentModel()).toBe(models[2]);
    expect(commit(pool, confirmedQueue(pool, loads, 30)).toModel).toBe(models[3]);
    pool = new TraexAutoModelController(config, pool.runtimeState('native'));
    expect(confirmedQueue(pool, loads, 20)).toMatchObject({ kind: 'exhausted', model: models[3], modelCount: 2 });
    expect(pool.runtimeState('native').waitingOnFinalModel).toBe(true);
    for (const nowMs of [Date.now() + 10000, Date.now() + 600000]) {
      expect(pool.observeCapacityQueue({ turnId: 'turn', queued: true, nowMs })).toEqual({ kind: 'none' });
    }
  });
  it('never returns to a restricted low-load model during final queue selection', () => {
    const pool = create();
    const loads = loadMap([0, 0, 180, 200]);
    commit(pool, pool.observeModelAccessFailure('turn', loads));
    commit(pool, pool.observeModelAccessFailure('turn', loads));
    commit(pool, confirmedQueue(pool, loads, 15));
    expect(commit(pool, pool.observeModelAccessFailure('turn', loads))).toMatchObject({ toModel: models[2], reason: 'lowest_load' });
    expect(pool.runtimeState('native').waitingOnFinalModel).toBe(true);
    expect(pool.observeModelAccessFailure('turn', loads)).toMatchObject({ kind: 'exhausted', restrictionRecovery: true });
  });
  it('uses actual queue evidence when the load catalog is unavailable', () => {
    const pool = create();
    commit(pool, pool.observeModelAccessFailure('turn', null));
    commit(pool, pool.observeModelAccessFailure('turn', null));
    commit(pool, confirmedQueue(pool, null, 9));
    expect(commit(pool, pool.observeModelAccessFailure('turn', null))).toMatchObject({
      toModel: models[2], reason: 'shortest_queue', queuePosition: 9,
    });
  });
  it('preserves queue evidence even when the queue exposes no rank', () => {
    let pool = create();
    commit(pool, pool.observeModelAccessFailure('turn', null));
    commit(pool, pool.observeModelAccessFailure('turn', null));
    commit(pool, confirmedQueue(pool, null));
    pool = new TraexAutoModelController(config, pool.runtimeState('native'));
    expect(pool.runtimeState('native').modelAccessRecovery?.queuedModels).toEqual([models[2]]);
    expect(commit(pool, pool.observeModelAccessFailure('turn', null)).toModel).toBe(models[2]);
  });
  it('continues to remaining candidates after a queued backup successor is restricted', () => {
    const pool = create();
    const initial = pool.observeModelAccessFailure('turn', loadMap([0, 10, 200, 300]));
    commit(pool, initial);
    expect(commit(pool, confirmedQueue(pool, loadMap([0, 10, 200, 300]))).toModel).toBe(models[2]);
    expect(commit(pool, pool.observeModelAccessFailure('turn', loadMap([0, 10, 200, 300]))).toModel).toBe(models[3]);
  });
  it('retains recent queue ranks through disk persistence and a fresh controller', () => {
    const pool = create(); commit(pool, pool.observeModelAccessFailure('turn', null));
    commit(pool, confirmedQueue(pool, null, 1));
    commit(pool, confirmedQueue(pool, null, 99));
    const root = mkdtempSync(join(tmpdir(), 'model-access-ranks-')); roots.push(root);
    const path = join(root, 'runtime.json'); writeFileSync(path, JSON.stringify(pool.runtimeState('native')));
    const restored = new TraexAutoModelController(config, JSON.parse(readFileSync(path, 'utf8')));
    expect(restored.observeModelAccessFailure('turn', null)).toMatchObject({
      kind: 'switch', toModel: models[1], queuePosition: 1, reason: 'shortest_queue',
    });
  });
  it('does not trust stale, future, invalid or out-of-pool persisted queue ranks', () => {
    const pool = create(); commit(pool, pool.observeModelAccessFailure('turn', null));
    commit(pool, confirmedQueue(pool, null, 1)); commit(pool, confirmedQueue(pool, null, 99));
    const state = pool.runtimeState('native');
    (state.modelAccessRecovery as any).queuePositions = [
      { model: models[1], position: 1, atMs: Date.now() },
      { model: models[2], position: 0, atMs: Date.now() + 1 },
      { model: models[2], position: 0, atMs: Date.now() - 600001 },
      { model: models[2], position: -1, atMs: Date.now() },
      { model: models[2], position: 0.5, atMs: Date.now() },
      { model: models[0], position: 0, atMs: Date.now() },
      { model: 'outside', position: 0, atMs: Date.now() }, null,
    ];
    const restored = new TraexAutoModelController(config, state);
    expect(restored.runtimeState('native').modelAccessRecovery?.queuePositions).toHaveLength(1);
    expect(restored.observeModelAccessFailure('turn', null)).toMatchObject({ toModel: models[1], queuePosition: 1 });
  });
  it('accepts legacy access-recovery state without persisted queue ranks', () => {
    const pool = create(); commit(pool, pool.observeModelAccessFailure('turn', null));
    commit(pool, confirmedQueue(pool, null));
    const state = pool.runtimeState('native'); delete state.modelAccessRecovery?.queuePositions;
    const restored = new TraexAutoModelController(config, state);
    expect(restored.runtimeState('native').modelAccessRecovery?.queuedModels).toEqual([models[1]]);
  });
  it('does not revive blocked preferences on a cold preflight for the same recovered turn', () => {
    const configured = { ...config, preflightLoadCheck: true, reselectPerTurn: true };
    let pool = create(configured);
    commit(pool, pool.observeModelAccessFailure('turn', loadMap([0, 10, 20, 30])));
    pool = new TraexAutoModelController(configured, pool.runtimeState('native'));
    expect(pool.preflightDecision('turn', loadMap([0, 10, 20, 30]), { preferFirstModel: true })).toMatchObject({
      kind: 'keep', model: models[1],
    });
  });
  it('does not propose a cold preflight switch for a stopped ordinary capacity turn', () => {
    const pool = create({ preflightLoadCheck: true, reselectPerTurn: true });
    expect(pool.requestRecoveryStop('turn')).toBe(true);
    expect(pool.preflightDecision('turn', loadMap([200, 50, 20, 10]))).toMatchObject({ kind: 'keep', model: models[0] });
  });
  it.each(['capacity', 'quota'] as const)('persists stop intent for %s recovery and only clears it for a new turn', trigger => {
    const pool = create({ trigger });
    if (trigger === 'capacity') commit(pool, pool.observeModelAccessFailure('turn', null));
    expect(pool.requestRecoveryStop('turn')).toBe(true);
    const restored = new TraexAutoModelController(pool.config, JSON.parse(JSON.stringify(pool.runtimeState('native'))));
    expect(restored.recoveryStopped('turn')).toBe(true);
    expect(restored.observeModelAccessFailure('turn', null)).toEqual({ kind: 'none' });
    expect(restored.observeQuotaFailure('turn', null)).toEqual({ kind: 'none' });
    expect(restored.commitSwitch({ kind: 'switch', reason: 'model_access_restricted', turnId: 'turn',
      fromModel: restored.currentModel(), toModel: models[2]!, toIndex: 2 })).toBe(false);
    restored.endTurn('turn'); restored.beginTurn('next');
    expect(restored.recoveryStopped('turn')).toBe(false);
    expect(restored.runtimeState('native').stoppedRecoveryTurnId).toBeUndefined();
  });
  it('does not resurrect access restrictions after an independent next turn', () => {
    const pool = create({ reselectPerTurn: true });
    commit(pool, pool.observeModelAccessFailure('turn', null));
    pool.endTurn('turn');
    expect(pool.runtimeState('native').modelAccessRecovery).toBeUndefined();
    expect(commit(pool, pool.beginTurn('next')).toModel).toBe(models[0]);
  });
  it('ignores stale errors and rejects proposals for a confirmed restricted model', () => {
    const pool = create();
    expect(pool.observeModelAccessFailure('stale', null)).toEqual({ kind: 'none' });
    expect(pool.runtimeState('native').modelAccessRecovery).toBeUndefined();
    commit(pool, pool.observeModelAccessFailure('turn', null));
    expect(pool.commitSwitch({ kind: 'switch', reason: 'lowest_load', turnId: 'turn', fromModel: models[1]!, toModel: models[0]!, toIndex: 0 })).toBe(false);
  });
  it('leaves quota-only capacity policy unchanged until an access failure starts recovery', () => {
    const pool = create({ trigger: 'quota' });
    expect(pool.observeCapacityQueue({ turnId: 'turn', queued: true, nowMs: Date.now() })).toEqual({ kind: 'none' });
    commit(pool, pool.observeModelAccessFailure('turn', null));
    expect(commit(pool, confirmedQueue(pool, null)).toModel).toBe(models[2]);
  });
  it('does not use candidates with already confirmed exhausted quota', () => {
    const pool = create({ trigger: 'quota' });
    pool.refreshQuotaEvidence(new Map([[models[1]!.toLowerCase(), { depleted: true }]]));
    expect(commit(pool, pool.observeModelAccessFailure('turn', loadMap([0, 1, 20, 30]))).toModel).toBe(models[2]);
  });
});
