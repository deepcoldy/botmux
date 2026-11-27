/**
 * Lifecycle of a native gateway ask (native gateway core): one delivery receipt per
 * ask across re-sends, never persisted, ended with the exact execution that
 * asked. Real broker, real native gateway dispatcher, real gateway-callback control
 * and a real persist store in a temp dir; only the clock is fake.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _resetForTest,
  listPendingAsks,
  registerAsk,
  registerHostAsk,
  restorePersistedAsks,
  setAskPersistStore,
  setCardDispatcher,
  setNativeGatewayAskLivenessChecker,
} from '../src/core/ask-broker.js';
import { createAskPersistStore, type PersistedAsk } from '../src/core/ask-persist-store.js';
import { confirmNativeGatewayAskDelivered, createNativeGatewayAskDispatcher } from '../src/core/native-gateway-ask-dispatch.js';
import {
  nativeGatewayAskDecision,
  nativeGatewayAskOriginIsLive,
  wireAskCardDelivery,
  nativeGatewayAskSnapshots,
  type NativeGatewayAskLiveSession,
  type NativeGatewayAskOrigin,
} from '../src/core/native-gateway-ask-control.js';
import { AskDispatchError, type AskResult, type CreateAskInput, type PendingAsk } from '../src/core/ask-types.js';
import { logger } from '../src/utils/logger.js';

const APP = 'local_bot';
const CHAT = 'http_async_fixture';
const origin: NativeGatewayAskOrigin = { sessionId: 'session', turnId: 'turn', workerGeneration: 2, dispatchAttempt: 4 };
const questions = [{ prompt: 'Proceed?', multiSelect: false, options: [{ key: 'yes', label: 'Yes' }, { key: 'no', label: 'No' }] }];
/** Comfortably longer than any sweep interval, far shorter than the ask deadline. */
const WELL_WITHIN_DEADLINE_MS = 30_000;
/** How soon an ask must end once its execution really ended. */
const ENDS_WITHIN_MS = 10_000;
const ASK_TIMEOUT_MS = 600_000;

function hookInput(overrides: Partial<CreateAskInput> = {}): CreateAskInput {
  return {
    larkAppId: APP, chatId: CHAT, sessionId: origin.sessionId, rootMessageId: null, questions,
    timeoutMs: ASK_TIMEOUT_MS, requestId: 'hook-req-1', originKind: 'hook', backendSurvivesRestart: true,
    nativeGatewayOrigin: { turnId: origin.turnId, workerGeneration: origin.workerGeneration, dispatchAttempt: origin.dispatchAttempt },
    ...overrides,
  };
}

const roots: string[] = [];
function tempStoreDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'native-gateway-ask-lifecycle-'));
  roots.push(dir);
  return dir;
}

const flush = () => vi.advanceTimersByTimeAsync(1);

function deliver(ask: PendingAsk, current: NativeGatewayAskOrigin = origin): string {
  return nativeGatewayAskDecision(
    { action: 'delivered', askId: ask.askId, nonce: ask.nonce, origin: current, messageId: `card-${ask.askId}` },
    current, APP, CHAT,
  );
}

function answerYes(ask: PendingAsk, current: NativeGatewayAskOrigin = origin): string {
  const toggled = nativeGatewayAskDecision(
    { action: 'toggle', askId: ask.askId, nonce: ask.nonce, by: 'alice', origin: current, questionIndex: 0, key: 'yes' },
    current, APP, CHAT,
  );
  if (toggled !== 'toggled') return toggled;
  return nativeGatewayAskDecision({ action: 'submit', askId: ask.askId, nonce: ask.nonce, by: 'alice', origin: current }, current, APP, CHAT);
}

async function stillWaiting(result: Promise<AskResult>): Promise<AskResult | 'still-waiting'> {
  return Promise.race([result, flush().then(() => 'still-waiting' as const)]);
}

beforeEach(() => {
  vi.useFakeTimers();
  _resetForTest();
  setCardDispatcher(createNativeGatewayAskDispatcher());
});

