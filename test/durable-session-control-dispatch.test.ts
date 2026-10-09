import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InboxClaim } from '../src/services/durable-coordination.js';
import { SqliteDurableCoordinationStore } from '../src/services/sqlite-durable-coordination.js';
import {
  durableLarkSessionControlEvent,
  durableLarkSessionControlEventId,
  durableLarkSessionControlPartition,
  parseDurableLarkSessionControlClaim,
} from '../src/services/durable-lark-session-control.js';
import { createDurableSessionControlDispatch } from '../src/services/durable-session-control-dispatch.js';

const tempDirs: string[] = [];

function makeStore(now: () => number): SqliteDurableCoordinationStore {
  const dir = mkdtempSync(join(tmpdir(), 'botmux-control-dispatch-'));
  tempDirs.push(dir);
  return new SqliteDurableCoordinationStore(join(dir, 'coordination.db'), { now });
}

function controlInput() {
  const event = durableLarkSessionControlEvent({
    larkAppId: 'cli_test',
    eventId: durableLarkSessionControlEventId('cli_test', 'evt_control'),
    partitionKey: durableLarkSessionControlPartition('cli_test', 'session-1'),
    data: {
      event_id: 'evt_control',
      action: { value: { action: 'close', session_id: 'session-1', root_id: 'om_root' } },
      operator: { open_id: 'ou_operator' },
      context: { open_message_id: 'om_card' },
    },
    now: 1,
  });
  const claim: InboxClaim = {
    event,
    workerId: 'control-worker',
    claimEpoch: 1,
    claimUntil: 100,
    attempts: 1,
  };
  return {
    control: parseDurableLarkSessionControlClaim(claim),
    context: { claim, signal: new AbortController().signal },
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('durable session control dispatch', () => {
  it('retries only canonical commit after a completed effect', async () => {
    let now = 10;
    const store = makeStore(() => now);
    const execute = vi.fn(async () => ({
      kind: 'completed' as const,
      result: { status: 'closed' },
    }));
    const commit = vi.fn()
      .mockRejectedValueOnce(new Error('canonical write unavailable'))
      .mockResolvedValueOnce(undefined);
    const dispatch = createDurableSessionControlDispatch({
      store,
      sessionOwnerId: 'session-owner',
      resolve: async () => ({
        kind: 'target',
        target: {
          sessionKey: 'om_root::cli_test',
          operationPayload: { action: 'close', sessionId: 'session-1' },
          execute,
          reconcile: async () => ({ kind: 'unknown', error: 'not expected' }),
          commit,
        },
      }),
    });
    const input = controlInput();

    await expect(dispatch(input.control, input.context)).rejects.toThrow('canonical write unavailable');
    expect(execute).toHaveBeenCalledOnce();
    expect(await store.readControlOperation(input.control.operationId)).toMatchObject({
      state: 'completed', result: { status: 'closed' }, attempts: 1,
    });
    now = 11;
    await expect(dispatch(input.control, input.context)).resolves.toEqual({ kind: 'settled' });
    expect(execute).toHaveBeenCalledOnce();
    expect(commit).toHaveBeenCalledTimes(2);
    await store.close();
  });

  it('keeps result-unknown work closed until reconciliation proves completion', async () => {
    let now = 10;
    const store = makeStore(() => now);
    const execute = vi.fn(async () => ({
      kind: 'ambiguous' as const,
      error: 'provider response lost',
    }));
    const reconcile = vi.fn(async () => ({
      kind: 'completed' as const,
      result: { status: 'resumed', generation: 2 },
      evidence: { source: 'backend', generation: 2 },
    }));
    const commit = vi.fn(async () => undefined);
    const dispatch = createDurableSessionControlDispatch({
      store,
      sessionOwnerId: 'session-owner',
      resolve: async () => ({
        kind: 'target',
        target: {
          sessionKey: 'om_root::cli_test',
          operationPayload: { action: 'resume', sessionId: 'session-1' },
          execute,
          reconcile,
          commit,
        },
      }),
    });
    const input = controlInput();

    await expect(dispatch(input.control, input.context)).rejects.toThrow('provider response lost');
    expect(await store.readControlOperation(input.control.operationId)).toMatchObject({ state: 'ambiguous' });
    now = 11;
    await expect(dispatch(input.control, input.context)).resolves.toEqual({ kind: 'settled' });
    expect(execute).toHaveBeenCalledOnce();
    expect(reconcile).toHaveBeenCalledOnce();
    expect(commit).toHaveBeenCalledWith(
      { status: 'resumed', generation: 2 },
      input.context.signal,
    );
    await store.close();
  });

  it('reopens only after terminal not-applied evidence and starts a new attempt', async () => {
    let now = 10;
    const store = makeStore(() => now);
    const execute = vi.fn()
      .mockResolvedValueOnce({ kind: 'not_applied', error: 'rejected before dispatch' })
      .mockResolvedValueOnce({ kind: 'completed', result: { status: 'closed' } });
    const commit = vi.fn(async () => undefined);
    const dispatch = createDurableSessionControlDispatch({
      store,
      sessionOwnerId: 'session-owner',
      resolve: async () => ({
        kind: 'target',
        target: {
          sessionKey: 'om_root::cli_test',
          operationPayload: { action: 'close', sessionId: 'session-1' },
          execute,
          reconcile: async () => ({ kind: 'unknown', error: 'not expected' }),
          commit,
        },
      }),
    });
    const input = controlInput();

    await expect(dispatch(input.control, input.context)).rejects.toThrow('rejected before dispatch');
    expect(await store.readControlOperation(input.control.operationId)).toMatchObject({
      state: 'pending', attempts: 1,
    });
    now = 11;
    await expect(dispatch(input.control, input.context)).resolves.toEqual({ kind: 'settled' });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(await store.readControlOperation(input.control.operationId)).toMatchObject({
      state: 'completed', attempts: 2,
    });
    await store.close();
  });
});
