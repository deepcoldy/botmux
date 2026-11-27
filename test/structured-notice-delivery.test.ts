import { describe, expect, it, vi } from 'vitest';
import type { Session } from '../src/types.js';
import { deliverStructuredNotice, StructuredNoticeCardPendingError, type StructuredNoticeDeliveryInput } from '../src/services/structured-notice-delivery.js';
import { RecoveryNoticeOutbox, type TurnNoticeRecord } from '../src/services/ordinary-recovery-notice.js';

const noticeId = 'a'.repeat(32);
function fixture(overrides: Partial<StructuredNoticeDeliveryInput> = {}) {
  const session = overrides.session ?? ({ sessionId: 'session-1', turnNotices: undefined } as unknown as Session);
  const snapshots: Session[] = [];
  const input: StructuredNoticeDeliveryInput = {
    session, noticeId, turnId: 'om_turn', content: 'Open the Web terminal',
    owns: () => true,
    persist: vi.fn(() => { snapshots.push(structuredClone(session)); }),
    retireCard: vi.fn(async () => true),
    deliverPending: vi.fn(async () => {}),
    acknowledge: vi.fn(),
    onEnqueued: vi.fn(),
    onCardError: vi.fn(),
    ...overrides,
  };
  return { session, snapshots, input };
}

