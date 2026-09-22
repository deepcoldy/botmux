import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __testOnly_resetOneShotRetirementCloseState,
  armOneShotRetirement,
  closeOneShotRetirementIfReady,
  reconcileOneShotRetirementsOnBoot,
  recordOneShotRetirementEvidence,
  type OneShotRetirementTuple,
} from '../src/services/one-shot-retirement.js';
import type { Session } from '../src/types.js';

const NOW = new Date('2026-09-21T10:00:00.000Z');
const TUPLE: OneShotRetirementTuple = {
  sessionId: 'session-one-shot',
  workerGeneration: 7,
  turnId: 'om_one_shot',
};
const OWNER_LARK_APP_ID = 'cli_one_shot_owner';

function oneShotSession(): Session {
  return {
    sessionId: TUPLE.sessionId,
    chatId: 'oc_visible',
    chatType: 'group',
    rootMessageId: 'om_visible',
    title: 'one shot',
    status: 'active',
    larkAppId: OWNER_LARK_APP_ID,
    createdAt: NOW.toISOString(),
    workerGeneration: TUPLE.workerGeneration,
    oneShot: {
      version: 1,
      mode: 'ordinary_per_message',
      routingAnchor: 'one-shot:om_one_shot',
      visibleLaneKey: 'lane:oc_visible:om_visible',
      visibleRoute: {
        chatId: 'oc_visible',
        chatType: 'group',
        scope: 'thread',
        rootMessageId: 'om_visible',
      },
      createdAt: NOW.toISOString(),
      turn: { turnId: TUPLE.turnId },
    },
  } as Session;
}

function harness() {
  const session = oneShotSession();
  const persisted: Session[] = [];
  const persist = vi.fn((row: Session) => {
    persisted.push(structuredClone(row));
  });
  armOneShotRetirement(session, TUPLE, { persist, now: () => NOW });
  persist.mockClear();
  persisted.length = 0;
  return { session, persist, persisted };
}

function bootSession(
  phase: 'armed' | 'waiting' | 'ready' | 'closing',
  options: {
    sessionId?: string;
    ownerLarkAppId?: string;
    ownerMissing?: boolean;
    uncertainReason?: string;
  } = {},
): Session {
  const session = oneShotSession();
  const sessionId = options.sessionId ?? `boot-${phase}`;
  session.sessionId = sessionId;
  if (options.ownerMissing) delete session.larkAppId;
  else session.larkAppId = options.ownerLarkAppId ?? OWNER_LARK_APP_ID;
  session.oneShot!.turn.workerGeneration = TUPLE.workerGeneration;
  session.oneShot!.retirement = {
    version: 1,
    turnId: TUPLE.turnId,
    workerGeneration: TUPLE.workerGeneration,
    phase,
    ...(phase === 'armed' ? {} : {
      terminal: { status: 'completed' },
    }),
    delivery: options.uncertainReason
      ? { state: 'uncertain', reason: options.uncertainReason }
      : phase === 'ready' || phase === 'closing'
        ? { state: 'settled', source: 'automatic_final', messageId: 'om_boot_answer' }
        : { state: 'pending' },
    updatedAt: NOW.toISOString(),
  };
  return session;
}

function bootHarness(sessions: Session[]) {
  const durable = new Map(sessions.map(session => [
    session.sessionId,
    structuredClone(session),
  ]));
  const persist = vi.fn((row: Session) => {
    durable.set(row.sessionId, structuredClone(row));
  });
  const read = vi.fn((sessionId: string) => {
    const row = durable.get(sessionId);
    return row ? structuredClone(row) : undefined;
  });
  return { durable, persist, read };
}

