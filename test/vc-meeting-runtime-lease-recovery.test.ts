import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DaemonSession } from '../src/core/types.js';
import type { VcMeetingDeliveryRequest } from '../src/services/vc-meeting-delivery-protocol.js';
import type { VcMeetingAmbiguousReceiptRef } from '../src/services/vc-meeting-delivery-store.js';

vi.mock('@larksuiteoapi/node-sdk', () => {
  class FakeClient { constructor(public opts: Record<string, unknown>) {} }
  return { Client: FakeClient, LoggerLevel: { error: 0, warn: 1, info: 2 } };
});

import { __testOnly_createVcMeetingRuntimeLeaseRecovery as createRecovery } from '../src/daemon.js';

type FakeSession = DaemonSession & { testPersistentScope?: 'tmux' | 'herdr' | 'zellij' | 'none' | 'unknown' };

function ref(overrides: Partial<VcMeetingAmbiguousReceiptRef> = {}): VcMeetingAmbiguousReceiptRef {
  return {
    listenerAppId: 'listener_test',
    meetingId: 'meeting_test',
    memberId: 'member_a',
    memberEpoch: 1,
    deliveryKey: 'delivery_a',
    receiverSessionId: 'session_a',
    workerGeneration: 7,
    dispatchAttempt: 1,
    ambiguousReplayCount: 1,
    ...overrides,
  };
}

