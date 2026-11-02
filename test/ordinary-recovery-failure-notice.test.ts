/**
 * Ordinary-turn recovery must never end silently (10-31, oncall session
 * ce4daf6f): the real coordinator registry + the real notice outbox, driven by
 * a fake clock and a fake session store, through the shapes that matter:
 *
 *  - retries exhausted → exactly one failure card, recovery state failed;
 *  - the continuation's own terminal is lost (attributed elsewhere) → once the
 *    CLI has been idle past the grace, the state settles failed and the card
 *    goes out — instead of `running` forever (the 10-31 shape);
 *  - Feishu unreachable → the card is retried with backoff and lands once;
 *  - daemon restart → a delivered card is never re-sent, a pending one resumes;
 *  - a pre-upgrade stuck state settled after deployment gets no day-old card.
 *
 * The wiring mirrors worker-pool's enqueueOrdinaryRecoveryNotice: initiator
 * from recoveryNoticeInitiator, record + delivery from
 * recordAndDeliverOrdinaryRecoveryNotice.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  attachOrdinaryTurnRecovery,
  beginOrdinaryTurnRecovery,
  disposeOrdinaryTurnRecovery,
  handleOrdinaryTurnRecoveryTerminal,
  cancelOrdinaryTurnRecoveryForStop,
  noteOrdinaryTurnRecoveryCliIdle,
  requireOrdinaryTurnRecoveryAttention,
  type OrdinaryTurnRecoveryState,
} from '../src/services/ordinary-turn-recovery.js';
import {
  RECOVERY_NOTICE_MAX_AGE_MS,
  RecoveryNoticeOutbox,
  recordAndDeliverOrdinaryRecoveryNotice,
  recoveryNoticeInitiator,
  type OrdinaryRecoveryNoticeRecord,
  type RecoveryNoticeHost,
} from '../src/services/ordinary-recovery-notice.js';

const GRACE_MS = 60_000;
const APP = 'cli_app';
const ASKER = 'ou_asker';
const ENVELOPE_A = '<role>oncall</role>\n<user_message>\n@Bot 私聊回复怎么都放进一个话题？\n</user_message>\n<sender type="user" open_id="ou_asker" />';
const ENVELOPE_B = '<user_message>\n@Bot 可以回答一下吗\n</user_message>';

/** Deterministic timers: `advance` runs every due callback in time order. */
function fakeClock(start = Date.parse('2026-10-31T04:11:30.000Z')) {
  let now = start;
  let seq = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  return {
    now: () => now,
    schedule: (delayMs: number, run: () => void) => {
      const id = ++seq;
      timers.set(id, { at: now + delayMs, run });
      return id;
    },
    cancel: (id: number) => { timers.delete(id); },
    pending: () => timers.size,
    async advance(ms: number) {
      const until = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].run();
        // let async deliveries settle
        for (let i = 0; i < 5; i++) await Promise.resolve();
      }
      now = until;
      for (let i = 0; i < 5; i++) await Promise.resolve();
    },
  };
}

type Clock = ReturnType<typeof fakeClock>;

let seq = 0;
const attached: any[] = [];

/** One daemon process: coordinator registry + outbox over a session object
 *  whose every write is mirrored into `store` (the durable row). */