describe('one-shot retirement join', () => {
  beforeEach(() => __testOnly_resetOneShotRetirementCloseState());

  it('joins terminal-first evidence and persists ready before closing', async () => {
    const { session, persist, persisted } = harness();
    const close = vi.fn(async () => ({ ok: true as const }));

    expect(recordOneShotRetirementEvidence(session, TUPLE, {
      kind: 'terminal', status: 'completed', completedAtMs: NOW.getTime(),
    }, { persist, now: () => NOW })).toMatchObject({
      outcome: 'persisted', retirement: { phase: 'waiting', delivery: { state: 'pending' } },
    });
    expect(close).not.toHaveBeenCalled();

    expect(recordOneShotRetirementEvidence(session, TUPLE, {
      kind: 'delivery', source: 'automatic_final', messageId: 'om_answer',
    }, { persist, now: () => NOW })).toMatchObject({
      outcome: 'persisted', retirement: { phase: 'ready' },
    });
    await closeOneShotRetirementIfReady(session, TUPLE, { persist, close, now: () => NOW });

    expect(persisted.map(row => row.oneShot?.retirement?.phase)).toEqual([
      'waiting', 'ready', 'closing',
    ]);
    expect(close).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledWith(
      TUPLE.sessionId,
      expect.stringContaining('one-shot retirement'),
    );
  });

  it('joins delivery-first evidence only after the exact terminal arrives', async () => {
    const { session, persist } = harness();
    const close = vi.fn(async () => ({ ok: true as const }));

    expect(recordOneShotRetirementEvidence(session, TUPLE, {
      kind: 'delivery', source: 'explicit_final', messageId: 'om_explicit',
    }, { persist })).toMatchObject({
      outcome: 'persisted', retirement: { phase: 'waiting' },
    });
    await expect(closeOneShotRetirementIfReady(session, TUPLE, { persist, close }))
      .resolves.toEqual({ outcome: 'not_ready' });

    expect(recordOneShotRetirementEvidence(session, TUPLE, {
      kind: 'terminal', status: 'completed',
    }, { persist })).toMatchObject({
      outcome: 'persisted', retirement: { phase: 'ready' },
    });
    await closeOneShotRetirementIfReady(session, TUPLE, { persist, close });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('does not retire after delivery when no terminal evidence exists', async () => {
    const { session, persist } = harness();
    const close = vi.fn(async () => ({ ok: true as const }));

    recordOneShotRetirementEvidence(session, TUPLE, {
      kind: 'delivery', source: 'automatic_final', messageId: 'om_answer',
    }, { persist });

    await expect(closeOneShotRetirementIfReady(session, TUPLE, { persist, close }))
      .resolves.toEqual({ outcome: 'not_ready' });
    expect(close).not.toHaveBeenCalled();
    expect(session.oneShot?.retirement?.phase).toBe('waiting');
  });

  it('keeps retry-exhausted delivery uncertainty sticky and fail-closed', async () => {
    const { session, persist } = harness();
    const close = vi.fn(async () => ({ ok: true as const }));

    recordOneShotRetirementEvidence(session, TUPLE, {
      kind: 'terminal', status: 'completed',
    }, { persist });
    expect(recordOneShotRetirementEvidence(session, TUPLE, {
      kind: 'delivery_uncertain', reason: 'automatic_final_retry_exhausted',
    }, { persist })).toMatchObject({
      outcome: 'persisted',
      retirement: {
        phase: 'waiting',
        delivery: { state: 'uncertain', reason: 'automatic_final_retry_exhausted' },
      },
    });
    expect(recordOneShotRetirementEvidence(session, TUPLE, {
      kind: 'delivery', source: 'automatic_final', messageId: 'late-unproven',
    }, { persist })).toEqual({
      outcome: 'conflict', reason: 'delivery_already_uncertain',
    });

    await expect(closeOneShotRetirementIfReady(session, TUPLE, { persist, close }))
      .resolves.toEqual({ outcome: 'not_ready' });
    expect(close).not.toHaveBeenCalled();
  });

  it('rejects stale worker generations without mutating durable state', () => {
    const { session, persist } = harness();
    const before = structuredClone(session.oneShot?.retirement);

    expect(recordOneShotRetirementEvidence(session, {
      ...TUPLE, workerGeneration: TUPLE.workerGeneration - 1,
    }, { kind: 'terminal', status: 'completed' }, { persist })).toEqual({
      outcome: 'stale', reason: 'session_generation_mismatch',
    });
    expect(session.oneShot?.retirement).toEqual(before);
    expect(persist).not.toHaveBeenCalled();
  });

  it('deduplicates evidence and concurrent close attempts', async () => {
    const { session, persist } = harness();
    const release: Array<() => void> = [];
    const close = vi.fn(() => new Promise<{ ok: true }>(resolve => {
      release.push(() => resolve({ ok: true }));
    }));
    const terminal = { kind: 'terminal', status: 'completed' } as const;

    expect(recordOneShotRetirementEvidence(session, TUPLE, terminal, { persist }).outcome)
      .toBe('persisted');
    expect(recordOneShotRetirementEvidence(session, TUPLE, terminal, { persist }).outcome)
      .toBe('duplicate');
    expect(recordOneShotRetirementEvidence(session, TUPLE, {
      kind: 'delivery', source: 'automatic_final', messageId: 'om_answer',
    }, { persist }).outcome).toBe('persisted');

    const first = closeOneShotRetirementIfReady(session, TUPLE, { persist, close });
    const second = closeOneShotRetirementIfReady(session, TUPLE, { persist, close });
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
    release[0]();
    await expect(Promise.all([first, second])).resolves.toEqual([
      { outcome: 'close_requested', result: { ok: true } },
      { outcome: 'close_requested', result: { ok: true } },
    ]);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('keeps a refused close durably claimed and allows a later retry', async () => {
    const { session, persist } = harness();
    recordOneShotRetirementEvidence(session, TUPLE, {
      kind: 'terminal', status: 'completed',
    }, { persist });
    recordOneShotRetirementEvidence(session, TUPLE, {
      kind: 'delivery', source: 'automatic_final', messageId: 'om_answer',
    }, { persist });
    const close = vi.fn()
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({ ok: true });

    await expect(closeOneShotRetirementIfReady(session, TUPLE, { persist, close }))
      .resolves.toEqual({ outcome: 'close_refused', result: { ok: false } });
    expect(session.oneShot?.retirement?.phase).toBe('closing');

    await expect(closeOneShotRetirementIfReady(session, TUPLE, { persist, close }))
      .resolves.toEqual({ outcome: 'close_requested', result: { ok: true } });
    expect(close).toHaveBeenCalledTimes(2);
  });

  it('keeps nothing-to-send waiting until exact policy or notice evidence settles it', () => {
    const noOutput = harness();
    expect(recordOneShotRetirementEvidence(noOutput.session, TUPLE, {
      kind: 'terminal', status: 'completed', outputDisposition: 'nothing_to_send',
    }, { persist: noOutput.persist })).toMatchObject({
      outcome: 'persisted',
      retirement: {
        phase: 'waiting',
        delivery: { state: 'pending' },
      },
    });
    expect(recordOneShotRetirementEvidence(noOutput.session, TUPLE, {
      kind: 'delivery', source: 'nothing_to_send',
    }, { persist: noOutput.persist })).toMatchObject({
      outcome: 'persisted',
      retirement: {
        phase: 'ready', delivery: { state: 'settled', source: 'nothing_to_send' },
      },
    });

    const visibleReceipt = harness();
    recordOneShotRetirementEvidence(visibleReceipt.session, TUPLE, {
      kind: 'terminal', status: 'completed', outputDisposition: 'nothing_to_send',
    }, { persist: visibleReceipt.persist });
    expect(recordOneShotRetirementEvidence(visibleReceipt.session, TUPLE, {
      kind: 'delivery', source: 'terminal_notice', messageId: 'om_silence_receipt',
    }, { persist: visibleReceipt.persist })).toMatchObject({
      outcome: 'persisted',
      retirement: {
        phase: 'ready', delivery: { state: 'settled', source: 'terminal_notice' },
      },
    });

    const failure = harness();
    recordOneShotRetirementEvidence(failure.session, TUPLE, {
      kind: 'terminal', status: 'failed',
    }, { persist: failure.persist });
    expect(recordOneShotRetirementEvidence(failure.session, TUPLE, {
      kind: 'delivery', source: 'terminal_notice', messageId: 'om_failure',
    }, { persist: failure.persist })).toMatchObject({
      outcome: 'persisted', retirement: { phase: 'ready' },
    });
  });
});

describe('one-shot retirement boot reconciliation', () => {
  beforeEach(() => __testOnly_resetOneShotRetirementCloseState());

  it('persists closing before re-driving ready and accepts only a durable closed readback', async () => {
    const session = bootSession('ready');
    const { durable, persist, read } = bootHarness([session]);
    const order: string[] = [];
    persist.mockImplementation((row: Session) => {
      order.push(`persist:${row.oneShot?.retirement?.phase}`);
      durable.set(row.sessionId, structuredClone(row));
    });
    const close = vi.fn(async (sessionId: string) => {
      order.push('close');
      const row = structuredClone(durable.get(sessionId)!);
      row.status = 'closed';
      durable.set(sessionId, row);
      return { ok: true as const };
    });

    const result = await reconcileOneShotRetirementsOnBoot([session], {
      ownerLarkAppId: OWNER_LARK_APP_ID, persist, read, close, now: () => NOW,
    });

    expect(order).toEqual(['persist:closing', 'close']);
    expect(read).toHaveBeenCalledWith(session.sessionId);
    expect(result.closedSessionIds).toEqual(new Set([session.sessionId]));
    expect(result.quarantinedSessionIds).toEqual(new Set());
  });

  it('re-drives a closing row without rewriting the claim', async () => {
    const session = bootSession('closing');
    const { durable, persist, read } = bootHarness([session]);
    const close = vi.fn(async (sessionId: string) => {
      const row = structuredClone(durable.get(sessionId)!);
      row.status = 'closed';
      durable.set(sessionId, row);
      return { ok: true as const };
    });

    const result = await reconcileOneShotRetirementsOnBoot([session], {
      ownerLarkAppId: OWNER_LARK_APP_ID, persist, read, close, now: () => NOW,
    });

    expect(close).toHaveBeenCalledTimes(1);
    expect(persist).not.toHaveBeenCalled();
    expect(result.closedSessionIds).toEqual(new Set([session.sessionId]));
  });

  it('quarantines an ok close whose row is still durably active', async () => {
    const session = bootSession('ready');
    const { durable, persist, read } = bootHarness([session]);
    const close = vi.fn(async () => ({ ok: true as const }));

    const result = await reconcileOneShotRetirementsOnBoot([session], {
      ownerLarkAppId: OWNER_LARK_APP_ID, persist, read, close, now: () => NOW,
    });

    expect(result.closedSessionIds).toEqual(new Set());
    expect(result.quarantinedSessionIds).toEqual(new Set([session.sessionId]));
    expect(result.quarantineReasons.get(session.sessionId)).toBe('close_not_durable');
    expect(durable.get(session.sessionId)?.restoreQuarantinedAt).toBe(NOW.toISOString());
  });

  it.each([
    ['refused close', 'ready' as const, { kind: 'refused' as const }, 'close_refused'],
    ['thrown close', 'ready' as const, { kind: 'throw' as const }, 'close_error:boom'],
    ['malformed tuple', 'ready' as const, { kind: 'conflict' as const }, 'conflict:invalid_worker_generation'],
  ])('quarantines %s', async (_label, phase, behavior, expectedReason) => {
    const session = bootSession(phase);
    if (behavior.kind === 'conflict') {
      session.oneShot!.retirement!.workerGeneration = 0;
    }
    const { durable, persist, read } = bootHarness([session]);
    const close = vi.fn(async () => {
      if (behavior.kind === 'throw') throw new Error('boom');
      return { ok: behavior.kind !== 'refused' };
    });

    const result = await reconcileOneShotRetirementsOnBoot([session], {
      ownerLarkAppId: OWNER_LARK_APP_ID, persist, read, close, now: () => NOW,
    });

    expect(result.quarantinedSessionIds).toEqual(new Set([session.sessionId]));
    expect(result.quarantineReasons.get(session.sessionId)).toBe(expectedReason);
    expect(durable.get(session.sessionId)?.restoreQuarantinedAt).toBe(NOW.toISOString());
  });

  it.each([
    ['armed', bootSession('armed'), 'retirement_armed'],
    ['waiting', bootSession('waiting'), 'retirement_waiting'],
    [
      'uncertain',
      bootSession('waiting', { sessionId: 'boot-uncertain', uncertainReason: 'retry_exhausted' }),
      'retirement_waiting:retry_exhausted',
    ],
  ])('quarantines unresolved %s rows without attempting close', async (_label, session, reason) => {
    const { durable, persist, read } = bootHarness([session]);
    const close = vi.fn(async () => ({ ok: true as const }));

    const result = await reconcileOneShotRetirementsOnBoot([session], {
      ownerLarkAppId: OWNER_LARK_APP_ID, persist, read, close, now: () => NOW,
    });

    expect(close).not.toHaveBeenCalled();
    expect(result.quarantineReasons.get(session.sessionId)).toBe(reason);
    expect(durable.get(session.sessionId)?.restoreQuarantinedAt).toBe(NOW.toISOString());
  });

  it('quarantines an exact-owner active one-shot that was never armed', async () => {
    const session = oneShotSession();
    session.sessionId = 'boot-unarmed';
    const { durable, persist, read } = bootHarness([session]);
    const close = vi.fn(async () => ({ ok: true as const }));

    const result = await reconcileOneShotRetirementsOnBoot([session], {
      ownerLarkAppId: OWNER_LARK_APP_ID, persist, read, close, now: () => NOW,
    });

    expect(close).not.toHaveBeenCalled();
    expect(result.quarantineReasons.get(session.sessionId)).toBe('retirement_not_armed');
    expect(durable.get(session.sessionId)?.restoreQuarantinedAt).toBe(NOW.toISOString());
  });

  it('quarantines an exact-owner row with malformed one-shot identity', async () => {
    const session = bootSession('ready', { sessionId: 'boot-malformed-one-shot' });
    (session.oneShot as { version: number }).version = 2;
    const { durable, persist, read } = bootHarness([session]);
    const close = vi.fn(async () => ({ ok: true as const }));

    const result = await reconcileOneShotRetirementsOnBoot([session], {
      ownerLarkAppId: OWNER_LARK_APP_ID, persist, read, close, now: () => NOW,
    });

    expect(close).not.toHaveBeenCalled();
    expect(result.quarantineReasons.get(session.sessionId)).toBe('invalid_one_shot_identity');
    expect(durable.get(session.sessionId)?.restoreQuarantinedAt).toBe(NOW.toISOString());
  });

  it('excludes ownerless and mismatched rows without cross-daemon mutation', async () => {
    const ownerless = bootSession('ready', { sessionId: 'boot-ownerless', ownerMissing: true });
    const foreign = bootSession('ready', {
      sessionId: 'boot-foreign', ownerLarkAppId: 'cli_other_owner',
    });
    const { persist, read } = bootHarness([ownerless, foreign]);
    const close = vi.fn(async () => ({ ok: true as const }));

    const result = await reconcileOneShotRetirementsOnBoot([ownerless, foreign], {
      ownerLarkAppId: OWNER_LARK_APP_ID, persist, read, close, now: () => NOW,
    });

    expect(result.quarantinedSessionIds).toEqual(new Set([
      ownerless.sessionId, foreign.sessionId,
    ]));
    expect(result.quarantineReasons).toEqual(new Map([
      [ownerless.sessionId, 'one_shot_owner_missing'],
      [foreign.sessionId, 'one_shot_owner_mismatch'],
    ]));
    expect(read).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });
});
