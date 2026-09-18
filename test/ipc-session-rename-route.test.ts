/**
 * Narrow-capability aperture + handler semantics for
 * POST /api/sessions/:sessionId/rename when invoked by the in-session CLI
 * (`botmux session rename`, source:'agent').
 *
 * The route predates this entry (dashboard inline edit); what is new is that
 * the path is admitted through routeHasNarrowUntrustedAuth, so a sandboxed CLI
 * presenting its rotating per-turn capability reaches the handler. The
 * handler's sessionCliIpcAuth still binds the capability to the URL session
 * id — these tests pin both sides.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  setIpcAuthSecret,
  startIpcServer,
  type IpcServerHandle,
} from '../src/core/dashboard-ipc-server.js';
import { daemonIpcAuthHeaders } from '../src/core/daemon-ipc-auth.js';
import * as workerPool from '../src/core/worker-pool.js';
import * as sessionStore from '../src/services/session-store.js';
import { config } from '../src/config.js';
import { SESSION_TITLE_MAX } from '../src/core/session-board.js';

const SECRET = 'session-rename-narrow-secret';
const CAP_A = 'ab12cd34'.repeat(8);
const CAP_B = 'ef56ab78'.repeat(8);

let handle: IpcServerHandle | null = null;
let dataDir: string | null = null;
let prevDataDir: string | null = null;
let findSpy: ReturnType<typeof vi.spyOn> | null = null;

afterEach(async () => {
  if (handle) await handle.close();
  handle = null;
  setIpcAuthSecret(null);
  findSpy?.mockRestore();
  findSpy = null;
  sessionStore.init();
  if (prevDataDir !== null) config.session.dataDir = prevDataDir;
  prevDataDir = null;
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  dataDir = null;
  vi.restoreAllMocks();
});

function setupStore(): ReturnType<typeof sessionStore.createSession>[] {
  dataDir = mkdtempSync(join(tmpdir(), 'ipc-session-rename-'));
  prevDataDir = config.session.dataDir;
  config.session.dataDir = dataDir;
  sessionStore.init();
  const a = sessionStore.createSession('oc_rename_a', 'om_rename_a', '旧标题 A', 'group');
  const b = sessionStore.createSession('oc_rename_b', 'om_rename_b', '旧标题 B', 'group');
  return [a, b];
}

function activeFor(
  session: ReturnType<typeof sessionStore.createSession>,
  capability: string,
  opts: { connected?: boolean; initConfig?: Record<string, unknown> } = {},
): any {
  return {
    session,
    worker: opts.connected === false
      ? null
      : { killed: false, connected: true, send: vi.fn() },
    initConfig: opts.initConfig,
    workerPort: 1234,
    workerToken: 'token',
    larkAppId: 'app',
    chatId: session.chatId,
    chatType: 'group',
    scope: 'thread',
    spawnedAt: Date.now(),
    cliVersion: '1',
    lastMessageAt: Date.now(),
    hasHistory: true,
    managedTurnOrigin: { capability },
  } as any;
}

async function startAuthServer(): Promise<void> {
  setIpcAuthSecret(SECRET);
  handle = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true });
}

function postRename(
  sessionId: string,
  body: Record<string, unknown>,
  opts: { trustedHost?: boolean } = {},
): Promise<Response> {
  const path = `/api/sessions/${encodeURIComponent(sessionId)}/rename`;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.trustedHost) {
    const auth = daemonIpcAuthHeaders({ secret: SECRET, port: handle!.port, method: 'POST', path, headers });
    auth.forEach((value, key) => { headers[key] = value; });
  }
  return fetch(`http://127.0.0.1:${handle!.port}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

describe('POST /api/sessions/:sessionId/rename — narrow capability aperture', () => {
  it('admits the current-turn capability of the URL session through the sandbox aperture', async () => {
    const [a] = setupStore();
    findSpy = vi.spyOn(workerPool, 'findActiveBySessionId').mockImplementation(
      (id: string) => (id === a.sessionId
        ? activeFor(a, CAP_A, { initConfig: { cliId: 'codex', cliPathOverride: '/bin/codex', backendType: 'tmux' } })
        : undefined),
    );
    await startAuthServer();

    const res = await postRename(a.sessionId, { title: '排障｜支付链路超时', source: 'agent', originCapability: CAP_A });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      title: '排障｜支付链路超时',
      titleSource: 'agent',
      agentSync: 'requested',
    });
    expect(sessionStore.getSession(a.sessionId)).toMatchObject({
      title: '排障｜支付链路超时',
      titleSource: 'agent',
    });
  });

  it('403s when the capability belongs to a different session id (URL id is bound)', async () => {
    const [a, b] = setupStore();
    findSpy = vi.spyOn(workerPool, 'findActiveBySessionId').mockImplementation(
      (id: string) => {
        if (id === a.sessionId) return activeFor(a, CAP_A);
        if (id === b.sessionId) return activeFor(b, CAP_B);
        return undefined;
      },
    );
    await startAuthServer();

    // Capability of A presented against URL id B.
    const res = await postRename(b.sessionId, { title: '伪造标题', source: 'agent', originCapability: CAP_A });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ ok: false, error: 'origin_unproven' });
    expect(sessionStore.getSession(b.sessionId)).toMatchObject({ title: '旧标题 B' });

    // A missing/foreign URL id gets the same opaque denial — no session probe.
    const resMissing = await postRename('sess-does-not-exist', { title: 'x', originCapability: CAP_A });
    expect(resMissing.status).toBe(403);
  });
});

describe('POST /api/sessions/:sessionId/rename — handler semantics', () => {
  it('rejects an empty title with 400 after auth', async () => {
    const [a] = setupStore();
    findSpy = vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue(activeFor(a, CAP_A));
    await startAuthServer();

    const res = await postRename(a.sessionId, { title: '   ', source: 'agent', originCapability: CAP_A });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, error: 'bad_title' });
    expect(sessionStore.getSession(a.sessionId)).toMatchObject({ title: '旧标题 A' });
  });

  it(`truncates an over-long title to SESSION_TITLE_MAX=${SESSION_TITLE_MAX} and still succeeds`, async () => {
    const [a] = setupStore();
    findSpy = vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue(
      activeFor(a, CAP_A, { initConfig: { cliId: 'codex', cliPathOverride: '/bin/codex', backendType: 'tmux' } }),
    );
    await startAuthServer();

    const longTitle = '标'.repeat(SESSION_TITLE_MAX + 50);
    const res = await postRename(a.sessionId, { title: longTitle, source: 'agent', originCapability: CAP_A });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.title).toHaveLength(SESSION_TITLE_MAX);
    expect(sessionStore.getSession(a.sessionId)?.title).toHaveLength(SESSION_TITLE_MAX);
  });

  it('updates the canonical title with no live worker and reports agentSync not_running (trusted host)', async () => {
    const [a] = setupStore();
    findSpy = vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue(undefined);
    await startAuthServer();

    const res = await postRename(a.sessionId, { title: '开发｜权限黑名单', source: 'agent' }, { trustedHost: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      title: '开发｜权限黑名单',
      titleSource: 'agent',
      agentSync: 'not_running',
    });
    const stored = sessionStore.getSession(a.sessionId);
    expect(stored).toMatchObject({ title: '开发｜权限黑名单', titleSource: 'agent' });
  });

  it('keeps canonical success when the live backend cannot rename natively (riff → unsupported)', async () => {
    const [a] = setupStore();
    const active = activeFor(a, CAP_A, { initConfig: { cliId: 'codex', backendType: 'riff' } });
    findSpy = vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue(active);
    await startAuthServer();

    const res = await postRename(a.sessionId, { title: '排障｜远端任务超时', source: 'agent', originCapability: CAP_A });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      title: '排障｜远端任务超时',
      titleSource: 'agent',
      agentSync: 'unsupported',
    });
    expect(sessionStore.getSession(a.sessionId)).toMatchObject({
      title: '排障｜远端任务超时',
      titleSource: 'agent',
    });
    expect(active.worker.send).not.toHaveBeenCalled();
  });
});
