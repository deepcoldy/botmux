import type { IncomingMessage } from 'node:http';
import { Readable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import {
  DISPATCH_LAUNCH_IPC_DOMAIN,
  DISPATCH_LAUNCH_IPC_BODY_LIMIT_BYTES,
  DISPATCH_LAUNCH_IPC_HEADERS,
  canonicalDispatchLaunchIpcMaterial,
  createDispatchLaunchIpcNonceStore,
  signDispatchLaunchIpcRequest,
  signDispatchLaunchIpcResponse,
  verifyDispatchLaunchIpcRequestSignature,
  verifyDispatchLaunchIpcResponseSignature,
  verifyDispatchLaunchIpcRequest,
  type DispatchLaunchIpcClock,
} from '../src/core/dispatch-launch-ipc-auth.js';

const target = {
  larkAppId: 'cli_target',
  ipcPort: 4100,
  bootInstanceId: 'A'.repeat(43),
};
const request = {
  secret: 'secret',
  timestamp: '1788350400000',
  nonce: 'B'.repeat(43),
  method: 'POST',
  pathWithQuery: '/__dispatch-launch-ipc/v1/operations/dl_x/prepare',
  body: '{"dispatchId":"dl_x"}',
  target,
};
const NOW = Number(request.timestamp);
const clock: DispatchLaunchIpcClock = { now: () => NOW };

function makeRequest(input: {
  body?: string | Uint8Array; headers?: Record<string, string | string[] | undefined>;
  remoteAddress?: string; localPort?: number; signedBody?: string | Uint8Array;
  signedPath?: string; signedTarget?: typeof target; nonce?: string;
} = {}): IncomingMessage {
  const body = input.body ?? request.body;
  const bytes = typeof body === 'string' ? Buffer.from(body) : Buffer.from(body);
  const nonce = input.nonce ?? request.nonce;
  const signature = signDispatchLaunchIpcRequest({
    ...request, nonce, body: input.signedBody ?? bytes,
    pathWithQuery: input.signedPath ?? request.pathWithQuery,
    target: input.signedTarget ?? target,
  });
  return Object.assign(Readable.from([bytes]), {
    method: request.method, url: request.pathWithQuery,
    headers: {
      [DISPATCH_LAUNCH_IPC_HEADERS.timestamp]: request.timestamp,
      [DISPATCH_LAUNCH_IPC_HEADERS.nonce]: nonce,
      [DISPATCH_LAUNCH_IPC_HEADERS.signature]: signature,
      ...input.headers,
    },
    socket: { remoteAddress: input.remoteAddress ?? '127.0.0.1', localPort: input.localPort ?? target.ipcPort },
  }) as unknown as IncomingMessage;
}

function verify(req: IncomingMessage, store = createDispatchLaunchIpcNonceStore(clock)) {
  return verifyDispatchLaunchIpcRequest(req, {
    secret: request.secret,
    target: { larkAppId: target.larkAppId, bootInstanceId: target.bootInstanceId },
    nonceStore: store, clock,
  });
}

describe('dispatch launch IPC signing contract', () => {
  it('uses a dedicated domain and binds exact request bytes plus target boot', () => {
    expect(canonicalDispatchLaunchIpcMaterial(request)).toContain(DISPATCH_LAUNCH_IPC_DOMAIN);
    const signature = signDispatchLaunchIpcRequest(request);
    expect(verifyDispatchLaunchIpcRequestSignature({ ...request, signature })).toBe(true);
    expect(verifyDispatchLaunchIpcRequestSignature({ ...request, body: '{}', signature })).toBe(false);
    expect(verifyDispatchLaunchIpcRequestSignature({
      ...request, target: { ...target, bootInstanceId: 'C'.repeat(43) }, signature,
    })).toBe(false);
  });

  it('signs responses in a separate domain and binds status and request nonce', () => {
    const response = {
      secret: request.secret,
      requestNonce: request.nonce,
      method: request.method,
      pathWithQuery: request.pathWithQuery,
      status: 200,
      body: '{"ok":true}',
      target,
    };
    const signature = signDispatchLaunchIpcResponse(response);
    expect(verifyDispatchLaunchIpcResponseSignature({ ...response, signature })).toBe(true);
    expect(verifyDispatchLaunchIpcResponseSignature({ ...response, status: 409, signature })).toBe(false);
    expect(verifyDispatchLaunchIpcResponseSignature({
      ...response, requestNonce: 'D'.repeat(43), signature,
    })).toBe(false);
  });

  it('rejects malformed target audiences and nonces', () => {
    expect(() => signDispatchLaunchIpcRequest({ ...request, nonce: 'short' })).toThrow('nonce');
    expect(() => signDispatchLaunchIpcRequest({
      ...request, target: { ...target, ipcPort: 0 },
    })).toThrow('target descriptor');
    expect(verifyDispatchLaunchIpcRequestSignature({
      ...request, nonce: 'short', signature: 'X'.repeat(43),
    })).toBe(false);
    expect(verifyDispatchLaunchIpcRequestSignature({
      ...request, target: { ...target, ipcPort: 0 }, signature: 'X'.repeat(43),
    })).toBe(false);
    expect(verifyDispatchLaunchIpcResponseSignature({
      secret: request.secret, requestNonce: 'short', method: 'POST',
      pathWithQuery: request.pathWithQuery, status: 99, body: '{}', target,
      signature: 'X'.repeat(43),
    })).toBe(false);
  });
});

describe('dispatch launch IPC request verifier', () => {
  it('accepts exact bytes once and rejects a replay', async () => {
    const store = createDispatchLaunchIpcNonceStore(clock);
    await expect(verify(makeRequest(), store)).resolves.toEqual({
      ok: true, bodyRaw: request.body, nonce: request.nonce, target,
    });
    await expect(verify(makeRequest(), store)).resolves.toEqual({
      ok: false, reason: 'replay', httpStatus: 401,
    });
  });

  it('rejects peer, path, target, and body tampering', async () => {
    await expect(verify(makeRequest({ remoteAddress: '192.0.2.1' }))).resolves
      .toEqual({ ok: false, reason: 'remote_not_loopback', httpStatus: 403 });
    await expect(verify(makeRequest({ signedPath: '/wrong' }))).resolves
      .toEqual({ ok: false, reason: 'signature_mismatch', httpStatus: 401 });
    await expect(verify(makeRequest({ signedTarget: { ...target, ipcPort: 4101 } }))).resolves
      .toEqual({ ok: false, reason: 'signature_mismatch', httpStatus: 401 });
    await expect(verify(makeRequest({ body: '{}', signedBody: '{"different":true}' }))).resolves
      .toEqual({ ok: false, reason: 'signature_mismatch', httpStatus: 401 });
  });

  it('bounds body bytes and rejects framing ambiguity or invalid UTF-8', async () => {
    await expect(verify(makeRequest({
      headers: { 'content-length': String(DISPATCH_LAUNCH_IPC_BODY_LIMIT_BYTES + 1) },
    }))).resolves.toEqual({ ok: false, reason: 'body_too_large', httpStatus: 413 });
    await expect(verify(makeRequest({
      headers: { 'content-length': '2', 'transfer-encoding': 'chunked' },
    }))).resolves.toEqual({ ok: false, reason: 'body_length_mismatch', httpStatus: 400 });
    const invalid = Buffer.from([0xc3, 0x28]);
    await expect(verify(makeRequest({ body: invalid, signedBody: invalid }))).resolves
      .toEqual({ ok: false, reason: 'body_not_utf8', httpStatus: 400 });
  });
});
