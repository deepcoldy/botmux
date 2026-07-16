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

  function between(start: string, end: string): string {
    const from = source.indexOf(start);
    const to = source.indexOf(end, from + start.length);
    expect(from, `missing route marker: ${start}`).toBeGreaterThanOrEqual(0);
    expect(to, `missing route marker: ${end}`).toBeGreaterThan(from);
    return source.slice(from, to);
  }

  it('binds ask routing before registering an observable card', () => {
    const route = between(
      "ipcRoute('POST', '/api/asks'",
      "ipcRoute('POST', '/api/attention'",
    );
    const bindAt = route.indexOf('boundAsk = bindSessionScopedIpcIdentity(');
    const registerAt = route.indexOf('registerAskBroker({');
    expect(bindAt).toBeGreaterThanOrEqual(0);
    expect(registerAt).toBeGreaterThan(bindAt);
  });

  it('binds hook identity before emitting the event', () => {
    const route = between(
      "ipcRoute('POST', '/api/hooks/emit'",
      '// ─── adopt-session',
    );
    const bindAt = route.indexOf('boundPayload = bindSessionScopedIpcIdentity(');
    const emitAt = route.indexOf('emitHookEventLocal(event as HookEvent, boundPayload)');
    expect(bindAt).toBeGreaterThanOrEqual(0);
    expect(emitAt).toBeGreaterThan(bindAt);
  });
});
