/**
 * Explicit `botmux ask` receipts on a native gateway core. A native gateway ask is
 * never re-sent and never recovered into a turn the gateway did not start:
 * once its execution ends (or the daemon restarts) the receipt is closed with
 * the same `execution_ended` result the daemon route gives a reconnecting
 * caller. Feishu receipts keep their recovery. Real continuation, real broker
 * and native gateway dispatcher; fake timers for the broker, an injected clock for
 * the continuation.
 */
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _resetForTest,
  explicitAskSnapshot,
  hasExplicitAskHandoff,
  invalidateExplicitAsk,
  listPendingAsks,
  registerHostAsk,
  releaseExplicitAskHandoff,
  restorePersistedAsks,
  retireExplicitAsk,
  setAskPersistStore,
  setCanTalkChecker,
  setCardDispatcher,
  setNativeGatewayAskLivenessChecker,
  submitAsk,
} from '../src/core/ask-broker.js';
import { createAskPersistStore } from '../src/core/ask-persist-store.js';
import { createNativeGatewayAskDispatcher, resolveAskDeliveryRoute } from '../src/core/native-gateway-ask-dispatch.js';
import {
  nativeGatewayAskDecision,
  nativeGatewayAskOriginIsLive,
  type NativeGatewayAskLiveSession,
  type NativeGatewayAskOrigin,
} from '../src/core/native-gateway-ask-control.js';
import { createExplicitAskContinuation, type ExplicitAskReceipt } from '../src/core/explicit-ask-continuation.js';
import type { AskResult, CreateAskInput } from '../src/core/ask-types.js';

const APP = 'app';
const CHAT = 'http_async_fixture';
const origin: NativeGatewayAskOrigin = { sessionId: 'session', turnId: 'turn', workerGeneration: 2, dispatchAttempt: 4 };
const questions = [{ prompt: 'Release?', multiSelect: false, options: [{ key: 'yes', label: 'Yes' }, { key: 'no', label: 'No' }] }];
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

const larkInput = {
  larkAppId: APP, chatId: 'oc_chat', rootMessageId: null, sessionId: origin.sessionId, requestId: 'request',
  originKind: 'host_explicit', timeoutMs: 600_000, questions,
} satisfies CreateAskInput & { requestId: string };
const nativeGatewayInput = {
  ...larkInput,
  chatId: CHAT,
  nativeGatewayOrigin: { turnId: origin.turnId, workerGeneration: origin.workerGeneration, dispatchAttempt: origin.dispatchAttempt },
} satisfies CreateAskInput & { requestId: string };
const receiptOrigin = { turnId: origin.turnId, dispatchAttempt: origin.dispatchAttempt, workerGeneration: origin.workerGeneration };

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'native-gateway-explicit-receipt-'));
  dirs.push(dir);
  return dir;
}

/** One daemon lifetime: broker wiring plus a continuation over the shared dirs. */
function daemon(dirs: { receipts: string; asks: string }, options: { canResume?: boolean; dispatcher?: 'native_gateway' | 'lark' } = {}) {
  setAskPersistStore(createAskPersistStore(dirs.asks));
  if (options.dispatcher === 'lark') {
    setCanTalkChecker(() => true);
    setCardDispatcher({ send: async () => ({ messageId: 'om_card' }) });
  } else {
    setCardDispatcher(createNativeGatewayAskDispatcher());
  }
  const clock = { now: 1_000_000 };
  const register = vi.fn((input: CreateAskInput) => registerHostAsk(input));
  const dispatch = vi.fn(async () => true);
  const onError = vi.fn();
  const continuation = createExplicitAskContinuation({
    dir: dirs.receipts, appId: APP, register, dispatch, onError,
    canResume: () => options.canResume ?? true,
    releaseHandoff: releaseExplicitAskHandoff, hasHandoff: hasExplicitAskHandoff,
    invalidate: invalidateExplicitAsk, retire: retireExplicitAsk, canRetire: () => true,
    snapshot: explicitAskSnapshot, shouldInvalidate: () => false,
    now: () => clock.now,
  });
  return { continuation, register, dispatch, onError, clock };
}

function onlyReceipt(dir: string): ExplicitAskReceipt {
  const files = readdirSync(dir).filter(name => name.endsWith('.json'));
  expect(files).toHaveLength(1);
  return JSON.parse(readFileSync(join(dir, files[0]!), 'utf8'));
}

function receiptCount(dir: string): number {
  return readdirSync(dir).filter(name => name.endsWith('.json')).length;
}

async function deliverPendingNativeGatewayAsk(): Promise<void> {
  await vi.advanceTimersByTimeAsync(1);
  const [ask] = listPendingAsks();
  expect(nativeGatewayAskDecision(
    { action: 'delivered', askId: ask!.askId, nonce: ask!.nonce, origin, messageId: 'card' }, origin, APP, CHAT,
  )).toBe('accepted');
  await vi.advanceTimersByTimeAsync(1);
}

/** Drop every in-memory owner (broker + continuation); only the dirs survive. */
function restart(): void {
  _resetForTest();
}

