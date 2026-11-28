/**
 * `POST /api/asks` on a native gateway core: runs daemon.ts's real
 * handleAskRequest (as test/ask-chat-scope-turn-target.test.ts does) with the
 * real broker, native gateway dispatcher, gateway-callback control and explicit-ask
 * receipts; only IPC plumbing and Lark-only lookups are replaced. A "restart"
 * rebuilds every in-memory owner over the same receipt / ask directories.
 */
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
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
  retireExplicitAsk,
  setAskPersistStore,
  setCardDispatcher,
  setNativeGatewayAskLivenessChecker,
} from '../src/core/ask-broker.js';
import { createAskPersistStore } from '../src/core/ask-persist-store.js';
import { askResponseBody, parseAskBody, registerAskForResponse, verifiedAskMention } from '../src/core/ask-api.js';
import { codexAsyncAnswerNeedsRawInput, codexAsyncAskOriginEligible } from '../src/services/codex-async-user-input.js';
import { NATIVE_STANDALONE_ASK_ORIGIN } from '../src/core/ask-types.js';
import { authorizeSessionScopedIpc, bindSessionScopedIpcIdentity } from '../src/core/daemon-ipc-session-auth.js';
import { frozenReplyContextForTurn } from '../src/core/reply-target.js';
import { isSilentMessageListenerSession } from '../src/core/message-listener-silence.js';
import { createNativeGatewayAskDispatcher, resolveAskDeliveryRoute } from '../src/core/native-gateway-ask-dispatch.js';
import {
  nativeGatewayAskDecision,
  nativeGatewayAskOriginIsLive,
  nativeGatewayAskSnapshots,
  type NativeGatewayAskLiveSession,
  type NativeGatewayAskOrigin,
} from '../src/core/native-gateway-ask-control.js';
import { createExplicitAskContinuation } from '../src/core/explicit-ask-continuation.js';
import { productionConst } from './helpers/codex-async-answer-function-harness.js';

const APP = 'local_gateway_core';
const CHAT = 'http_async_fixture';
const SESSION = 'sess-gateway';
/** Comfortably longer than any sweep interval, far shorter than the ask deadline. */
const WELL_WITHIN_DEADLINE_MS = 30_000;

type GatewaySession = ReturnType<typeof gatewaySession>;

/** A restored native-core session: `turn` is the gateway turn now live, if any. */
function gatewaySession(turn?: { turnId: string; dispatchAttempt: number }, workerGeneration = 2) {
  return {
    larkAppId: APP, chatId: CHAT, chatType: 'p2p' as const, scope: 'chat' as const,
    session: { sessionId: SESSION, scope: 'chat', chatId: CHAT, rootMessageId: CHAT, status: 'active' } as any,
    worker: { killed: false }, workerGeneration,
    managedTurnOrigin: { capability: 'cap', ...(turn ?? {}) } as Record<string, unknown>,
    asyncTriggerResults: new Map(turn ? [[turn.turnId, { status: 'pending' }]] : []),
    activeInteractiveTurn: turn ? { turnId: turn.turnId } : undefined,
  };
}

function originOf(ds: GatewaySession): NativeGatewayAskOrigin {
  return {
    sessionId: SESSION,
    turnId: ds.managedTurnOrigin.turnId as string,
    workerGeneration: ds.workerGeneration,
    dispatchAttempt: ds.managedTurnOrigin.dispatchAttempt as number | undefined,
  };
}

function hookAsk(extra: Record<string, unknown> = {}) {
  return {
    sessionId: SESSION, chatId: CHAT, larkAppId: APP, rootMessageId: null,
    prompt: 'Proceed?', options: [{ key: 'yes', label: 'Yes' }, { key: 'no', label: 'No' }], timeoutMs: 600_000,
    originKind: 'hook', requestId: 'hook-req', ...extra,
  };
}

const dirs: string[] = [];
let continuation: ReturnType<typeof createExplicitAskContinuation>;
let live: GatewaySession | undefined;

