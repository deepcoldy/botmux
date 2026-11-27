import { describe, expect, it } from 'vitest';
import * as protocol from '../src/cli/bytedcli-exec-protocol.js';
const request = { schema: 'botmux.bytedcli-exec.v1', sessionId: 'session-1', requestId: 'request-1',
  argv: ['codebase', 'repo', 'get', '--repo', 'team/service'] };
const response = { schema: 'botmux.bytedcli-exec.v1', requestId: 'request-1', operationId: 'codebase.repo.get',
  effectiveIdentity: { kind: 'machine' }, outcome: 'completed', stdoutBase64: 'b2sK', stderrBase64: '', exitCode: 0 };

describe('ByteCloud broker wire validation', () => {
  it.each([[16, 0], [8, 8], [0, 16]])('accepts canonical output at the limit with %i MiB stdout and %i MiB stderr', (stdoutMiB, stderrMiB) => {
    const output = { ...response,
      stdoutBase64: Buffer.alloc(stdoutMiB * 1024 * 1024, 0x61).toString('base64'),
      stderrBase64: Buffer.alloc(stderrMiB * 1024 * 1024, 0x62).toString('base64') };
    const parsed = protocol.parseBytedcliExecResponse(JSON.stringify(output));
    expect(parsed.outcome).toBe('completed');
    expect(parsed.exitCode).toBe(0);
    expect(parsed.stdoutBase64).toBe(output.stdoutBase64);
    expect(parsed.stderrBase64).toBe(output.stderrBase64);
    const stdout = Buffer.from(parsed.stdoutBase64, 'base64');
    const stderr = Buffer.from(parsed.stderrBase64, 'base64');
    expect(stdout.length).toBe(stdoutMiB * 1024 * 1024);
    expect(stderr.length).toBe(stderrMiB * 1024 * 1024);
    if (stdout.length) expect([stdout[0], stdout[stdout.length - 1]]).toEqual([0x61, 0x61]);
    if (stderr.length) expect([stderr[0], stderr[stderr.length - 1]]).toEqual([0x62, 0x62]);
  });

  it('rejects individually valid streams whose combined decoded output exceeds the limit', () => {
    expect(() => protocol.parseBytedcliExecResponse({ ...response,
      stdoutBase64: Buffer.alloc(8 * 1024 * 1024).toString('base64'),
      stderrBase64: Buffer.alloc(8 * 1024 * 1024 + 1).toString('base64') })).toThrow();
  });

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
      ...['Y==A', '====', 'AAA===', 'A===', 'AA_A', 'AA-A', 'AA A', 'AA\nA'].map(stdinBase64 => ({ stdinBase64 })),
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
    expect(protocol.parseBytedcliExecResponse({ ...unknown, effectiveIdentity: { kind: 'machine', accountFingerprint: 'sha256:machine' } }))
      .toMatchObject({ outcome: 'write_outcome_unknown', effectiveIdentity: { kind: 'machine' } });
    expect(() => protocol.parseBytedcliExecResponse({ ...unknown, effectiveIdentity: { kind: 'none' } })).toThrow();
    for (const extra of [{ token: 'secret' }, { exitCode: -1 }, { stdoutBase64: 'bad!' }, { errorCode: 'arbitrary-secret' },
      { effectiveIdentity: { kind: 'actor', email: 'person@example.com' } }, { outcome: 'write_outcome_unknown', exitCode: 0 },
      { stdoutBase64: Buffer.alloc(16 * 1024 * 1024 + 1).toString('base64') }]) {
      expect(() => protocol.parseBytedcliExecResponse({ ...response, ...extra })).toThrow();
    }
  });
});
