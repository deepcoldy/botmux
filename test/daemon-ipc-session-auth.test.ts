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
  const ipcServerSource = readFileSync(new URL('../src/core/dashboard-ipc-server.ts', import.meta.url), 'utf8');

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
    expect(route).toContain('const askChatType = askSession?.chatType;');
    expect(route).toMatch(
      /registerAskBroker\(\{\s*larkAppId: boundAsk\.larkAppId,[\s\S]*chatType: askChatType,/,
    );
    expect(route).not.toMatch(
      /registerAskBroker\(\{\s*larkAppId: parsed\.larkAppId,/,
    );
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

  it('admits only the capability-checked goal command apertures', () => {
    for (const path of [
      '/api/goal/supervise',
      '/api/goal/notify-parent',
      '/api/goal/watchdog',
      '/api/goal/release-check',
      '/api/goal/release-action',
    ]) {
      expect(ipcServerSource).toContain(`pathname === '${path}'`);
    }
  });

  it('binds goal supervise to the authenticated L1 session before starting L2', () => {
    const route = between(
      "ipcRoute('POST', '/api/goal/supervise'",
      'function findActiveSessionById(',
    );
    const authAt = route.indexOf('authorizeGoalSessionIpc(req, parent, raw)');
    const startAt = route.indexOf('startGoalSupervisor({');
    expect(authAt).toBeGreaterThanOrEqual(0);
    expect(startAt).toBeGreaterThan(authAt);
    expect(route).toContain('raw.parentChatId = parent.chatId;');
    expect(route).toContain('raw.larkAppId = parent.larkAppId;');
    expect(route).toContain('const authorizedWorkingDir = parent.workingDir ?? parent.session.workingDir;');
    expect(route).toContain("errorCode: 'working_dir_not_authorized'");
    expect(route).toContain('raw.workingDir = authorizedWorkingDir;');
  });

  it('binds goal notify-parent to the authenticated supervisor session', () => {
    const route = between(
      "ipcRoute('POST', '/api/goal/notify-parent'",
      "ipcRoute('POST', '/api/goal/watchdog'",
    );
    const authAt = route.indexOf('authorizeGoalSessionIpc(req, supervisor, raw)');
    const notifyAt = route.indexOf('notifyGoalParent(notifyReq');
    expect(authAt).toBeGreaterThanOrEqual(0);
    expect(notifyAt).toBeGreaterThan(authAt);
    expect(route).toContain('raw.goalChatId = supervisor.session.goalSupervisor.goalChatId;');
  });

  it('lets an authenticated goal member request a host-signed watchdog fan-out', () => {
    const route = between(
      "ipcRoute('POST', '/api/goal/watchdog'",
      '// ─── session-ready IPC route',
    );
    const authAt = route.indexOf('authorizeGoalSessionIpc(req, caller, raw)');
    const fanoutAt = route.indexOf('triggerGoalWatchdogAcrossDaemons({');
    expect(authAt).toBeGreaterThanOrEqual(0);
    expect(fanoutAt).toBeGreaterThan(authAt);
    expect(route).toContain('caller.chatId !== goalChatId');
  });

  it('allows only the owning goal supervisor to confirm or retry a planned release', () => {
    const route = between(
      "ipcRoute('POST', '/api/goal/release-action'",
      "ipcRoute('POST', '/api/goal/release-check'",
    );
    const authAt = route.indexOf('authorizeGoalSessionIpc(req, caller, raw)');
    const mutateAt = route.indexOf('confirmTaskRelease({');
    expect(authAt).toBeGreaterThanOrEqual(0);
    expect(mutateAt).toBeGreaterThan(authAt);
    expect(route).toContain("caller.session.goalSupervisor?.goalChatId !== task.chatId");
    expect(route).toContain("error: 'goal_supervisor_required'");
    expect(route).toContain("error: 'wrong_release_owner'");
  });

  it('authenticates a session-scoped release-check before host fan-out', () => {
    const route = between(
      "ipcRoute('POST', '/api/goal/release-check'",
      "ipcRoute('POST', '/api/goal/watchdog'",
    );
    const authAt = route.indexOf('authorizeGoalSessionIpc(req, caller, raw)');
    const fanoutAt = route.indexOf('triggerGoalReleaseAcrossDaemons({');
    expect(authAt).toBeGreaterThanOrEqual(0);
    expect(fanoutAt).toBeGreaterThan(authAt);
    expect(route).toContain('caller.chatId !== goalChatId');
    expect(route).toContain('if (!isTrustedHostIpcRequest(req))');
  });
});