/** One daemon lifetime over shared directories; `session` is what restore found. */
function boot(shared: { receipts: string; asks: string }, session: GatewaySession | undefined): void {
  _resetForTest();
  setAskPersistStore(createAskPersistStore(shared.asks));
  setCardDispatcher(createNativeGatewayAskDispatcher());
  live = session;
  setNativeGatewayAskLivenessChecker(ask => !!ask.nativeGatewayOrigin
    && nativeGatewayAskOriginIsLive(ask.nativeGatewayOrigin, live as unknown as NativeGatewayAskLiveSession | undefined));
  continuation = createExplicitAskContinuation({
    dir: shared.receipts, appId: APP, register: input => registerHostAsk(input), dispatch: vi.fn(async () => true),
    onError: vi.fn(), canResume: () => true, releaseHandoff: releaseExplicitAskHandoff, hasHandoff: hasExplicitAskHandoff,
    invalidate: invalidateExplicitAsk, retire: retireExplicitAsk, canRetire: () => true,
    snapshot: explicitAskSnapshot, shouldInvalidate: () => false,
  });
}

function directories(): { receipts: string; asks: string } {
  const receipts = mkdtempSync(join(tmpdir(), 'native-gateway-ask-request-r-'));
  const asks = mkdtempSync(join(tmpdir(), 'native-gateway-ask-request-a-'));
  dirs.push(receipts, asks);
  return { receipts, asks };
}

function post(body: Record<string, unknown>, options: { replyCardTarget?: unknown } = {}) {
  const ds = live;
  const responses: Array<{ status: number; payload: any }> = [];
  const res = Object.assign(new EventEmitter(), { destroyed: false });
  const handler = productionConst('src/daemon.ts', 'handleAskRequest', {
    readJsonBody: async () => body,
    jsonRes: (_res: unknown, status: number, payload: unknown) => { responses.push({ status, payload }); },
    parseAskBody,
    NATIVE_STANDALONE_ASK_ORIGIN,
    findActiveBySessionId: (id: string) => id === SESSION ? ds : undefined,
    shouldReturnAskStartupNotReady: () => false,
    isTrustedHostIpcRequest: () => true,
    authorizeSessionScopedIpc,
    bindSessionScopedIpcIdentity,
    larkTransportEnabled: () => false,
    resolveAskDeliveryRoute,
    isNativeGatewayCoreProcess: () => true,
    isSilentMessageListenerSession,
    getBot: () => ({ config: { apiOnly: true, cliId: 'claude-code' } }),
    resolveDocumentAskDelivery: async () => undefined,
    captureRoutingGeneration: () => ({}),
    isCurrentRoutingGeneration: () => true,
    replyCardAskTarget: () => options.replyCardTarget,
    codexAsyncAnswerNeedsRawInput,
    codexAsyncAskOriginEligible,
    getSessionPersistentBackendType: () => 'tmux',
    registerAskForResponse,
    askResponseBody,
    localeForBot: () => 'zh',
    verifiedAskMention,
    isKnownPeerBot: () => false,
    isHumanOpenId: async () => true,
    frozenReplyContextForTurn,
    explicitAskContinuation: continuation,
    explicitAskOriginIsLive: () => true,
    activeSessions: new Map(ds ? [['k', ds]] : []),
    logger: { info: () => {}, warn: () => {}, debug: () => {} },
  });
  const done: Promise<void> = handler({}, res);
  return { done, responses, res };
}

/**
 * Let a request that was just posted run until it has registered its ask.
 * Only pending promise callbacks are drained and the fake clock does not move,
 * so this behaves the same under vitest and `bun test` (whose fake-timer
 * `advanceTimersByTimeAsync` drains a single callback, not the handler's chain).
 */
async function untilAskRegistered(): Promise<void> {
  for (let turn = 0; turn < 1_000 && listPendingAsks().length === 0; turn += 1) await Promise.resolve();
  expect(listPendingAsks()).toHaveLength(1);
}

function decide(ds: GatewaySession, body: Record<string, unknown>): string {
  const origin = originOf(ds);
  return nativeGatewayAskDecision({ origin, by: 'alice', ...body }, origin, APP, CHAT);
}

