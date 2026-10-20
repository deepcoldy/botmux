import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  authorizeSessionScopedIpc,
  bindSessionScopedIpcIdentity,
} from '../src/core/daemon-ipc-session-auth.js';

const liveOrigin = {
  capability: 'cap-session-a',
  turnId: 'turn-a',
  dispatchAttempt: 2,
};

describe('daemon IPC session-scoped fallback', () => {
  it('accepts only the exact ordinary-session live capability', () => {
    expect(authorizeSessionScopedIpc({
      trustedHost: false,
      sessionExists: true,
      receiverSession: false,
      allowReceiver: false,
      sessionId: 'session-a',
      liveOrigin,
      claimedCapability: liveOrigin.capability,
    })).toEqual({ ok: true });
    expect(authorizeSessionScopedIpc({
      trustedHost: false,
      sessionExists: true,
      receiverSession: false,
      allowReceiver: false,
      sessionId: 'session-a',
      liveOrigin,
      claimedTurnId: liveOrigin.turnId,
      claimedDispatchAttempt: liveOrigin.dispatchAttempt,
    })).toEqual({ ok: false, error: 'origin_unproven' });
  });

  it('rejects stale/cross-session claims and missing sessions', () => {
    expect(authorizeSessionScopedIpc({
      trustedHost: false,
      sessionExists: true,
      receiverSession: false,
      allowReceiver: false,
      sessionId: 'session-b',
      liveOrigin: { ...liveOrigin, capability: 'cap-session-b' },
      claimedCapability: liveOrigin.capability,
    })).toEqual({ ok: false, error: 'origin_unproven' });
    expect(authorizeSessionScopedIpc({
      trustedHost: false,
      sessionExists: false,
      receiverSession: false,
      allowReceiver: false,
      sessionId: 'missing',
      claimedCapability: liveOrigin.capability,
    })).toEqual({ ok: false, error: 'origin_unproven' });
  });

  it('denies receiver side effects while allowing its non-observable readiness signal', () => {
    const base = {
      trustedHost: false,
      sessionExists: true,
      receiverSession: true,
      sessionId: 'receiver-a',
      liveOrigin,
      claimedCapability: liveOrigin.capability,
    };
    expect(authorizeSessionScopedIpc({ ...base, allowReceiver: false }))
      .toEqual({ ok: false, error: 'managed_action_required' });
    expect(authorizeSessionScopedIpc({ ...base, allowReceiver: true }))
      .toEqual({ ok: true });
  });

  it('always accepts an already HMAC-authenticated trusted host', () => {
    expect(authorizeSessionScopedIpc({
      trustedHost: true,
      sessionExists: false,
      receiverSession: true,
      allowReceiver: false,
      sessionId: '',
    })).toEqual({ ok: true });
  });

  it('overrides a stale project-card root with the live chat route', () => {
    const ask = { sessionId: 'session-a', larkAppId: 'app-a', chatId: 'chat-a', rootMessageId: 'om_project_card', requestId: 'req-a' };
    const bound = bindSessionScopedIpcIdentity(ask, {
      sessionId: 'session-a', larkAppId: 'app-a', chatId: 'chat-a', rootMessageId: null,
    });
    expect(bound).toEqual({ ...ask, rootMessageId: null });
    expect(bindSessionScopedIpcIdentity(ask, {
      sessionId: 'session-a', larkAppId: 'app-a', chatId: 'chat-a', rootMessageId: 'om_live_topic',
    })).toEqual({ ...ask, rootMessageId: 'om_live_topic' });
  });

  it('binds ask and hook routing fields to the authenticated session', () => {
    const bound = bindSessionScopedIpcIdentity({
      sessionId: 'session-b',
      larkAppId: 'app-b',
      chatId: 'chat-b',
      rootMessageId: 'root-b',
      questions: ['preserved'],
      event: 'preserved',
    }, {
      sessionId: 'session-a',
      larkAppId: 'app-a',
      chatId: 'chat-a',
      rootMessageId: 'root-a',
    });
    expect(bound).toEqual({
      sessionId: 'session-a',
      larkAppId: 'app-a',
      chatId: 'chat-a',
      rootMessageId: 'root-a',
      questions: ['preserved'],
      event: 'preserved',
    });
  });
});

describe('daemon session-scoped IPC route wiring', () => {
  const source = readFileSync(new URL('../src/daemon.ts', import.meta.url), 'utf8');

  function route(path: string): string {
    const from = source.indexOf(`ipcRoute('POST', '${path}'`);
    expect(from, `missing route: ${path}`).toBeGreaterThanOrEqual(0);
    const to = source.indexOf('ipcRoute(', from + 1);
    return source.slice(from, to > from ? to : undefined);
  }

  function blockEnd(text: string, openAt: number): number {
    let depth = 0;
    for (let i = text.indexOf('{', openAt); i >= 0 && i < text.length; i++) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}' && --depth === 0) return i;
    }
    return -1;
  }

  // 源码结构护栏(K2)：ask / hook 两条 IPC 路由里，路由与身份字段（larkAppId / chatId / rootMessageId）必须先由
  // bindSessionScopedIpcIdentity 从已认证的 daemon 会话覆写，才能注册可观测的确认卡或发出 hook 事件；否则持有会话 A
  // 能力的调用方可以在 payload 里冒充会话 B。#1740 起 HMAC 宿主调用方同样要绑定，绑定不能嵌回
  // `if (!isTrustedHostIpcRequest(req))` 鉴权块里。路由处理器内联在 daemon.ts 入口模块，没有行为 seam；
  // 绑定函数本身由上方 'daemon IPC session-scoped fallback' 行为用例覆盖。
  it('binds ask and hook identity from the authenticated session before any observable side effect', () => {
    const ask = route('/api/asks');
    const askBindAt = ask.indexOf('boundAsk = bindSessionScopedIpcIdentity(');
    const authAt = ask.indexOf('if (!isTrustedHostIpcRequest(req)) {');
    expect(askBindAt).toBeGreaterThan(-1);
    expect(authAt).toBeGreaterThan(-1);
    // Host HMAC callers are bound too: the bind sits after the auth block closes.
    expect(askBindAt).toBeGreaterThan(blockEnd(ask, authAt));
    const inputAt = ask.indexOf('const askInput = {');
    expect(inputAt).toBeGreaterThan(askBindAt);
    const askInput = ask.slice(inputAt, ask.indexOf('};', inputAt));
    expect(askInput).toContain('boundAsk.larkAppId');
    expect(askInput).not.toContain('parsed.larkAppId');
    expect(ask.indexOf('registerAskForResponse(askInput')).toBeGreaterThan(inputAt);

    const hook = route('/api/hooks/emit');
    const hookBindAt = hook.indexOf('boundPayload = bindSessionScopedIpcIdentity(');
    const emitAt = hook.search(/emitHookEventLocal\([^)]*boundPayload\)/);
    expect(hookBindAt).toBeGreaterThan(-1);
    expect(emitAt).toBeGreaterThan(hookBindAt);
  });
});