describe('durable structured notice delivery', () => {
  it('persists before the card effect and only re-ACKs after an unknown ACK result', async () => {
    const { session, snapshots, input } = fixture();
    await deliverStructuredNotice(input);
    expect(snapshots).toHaveLength(2);
    expect(input.retireCard).toHaveBeenCalledOnce();
    expect(input.deliverPending).not.toHaveBeenCalled();
    expect(input.acknowledge).toHaveBeenCalledOnce();
    expect(input.onEnqueued).toHaveBeenCalledOnce();
    expect(session.turnNotices?.[0]).toMatchObject({
      turnId: 'om_turn', content: 'Open the Web terminal',
      delivery: { uuid: noticeId, state: 'delivered', attempts: 1 },
    });

    // The first ACK can be lost after the provider/card effect. Replay must not
    // create another durable record or repeat that effect.
    await deliverStructuredNotice(input);
    expect(input.retireCard).toHaveBeenCalledOnce();
    expect(input.deliverPending).not.toHaveBeenCalled();
    expect(input.acknowledge).toHaveBeenCalledTimes(2);
    expect(input.onEnqueued).toHaveBeenCalledOnce();
    expect(session.turnNotices).toHaveLength(1);
  });

  it('hands a legacy notice to the existing outbox and resumes the same durable UUID after restart', async () => {
    const { session, snapshots, input } = fixture({ retireCard: vi.fn(async () => false) });
    await deliverStructuredNotice(input);
    expect(input.deliverPending).toHaveBeenCalledWith(noticeId);
    expect(input.acknowledge).toHaveBeenCalledOnce();
    expect(input.onEnqueued).toHaveBeenCalledOnce();
    expect(session.turnNotices?.[0]?.delivery.state).toBe('pending');

    const restarted = structuredClone(snapshots.at(-1)!);
    const delivered = fixture({
      session: restarted,
      retireCard: vi.fn(async () => false),
      deliverPending: vi.fn(async id => {
        const row = restarted.turnNotices!.find(entry => entry.delivery.uuid === id)!;
        row.delivery.state = 'delivered';
        row.delivery.attempts += 1;
        restarted.turnNotices = [...restarted.turnNotices!];
      }),
    });
    await deliverStructuredNotice(delivered.input);
    expect(delivered.input.onEnqueued).not.toHaveBeenCalled();
    expect(restarted.turnNotices).toHaveLength(1);
    expect(restarted.turnNotices?.[0]?.delivery).toMatchObject({ uuid: noticeId, state: 'delivered' });
    expect(delivered.input.acknowledge).toHaveBeenCalledOnce();
  });

  it('does not run any UI effect when the initial durable write fails', async () => {
    const { session, input } = fixture({ persist: vi.fn(() => { throw new Error('disk full'); }) });
    await expect(deliverStructuredNotice(input)).rejects.toThrow('disk full');
    expect(session.turnNotices).toBeUndefined();
    expect(input.retireCard).not.toHaveBeenCalled();
    expect(input.deliverPending).not.toHaveBeenCalled();
    expect(input.acknowledge).not.toHaveBeenCalled();
    expect(input.onEnqueued).not.toHaveBeenCalled();
  });

  it('does not fall back to text when persisting a successful card result fails', async () => {
    let writes = 0;
    let durablePending: Session | undefined;
    const { session, input } = fixture({
      persist: vi.fn(() => {
        if (++writes === 2) throw new Error('delivered-state write failed');
        durablePending = structuredClone(session);
      }),
    });
    await expect(deliverStructuredNotice(input)).rejects.toThrow('delivered-state write failed');
    expect(input.retireCard).toHaveBeenCalledOnce();
    expect(input.deliverPending).not.toHaveBeenCalled();
    expect(input.acknowledge).not.toHaveBeenCalled();
    expect(durablePending?.turnNotices?.[0]?.delivery.state).toBe('pending');
    expect(session.turnNotices?.[0]).toMatchObject({ carrier: 'card' });
    expect(session.turnNotices?.[0]?.delivery.state).toBe('pending');

    // Restart from the actual durable pending row. Replaying the same card PATCH
    // is idempotent; the text outbox must stay unused and exactly one ACK goes out.
    const restarted = structuredClone(durablePending!);
    const retry = fixture({ session: restarted });
    await deliverStructuredNotice(retry.input);
    expect(retry.input.retireCard).toHaveBeenCalledOnce();
    expect(retry.input.deliverPending).not.toHaveBeenCalled();
    expect(retry.input.acknowledge).toHaveBeenCalledOnce();
    expect(restarted.turnNotices?.[0]?.delivery.state).toBe('delivered');
  });

  it('retains delivered dedupe tombstones when successor notices arrive', async () => {
    const first = fixture();
    await deliverStructuredNotice(first.input);
    const successor = fixture({ session: first.session, noticeId: 'b'.repeat(32) });
    await deliverStructuredNotice(successor.input);
    expect(first.session.turnNotices).toHaveLength(2);
    expect(first.session.turnNotices?.map(row => row.delivery.uuid)).toEqual([noticeId, 'b'.repeat(32)]);

    await deliverStructuredNotice(first.input);
    expect(first.input.retireCard).toHaveBeenCalledOnce();
    expect(first.input.acknowledge).toHaveBeenCalledTimes(2);
  });

  it('does not evict an ACKed pending notice when ten successors need the daemon outbox', async () => {
    const first = fixture({ retireCard: vi.fn(async () => false) });
    await deliverStructuredNotice(first.input);
    for (let i = 1; i <= 10; i++) {
      const successor = fixture({
        session: first.session, noticeId: i.toString(16).padStart(32, '0'),
        turnId: `om_successor_${i}`, retireCard: vi.fn(async () => false),
      });
      await deliverStructuredNotice(successor.input);
    }
    expect(first.session.turnNotices).toHaveLength(11);
    expect(first.session.turnNotices?.find(row => row.delivery.uuid === noticeId)?.delivery.state).toBe('pending');

    await deliverStructuredNotice(first.input);
    expect(first.input.deliverPending).toHaveBeenCalledWith(noticeId);
    expect(first.session.turnNotices?.find(row => row.delivery.uuid === noticeId)?.delivery.state).toBe('pending');
  });

  it('keeps an unknown card effect on the same carrier and withholds ACK until replay succeeds', async () => {
    const first = fixture({ retireCard: vi.fn(async () => { throw new StructuredNoticeCardPendingError(); }) });
    await expect(deliverStructuredNotice(first.input)).rejects.toThrow('structured_notice_card_effect_pending');
    expect(first.input.deliverPending).not.toHaveBeenCalled();
    expect(first.input.acknowledge).not.toHaveBeenCalled();
    expect(first.session.turnNotices?.[0]?.delivery.state).toBe('pending');

    const retry = fixture({ session: first.session });
    await deliverStructuredNotice(retry.input);
    expect(retry.input.retireCard).toHaveBeenCalledOnce();
    expect(retry.input.deliverPending).not.toHaveBeenCalled();
    expect(retry.input.acknowledge).toHaveBeenCalledOnce();
    expect(first.session.turnNotices?.[0]?.delivery.state).toBe('delivered');
  });

  it('settles a silent legacy display without invoking a text outbox', async () => {
    const silent = fixture({ allowTextFallback: false, retireCard: vi.fn(async () => false) });
    await deliverStructuredNotice(silent.input);
    expect(silent.input.deliverPending).not.toHaveBeenCalled();
    expect(silent.input.acknowledge).toHaveBeenCalledOnce();
    expect(silent.session.turnNotices?.[0]?.delivery.state).toBe('delivered');
  });

  it('reclaims settled tombstones after the coordinated recovery lifetime', async () => {
    const first = fixture({ now: () => 0 });
    await deliverStructuredNotice(first.input);
    for (let i = 1; i < 32; i++) {
      const settled = fixture({
        session: first.session, noticeId: i.toString(16).padStart(32, '0'),
        turnId: `om_settled_${i}`, now: () => 0,
      });
      await deliverStructuredNotice(settled.input);
    }
    expect(first.session.turnNotices).toHaveLength(32);

    const fresh = fixture({
      session: first.session, noticeId: 'f'.repeat(32), turnId: 'om_fresh',
      now: () => 2 * 24 * 60 * 60 * 1000,
    });
    await expect(deliverStructuredNotice(fresh.input)).resolves.toBeUndefined();
    expect(fresh.input.retireCard).toHaveBeenCalledOnce();
    expect(fresh.input.acknowledge).toHaveBeenCalledOnce();
    expect(fresh.session.turnNotices).toHaveLength(1);
    expect(fresh.session.turnNotices?.[0]?.delivery.uuid).toBe('f'.repeat(32));
  });

  it.each([false, true])('never resumes a pending %s card as text after restart', async silent => {
    const first = fixture({
      allowTextFallback: silent ? false : undefined,
      retireCard: vi.fn(async () => { throw new StructuredNoticeCardPendingError(); }),
    });
    await expect(deliverStructuredNotice(first.input)).rejects.toThrow('structured_notice_card_effect_pending');
    const restarted = structuredClone(first.snapshots[0]!);
    expect(restarted.turnNotices?.[0]?.carrier).toBe(silent ? 'silent' : 'card');
    const posted = vi.fn();
    const scheduled: Array<() => void> = [];
    const outbox = new RecoveryNoticeOutbox<() => void, TurnNoticeRecord>({
      schedule: (_delay, run) => { scheduled.push(run); return run; }, cancel: () => {}, now: () => 1_000,
    });
    const host = {
      key: restarted.sessionId,
      list: () => restarted.turnNotices ?? [],
      update: (_id: string, mutate: (row: TurnNoticeRecord) => void) => {
        const row = restarted.turnNotices?.[0]; if (row) mutate(row); return row;
      },
      send: posted, canDeliver: () => true,
    };
    outbox.resume(host);
    expect(scheduled).toEqual([]);
    expect(posted).not.toHaveBeenCalled();

    const replay = fixture({ session: restarted });
    await deliverStructuredNotice(replay.input);
    expect(replay.input.retireCard).toHaveBeenCalledOnce();
    expect(replay.input.acknowledge).toHaveBeenCalledOnce();
    expect(posted).not.toHaveBeenCalled();
  });

  it('persists the card-to-text transition before text and never reruns a card on text replay', async () => {
    const session = { sessionId: 'text-replay', turnNotices: undefined } as unknown as Session;
    const scheduled: Array<() => void> = [];
    const outbox = new RecoveryNoticeOutbox<() => void, TurnNoticeRecord>({
      schedule: (_delay, run) => { scheduled.push(run); return run; }, cancel: () => {}, now: () => 5_000,
    });
    let textAttempts = 0;
    const persistedCarrierAtText: Array<string | undefined> = [];
    const host = {
      key: session.sessionId,
      list: () => session.turnNotices ?? [],
      update: (_id: string, mutate: (row: TurnNoticeRecord) => void) => {
        const row = session.turnNotices?.[0]; if (row) mutate(row); return row;
      },
      send: vi.fn(async () => {
        persistedCarrierAtText.push(first.snapshots.at(-1)?.turnNotices?.[0]?.carrier);
        textAttempts++;
        if (textAttempts === 1) throw new Error('timeout after provider acceptance');
        return 'om_text';
      }),
      canDeliver: () => true,
    };
    const firstCard = vi.fn(async () => { throw new Error('definite pre-publication failure'); });
    const first = fixture({
      session, retireCard: firstCard,
      deliverPending: id => outbox.deliver(host, id),
      acknowledge: vi.fn(() => { throw new Error('ACK result unknown'); }),
    });
    await expect(deliverStructuredNotice(first.input)).rejects.toThrow('ACK result unknown');
    expect(session.turnNotices?.[0]).toMatchObject({ carrier: 'text' });
    expect(persistedCarrierAtText).toEqual(['text']);
    expect(textAttempts).toBe(1);

    const replayCard = vi.fn(async () => true);
    const replay = fixture({
      session, retireCard: replayCard, deliverPending: id => outbox.deliver(host, id),
      acknowledge: vi.fn(),
    });
    await deliverStructuredNotice(replay.input);
    expect(firstCard).toHaveBeenCalledOnce();
    expect(replayCard).not.toHaveBeenCalled();
    expect(textAttempts).toBe(2);
    expect(replay.input.acknowledge).toHaveBeenCalledOnce();
    expect(session.turnNotices?.[0]?.delivery.state).toBe('delivered');
  });

  it.each(['reject', 'resolve'] as const)('does not change carrier or settle after losing ownership during card %s', async outcome => {
    let owned = true;
    const first = fixture({
      owns: () => owned,
      retireCard: vi.fn(async () => {
        owned = false;
        if (outcome === 'reject') throw new Error('ownership changed during card update');
        return true;
      }),
    });
    await deliverStructuredNotice(first.input);
    expect(first.input.deliverPending).not.toHaveBeenCalled();
    expect(first.input.acknowledge).not.toHaveBeenCalled();
    expect(first.input.onCardError).not.toHaveBeenCalled();
    expect(first.session.turnNotices?.[0]).toMatchObject({ carrier: 'card' });
    expect(first.session.turnNotices?.[0]?.delivery.state).toBe('pending');
  });

  it.each(['silent', 'pending'] as const)('withholds error handling and settlement when ownership is lost during a %s card failure', async kind => {
    let owned = true;
    const error = kind === 'pending' ? new StructuredNoticeCardPendingError() : new Error('silent PATCH failed');
    const first = fixture({
      owns: () => owned,
      allowTextFallback: kind === 'silent' ? false : undefined,
      retireCard: vi.fn(async () => { owned = false; throw error; }),
    });
    await expect(deliverStructuredNotice(first.input)).resolves.toBeUndefined();
    expect(first.input.onCardError).not.toHaveBeenCalled();
    expect(first.input.deliverPending).not.toHaveBeenCalled();
    expect(first.input.acknowledge).not.toHaveBeenCalled();
    expect(first.session.turnNotices?.[0]).toMatchObject({
      carrier: kind === 'silent' ? 'silent' : 'card', delivery: { state: 'pending' },
    });
  });

  it('rolls back an in-memory carrier transition when its durable write fails', async () => {
    let writes = 0;
    const first = fixture({
      retireCard: vi.fn(async () => false),
      persist: vi.fn(() => { if (++writes === 2) throw new Error('carrier write failed'); }),
    });
    await expect(deliverStructuredNotice(first.input)).rejects.toThrow('carrier write failed');
    expect(first.input.deliverPending).not.toHaveBeenCalled();
    expect(first.input.acknowledge).not.toHaveBeenCalled();
    expect(first.session.turnNotices?.[0]).toMatchObject({ carrier: 'card' });
    expect(first.session.turnNotices?.[0]?.delivery.state).toBe('pending');
  });

  it('coalesces concurrent duplicate IPC deliveries into one card effect and one ACK', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const { input } = fixture({ retireCard: vi.fn(async () => { await gate; return true; }) });
    const first = deliverStructuredNotice(input);
    const second = deliverStructuredNotice(input);
    release();
    await Promise.all([first, second]);
    expect(input.retireCard).toHaveBeenCalledOnce();
    expect(input.acknowledge).toHaveBeenCalledOnce();
    expect(input.session.turnNotices).toHaveLength(1);
  });
});