function delivery(sessionId = 'session_a', memberId = 'member_a'): VcMeetingDeliveryRequest {
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

function fakeSession(options: {
  sessionId?: string;
  memberId?: string;
  worker?: boolean;
  workerGeneration?: number;
  persistentScope?: FakeSession['testPersistentScope'];
} = {}): FakeSession {
  const sessionId = options.sessionId ?? 'session_a';
  return {
    session: {
      sessionId,
      vcMeetingReceiver: {
        listenerAppId: 'listener_test',
        meetingId: 'meeting_test',
        memberId: options.memberId ?? 'member_a',
        memberEpoch: 1,
      },
    },
    larkAppId: 'agent_test',
    workerGeneration: options.workerGeneration ?? 7,
    worker: options.worker === false ? null : { killed: false },
    testPersistentScope: options.persistentScope ?? 'tmux',
  } as unknown as FakeSession;
}

function harness(input: {
  sessions?: FakeSession[];
  probe?: (backend: 'tmux' | 'herdr' | 'zellij', sessionName: string) => 'exists' | 'missing' | 'unknown';
  missingPersistentScope?: FakeSession['testPersistentScope'];
  backendAvailable?: (backend: 'tmux' | 'herdr' | 'zellij') => boolean;
} = {}) {
  const sessions = new Map((input.sessions ?? []).map(ds => [ds.session.sessionId, ds]));
  const sent: Array<{ sessionId: string; turnId: string; dispatchAttempt: number }> = [];
  const killed: string[] = [];
  const backingKills: string[] = [];
  const probes: string[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];
  const recovery = createRecovery({
    findSession: (sessionId: string) => sessions.get(sessionId),
    sendExpiry: (ds: FakeSession, message: { turnId: string; dispatchAttempt: number }) => {
      sent.push({
        sessionId: ds.session.sessionId,
        turnId: message.turnId,
        dispatchAttempt: message.dispatchAttempt,
      });
    },
    killWorker: (ds: FakeSession) => {
      killed.push(ds.session.sessionId);
      ds.worker = null;
    },
    resolvePersistentScope: (ds: FakeSession) => ds.testPersistentScope ?? 'unknown',
    resolveMissingPersistentScope: () => input.missingPersistentScope ?? 'unknown',
    backendAvailable: (backend: 'tmux' | 'herdr' | 'zellij') => input.backendAvailable?.(backend) ?? true,
    killPersistent: (backend: string, sessionName: string) => {
      backingKills.push(`${backend}:${sessionName}`);
    },
    probePersistent: (backend: 'tmux' | 'herdr' | 'zellij', sessionName: string) => {
      probes.push(`${backend}:${sessionName}`);
      return input.probe?.(backend, sessionName) ?? 'missing';
    },
    warn: (message: string) => warnings.push(message),
    error: (message: string) => errors.push(message),
  } as any);
  return { recovery, sessions, sent, killed, backingKills, probes, warnings, errors };
}

describe('VC meeting runtime lease recovery', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('gates only live receiver A until its exact worker-generation ACK', () => {
    const h = harness({ sessions: [fakeSession()] });
    h.recovery.arm(ref(), 'agent_test');

    expect(h.sent).toEqual([{ sessionId: 'session_a', turnId: 'delivery_a', dispatchAttempt: 1 }]);
    expect(h.recovery.isBlocked(delivery())).toBe(true);
    expect(h.recovery.isBlocked(delivery('session_b', 'member_b'))).toBe(false);

    expect(h.recovery.acknowledge({
      sessionId: 'session_a', turnId: 'delivery_a', dispatchAttempt: 1, workerGeneration: 6,
      disposition: 'queued_removed',
    })).toBe(false);
    expect(h.recovery.isBlocked(delivery())).toBe(true);
    expect(h.recovery.acknowledge({
      sessionId: 'session_a', turnId: 'delivery_a', dispatchAttempt: 1, workerGeneration: 7,
      disposition: 'queued_removed',
    })).toBe(true);
    expect(h.recovery.isBlocked(delivery())).toBe(false);
  });

  it('accepts cli_fenced ACK only when the persisted exact backend probes missing', () => {
    const h = harness({ sessions: [fakeSession({ persistentScope: 'tmux' })] });
    h.recovery.arm(ref(), 'agent_test');

    expect(h.recovery.acknowledge({
      sessionId: 'session_a',
      turnId: 'delivery_a',
      dispatchAttempt: 1,
      workerGeneration: 7,
      disposition: 'cli_fenced',
    })).toBe(true);
    expect(h.probes).toEqual(['tmux:bmx-session_']);
    expect(h.recovery.snapshot()).toEqual([]);
  });

  it('escalates an unproven cli_fenced ACK and ignores its duplicate until teardown proves missing', async () => {
    let probeState: 'exists' | 'missing' = 'exists';
    const h = harness({
      sessions: [fakeSession({ persistentScope: 'tmux' })],
      probe: () => probeState,
    });
    h.recovery.arm(ref(), 'agent_test');
    const ack = {
      sessionId: 'session_a',
      turnId: 'delivery_a',
      dispatchAttempt: 1,
      workerGeneration: 7,
      disposition: 'cli_fenced' as const,
    };

    expect(h.recovery.acknowledge(ack)).toBe(false);
    expect(h.killed).toEqual(['session_a']);
    expect(h.recovery.snapshot()).toMatchObject([{ phase: 'escalating', timerArmed: true }]);
    expect(h.recovery.acknowledge(ack)).toBe(false);

    probeState = 'missing';
    await vi.advanceTimersByTimeAsync(8_000);
    expect(h.recovery.snapshot()).toEqual([]);
  });

  it('kills and probes a workerless owned pane, unlocking only after authoritative missing', () => {
    const h = harness({
      sessions: [fakeSession({ worker: false, persistentScope: 'tmux' })],
    });
    h.recovery.arm(ref(), 'agent_test');

    expect(h.killed).toEqual(['session_a']);
    expect(h.backingKills).toEqual(['tmux:bmx-session_']);
    expect(h.probes).toEqual(['tmux:bmx-session_']);
    expect(h.recovery.snapshot()).toEqual([]);
  });

  it('keeps worker-exit replay gated while its persistent pane exists, without blocking another member', async () => {
    let probeState: 'exists' | 'missing' = 'exists';
    const h = harness({
      sessions: [fakeSession({ worker: false, persistentScope: 'tmux' })],
      probe: () => probeState,
    });
    h.recovery.arm(ref(), 'agent_test');

    expect(h.recovery.isBlocked(delivery('session_a', 'member_a'))).toBe(true);
    expect(h.recovery.isBlocked(delivery('session_b', 'member_b'))).toBe(false);
    expect(h.recovery.snapshot()).toMatchObject([{ phase: 'blocked', timerArmed: true }]);

    probeState = 'missing';
    await vi.advanceTimersByTimeAsync(4_999);
    expect(h.recovery.isBlocked(delivery('session_a', 'member_a'))).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.recovery.isBlocked(delivery('session_a', 'member_a'))).toBe(false);
  });

  it('probes every deterministic backend when ds is missing and keeps unknown fail-closed', () => {
    const h = harness({
      probe: backend => backend === 'zellij' ? 'unknown' : 'missing',
    });
    h.recovery.arm(ref(), 'agent_test');

    expect(h.backingKills.map(value => value.split(':')[0])).toEqual(['tmux', 'herdr', 'zellij']);
    expect(h.probes.map(value => value.split(':')[0])).toEqual(['tmux', 'herdr', 'zellij']);
    expect(h.recovery.snapshot()).toMatchObject([{
      receiverSessionId: 'session_a',
      deliveryKey: 'delivery_a',
      dispatchAttempt: 1,
      phase: 'blocked',
      timerArmed: true,
    }]);
    expect(h.recovery.isBlocked(delivery())).toBe(true);
    expect(h.errors.some(message => message.includes('backing unknown'))).toBe(true);
  });

  it('uses persisted backend type for a missing ds instead of unknown cross-backend probes', () => {
    const h = harness({ missingPersistentScope: 'tmux' });
    h.recovery.arm(ref(), 'agent_test');

    expect(h.backingKills).toEqual(['tmux:bmx-session_']);
    expect(h.probes).toEqual(['tmux:bmx-session_']);
    expect(h.recovery.snapshot()).toEqual([]);
  });

  it('excludes unavailable backends when a missing ds has no persisted backend type', () => {
    const h = harness({
      backendAvailable: backend => backend === 'tmux',
    });
    h.recovery.arm(ref(), 'agent_test');

    expect(h.backingKills).toEqual(['tmux:bmx-session_']);
    expect(h.probes).toEqual(['tmux:bmx-session_']);
    expect(h.recovery.snapshot()).toEqual([]);
  });

  it('reprobes an unknown missing-ds fence and unlocks once every available backend is missing', async () => {
    let probeState: 'unknown' | 'missing' = 'unknown';
    const h = harness({ probe: () => probeState });
    h.recovery.arm(ref(), 'agent_test');
    expect(h.recovery.snapshot()).toMatchObject([{ phase: 'blocked', timerArmed: true }]);

    probeState = 'missing';
    await vi.advanceTimersByTimeAsync(4_999);
    expect(h.recovery.isBlocked(delivery())).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.recovery.snapshot()).toEqual([]);
  });

  it('ignores a late ACK after timeout escalation until teardown probe completes', async () => {
    const h = harness({ sessions: [fakeSession()] });
    h.recovery.arm(ref(), 'agent_test');

    await vi.advanceTimersByTimeAsync(3_000);
    expect(h.killed).toEqual(['session_a']);
    expect(h.recovery.snapshot()).toMatchObject([{ phase: 'escalating', timerArmed: true }]);
    expect(h.recovery.acknowledge({
      sessionId: 'session_a', turnId: 'delivery_a', dispatchAttempt: 1, workerGeneration: 7,
      disposition: 'queued_removed',
    })).toBe(false);
    expect(h.recovery.isBlocked(delivery())).toBe(true);

    await vi.advanceTimersByTimeAsync(7_999);
    expect(h.recovery.isBlocked(delivery())).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.killed).toEqual(['session_a', 'session_a']);
    expect(h.recovery.snapshot()).toEqual([]);
  });

  it('never sends expiry to or accepts proof from a non-exact live worker generation', () => {
    const h = harness({ sessions: [fakeSession({ workerGeneration: 9 })] });
    h.recovery.arm(ref({ workerGeneration: 8 }), 'agent_test');

    expect(h.sent).toEqual([]);
    expect(h.killed).toEqual(['session_a']);
    expect(h.recovery.snapshot()).toMatchObject([{ phase: 'escalating', timerArmed: true }]);
    expect(h.recovery.acknowledge({
      sessionId: 'session_a',
      turnId: 'delivery_a',
      dispatchAttempt: 1,
      workerGeneration: 9,
      disposition: 'queued_removed',
    })).toBe(false);
    expect(h.recovery.isBlocked(delivery())).toBe(true);
  });

  it('does not let an old-attempt ACK release a newer fence on the same stream', () => {
    const h = harness({ sessions: [fakeSession()] });
    h.recovery.arm(ref(), 'agent_test');
    h.recovery.arm(ref({ dispatchAttempt: 2 }), 'agent_test');

    expect(h.recovery.acknowledge({
      sessionId: 'session_a', turnId: 'delivery_a', dispatchAttempt: 1, workerGeneration: 7,
      disposition: 'queued_removed',
    })).toBe(false);
    expect(h.recovery.snapshot()).toMatchObject([{ dispatchAttempt: 2, phase: 'awaiting_ack' }]);
    expect(h.recovery.acknowledge({
      sessionId: 'session_a', turnId: 'delivery_a', dispatchAttempt: 2, workerGeneration: 7,
      disposition: 'queued_removed',
    })).toBe(true);
  });
});
