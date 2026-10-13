import { describe, expect, it, vi } from 'vitest';

import {
  dispatchLaunchIpcHeaders,
  signDispatchLaunchIpcResponse,
} from '../src/core/dispatch-launch-ipc-auth.js';
import {
  DispatchLaunchIpcTransportError,
  dispatchLaunchIpcPath,
  dispatchLaunchIpcTarget,
  requestDispatchLaunchIpc,
} from '../src/core/dispatch-launch-ipc-client.js';

const SECRET = 'secret';
const NONCE = 'n'.repeat(43);
const TIMESTAMP = '1700000000123';
const dispatchId = `dl_${'a'.repeat(32)}`;
const daemon = {
  larkAppId: 'cli_target', ipcPort: 32123, bootInstanceId: 'b'.repeat(43),
  dispatchLaunchIpcProtocol: 'v1' as const,
};

function response(bodyRaw: string, status: number, pathWithQuery: string): Response {
  return new Response(bodyRaw, {
    status,
    headers: {
      'X-Botmux-Dispatch-Launch-Ipc-Response-Signature': signDispatchLaunchIpcResponse({
        secret: SECRET, requestNonce: NONCE, method: 'POST', pathWithQuery, status,
        body: bodyRaw, target: daemon,
      }),
    },
  });
}

describe('dispatch launch IPC client', () => {
  it('fails closed when the target descriptor does not advertise v1', () => {
    expect(() => dispatchLaunchIpcTarget({ ...daemon, dispatchLaunchIpcProtocol: undefined }))
      .toThrow(DispatchLaunchIpcTransportError);
    expect(() => dispatchLaunchIpcPath('../other', 'start')).toThrow('invalid dispatch launch id');
  });

  it('signs exact request bytes and verifies the response without retrying', async () => {
    const path = dispatchLaunchIpcPath(dispatchId, 'start');
    const body = { dispatchId, value: 'x' };
    const fetchImpl = vi.fn().mockResolvedValue(response('{"ok":true}', 202, path));
    await expect(requestDispatchLaunchIpc({
      daemon, dispatchId, action: 'start', body, secret: SECRET, nonce: NONCE,
      timestamp: TIMESTAMP, fetchImpl,
    })).resolves.toEqual({ ok: true, status: 202, bodyRaw: '{"ok":true}' });
    const expectedHeaders = dispatchLaunchIpcHeaders({
      secret: SECRET, method: 'POST', pathWithQuery: path, bodyRaw: JSON.stringify(body),
      target: daemon, nonce: NONCE, timestamp: TIMESTAMP,
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledWith(`http://127.0.0.1:${daemon.ipcPort}${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...expectedHeaders },
      body: JSON.stringify(body),
    });
  });

  it('rejects unsigned/tampered responses and does not transport-retry', async () => {
    await expect(requestDispatchLaunchIpc({
      daemon, dispatchId, action: 'cancel', secret: SECRET, nonce: NONCE,
      fetchImpl: vi.fn().mockResolvedValue(new Response('{"ok":true}', { status: 200 })),
    })).rejects.toThrow(/authentication failed/);
    const fetchImpl = vi.fn().mockRejectedValue(new Error('reset'));
    await expect(requestDispatchLaunchIpc({
      daemon, dispatchId, action: 'prepare', secret: SECRET, fetchImpl,
    })).rejects.toBeInstanceOf(DispatchLaunchIpcTransportError);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
