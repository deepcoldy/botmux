/**
 * Human closes through the dashboard / `botmux delete` IPC route
 * (`POST /api/sessions/:id/close`, empty body) must stamp `userClosedAt`, so the
 * topic's next message starts fresh instead of resuming the session. Idle
 * cleanup (`idleCleanup: true`) must stay resumable. Real session store + real
 * closeSession; only the IPC session auth is bypassed.
 *
 * Run: bun x vitest run --project unit test/topic-session-continuity-close-route.test.ts
 */
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

const env = vi.hoisted(() => {
  const root = `${process.env.TMPDIR ?? '/tmp'}/botmux-topic-cont-close-${process.pid}`;
  process.env.SESSION_DATA_DIR = `${root}/data`;
  process.env.BOTS_CONFIG = `${root}/data/bots.json`;
  return { root };
});

vi.mock('../src/core/daemon-ipc-session-auth.js', async original => ({
  ...await original<typeof import('../src/core/daemon-ipc-session-auth.js')>(),
  authorizeSessionScopedIpc: vi.fn(() => ({ ok: true })),
}));

import { rmSync } from 'node:fs';
import { startIpcServer, type IpcServerHandle } from '../src/core/dashboard-ipc-server.js';
import * as sessionStore from '../src/services/session-store.js';

sessionStore.init(process.env.TOPIC_CONT_APP ?? 'topic_cont_close_app');
import { findLatestClosedTopicSession, topicResumeBlockReason } from '../src/core/topic-session-continuity.js';

const APP = 'topic_cont_close_app';
const CHAT = 'oc_topic_cont_close';
let handle: IpcServerHandle | undefined;
let n = 0;

afterEach(async () => { await handle?.close(); handle = undefined; });
afterAll(() => rmSync(env.root, { recursive: true, force: true }));

async function closeViaRoute(body: Record<string, unknown>): Promise<{ root: string; sessionId: string }> {
  const root = `om_close_route_root_${++n}`;
  const session = sessionStore.createSession(CHAT, root, 'work', 'group');
  Object.assign(session, { larkAppId: APP, scope: 'thread', cliId: 'claude-code', cliSessionId: 'cli-work' });
  sessionStore.updateSession(session);
  handle ??= await startIpcServer({ port: 0, host: '127.0.0.1' });
  const res = await fetch(`http://127.0.0.1:${handle.port}/api/sessions/${session.sessionId}/close`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  expect((await res.json() as any).ok).toBe(true);
  return { root, sessionId: session.sessionId };
}

/** What the daemon's thread route asks for the next message in the topic. */
function nextMessageDecision(root: string): string | undefined {
  const previous = findLatestClosedTopicSession(sessionStore.listSessionsStrict(), { larkAppId: APP, chatId: CHAT, anchor: root });
  return previous ? (topicResumeBlockReason(previous) ?? 'resume') : 'no_previous';
}

describe('closing a topic session through POST /api/sessions/:id/close', () => {
  it('dashboard close (empty body) is a human close: the next topic message does not resume', async () => {
    const { root, sessionId } = await closeViaRoute({});
    expect(sessionStore.getSession(sessionId)?.userClosedAt).toBeTruthy();
    expect(nextMessageDecision(root)).toBe('user_closed');
  });

  it('`botmux delete` (the same route, empty body) is a human close too', async () => {
    const { root } = await closeViaRoute({});
    expect(nextMessageDecision(root)).toBe('user_closed');
  });

  it('idle cleanup stays resumable', async () => {
    const { root, sessionId } = await closeViaRoute({ idleCleanup: true });
    expect(sessionStore.getSession(sessionId)?.status).toBe('closed');
    expect(sessionStore.getSession(sessionId)?.userClosedAt).toBeUndefined();
    expect(nextMessageDecision(root)).toBe('resume');
  });

  async function humanReclose(sessionId: string) {
    const res = await fetch(`http://127.0.0.1:${handle!.port}/api/sessions/${sessionId}/close`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    expect((await res.json() as any).ok).toBe(true);
  }

  it('idle close, then a human dashboard close: the next topic message does not resume', async () => {
    const { root, sessionId } = await closeViaRoute({ idleCleanup: true });
    expect(nextMessageDecision(root)).toBe('resume');
    await humanReclose(sessionId);
    expect(sessionStore.getSession(sessionId)?.userClosedAt).toBeTruthy();
    expect(nextMessageDecision(root)).toBe('user_closed');
  });

  it('same when the idle-closed row carries the background-cleanup marker', async () => {
    const { root, sessionId } = await closeViaRoute({ idleCleanup: true });
    const row = sessionStore.getSession(sessionId)!;
    row.backgroundExecutionCleanupClosedAt = new Date().toISOString();
    sessionStore.updateSession(row);
    await humanReclose(sessionId);
    expect(sessionStore.getSession(sessionId)?.userClosedAt).toBeTruthy();
    expect(nextMessageDecision(root)).toBe('user_closed');
  });

  it('a repeated idle-cleanup close of a closed row never stamps userClosedAt', async () => {
    const { root, sessionId } = await closeViaRoute({ idleCleanup: true });
    const res = await fetch(`http://127.0.0.1:${handle!.port}/api/sessions/${sessionId}/close`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ idleCleanup: true }),
    });
    expect((await res.json() as any).ok).toBe(true);
    expect(nextMessageDecision(root)).toBe('resume');
  });
});
