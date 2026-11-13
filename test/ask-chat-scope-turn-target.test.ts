import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _resetForTest,
  listPendingAsksByAnchor,
  registerHostAsk,
  setCanTalkChecker,
  setCardDispatcher,
  setExplicitAskSessionChecker,
  submitCustomReply,
} from '../src/core/ask-broker.js';
import { parseAskBody, registerAskForResponse, verifiedAskMention } from '../src/core/ask-api.js';
import { authorizeSessionScopedIpc, bindSessionScopedIpcIdentity } from '../src/core/daemon-ipc-session-auth.js';
import { createExplicitAskContinuation, explicitAskOriginIsLive, explicitAskSessionBound } from '../src/core/explicit-ask-continuation.js';
import { frozenReplyContextForTurn } from '../src/core/reply-target.js';
import { createLarkAskCardDispatcher } from '../src/im/lark/ask-card.js';
import { isSilentMessageListenerSession } from '../src/core/message-listener-silence.js';
import { productionConst } from './helpers/codex-async-answer-function-harness.js';
import { captureCodexAsyncAskOrigin } from '../src/core/codex-async-ask-origin.js';
import * as sessionControllers from '../src/core/session-controller.js';
import { SessionContractStore } from '../src/services/session-contract-store.js';
import type { DaemonSession } from '../src/core/types.js';

// 执行 daemon.ts 里真实的 handleAskRequest，配真实 broker / 显式 ask 回执 / 飞书发卡器，
// 只把飞书发送接口换成记录器：断言卡片实际发到哪、文字答复能否结算。
const APP = 'cli_chat_scope_ask';
const CHAT = 'oc_chat_fixture';
const ROOT = 'om_root_fixture';
const TURN = 'om_turn_fixture';

type Ds = ReturnType<typeof chatScopeSession>;

function chatScopeSession(session: Record<string, unknown>, turnId = TURN) {
  return {
    larkAppId: APP, chatId: CHAT, chatType: 'group' as const, scope: 'chat' as const,
    session: { sessionId: 'sess-chat-scope', scope: 'chat', chatId: CHAT, rootMessageId: CHAT, ...session } as any,
    worker: { killed: false }, workerGeneration: 1,
    managedTurnOrigin: { turnId, dispatchAttempt: 1 },
  };
}

function askBody(originTurnId: string, extra: Record<string, unknown> = {}) {
  return {
    sessionId: 'sess-chat-scope', chatId: CHAT, larkAppId: APP, rootMessageId: null,
    prompt: '是否继续？', options: [{ key: 'yes', label: 'yes' }, { key: 'no', label: 'no' }], timeoutMs: 60_000,
    originKind: 'explicit', requestId: `req-${originTurnId}`, originTurnId, originDispatchAttempt: 1, ...extra,
  };
}

