/**
 * migrate-to-chat-endpoint.test.ts
 *
 * Integration test for the HTTP IPC endpoint `POST /api/sessions/migrate-to-chat`.
 * Spins up the real IPC server on a random port, registers a fake session in
 * the activeSessions registry, and verifies the endpoint enforces:
 *
 *   - 127.0.0.1 only (skipped — node loopback is always local in tests)
 *   - requesterLarkAppId must be a known bot
 *   - sourceAnchor must match a session this daemon owns
 *   - requestingUserOpenId must match the session's owner
 *   - On success, delegates to transferSession (we stub the body of it to
 *     observe arguments without actually touching tmux / forking workers).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

// Stub sessionStore writes so transferSession's persist call is a no-op.
vi.mock('../src/services/session-store.js', () => ({
  updateSession: vi.fn(),
  getSession: vi.fn(),
  listSessions: vi.fn(() => []),
}));

// Provide a known bots list for the requester-validation check.
vi.mock('../src/bot-registry.js', () => ({
  getAllBots: vi.fn(() => [
    { config: { larkAppId: 'cli_leader' } } as any,
    { config: { larkAppId: 'cli_peer' } } as any,
  ]),
  getBot: vi.fn(),
}));

// The endpoint identifies legitimate requesters via the cross-process
// online-daemon registry (`listOnlineDaemons`), NOT this process's local
// bot list — botmux runs one-daemon-per-bot, so a peer's `getAllBots()`
// only sees its OWN bot and cannot recognise the leader bot. Stub the
// registry so tests still exercise the requester-known happy path.
vi.mock('../src/utils/daemon-discovery.js', () => ({
  listOnlineDaemons: vi.fn(() => [
    { larkAppId: 'cli_leader', ipcPort: 0, lastHeartbeat: Date.now() },
    { larkAppId: 'cli_peer', ipcPort: 0, lastHeartbeat: Date.now() },
  ]),
  findOnlineDaemon: vi.fn(),
}));

// Stub the lark client just for `resolveUnionIdFromOpenId` — invoked by
// the lazy-backfill path when a peer session lacks ownerUnionId. Returning
// null lets the handler fall through to the open_id same-bot comparison
// (which works in these tests since they all use the same namespace).
vi.mock('../src/im/lark/client.js', () => ({
  getChatMode: vi.fn(),
  replyMessage: vi.fn(),
  sendMessage: vi.fn(),
  resolveUnionIdFromOpenId: vi.fn(async () => null),
}));

vi.mock('../src/core/dashboard-events.js', () => ({
  dashboardEventBus: { publish: vi.fn() },
}));

// We need transferSession to NOT actually fork. Stub forkWorker/killWorker at
// the module level — transferSession will call these via its DI parameters
// but we don't pass DI from the endpoint, so we have to neutralise them
// through bot-registry / cli-adapter so the real path is safe.
// Simpler: stub forkWorker via vi.mock since this is an endpoint integration
// test and we don't care about exercising the spawn machinery.
vi.mock('../src/core/worker-pool.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/core/worker-pool.js')>();
  return {
    ...orig,
    forkWorker: vi.fn(),
    killWorker: vi.fn(),
  };
});

import { startIpcServer, setLarkAppId } from '../src/core/dashboard-ipc-server.js';
import { setActiveSessionsRegistry } from '../src/core/worker-pool.js';
import { sessionKey } from '../src/core/types.js';
import type { DaemonSession } from '../src/core/types.js';
import type { Session } from '../src/types.js';

let server: { port: number; close: () => Promise<void> };
let baseUrl: string;
let registry: Map<string, DaemonSession>;

function makeDs(): DaemonSession {
  const session: Session = {
    sessionId: 'sess-peer-1',
    chatId: 'oc_source',
    rootMessageId: 'om_thread_root',
    title: 'peer session',
    status: 'active',
    createdAt: new Date().toISOString(),
    scope: 'thread',
    chatType: 'group',
    larkAppId: 'cli_peer',
    ownerOpenId: 'ou_owner',
    workingDir: '/tmp/peer',
    cliId: 'claude-code',
  };
  return {
    session,
    worker: null,
    workerPort: null,
    workerToken: null,
    larkAppId: 'cli_peer',
    chatId: 'oc_source',
    chatType: 'group',
    scope: 'thread',
    spawnedAt: Date.now(),
    cliVersion: '1.0.0',
    lastMessageAt: Date.now(),
    hasHistory: true,
    workingDir: '/tmp/peer',
    lastScreenStatus: 'idle',
  } as DaemonSession;
}

const validBody = () => ({
  sourceAnchor: 'om_thread_root',
  targetChatId: 'oc_target',
  targetRootMessageId: 'om_M1',
  requesterLarkAppId: 'cli_leader',
  requestingUserOpenId: 'ou_owner',
});

async function postMigrate(body: unknown): Promise<{ status: number; body: any }> {
  const r = await fetch(`${baseUrl}/api/sessions/migrate-to-chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
}

beforeAll(async () => {
  // The peer daemon represents itself as cli_peer.
  setLarkAppId('cli_peer');
  server = await startIpcServer({ port: 0, host: '127.0.0.1' });
  baseUrl = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  await server.close();
});

beforeEach(() => {
  vi.clearAllMocks();
  registry = new Map();
  setActiveSessionsRegistry(registry);
});

describe('POST /api/sessions/migrate-to-chat', () => {
  it('400 when a required field is missing', async () => {
    const r = await postMigrate({ sourceAnchor: 'om_thread_root' });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('missing_field');
  });

  it('403 when requesterLarkAppId is not a known bot', async () => {
    const ds = makeDs();
    registry.set(sessionKey('om_thread_root', 'cli_peer'), ds);

    const r = await postMigrate({ ...validBody(), requesterLarkAppId: 'cli_unknown' });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('unknown_requester');
  });

  it('404 when no session matches sourceAnchor in this daemon', async () => {
    // Registry empty — peer has no session at the requested anchor.
    const r = await postMigrate(validBody());
    expect(r.status).toBe(404);
    expect(r.body.error).toBe('no_session_at_anchor');
  });

  it('403 when requestingUserOpenId is not the session owner', async () => {
    const ds = makeDs();
    registry.set(sessionKey('om_thread_root', 'cli_peer'), ds);

    const r = await postMigrate({ ...validBody(), requestingUserOpenId: 'ou_other' });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('not_session_owner');
  });

  // Note: the happy-path "200 + delegates to transferSession" assertion
  // is intentionally NOT tested here. The endpoint hands a vetted call into
  // `transferSession()`, which internally invokes the real `forkWorker`
  // (binding resolved at module-declaration time, so vi.mock of the export
  // doesn't intercept the internal closure). Exercising forkWorker means
  // actually spawning a child process and attaching tmux — explicitly out
  // of scope for unit tests. transferSession's behaviour is covered in
  // `transfer-session.test.ts` (via its forkWorkerImpl / killWorkerImpl DI
  // overrides), and the integration of the two layers is covered at E2E.

  it('404 when sourceAnchor matches a session owned by a different daemon', async () => {
    // This daemon presents itself as cli_peer (set in beforeAll). A session
    // belonging to cli_other at the same rootMessageId must NOT be found —
    // each daemon only authorises moves of its own sessions.
    const ds = makeDs();
    ds.larkAppId = 'cli_other';
    ds.session.larkAppId = 'cli_other';
    registry.set(sessionKey('om_thread_root', 'cli_other'), ds);

    const r = await postMigrate(validBody());
    expect(r.status).toBe(404);
    expect(r.body.error).toBe('no_session_at_anchor');
  });
});
