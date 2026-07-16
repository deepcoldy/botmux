import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import type { VcMeetingDeliveryRequest } from '../src/services/vc-meeting-delivery-protocol.js';

vi.mock('@larksuiteoapi/node-sdk', () => {
  class FakeClient { constructor(public opts: Record<string, unknown>) {} }
  return { Client: FakeClient, LoggerLevel: { error: 0, warn: 1, info: 2 } };
});

import { __testOnly_vcMeetingReceiverRecovery as recovery } from '../src/daemon.js';

const daemonSource = readFileSync(new URL('../src/daemon.ts', import.meta.url), 'utf8');

function delivery(sessionId: string, memberId: string): VcMeetingDeliveryRequest {
  return {
    schemaVersion: 1,
    meeting: {
      listenerAppId: 'listener_test',
      meetingId: 'meeting_test',
      ownerBootId: 'owner_boot',
      ownerEpoch: 1,
    },
    member: {
      memberId,
      agentAppId: 'agent_test',
      role: 'reviewer',
      epoch: 1,
      membershipGeneration: 1,
    },
    stream: {
      fromSeq: 1,
      toSeq: 1,
      batchId: `batch_${memberId}`,
      inputHash: 'unused_by_gate',
      final: false,
    },
    entries: [{ deliverySeq: 1, kind: 'item', rawText: 'hello' }],
    target: { sessionId, chatId: 'chat_test' },
    instructionVersion: 'v1',
  };
}

describe('VC meeting receiver boot-recovery lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    recovery.reset();
  });

  afterEach(() => {
    recovery.reset();
    vi.useRealTimers();
  });

  it('ignores a reset-ready ACK that arrives after timeout escalation until orphan teardown completes', async () => {
    recovery.setBackingMissingProbe(() => true);
    const key = recovery.start('sess_late_ack', 'delivery_late_ack', 4, {
      memberId: 'member_a',
    });
    recovery.finishScheduling();

    expect(recovery.snapshot(key)).toMatchObject({
      ready: false,
      pending: true,
      timerArmed: true,
    });
    expect(recovery.isBlocked(delivery('sess_late_ack', 'member_a'))).toBe(true);
    // Per-receiver recovery: A's stuck reset never creates a daemon-global
    // barrier for unrelated receiver/member B.
    expect(recovery.isBlocked(delivery('sess_b', 'member_b'))).toBe(false);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(recovery.snapshot(key)).toMatchObject({
      ready: false,
      pending: true,
      timerArmed: true,
    });

    // The worker ACK belongs to the pre-escalation reset request. Once the
    // daemon has committed to kill + orphan teardown it must not cancel phase 2.
    recovery.acknowledge('sess_late_ack', 'delivery_late_ack', 4);
    expect(recovery.snapshot(key)).toMatchObject({
      ready: false,
      pending: true,
      timerArmed: true,
    });

    await vi.advanceTimersByTimeAsync(7_999);
    expect(recovery.snapshot(key).ready).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(recovery.snapshot(key)).toMatchObject({
      ready: true,
      pending: false,
      timerArmed: false,
    });
  });

  it('does not trust reset-ready without authoritative backing-missing proof', async () => {
    recovery.setBackingMissingProbe(() => false);
    const key = recovery.start('sess_unproven_ack', 'delivery_unproven_ack', 2, {
      memberId: 'member_unproven',
    });
    recovery.finishScheduling();

    recovery.acknowledge('sess_unproven_ack', 'delivery_unproven_ack', 2);
    expect(recovery.snapshot(key)).toMatchObject({
      ready: false,
      pending: true,
      timerArmed: true,
    });

    recovery.setBackingMissingProbe(() => true);
    await vi.advanceTimersByTimeAsync(7_999);
    expect(recovery.isBlocked(delivery('sess_unproven_ack', 'member_unproven'))).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(recovery.snapshot(key)).toMatchObject({ ready: true, pending: false, timerArmed: false });
  });

  it('keeps the boot gate pending when reset IPC send throws', () => {
    const failureLog = daemonSource.indexOf('failed to fence boot-ambiguous receiver');
    expect(failureLog).toBeGreaterThanOrEqual(0);
    const catchBlock = daemonSource.slice(failureLog, failureLog + 500);
    expect(catchBlock).toContain('escalateVcMeetingBootRecovery(recoveryKey, ref.receiverSessionId)');
    expect(catchBlock).not.toContain('clearVcMeetingReceiverRecoveryPending(recoveryKey)');
  });
});