describe('chat-scope 会话里 ask 卡片跟随发起 turn 的冻结回复目标', () => {
  let dir: string;
  let continuation: ReturnType<typeof createExplicitAskContinuation>;
  const sent: Array<{ via: 'reply' | 'send'; target: string }> = [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ask-chat-scope-'));
    sent.length = 0;
    setCanTalkChecker(() => true);
    setCardDispatcher(createLarkAskCardDispatcher({
      replyMessage: (async (_app: string, root: string) => { sent.push({ via: 'reply', target: root }); return `om_card_${sent.length}`; }) as any,
      sendMessage: (async (_app: string, chat: string) => { sent.push({ via: 'send', target: chat }); return `om_card_${sent.length}`; }) as any,
    }));
    continuation = createExplicitAskContinuation({
      dir, appId: APP, register: registerHostAsk,
      canResume: () => false, dispatch: async () => false, onError: () => {},
    });
  });
  afterEach(() => {
    _resetForTest();
    rmSync(dir, { recursive: true, force: true });
  });

  function post(ds: Ds, body: Record<string, unknown>, dependencies: Record<string, unknown> = {}) {
    const responses: Array<{ status: number; payload: any }> = [];
    const handler = productionConst('src/daemon.ts', 'handleAskRequest', {
      readJsonBody: async () => body,
      jsonRes: (_res: unknown, status: number, payload: unknown) => { responses.push({ status, payload }); },
      parseAskBody,
      findActiveBySessionId: (id: string) => id === ds.session.sessionId ? ds : undefined,
      shouldReturnAskStartupNotReady: () => false,
      isTrustedHostIpcRequest: () => true,
      authorizeSessionScopedIpc,
      bindSessionScopedIpcIdentity,
      larkTransportEnabled: () => true,
      isSilentMessageListenerSession,
      getBot: () => ({ config: { apiOnly: false, cliId: 'codex-app' } }),
      resolveDocumentAskDelivery: async () => undefined,
      captureRoutingGeneration: () => ({}),
      isCurrentRoutingGeneration: () => true,
      replyCardAskTarget: () => undefined,
      getSessionPersistentBackendType: () => 'tmux',
      explicitAskContinuation: continuation,
      explicitAskOriginIsLive,
      registerAskForResponse,
      verifiedAskMention,
      isKnownPeerBot: () => false,
      isHumanOpenId: async () => true,
      frozenReplyContextForTurn,
      activeSessions: new Map([['k', ds]]),
      logger: { info: () => {}, warn: () => {}, debug: () => {} },
      ...dependencies,
    });
    const done: Promise<void> = handler({}, { destroyed: false, once: () => {}, off: () => {} });
    return { done, responses };
  }

  it.each(['none', 'document lookup', 'before registration', 'waiting for answer', 'pending reservation'])(
    'routes a native question with no legacy thread mirror; replaces runtime during %s', async replace => {
    const ds = chatScopeSession({ status: 'active', workerGeneration: 1, cliId: 'codex-app' });
    const store = new SessionContractStore(dir, APP);
    const controller = new sessionControllers.SessionController(ds as unknown as DaemonSession, store);
    const lookup = vi.spyOn(sessionControllers, 'controllerForSession').mockReturnValue(controller);
    try {
      const { worker } = controller.bindWorker(1);
      const bind = (binding: string, physicalId: string) => {
        controller.reserveBinding(binding, worker);
        return controller.bindRuntime(binding, worker, { backend: 'tmux', physicalId,
          proof: 'process_start', nativeSessionId: 'thread-current' });
      };
      bind('current', '10:100');
      const deliveryChecks: boolean[] = [];
      const { done, responses } = post(ds, askBody(TURN, {
        originKind: 'native-user-input-async', requestId: 'question-item',
        asyncUserInput: { threadId: 'thread-current', nativeTurnId: 'native-turn', itemId: 'question-item' },
      }), {
        isCodexAppCliId: (id: string) => id === 'codex-app', captureCodexAsyncAskOrigin,
        asyncAskAudience: () => ({ kind: 'human', answererOpenId: 'ou_user' }),
        localeForBot: () => 'zh', tr: (key: string) => key, notifyAsyncAsk: vi.fn(),
        resolveDocumentAskDelivery: async () => {
          if (replace === 'document lookup') bind('replacement', '11:101');
          // 替代运行时只预留（starting、无 identity）：activeRuntime 仍是旧的，
          // 只有 hasPendingRuntimeReplacement 能识别这个换代窗口。
          if (replace === 'pending reservation') controller.reserveBinding('replacement', worker);
          return undefined;
        },
        verifiedAskMention: async () => {
          if (replace === 'before registration') bind('replacement', '11:101');
          return undefined;
        },
        deliverCodexAsyncAnswer: async (_identity: unknown, _questions: unknown, _result: unknown, deps: { isCurrent(): boolean }) => {
          deliveryChecks.push(deps.isCurrent()); return deps.isCurrent();
        },
      });
      if (replace === 'document lookup' || replace === 'before registration' || replace === 'pending reservation') {
        await done;
        expect(sent).toHaveLength(0);
        expect(responses.at(-1)).toMatchObject({ status: 409 });
        return;
      }
      await vi.waitFor(() => expect(sent).toEqual([{ via: 'send', target: CHAT }]));
      expect(ds.session.cliSessionId).toBeUndefined();
      if (replace === 'waiting for answer') bind('replacement', '11:101');
      const [pending] = listPendingAsksByAnchor({ larkAppId: APP, chatId: CHAT, anchor: CHAT });
      expect(submitCustomReply({ askId: pending!.askId, by: 'ou_user', text: '继续' })).toBe('accepted');
      await done;
      expect(deliveryChecks).toEqual([replace === 'none']);
    } finally {
      lookup.mockRestore(); store.close();
    }
  });

  it('rejects a native question whose threadId does not match the live runtime', async () => {
    const ds = chatScopeSession({ status: 'active', workerGeneration: 1, cliId: 'codex-app' });
    const store = new SessionContractStore(dir, APP);
    const controller = new sessionControllers.SessionController(ds as unknown as DaemonSession, store);
    const lookup = vi.spyOn(sessionControllers, 'controllerForSession').mockReturnValue(controller);
    try {
      const { worker } = controller.bindWorker(1);
      controller.reserveBinding('current', worker);
      controller.bindRuntime('current', worker, { backend: 'tmux', physicalId: '10:100',
        proof: 'process_start', nativeSessionId: 'thread-current' });
      const { done, responses } = post(ds, askBody(TURN, {
        originKind: 'native-user-input-async', requestId: 'question-item',
        asyncUserInput: { threadId: 'thread-other', nativeTurnId: 'native-turn', itemId: 'question-item' },
      }), {
        isCodexAppCliId: (id: string) => id === 'codex-app', captureCodexAsyncAskOrigin,
        asyncAskAudience: () => ({ kind: 'human', answererOpenId: 'ou_user' }),
        localeForBot: () => 'zh', tr: (key: string) => key, notifyAsyncAsk: vi.fn(),
      });
      await done;
      expect(sent).toHaveLength(0);
      expect(responses.at(-1)).toMatchObject({ status: 409 });
    } finally {
      lookup.mockRestore(); store.close();
    }
  });

  it('freezes the worker generation: a later rotation invalidates the captured origin', () => {
    const ds = chatScopeSession({ status: 'active', workerGeneration: 1, cliId: 'codex-app' });
    const store = new SessionContractStore(dir, APP);
    const controller = new sessionControllers.SessionController(ds as unknown as DaemonSession, store);
    const lookup = vi.spyOn(sessionControllers, 'controllerForSession').mockReturnValue(controller);
    try {
      const { worker } = controller.bindWorker(1);
      controller.reserveBinding('current', worker);
      controller.bindRuntime('current', worker, { backend: 'tmux', physicalId: '10:100',
        proof: 'process_start', nativeSessionId: 'thread-current' });
      const isCurrent = captureCodexAsyncAskOrigin(ds, 'thread-current');
      expect(typeof isCurrent).toBe('function');
      expect(isCurrent!()).toBe(true);
      // reserveWorkerGeneration 在新 worker 的 contract bindWorker 之前就推进 ds 代次。
      ds.workerGeneration = 2;
      ds.session.workerGeneration = 2;
      expect(isCurrent!()).toBe(false);
    } finally {
      lookup.mockRestore(); store.close();
    }
  });

  /** 等卡片发出，再用 chat-scope 折叠路径的锚点（chatId）以文字作答。 */
  async function cardThenTextAnswer(ds: Ds, body: Record<string, unknown>) {
    const before = sent.length;
    const { done, responses } = post(ds, body);
    await vi.waitFor(() => expect(sent.length).toBe(before + 1));
    const [pending] = listPendingAsksByAnchor({ larkAppId: APP, chatId: CHAT, anchor: CHAT });
    expect(pending).toBeDefined();
    expect(submitCustomReply({ askId: pending!.askId, by: 'ou_user', text: '继续' })).toBe('accepted');
    await done;
    expect(responses.at(-1)).toMatchObject({ status: 200, payload: { kind: 'answered', comment: '继续' } });
    return sent.at(-1);
  }

  it('冻结为话题的 turn：卡片回复进该话题，话题里的文字答复仍能结算', async () => {
    const ds = chatScopeSession({
      turnReplyContexts: { [TURN]: { target: { mode: 'thread', rootMessageId: ROOT }, inThread: false, sourceMessageId: TURN } },
      replyTargets: { [TURN]: { rootMessageId: ROOT, quoteOnly: false, updatedAt: new Date().toISOString() } },
    });
    expect(await cardThenTextAnswer(ds, askBody(TURN))).toEqual({ via: 'reply', target: ROOT });
  });

  it('hook 发起的 ask 同样跟随话题落点', async () => {
    const ds = chatScopeSession({
      turnReplyContexts: { [TURN]: { target: { mode: 'thread', rootMessageId: ROOT } } },
    });
    expect(await cardThenTextAnswer(ds, askBody(TURN, { originKind: 'hook', requestId: 'hook-req' })))
      .toEqual({ via: 'reply', target: ROOT });
  });

  it('话题 A/B 交错：旧 turn 提问发到它自己的话题，不跟最新话题；群顶层 turn 与引用回复 turn 仍发群顶层', async () => {
    const ds = chatScopeSession({
      turnReplyContexts: {
        om_turn_a: { target: { mode: 'thread', rootMessageId: 'om_root_a' } },
        om_turn_top: { target: { mode: 'plain', chatId: CHAT } },
        om_turn_quote: { target: { mode: 'quote', rootMessageId: 'om_quoted' } },
        om_turn_b: { target: { mode: 'thread', rootMessageId: 'om_root_b' } },
      },
      currentReplyTarget: { rootMessageId: 'om_root_b', turnId: 'om_turn_b', updatedAt: new Date().toISOString() },
    }, 'om_turn_b');
    expect(await cardThenTextAnswer(ds, askBody('om_turn_a'))).toEqual({ via: 'reply', target: 'om_root_a' });
    expect(await cardThenTextAnswer(ds, askBody('om_turn_top'))).toEqual({ via: 'send', target: CHAT });
    expect(await cardThenTextAnswer(ds, askBody('om_turn_quote'))).toEqual({ via: 'send', target: CHAT });
  });

  it('只有 replyTargets 的 turn（如失败重试重建的 turn）按同一冻结口径回退到它的话题', async () => {
    const ds = chatScopeSession({
      replyTargets: { om_turn_retry: { rootMessageId: ROOT, updatedAt: new Date().toISOString() } },
    }, 'om_turn_retry');
    expect(await cardThenTextAnswer(ds, askBody('om_turn_retry'))).toEqual({ via: 'reply', target: ROOT });
  });

  it('发卡位置不属于显式 ask 的调用身份：turn 记录被淘汰后同一调用重连仍拿到原答案', async () => {
    const ds = chatScopeSession({
      turnReplyContexts: { [TURN]: { target: { mode: 'thread', rootMessageId: ROOT } } },
      replyTargets: { [TURN]: { rootMessageId: ROOT, updatedAt: new Date().toISOString() } },
    });
    await cardThenTextAnswer(ds, askBody(TURN));
    ds.session.turnReplyContexts = {};
    ds.session.replyTargets = {};
    const { done, responses } = post(ds, askBody(TURN));
    await done;
    expect(responses).toEqual([{ status: 200, payload: expect.objectContaining({ kind: 'answered', comment: '继续' }) }]);
    expect(sent).toHaveLength(1);
  });

  // chat-scope 会话记录里 rootMessageId 存的是 chatId，而 ask 身份按 root=null 绑定；
  // 无期限 ask 的「会话关闭/换绑即失效」若拿原始字段比较，会把每张 chat-scope 卡判成已换绑。
  it('无期限 ask：真实绑定出的 chat-scope 身份算会话仍在，可作答；会话关闭后同一张卡只得失效', async () => {
    const ds = chatScopeSession({});
    const live = new Map<string, Ds>([[ds.session.sessionId, ds]]);
    setExplicitAskSessionChecker(ask => explicitAskSessionBound(ask, live.get(ask.sessionId)));
    await cardThenTextAnswer(ds, askBody(TURN, { timeoutMs: 0 }));

    const before = sent.length;
    const { done, responses } = post(ds, askBody(TURN, { timeoutMs: 0, requestId: 'req-closed' }));
    await vi.waitFor(() => expect(sent.length).toBe(before + 1));
    const [pending] = listPendingAsksByAnchor({ larkAppId: APP, chatId: CHAT, anchor: CHAT });
    live.clear();
    expect(submitCustomReply({ askId: pending!.askId, by: 'ou_user', text: '继续' })).toBe('already_settled');
    await done;
    expect(responses.at(-1)).toMatchObject({ status: 200, payload: { kind: 'invalidated', timedOut: false } });
  });

  it('daemon 的显式 ask 回执判定：chat-scope 会话在线时不失效且可恢复，关闭或换群才失效，会话恢复完成前不判', () => {
    const ds = chatScopeSession({});
    const receipt = { version: 1, input: { larkAppId: APP, chatId: CHAT, rootMessageId: null, sessionId: ds.session.sessionId,
      requestId: 'req-receipt', originKind: 'host_explicit', timeoutMs: 0, questions: [] } };
    const scope: Record<string, any> = {
      createExplicitAskContinuation: (deps: unknown) => deps, join, config: { session: { dataDir: dir } },
      sessionsRestored: true, findActiveBySessionId: () => ds, explicitAskSessionBound,
      releaseExplicitAskHandoff: () => {}, hasExplicitAskHandoff: () => true, invalidateExplicitAsk: () => {},
    };
    const deps = productionConst('src/daemon.ts', 'explicitAskContinuation', scope);
    expect(deps.shouldInvalidate(receipt)).toBe(false);
    expect(deps.canResume(receipt)).toBe(true);
    scope.findActiveBySessionId = () => ({ ...ds, chatId: 'oc_other_chat' });
    expect(deps.shouldInvalidate(receipt)).toBe(true);
    expect(deps.canResume(receipt)).toBe(false);
    scope.findActiveBySessionId = () => undefined;
    expect(deps.shouldInvalidate(receipt)).toBe(true);
    scope.sessionsRestored = false;
    expect(deps.shouldInvalidate(receipt)).toBe(false);
  });
});
