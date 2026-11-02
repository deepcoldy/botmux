import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../src/config.js';
import * as store from '../src/services/session-store.js';
import type { Session } from '../src/types.js';
import {
  cancelDeploymentContinuation, claimDeploymentContinuation, deploymentContinuationCandidate,
  deploymentContinuationTemplate, recordDeploymentContinuation,
} from '../src/services/deployment-continuation.js';
import { restartNoteInput, restartInterruptionNote } from '../src/services/restart-interruption.js';
import { loadWorkerFunction, loadWorkerMessageHandler } from './helpers/worker-function-harness.js';

let directory: string, previousDirectory: string, row: Session;
const caller = { senderType: 'user' as const, requestUserOpenId: 'ou_sender', requestLarkAppId: 'app_test' };
const receipt = { type: 'native_input_consumed' as const, ordinaryInteractive: true as const, turnId: 'om_task', proofKind: 'codex_history_match' as const, nativeSessionId: 'native-original' };
const context = { caller, currentTurnId: receipt.turnId, workerGeneration: 1, rpc: false };
const persist = (previous: Session['deploymentContinuation']) => store.updateDeploymentContinuation(row, previous);
const arm = () => recordDeploymentContinuation(row, receipt, context, persist);
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-27T12:00:00Z'));
  directory = mkdtempSync(join(tmpdir(), 'deploy-continuation-'));
  previousDirectory = config.session.dataDir; config.session.dataDir = directory;
  store.init('app_test');
  row = store.createSession('oc_chat', 'om_root', 'task', 'group', 'thread');
  Object.assign(row, { larkAppId: 'app_test', backendType: 'tmux', cliId: 'codex', cliSessionId: receipt.nativeSessionId, workerGeneration: 1, ownerOpenId: 'ou_not_sender' });
  store.updateSession(row);
});
afterEach(() => {
  vi.useRealTimers(); config.session.dataDir = previousDirectory;
  rmSync(directory, { recursive: true, force: true });
});

describe('native-consumed deployment continuation with real SQLite', () => {
  it('survives reload, claims once, and continues with the original caller without replaying the prompt', () => {
    expect(arm()).toBe(true);
    store.init('app_test'); row = store.getOwnedSession(row.sessionId)!;
    const claimed = claimDeploymentContinuation(row, deploymentContinuationCandidate(row)!, persist)!;
    expect(deploymentContinuationCandidate(row)).toBeUndefined();
    const input = deploymentContinuationTemplate(claimed, { appId: 'app_test', nativeSessionId: receipt.nativeSessionId, resumed: true, reattached: false })!;
    const note = restartInterruptionNote({ turnOpen: true, tasks: [] });
    expect(restartNoteInput(input, note)).toMatchObject({ content: note, turnId: 'om_task', trustedCaller: caller });
    expect(JSON.stringify(input)).not.toContain('ou_not_sender');
    store.init('app_test'); row = store.getOwnedSession(row.sessionId)!;
    expect(deploymentContinuationCandidate(row)).toBeUndefined();
    // The resumed native CLI confirms consumption; a later deployment can continue again.
    expect(arm()).toBe(true);
    expect(deploymentContinuationCandidate(row)?.state).toBe('running');
  });

  it('stop persists before its side effect and late native receipts cannot revive it', () => {
    arm();
    const stale = structuredClone(row);
    cancelDeploymentContinuation(row, persist, 'om_task');
    expect(arm()).toBe(false);
    stale.title = 'unrelated stale metadata'; store.updateSession(stale);
    store.init('app_test'); row = store.getOwnedSession(row.sessionId)!;
    expect(deploymentContinuationCandidate(row)).toBeUndefined();
    expect(row.deploymentContinuation?.state).toBe('cancelled');
  });

  it('failed cancellation never reaches the interrupt, and failed claims never dispatch', () => {
    arm();
    const effect = vi.fn();
    const diskFailure = () => { throw new Error('disk unavailable'); };
    expect(() => { cancelDeploymentContinuation(row, diskFailure); effect(); }).toThrow('disk unavailable');
    expect(() => { claimDeploymentContinuation(row, deploymentContinuationCandidate(row)!, diskFailure); effect(); }).toThrow('disk unavailable');
    expect(effect).not.toHaveBeenCalled();
    expect(deploymentContinuationCandidate(row)).toBeDefined();
  });

  it('new user input cancels the previous authority before native admission of the successor', () => {
    arm(); cancelDeploymentContinuation(row, persist);
    expect(arm()).toBe(false);
    expect(recordDeploymentContinuation(row, { ...receipt, turnId: 'om_new' }, { ...context, currentTurnId: 'om_new' }, persist)).toBe(true);
    cancelDeploymentContinuation(row, persist, 'om_task'); // delayed old terminal
    expect(deploymentContinuationCandidate(row)?.turnId).toBe('om_new');
  });

  it.each([
    { caller: undefined }, { caller: { ...caller, senderType: 'bot' as const } },
    { caller: { ...caller, requestLarkAppId: 'foreign' } }, { workerGeneration: 2 },
    { currentTurnId: 'om_new' }, { rpc: true },
  ])('rejects unproven admission %j', patch => {
    expect(recordDeploymentContinuation(row, receipt, { ...context, ...patch }, persist)).toBe(false);
  });

  it.each(['pty', 'remote-runner'])('does not take ownership of backend %s', backendType => {
    row.backendType = backendType as Session['backendType']; expect(arm()).toBe(false);
  });

  it('expires old work and never resumes another native conversation or a surviving process', () => {
    arm(); const claimed = claimDeploymentContinuation(row, deploymentContinuationCandidate(row)!, persist)!;
    for (const patch of [{ resumed: false }, { reattached: true }, { nativeSessionId: 'another' }, { appId: 'another' }]) {
      expect(deploymentContinuationTemplate(claimed, { appId: 'app_test', nativeSessionId: receipt.nativeSessionId, resumed: true, reattached: false, ...patch })).toBeUndefined();
    }
    arm(); vi.advanceTimersByTime(25 * 60 * 60_000);
    expect(deploymentContinuationCandidate(row)).toBeUndefined();
  });

  it('a stale authority writer cannot replace a newer stop', () => {
    arm(); const stale = structuredClone(row); const before = stale.deploymentContinuation;
    cancelDeploymentContinuation(row, persist);
    stale.deploymentContinuation = { ...before!, state: 'claimed' };
    expect(() => store.updateDeploymentContinuation(stale, before)).toThrow('authority changed');
  });
});

