import { afterEach, describe, expect, it, vi } from 'vitest';
import { daemonIpcAuthHeaders } from '../src/core/daemon-ipc-auth.js';
import {
  setIpcAuthSecret,
  setSupervisorShutdownHandler,
  startIpcServer,
  type IpcServerHandle,
} from '../src/core/dashboard-ipc-server.js';
import { SUPERVISOR_SHUTDOWN_ROUTE } from '../src/core/supervisor-shutdown-ipc.js';

const SECRET = 'supervisor-loopback-test-secret';
const IDENTITY = {
  larkAppId: 'cli_loopback',
  bootInstanceId: 'boot-loopback',
  processStartIdentity: 'birth-loopback',
};

let server: IpcServerHandle | null = null;

afterEach(async () => {
  setSupervisorShutdownHandler(null);
  setIpcAuthSecret(null);
  if (server) await server.close();
  server = null;
});

async function signedPost(body: unknown): Promise<Response> {
  if (!server) throw new Error('test IPC server is not running');
  return fetch(`http://127.0.0.1:${server.port}${SUPERVISOR_SHUTDOWN_ROUTE}`, {
    method: 'POST',
    headers: daemonIpcAuthHeaders({
      secret: SECRET,
      port: server.port,
      method: 'POST',
      path: SUPERVISOR_SHUTDOWN_ROUTE,
      headers: { 'content-type': 'application/json' },
    }),
    body: JSON.stringify(body),
  });
}

describe('supervisor shutdown signed loopback handshake', () => {
  it('authenticates the real route and accepts only the registered boot/birth generation', async () => {
    setIpcAuthSecret(SECRET);
    server = await startIpcServer({
      port: 0,
      host: '127.0.0.1',
      authRequired: true,
      ready: Promise.resolve(),
    });

    const unsigned = await fetch(
      `http://127.0.0.1:${server.port}${SUPERVISOR_SHUTDOWN_ROUTE}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(IDENTITY),
      },
    );
    expect(unsigned.status).toBe(401);

    const beforeRegistration = await signedPost(IDENTITY);
    expect(beforeRegistration.status).toBe(503);

    const shutdown = vi.fn(async () => {});
    setSupervisorShutdownHandler({ ...IDENTITY, shutdown });

    const wrongBoot = await signedPost({ ...IDENTITY, bootInstanceId: 'boot-successor' });
    expect(wrongBoot.status).toBe(409);
    const wrongBirth = await signedPost({ ...IDENTITY, processStartIdentity: 'birth-successor' });
    expect(wrongBirth.status).toBe(409);
    expect(shutdown).not.toHaveBeenCalled();

    const accepted = await signedPost(IDENTITY);
    expect(accepted.status).toBe(202);
    expect(await accepted.json()).toEqual({
      ok: true,
      accepted: true,
      ...IDENTITY,
    });
    await vi.waitFor(() => expect(shutdown).toHaveBeenCalledOnce());
  });
});
