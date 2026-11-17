/** Real worker closures/controllers with injected catalog IPC and native input I/O. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { promises as fsp } from 'node:fs';
import { ActiveTurnAuthority } from '../src/core/active-turn-authority.js';
import { TraexAutoModelController, traexAutoModelPolicyKey, traexAutoModelPreflightEnabled } from '../src/services/traex-auto-model.js';
import { beginRuntimeWriteCycle } from '../src/utils/runtime-screen-status.js';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';
import { workerSubmitHarness } from './helpers/worker-submit-harness.js';

const basePool = { enabled: true as const, models: ['core', 'backup'], queueTimeoutMs: 5_000, preflightLoadCheck: true };
const backupCatalog = { catalogModels: new Set(['backup']), loads: new Map([['backup', 10]]), reasoningEfforts: new Map() };
const coreOnlyCatalog = { catalogModels: new Set(['core']), loads: new Map([['core', 20]]), reasoningEfforts: new Map() };

type ReplyKind = 'superseded' | 'sibling' | 'applied' | 'empty' | 'failed' | 'timeout' | 'none';

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllTimers();
  vi.useRealTimers();
});

function idlePreflightProbe(options: { reply?: ReplyKind; catalog?: typeof backupCatalog; preflight?: boolean; dispatchAttempt?: number; siblingModels?: string[]; sameTurn?: boolean } = {}) {
  const h = workerSubmitHarness();
  const { scope } = h;
  const pool = { ...basePool, preflightLoadCheck: options.preflight ?? true };
  const controller = new TraexAutoModelController(pool);
  const owningTurn = options.sameTurn ? 'next' : 'previous';
  controller.beginTurn(owningTurn);
  const head: Record<string, any> = { content: 'follow-up', turnId: 'next' };
  if (options.dispatchAttempt !== undefined) head.dispatchAttempt = options.dispatchAttempt;
  scope.pendingMessages.splice(0, scope.pendingMessages.length, head);
  const pendingPrunes = new Map<string, any>();
  const pruneRequests: any[] = [];
  const replyKind = options.reply ?? 'applied';
  const catalog = options.catalog ?? backupCatalog;
  Object.assign(scope, {
    backend: { captureViewportAsync: vi.fn(async () => '❯ Use /skills to list available skills') },
    lastInitConfig: { cliId: 'traex', cliSessionId: 'native-old', model: 'core', traexAutoModel: structuredClone(pool) },
    traexAutoModelRuntimeEligible: () => true,
    traexAutoModelController: controller, traexAutoModelSwitching: false,
    traexAutoModelTurnReplayForbidden: false, traexAutoModelPreflightPending: undefined,
    traexAutoModelPreflightEnabled, activeTurnAuthority: new ActiveTurnAuthority(),
    currentBotmuxTurnId: owningTurn, backendScreenRevision: 0, observedPaneGridRevision: 0,
    renderer: null, backendScreenEvidenceIsAuthoritativeForMutation: () => true,
    commandLineWritesPending: 0, injectionFlushing: false,
    currentPostTerminalInputFence: () => null, retryTraexAutoModelAdmission: vi.fn(),
    traexCapacityQueueVisible: () => false, traexModelProgressVisible: () => false,
    traexQueuedTypeAheadVisible: () => false, traexAutoModelInputHold: () => false,
    promptReadinessRevision: 0, webTerminalInputGeneration: 0,
    beginRuntimeWriteCycle, backgroundTaskTracker: { noteMainTurn: vi.fn() },
    publishActiveRuntime: vi.fn(), markTurnRetired: vi.fn(),
    acknowledgeTurnInputCommitted: vi.fn(), maybeQueuePostSubmitNativeSessionTitle: vi.fn(),
    currentTraexLoadSnapshot: vi.fn(async () => catalog),
    TRAEX_AUTO_MODEL_DEFAULT_PREFLIGHT_TIMEOUT_MS: 8_000,
    TRAEX_AUTO_MODEL_DEFAULT_OVERLOAD_THRESHOLD_PERCENT: 100,
    pendingTraexModelPoolPrunes: pendingPrunes, randomUUID: () => `prune-${pruneRequests.length + 1}`,
    traexAutoModelPolicyKey,
    process: { send: vi.fn((msg: any) => {
      pruneRequests.push(msg);
      if (replyKind === 'timeout') return;
      const entry = pendingPrunes.get(msg.requestId);
      clearTimeout(entry.timeout);
      pendingPrunes.delete(msg.requestId);
      const result = replyKind === 'superseded'
        ? { status: 'superseded', removedModels: [] }
        : replyKind === 'sibling'
          ? { status: 'superseded', removedModels: [], config: { ...pool, models: options.siblingModels ?? ['backup'] } }
          : replyKind === 'failed'
            ? { status: 'failed', removedModels: [] }
            : replyKind === 'empty'
              ? { status: 'applied', removedModels: ['core', 'backup'], config: { ...pool, models: [], catalogUnavailable: true as const } }
              : { status: 'applied', removedModels: ['core'], config: { ...pool, models: ['backup'] } };
      entry.resolve(result);
    }) },
    send: vi.fn(), t: (key: string) => key, log: vi.fn(),
    rememberTraexModelLoadSnapshot: vi.fn(), logTraexPreflightDecision: vi.fn(),
    notifyTraexPreflightDecision: vi.fn(), executeTraexAutoModelSwitch: vi.fn(() => true),
    applyTraexAutoModelSettings: vi.fn((target: any, _c: any, model: string) => { target.model = model; }),
  });
  scope.resetTraexAutoModelBeforePendingTurn = loadWorkerFunction('resetTraexAutoModelBeforePendingTurn', scope);
  scope.selectTraexCapacityModelBeforeTurn = loadWorkerFunction('selectTraexCapacityModelBeforeTurn', scope);
  scope.admitTraexAutoModelPendingInput = loadWorkerFunction('admitTraexAutoModelPendingInput', scope);
  scope.deferNativeCodexInputCommit = loadWorkerFunction('deferNativeCodexInputCommit', scope);
  scope.deferTurnInputCommitUntilSubmission = loadWorkerFunction('deferTurnInputCommitUntilSubmission', scope);
  scope.idleDetector.reset = vi.fn();
  scope.revokePromptReadiness = loadWorkerFunction('revokePromptReadiness', scope);
  scope.beginCliWriteCycle = loadWorkerFunction('beginCliWriteCycle', scope);
  scope.cliAdapter.writeInput = vi.fn(async () => ({ submitted: true }));
  const flush = vi.fn(loadWorkerFunction<() => Promise<void>>('flushPending', scope));
  scope.flushPending = flush;
  return { h, scope, controller, head, flush, pruneRequests, pendingPrunes, pool };
}

describe('idle catalog reconciliation settles the queued input', () => {
  it.each(['superseded', 'failed'] as const)('falls back to the pre-catalog flow after %s instead of stranding the head', async reply => {
    const p = idlePreflightProbe({ reply });
    await p.flush();
    await vi.waitFor(() => expect(p.scope.cliAdapter.writeInput).toHaveBeenCalledOnce());
    expect(p.head.traexAutoModelPreflightDone).toBe(true);
    expect(p.scope.pendingMessages).toEqual([]);
    expect(p.controller.currentModel()).toBe('core');
    expect(p.scope.executeTraexAutoModelSwitch).not.toHaveBeenCalled();
    expect(p.pruneRequests).toHaveLength(1);
  });

  it('reports a 20s ACK timeout as unconfirmed, then delivers through the old flow', async () => {
    vi.useFakeTimers();
    const p = idlePreflightProbe({ reply: 'timeout' });
    await p.flush();
    // Wait until the real async catalog read has registered its prune request;
    // otherwise Bun advances the clock before the 20s timeout exists.
    await vi.advanceTimersByTimeAsync(0);
    expect(p.pendingPrunes.size).toBe(1);
    await vi.advanceTimersByTimeAsync(20_000);
    // Bun drains the newly queued promise chain on the following zero-duration
    // timer edge rather than within the 20s advance itself.
    await vi.advanceTimersByTimeAsync(0);
    await fsp.stat('package.json');
    expect(p.scope.cliAdapter.writeInput).toHaveBeenCalledOnce();
    expect(p.head.traexAutoModelPreflightDone).toBe(true);
    expect(p.scope.pendingMessages).toEqual([]);
    const notices = p.scope.send.mock.calls.map(call => call[0]);
    expect(notices).toContainEqual(expect.objectContaining({ message: 'worker.traex_auto_model.catalog_persist_timeout' }));
    expect(notices).not.toContainEqual(expect.objectContaining({ message: 'worker.traex_auto_model.catalog_persist_failed' }));
  });

  it('adopts a sibling-pruned subset returned with superseded and continues normally', async () => {
    const p = idlePreflightProbe({ reply: 'sibling', siblingModels: ['core'], catalog: coreOnlyCatalog });
    await p.flush();
    await vi.waitFor(() => expect(p.scope.cliAdapter.writeInput).toHaveBeenCalledOnce());
    expect(p.scope.lastInitConfig.traexAutoModel.models).toEqual(['core']);
    expect(p.controller.currentModel()).toBe('core');
    expect(p.scope.pendingMessages).toEqual([]);
  });

  it('never adopts a superseded config that is not a strict directory-confirmed subset', async () => {
    // A manual pool edit can carry a foreign model and the same length as the
    // current pool. Only a strictly smaller, catalog-confirmed subset may be
    // adopted; anything else must fall back with the original pool intact.
    const p = idlePreflightProbe({ reply: 'sibling', siblingModels: ['core', 'manual-choice'], catalog: coreOnlyCatalog });
    await p.flush();
    await vi.waitFor(() => expect(p.scope.cliAdapter.writeInput).toHaveBeenCalledOnce());
    expect(p.scope.lastInitConfig.traexAutoModel.models).toEqual(['core', 'backup']);
    expect(p.controller.config.models).toEqual(['core', 'backup']);
    expect(p.scope.pendingMessages).toEqual([]);
  });

  it('executes catalog_unavailable before writing and forwards the queued attempt', async () => {
    const p = idlePreflightProbe({ reply: 'applied', dispatchAttempt: 2 });
    await p.flush();
    await vi.waitFor(() => expect(p.scope.executeTraexAutoModelSwitch).toHaveBeenCalledOnce());
    expect(p.scope.executeTraexAutoModelSwitch).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'switch', reason: 'catalog_unavailable', fromModel: 'core', toModel: 'backup', turnId: 'next' }),
      { resumeCurrentTurn: false, dispatchAttempt: 2 },
    );
    expect(p.scope.cliAdapter.writeInput).not.toHaveBeenCalled();
    expect(p.scope.pendingMessages).toEqual([p.head]);
    expect(p.scope.lastInitConfig.cliSessionId).toBe('native-old');
  });

  it('holds an empty pool without duplicate catalog_empty notices on later flush edges', async () => {
    const p = idlePreflightProbe({ reply: 'empty' });
    await p.flush();
    await vi.waitFor(() => expect(p.head.traexAutoModelPreflightDone).toBe(true));
    await p.flush();
    expect(p.scope.cliAdapter.writeInput).not.toHaveBeenCalled();
    expect(p.scope.executeTraexAutoModelSwitch).not.toHaveBeenCalled();
    expect(p.scope.pendingMessages).toEqual([p.head]);
    const emptyNotices = p.scope.send.mock.calls.map(call => call[0])
      .filter(message => message.message === 'worker.traex_auto_model.catalog_empty');
    expect(emptyNotices).toHaveLength(1);
  });
});

function queuedProbe(reply: 'superseded' | 'sibling' | 'failed' | 'timeout') {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(0);
  const controller = new TraexAutoModelController(basePool);
  controller.beginTurn('turn', { retainCurrentModel: true });
  const resolveLoads = vi.spyOn(controller, 'resolveModelLoads');
  const activeTurnAuthority = new ActiveTurnAuthority();
  activeTurnAuthority.reserve({ turnId: 'turn' });
  activeTurnAuthority.markStarted({ turnId: 'turn' });
  const pendingPrunes = new Map<string, any>();
  let reconcileSettled!: (value: boolean) => void;
  const settled = new Promise<boolean>(resolve => { reconcileSettled = resolve; });
  const catalog = reply === 'sibling' ? backupCatalog : coreOnlyCatalog;
  const scope: Record<string, any> = {
    traexAutoModelController: controller, traexAutoModelRuntimeEligible: () => true,
    traexAutoModelSwitching: false, cliRestartInProgress: false, isFlushing: false,
    traexQuotaPending: undefined, isPromptReady: false, traexAutoModelTurnReplayForbidden: false,
    lastInitConfig: { cliId: 'traex', cliSessionId: 'native', traexAutoModel: basePool },
    activeTurnAuthority, currentBotmuxTurnId: 'turn', backend: {}, cliSpawnGeneration: 1,
    traexModelProgressVisible: () => false, traexQueuedTypeAheadVisible: () => false,
    traexCapacityQueueVisible: () => true, traexCapacityQueuePosition: () => 3,
    currentTraexLoadSnapshot: vi.fn(async () => catalog),
    TRAEX_AUTO_MODEL_DEFAULT_PREFLIGHT_TIMEOUT_MS: 8_000,
    pendingTraexModelPoolPrunes: pendingPrunes, randomUUID: () => 'queued-prune', traexAutoModelPolicyKey,
    process: { send: vi.fn((msg: any) => {
      if (reply === 'timeout') return;
      const entry = pendingPrunes.get(msg.requestId);
      clearTimeout(entry.timeout); pendingPrunes.delete(msg.requestId);
      entry.resolve(reply === 'sibling'
        ? { status: 'superseded', removedModels: [], config: { ...basePool, models: ['backup'] } }
        : reply === 'failed'
          ? { status: 'failed', removedModels: [] }
          : { status: 'superseded', removedModels: [] });
    }) },
    send: vi.fn(), t: (key: string) => key, log: vi.fn(),
    rememberTraexModelLoadSnapshot: vi.fn(), executeTraexAutoModelSwitch: vi.fn(() => true),
    publishActiveRuntime: vi.fn(), flushPending: vi.fn(), commandLineWritesPending: 0,
  };
  const reconcile = loadWorkerFunction<any>('reconcileTraexModelCatalog', scope);
  scope.reconcileTraexModelCatalog = async (...args: any[]) => {
    const value = await reconcile(...args);
    reconcileSettled(value);
    return value;
  };
  const observe = loadWorkerFunction<any>('observeTraexAutoModelCapacity', scope);
  return { scope, controller, resolveLoads, observe, settled };
}

describe('queued catalog reconciliation releases or completes the pending load check', () => {
  it('settles superseded without config through resolveModelLoads(null), allowing ordered fallback', async () => {
    const p = queuedProbe('superseded');
    p.observe('Request queued, position: 3');
    vi.setSystemTime(5_000);
    p.observe('Request queued, position: 3');
    expect(await p.settled).toBe(false);
    await vi.waitFor(() => expect(p.resolveLoads).toHaveBeenCalledWith('turn', null));
    vi.setSystemTime(10_000);
    p.observe('Request queued, position: 3');
    expect(p.scope.executeTraexAutoModelSwitch).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'switch', toModel: 'backup' }), { resumeCurrentTurn: true },
    );
  });

  it.each([
    { reply: 'failed' as const, nextTickMs: 10_000 },
    { reply: 'timeout' as const, nextTickMs: 30_000 },
  ])('settles $reply through resolveModelLoads(null) and keeps ordered fallback live', async ({ reply, nextTickMs }) => {
    const p = queuedProbe(reply);
    p.observe('Request queued, position: 3');
    vi.setSystemTime(5_000);
    p.observe('Request queued, position: 3');
    if (reply === 'timeout') {
      await vi.advanceTimersByTimeAsync(0);
      await fsp.stat('package.json');
      await vi.advanceTimersByTimeAsync(20_000);
      await fsp.stat('package.json');
    }
    expect(await p.settled).toBe(false);
    await vi.waitFor(() => expect(p.resolveLoads).toHaveBeenCalledWith('turn', null));
    vi.setSystemTime(nextTickMs);
    p.observe('Request queued, position: 3');
    expect(p.scope.executeTraexAutoModelSwitch).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'switch', toModel: 'backup' }), { resumeCurrentTurn: true },
    );
  });

  it('uses a sibling subset immediately and rotates away from the removed current model', async () => {
    const p = queuedProbe('sibling');
    p.observe('Request queued, position: 3');
    vi.setSystemTime(5_000);
    p.observe('Request queued, position: 3');
    expect(await p.settled).toBe(true);
    await vi.waitFor(() => expect(p.scope.executeTraexAutoModelSwitch).toHaveBeenCalledOnce());
    expect(p.resolveLoads).toHaveBeenCalledWith('turn', backupCatalog.loads);
    expect(p.scope.executeTraexAutoModelSwitch).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'switch', reason: 'catalog_unavailable', fromModel: 'core', toModel: 'backup' }),
      { resumeCurrentTurn: true },
    );
  });
});

describe('catalog proof arriving at the final write edge', () => {
  it('requeues before any native write and executes the deferred catalog switch', async () => {
    const p = idlePreflightProbe({ reply: 'none', preflight: false });
    p.scope.runAmbiguousSubmissionTransaction = async (_backend: unknown, write: () => Promise<any>, _accepted: unknown, prepare: () => void) => {
      p.controller.observeModelCatalog(new Set(['backup']));
      p.controller.markCatalogPruned(['core'], { ...p.pool, models: ['backup'] });
      prepare();
      return { result: await write() };
    };
    await p.flush();
    await vi.waitFor(() => expect(p.scope.executeTraexAutoModelSwitch).toHaveBeenCalledOnce());
    expect(p.scope.cliAdapter.writeInput).not.toHaveBeenCalled();
    expect(p.scope.pendingMessages).toEqual([p.head]);
    expect(p.scope.executeTraexAutoModelSwitch).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'switch', reason: 'catalog_unavailable', fromModel: 'core', toModel: 'backup' }),
      { resumeCurrentTurn: false },
    );
  });

  it.each([
    { name: 'same-turn ordinary retry', dispatchAttempt: undefined },
    { name: 'same-turn durable attempt', dispatchAttempt: 2 },
  ])('fences a $name when catalog proof arrives after the pre-dequeue gate', async ({ dispatchAttempt }) => {
    const p = idlePreflightProbe({ reply: 'none', preflight: false, sameTurn: true, dispatchAttempt });
    p.scope.runAmbiguousSubmissionTransaction = async (_backend: unknown, write: () => Promise<any>, _accepted: unknown, prepare: () => void) => {
      p.controller.observeModelCatalog(new Set(['backup']));
      p.controller.markCatalogPruned(['core'], { ...p.pool, models: ['backup'] });
      prepare();
      return { result: await write() };
    };
    await p.flush();
    await vi.waitFor(() => expect(p.scope.executeTraexAutoModelSwitch).toHaveBeenCalledOnce());
    expect(p.scope.cliAdapter.writeInput).not.toHaveBeenCalled();
    expect(p.scope.pendingMessages).toEqual([p.head]);
    expect(p.scope.executeTraexAutoModelSwitch).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'switch', reason: 'catalog_unavailable', fromModel: 'core', toModel: 'backup', turnId: 'next' }),
      { resumeCurrentTurn: false, ...(dispatchAttempt !== undefined ? { dispatchAttempt } : {}) },
    );
  });
});