it('real worker stop removes a queued restart note while preserving a newer input', () => {
  const scope: any = { lastWrittenCliInput: { turnId: 'om_old' },
    lastInitConfig: { deploymentContinuation: { turnId: 'om_old' } },
    pendingRestartInterruption: { turnOpen: true, tasks: [] }, restartInterruptionScanBeforeMs: 1,
    pendingMessages: [{ turnId: 'om_old', content: 'continue' }, { turnId: 'om_new', content: 'new request' }],
    inflightInputs: { retireTurn: vi.fn() } };
  loadWorkerFunction<() => void>('discardDeploymentContinuation', scope)();
  expect(scope.pendingMessages).toEqual([{ turnId: 'om_new', content: 'new request' }]);
  expect(scope.pendingRestartInterruption).toBeUndefined();
  expect(scope.lastWrittenCliInput).toBeUndefined();
});

it.each([
  { type: 'raw_input', content: '/clear' },
  { type: 'inject_command', command: '/new' },
  { type: 'tui_text_input', keys: ['Enter'], text: 'manual reply' },
])('$type retires restored work before the first prompt can deliver its note', async message => {
  const newer = { turnId: 'om_new', content: 'new user intent' };
  const scope: any = {
    lastInitConfig: { deploymentContinuation: { turnId: 'om_old' } }, restoredDeploymentTurnId: 'om_old',
    lastWrittenCliInput: { turnId: 'om_old' }, pendingRestartInterruption: { turnOpen: true, tasks: [] },
    pendingMessages: [{ turnId: 'om_old', content: 'old note' }, newer], pendingInjections: [],
    inflightInputs: { retireTurn: vi.fn() }, restartInterruptionScanBeforeMs: 1,
    refreshHookReviewInputHold: vi.fn(), firstWriteLivenessConfirmed: false, cliRestartInProgress: true,
    freshnessInputQueue: { enqueueRaw: vi.fn() }, flushPending: vi.fn(), log: vi.fn(),
    flushPendingInjections: vi.fn(), handleTuiTextInput: vi.fn(async () => true),
    unattendedRawInputRefusal: () => undefined,
  };
  scope.discardDeploymentContinuation = loadWorkerFunction('discardDeploymentContinuation', scope);
  await loadWorkerMessageHandler(message.type, scope)(message);
  expect(scope.lastInitConfig.deploymentContinuation).toBeUndefined();
  expect(scope.lastWrittenCliInput).toBeUndefined();
  expect(scope.pendingRestartInterruption).toBeUndefined();
  expect(scope.pendingMessages).toEqual([newer]);
  expect(scope.inflightInputs.retireTurn).toHaveBeenCalledWith('om_old');
  // An ensuing prompt-ready edge cannot synthesize an old continuation.
  loadWorkerFunction<() => void>('deliverRestartInterruptionNote', scope)();
  expect(scope.pendingMessages).toEqual([newer]);
});

it('requires positive ordinary input evidence even when another owner receipt is unavailable', () => {
  expect(recordDeploymentContinuation(row, { ...receipt, ordinaryInteractive: undefined }, context, persist)).toBe(false);
  row.durablePrimaryInputCommits = [{ version: 1, turnId: 'om_task', workerGeneration: 1, committedAt: new Date().toISOString(), dispatchAttempt: 1 }];
  expect(arm()).toBe(false);
});

