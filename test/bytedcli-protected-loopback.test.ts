import { describe, expect, it } from 'vitest';
import { createProtectedLoopbackProxyAttestation, PROTECTED_LOOPBACK_ATTESTATION_HEADER } from '../src/core/protected-loopback-attestation.js';
import { bytedcliLoopbackServices, resolveProtectedExecutionPeer } from '../src/core/bytedcli-protected-loopback.js';
import { resolveIdentityStorageModel } from '../src/core/lark-tool-binding.js';
import { assertBytedcliLaunchSupported } from '../src/core/bytedcli-linux-containment.js';
import type { IncomingMessage } from 'node:http';
import type { DaemonSession } from '../src/core/types.js';

describe('ByteCloud through the protected loopback relay', () => {
  const secret = 'ab'.repeat(32);
  const body = Buffer.from('{"sessionId":"session-a"}');
  const headers = { 'content-type': 'application/json' };
  const ds = { workerGeneration: 7, worker: { pid: 123, killed: false },
    protectedLoopbackProxyAttestation: { secret, workerGeneration: 7 },
    managedTurnOrigin: { turnId: 'turn-a', dispatchAttempt: 3 } } as unknown as DaemonSession;
  const peer = { pid: 321, procStart: '123456' };
  const service = bytedcliLoopbackServices(7950)[0]!;
  const signed = () => createProtectedLoopbackProxyAttestation(secret, {
    sessionId: 'session-a', serviceId: service.id, workerGeneration: 7, turnId: 'turn-a', dispatchAttempt: 3,
    peer, method: 'POST', path: service.path, headers, body,
  });
  function request(token = signed()): IncomingMessage {
    return { method: 'POST', url: service.path, headers: { ...headers, [PROTECTED_LOOPBACK_ATTESTATION_HEADER]: token }, socket: { remoteAddress: '127.0.0.1' } } as IncomingMessage;
  }
  it('verifies the original peer without authorizing the host proxy process', async () => {
    expect(await resolveProtectedExecutionPeer(request(), body, 'session-a', service.id, () => ds)).toMatchObject({ ok: true, peer });
  });
  it.each(['body', 'session', 'generation', 'turn', 'path', 'signature', 'worker'])(
    'rejects changed %s without falling back to a direct loopback peer', async change => {
      const req = request();
      const changed = { ...ds, managedTurnOrigin: { ...ds.managedTurnOrigin } } as DaemonSession;
      if (change === 'generation') changed.workerGeneration = 8;
      if (change === 'turn') changed.managedTurnOrigin!.turnId = 'turn-b';
      if (change === 'path') req.url = '/api/other';
      if (change === 'signature') req.headers[PROTECTED_LOOPBACK_ATTESTATION_HEADER] = 'invalid';
      if (change === 'worker') changed.worker = null;
      const result = await resolveProtectedExecutionPeer(req, change === 'body' ? Buffer.from('{}') : body,
        change === 'session' ? 'session-b' : 'session-a', service.id, () => changed);
      expect(result.ok).toBe(false);
    },
  );
  it('withdraws a resolved relay proof before an async gap can borrow a new turn', async () => {
    const local = { ...ds, managedTurnOrigin: { ...ds.managedTurnOrigin } } as DaemonSession;
    const result = await resolveProtectedExecutionPeer(request(), body, 'session-a', service.id, () => local);
    expect(result.current?.()).toBe(true);
    local.managedTurnOrigin!.turnId = 'new-turn';
    expect(result.current?.()).toBe(false);
  });
  it('keeps slirp isolated while admitting only the attested relay for proven identity', () => {
    const facts = { platform: 'linux' as const, binding: true, sandboxEngaged: true, loopbackShared: false };
    expect(resolveIdentityStorageModel(facts)).toBe('single');
    expect(resolveIdentityStorageModel({ ...facts, attestedLoopback: true })).toBe('proven');
    const launch = { platform: 'linux', backendType: 'pty', cliId: 'codex', sandbox: 'oncall', loopbackShared: false, identityModel: 'proven' };
    expect(() => assertBytedcliLaunchSupported(launch)).toThrow();
    expect(() => assertBytedcliLaunchSupported({ ...launch, attestedLoopback: true })).not.toThrow();
    expect(() => assertBytedcliLaunchSupported({ ...launch, attestedLoopback: true, sharedAuthentication: true })).toThrow();
  });
});
