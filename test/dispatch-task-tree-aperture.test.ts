// `botmux dispatch` / `botmux dispatch tree` task-tree route aperture.
//
// The orchestrating CLI runs inside the agent process. Sandboxed (Linux bwrap)
// and read-isolated (macOS) sessions cannot read the host HMAC secret, so the
// session-scoped task-tree route is called with this session's rotating
// per-turn capability. If it is missing from `routeHasNarrowUntrustedAuth`,
// the outer gate answers a bare 401 `unauthorized` before the handler runs, and
// the whole card feature silently never appears for isolated sessions.
//
// These tests run the REAL routes behind startIpcServer({ authRequired: true }):
// an unsigned request must reach the handler (a handler-level 403, never the
// outer 401), and a live capability reaches the handler body (200). The
// daemon-to-daemon refresh route stays behind the host HMAC (401).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  routeHasNarrowUntrustedAuth,
  setIpcAuthSecret,
  setLarkAppId,
  startIpcServer,
  type IpcServerHandle,
} from '../src/core/dashboard-ipc-server.js';
import { setActiveSessionsRegistry } from '../src/core/worker-pool.js';

const CAP = 'a1b2c3d4'.repeat(8);
const TURN_ID = 'om_dispatch_tree_live';
const SESSION_ID = 'sess-dispatch-tree-aperture';
const APP_ID = 'cli_dispatch_tree_test';

let handle: IpcServerHandle | null = null;
let tempDir: string;
const activeSessions = new Map<string, unknown>();

async function post(path: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(`http://127.0.0.1:${handle!.port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'dispatch-tree-aperture-'));
  delete process.env.BOTMUX_DISPATCH_TASK_TREE_CARD_ENABLED;
  process.env.SESSION_DATA_DIR = tempDir;
  activeSessions.clear();
  activeSessions.set(SESSION_ID, {
    session: { sessionId: SESSION_ID, title: '编排', status: 'active' },
    larkAppId: APP_ID,
    chatId: 'oc_dispatch_tree_group',
    managedTurnOrigin: { capability: CAP, turnId: TURN_ID },
  });
  setActiveSessionsRegistry(activeSessions as never);
  setLarkAppId(APP_ID);
  setIpcAuthSecret('test-ipc-dispatch-tree-aperture-host-secret');
  handle = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true });
});

afterEach(async () => {
  if (handle) await handle.close();
  handle = null;
  setActiveSessionsRegistry(undefined);
  setIpcAuthSecret(null);
  delete process.env.SESSION_DATA_DIR;
  delete process.env.BOTMUX_DISPATCH_TASK_TREE_CARD_ENABLED;
  rmSync(tempDir, { recursive: true, force: true });
});

describe('dispatch-tree IPC aperture', () => {
  it('admits only POST /api/sessions/:id/dispatch-tree, never the daemon refresh route', () => {
    expect(routeHasNarrowUntrustedAuth('POST', `/api/sessions/${SESSION_ID}/dispatch-tree`)).toBe(true);
    expect(routeHasNarrowUntrustedAuth('GET', `/api/sessions/${SESSION_ID}/dispatch-tree`)).toBe(false);
    expect(routeHasNarrowUntrustedAuth('POST', `/api/sessions/${SESSION_ID}/dispatch-tree/x`)).toBe(false);
    // The report-driven refresh is daemon-to-daemon: both ends hold the secret.
    expect(routeHasNarrowUntrustedAuth('POST', '/api/dispatch-tree/refresh')).toBe(false);
  });

  it('an unsigned request reaches the handler, which refuses an unproven origin (403, never outer 401)', async () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      [`/api/sessions/${SESSION_ID}/dispatch-tree`, { sessionId: SESSION_ID }],
      [`/api/sessions/${SESSION_ID}/dispatch-tree`, { sessionId: SESSION_ID, originCapability: 'deadbeef'.repeat(8), originTurnId: TURN_ID }],
      // A capability minted for our session must not drive another session id.
      ['/api/sessions/someone-else/dispatch-tree', { sessionId: 'someone-else', originCapability: CAP, originTurnId: TURN_ID }],
    ];
    for (const [path, body] of cases) {
      const res = await post(path, body);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ ok: false, error: 'origin_unproven' });
    }
  });

  it('the live per-turn capability reaches the handler body when the card switch is on (200, not outer 401)', async () => {
    process.env.BOTMUX_DISPATCH_TASK_TREE_CARD_ENABLED = 'true';
    try {
      const res = await post(`/api/sessions/${SESSION_ID}/dispatch-tree`, {
        sessionId: SESSION_ID,
        originCapability: CAP,
        originTurnId: TURN_ID,
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true, enabled: true, posted: false, nodes: 0 });
    } finally {
      delete process.env.BOTMUX_DISPATCH_TASK_TREE_CARD_ENABLED;
    }
  });

  it('default-off: live capability gets enabled:false + hint and writes no card record and no kind label', async () => {
    const registryPath = join(tempDir, 'orchestrate-dispatch.json');
    writeFileSync(registryPath, JSON.stringify({
      om_root: { orchSessionId: SESSION_ID, targetChatId: 'oc_x', targetAppIds: [APP_ID], title: 't', status: 'accepted', createdAt: '1' },
    }));
    const cardRecordPath = join(tempDir, 'dispatch-task-tree-cards.json');
    const res = await post(`/api/sessions/${SESSION_ID}/dispatch-tree`, {
      sessionId: SESSION_ID,
      originCapability: CAP,
      originTurnId: TURN_ID,
      dispatchRoot: 'om_root',
      kind: 'review',
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, enabled: false, posted: false, nodes: 0 });
    expect(typeof body.hint).toBe('string');
    expect(body.hint).toContain('任务树卡片');
    // No card record file and the kind label was not persisted.
    expect(existsSync(cardRecordPath)).toBe(false);
    const entry = JSON.parse(readFileSync(registryPath, 'utf8')).om_root as Record<string, unknown>;
    expect(entry.kind).toBeUndefined();
  });

  it('the daemon refresh route without the host secret stays at the outer 401', async () => {
    const res = await post('/api/dispatch-tree/refresh', { orchSessionId: SESSION_ID });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ ok: false, error: 'unauthorized' });
  });
});
