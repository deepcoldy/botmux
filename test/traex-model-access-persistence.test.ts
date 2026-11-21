import { InputDeliveryEvidenceTracker } from '../src/services/input-delivery-evidence.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../src/config.js';
import * as store from '../src/services/session-store.js';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';
import { TraexAutoModelController, validTraexAutoModelRuntime, TRAEX_AUTO_MODEL_DEFAULT_PREFLIGHT_TIMEOUT_MS,
  TRAEX_AUTO_MODEL_DEFAULT_OVERLOAD_THRESHOLD_PERCENT } from '../src/services/traex-auto-model.js';
import { TRAEX_MODEL_ACCESS_ERROR_CODE } from '../src/services/traex-model-access.js';
import { TRAEX_QUOTA_ERROR_CODE } from '../src/services/traex-quota.js';
import { ActiveTurnAuthority } from '../src/core/active-turn-authority.js';
import { InflightInputTracker } from '../src/core/inflight-input-tracker.js';
import { traexCapacityQueueVisible, traexCapacityQueuePosition, traexModelProgressVisible, traexQueuedTypeAheadVisible } from '../src/adapters/cli/traex.js';

const appId = 'model-access-persistence';
const models = ['first', 'second', 'third'];
const policy = { enabled: true as const, models, queueTimeoutMs: 5000 };
let root: string;
let originalDataDir: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'model-access-store-'));
  originalDataDir = config.session.dataDir;
  config.session.dataDir = join(root, 'data');
  store.init(appId);
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-06T00:00:00Z'));
});
afterEach(() => {
  store.init('model-access-detached', { owner: false });
  config.session.dataDir = originalDataDir;
  vi.useRealTimers(); readdirSync(root); rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const session = store.createSession('oc_test', 'om_test', 'isolated model access persistence');
  session.cliId = 'traex'; session.cliSessionId = 'native'; store.updateSession(session);
  const pool = new TraexAutoModelController(policy); pool.beginTurn('turn');
  const authority = new ActiveTurnAuthority(); authority.reserve({ turnId: 'turn' }); authority.markStarted({ turnId: 'turn' });
  const tracker = new InflightInputTracker(); tracker.onWrite({ content: 'original', turnId: 'turn' });
  let resolve!: (value: any) => void;
  const query = new Promise<any>(done => { resolve = done; });
  const scope: Record<string, any> = {
    inputDeliveryEvidence: new InputDeliveryEvidenceTracker(),
    traexAutoModelController: pool, traexAutoModelRuntimeEligible: () => true,
    activeTurnAuthority: authority, inflightInputs: tracker, currentBotmuxTurnId: 'turn', cliSpawnGeneration: 1,
    lastInitConfig: { cliId: 'traex', cliSessionId: 'native', model: models[0] }, backend: {},
    traexAutoModelSwitching: false, cliRestartInProgress: false, isFlushing: false, isPromptReady: false,
    currentInputDeliveryQuarantine: () => null,
    commandLineWritesPending: 0, pendingMessages: [], currentBotmuxCallerOpenId: 'caller',
    currentTraexLoadSnapshot: () => query, currentTraexQuotas: vi.fn(), rememberTraexModelLoadSnapshot: vi.fn(),
    TRAEX_MODEL_ACCESS_ERROR_CODE, TRAEX_QUOTA_ERROR_CODE, TRAEX_AUTO_MODEL_DEFAULT_PREFLIGHT_TIMEOUT_MS,
    TRAEX_AUTO_MODEL_DEFAULT_OVERLOAD_THRESHOLD_PERCENT, activeRuntimePublished: false, publishedActiveRuntime: {},
    applyTraexAutoModelSettings: (cfg: any, _controller: unknown, model: string) => { cfg.model = model; },
    restartCliProcess: vi.fn(async () => {}), emitReadyCodexTurns: vi.fn(), idleDetector: { fireIdle: vi.fn() },
    log: vi.fn(), t: (key: string) => key,
    send: (message: any) => {
      if (message.type === 'active_runtime') {
        session.traexAutoModelRuntime = message.traexAutoModelRuntime;
        store.updateSession(session);
      }
    },
  };
  for (const name of ['publishActiveRuntime', 'enqueueTraexAutoModelRecovery', 'executeTraexAutoModelSwitch',
    'notifyTraexModelAccessSwitchActivity', 'holdTraexRecoveryForStop', 'settleStoppedTraexRecovery']) {
    scope[name] = loadWorkerFunction(name, scope);
  }
  const turn = { turnId: 'turn', sourceTurnId: 'native-turn', terminalStatus: 'failed', terminalErrorCode: TRAEX_MODEL_ACCESS_ERROR_CODE };
  scope.releaseInputDeliveryQuarantineForStructuredTerminal = loadWorkerFunction('releaseInputDeliveryQuarantineForStructuredTerminal', scope);
  const recover = loadWorkerFunction<(turn: any) => boolean>('recoverTraexQuotaTurn', scope);
  const fresh = () => store.getSessionFresh(session.sessionId)!;
  return { pool, scope, turn, recover, resolve, fresh };
}
async function drain() { for (let i = 0; i < 15; i++) await Promise.resolve(); }

describe('real Worker runtime publication and SessionStore persistence', () => {
  it('writes the refusal to storage before the directory lookup can complete', () => {
    const f = fixture(); expect(f.recover(f.turn)).toBe(true);
    store.init(appId, { owner: false });
    const persisted = f.fresh().traexAutoModelRuntime;
    expect(persisted?.modelAccessRecovery?.blockedModels).toEqual([models[0]]);
    expect(validTraexAutoModelRuntime(policy, persisted, 'native')).toBe(true);
    const restored = new TraexAutoModelController(policy, persisted);
    expect(restored.observeModelAccessFailure('turn', null)).toMatchObject({ toModel: models[1] });
  });
  it('writes actual queue names and ranks before the next directory lookup returns', async () => {
    const f = fixture(); f.recover(f.turn);
    f.resolve({ loads: new Map(models.map((model, index) => [model, index * 10])) }); await drain();
    f.scope.traexAutoModelSwitching = false; f.scope.backend = {};
    Object.assign(f.scope, { cliAdapter: { resolvedBin: 'unused' }, buildSessionChildEnv: () => ({}), botInjectedEnv: () => ({}),
      readTraexModelLoadSnapshot: () => new Promise(() => {}), traexCapacityQueueVisible, traexCapacityQueuePosition,
      traexModelProgressVisible, traexQueuedTypeAheadVisible, flushPending: vi.fn(),
    });
    const observe = loadWorkerFunction<(screen: string) => void>('observeTraexAutoModelCapacity', f.scope);
    const screen = "◆ Queued for capacity (20s • esc to interrupt)\n  └ Too many requests right now. You're in the queue at position 15.\nContext 99% left";
    observe(screen); vi.advanceTimersByTime(1001); observe(screen);
    store.init(appId, { owner: false });
    const persisted = f.fresh().traexAutoModelRuntime;
    expect(persisted?.modelAccessRecovery?.queuedModels).toEqual([models[1]]);
    expect(persisted?.modelAccessRecovery?.queuePositions).toEqual([{ model: models[1], position: 15, atMs: Date.now() }]);
    const restored = new TraexAutoModelController(policy, persisted);
    const next = restored.observeModelAccessFailure('turn', null);
    expect(next).toMatchObject({ toModel: models[2] });
  });
  it('stores stop intent and suppresses recovery in a fresh Worker controller', () => {
    const f = fixture(); f.recover(f.turn); f.scope.holdTraexRecoveryForStop('turn');
    store.init(appId, { owner: false });
    const persisted = f.fresh().traexAutoModelRuntime;
    expect(persisted?.stoppedRecoveryTurnId).toBe('turn');
    const restored = new TraexAutoModelController(policy, persisted);
    expect(restored.recoveryStopped('turn')).toBe(true);
    expect(restored.observeModelAccessFailure('turn', null)).toEqual({ kind: 'none' });
    expect(f.scope.inflightInputs.onCliExit()).toBe(0);
  });
});
