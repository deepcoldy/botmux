import { describe, expect, it } from 'vitest';

import {
  DISPATCH_LAUNCH_IPC_DOMAIN,
  canonicalDispatchLaunchIpcMaterial,
  signDispatchLaunchIpcRequest,
  signDispatchLaunchIpcResponse,
  verifyDispatchLaunchIpcRequestSignature,
  verifyDispatchLaunchIpcResponseSignature,
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
  });
});
