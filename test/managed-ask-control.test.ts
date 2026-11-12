import { describe, expect, it } from 'vitest';
import { createManagedAskControl, managedAskDecisionStatus, managedAskOriginKey, parseManagedAskControl } from '../src/core/managed-ask-control.js';
import type { ExplicitAskReceipt } from '../src/core/explicit-ask-continuation.js';

describe('managed explicit Ask retirement control', () => {
  it('validates the complete bounded control body without accepting a malformed dispatch attempt', () => {
    const request = { larkAppId: 'app', sessionId: 'session', requestId: 'request', chatId: 'chat',
      rootMessageId: 'root', origin: { turnId: 'turn', workerGeneration: 3, dispatchAttempt: 2 },
      operationId: 'operation', reason: 'ended' };
    expect(parseManagedAskControl(request, 'retire')).toEqual(request);
    for (const dispatchAttempt of [-1, 1.5, '2', null]) {
      expect(() => parseManagedAskControl({ ...request, origin: { ...request.origin, dispatchAttempt } }, 'retire')).toThrow();
    }
    expect(() => parseManagedAskControl({ ...request, extra: true }, 'retire')).toThrow();
    expect(() => parseManagedAskControl({ ...request, reason: 'x'.repeat(20000) }, 'retire')).toThrow();
    expect(() => parseManagedAskControl(null, 'retire')).toThrow();
  });
  it('retains draining state until the same generation is safe to release', async () => {
    const request = { larkAppId: 'app', sessionId: 'session', requestId: 'request', chatId: 'chat',
      rootMessageId: 'root', origin: { turnId: 'turn', workerGeneration: 3 }, operationId: 'operation', reason: 'business ended' };
    let retired = false;
    let safe = false;
    let alive = true;
    let generation = 3;
    let terminal = false;
    const receipt = (): ExplicitAskReceipt => ({
      version: 1, input: { ...request, timeoutMs: 0, originKind: 'host_explicit',
        questions: [{ prompt: 'original decision', options: [{ key: 'fix', label: 'fix' }, { key: 'waive', label: 'waive' }], multiSelect: false }] },
      origin: request.origin,
      ...(retired ? { retirement: { operationId: 'operation', reason: 'business ended', requestedAt: 1 },
        result: { kind: 'invalidated', reason: 'business ended', timedOut: false, selected: null, by: null, comment: null } } : {}),
    });
    const controller = createManagedAskControl({
      appId: 'app',
      inspect: receipt,
      retire: () => { retired = true; return receipt(); },
      snapshot: () => undefined,
      session: () => ({ larkAppId: 'app', chatId: 'chat', rootMessageId: 'root', workerGeneration: generation,
        workerAlive: alive, turnId: 'turn', safeToSuspend: safe, resourceOwned: true,
        suspensionConfirmed: !alive, terminalExecutionKeys: terminal ? [managedAskOriginKey(request.origin)] : [] }),
      suspend: async () => { alive = false; return true; },
    });
    await expect(controller.retire(request)).resolves.toMatchObject({ status: 'draining', questions: receipt().input.questions });
    expect(retired).toBe(true);
    generation = 4;
    await expect(controller.release(request)).resolves.toMatchObject({ status: 'conflict' });
    expect(alive).toBe(true);
    generation = 3;
    safe = true;
    await expect(controller.release(request)).resolves.toMatchObject({ status: 'draining' });
    expect(alive).toBe(true);
    terminal = true;
    await expect(controller.release(request)).resolves.toMatchObject({ status: 'suspended' });
    await expect(controller.release(request)).resolves.toMatchObject({ status: 'suspended' });
  });

  it('revalidates the original turn and ownership at the asynchronous teardown boundary', async () => {
    const request = { larkAppId: 'app', sessionId: 'session', requestId: 'request', chatId: 'chat',
      rootMessageId: 'root', origin: { turnId: 'turn', workerGeneration: 3 }, operationId: 'operation', reason: 'ended' };
    const receipt: ExplicitAskReceipt = { version: 1,
      input: { ...request, timeoutMs: 0, originKind: 'host_explicit', questions: [] }, origin: request.origin,
      retirement: { operationId: 'operation', reason: 'ended', requestedAt: 1 },
      result: { kind: 'invalidated', reason: 'ended', selected: null, by: null, comment: null, timedOut: false } };
    let generation = 3;
    let alive = true;
    const controller = createManagedAskControl({
      appId: 'app', inspect: () => receipt, retire: () => receipt, snapshot: () => undefined,
      session: () => ({ larkAppId: 'app', chatId: 'chat', rootMessageId: 'root', workerGeneration: generation,
        workerAlive: alive, turnId: 'turn', safeToSuspend: true, resourceOwned: true, terminalExecutionKeys: [managedAskOriginKey(request.origin)] }),
      suspend: async (_sessionId, stillOwned) => {
        await Promise.resolve();
        generation = 4;
        if (stillOwned && !stillOwned()) return false;
        alive = false;
        return true;
      },
    });
    await expect(controller.release(request)).resolves.toMatchObject({ status: 'unknown' });
    expect(alive).toBe(true);
  });

  it('retires the exact origin but refuses release when the current attempt changed within the same generation', async () => {
    const request = { larkAppId: 'app', sessionId: 'session', requestId: 'request', chatId: 'chat',
      rootMessageId: 'root', origin: { turnId: 'turn', workerGeneration: 3, dispatchAttempt: 1 },
      operationId: 'operation', reason: 'ended' };
    let writes = 0;
    let suspends = 0;
    let receipt: ExplicitAskReceipt = { version: 1, input: { ...request, timeoutMs: 0, questions: [] }, origin: request.origin };
    const controller = createManagedAskControl({
      appId: 'app', inspect: () => receipt, snapshot: () => undefined,
      retire: () => {
        writes++;
        receipt = { ...receipt, retirement: { operationId: 'operation', reason: 'ended', requestedAt: 1 },
          result: { kind: 'invalidated', reason: 'ended', selected: null, by: null, comment: null, timedOut: false } };
        return receipt;
      },
      session: () => ({ larkAppId: 'app', chatId: 'chat', rootMessageId: 'root', workerGeneration: 3,
        turnId: 'turn', dispatchAttempt: 2, workerAlive: true, resourceOwned: true, safeToSuspend: true,
        terminalExecutionKeys: [managedAskOriginKey(request.origin)] }),
      suspend: async () => { suspends++; return true; },
    });
    await expect(controller.retire(request)).resolves.toMatchObject({ status: 'draining', operationId: 'operation' });
    expect(writes).toBe(1);
    await expect(controller.release(request)).resolves.toMatchObject({ status: 'conflict' });
    expect(suspends).toBe(0);
  });

  it.each([
    ['a daemon restart replaced the worker generation', { workerGeneration: 4, workerAlive: true, resourceOwned: true }],
    ['the restored session has no worker yet', { workerGeneration: undefined, workerAlive: false, resourceOwned: true }],
    ['a Dashboard lock or adoption withdrew resource ownership', { workerGeneration: 3, workerAlive: true, resourceOwned: false }],
  ])('still retires the decision but never releases after %s', async (_case, view) => {
    const request = { larkAppId: 'app', sessionId: 'session', requestId: 'request', chatId: 'chat',
      rootMessageId: 'root', origin: { turnId: 'turn', workerGeneration: 3 }, operationId: 'operation', reason: 'MR closed' };
    let receipt: ExplicitAskReceipt = { version: 1, input: { ...request, timeoutMs: 0, originKind: 'host_explicit', questions: [] },
      origin: request.origin };
    let suspends = 0;
    const controller = createManagedAskControl({
      appId: 'app', inspect: () => receipt, snapshot: () => undefined,
      retire: () => {
        receipt = { ...receipt, retirement: { operationId: 'operation', reason: 'MR closed', requestedAt: 1 },
          result: { kind: 'invalidated', reason: 'MR closed', selected: null, by: null, comment: null, timedOut: false } };
        return receipt;
      },
      // Restored sessions carry no managed turn origin and an empty in-memory terminal table.
      session: () => ({ larkAppId: 'app', chatId: 'chat', rootMessageId: 'root', ...view,
        safeToSuspend: true, terminalExecutionKeys: [] }),
      suspend: async () => { suspends++; return true; },
    });
    await expect(controller.retire(request)).resolves.toMatchObject({ status: 'draining', operationId: 'operation' });
    expect(controller.inspect(request)).toMatchObject({ status: 'retired' });
    await expect(controller.release(request)).resolves.toMatchObject({ status: 'conflict' });
    expect(suspends).toBe(0);
  });

  it('reports retiring, never retired, while only the retirement intent is durable', () => {
    const base: ExplicitAskReceipt = { version: 1, input: { larkAppId: 'app', sessionId: 's', requestId: 'r', chatId: 'c',
      rootMessageId: null, timeoutMs: 0, questions: [] }, origin: { turnId: 't', workerGeneration: 1 } };
    const retirement = { operationId: 'op', reason: 'ended', requestedAt: 1 };
    const invalidated = { kind: 'invalidated', reason: 'ended', selected: null, by: null, comment: null, timedOut: false } as const;
    expect(managedAskDecisionStatus(base)).toBe('waiting');
    expect(managedAskDecisionStatus({ ...base, retirement })).toBe('retiring');
    expect(managedAskDecisionStatus({ ...base, retirement, result: invalidated })).toBe('retired');
    expect(managedAskDecisionStatus({ ...base, result: invalidated })).toBe('invalidated');
    expect(managedAskDecisionStatus({ ...base, retirement, result: { kind: 'answered', answers: [['y']], by: 'h', comment: null, timedOut: false } })).toBe('answered');
  });

  it('rejects foreign bindings and never retires or releases an answered Ask', async () => {
    let writes = 0;
    const request = { larkAppId: 'app', sessionId: 'session', requestId: 'request', chatId: 'chat',
      rootMessageId: null, origin: { turnId: 'turn', workerGeneration: 2 }, operationId: 'operation', reason: 'business ended' };
    const receipt: ExplicitAskReceipt = { version: 1,
      input: { ...request, timeoutMs: 0, originKind: 'host_explicit', questions: [] }, origin: request.origin,
      result: { kind: 'answered', answers: [['fix']], by: 'human', comment: null, timedOut: false } };
    const controller = createManagedAskControl({
      appId: 'app', inspect: () => receipt, retire: () => { writes++; return receipt; }, snapshot: () => undefined,
      session: () => ({ larkAppId: 'app', chatId: 'chat', rootMessageId: null, workerGeneration: 2,
        workerAlive: true, turnId: 'turn', safeToSuspend: true, resourceOwned: true }),
      suspend: async () => { writes++; return true; },
    });
    await expect(controller.retire({ ...request, larkAppId: 'foreign' })).rejects.toThrow('binding');
    await expect(controller.retire(request)).resolves.toMatchObject({ status: 'answered' });
    expect(writes).toBe(0);
  });
});
