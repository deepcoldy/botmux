import { describe, expect, it } from 'vitest';
import type { DurableLarkMessageClaim } from '../src/services/durable-inbox-shadow.js';
import {
  durableLarkAdmissionReceipt,
  parseDurableLarkAdmissionReceipt,
} from '../src/services/durable-lark-admission.js';

function message(overrides: Partial<DurableLarkMessageClaim> = {}): DurableLarkMessageClaim {
  return {
    eventType: 'lark.im.message.receive_v1',
    eventId: 'im.message.receive_v1:cli_test:om_message',
    partitionKey: 'lark-message-routing:cli_test:oc_chat',
    larkAppId: 'cli_test',
    messageId: 'om_message',
    attempts: 1,
    data: { message: { message_id: 'om_message' } },
    ...overrides,
  };
}

function receipt(overrides: {
  message?: DurableLarkMessageClaim;
  leaseSessionKey?: string;
  recordSessionKey?: string;
  epoch?: number;
  revision?: number;
  updatedAt?: number;
} = {}) {
  const sessionKey = overrides.leaseSessionKey ?? 'om_root::cli_test';
  return durableLarkAdmissionReceipt({
    message: overrides.message ?? message(),
    lease: {
      sessionKey,
      ownerId: 'session-owner-boot',
      epoch: overrides.epoch ?? 7,
      leaseUntil: 60_000,
    },
    record: {
      sessionKey: overrides.recordSessionKey ?? sessionKey,
      revision: overrides.revision ?? 11,
      value: { status: 'active' },
      updatedAt: overrides.updatedAt ?? 12_345,
    },
  });
}

describe('durable Lark admission receipt', () => {
  it('binds an inbox event to the fenced Session mutation result', () => {
    expect(receipt()).toEqual({
      version: 1,
      type: 'botmux.lark.durable-admission',
      eventId: 'im.message.receive_v1:cli_test:om_message',
      partitionKey: 'lark-message-routing:cli_test:oc_chat',
      larkAppId: 'cli_test',
      sessionKey: 'om_root::cli_test',
      sessionEpoch: 7,
      sessionRevision: 11,
      sessionUpdatedAt: 12_345,
    });
  });

  it('revalidates a serialized receipt against the exact claimed inbox identity', () => {
    const value = JSON.parse(JSON.stringify(receipt()));
    expect(parseDurableLarkAdmissionReceipt(value, message())).toEqual(value);

    expect(() => parseDurableLarkAdmissionReceipt(
      { ...value, eventId: 'im.message.receive_v1:cli_test:om_other' },
      message(),
    )).toThrow(/mismatched inbox identity/);
    expect(() => parseDurableLarkAdmissionReceipt(
      { ...value, partitionKey: 'lark-message-routing:cli_test:oc_other' },
      message(),
    )).toThrow(/mismatched inbox identity/);
    expect(() => parseDurableLarkAdmissionReceipt(
      { ...value, larkAppId: 'cli_other' },
      message(),
    )).toThrow(/mismatched inbox identity/);
  });

  it('rejects receipts without a real positive Session epoch and revision', () => {
    expect(() => receipt({ epoch: 0 })).toThrow(/sessionEpoch/);
    expect(() => receipt({ revision: 0 })).toThrow(/sessionRevision/);
    expect(() => receipt({ updatedAt: -1 })).toThrow(/sessionUpdatedAt/);
    expect(() => receipt({ recordSessionKey: 'another-session' })).toThrow(/do not match/);
    expect(() => parseDurableLarkAdmissionReceipt({ kind: 'queued' }, message()))
      .toThrow(/invalid receipt envelope/);
  });
});