function daemonProcess(opts: {
  clock: Clock;
  session: any;
  store: { row?: any };
  send: (record: OrdinaryRecoveryNoticeRecord) => Promise<string | undefined>;
  busy?: () => boolean;
  enqueue?: () => boolean;
}) {
  const { clock, session, store } = opts;
  const persist = () => { store.row = structuredClone(session); };
  const outbox = new RecoveryNoticeOutbox<number>({ schedule: clock.schedule, cancel: clock.cancel, now: clock.now });
  const host: RecoveryNoticeHost = {
    key: session.sessionId,
    list: () => session.ordinaryRecoveryNotices ?? [],
    update: (logicalTurnId, mutate) => {
      const record = session.ordinaryRecoveryNotices?.find((r: OrdinaryRecoveryNoticeRecord) => r.logicalTurnId === logicalTurnId);
      if (!record) return undefined;
      mutate(record);
      persist();
      return record;
    },
    send: opts.send,
    canDeliver: () => true,
  };
  const warn = vi.fn((state: OrdinaryTurnRecoveryState) => {
    const initiator = recoveryNoticeInitiator(state, { larkAppId: APP, replyTarget: session.replyTargets?.[state.logicalTurnId] });
    const admittedAt = Date.parse(session.replyTargets?.[state.logicalTurnId]?.updatedAt ?? '');
    recordAndDeliverOrdinaryRecoveryNotice({
      state,
      context: {
        now: clock.now(),
        ...(initiator.openId ? { initiatorOpenId: initiator.openId } : {}),
        ...(initiator.caller ? { retryCaller: initiator.caller } : {}),
        retrySupported: true,
        ...(Number.isFinite(admittedAt) ? { turnAdmittedAt: admittedAt } : {}),
      },
      host,
      outbox,
      saveList: list => { session.ordinaryRecoveryNotices = list; persist(); },
    });
  });
  const enqueue = vi.fn(opts.enqueue ?? (() => true));
  attachOrdinaryTurnRecovery(session, {
    schedule: clock.schedule,
    cancel: clock.cancel,
    persist,
    enqueue,
    warn,
    now: clock.now,
    randomId: () => `c${++seq}`,
    backoffMs: [2_000, 8_000],
    lostContinuationGraceMs: GRACE_MS,
    isCliBusy: opts.busy ?? (() => false),
    ownsQueuedFailure: terminal => terminal.status === 'failed' || terminal.status === 'ambiguous',
  });
  outbox.resume(host);
  attached.push(session);
  return { warn, enqueue, outbox, host };
}

function freshSession(id = `notice-${++seq}`) {
  const updatedAt = '2026-10-31T04:11:30.000Z';
  return {
    sessionId: id,
    turnReplyContexts: {
      om_A: { target: { mode: 'plain', chatId: 'oc_group' }, replyTargetSenderOpenId: ASKER, replyTargetSenderIsBot: false },
    },
    replyTargets: {
      om_A: { updatedAt, senderOpenId: ASKER, participants: [{ openId: ASKER, isBot: false }] },
      om_B: { updatedAt, senderOpenId: ASKER, participants: [{ openId: ASKER, isBot: false }] },
    },
  } as any;
}

const cardsFor = (send: { mock: { calls: unknown[][] } }, turn: string) =>
  send.mock.calls.filter(([record]) => (record as OrdinaryRecoveryNoticeRecord).logicalTurnId === turn);

const askerCaller = { requestUserOpenId: ASKER, requestLarkAppId: APP, senderType: 'user' as const };
const providerFailure = (turnId: string) => ({
  turnId, status: 'failed' as const, errorCode: 'provider_server_error', retryable: true,
});

afterEach(() => {
  for (const session of attached.splice(0)) disposeOrdinaryTurnRecovery(session);
});

describe('retries exhausted', () => {
  it('posts exactly one failure card and lands the recovery state in a failed status', async () => {
    const clock = fakeClock();
    const session = freshSession();
    const store: { row?: any } = {};
    const send = vi.fn(async () => 'om_card');
    const { warn } = daemonProcess({ clock, session, store, send });

    beginOrdinaryTurnRecovery(session, 'om_A', { input: { cliInput: ENVELOPE_A, trustedCaller: askerCaller } });
    handleOrdinaryTurnRecoveryTerminal(session, providerFailure('om_A'));
    await clock.advance(2_000);
    handleOrdinaryTurnRecoveryTerminal(session, providerFailure(session.ordinaryTurnRecovery.currentTurnId));
    await clock.advance(8_000);
    const last = session.ordinaryTurnRecovery.currentTurnId;
    handleOrdinaryTurnRecoveryTerminal(session, providerFailure(last));
    await clock.advance(1);
    // Duplicate terminal and a late attention request for the same turn.
    handleOrdinaryTurnRecoveryTerminal(session, providerFailure(last));
    requireOrdinaryTurnRecoveryAttention(session, last, 'recovery_delivery_failed');
    await clock.advance(10 * 60_000);

    expect(store.row.ordinaryTurnRecovery).toMatchObject({ status: 'exhausted', continuationsStarted: 2 });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
    const record = send.mock.calls[0][0] as OrdinaryRecoveryNoticeRecord;
    expect(record).toMatchObject({
      logicalTurnId: 'om_A',
      initiatorOpenId: ASKER,
      causeErrorCode: 'provider_server_error',
      continuations: 2,
      retry: { cliInput: ENVELOPE_A, trustedCaller: { requestUserOpenId: ASKER } },
    });
    expect(record.task).toContain('私聊回复怎么都放进一个话题');
    expect(store.row.ordinaryRecoveryNotices).toHaveLength(1);
    expect(store.row.ordinaryRecoveryNotices[0].delivery).toMatchObject({ state: 'delivered', messageId: 'om_card' });
  });
});

