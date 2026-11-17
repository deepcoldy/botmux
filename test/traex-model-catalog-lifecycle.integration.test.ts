/** Real production closures/components with injected native I/O and clock.
 * No daemon, model endpoint, host configuration, or shared tmux is started.
 * Keep lifecycle, durable-write and input-admission boundaries composed. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadWorkerFunction, loadWorkerMessageHandler } from './helpers/worker-function-harness.js';
import { loadWorkerPoolClosure, loadWorkerPoolFunction } from './helpers/worker-pool-function-harness.js';
import { workerSubmitHarness } from './helpers/worker-submit-harness.js';
import { TraexAutoModelController, traexAutoModelPolicyKey, traexAutoModelPreflightEnabled } from '../src/services/traex-auto-model.js';
import { pruneSavedTraexModelPool, traexCatalogConfigKey } from '../src/services/traex-model-pool-prune.js';
import { rmwBotEntry } from '../src/services/config-store.js';
import { activeSessionKey, sessionAnchorId } from '../src/core/types.js';
import { SessionController } from '../src/core/session-controller.js';
import { SessionContractStore } from '../src/services/session-contract-store.js';
import { createTraexAdapter, traexCapacityQueueVisible, traexModelProgressVisible, traexQueuedTypeAheadVisible, traexCapacityQueuePosition } from '../src/adapters/cli/traex.js';
import { ActiveTurnAuthority } from '../src/core/active-turn-authority.js';

const pool = { enabled: true as const, models: ['core', 'retired', 'backup'], queueTimeoutMs: 5000,
  modelSettings: { retired: { reasoningEffort: 'high' as const }, backup: { reasoningEffort: 'xhigh' as const } } };
const catalog = { catalogModels: new Set(['core', 'backup']), loads: new Map([['core', 20], ['backup', 10]]), reasoningEfforts: new Map() };
const SHORTCUT = ['  TRAE CLI', '  /tmp/native-control', '────────────────────────────────────────',
  '❯ Ask TRAE CLI to do anything', '────────────────────────────────────────', '  ? for shortcuts'].join('\n');
const roots: string[] = [];
const stores: SessionContractStore[] = [];
// Let real filesystem/SQLite promises drain between fake-clock edges. Captured
// setTimeout is still intercepted by Bun fake timers, so never use it to wait
// for real I/O while the clock is paused.
async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  await fsp.stat('package.json');
}
function deferred<T = void>() { let resolve!: (v: T) => void; const promise = new Promise<T>(r => resolve = r); return { promise, resolve }; }

beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] }); vi.setSystemTime(new Date('2026-11-17T02:00:00Z')); });
afterEach(() => { vi.restoreAllMocks(); vi.clearAllTimers(); vi.useRealTimers(); for (const s of stores.splice(0)) s.close(); for (const r of roots.splice(0)) rmSync(r, { force: true, recursive: true }); });

function hostFixture(dispatchAttempt?: number, admit = true) {
  const dir = mkdtempSync(join(tmpdir(), 'traex-catalog-lifecycle-')); roots.push(dir);
  const path = join(dir, 'bots.json');
  const botCfg = { larkAppId: 'cli_catalog_lifecycle', larkAppSecret: 'synthetic', cliId: 'traex', model: 'auto', traexAutoModel: structuredClone(pool), apiOnly: true };
  writeFileSync(path, JSON.stringify([botCfg, { larkAppId: 'cli_other', larkAppSecret: 'synthetic', cliId: 'codex', model: 'other', apiOnly: true }]));
  const worker: any = { connected: true, send: vi.fn() };
  const ds: any = { larkAppId: 'cli_catalog_lifecycle', chatId: 'oc_shared', rootMessageId: 'om_shared', worker, workerGeneration: 1,
    currentTurnId: 'om_turn', initConfig: { cliId: 'traex', traexAutoModel: structuredClone(pool) },
    session: { rootMessageId: 'om_shared', sessionId: 'native-owner-a', larkAppId: 'cli_catalog_lifecycle', status: 'active', workerGeneration: 1 } };
  const store = new SessionContractStore(dir, 'cli_catalog_lifecycle'); stores.push(store);
  const sessionController = new SessionController(ds, store);
  const contractWorker = sessionController.bindWorker(1).worker;
  const execution = admit ? sessionController.admitInput('om_turn', dispatchAttempt) : undefined;
  const scope: Record<string, any> = { ds, worker, workerGeneration: 1, botCfg, t: 'catalog-lifecycle', loc: 'en',
    sessionController, contractWorker, handlerSession: ds.session, handlerAnchor: sessionAnchorId(ds), handlerLarkAppId: ds.larkAppId,
    activeSessionsRegistry: new Map([[activeSessionKey(ds), ds]]), activeSessionKey, sessionAnchorId,
    traexCatalogContextKey: traexCatalogConfigKey(botCfg),
    pruneSavedTraexModelPool: (args: any) => pruneSavedTraexModelPool({ ...args, path }),
    tr: (key: string) => key, getBot: () => ({ config: botCfg }), isRemoteBackendSession: () => false,
    logger: { warn: vi.fn(), debug: vi.fn() },
    scopedReply: vi.fn(async (_body: string, _kind: string, _turn: string, opts: any) => { opts.beforeWrite(); }),
  };
  scope.sessionCliId = loadWorkerPoolFunction('sessionCliId', scope);
  scope.ownsWorkerSession = loadWorkerPoolClosure('ownsWorkerSession', scope);
  scope.handleLegacyWorkerMessage = loadWorkerPoolClosure('handleLegacyWorkerMessage', scope);
  const handle = loadWorkerPoolClosure<(msg: any) => Promise<void>>('handleWorkerMessage', scope);
  const request = (id = 'prune-1') => ({ type: 'traex_model_pool_prune', requestId: id,
    expectedPolicyKey: traexAutoModelPolicyKey(pool), availableModels: [...catalog.catalogModels], turnId: 'om_turn',
    ...(dispatchAttempt !== undefined ? { dispatchAttempt } : {}) });
  const read = () => JSON.parse(readFileSync(path, 'utf8'));
  return { dir, path, scope, ds, worker, botCfg, sessionController, execution: execution!, request, read, handle };
}

describe('catalog host lifecycle and durable configuration', () => {
  it('validates child/session ownership and prunes before executor binding', async () => {
    const h = hostFixture();
    expect(h.sessionController.currentRuntime()).toBeUndefined();
    await h.handle(h.request());
    expect(h.read()[0].traexAutoModel.models).toEqual(['core', 'backup']);
    expect(h.scope.scopedReply).toHaveBeenCalledOnce();
    expect(h.worker.send).toHaveBeenCalledWith(expect.objectContaining({ result: expect.objectContaining({ status: 'applied' }) }));
    expect(h.botCfg.traexAutoModel.models).toEqual(['core', 'backup']);
  });

  it.each(['policy', 'account', 'owner-object', 'generation', 'registry-collision', 'confirmed-cancel'])('does not commit after %s during a delayed notice', async intervention => {
    const h = hostFixture(); const gate = deferred(); const entered = deferred();
    h.scope.scopedReply.mockImplementation(async (_a: unknown, _b: unknown, _c: unknown, opts: any) => { opts.beforeWrite(); entered.resolve(); await gate.promise; });
    const running = h.handle(h.request());
    await entered.promise;
    expect(h.scope.scopedReply).toHaveBeenCalledOnce();
    await advance(5000);
    if (intervention === 'policy' || intervention === 'account') {
      await rmwBotEntry('cli_catalog_lifecycle', entry => {
        if (intervention === 'policy') entry.traexAutoModel.models = ['core', 'manual'];
        else entry.env = { TRAECLI_HOME: '/synthetic/account-b' };
        return { write: true, result: null };
      }, { path: h.path });
    } else if (intervention === 'owner-object') h.ds.session = { ...h.ds.session, sessionId: 'replacement' };
    else if (intervention === 'generation') { h.ds.workerGeneration++; h.ds.session.workerGeneration++; }
    else if (intervention === 'registry-collision') {
      const other: any = { ...h.ds, session: { ...h.ds.session, sessionId: 'other-session' } };
      h.scope.activeSessionsRegistry.set(activeSessionKey(h.ds), other);
    } else {
      const op = h.sessionController.beginControl('cancel', 'manual-cancel', h.execution).operation;
      h.sessionController.controlStarted(op.operationId);
      const runtime = h.sessionController.store.reserveRuntime(h.sessionController.ref, h.scope.contractWorker);
      h.sessionController.store.apply(h.sessionController.ref, { type: 'execution_terminal', execution: h.execution, runtime, status: 'cancelled', evidence: 'synthetic_verified_cancel' });
      expect(h.sessionController.store.executions(h.sessionController.ref, 'om_turn')[0]?.phase).toBe('cancelled');
    }
    gate.resolve(); await running;
    expect(h.read()[0].traexAutoModel.models).toEqual(intervention === 'policy' ? ['core', 'manual'] : pool.models);
    expect(h.botCfg.traexAutoModel.models).toEqual(pool.models);
  });

  it('does not cross-wire same-anchor sessions belonging to different bots', async () => {
    const h = hostFixture();
    const sibling: any = { ...h.ds, larkAppId: 'cli_sibling', session: { ...h.ds.session, sessionId: 'native-owner-b' } };
    h.scope.activeSessionsRegistry.set(activeSessionKey(sibling), sibling);
    expect(activeSessionKey(sibling)).not.toBe(activeSessionKey(h.ds));
    await h.handle(h.request());
    expect(h.read()[0].traexAutoModel.models).toEqual(['core', 'backup']);
    expect(sibling.session.sessionId).toBe('native-owner-b');
  });

  it('does not irreversibly prune while a manual cancellation operation is in flight', async () => {
    const h = hostFixture(); const gate = deferred(); const entered = deferred();
    h.scope.scopedReply.mockImplementation(async (_a: unknown, _b: unknown, _c: unknown, opts: any) => { opts.beforeWrite(); entered.resolve(); await gate.promise; });
    const running = h.handle(h.request());
    await entered.promise;
    expect(h.scope.scopedReply).toHaveBeenCalledOnce();
    const op = h.sessionController.beginControl('cancel', 'slow-manual-cancel', h.execution).operation;
    h.sessionController.controlStarted(op.operationId);
    expect(h.sessionController.allowsInput()).toBe(false);
    expect(h.sessionController.store.execution(h.sessionController.ref, h.execution.executionId)?.cancelRequested).toBe(true);
    await advance(10_000);
    gate.resolve(); await running;
    expect(h.read()[0].traexAutoModel.models).toEqual(pool.models);
  });

  it.each(['cancelled', 'succeeded', 'failed'] as const)('rejects a %s durable dispatch attempt after delayed notification', async status => {
    const h = hostFixture(1); const gate = deferred(); const entered = deferred();
    h.scope.scopedReply.mockImplementation(async (_a: unknown, _b: unknown, _c: unknown, opts: any) => { opts.beforeWrite(); entered.resolve(); await gate.promise; });
    const running = h.handle(h.request());
    await entered.promise;
    expect(h.scope.scopedReply).toHaveBeenCalledOnce();
    const runtime = h.sessionController.store.reserveRuntime(h.sessionController.ref, h.scope.contractWorker);
    h.sessionController.store.apply(h.sessionController.ref, { type: 'execution_terminal', execution: h.execution, runtime, status, evidence: 'synthetic_verified_terminal' });
    expect(h.sessionController.store.executions(h.sessionController.ref, 'om_turn', 1)[0]?.phase).toBe(status);
    await advance(5000);
    gate.resolve(); await running;
    expect(h.read()[0].traexAutoModel.models).toEqual(pool.models);
  });

  it('admits the new active attempt 2 without borrowing the terminal attempt 1', async () => {
    const h = hostFixture(1);
    const runtime = h.sessionController.store.reserveRuntime(h.sessionController.ref, h.scope.contractWorker);
    h.sessionController.store.apply(h.sessionController.ref, { type: 'execution_terminal', execution: h.execution, runtime, status: 'cancelled', evidence: 'verified_cancel' });
    h.sessionController.admitInput('om_turn', 2);
    await h.handle({ ...h.request(), dispatchAttempt: 2 });
    expect(h.read()[0].traexAutoModel.models).toEqual(['core', 'backup']);
    expect(h.scope.scopedReply).toHaveBeenCalledOnce();
    expect(h.worker.send).toHaveBeenCalledWith(expect.objectContaining({ result: expect.objectContaining({ status: 'applied' }) }));
  });

  it('revokes attempt 1 when attempt 2 appears during its notification', async () => {
    const h = hostFixture(1); const gate = deferred(); const entered = deferred();
    h.scope.scopedReply.mockImplementation(async (_a: unknown, _b: unknown, _c: unknown, opts: any) => { opts.beforeWrite(); entered.resolve(); await gate.promise; });
    const running = h.handle(h.request()); await entered.promise;
    h.sessionController.admitInput('om_turn', 2);
    await advance(5000); gate.resolve(); await running;
    expect(h.read()[0].traexAutoModel).toEqual(pool);
    expect(h.worker.send).not.toHaveBeenCalled();
  });

  it('does not let an unscoped attempt borrow a positive attempt execution', async () => {
    const h = hostFixture(1);
    const { dispatchAttempt: _attempt, ...unscoped } = h.request();
    await h.handle(unscoped);
    expect(h.read()[0].traexAutoModel).toEqual(pool);
    expect(h.scope.scopedReply).not.toHaveBeenCalled();
    expect(h.worker.send).not.toHaveBeenCalled();
  });

  it('keeps pre-bootstrap maintenance available when no execution exists yet', async () => {
    const h = hostFixture(1, false);
    expect(h.sessionController.store.executions(h.sessionController.ref)).toEqual([]);
    await h.handle(h.request());
    expect(h.read()[0].traexAutoModel.models).toEqual(['core', 'backup']);
    expect(h.worker.send).toHaveBeenCalledWith(expect.objectContaining({ result: expect.objectContaining({ status: 'applied' }) }));
  });

  it('admits a live follow-up execution while currentTurnId still names its predecessor', async () => {
    const h = hostFixture();
    h.sessionController.admitInput('om_followup');
    expect(h.ds.currentTurnId).toBe('om_turn');
    await h.handle({ ...h.request(), turnId: 'om_followup' });
    expect(h.read()[0].traexAutoModel.models).toEqual(['core', 'backup']);
    expect(h.worker.send).toHaveBeenCalledWith(expect.objectContaining({
      result: expect.objectContaining({ status: 'applied' }),
    }));
  });

  it('keeps the legacy current-turn fence when no contract execution exists to prove admission', async () => {
    const h = hostFixture();
    h.scope.sessionController = undefined;
    h.ds.currentTurnId = 'om_other';
    await h.handle(h.request());
    expect(h.read()[0].traexAutoModel.models).toEqual(pool.models);
    expect(h.worker.send).not.toHaveBeenCalled();
  });

  it('refreshes the registry after a durable commit even when a generation change suppresses the ACK', async () => {
    const h = hostFixture();
    const prune = h.scope.pruneSavedTraexModelPool;
    h.scope.pruneSavedTraexModelPool = async (args: any) => {
      const result = await prune(args);
      h.ds.workerGeneration++;
      h.ds.session.workerGeneration++;
      return result;
    };
    await h.handle(h.request());
    expect(h.read()[0].traexAutoModel.models).toEqual(['core', 'backup']);
    expect(h.botCfg.traexAutoModel.models).toEqual(['core', 'backup']);
    expect(h.ds.initConfig.traexAutoModel.models).toEqual(pool.models);
    expect(h.worker.send).not.toHaveBeenCalled();
  });

  it('does not let a stale committed result overwrite a later manual pool generation', async () => {
    const h = hostFixture();
    const prune = h.scope.pruneSavedTraexModelPool;
    h.scope.pruneSavedTraexModelPool = async (args: any) => {
      const result = await prune(args);
      await rmwBotEntry('cli_catalog_lifecycle', entry => {
        entry.traexAutoModel.models = ['manual'];
        entry.traexAutoModel.modelSettings = {};
        return { write: true, result: null };
      }, { path: h.path });
      h.botCfg.traexAutoModel = { ...pool, models: ['manual'], modelSettings: {} };
      h.ds.workerGeneration++;
      h.ds.session.workerGeneration++;
      return result;
    };
    await h.handle(h.request());
    expect(h.read()[0].traexAutoModel.models).toEqual(['manual']);
    expect(h.botCfg.traexAutoModel.models).toEqual(['manual']);
    expect(h.ds.initConfig.traexAutoModel.models).toEqual(pool.models);
    expect(h.worker.send).not.toHaveBeenCalled();
  });

  it('survives notification then rename failure; the next independent request can persist without touching another bot', async () => {
    const h = hostFixture(); const before = readFileSync(h.path, 'utf8'); const original = fsp.rename.bind(fsp);
    let fail = true;
    vi.spyOn(fsp, 'rename').mockImplementation(async (from, to) => {
      if (String(to) === h.path && fail) { fail = false; throw Object.assign(new Error('synthetic ENOSPC'), { code: 'ENOSPC' }); }
      return original(from, to);
    });
    await h.handle(h.request());
    expect(h.scope.scopedReply).toHaveBeenCalledOnce();
    expect(readFileSync(h.path, 'utf8')).toBe(before);
    expect(h.worker.send).toHaveBeenLastCalledWith(expect.objectContaining({ result: { status: 'failed', removedModels: [] } }));
    await advance(30_000);
    await h.handle(h.request('independent-flow-2'));
    expect(h.read()[0].traexAutoModel.models).toEqual(['core', 'backup']);
    expect(h.read()[1]).toEqual(JSON.parse(before)[1]);
    expect(h.worker.send).toHaveBeenLastCalledWith(expect.objectContaining({ result: expect.objectContaining({ status: 'applied' }) }));
  });
});

function startupFixture() {
  const h = workerSubmitHarness(); const c = new TraexAutoModelController(pool); c.beginTurn('om_first');
  const cfg: any = { cliId: 'traex', model: 'core', traexAutoModel: structuredClone(pool), prompt: 'unsent first task', turnId: 'om_first' };
  Object.assign(h.scope, {
    lastInitConfig: cfg, traexAutoModelController: c, cliSpawnGeneration: 1, backend: undefined,
    traexNativeStartupInputPending: true, traexFirstInputAdmissionPending: true, traexFirstSubmitConfirmed: false,
    traexAutoModelRuntimeEligible: () => true, traexAutoModelPreflightEnabled,
    CliSpawnSupersededError: class extends Error {},
    currentTraexLoadSnapshot: vi.fn(async () => null), TRAEX_AUTO_MODEL_DEFAULT_PREFLIGHT_TIMEOUT_MS: 8000,
    TRAEX_AUTO_MODEL_DEFAULT_OVERLOAD_THRESHOLD_PERCENT: 100,
    cliAdapter: { ...h.scope.cliAdapter, readyPattern: createTraexAdapter('/bin/true').readyPattern },
    backendScreenEvidenceIsAuthoritativeForMutation: () => true, screen: SHORTCUT,
    renderer: { rawSnapshot: () => h.scope.screen, writeAndFlush: vi.fn(async () => {}) },
    idleDetector: { isStartupPending: () => false, programStatusHeldWorking: () => false, lastProgramStatusReport: () => undefined },
    webTerminalInputGeneration: 0, webTerminalInputGenerationAtSpawn: 0,
    hookReviewInputHold: false, heldStuckPage: () => undefined,
    rememberTraexModelLoadSnapshot: vi.fn(), logTraexPreflightDecision: vi.fn(), notifyTraexPreflightDecision: vi.fn(),
    applyTraexAutoModelSettings: vi.fn((target: any, _c: any, model: string) => { target.model = model; }),
  });
  h.scope.pendingMessages.splice(0, h.scope.pendingMessages.length, { content: cfg.prompt, turnId: cfg.turnId });
  const preflight = loadWorkerFunction<any>('preflightTraexAutoModelBeforeSpawn', h.scope);
  const pending = loadWorkerFunction<any>('traexNativeStartupInputIsPending', h.scope);
  return { ...h, c, cfg, preflight: () => preflight(cfg, { spawnGeneration: 1, willReattachPersistent: false }), pending };
}

function connectWorker(h: ReturnType<typeof hostFixture>, dispatchAttempt?: number) {
  const c = new TraexAutoModelController(pool); c.beginTurn('om_turn');
  const cfg: any = { traexAutoModel: structuredClone(pool), turnId: 'om_turn', dispatchAttempt };
  const jobs: Promise<void>[] = [];
  const scope: any = { lastInitConfig: cfg, pendingTraexModelPoolPrunes: new Map(), randomUUID,
    traexAutoModelRuntimeEligible: () => true,
    traexAutoModelPolicyKey, send: vi.fn(), t: (key: string) => key,
    process: { send: vi.fn((msg: any) => { jobs.push(h.handle(msg)); }) } };
  h.worker.send.mockImplementation(loadWorkerMessageHandler('traex_model_pool_prune_result', scope));
  const reconcile = loadWorkerFunction<any>('reconcileTraexModelCatalog', scope);
  return { c, cfg, jobs, scope, reconcile: () => reconcile(catalog, c, cfg, () => true, 'om_turn', dispatchAttempt) };
}

describe('catalog worker request, host persistence and ACK composition', () => {
  it('revokes a real worker-issued cleanup when its durable attempt is cancelled before notice completion', async () => {
    const h = hostFixture(1); const w = connectWorker(h, 1); const gate = deferred(); const entered = deferred();
    h.scope.scopedReply.mockImplementation(async (_a: unknown, _b: unknown, _c: unknown, opts: any) => { opts.beforeWrite(); entered.resolve(); await gate.promise; });
    const result = w.reconcile();
    await entered.promise;
    expect(h.scope.scopedReply).toHaveBeenCalledOnce();
    const runtime = h.sessionController.store.reserveRuntime(h.sessionController.ref, h.scope.contractWorker);
    h.sessionController.store.apply(h.sessionController.ref, { type: 'execution_terminal', execution: h.execution, runtime, status: 'cancelled', evidence: 'synthetic_verified_cancel' });
    await advance(10_000); gate.resolve(); await Promise.all(w.jobs);
    // A revoked host may intentionally withhold the stale reply; drain its bounded timeout.
    await advance(20_000);
    expect(h.read()[0].traexAutoModel.models).toEqual(pool.models);
    expect(await result).toBe(false);
  });

  it('carries the queued head attempt rather than the old init attempt to the host', async () => {
    const h = hostFixture(2); const w = connectWorker(h, 1);
    w.cfg.turnId = 'om_previous';
    const head = { content: 'independent task', turnId: 'om_turn', dispatchAttempt: 2 };
    Object.assign(w.scope, {
      traexAutoModelController: w.c, pendingMessages: [head], cliSpawnGeneration: 1,
      isPromptReady: true, cliRestartInProgress: false, activeTurnAuthority: new ActiveTurnAuthority(),
      currentTraexLoadSnapshot: vi.fn(async () => catalog),
      TRAEX_AUTO_MODEL_DEFAULT_PREFLIGHT_TIMEOUT_MS: 8000, TRAEX_AUTO_MODEL_DEFAULT_OVERLOAD_THRESHOLD_PERCENT: 100,
      rememberTraexModelLoadSnapshot: vi.fn(), logTraexPreflightDecision: vi.fn(),
      executeTraexAutoModelSwitch: vi.fn(() => false), applyTraexAutoModelSettings: vi.fn(),
      notifyTraexPreflightDecision: vi.fn(), flushPending: vi.fn(), log: vi.fn(),
    });
    const sent = deferred<any>();
    w.scope.process.send.mockImplementation((msg: any) => { sent.resolve(msg); w.jobs.push(h.handle(msg)); });
    const select = loadWorkerFunction<any>('selectTraexCapacityModelBeforeTurn', w.scope);
    expect(select(head)).toBe(true);
    const request = await sent.promise;
    await Promise.all(w.jobs);
    // Also drain a withheld stale ACK in the mutation case before closing its store.
    await advance(20_000);
    expect(request.dispatchAttempt).toBe(2);
    expect(h.read()[0].traexAutoModel.models).toEqual(['core', 'backup']);
    expect(w.scope.flushPending).toHaveBeenCalledOnce();
  });

  it.each([false, true])('carries the cold startup attempt through the real preflight caller (retry=%s)', async retry => {
    const h = hostFixture(3); const w = connectWorker(h, 3);
    Object.assign(w.cfg, { prompt: 'initial task', model: 'core', cliId: 'traex' });
    let reads = 0;
    Object.assign(w.scope, {
      traexAutoModelController: w.c, cliSpawnGeneration: 1, cliAdapter: {},
      traexAutoModelRuntimeEligible: () => true, traexAutoModelPreflightEnabled,
      currentTraexLoadSnapshot: vi.fn(async () => ++reads === 1 && retry ? null : catalog),
      TRAEX_AUTO_MODEL_DEFAULT_PREFLIGHT_TIMEOUT_MS: 8000,
      rememberTraexModelLoadSnapshot: vi.fn(), CliSpawnSupersededError: class extends Error {}, log: vi.fn(),
    });
    const sent = deferred<any>();
    w.scope.process.send.mockImplementation((msg: any) => { sent.resolve(msg); w.jobs.push(h.handle(msg)); });
    const preflight = loadWorkerFunction<any>('preflightTraexAutoModelBeforeSpawn', w.scope);
    const running = preflight(w.cfg, { spawnGeneration: 1, willReattachPersistent: false });
    if (retry) { await running; await advance(30_000); }
    const request = await sent.promise;
    expect(request.dispatchAttempt).toBe(3);
    await Promise.all(w.jobs); await running; await advance(0);
    expect(h.read()[0].traexAutoModel.models).toEqual(['core', 'backup']);
  });

  it('keeps manual configuration when a 20s worker timeout overlaps a still-pending host notification', async () => {
    const h = hostFixture(); const w = connectWorker(h); const gate = deferred(); const entered = deferred();
    h.scope.scopedReply.mockImplementation(async (_a: unknown, _b: unknown, _c: unknown, opts: any) => { opts.beforeWrite(); entered.resolve(); await gate.promise; });
    const result = w.reconcile();
    await entered.promise;
    expect(h.scope.scopedReply).toHaveBeenCalledOnce();
    await advance(20_000);
    expect(await result).toBe(false);
    expect(w.scope.pendingTraexModelPoolPrunes.size).toBe(0);
    await rmwBotEntry('cli_catalog_lifecycle', entry => { entry.traexAutoModel.models = ['manual']; return { write: true, result: null }; }, { path: h.path });
    gate.resolve(); await Promise.all(w.jobs);
    expect(h.read()[0].traexAutoModel.models).toEqual(['manual']);
    expect(w.cfg.traexAutoModel.models).toEqual(pool.models);
    expect(h.scope.scopedReply).toHaveBeenCalledOnce();
    await advance(300_000);
    expect(w.scope.process.send).toHaveBeenCalledOnce();
  });

  it('recovers after notice+disk commit succeeds but ACK is lost without notifying the same missing set again', async () => {
    const h = hostFixture(); const w = connectWorker(h); const deliver = h.worker.send.getMockImplementation();
    h.worker.send.mockImplementation((msg: any) => { if (msg.type !== 'traex_model_pool_prune_result') return deliver(msg); });
    const result = w.reconcile(); await Promise.all(w.jobs);
    expect(h.read()[0].traexAutoModel.models).toEqual(['core', 'backup']);
    await advance(20_000); expect(await result).toBe(false);
    // Cold restore loads the committed pool, not the timed-out worker's cached policy.
    const next = connectWorker(h); next.cfg.traexAutoModel = h.read()[0].traexAutoModel;
    const restored = new TraexAutoModelController(next.cfg.traexAutoModel);
    expect(await loadWorkerFunction<any>('reconcileTraexModelCatalog', next.scope)(catalog, restored, next.cfg, () => true, 'om_new')).toBe(true);
    expect(h.scope.scopedReply).toHaveBeenCalledOnce();
    expect(restored.config.models).toEqual(['core', 'backup']);
  });
});

describe('catalog retry across first-input startup admission', () => {
  it('continues bounded retries while the real first-input fence still owns an unsubmitted task', async () => {
    const h = startupFixture(); await h.preflight();
    h.scope.backend = {};
    expect(h.pending()).toBe(true);
    await h.flush();
    expect(h.scope.cliAdapter.writeInput).not.toHaveBeenCalled();
    await advance(30_000);
    expect(h.pending()).toBe(true);
    expect(h.scope.pendingMessages).toHaveLength(1);
    expect(h.scope.currentTraexLoadSnapshot).toHaveBeenCalledTimes(2);
    await advance(30_000);
    expect(h.scope.currentTraexLoadSnapshot).toHaveBeenCalledTimes(3);
    await advance(300_000);
    expect(h.scope.currentTraexLoadSnapshot).toHaveBeenCalledTimes(3);
  });

  it.each(['cancel', 'controller', 'generation'])('abandons a long read after %s without pruning or selecting', async change => {
    const h = startupFixture(); const wait = deferred<any>();
    h.scope.currentTraexLoadSnapshot.mockImplementation(() => wait.promise);
    const running = h.preflight().then(() => null, (error: Error) => error);
    await advance(7500);
    if (change === 'cancel') h.c.requestRecoveryStop('om_first');
    if (change === 'controller') h.scope.traexAutoModelController = new TraexAutoModelController({ ...pool, models: ['manual'] });
    if (change === 'generation') h.scope.cliSpawnGeneration++;
    wait.resolve(catalog); const result = await running;
    expect(result).toBeInstanceOf(Error);
    expect(h.cfg.model).toBe('core');
    expect(h.scope.applyTraexAutoModelSettings).not.toHaveBeenCalled();
    expect(h.scope.send).not.toHaveBeenCalled();
  });
});

describe('capacity observations during slow background catalog retry', () => {
  function queueFixture() {
    const h = startupFixture(); const longRead = deferred<any>();
    let reads = 0;
    h.scope.currentTraexLoadSnapshot.mockImplementation(() => ++reads === 2 ? longRead.promise : Promise.resolve(null));
    Object.assign(h.scope, { traexAutoModelSwitching: false, traexQuotaPending: undefined, traexAutoModelTurnReplayForbidden: false,
      activeTurnAuthority: new ActiveTurnAuthority(), currentBotmuxTurnId: 'om_first', commandLineWritesPending: 0,
      traexCapacityQueueVisible, traexModelProgressVisible, traexQueuedTypeAheadVisible, traexCapacityQueuePosition,
      executeTraexAutoModelSwitch: vi.fn(), publishActiveRuntime: vi.fn(), flushPending: vi.fn(), isPromptReady: false });
    h.cfg.cliSessionId = 'synthetic-native';
    const observe = loadWorkerFunction<any>('observeTraexAutoModelCapacity', h.scope);
    return { ...h, longRead, observe };
  }
  const queue = 'Request queued, position: 3';
  it('shares one retry flow across repeated queue ticks and waits from failure completion, not query start', async () => {
    const h = queueFixture(); await h.preflight(); h.scope.backend = {};
    h.scope.activeTurnAuthority.reserve({ turnId: 'om_first' }); h.scope.activeTurnAuthority.markStarted({ turnId: 'om_first' }); h.c.markInputSubmitted('om_first');
    h.scope.traexNativeStartupInputPending = false; h.scope.traexFirstInputAdmissionPending = false; h.scope.traexFirstSubmitConfirmed = true;
    h.observe(queue);
    const ticks = setInterval(() => h.observe(queue), 1000);
    await advance(30_000);
    expect(h.scope.currentTraexLoadSnapshot).toHaveBeenCalledTimes(2);
    await advance(7000);
    expect(h.scope.currentTraexLoadSnapshot).toHaveBeenCalledTimes(2);
    const failureCompletedAt = Date.now();
    h.longRead.resolve(null); await h.longRead.promise; await advance(0);
    // Bun may move the clock by 1ms while draining a zero-duration interval
    // edge. Assert the absolute retry boundary instead of assuming that drain
    // left Date.now unchanged.
    await advance(failureCompletedAt + 30_000 - Date.now() - 1);
    expect(h.scope.currentTraexLoadSnapshot).toHaveBeenCalledTimes(2);
    await advance(1);
    expect(h.scope.currentTraexLoadSnapshot).toHaveBeenCalledTimes(3);
    await advance(300_000); clearInterval(ticks);
    expect(h.scope.currentTraexLoadSnapshot).toHaveBeenCalledTimes(3);
    expect(h.scope.executeTraexAutoModelSwitch).not.toHaveBeenCalled();
  });
  it('discards a slow retry result when the model becomes healthy before it resolves', async () => {
    const h = queueFixture(); await h.preflight(); h.scope.backend = {};
    h.scope.activeTurnAuthority.reserve({ turnId: 'om_first' }); h.scope.activeTurnAuthority.markStarted({ turnId: 'om_first' }); h.c.markInputSubmitted('om_first');
    h.scope.traexNativeStartupInputPending = false; h.scope.traexFirstInputAdmissionPending = false; h.scope.traexFirstSubmitConfirmed = true;
    h.observe(queue); await advance(30_000);
    h.observe('◆ Working… (2s • esc to interrupt)');
    await advance(7000); h.longRead.resolve(catalog); await h.longRead.promise;
    await advance(300_000);
    expect(h.scope.currentTraexLoadSnapshot).toHaveBeenCalledTimes(2);
    expect(h.cfg.traexAutoModel.models).toEqual(pool.models);
    expect(h.scope.executeTraexAutoModelSwitch).not.toHaveBeenCalled();
    expect(h.scope.traexCatalogRetryPending).toBeUndefined();
  });
});
