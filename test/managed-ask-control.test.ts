import { describe, expect, it } from 'vitest';
import { createManagedAskControl, parseManagedAskControl } from '../src/core/managed-ask-control.js';
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
        suspensionConfirmed: !alive, terminatedTurnIds: terminal ? ['turn'] : [] }),
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
        workerAlive: alive, turnId: 'turn', safeToSuspend: true, resourceOwned: true, terminatedTurnIds: ['turn'] }),
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