it('fresh fallback retires only the restored synthetic input', () => {
  arm(); const claimed = claimDeploymentContinuation(row, deploymentContinuationCandidate(row)!, persist)!;
  const cfg = { cliId: 'codex', larkAppId: 'app_test', deploymentContinuation: claimed };
  const scope: any = { lastInitConfig: cfg, lastSpawnEffectiveResume: true,
    lastSpawnEffectiveCliSessionId: receipt.nativeSessionId, deploymentContinuationTemplate,
    pendingMessages: [], inflightInputs: { retireTurn: vi.fn() } };
  scope.discardDeploymentContinuation = loadWorkerFunction('discardDeploymentContinuation', scope);
  const spawn = loadWorkerFunction<(config: unknown, reattached: boolean) => void>('prepareDeploymentContinuationForSpawn', scope);
  spawn(cfg, false);
  expect(scope.lastWrittenCliInput.trustedCaller).toMatchObject({ ...caller, source: 'failed_turn_recovery' });
  scope.pendingMessages.push({ turnId: 'om_task', content: 'continue' }, { turnId: 'om_new', content: 'new input' });
  scope.pendingRestartInterruption = { turnOpen: true, tasks: [] };
  scope.lastSpawnEffectiveResume = false; scope.lastSpawnEffectiveCliSessionId = 'fresh-native';
  spawn(cfg, false);
  expect(scope.lastWrittenCliInput).toBeUndefined();
  expect(scope.pendingRestartInterruption).toBeUndefined();
  expect(scope.pendingMessages).toEqual([{ turnId: 'om_new', content: 'new input' }]);
});

it('does not retire ordinary non-deployment input before an interrupt succeeds', () => {
  const item = { turnId: 'om_task', content: 'original' };
  const scope: any = { lastInitConfig: { cliId: 'codex' }, lastWrittenCliInput: item,
    pendingMessages: [item], inflightInputs: { retireTurn: vi.fn() } };
  loadWorkerFunction<() => void>('discardDeploymentContinuation', scope)();
  expect(scope.pendingMessages).toEqual([item]);
  expect(scope.lastWrittenCliInput).toBe(item);
  expect(scope.inflightInputs.retireTurn).not.toHaveBeenCalled();
});

it.each(['ok', 'failed', 'timeout'])('Web terminal waits for durable cancellation: %s', async outcome => {
  const writes = vi.fn(), send = vi.fn();
  const scope: any = { lastInitConfig: { cliId: 'codex', deploymentContinuation: { turnId: 'om_task' } },
    restoredDeploymentTurnId: 'om_task', effectiveBackendType: 'tmux',
    pendingMessages: [{ turnId: 'om_task', content: 'continue' }],
    inflightInputs: { retireTurn: vi.fn() }, deploymentCancellationReceipts: new Map(),
    randomBytes: () => ({ toString: () => 'request-fixture' }), send };
  scope.discardDeploymentContinuation = loadWorkerFunction('discardDeploymentContinuation', scope);
  const cancel = loadWorkerFunction<() => Promise<boolean>>('cancelDeploymentForTerminalInput', scope);
  const result = cancel().then(ok => { if (ok) writes(); });
  expect(writes).not.toHaveBeenCalled(); expect(scope.pendingMessages).toEqual([]);
  if (outcome === 'timeout') vi.advanceTimersByTime(5001);
  else scope.deploymentCancellationReceipts.get('request-fixture')(outcome === 'ok');
  await result;
  expect(writes).toHaveBeenCalledTimes(outcome === 'ok' ? 1 : 0);
  expect(scope.deploymentCancellationReceipts.size).toBe(0);
});

it('stop before the first native receipt survives restart and rejects that delayed receipt', () => {
  cancelDeploymentContinuation(row, persist, 'om_task', true);
  store.init('app_test'); row = store.getOwnedSession(row.sessionId)!;
  expect(arm()).toBe(false);
  // A new admitted turn has not yet produced its receipt when it too is stopped.
  cancelDeploymentContinuation(row, persist, 'om_next', true);
  expect(recordDeploymentContinuation(row, { ...receipt, turnId: 'om_next' }, { ...context, currentTurnId: 'om_next' }, persist)).toBe(false);
  // A delayed terminal from the previous turn cannot erase the newer stop.
  cancelDeploymentContinuation(row, persist, 'om_task');
  expect(row.deploymentContinuation).toEqual({ state: 'cancelled', turnId: 'om_next' });
});

it.each([['claude-code', 'pty'], ['codex', 'pty'], ['codex-app', 'tmux']] as const)(
  'unrecorded stop for %s/%s has no new persistence dependency', (cliId, backendType) => {
    row.cliId = cliId; row.backendType = backendType;
    const disk = vi.fn(() => { throw new Error('disk full'); });
    expect(() => cancelDeploymentContinuation(row, disk, 'om_task', true)).not.toThrow();
    expect(disk).not.toHaveBeenCalled();
  },
);
