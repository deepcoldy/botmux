// Runtime-scope gating on the daemon's CLI lifecycle hook routes.
//
// `session-ready` is a session-contract signal: it is forwarded only when the
// controller can attribute the hook to the current runtime, and it carries the
// proven scope as `sessionCommand`. `claude-compaction-start` is not part of
// the contract (pre-contract CLIs send it without a binding ID), so it keeps
// master's ungated forwarding even when the session has a controller.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  setIpcAuthSecret,
  startIpcServer,
  type IpcServerHandle,
} from '../src/core/dashboard-ipc-server.js';
import { daemonIpcAuthHeaders } from '../src/core/daemon-ipc-auth.js';
import { acknowledgeSessionReady } from '../src/core/session-ready-handshake.js';

const controllers = vi.hoisted(() => new WeakMap<object, { nativeSignal: (...args: unknown[]) => unknown }>());
vi.mock('../src/core/session-controller.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/core/session-controller.js')>()),
  controllerForSession: (ds: object) => controllers.get(ds),
}));

const { __testOnly_activeSessions } = await import('../src/daemon.js');

const HOST_SECRET = 'test-ipc-session-lifecycle-scope-host-secret';
const SESSION_ID = 'sess-lifecycle-scope';
const STARTED_AT_MS = Date.now() - 1_000;

let handle: IpcServerHandle | null = null;
let workerSend: ReturnType<typeof vi.fn>;
let nativeSignal: ReturnType<typeof vi.fn>;

function mountSession(scope: unknown): void {
  nativeSignal = vi.fn(() => scope);
  const ds = { session: { sessionId: SESSION_ID }, worker: { send: workerSend } };
  controllers.set(ds, { nativeSignal });
  __testOnly_activeSessions.set(SESSION_ID, ds as never);
}

async function post(path: string, body: Record<string, unknown>): Promise<Response> {
  const headers = daemonIpcAuthHeaders({
    secret: HOST_SECRET,
    port: handle!.port,
    method: 'POST',
    path,
    headers: { 'content-type': 'application/json' },
  });
  return fetch(`http://127.0.0.1:${handle!.port}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
}

const HOOK = { sessionId: SESSION_ID, runtimeBindingId: 'binding-stale', nativeSessionId: 'native-1' };

beforeEach(async () => {
  workerSend = vi.fn((msg: { requestId?: string }) => {
    if (msg.requestId) acknowledgeSessionReady(msg.requestId);
  });
  setIpcAuthSecret(HOST_SECRET);
  handle = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true });
});

afterEach(async () => {
  if (handle) await handle.close();
  handle = null;
  __testOnly_activeSessions.clear();
  setIpcAuthSecret(null);
  vi.restoreAllMocks();
});

describe('lifecycle hook runtime scope', () => {
  it('drops a session-ready hook the controller cannot attribute to the current runtime', async () => {
    mountSession(undefined);
    const res = await post('/api/session-ready', { ...HOOK, source: 'hook' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ignored: 'runtime_scope_unproven' });
    expect(nativeSignal).toHaveBeenCalledWith('binding-stale', 'native-1');
    expect(workerSend).not.toHaveBeenCalled();
  });

  it('forwards a proven session-ready hook with its runtime scope', async () => {
    const scope = { version: 2, runtime: { runtimeId: 'rt-1', epoch: 1 } };
    mountSession(scope);
    const res = await post('/api/session-ready', { ...HOOK, source: 'hook' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(workerSend).toHaveBeenCalledWith({ type: 'session_ready', source: 'hook', requestId: expect.any(String), sessionCommand: scope });
  });

  it('forwards compaction start without consulting the runtime scope', async () => {
    mountSession(undefined);
    const res = await post('/api/claude-compaction-start-v1', { ...HOOK, startedAtMs: STARTED_AT_MS });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(nativeSignal).not.toHaveBeenCalled();
    expect(workerSend).toHaveBeenCalledWith({ type: 'claude_compaction_start', startedAtMs: STARTED_AT_MS, requestId: expect.any(String) });
  });
});
