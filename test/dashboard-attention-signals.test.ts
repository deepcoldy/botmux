// test/dashboard-attention-signals.test.ts
//
// Attention signals for the dashboard sessions board (needs-you column):
//   - composeRowFromActive carries pendingRepo / tuiPromptActive
//   - publishAttentionPatch emits a session.update derived from live state
//   - announcePendingRepoSession announces card-waiting sessions (which have
//     no worker yet, so the normal spawn-time announce never fires) and
//     no-ops for non-pending sessions
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { composeRowFromActive } from '../src/core/dashboard-rows.js';
import { publishAttentionPatch, announcePendingRepoSession, clearAgentAttention } from '../src/core/session-activity.js';
import { dashboardEventBus, type DashboardEvent } from '../src/core/dashboard-events.js';
import { attentionWaitSince } from '../src/dashboard/web/ui.js';
import {
  setTerminalProxyPort,
  setTerminalExternalPort,
  resetTerminalProxy,
} from '../src/core/terminal-url.js';
import type { DaemonSession } from '../src/core/types.js';

function makeDs(overrides: Partial<DaemonSession> = {}): DaemonSession {
  return {
    session: {
      sessionId: 'sess-1',
      chatId: 'oc_chat',
      rootMessageId: 'om_root',
      title: 't',
      status: 'active',
      createdAt: new Date(1000).toISOString(),
    },
    worker: null,
    workerPort: null,
    workerToken: null,
    larkAppId: 'cli_app',
    chatId: 'oc_chat',
    chatType: 'group',
    scope: 'thread',
    spawnedAt: 1000,
    cliVersion: 'test',
    lastMessageAt: 1000,
    hasHistory: false,
    ...overrides,
  } as DaemonSession;
}

function collectEvents(): DashboardEvent[] {
  const seen: DashboardEvent[] = [];
  const off = dashboardEventBus.subscribe(e => seen.push(e));
  // vitest runs this file in one process — detach after each test via closure
  collectEvents.off = off;
  return seen;
}
collectEvents.off = () => {};