describe('one notice per logical turn', () => {
  it('a second warn for the same turn (e.g. a lost warning flag) creates no second record or card', async () => {
    const clock = fakeClock();
    const session = freshSession();
    const store: { row?: any } = {};
    const send = vi.fn(async () => 'om_card');
    const { warn } = daemonProcess({ clock, session, store, send });
    const failed: OrdinaryTurnRecoveryState = {
      logicalTurnId: 'om_A', currentTurnId: 'bmx-recovery-x', continuationsStarted: 2,
      status: 'exhausted', lastErrorCode: 'provider_server_error', dispatchedAt: clock.now(),
      retryInputs: { om_A: { cliInput: ENVELOPE_A, trustedCaller: askerCaller } },
    };
    warn(failed);
    warn({ ...failed });
    await clock.advance(60 * 60_000);

    expect(store.row.ordinaryRecoveryNotices).toHaveLength(1);
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe('continuation terminal lost (10-31 shape)', () => {
  /** A failed, a type-ahead B queued behind it, the continuation delivered;
   *  B's terminal arrives (and is forgotten), the continuation's never does. */
  async function driveToLostContinuation(busy?: () => boolean) {
    const clock = fakeClock();
    const session = freshSession();
    const store: { row?: any } = {};
    const send = vi.fn(async () => 'om_card');
    const proc = daemonProcess({ clock, session, store, send, ...(busy ? { busy } : {}) });
    beginOrdinaryTurnRecovery(session, 'om_A', { input: { cliInput: ENVELOPE_A, trustedCaller: askerCaller } });
    beginOrdinaryTurnRecovery(session, 'om_B', { input: { cliInput: ENVELOPE_B, trustedCaller: askerCaller } });
    handleOrdinaryTurnRecoveryTerminal(session, providerFailure('om_A'));
    await clock.advance(2_000);
    const continuation = session.ordinaryTurnRecovery.currentTurnId;
    expect(continuation).toMatch(/^bmx-recovery-/);
    handleOrdinaryTurnRecoveryTerminal(session, providerFailure('om_B'));
    return { clock, session, store, send, continuation, ...proc };
  }

  it('settles failed once the CLI has stayed idle past the grace and sends one card for the original turn', async () => {
    const { clock, session, store, send, warn, continuation } = await driveToLostContinuation();

    noteOrdinaryTurnRecoveryCliIdle(session);
    await clock.advance(GRACE_MS - 1);
    expect(session.ordinaryTurnRecovery).toMatchObject({ status: 'running', currentTurnId: continuation });
    expect(cardsFor(send, 'om_A')).toHaveLength(0);

    await clock.advance(1);
    expect(store.row.ordinaryTurnRecovery).toMatchObject({
      status: 'attention_required',
      lastErrorCode: 'recovery_outcome_unverified',
      causeErrorCode: 'provider_server_error',
      warningDispatched: true,
      failureNoticeOwed: true,
    });
    // One warn for om_A (the other is om_B's own notice, raised earlier).
    expect(warn.mock.calls.filter(([st]) => st.logicalTurnId === 'om_A')).toHaveLength(1);
    expect(cardsFor(send, 'om_A')).toHaveLength(1);
    // The card re-delivers the first question, not the type-ahead follow-up.
    expect(cardsFor(send, 'om_A')[0][0]).toMatchObject({ logicalTurnId: 'om_A', retry: { cliInput: ENVELOPE_A } });

    // Later idle edges / polling do not post again.
    noteOrdinaryTurnRecoveryCliIdle(session);
    await clock.advance(10 * GRACE_MS);
    expect(cardsFor(send, 'om_A')).toHaveLength(1);
  });

  it('leaves a busy CLI alone and keeps checking without needing another idle edge', async () => {
    let busy = true;
    const { clock, session, send, continuation } = await driveToLostContinuation(() => busy);

    noteOrdinaryTurnRecoveryCliIdle(session);
    await clock.advance(3 * GRACE_MS);
    expect(session.ordinaryTurnRecovery).toMatchObject({ status: 'running', currentTurnId: continuation });
    expect(cardsFor(send, 'om_A')).toHaveLength(0);

    // e.g. a usage limit lifts: no new prompt_ready is needed for the check.
    busy = false;
    await clock.advance(GRACE_MS);
    expect(session.ordinaryTurnRecovery.status).toBe('attention_required');
    expect(cardsFor(send, 'om_A')).toHaveLength(1);
  });

  it('a type-ahead follow-up that fails while the earlier recovery is in flight gets its own durable card', async () => {
    const { clock, session, store, send } = await driveToLostContinuation();
    // driveToLostContinuation already delivered om_B's provider failure while
    // the continuation of om_A was in flight.
    await clock.advance(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toMatchObject({
      logicalTurnId: 'om_B',
      errorCode: 'recovery_queued_unrecovered',
      causeErrorCode: 'provider_server_error',
      continuations: 0,
      retry: { cliInput: ENVELOPE_B },
    });
    // The slot keeps recovering om_A; om_B is no longer queued.
    expect(session.ordinaryTurnRecovery).toMatchObject({ logicalTurnId: 'om_A', status: 'running' });
    expect(session.ordinaryTurnRecovery.queuedLogicalTurnIds).toBeUndefined();

    noteOrdinaryTurnRecoveryCliIdle(session);
    await clock.advance(GRACE_MS);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][0]).toMatchObject({ logicalTurnId: 'om_A' });
    expect(store.row.ordinaryRecoveryNotices.map((n: OrdinaryRecoveryNoticeRecord) => n.logicalTurnId)).toEqual(['om_B', 'om_A']);
  });

  it('a user stop cancels the in-flight continuation: no card later', async () => {
    const { clock, session, send } = await driveToLostContinuation();
    await clock.advance(1);
    send.mockClear();

    cancelOrdinaryTurnRecoveryForStop(session);
    noteOrdinaryTurnRecoveryCliIdle(session);
    await clock.advance(10 * GRACE_MS);

    expect(session.ordinaryTurnRecovery).toMatchObject({ status: 'cancelled', cancelledByTurnId: 'stop' });
    expect(send).not.toHaveBeenCalled();
  });

  it('does nothing when the continuation reports its terminal within the grace', async () => {
    const { clock, session, send, continuation } = await driveToLostContinuation();

    noteOrdinaryTurnRecoveryCliIdle(session);
    await clock.advance(5_000);
    handleOrdinaryTurnRecoveryTerminal(session, { turnId: continuation, status: 'completed' });
    await clock.advance(GRACE_MS);

    expect(session.ordinaryTurnRecovery.status).toBe('completed');
    expect(cardsFor(send, 'om_A')).toHaveLength(0);
  });

  it('never fires for a turn that has not been continued', async () => {
    const clock = fakeClock();
    const session = freshSession();
    const send = vi.fn(async () => 'om_card');
    daemonProcess({ clock, session, store: {}, send });
    beginOrdinaryTurnRecovery(session, 'om_A', { input: { cliInput: ENVELOPE_A, trustedCaller: askerCaller } });

    noteOrdinaryTurnRecoveryCliIdle(session);
    await clock.advance(10 * GRACE_MS);

    expect(session.ordinaryTurnRecovery).toMatchObject({ status: 'running', currentTurnId: 'om_A' });
    expect(send).not.toHaveBeenCalled();
  });
});

describe('Feishu unreachable while the card is due', () => {
  it('retries with backoff until Feishu accepts it, then never sends again', async () => {
    const clock = fakeClock();
    const session = freshSession();
    const store: { row?: any } = {};
    let failures = 3;
    const send = vi.fn(async () => {
      if (failures-- > 0) throw new Error('getaddrinfo ENOTFOUND open.feishu.cn');
      return 'om_card';
    });
    daemonProcess({ clock, session, store, send });
    beginOrdinaryTurnRecovery(session, 'om_A', { input: { cliInput: ENVELOPE_A, trustedCaller: askerCaller } });
    handleOrdinaryTurnRecoveryTerminal(session, providerFailure('om_A'));
    await clock.advance(2_000);
    noteOrdinaryTurnRecoveryCliIdle(session);
    await clock.advance(GRACE_MS);

    expect(send).toHaveBeenCalledTimes(1);
    expect(store.row.ordinaryRecoveryNotices[0].delivery).toMatchObject({ state: 'pending', attempts: 1 });

    await clock.advance(60 * 60_000);
    expect(send).toHaveBeenCalledTimes(4);
    expect(store.row.ordinaryRecoveryNotices[0].delivery).toMatchObject({ state: 'delivered', attempts: 4, messageId: 'om_card' });
    // Every attempt reuses one Feishu idempotency key.
    expect(new Set(send.mock.calls.map(([record]) => (record as OrdinaryRecoveryNoticeRecord).delivery.uuid)).size).toBe(1);

    await clock.advance(24 * 60 * 60_000);
    expect(send).toHaveBeenCalledTimes(4);
  });

  async function cardDueWith(send: (record: OrdinaryRecoveryNoticeRecord) => Promise<string | undefined>) {
    const clock = fakeClock();
    const session = freshSession();
    const store: { row?: any } = {};
    daemonProcess({ clock, session, store, send });
    beginOrdinaryTurnRecovery(session, 'om_A', { input: { cliInput: ENVELOPE_A, trustedCaller: askerCaller } });
    handleOrdinaryTurnRecoveryTerminal(session, providerFailure('om_A'));
    await clock.advance(2_000);
    noteOrdinaryTurnRecoveryCliIdle(session);
    await clock.advance(GRACE_MS);
    return { clock, store };
  }

  it('keeps retrying past an hour while sends provably never reach Feishu (DNS)', async () => {
    let outageEnds = Number.POSITIVE_INFINITY;
    let clockRef: Clock | undefined;
    const { clock, store } = await cardDueWith(async () => {
      if (clockRef && clockRef.now() > outageEnds) return 'om_card';
      throw new Error('getaddrinfo ENOTFOUND open.feishu.cn');
    });
    clockRef = clock;
    outageEnds = clock.now() + 90 * 60_000;
    expect(store.row.ordinaryRecoveryNotices[0].delivery.state).toBe('pending');
    await clock.advance(3 * 60 * 60_000);
    expect(store.row.ordinaryRecoveryNotices[0].delivery).toMatchObject({ state: 'delivered', messageId: 'om_card' });
    expect(store.row.ordinaryRecoveryNotices[0].delivery.uncertainSince).toBeUndefined();
  });

  it('after a send whose outcome is unknown, stops retrying once Feishu\'s one-hour de-duplication window is over', async () => {
    let calls = 0;
    const offsets: number[] = [];
    let clockRef: Clock | undefined;
    const { clock, store } = await cardDueWith(async () => {
      calls += 1;
      offsets.push(clockRef ? clockRef.now() : 0);
      if (calls === 1) throw new Error('timeout of 10000ms exceeded');
      throw new Error('getaddrinfo EAI_AGAIN open.feishu.cn');
    });
    clockRef = clock;
    const firstAt = store.row.ordinaryRecoveryNotices[0].delivery.uncertainSince;
    expect(firstAt).toEqual(expect.any(Number));

    await clock.advance(3 * 60 * 60_000);
    const delivery = store.row.ordinaryRecoveryNotices[0].delivery;
    expect(delivery.state).toBe('abandoned');
    // Every retry stayed inside the window that Feishu de-duplicates the uuid in.
    for (const at of offsets.slice(1)) expect(at - firstAt).toBeLessThanOrEqual(55 * 60_000);
  });

  it('gives up (abandoned, logged) once the delivery window has closed', async () => {
    const clock = fakeClock();
    const session = freshSession();
    const store: { row?: any } = {};
    const send = vi.fn(async () => { throw new Error('getaddrinfo ENOTFOUND open.feishu.cn'); });
    daemonProcess({ clock, session, store, send });
    beginOrdinaryTurnRecovery(session, 'om_A', { input: { cliInput: ENVELOPE_A, trustedCaller: askerCaller } });
    handleOrdinaryTurnRecoveryTerminal(session, providerFailure('om_A'));
    await clock.advance(2_000);
    noteOrdinaryTurnRecoveryCliIdle(session);
    await clock.advance(GRACE_MS);

    await clock.advance(RECOVERY_NOTICE_MAX_AGE_MS + 60 * 60_000);
    const attempts = send.mock.calls.length;
    expect(store.row.ordinaryRecoveryNotices[0].delivery.state).toBe('abandoned');
    expect(clock.pending()).toBe(0);
    await clock.advance(24 * 60 * 60_000);
    expect(send).toHaveBeenCalledTimes(attempts);
  });
});

describe('daemon restart', () => {
  /** Kill the process (its timers die with it) and boot a new one from the
   *  durable row only. */
  function restart(store: { row?: any }, send: (record: OrdinaryRecoveryNoticeRecord) => Promise<string | undefined>, at: number) {
    for (const session of attached.splice(0)) disposeOrdinaryTurnRecovery(session);
    const clock = fakeClock(at);
    const session = structuredClone(store.row);
    const proc = daemonProcess({ clock, session, store, send });
    return { clock, session, ...proc };
  }

  it('does not re-send a delivered card, on restore or on later idle edges', async () => {
    const clock = fakeClock();
    const session = freshSession();
    const store: { row?: any } = {};
    const send = vi.fn(async () => 'om_card');
    daemonProcess({ clock, session, store, send });
    beginOrdinaryTurnRecovery(session, 'om_A', { input: { cliInput: ENVELOPE_A, trustedCaller: askerCaller } });
    handleOrdinaryTurnRecoveryTerminal(session, providerFailure('om_A'));
    await clock.advance(2_000);
    noteOrdinaryTurnRecoveryCliIdle(session);
    await clock.advance(GRACE_MS);
    expect(send).toHaveBeenCalledTimes(1);

    const next = restart(store, send, clock.now() + 16 * 60 * 60_000);
    noteOrdinaryTurnRecoveryCliIdle(next.session);
    await next.clock.advance(24 * 60 * 60_000);

    expect(send).toHaveBeenCalledTimes(1);
    expect(next.warn).not.toHaveBeenCalled();
    expect(store.row.ordinaryTurnRecovery.status).toBe('attention_required');
  });

  it('resumes a card that was still pending when the daemon went down, and sends it once', async () => {
    const clock = fakeClock();
    const session = freshSession();
    const store: { row?: any } = {};
    const failing = vi.fn(async () => { throw new Error('getaddrinfo EAI_AGAIN open.feishu.cn'); });
    daemonProcess({ clock, session, store, send: failing });
    beginOrdinaryTurnRecovery(session, 'om_A', { input: { cliInput: ENVELOPE_A, trustedCaller: askerCaller } });
    handleOrdinaryTurnRecoveryTerminal(session, providerFailure('om_A'));
    await clock.advance(2_000);
    noteOrdinaryTurnRecoveryCliIdle(session);
    await clock.advance(GRACE_MS + 5 * 60_000);
    expect(store.row.ordinaryRecoveryNotices[0].delivery.state).toBe('pending');

    const send = vi.fn(async () => 'om_card');
    const next = restart(store, send, clock.now() + 60_000);
    await next.clock.advance(15 * 60_000);

    expect(send).toHaveBeenCalledTimes(1);
    expect(next.warn).not.toHaveBeenCalled();
    expect(store.row.ordinaryRecoveryNotices).toHaveLength(1);
    expect(store.row.ordinaryRecoveryNotices[0].delivery.state).toBe('delivered');
  });
});

describe('pre-upgrade stuck continuation settled after deployment', () => {
  function stuckRow(turnAdmittedAt: string) {
    const session = freshSession();
    session.replyTargets.om_A.updatedAt = turnAdmittedAt;
    // Exactly what the 10-31 session still holds: no dispatchedAt / retryInputs.
    session.ordinaryTurnRecovery = {
      logicalTurnId: 'om_A',
      currentTurnId: 'bmx-recovery-1oq8ky6y9za',
      continuationsStarted: 1,
      status: 'running',
      lastErrorCode: 'provider_server_error',
    };
    return session;
  }

  it('lands the state in failed without a day-old card', async () => {
    const session = stuckRow('2026-10-31T04:11:30.000Z');
    const clock = fakeClock(Date.parse('2026-11-02T08:00:00.000Z'));
    const store: { row?: any } = {};
    const send = vi.fn(async () => 'om_card');
    daemonProcess({ clock, session, store, send });

    noteOrdinaryTurnRecoveryCliIdle(session);
    await clock.advance(GRACE_MS);

    expect(store.row.ordinaryTurnRecovery).toMatchObject({ status: 'attention_required', causeErrorCode: 'provider_server_error' });
    expect(store.row.ordinaryRecoveryNotices[0].delivery.state).toBe('skipped');
    expect(send).not.toHaveBeenCalled();
  });

  it('still posts the card when the stuck turn is recent', async () => {
    const session = stuckRow('2026-11-02T07:30:00.000Z');
    const clock = fakeClock(Date.parse('2026-11-02T08:00:00.000Z'));
    const send = vi.fn(async () => 'om_card');
    daemonProcess({ clock, session, store: {}, send });

    noteOrdinaryTurnRecoveryCliIdle(session);
    await clock.advance(GRACE_MS);

    expect(send).toHaveBeenCalledTimes(1);
    // No frozen input on a pre-upgrade state: the card cannot offer a retry.
    expect((send.mock.calls[0][0] as OrdinaryRecoveryNoticeRecord).retry).toBeUndefined();
  });
});

describe('frozen retry inputs follow the tracked turns', () => {
  it('keeps the inputs of the queue head (the successors that run next), not the tail', async () => {
    const clock = fakeClock();
    const session = freshSession();
    daemonProcess({ clock, session, store: {}, send: vi.fn(async () => 'om_card') });
    beginOrdinaryTurnRecovery(session, 'om_A', { input: { cliInput: ENVELOPE_A, trustedCaller: askerCaller } });
    const queued = Array.from({ length: 10 }, (_, i) => `om_Q${i + 1}`);
    for (const id of queued) {
      beginOrdinaryTurnRecovery(session, id, { input: { cliInput: `<user_message>${id}</user_message>`, trustedCaller: askerCaller } });
    }
    handleOrdinaryTurnRecoveryTerminal(session, { turnId: 'om_A', status: 'completed' });

    expect(session.ordinaryTurnRecovery.logicalTurnId).toBe('om_Q1');
    expect(session.ordinaryTurnRecovery.retryInputs.om_Q1?.cliInput).toContain('om_Q1');
    expect(Object.keys(session.ordinaryTurnRecovery.retryInputs)).toContain('om_Q2');
  });

  it('keeps the input of the turn that owns the slot and drops it once the slot settles', async () => {
    const clock = fakeClock();
    const session = freshSession();
    daemonProcess({ clock, session, store: {}, send: vi.fn(async () => 'om_card') });
    beginOrdinaryTurnRecovery(session, 'om_A', { input: { cliInput: ENVELOPE_A, trustedCaller: askerCaller } });
    beginOrdinaryTurnRecovery(session, 'om_B', { input: { cliInput: ENVELOPE_B, trustedCaller: askerCaller } });
    expect(Object.keys(session.ordinaryTurnRecovery.retryInputs)).toEqual(['om_A', 'om_B']);

    handleOrdinaryTurnRecoveryTerminal(session, { turnId: 'om_A', status: 'completed' });
    expect(session.ordinaryTurnRecovery).toMatchObject({ logicalTurnId: 'om_B', status: 'running' });
    expect(Object.keys(session.ordinaryTurnRecovery.retryInputs)).toEqual(['om_B']);

    handleOrdinaryTurnRecoveryTerminal(session, { turnId: 'om_B', status: 'completed' });
    expect(session.ordinaryTurnRecovery.status).toBe('completed');
    expect(session.ordinaryTurnRecovery.retryInputs).toBeUndefined();
  });
});
