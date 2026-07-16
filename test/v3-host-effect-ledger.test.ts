import { describe, expect, it } from 'vitest';

import { openV3HostEffects } from '../src/workflows/v3/host-effect-ledger.js';
import type { StoredEvent } from '../src/workflows/v3/journal.js';

const intent = (overrides: Partial<StoredEvent> = {}): StoredEvent => ({
  ts: 10,
  type: 'hostEffectIntent',
  nodeId: 'send',
  instanceId: 'send#001',
  attemptId: 'send#001/attempts/001',
  executor: 'feishu-send',
  provider: 'feishu-im',
  inputRef: { path: 'send#001/attempts/001/host-input.json', sha256: 'a'.repeat(64), bytes: 10 },
  inputHash: `sha256:${'b'.repeat(64)}`,
  idempotencyKey: 'wf3_key',
  idempotencyTtlMs: 3_600_000,
  approvalDigest: `sha256:${'c'.repeat(64)}`,
  ...overrides,
} as StoredEvent);

describe('v3 host effect ledger', () => {
  it('opens only at durable intent, not preparation or gate', () => {
    const prepared = { ...intent(), type: 'hostInputPrepared' } as StoredEvent;
    expect(openV3HostEffects([prepared])).toEqual([]);
    expect(openV3HostEffects([prepared, intent()])).toHaveLength(1);
  });

  it('closes on the matching ordinary node verdict', () => {
    const opened = intent();
    expect(openV3HostEffects([
      opened,
      { ts: 11, type: 'nodeSucceeded', nodeId: 'send', instanceId: 'send#001',
        attemptId: 'send#001/attempts/001', manifestPath: '/run/manifest.json' },
      opened,
    ])).toEqual([]);
  });

  it('closes on an explicit uncertain verdict without pretending success or failure', () => {
    expect(openV3HostEffects([
      intent(),
      {
        ts: 11,
        type: 'hostEffectUncertain',
        nodeId: 'send',
        instanceId: 'send#001',
        attemptId: 'send#001/attempts/001',
        executor: 'feishu-send',
        reason: 'ttlExpired',
        errorCode: 'HOST_EFFECT_TTL_EXPIRED',
      },
    ])).toEqual([]);
  });

  it('does not let a close-before-open bless a later intent', () => {
    const verdict = { ts: 9, type: 'nodeBlocked', nodeId: 'send', instanceId: 'send#001',
      attemptId: 'send#001/attempts/001', errorClass: 'workerError' } as StoredEvent;
    expect(openV3HostEffects([verdict, intent()])).toHaveLength(1);
  });

  it('fails closed on an identity-changing duplicate or verdict', () => {
    expect(() => openV3HostEffects([intent(), intent({ nodeId: 'other' } as Partial<StoredEvent>)]))
      .toThrow(/identity changed/);
    expect(() => openV3HostEffects([
      intent(),
      { ts: 11, type: 'nodeFailed', nodeId: 'other', instanceId: 'send#001',
        attemptId: 'send#001/attempts/001', errorClass: 'workerError' },
    ])).toThrow(/close identity changed/);
    expect(() => openV3HostEffects([
      intent(),
      { ts: 11, type: 'hostEffectUncertain', nodeId: 'send', instanceId: 'send#001',
        attemptId: 'send#001/attempts/001', executor: 'feishu-reply',
        reason: 'providerUncertain', errorCode: 'UNKNOWN' },
    ])).toThrow(/uncertain executor changed/);
  });

  it('validates retry deferral identity and a monotonic replay sequence', () => {
    const first = {
      ts: 11,
      type: 'hostEffectRetryDeferred',
      nodeId: 'send',
      instanceId: 'send#001',
      attemptId: 'send#001/attempts/001',
      retryCount: 1,
      nextRetryAt: 1_010,
      errorCode: 'RETRYABLE',
    } as StoredEvent;
    expect(openV3HostEffects([intent(), first, first])).toHaveLength(1);
    expect(openV3HostEffects([intent(), first, {
      ...first, ts: 12, retryCount: 2, nextRetryAt: 3_010,
    } as StoredEvent])).toHaveLength(1);
    expect(() => openV3HostEffects([intent(), {
      ...first, nodeId: 'other',
    } as StoredEvent])).toThrow(/deferral identity changed/);
    expect(() => openV3HostEffects([intent(), {
      ...first, retryCount: 2,
    } as StoredEvent])).toThrow(/must start at 1/);
    expect(() => openV3HostEffects([intent(), first, {
      ...first, ts: 12, retryCount: 3, nextRetryAt: 3_010,
    } as StoredEvent])).toThrow(/retry sequence changed/);
  });
});