describe('attention signals', () => {
  beforeEach(() => {
    collectEvents.off();
  });

  it('composeRowFromActive exposes pendingRepo and tuiPromptActive', () => {
    const row = composeRowFromActive(makeDs({ pendingRepo: true, tuiPromptCardId: 'om_card' }));
    expect(row.pendingRepo).toBe(true);
    expect(row.tuiPromptActive).toBe(true);

    const quiet = composeRowFromActive(makeDs());
    expect(quiet.pendingRepo).toBe(false);
    expect(quiet.tuiPromptActive).toBe(false);
  });

  it('composeRowFromActive carries the agent raise-hand signal with its reason', () => {
    const raised = composeRowFromActive(makeDs({
      agentAttention: { kind: 'authz', reason: '需要 prod 部署授权', at: 1234 },
    }));
    // `at` (raise time) is exposed so the UI shows a true "waiting since" time
    expect(raised.agentAttention).toEqual({ kind: 'authz', reason: '需要 prod 部署授权', at: 1234 });

    // quiet sessions omit the field entirely (not a needs-you row)
    expect(composeRowFromActive(makeDs()).agentAttention).toBeUndefined();
  });

  it('composeRowFromActive carries the session scope (locate vs open-chat)', () => {
    const chatScoped = makeDs();
    chatScoped.session.scope = 'chat';
    expect(composeRowFromActive(chatScoped).scope).toBe('chat');

    const threadScoped = makeDs();
    threadScoped.session.scope = 'thread';
    expect(composeRowFromActive(threadScoped).scope).toBe('thread');

    // legacy sessions persisted before the scope field existed
    expect(composeRowFromActive(makeDs()).scope).toBeUndefined();
  });

  it('publishAttentionPatch emits session.update derived from session state', () => {
    const seen = collectEvents();
    publishAttentionPatch(makeDs({ tuiPromptCardId: 'om_card' }));
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({
      type: 'session.update',
      body: {
        sessionId: 'sess-1',
        patch: { pendingRepo: false, tuiPromptActive: true, agentAttention: null },
      },
    });
  });

  it('publishAttentionPatch carries agentAttention (object when raised, null to clear)', () => {
    const seen = collectEvents();
    const ds = makeDs({ agentAttention: { kind: 'decision', reason: '要删 old_users 表', at: 5 } });
    publishAttentionPatch(ds);
    ds.agentAttention = undefined;
    publishAttentionPatch(ds);
    expect(seen.map(e => (e as any).body.patch.agentAttention)).toEqual([
      { kind: 'decision', reason: '要删 old_users 表', at: 5 },
      null,
    ]);
  });

  it('clearAgentAttention clears once and publishes the null patch', () => {
    const seen = collectEvents();
    const ds = makeDs({ agentAttention: { kind: 'blocked', reason: '缺权限', at: 5 } });

    expect(clearAgentAttention(ds)).toBe(true);
    expect(ds.agentAttention).toBeUndefined();
    expect(clearAgentAttention(ds)).toBe(false);
    expect(seen.map(e => (e as any).body.patch.agentAttention)).toEqual([null]);
  });

  it('publishAttentionPatch reflects cleared signals (idempotent re-derive)', () => {
    const seen = collectEvents();
    const ds = makeDs({ pendingRepo: true });
    publishAttentionPatch(ds);
    ds.pendingRepo = false;
    publishAttentionPatch(ds);
    expect(seen.map(e => (e as any).body.patch.pendingRepo)).toEqual([true, false]);
  });

  it('announcePendingRepoSession publishes a full session.spawned row when pending', () => {
    const seen = collectEvents();
    announcePendingRepoSession(makeDs({ pendingRepo: true }));
    expect(seen).toHaveLength(1);
    expect(seen[0].type).toBe('session.spawned');
    const row = (seen[0] as any).body.session;
    expect(row.sessionId).toBe('sess-1');
    expect(row.pendingRepo).toBe(true);
    expect(row.status).toBe('starting'); // no screen yet → starting
  });

  it('announcePendingRepoSession is a no-op when the session is not pending', () => {
    const seen = collectEvents();
    announcePendingRepoSession(makeDs({ pendingRepo: false }));
    announcePendingRepoSession(makeDs());
    expect(seen).toHaveLength(0);
  });

  it('handleThreadReply clears agent attention before early-return intercepts', () => {
    const src = readFileSync(new URL('../src/daemon.ts', import.meta.url), 'utf-8');
    const start = src.indexOf('async function handleThreadReply(');
    expect(start).toBeGreaterThanOrEqual(0);
    // 16000：窗口需罩住函数头到最后一个拦截点 (findPendingAskByAnchor) 的全部
    // 源码——passthrough 冷启动等合法插入会把后续 marker 往后推，窗口太紧会误报。
    // 语义断言不变：clear 在所有拦截点之前。
    const region = src.slice(start, start + 16000);
    const clearIdx = region.indexOf('clearAgentAttentionForHumanInbound();');
    expect(clearIdx).toBeGreaterThanOrEqual(0);
    for (const marker of [
      'isCallbackUrl(content)',
      'handleWorkflowCommandIfAny',
      'parseSlashCommandInvocation',
      'findPendingAskByAnchor',
    ]) {
      const markerIdx = region.indexOf(marker);
      expect(markerIdx).toBeGreaterThanOrEqual(0);
      expect(clearIdx).toBeLessThan(markerIdx);
    }
  });

  it('attentionWaitSince prefers agent raise time and falls back safely', () => {
    expect(attentionWaitSince({ agentAttention: { at: 1234 }, lastMessageAt: 9999 })).toBe(1234);
    expect(attentionWaitSince({ pendingRepo: true, lastMessageAt: 9999 })).toBe(9999);
    expect(attentionWaitSince({ agentAttention: { at: 'bad' }, lastMessageAt: 9999 })).toBe(9999);
    expect(attentionWaitSince({})).toBe(0);
  });
});

// The dashboard "open terminal" link is built from row.proxyPort (sessions.ts
// terminalHref), NOT buildTerminalUrl — so the row must carry the SAME advertised
// port the card links use, or the relay scenario gives a broken dashboard link.
describe('composeRowFromActive — advertised proxy port (WEB_EXTERNAL_PORT)', () => {
  afterEach(() => resetTerminalProxy());

  it('advertises WEB_EXTERNAL_PORT (relay port) to the dashboard, not the local proxy port', () => {
    setTerminalProxyPort(8800);     // local bound proxy port
    setTerminalExternalPort(9000);  // WEB_EXTERNAL_PORT + botIndex
    expect(composeRowFromActive(makeDs()).proxyPort).toBe(9000);
  });

  it('advertises the bound proxy port when WEB_EXTERNAL_PORT is unset', () => {
    setTerminalProxyPort(8800);
    expect(composeRowFromActive(makeDs()).proxyPort).toBe(8800);
  });

  it('omits proxyPort (→ frontend uses direct webPort) when the proxy never bound', () => {
    resetTerminalProxy();
    setTerminalExternalPort(9000);
    expect(composeRowFromActive(makeDs()).proxyPort).toBeUndefined();
  });
});
