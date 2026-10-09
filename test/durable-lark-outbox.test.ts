import { describe, expect, it, vi } from 'vitest';
import type { DurableOutboxRecord, OutboxAttempt } from '../src/services/durable-coordination.js';
import {
  deliverDurableLarkOutbox,
  durableLarkOutboxMessage,
  LARK_OUTBOX_IDEMPOTENCY_TTL_MS,
  parseDurableLarkOutboxRecord,
} from '../src/services/durable-lark-outbox.js';
import { MessageWithdrawnError } from '../src/im/lark/client.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function row(overrides: Partial<Parameters<typeof durableLarkOutboxMessage>[0]> = {}): DurableOutboxRecord {
  const message = durableLarkOutboxMessage({
    messageId: 'outbox-1',
    sessionKey: 'om_root::cli_test',
    larkAppId: 'cli_test',
    target: { kind: 'send', chatId: 'oc_chat' },
    content: 'hello',
    msgType: 'text',
    providerUuid: 'bts_0123456789abcdef0123456789abcdef',
    hookContext: { sessionId: 'session-1' },
    createdAt: 1_000,
    visibleAt: 1_000,
    ...overrides,
  });
  return {
    ...message,
    state: 'attempting',
    originEpoch: 1,
    attempts: 1,
    updatedAt: 1_000,
  };
}

function context(record: DurableOutboxRecord, attempt = 1, signal = new AbortController().signal) {
  const outboxAttempt: OutboxAttempt = {
    record: { ...record, state: 'attempting', attempts: attempt },
    workerId: 'outbox-worker',
    claimEpoch: 1,
    claimUntil: 60_000,
    attempt,
  };
  return { attempt: outboxAttempt, signal };
}

function deps() {
  return {
    sendMessage: vi.fn(async () => 'om_sent'),
    replyMessage: vi.fn(async () => 'om_replied'),
    updateMessage: vi.fn(async () => true),
  };
}

