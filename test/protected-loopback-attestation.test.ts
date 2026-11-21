import { describe, expect, it } from 'vitest';

import {
  createProtectedLoopbackProxyAttestation,
  verifyProtectedLoopbackProxyAttestation,
} from '../src/core/protected-loopback-attestation.js';

const secret = 'ab'.repeat(32);
const body = Buffer.from('{"mode":"user"}');
const headers = {
  'content-type': 'application/json',
  'x-botmux-lark-session': 'session-access-key',
};
const request = {
  sessionId: 'session-a',
  serviceId: 'lark-tool-identity',
  workerGeneration: 7,
  turnId: 'turn-a',
  dispatchAttempt: 3,
  peer: { pid: 321, procStart: '123456' },
  method: 'POST',
  path: '/api/sessions/session-a/lark-tool-identity',
  headers,
  body,
  issuedAtMs: 10_000,
  nonce: 'cd'.repeat(16),
} as const;
const expected = {
  sessionId: request.sessionId,
  serviceId: request.serviceId,
  workerGeneration: request.workerGeneration,
  turnId: request.turnId,
  dispatchAttempt: request.dispatchAttempt,
  method: request.method,
  path: request.path,
  headers,
  body,
  nowMs: 10_500,
  maxAgeMs: 1_000,
} as const;

describe('protected loopback proxy attestation', () => {
  it('binds the original host peer to the exact generation, turn, request headers and body', () => {
    const token = createProtectedLoopbackProxyAttestation(secret, request);

    expect(verifyProtectedLoopbackProxyAttestation(secret, token, expected)).toEqual(request.peer);
  });

  it.each([
    ['secret', 'ef'.repeat(32), expected],
    ['generation', secret, { ...expected, workerGeneration: 8 }],
    ['turn', secret, { ...expected, turnId: 'turn-b' }],
    ['attempt', secret, { ...expected, dispatchAttempt: 4 }],
    ['method', secret, { ...expected, method: 'GET' }],
    ['path', secret, { ...expected, path: '/api/sessions/session-b/lark-tool-identity' }],
    ['headers', secret, { ...expected, headers: { ...headers, 'x-botmux-lark-session': 'other' } }],
    ['body', secret, { ...expected, body: Buffer.from('{"mode":"bot"}') }],
    ['expiry', secret, { ...expected, nowMs: 11_001 }],
  ])('rejects a token reused with a different %s binding', (_field, verifySecret, verifyExpected) => {
    const token = createProtectedLoopbackProxyAttestation(secret, request);

    expect(verifyProtectedLoopbackProxyAttestation(verifySecret, token, verifyExpected)).toBeNull();
  });

  it('rejects payload mutation even when the encoded token remains syntactically valid', () => {
    const token = createProtectedLoopbackProxyAttestation(secret, request);
    const [payload, signature] = token.split('.');
    const decoded = JSON.parse(Buffer.from(payload!, 'base64url').toString('utf8'));
    decoded.peerPid = 999;
    const tampered = `${Buffer.from(JSON.stringify(decoded)).toString('base64url')}.${signature}`;

    expect(verifyProtectedLoopbackProxyAttestation(secret, tampered, expected)).toBeNull();
  });
});