afterEach(() => {
  _resetForTest();
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('re-sending an ask joins its delivery in flight', () => {
  it('a hook that reconnects before the gateway confirms delivery keeps the same ask, and it resolves once answered', async () => {
    const firstConnection = new AbortController();
    const first = registerAsk(hookInput(), firstConnection.signal);
    await flush();
    const [asked] = listPendingAsks();
    firstConnection.abort();
    await expect(first).resolves.toMatchObject({ kind: 'invalidated' });

    // The reconnect re-sends the card that was never confirmed.
    const reconnected = registerAsk(hookInput());
    await flush();
    expect(listPendingAsks().map(ask => ask.askId)).toEqual([asked!.askId]);

    expect(deliver(asked!)).toBe('accepted');
    await flush();
    expect(answerYes(asked!)).toBe('accepted');
    await expect(reconnected).resolves.toMatchObject({ kind: 'answered', by: 'alice', answers: [['yes']] });
  });

  it('every send of one ask observes the single delivery confirmation', async () => {
    const dispatcher = createNativeGatewayAskDispatcher();
    const ask = { askId: 'ask-1', nonce: 'nonce-1', nativeGatewayOrigin: hookInput().nativeGatewayOrigin } as PendingAsk;
    const firstSend = dispatcher.send(ask);
    const secondSend = dispatcher.send(ask);
    expect(confirmNativeGatewayAskDelivered('ask-1', 'nonce-1', 'card-1')).toBe(true);
    await expect(firstSend).resolves.toEqual({ messageId: 'card-1' });
    await expect(secondSend).resolves.toEqual({ messageId: 'card-1' });
  });
});

describe('the delivery receipt', () => {
  it('ends an ask whose delivery is never confirmed, and refuses a late receipt or answer', async () => {
    const deliveryWindowMs = 5_000;
    setCardDispatcher(createNativeGatewayAskDispatcher(deliveryWindowMs));
    const result = registerAsk(hookInput());
    await flush();
    const [ask] = listPendingAsks();
    await vi.advanceTimersByTimeAsync(deliveryWindowMs);
    await expect(result).resolves.toMatchObject({ kind: 'invalidated', failureCode: 'card_delivery_failed' });
    expect(deliver(ask!)).toBe('stale');
    expect(answerYes(ask!)).toBe('stale');
  });

  it('is released when its ask settles, so the pending send ends at once', async () => {
    const dispatcher = createNativeGatewayAskDispatcher();
    const ask = { askId: 'ask-2', nonce: 'nonce-2', nativeGatewayOrigin: hookInput().nativeGatewayOrigin } as PendingAsk;
    const send = dispatcher.send(ask);
    const outcome = send.then(() => 'delivered', () => 'released');
    await dispatcher.onSettle!(ask, { kind: 'timedOut', selected: null, by: null, comment: null, timedOut: true });
    await expect(outcome).resolves.toBe('released');
    expect(confirmNativeGatewayAskDelivered('ask-2', 'nonce-2', 'card-2')).toBe(false);
  });

  it('an answer that arrives before the delivery confirmation settles the ask without reporting a delivery failure', async () => {
    const warn = vi.spyOn(logger, 'warn');
    const result = registerAsk(hookInput());
    await flush();
    const [ask] = listPendingAsks();
    expect(answerYes(ask!)).toBe('accepted');
    await expect(result).resolves.toMatchObject({ kind: 'answered', by: 'alice' });
    await flush();
    expect(warn).not.toHaveBeenCalled();
  });

  it('a failure the dispatcher did not release for settlement is still recorded as a delivery failure (as for Lark)', async () => {
    // Same race on a dispatcher that never marks its failures: the ask times
    // out while the card send is in flight, then the send fails.
    let failSend!: (error: Error) => void;
    setCardDispatcher({ send: () => new Promise((_resolve, reject) => { failSend = reject; }) });
    const warn = vi.spyOn(logger, 'warn');
    const { nativeGatewayOrigin: _origin, ...larkInput } = hookInput({ timeoutMs: 1_000 });
    const result = registerAsk(larkInput);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(result).resolves.toMatchObject({ kind: 'timedOut' });
    failSend(new AskDispatchError('card rejected', false));
    await flush();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('a native gateway ask is never persisted', () => {
  it('is not written to the durable store, while the same ask without a native gateway origin is', async () => {
    const store = createAskPersistStore(tempStoreDir());
    setAskPersistStore(store);
    void registerAsk(hookInput(), new AbortController().signal);
    await flush();
    const [ask] = listPendingAsks();
    expect(deliver(ask!)).toBe('accepted');
    await flush();
    expect(store.list()).toEqual([]);

    // The same ask on a Lark daemon (its own card dispatcher).
    setCardDispatcher({ send: async () => ({ messageId: 'om_card' }) });
    const { nativeGatewayOrigin: _origin, ...larkInput } = hookInput({ requestId: 'lark-req' });
    void registerAsk(larkInput, new AbortController().signal);
    await flush();
    expect(store.list().map(record => record.requestId)).toEqual(['lark-req']);
  });

  it('a host-owned explicit native gateway ask stays off disk through settlement too', async () => {
    const store = createAskPersistStore(tempStoreDir());
    setAskPersistStore(store);
    const result = registerHostAsk(hookInput({ originKind: 'host_explicit', requestId: 'explicit-req' }));
    await flush();
    const [ask] = listPendingAsks();
    expect(deliver(ask!)).toBe('accepted');
    await flush();
    expect(answerYes(ask!)).toBe('accepted');
    await expect(result).resolves.toMatchObject({ kind: 'answered' });
    expect(store.list()).toEqual([]);
  });

  // A record an earlier build left on disk with its native gateway execution
  // must not come back as a card ask.
  it('a record carrying `nativeGatewayOrigin` is discarded on restore, never revived as a card ask', () => {
    const store = createAskPersistStore(tempStoreDir());
    const now = Date.now();
    const record = (requestId: string): PersistedAsk => ({
      v: 2, askKey: `key-${requestId}`, requestId, originKind: 'hook', askId: `ask-${requestId}`, nonce: 'n',
      larkAppId: APP, chatId: CHAT, rootMessageId: null, sessionId: origin.sessionId, questions,
      createdAt: now, deadlineAt: now + ASK_TIMEOUT_MS, timeoutMs: ASK_TIMEOUT_MS, cardMessageId: 'card', selections: [[]],
    });
    store.put({ ...record('native'), nativeGatewayOrigin: { turnId: 'turn', workerGeneration: 2 } } as PersistedAsk);
    store.put(record('ordinary'));
    setAskPersistStore(store);

    expect(restorePersistedAsks(now, APP)).toBe(1);
    expect(listPendingAsks().map(ask => ask.askId)).toEqual(['ask-ordinary']);
    expect(store.list().map(entry => entry.requestId)).toEqual(['ordinary']);
  });

  it('after a daemon restart nothing is restored, and the still-waiting caller is told its turn ended', async () => {
    const dir = tempStoreDir();
    setAskPersistStore(createAskPersistStore(dir));
    void registerAsk(hookInput(), new AbortController().signal);
    await flush();
    const [ask] = listPendingAsks();
    expect(deliver(ask!)).toBe('accepted');
    await flush();

    // Restart: every module-level state is rebuilt; only the store directory survives.
    vi.resetModules();
    const broker = await import('../src/core/ask-broker.js');
    const dispatch = await import('../src/core/native-gateway-ask-dispatch.js');
    const store = await import('../src/core/ask-persist-store.js');
    broker.setCardDispatcher(dispatch.createNativeGatewayAskDispatcher());
    broker.setAskPersistStore(store.createAskPersistStore(dir));
    try {
      expect(broker.restorePersistedAsks(Date.now(), APP)).toBe(0);
      // The restored session has no live turn: HTTP turns do not survive a restart.
      const route = dispatch.resolveAskDeliveryRoute({
        nativeGatewayCore: true, larkTransport: false, turnOrigin: undefined, workerGeneration: 3,
        claimedTurnId: origin.turnId,
      });
      expect(route).toMatchObject({ kind: 'ended', result: { kind: 'invalidated', failureCode: 'execution_ended' } });
    } finally {
      broker._resetForTest();
    }
  });
});

describe('a native gateway ask ends with the execution that asked', () => {
  function liveSession(): NativeGatewayAskLiveSession {
    return {
      workerGeneration: origin.workerGeneration,
      asyncTriggerResults: new Map([[origin.turnId, { status: 'pending' }]]),
      activeInteractiveTurn: { turnId: origin.turnId },
      managedTurnOrigin: { capability: 'cap', turnId: origin.turnId, dispatchAttempt: origin.dispatchAttempt },
    } as unknown as NativeGatewayAskLiveSession;
  }

  /** Mirrors the daemon wiring: look the ask's session up among live sessions. */
  function wireLiveness(sessions: Map<string, NativeGatewayAskLiveSession>): void {
    setNativeGatewayAskLivenessChecker(ask => !!ask.nativeGatewayOrigin
      && nativeGatewayAskOriginIsLive(ask.nativeGatewayOrigin, sessions.get(ask.sessionId)));
  }

  function liveSessions(): { sessions: Map<string, NativeGatewayAskLiveSession>; session: NativeGatewayAskLiveSession } {
    const session = liveSession();
    return { sessions: new Map([[origin.sessionId, session]]), session };
  }

  async function deliveredAsk(): Promise<{ ask: PendingAsk; result: Promise<AskResult> }> {
    const result = registerAsk(hookInput(), new AbortController().signal);
    await flush();
    const [ask] = listPendingAsks();
    expect(deliver(ask!)).toBe('accepted');
    await flush();
    return { ask: ask!, result };
  }

  type Ending = (live: { sessions: Map<string, NativeGatewayAskLiveSession>; session: NativeGatewayAskLiveSession }) => void;
  const endings: Array<[string, Ending]> = [
    ['its worker generation is replaced', ({ session }) => { session.workerGeneration = origin.workerGeneration + 1; }],
    ['its turn finishes', ({ session }) => { session.asyncTriggerResults!.set(origin.turnId, { status: 'completed' } as never); }],
    ['its dispatch attempt is superseded', ({ session }) => {
      session.managedTurnOrigin = { capability: 'cap', turnId: origin.turnId, dispatchAttempt: origin.dispatchAttempt! + 1 };
    }],
    ['its session is closed', ({ sessions }) => { sessions.delete(origin.sessionId); }],
    ['the live managed origin moves to another turn under the same attempt number', ({ session }) => {
      session.managedTurnOrigin = { capability: 'cap', turnId: 'turn-next', dispatchAttempt: origin.dispatchAttempt };
    }],
  ];

  for (const [when, end] of endings) {
    it(`is invalidated when ${when}, and a late receipt or answer is refused`, async () => {
      const live = liveSessions();
      wireLiveness(live.sessions);
      const { ask, result } = await deliveredAsk();
      // The execution stays live for a while first: the check keeps running.
      await vi.advanceTimersByTimeAsync(WELL_WITHIN_DEADLINE_MS);
      await expect(stillWaiting(result)).resolves.toBe('still-waiting');
      end(live);
      await vi.advanceTimersByTimeAsync(ENDS_WITHIN_MS);
      await expect(stillWaiting(result)).resolves.toMatchObject({ kind: 'invalidated', failureCode: 'execution_ended' });
      expect(nativeGatewayAskSnapshots(origin, APP, CHAT)).toEqual([]);
      expect(deliver(ask)).toBe('stale');
      expect(answerYes(ask)).toBe('stale');
    });
  }

  it('survives a momentary loss of liveness between two checks (a same-turn origin revoke, then its republication)', async () => {
    const { sessions, session } = liveSessions();
    const liveOrigin = session.managedTurnOrigin;
    let revokedAndSeen = false;
    setNativeGatewayAskLivenessChecker(ask => {
      const isLive = !!ask.nativeGatewayOrigin && nativeGatewayAskOriginIsLive(ask.nativeGatewayOrigin, sessions.get(ask.sessionId));
      if (!isLive && !revokedAndSeen) {
        revokedAndSeen = true;
        session.managedTurnOrigin = { ...liveOrigin!, capability: 'cap-republished' };
      }
      return isLive;
    });
    const { ask, result } = await deliveredAsk();
    session.managedTurnOrigin = { capability: 'cap-rotated' };
    await vi.advanceTimersByTimeAsync(WELL_WITHIN_DEADLINE_MS);
    expect(revokedAndSeen).toBe(true);
    await expect(stillWaiting(result)).resolves.toBe('still-waiting');
    expect(answerYes(ask)).toBe('accepted');
  });

  it('stays pending and answerable while its execution is live', async () => {
    wireLiveness(liveSessions().sessions);
    const { ask, result } = await deliveredAsk();
    await vi.advanceTimersByTimeAsync(WELL_WITHIN_DEADLINE_MS);
    await expect(stillWaiting(result)).resolves.toBe('still-waiting');
    expect(answerYes(ask)).toBe('accepted');
    await expect(result).resolves.toMatchObject({ kind: 'answered', by: 'alice' });
  });

  it('a hook that reconnects after its execution ended gets the terminal result instead of a live ask', async () => {
    const { sessions, session } = liveSessions();
    wireLiveness(sessions);
    const connection = new AbortController();
    void registerAsk(hookInput(), connection.signal);
    await flush();
    const [ask] = listPendingAsks();
    expect(deliver(ask!)).toBe('accepted');
    await flush();
    connection.abort();
    session.workerGeneration = origin.workerGeneration + 1;
    await vi.advanceTimersByTimeAsync(WELL_WITHIN_DEADLINE_MS);

    await expect(stillWaiting(registerAsk(hookInput())))
      .resolves.toMatchObject({ kind: 'invalidated', failureCode: 'execution_ended' });
    expect(listPendingAsks()).toEqual([]);
  });

  it('a reconnect that names a different execution is refused instead of joining the pending ask', async () => {
    const { result } = await deliveredAsk();
    const otherExecution = hookInput({
      nativeGatewayOrigin: { turnId: origin.turnId, workerGeneration: origin.workerGeneration + 1, dispatchAttempt: origin.dispatchAttempt },
    });
    await expect(stillWaiting(registerAsk(otherExecution)))
      .resolves.toMatchObject({ kind: 'invalidated', failureCode: 'execution_ended' });
    await expect(stillWaiting(result)).resolves.toBe('still-waiting');
  });

  it('never touches an ask that was not asked through the gateway', async () => {
    const { sessions } = liveSessions();
    wireLiveness(sessions);
    const gatewayAsk = registerAsk(hookInput(), new AbortController().signal);
    await flush();
    setCardDispatcher({ send: async () => ({ messageId: 'om_card' }) });
    const { nativeGatewayOrigin: _origin, ...larkInput } = hookInput({ requestId: 'lark-req' });
    const lark = registerAsk(larkInput);
    await flush();
    sessions.clear();
    await vi.advanceTimersByTimeAsync(WELL_WITHIN_DEADLINE_MS);
    await expect(stillWaiting(gatewayAsk)).resolves.toMatchObject({ failureCode: 'execution_ended' });
    await expect(stillWaiting(lark)).resolves.toBe('still-waiting');
  });

  it('keeps one periodic check however many asks register, and stops it once none is pending', async () => {
    wireLiveness(liveSessions().sessions);
    const first = registerAsk(hookInput({ requestId: 'one', backendSurvivesRestart: false }));
    const second = registerAsk(hookInput({ requestId: 'two', backendSurvivesRestart: false }));
    await flush();
    for (const ask of listPendingAsks()) expect(deliver(ask)).toBe('accepted');
    await flush();
    for (const ask of listPendingAsks()) expect(answerYes(ask)).toBe('accepted');
    await expect(first).resolves.toMatchObject({ kind: 'answered' });
    await expect(second).resolves.toMatchObject({ kind: 'answered' });
    await vi.advanceTimersByTimeAsync(WELL_WITHIN_DEADLINE_MS);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps an ask whose liveness cannot be decided, reports it once, and still ends it once the check works', async () => {
    const warn = vi.spyOn(logger, 'warn');
    let failing = true;
    const { sessions } = liveSessions();
    setNativeGatewayAskLivenessChecker(ask => {
      if (failing) throw new Error('session table unavailable');
      return !!ask.nativeGatewayOrigin && nativeGatewayAskOriginIsLive(ask.nativeGatewayOrigin, sessions.get(ask.sessionId));
    });
    const { ask, result } = await deliveredAsk();
    await vi.advanceTimersByTimeAsync(WELL_WITHIN_DEADLINE_MS);
    await expect(stillWaiting(result)).resolves.toBe('still-waiting');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(nativeGatewayAskSnapshots(origin, APP, CHAT).map(item => item.ask.askId)).toEqual([ask.askId]);

    failing = false;
    sessions.clear();
    await vi.advanceTimersByTimeAsync(WELL_WITHIN_DEADLINE_MS);
    await expect(stillWaiting(result)).resolves.toMatchObject({ failureCode: 'execution_ended' });
  });
});

describe('an ask the gateway can never see', () => {
  it('fails at once instead of waiting out the delivery window', async () => {
    const { nativeGatewayOrigin: _origin, ...unbound } = hookInput({ requestId: 'unbound' });
    const result = registerAsk(unbound);
    await expect(stillWaiting(result)).resolves.toMatchObject({ kind: 'invalidated', failureCode: 'card_delivery_failed' });
  });
});

describe('a delivery confirmation', () => {
  it('must name the card it delivered', async () => {
    void registerAsk(hookInput());
    await flush();
    const [ask] = listPendingAsks();
    expect(confirmNativeGatewayAskDelivered(ask!.askId, ask!.nonce, '')).toBe(false);
    expect(listPendingAsks()[0]!.cardMessageId).toBeUndefined();
    expect(confirmNativeGatewayAskDelivered(ask!.askId, ask!.nonce, 'card')).toBe(true);
  });
});

describe('daemon wiring of ask delivery', () => {
  it('a native gateway core delivers through the gateway and ends asks with their execution', async () => {
    const larkDispatcher = vi.fn(() => ({ send: async () => ({ messageId: 'om_card' }) }));
    const sessions = new Map([[origin.sessionId, {
      workerGeneration: origin.workerGeneration,
      asyncTriggerResults: new Map([[origin.turnId, { status: 'pending' }]]),
      activeInteractiveTurn: { turnId: origin.turnId },
      managedTurnOrigin: { capability: 'cap', turnId: origin.turnId, dispatchAttempt: origin.dispatchAttempt },
    } as unknown as NativeGatewayAskLiveSession]]);
    wireAskCardDelivery({ nativeGatewayCore: true, larkDispatcher, findSession: id => sessions.get(id) });
    const result = registerAsk(hookInput(), new AbortController().signal);
    await flush();
    const [ask] = listPendingAsks();
    expect(confirmNativeGatewayAskDelivered(ask!.askId, ask!.nonce, 'card')).toBe(true);
    sessions.clear();
    await vi.advanceTimersByTimeAsync(WELL_WITHIN_DEADLINE_MS);
    await expect(stillWaiting(result)).resolves.toMatchObject({ failureCode: 'execution_ended' });
    expect(larkDispatcher).not.toHaveBeenCalled();
  });

  it('every other daemon keeps its Lark card dispatcher and never sweeps', async () => {
    const send = vi.fn(async () => ({ messageId: 'om_card' }));
    wireAskCardDelivery({ nativeGatewayCore: false, larkDispatcher: () => ({ send }), findSession: () => undefined });
    const result = registerAsk(hookInput(), new AbortController().signal);
    await vi.advanceTimersByTimeAsync(WELL_WITHIN_DEADLINE_MS);
    expect(send).toHaveBeenCalledTimes(1);
    await expect(stillWaiting(result)).resolves.toBe('still-waiting');
  });
});