describe('durable Lark outbox adapter', () => {
  it('builds and revalidates a frozen provider identity', () => {
    const record = row({
      target: { kind: 'reply', messageId: 'om_parent', replyInThread: true },
    });
    expect(parseDurableLarkOutboxRecord(record)).toEqual({
      version: 1,
      type: 'botmux.lark.outbound',
      messageId: 'outbox-1',
      larkAppId: 'cli_test',
      target: { kind: 'reply', messageId: 'om_parent', replyInThread: true },
      content: 'hello',
      msgType: 'text',
      providerUuid: 'bts_0123456789abcdef0123456789abcdef',
      hookContext: { sessionId: 'session-1' },
    });

    expect(() => row({ providerUuid: 'x'.repeat(51) })).toThrow(/1\.\.50/);
    expect(() => parseDurableLarkOutboxRecord({ ...record, messageId: 'outbox-other' }))
      .toThrow(/identity/);
  });

  it('sends with the stable UUID and a revalidated first-attempt hook fence', async () => {
    const record = row();
    const transport = deps();
    const beforeEffect = vi.fn();
    const beforeHook = vi.fn();
    const hookOrigin = {
      ipcPort: 9999,
      sessionId: 'session-1',
      capability: 'frozen-capability',
      turnId: 'turn-1',
      dispatchAttempt: 1,
    };
    const result = await deliverDurableLarkOutbox(
      record,
      context(record),
      transport,
      {
        now: () => 2_000,
        beforeEffect,
        hookAuthority: async () => ({ beforeHook, hookOrigin }),
      },
    );

    expect(result).toEqual({
      kind: 'delivered',
      receipt: {
        provider: 'lark',
        providerMessageId: 'om_sent',
        providerUuid: 'bts_0123456789abcdef0123456789abcdef',
        operation: 'send',
        targetId: 'oc_chat',
      },
    });
    expect(beforeEffect).toHaveBeenCalledOnce();
    expect(transport.sendMessage).toHaveBeenCalledWith(
      'cli_test',
      'oc_chat',
      'hello',
      'text',
      'bts_0123456789abcdef0123456789abcdef',
      { sessionId: 'session-1' },
      { beforeHook, hookOrigin },
    );
    expect(transport.replyMessage).not.toHaveBeenCalled();
  });

  it('replies to the frozen parent and suppresses hooks during UUID reconciliation', async () => {
    const record = row({
      target: { kind: 'reply', messageId: 'om_parent', replyInThread: true },
    });
    const transport = deps();
    const hookAuthority = vi.fn();
    const result = await deliverDurableLarkOutbox(
      record,
      context(record, 2),
      transport,
      { now: () => 2_000, hookAuthority },
    );

    expect(result.kind).toBe('delivered');
    expect(hookAuthority).not.toHaveBeenCalled();
    expect(transport.replyMessage).toHaveBeenCalledWith(
      'cli_test',
      'om_parent',
      'hello',
      'text',
      true,
      'bts_0123456789abcdef0123456789abcdef',
      { sessionId: 'session-1' },
      { suppressHook: true },
    );
    expect(transport.sendMessage).not.toHaveBeenCalled();
  });

  it('updates one stable card target idempotently through the durable outbox', async () => {
    const record = row({ target: { kind: 'update', messageId: 'om_card' }, msgType: 'interactive' });
    const transport = deps();
    const result = await deliverDurableLarkOutbox(
      record,
      context(record),
      transport,
      { now: () => 2_000 },
    );

    expect(result).toEqual({
      kind: 'delivered',
      receipt: {
        provider: 'lark',
        providerMessageId: 'om_card',
        providerUuid: 'bts_0123456789abcdef0123456789abcdef',
        operation: 'update',
        targetId: 'om_card',
      },
    });
    expect(transport.updateMessage).toHaveBeenCalledWith('cli_test', 'om_card', 'hello');
    expect(transport.sendMessage).not.toHaveBeenCalled();
    expect(transport.replyMessage).not.toHaveBeenCalled();
  });

  it('uses the provider UUID window for bounded safe retry', async () => {
    const record = row();
    const transport = deps();
    const error = Object.assign(new Error('gateway unavailable'), { status: 503 });
    transport.sendMessage.mockRejectedValue(error);
    const result = await deliverDurableLarkOutbox(
      record,
      context(record),
      transport,
      { now: () => 2_000, retryDelaysMs: [5_000] },
    );

    expect(result).toEqual({
      kind: 'retry',
      visibleAt: 7_000,
      error: 'gateway unavailable',
      proof: 'stable_target_idempotency',
    });
  });

  it('stops retrying before the provider UUID window expires', async () => {
    const record = row();
    const transport = deps();
    transport.sendMessage.mockRejectedValue(Object.assign(new Error('timeout'), { status: 503 }));
    const result = await deliverDurableLarkOutbox(
      record,
      context(record, 3),
      transport,
      {
        now: () => record.createdAt + LARK_OUTBOX_IDEMPOTENCY_TTL_MS - 30_000,
        retryDelaysMs: [1_000],
      },
    );

    expect(result).toMatchObject({ kind: 'ambiguous' });
    if (result.kind === 'ambiguous') expect(result.error).toContain('dedupe window is exhausted');
  });

  it('never retargets a withdrawn reply under the same UUID', async () => {
    const record = row({
      target: { kind: 'reply', messageId: 'om_parent', replyInThread: true },
    });
    const transport = deps();
    transport.replyMessage.mockRejectedValue(new MessageWithdrawnError('om_parent'));
    const result = await deliverDurableLarkOutbox(
      record,
      context(record),
      transport,
      { now: () => 2_000 },
    );

    expect(result).toMatchObject({ kind: 'ambiguous' });
    expect(transport.sendMessage).not.toHaveBeenCalled();
  });

  it('retries safely when authority fails before the provider call', async () => {
    const record = row();
    const transport = deps();
    const result = await deliverDurableLarkOutbox(
      record,
      context(record),
      transport,
      {
        now: () => 2_000,
        retryDelaysMs: [500],
        beforeEffect: async () => { throw new Error('stale Session epoch'); },
      },
    );

    expect(result).toMatchObject({
      kind: 'retry',
      visibleAt: 2_500,
      proof: 'no_side_effect',
    });
    expect(transport.sendMessage).not.toHaveBeenCalled();
  });

  it('retries an already-aborted attempt without invoking the provider', async () => {
    const record = row();
    const transport = deps();
    const controller = new AbortController();
    controller.abort();
    const result = await deliverDurableLarkOutbox(
      record,
      context(record, 1, controller.signal),
      transport,
      { now: () => 2_000, retryDelaysMs: [500] },
    );

    expect(result).toMatchObject({ kind: 'retry', proof: 'no_side_effect' });
    expect(transport.sendMessage).not.toHaveBeenCalled();
  });

  it('rechecks abort after an awaited authority fence', async () => {
    const record = row();
    const transport = deps();
    const controller = new AbortController();
    const authorityStarted = deferred<void>();
    const authorityRelease = deferred<void>();
    const delivery = deliverDurableLarkOutbox(
      record,
      context(record, 1, controller.signal),
      transport,
      {
        now: () => 2_000,
        retryDelaysMs: [500],
        beforeEffect: async () => {
          authorityStarted.resolve();
          await authorityRelease.promise;
        },
      },
    );
    await authorityStarted.promise;
    controller.abort();
    authorityRelease.resolve();

    await expect(delivery).resolves.toMatchObject({ kind: 'retry', proof: 'no_side_effect' });
    expect(transport.sendMessage).not.toHaveBeenCalled();
  });

  it('contains corrupt durable payloads as ambiguous', async () => {
    const record = row();
    const transport = deps();
    const result = await deliverDurableLarkOutbox(
      { ...record, payload: { version: 2 } },
      context(record),
      transport,
    );

    expect(result).toMatchObject({ kind: 'ambiguous' });
    expect(transport.sendMessage).not.toHaveBeenCalled();
    expect(transport.replyMessage).not.toHaveBeenCalled();
    expect(transport.updateMessage).not.toHaveBeenCalled();
  });
});