function deliverAndAnswer(ds: GatewaySession): void {
  const [ask] = listPendingAsks();
  const ids = { askId: ask!.askId, nonce: ask!.nonce };
  expect(decide(ds, { action: 'delivered', ...ids, messageId: 'card' })).toBe('accepted');
  expect(decide(ds, { action: 'toggle', ...ids, questionIndex: 0, key: 'yes' })).toBe('toggled');
  expect(decide(ds, { action: 'submit', ...ids })).toBe('accepted');
}

const ended = { kind: 'invalidated', failureCode: 'execution_ended' };

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  _resetForTest();
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('botmux ask on a native gateway core', () => {
  it('a caller still waiting across a daemon restart is told its turn ended, and nothing is asked', async () => {
    boot(directories(), gatewaySession());
    const { done, responses } = post(hookAsk({ originTurnId: 'turn', originDispatchAttempt: 4 }));
    await done;
    expect(responses).toEqual([{ status: 200, payload: expect.objectContaining(ended) }]);
    expect(listPendingAsks()).toEqual([]);
  });

  it('without a live turn, a caller that names no turn is told the same — not that it needs a Feishu chat', async () => {
    boot(directories(), gatewaySession());
    const { done, responses } = post(hookAsk({ requestId: 'other-cli-hook' }));
    await done;
    expect(responses).toEqual([{ status: 200, payload: expect.objectContaining(ended) }]);
    expect(listPendingAsks()).toEqual([]);
  });

  it('an ask in a live turn is bound to that exact execution and never embedded in a reply card', async () => {
    boot(directories(), gatewaySession({ turnId: 'turn', dispatchAttempt: 4 }));
    const ds = live!;
    const { done, responses } = post(hookAsk({ originTurnId: 'turn', originDispatchAttempt: 4 }),
      { replyCardTarget: { turnId: 'turn', dispatchAttempt: 4 } });
    await untilAskRegistered();
    const [pending] = listPendingAsks();
    expect(pending).toMatchObject({ nativeGatewayOrigin: { turnId: 'turn', workerGeneration: 2, dispatchAttempt: 4 } });
    expect(pending!.replyCardTarget).toBeUndefined();
    expect(nativeGatewayAskSnapshots(originOf(ds), APP, CHAT).map(item => item.ask.askId)).toEqual([pending!.askId]);
    deliverAndAnswer(ds);
    await done;
    expect(responses.at(-1)).toMatchObject({ status: 200, payload: { kind: 'answered', by: 'alice' } });
  });

  it('refuses an asynchronous Codex App question with an accurate error, asking nothing', async () => {
    boot(directories(), gatewaySession({ turnId: 'turn', dispatchAttempt: 4 }));
    const { done, responses } = post(hookAsk({
      originKind: 'native-user-input-async', requestId: 'item-1', originTurnId: 'turn', originDispatchAttempt: 4,
      asyncUserInput: { threadId: 'thread-1', itemId: 'item-1' },
    }));
    await done;
    expect(responses).toEqual([{ status: 400, payload: expect.objectContaining({ error: 'async_question_unsupported' }) }]);
    expect(listPendingAsks()).toEqual([]);
  });
});

