/**
 * How the gateway reads the dedicated core's answer to a Dashboard host control
 * (requestWecomCoreSessionAction): only restart / resume / suspend, and only the
 * exact answer "404 session_not_active", count as the definite refusal
 * `sessionGone`; and the core's real IPC server does give that answer for a
 * session that is not in its active registry.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { requestWecomCoreSessionAction } from '../src/im/wecom/gateway/command.js';
import { setIpcAuthSecret, setLarkAppId, startIpcServer, type IpcServerHandle } from '../src/core/dashboard-ipc-server.js';

const CORE_PORT = 19123;
const SESSION_ID = 'sid-gone-1';

/** The dedicated core answering every request with `status` and the raw `body`. */
function coreAnswering(status: number, body: string) {
  return vi.fn(async (_port: number, _path: string, _init?: RequestInit, _secret?: string) => (
    new Response(body, { status, headers: { 'content-type': 'application/json' } })
  ));
}

const NOT_ACTIVE = JSON.stringify({ ok: false, error: 'session_not_active' });

describe('requestWecomCoreSessionAction: the definite "session no longer active" answer', () => {
  it.each(['restart', 'resume', 'suspend'] as const)('%s: 404 session_not_active reports sessionGone', async operation => {
    const request = coreAnswering(404, NOT_ACTIVE);

    const result = await requestWecomCoreSessionAction({ corePort: CORE_PORT, sessionId: SESSION_ID, operation, request });

    expect(result).toEqual({ ok: false, sessionGone: true });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['404 with another error', 404, JSON.stringify({ ok: false, error: 'not_found' })],
    ['404 without an error field', 404, JSON.stringify({ ok: false })],
    ['404 whose body is not JSON', 404, 'session_not_active'],
    ['404 whose body is a JSON string', 404, JSON.stringify('session_not_active')],
    ['409 naming session_not_active', 409, NOT_ACTIVE],
    ['500 naming session_not_active', 500, NOT_ACTIVE],
  ])('restart: %s is a plain failure, not sessionGone', async (_name, status, body) => {
    const result = await requestWecomCoreSessionAction({
      corePort: CORE_PORT,
      sessionId: SESSION_ID,
      operation: 'restart',
      request: coreAnswering(status, body),
    });

    expect(result).toEqual({ ok: false });
  });

  it.each(['close', 'archive', 'delete'] as const)('%s: even 404 session_not_active is a plain failure', async operation => {
    const result = await requestWecomCoreSessionAction({
      corePort: CORE_PORT,
      sessionId: SESSION_ID,
      operation,
      request: coreAnswering(404, NOT_ACTIVE),
    });

    expect(result).toEqual({ ok: false });
  });

  it('a request that never gets an answer (timeout, no connection) still rejects', async () => {
    const request = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });

    await expect(requestWecomCoreSessionAction({
      corePort: CORE_PORT,
      sessionId: SESSION_ID,
      operation: 'suspend',
      request,
    })).rejects.toThrow('fetch failed');
  });
});

describe('the core IPC server answers restart / wake / suspend of a session it does not have', () => {
  const SECRET = 'wecom-core-session-gone-secret';
  let server: IpcServerHandle | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
    setIpcAuthSecret(null);
    setLarkAppId('');
  });

  // The real route through the gateway's real signed client: the core answers
  // 404 session_not_active, which the gateway reads as sessionGone.
  it.each(['restart', 'resume', 'suspend'] as const)('%s reaches the core and comes back as sessionGone', async operation => {
    setLarkAppId('local_wecom_session_gone');
    setIpcAuthSecret(SECRET);
    server = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true, coreOnlyPublicRoutes: true });

    const result = await requestWecomCoreSessionAction({
      corePort: server.port,
      sessionId: 'closed-session',
      operation,
      secret: SECRET,
    });

    expect(result).toEqual({ ok: false, sessionGone: true });
  });
});
