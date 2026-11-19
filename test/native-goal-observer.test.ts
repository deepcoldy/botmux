import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { WorkerSessionEventScope } from '../src/services/session-event-scope.js';
import { SessionEventGateway } from '../src/core/session-event-gateway.js';
import { loadWorkerFunction, loadWorkerMessageHandler } from './helpers/worker-function-harness.js';
import { admitSessionCommand } from '../src/services/session-command-gateway.js';

it('accepts goal acknowledgements as receipts without executor privileges', () => {
  expect(admitSessionCommand('goal_update_ack', undefined)).toEqual({ allowed: true });
});

describe('native goal observer runtime scope', () => {
  it('publishes the current physical runtime from an old timer context and retries until ACK', async () => {
    const ref = { appId: 'app', sessionId: 'session' };
    const worker = { workerId: 'worker', generation: 1 };
    const eventScope = new WorkerSessionEventScope(ref, worker);
    const a = eventScope.beginRuntime(undefined, 'physicalA');
    eventScope.assign(a.bindingId, { runtimeId: 'runtimeA', epoch: 1 });
    const events: any[] = [];
    let now = 10_000;
    const scope: any = { createHash, workerSessionEventScope: eventScope, nativeGoalGeneration: 2, cliSpawnGeneration: 2,
      nativeGoalPhysicalId: 'physicalB', nativeGoalPendingSignature: undefined, nativeGoalOrigin: undefined,
      nativeGoalSourcePath: 'sourceB', nativeGoalReadAt: 0, nativeGoalSignature: undefined,
      backend: {}, cliRestartInProgress: false, Date: { now: () => now }, structuredBridgeIs: () => true,
      traexSessionIdFromRolloutPath: (path: string) => path, codexGenerationSessionIdFromRolloutPath: (path: string) => path,
      readNativeGoalForRollout: () => ({ goalId: 'g1', objective: 'goal', status: 'complete', createdAt: 100, updatedAt: 103, timeUsedSeconds: 9 }),
      currentBotmuxTurnId: undefined, currentBotmuxDispatchAttempt: undefined, lastInitConfig: { goalStatusCard: true } };
    scope.nativeGoalCardEnabled = loadWorkerFunction('nativeGoalCardEnabled', scope);
    scope.publishNativeGoal = loadWorkerFunction('publishNativeGoal', scope);
    scope.sessionEventMetadata = loadWorkerFunction('sessionEventMetadata', scope);
    scope.send = (message: any) => events.push(scope.sessionEventMetadata(message));
    const observe = loadWorkerFunction('observeNativeGoal', scope);
    let tick!: () => void;
    eventScope.run(a, () => { tick = eventScope.bind(observe); });
    const b = eventScope.beginRuntime(undefined, 'physicalB');
    const runtimeB = { runtimeId: 'runtimeB', epoch: 2 };
    eventScope.assign(b.bindingId, runtimeB);
    now += 3000; tick();
    const gateway = new SessionEventGateway({ read: () => ({ worker, activeRuntime: runtimeB, lifecycle: 'active' }),
      authorizedProducer: () => true, authorizedExecutionObserver: () => false, continuedExecution: () => false } as any, ref);
    expect(gateway.admit('goal_update', events[0].sessionContract, worker).kind).toBe('current');
    expect(events[0].sessionContract.scope.runtime).toEqual(runtimeB);
    now += 3000; tick(); expect(events).toHaveLength(2);
    await loadWorkerMessageHandler('goal_update_ack', scope)({ type: 'goal_update_ack', signature: events.at(-1).signature });
    now += 3000; tick(); expect(events).toHaveLength(2);
  });
  it('does not read a previous physical generation after replacement', () => {
    const read = vi.fn();
    const scope: any = { structuredBridgeIs: () => true, nativeGoalGeneration: 1, cliSpawnGeneration: 2,
      nativeGoalSourcePath: 'old', nativeGoalTimer: undefined, readNativeGoalForRollout: read, lastInitConfig: { goalStatusCard: true } };
    scope.nativeGoalCardEnabled = loadWorkerFunction('nativeGoalCardEnabled', scope);
    loadWorkerFunction('observeNativeGoal', scope)();
    expect(read).not.toHaveBeenCalled(); expect(scope.nativeGoalSourcePath).toBeUndefined();
  });
  it('does not poll the native goal store when the bot switch was off at worker start', () => {
    const read = vi.fn(() => null);
    const timer = setInterval(() => {}, 60_000);
    const scope: any = { structuredBridgeIs: () => true, nativeGoalGeneration: 2, cliSpawnGeneration: 2,
      nativeGoalSourcePath: 'current', nativeGoalTimer: timer, nativeGoalReadAt: 0, backend: {}, cliRestartInProgress: false,
      Date: { now: () => 10_000 }, traexSessionIdFromRolloutPath: (path: string) => path, codexGenerationSessionIdFromRolloutPath: (path: string) => path,
      readNativeGoalForRollout: read, publishNativeGoal: vi.fn(), lastInitConfig: { cliId: 'codex' } };
    scope.nativeGoalCardEnabled = loadWorkerFunction('nativeGoalCardEnabled', scope);
    loadWorkerFunction('observeNativeGoal', scope)();
    expect(read).not.toHaveBeenCalled();
    expect(scope.nativeGoalTimer).toBeUndefined(); expect(scope.nativeGoalSourcePath).toBeUndefined();
    scope.lastInitConfig = { cliId: 'codex', goalStatusCard: true };
    scope.nativeGoalSourcePath = 'current';
    loadWorkerFunction('observeNativeGoal', scope)();
    expect(read).toHaveBeenCalledOnce();
    clearInterval(timer);
  });
});