describe('a caller from an earlier execution is never re-bound to the live one', () => {
  it('after a restart, a hook from the earlier turn is told its turn ended even though another turn is live', async () => {
    const shared = directories();
    boot(shared, gatewaySession({ turnId: 'turn-a', dispatchAttempt: 1 }));
    void post(hookAsk({ originTurnId: 'turn-a', originDispatchAttempt: 1 }));
    await untilAskRegistered();

    boot(shared, gatewaySession({ turnId: 'turn-b', dispatchAttempt: 1 }, 3));
    const again = post(hookAsk({ originTurnId: 'turn-a', originDispatchAttempt: 1 }));
    await again.done;
    expect(again.responses).toEqual([{ status: 200, payload: expect.objectContaining(ended) }]);
    expect(listPendingAsks()).toEqual([]);
    expect(nativeGatewayAskSnapshots(originOf(live!), APP, CHAT)).toEqual([]);
  });

  const inProcessEndings: Array<[string, () => GatewaySession]> = [
    ['the same turn was re-dispatched to a new worker', () => gatewaySession({ turnId: 'turn-a', dispatchAttempt: 2 }, 3)],
    ['the turn finished and the next one is live', () => gatewaySession({ turnId: 'turn-b', dispatchAttempt: 1 })],
  ];
  for (const [when, next] of inProcessEndings) {
    it(`a hook reconnecting after ${when} is told its turn ended, within and after the settled retention`, async () => {
      boot(directories(), gatewaySession({ turnId: 'turn-a', dispatchAttempt: 1 }));
      const first = post(hookAsk({ originTurnId: 'turn-a', originDispatchAttempt: 1 }));
      await untilAskRegistered();
      const [ask] = listPendingAsks();
      expect(decide(live!, { action: 'delivered', askId: ask!.askId, nonce: ask!.nonce, messageId: 'card' })).toBe('accepted');
      first.res.emit('close'); // the hook's connection drops (tmux backend → in-memory dormant)
      await first.done;
      live = next();
      await vi.advanceTimersByTimeAsync(WELL_WITHIN_DEADLINE_MS);

      const soon = post(hookAsk({ originTurnId: 'turn-a', originDispatchAttempt: 1 }));
      await soon.done;
      expect(soon.responses.at(-1)?.payload).toMatchObject(ended);

      await vi.advanceTimersByTimeAsync(61_000);
      nativeGatewayAskSnapshots(originOf(live!), APP, CHAT); // the gateway keeps polling the live execution
      const late = post(hookAsk({ originTurnId: 'turn-a', originDispatchAttempt: 1 }));
      await late.done;
      expect(late.responses.at(-1)?.payload).toMatchObject(ended);
      expect(listPendingAsks()).toEqual([]);
    });
  }

  it('a hook that names no turn, reconnecting after its worker was replaced within the same turn, is told its turn ended', async () => {
    boot(directories(), gatewaySession({ turnId: 'turn-a', dispatchAttempt: 1 }));
    const first = post(hookAsk({ requestId: 'unnamed-hook' }));
    await untilAskRegistered();
    first.res.emit('close');
    await first.done;
    live = gatewaySession({ turnId: 'turn-a', dispatchAttempt: 1 }, 3);
    await vi.advanceTimersByTimeAsync(WELL_WITHIN_DEADLINE_MS);

    const again = post(hookAsk({ requestId: 'unnamed-hook' }));
    await again.done;
    expect(again.responses.at(-1)?.payload).toMatchObject(ended);
    expect(listPendingAsks()).toEqual([]);
  });
});

describe('an explicit ask answered before a restart', () => {
  for (const turnLiveAfterRestart of [false, true]) {
    it(`gets its recorded answer after the restart${turnLiveAfterRestart ? ' while another turn is live' : ''}`, async () => {
      const shared = directories();
      boot(shared, gatewaySession({ turnId: 'turn-a', dispatchAttempt: 1 }));
      const explicit = hookAsk({ originKind: 'explicit', requestId: 'explicit-req', originTurnId: 'turn-a', originDispatchAttempt: 1 });
      const first = post(explicit);
      await untilAskRegistered();
      deliverAndAnswer(live!);
      await first.done; // the answer is recorded; the response is lost with the daemon

      boot(shared, turnLiveAfterRestart ? gatewaySession({ turnId: 'turn-b', dispatchAttempt: 1 }, 3) : gatewaySession(undefined, 3));
      const again = post(explicit);
      await again.done;
      expect(again.responses).toEqual([{ status: 200, payload: expect.objectContaining({ kind: 'answered', by: 'alice' }) }]);
      expect(listPendingAsks()).toEqual([]);
    });
  }

  it('does not hand its answer to a different question that reuses the request id', async () => {
    const shared = directories();
    boot(shared, gatewaySession({ turnId: 'turn-a', dispatchAttempt: 1 }));
    const explicit = hookAsk({ originKind: 'explicit', requestId: 'explicit-req', originTurnId: 'turn-a', originDispatchAttempt: 1 });
    const first = post(explicit);
    await untilAskRegistered();
    deliverAndAnswer(live!);
    await first.done;

    boot(shared, gatewaySession(undefined, 3));
    const other = post({ ...explicit, prompt: 'Delete the branch?' });
    await other.done;
    expect(other.responses).toEqual([{ status: 200, payload: expect.objectContaining(ended) }]);
  });
});
