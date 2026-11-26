import { describe, expect, it } from 'vitest';
import * as protocol from '../src/cli/bytedcli-exec-protocol.js';
const request = { schema: 'botmux.bytedcli-exec.v1', sessionId: 'session-1', requestId: 'request-1',
  argv: ['codebase', 'repo', 'get', '--repo', 'team/service'] };
const response = { schema: 'botmux.bytedcli-exec.v1', requestId: 'request-1', operationId: 'codebase.repo.get',
  effectiveIdentity: { kind: 'machine' }, outcome: 'completed', stdoutBase64: 'b2sK', stderrBase64: '', exitCode: 0 };

describe('ByteCloud broker wire validation', () => {
  it('roundtrips request bytes without allowing authoritative identity fields', () => {
    const parsed = protocol.parseBytedcliExecRequest(JSON.stringify({ ...request, inputs: { stdinBase64: 'dGV4dA==' } }));
    expect(parsed).toEqual({ ...request, inputs: { stdinBase64: 'dGV4dA==' } });
    for (const key of ['pid', 'openId', 'email', 'owner', 'home', 'jwt', 'effect', 'timeoutMs', '__proto__']) {
      expect(() => protocol.parseBytedcliExecRequest(JSON.stringify({ ...request, [key]: 'attacker' }))).toThrow();
    }
    expect(() => protocol.parseBytedcliExecRequest({ ...request, schema: 'older' })).toThrow();
    expect(() => protocol.parseBytedcliExecRequest({ ...request, sessionId: '../session' })).toThrow();
  });

  it('bounds wire body, argv and strict decoded input rather than permissive base64 decoding', () => {
    for (const argv of [Array(257).fill('x'), ['x'.repeat(65_537)], ['bad\0arg'], [7]]) {
      expect(() => protocol.parseBytedcliExecRequest({ ...request, argv })).toThrow();
    }
    for (const inputs of [{ stdinBase64: 'not base64!' }, { stdinBase64: 'Zh==' }, { stdinBase64: 'YQ' },
      { files: [{ id: '/etc/passwd', dataBase64: '' }] }, { files: [{ id: 'a', dataBase64: '', path: '/etc/passwd' }] },
      { files: [{ id: 'a', dataBase64: '' }, { id: 'a', dataBase64: '' }] },
      { stdinBase64: Buffer.alloc(2 * 1024 * 1024 + 1).toString('base64') }]) {
      expect(() => protocol.parseBytedcliExecRequest({ ...request, inputs })).toThrow();
    }
    expect(() => protocol.parseBytedcliExecRequest(' '.repeat(3 * 1024 * 1024 + 1))).toThrow();
    const boundary = { stdinBase64: Buffer.alloc(2 * 1024 * 1024).toString('base64') };
    expect(protocol.parseBytedcliExecRequest({ ...request, inputs: boundary }).inputs).toEqual(boundary);
  });

  it('returns safe output and upstream exit status with explicit uncertain-write semantics', () => {
    expect(protocol.parseBytedcliExecResponse(response)).toEqual(response);
    const unknown = { ...response, effectiveIdentity: { kind: 'actor', accountFingerprint: 'sha256:abc' },
      outcome: 'write_outcome_unknown', exitCode: 1, errorCode: 'write_outcome_unknown' };
    expect(protocol.parseBytedcliExecResponse(JSON.stringify(unknown))).toEqual(unknown);
    for (const extra of [{ token: 'secret' }, { exitCode: -1 }, { stdoutBase64: 'bad!' }, { errorCode: 'arbitrary-secret' },
      { effectiveIdentity: { kind: 'actor', email: 'person@example.com' } }, { outcome: 'write_outcome_unknown', exitCode: 0 },
      { stdoutBase64: Buffer.alloc(16 * 1024 * 1024 + 1).toString('base64') }]) {
      expect(() => protocol.parseBytedcliExecResponse({ ...response, ...extra })).toThrow();
    }
  });
});