const endedByRoute = (): AskResult => {
  const route = resolveAskDeliveryRoute({ nativeGatewayCore: true, larkTransport: false, claimedTurnId: origin.turnId });
  if (route.kind !== 'ended') throw new Error(`expected an ended route, got ${route.kind}`);
  return route.result;
};

beforeEach(() => {
  vi.useFakeTimers();
  _resetForTest();
});

afterEach(() => {
  _resetForTest();
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) {
    chmodSync(dir, 0o700);
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('a native gateway receipt after a daemon restart', () => {
  it('is closed as ended by the sweep: no re-send, no recovery turn, and a reconnect gets the route result', async () => {
    const shared = { receipts: tempDir(), asks: tempDir() };
    const before = daemon(shared);
    void before.continuation.wait(nativeGatewayInput, receiptOrigin);
    await deliverPendingNativeGatewayAsk();

    restart();
    const after = daemon(shared);
    expect(restorePersistedAsks(Date.now(), APP)).toBe(0);
    await after.continuation.sweep();
    after.clock.now += 6_000;
    await after.continuation.sweep();

    expect(onlyReceipt(shared.receipts).result).toEqual(endedByRoute());
    expect(after.register).not.toHaveBeenCalled();
    expect(after.dispatch).not.toHaveBeenCalled();
    expect(listPendingAsks()).toEqual([]);

    // The same CLI call reconnecting — even while a later execution is live.
    await expect(after.continuation.wait(nativeGatewayInput)).resolves.toEqual(endedByRoute());
    const laterExecution = { ...nativeGatewayInput, nativeGatewayOrigin: { ...nativeGatewayInput.nativeGatewayOrigin, workerGeneration: 3 } };
    await expect(after.continuation.wait(laterExecution)).resolves.toEqual(endedByRoute());
    expect(after.register).not.toHaveBeenCalled();
  });

  it('a reconnect that arrives before the first sweep gets the same ended result without re-sending', async () => {
    const shared = { receipts: tempDir(), asks: tempDir() };
    void daemon(shared).continuation.wait(nativeGatewayInput, receiptOrigin);
    await deliverPendingNativeGatewayAsk();

    restart();
    const after = daemon(shared);
    await expect(after.continuation.wait(nativeGatewayInput)).resolves.toEqual(endedByRoute());
    expect(after.register).not.toHaveBeenCalled();
    after.clock.now += 6_000;
    await after.continuation.sweep();
    expect(after.dispatch).not.toHaveBeenCalled();
  });

  it('is closed and later reaped even when its session no longer resumes', async () => {
    const shared = { receipts: tempDir(), asks: tempDir() };
    void daemon(shared).continuation.wait(nativeGatewayInput, receiptOrigin);
    await deliverPendingNativeGatewayAsk();

    restart();
    const after = daemon(shared, { canResume: false });
    await after.continuation.sweep();
    expect(onlyReceipt(shared.receipts).result).toEqual(endedByRoute());
    after.clock.now += SEVEN_DAYS_MS;
    await after.continuation.sweep();
    expect(receiptCount(shared.receipts)).toBe(0);
  });
});

describe('a native gateway receipt whose execution ended while the daemon ran', () => {
  it('is closed with the ended result and never recovered, even when the acknowledgement is not adopted', async () => {
    const shared = { receipts: tempDir(), asks: tempDir() };
    const live = daemon(shared);
    const session = {
      workerGeneration: origin.workerGeneration,
      asyncTriggerResults: new Map([[origin.turnId, { status: 'pending' }]]),
      activeInteractiveTurn: { turnId: origin.turnId },
      managedTurnOrigin: { capability: 'cap', turnId: origin.turnId, dispatchAttempt: origin.dispatchAttempt },
    } as unknown as NativeGatewayAskLiveSession;
    setNativeGatewayAskLivenessChecker(ask => !!ask.nativeGatewayOrigin && nativeGatewayAskOriginIsLive(ask.nativeGatewayOrigin, session));
    const waiting = live.continuation.wait(nativeGatewayInput, receiptOrigin);
    await deliverPendingNativeGatewayAsk();

    session.workerGeneration = origin.workerGeneration + 1;
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(waiting).resolves.toEqual(endedByRoute());
    expect(live.continuation.acknowledge(nativeGatewayInput, () => false)).toEqual(endedByRoute());

    live.clock.now += 6_000;
    await live.continuation.sweep();
    expect(live.dispatch).not.toHaveBeenCalled();
    expect(live.register).toHaveBeenCalledTimes(1);
    expect(onlyReceipt(shared.receipts)).toMatchObject({ result: endedByRoute() });
  });
});

describe('a native gateway receipt while its ask is still running', () => {
  it('is left open by the sweep, so the real answer is what gets recorded', async () => {
    const shared = { receipts: tempDir(), asks: tempDir() };
    const live = daemon(shared);
    const waiting = live.continuation.wait(nativeGatewayInput, receiptOrigin);
    await deliverPendingNativeGatewayAsk();
    live.clock.now += 6_000;
    await live.continuation.sweep();
    expect(onlyReceipt(shared.receipts).result).toBeUndefined();

    const [ask] = listPendingAsks();
    expect(nativeGatewayAskDecision({ action: 'toggle', askId: ask!.askId, nonce: ask!.nonce, origin, by: 'alice', questionIndex: 0, key: 'yes' },
      origin, APP, CHAT)).toBe('toggled');
    expect(nativeGatewayAskDecision({ action: 'submit', askId: ask!.askId, nonce: ask!.nonce, origin, by: 'alice' }, origin, APP, CHAT))
      .toBe('accepted');
    await expect(waiting).resolves.toMatchObject({ kind: 'answered', by: 'alice' });
    expect(onlyReceipt(shared.receipts).result).toMatchObject({ kind: 'answered', by: 'alice' });
  });
});

// Root ignores directory permissions, so the failed write cannot be staged there.
const canFailWrites = process.getuid?.() !== 0;

describe('an explicit ask answered while its receipt could not be written', () => {
  for (const kind of ['native_gateway', 'lark'] as const) {
    it.skipIf(!canFailWrites)(`${kind}: a reconnect after the disk recovers gets the real answer, recorded`, async () => {
      const shared = { receipts: tempDir(), asks: tempDir() };
      const live = daemon(shared, { dispatcher: kind });
      const input = kind === 'native_gateway' ? nativeGatewayInput : larkInput;
      const first = live.continuation.wait(input, receiptOrigin);
      if (kind === 'native_gateway') await deliverPendingNativeGatewayAsk();
      else await vi.advanceTimersByTimeAsync(1);
      const [ask] = listPendingAsks();

      chmodSync(shared.receipts, 0o500); // the result write will fail
      if (kind === 'native_gateway') {
        expect(nativeGatewayAskDecision({ action: 'toggle', askId: ask!.askId, nonce: ask!.nonce, origin, by: 'alice', questionIndex: 0, key: 'yes' },
          origin, APP, CHAT)).toBe('toggled');
        expect(nativeGatewayAskDecision({ action: 'submit', askId: ask!.askId, nonce: ask!.nonce, origin, by: 'alice' }, origin, APP, CHAT))
          .toBe('accepted');
      } else {
        expect(submitAsk({ askId: ask!.askId, nonce: ask!.nonce, by: 'alice', selections: [['yes']] })).toBe('accepted');
      }
      await expect(first).rejects.toMatchObject({ code: 'EACCES' });
      chmodSync(shared.receipts, 0o700);

      await expect(live.continuation.wait(input, receiptOrigin)).resolves.toMatchObject({ kind: 'answered', by: 'alice' });
      expect(onlyReceipt(shared.receipts).result).toMatchObject({ kind: 'answered', by: 'alice' });
    });
  }
});

describe('an answered native gateway receipt after a daemon restart', () => {
  it('once answered, is never recovered into a turn the gateway did not start', async () => {
    const shared = { receipts: tempDir(), asks: tempDir() };
    const live = daemon(shared);
    const waiting = live.continuation.wait(nativeGatewayInput, receiptOrigin);
    await deliverPendingNativeGatewayAsk();
    const [ask] = listPendingAsks();
    expect(nativeGatewayAskDecision({ action: 'toggle', askId: ask!.askId, nonce: ask!.nonce, origin, by: 'alice', questionIndex: 0, key: 'yes' },
      origin, APP, CHAT)).toBe('toggled');
    expect(nativeGatewayAskDecision({ action: 'submit', askId: ask!.askId, nonce: ask!.nonce, origin, by: 'alice' }, origin, APP, CHAT))
      .toBe('accepted');
    await expect(waiting).resolves.toMatchObject({ kind: 'answered', by: 'alice' });
    restart();

    const after = daemon(shared);
    after.clock.now += 6_000;
    await after.continuation.sweep();

    expect(after.dispatch).not.toHaveBeenCalled();
    expect(onlyReceipt(shared.receipts).result).toMatchObject({ kind: 'answered', by: 'alice' });
  });
});

describe('a Feishu receipt (control)', () => {
  it('whose acknowledgement is not adopted is still recovered into the same session', async () => {
    const shared = { receipts: tempDir(), asks: tempDir() };
    const lark = daemon(shared, { dispatcher: 'lark' });
    const waiting = lark.continuation.wait(larkInput, receiptOrigin);
    await vi.advanceTimersByTimeAsync(1);
    const [ask] = listPendingAsks();
    expect(submitAsk({ askId: ask!.askId, nonce: ask!.nonce, by: 'ou_human', selections: [['yes']] })).toBe('accepted');
    await expect(waiting).resolves.toMatchObject({ kind: 'answered' });
    expect(lark.continuation.acknowledge(larkInput, () => false)).toMatchObject({ kind: 'answered' });

    lark.clock.now += 6_000;
    await lark.continuation.sweep();
    expect(lark.dispatch).toHaveBeenCalledTimes(1);
  });
});
