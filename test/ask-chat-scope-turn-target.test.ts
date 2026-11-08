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
  submitCustomReply,
} from '../src/core/ask-broker.js';
import { parseAskBody, registerAskForResponse, verifiedAskMention } from '../src/core/ask-api.js';
import { authorizeSessionScopedIpc, bindSessionScopedIpcIdentity } from '../src/core/daemon-ipc-session-auth.js';
import { createExplicitAskContinuation, explicitAskOriginIsLive } from '../src/core/explicit-ask-continuation.js';
import { frozenReplyContextForTurn } from '../src/core/reply-target.js';
import { createLarkAskCardDispatcher } from '../src/im/lark/ask-card.js';
import { isSilentMessageListenerSession } from '../src/core/message-listener-silence.js';
import { productionConst } from './helpers/codex-async-answer-function-harness.js';

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

  function post(ds: Ds, body: Record<string, unknown>) {
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
    });
    const done: Promise<void> = handler({}, { destroyed: false, once: () => {}, off: () => {} });
    return { done, responses };
  }

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
});
