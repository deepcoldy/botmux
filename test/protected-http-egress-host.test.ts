import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { request } from 'node:http';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MAX_PROTECTED_HTTP_BODY_BYTES,
  PROTECTED_HTTP_EGRESS_SOCKET_ENV,
  startSessionProtectedHttpEgressHost,
  type ProtectedHttpEgressForwardRequest,
  type ProtectedHttpEgressLogEntry,
  type ProtectedHttpEgressWarning,
} from '../src/core/protected-http-egress-host.js';
import {
  normalizeProtectedHttpEgressPolicy,
  protectedHttpEgressPolicyDigest,
} from '../src/core/protected-http-egress.js';

const policy = normalizeProtectedHttpEgressPolicy({
  id: 'fixture.catalog.write.v1',
  targets: [{
    scheme: 'https',
    host: 'fixture.internal.example',
    port: 443,
    denyRoutes: [{ methods: ['POST'], path: '/api/v2/catalog/info' }],
  }],
})!;

interface HttpResult {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

function unixHttpRequest(
  socketPath: string,
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: Buffer,
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, method, path, headers, agent: false }, res => {
      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(Buffer.from(chunk)));
      res.once('end', () => resolve({
        status: res.statusCode ?? 0,
        headers: res.headers,
        body: Buffer.concat(chunks),
      }));
    });
    req.once('error', reject);
    req.end(body);
  });
}

function rawUnixHttpRequest(socketPath: string, raw: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let response = '';
    socket.setEncoding('utf8');
    socket.once('connect', () => socket.end(raw));
    socket.on('data', chunk => { response += chunk; });
    socket.once('end', () => resolve(response));
    socket.once('error', reject);
  });
}

describe('session protected HTTP egress host', () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    await Promise.allSettled(cleanups.splice(0).map(cleanup => cleanup()));
  });

  async function start(overrides: Partial<Parameters<typeof startSessionProtectedHttpEgressHost>[0]> = {}) {
    const socketDir = mkdtempSync(join(tmpdir(), 'botmux-egress-host-'));
    chmodSync(socketDir, 0o700);
    const forwarded: ProtectedHttpEgressForwardRequest[] = [];
    const logs: ProtectedHttpEgressLogEntry[] = [];
    const warnings: ProtectedHttpEgressWarning[] = [];
    const host = await startSessionProtectedHttpEgressHost({
      socketDir,
      policy,
      policyDigest: protectedHttpEgressPolicyDigest(policy),
      forward: async incoming => {
        forwarded.push({ ...incoming, body: Buffer.from(incoming.body) });
        return {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'x-request-id': 'upstream-request-1',
          },
          body: Buffer.from('{"ok":true}'),
        };
      },
      log: entry => logs.push(entry),
      warn: warning => warnings.push(warning),
      ...overrides,
    });
    cleanups.push(async () => {
      await host.close();
      rmSync(socketDir, { recursive: true, force: true });
    });
    const auth = readFileSync(join(socketDir, 'egress-auth'), 'utf8').trim();
    return { host, socketDir, auth, forwarded, logs, warnings };
  }

  function routingHeaders(auth: string): Record<string, string> {
    return {
      'x-botmux-egress-auth': auth,
      'x-botmux-egress-policy': policy.id,
      'x-botmux-egress-target': '0',
    };
  }

  it('exports only the socket locator name and creates sibling 0600 authentication material', async () => {
    const { host, socketDir } = await start();
    expect(PROTECTED_HTTP_EGRESS_SOCKET_ENV).toBe('BOTMUX_PROTECTED_EGRESS_SOCKET');
    expect(host.socketPath).toBe(join(socketDir, 'e.sock'));
    expect(statSync(join(socketDir, 'egress-auth')).mode & 0o777).toBe(0o600);
  });

  it.each([
    ['missing', undefined],
    ['incorrect', 'not-the-session-token'],
  ])('rejects %s authentication before forwarding', async (_label, presented) => {
    const { host, forwarded } = await start();
    const headers = {
      'x-botmux-egress-policy': policy.id,
      'x-botmux-egress-target': '0',
      ...(presented ? { 'x-botmux-egress-auth': presented } : {}),
    };

    const response = await unixHttpRequest(host.socketPath, 'GET', '/api/v2/catalog/list', headers);

    expect(response.status).toBe(403);
    expect(forwarded).toHaveLength(0);
  });

  it('denies a registered write before the injected upstream is called', async () => {
    const { host, auth, forwarded, logs } = await start();

    const response = await unixHttpRequest(
      host.socketPath,
      'POST',
      '/api/v2/catalog/info?ignored=1',
      routingHeaders(auth),
      Buffer.from('secret-body'),
    );

    expect(response.status).toBe(403);
    expect(JSON.parse(response.body.toString('utf8'))).toEqual({
      code: 'botmux_protected_write_required',
    });
    expect(forwarded).toHaveLength(0);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      policyId: policy.id,
      method: 'POST',
      path: '/api/v2/catalog/info',
      decision: 'deny',
      status: 403,
    });
  });

  it('forwards allowed requests with only safe headers and the policy-selected target', async () => {
    const { host, auth, forwarded, logs, warnings } = await start();
    const body = Buffer.from('{"query":"fixture"}');

    const response = await unixHttpRequest(
      host.socketPath,
      'POST',
      '/api/v2/catalog/search?cursor=%aa%2f',
      {
        ...routingHeaders(auth),
        host: 'attacker.invalid',
        authorization: 'Bearer machine-jwt-fixture',
        'content-type': 'application/json',
        'content-length': String(body.length),
        connection: 'x-remove-me',
        'x-remove-me': 'hop-by-hop',
        'proxy-authorization': 'Basic proxy-secret',
        'x-forwarded-host': 'attacker.invalid',
        'x-botmux-private': 'internal-only',
        'x-safe-fixture': 'kept',
      },
      body,
    );

    expect(response.status).toBe(200);
    expect(response.body.toString('utf8')).toBe('{"ok":true}');
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]).toMatchObject({
      policyId: policy.id,
      targetIndex: 0,
      target: policy.targets[0],
      method: 'POST',
      path: '/api/v2/catalog/search?cursor=%AA%2F',
      headers: {
        authorization: 'Bearer machine-jwt-fixture',
        'content-type': 'application/json',
        'content-length': String(body.length),
        'x-safe-fixture': 'kept',
      },
    });
    expect(forwarded[0].body).toEqual(body);
    expect(Object.keys(forwarded[0].headers).sort()).toEqual([
      'authorization',
      'content-length',
      'content-type',
      'x-safe-fixture',
    ]);
    expect(logs).toHaveLength(1);
    expect(Object.keys(logs[0]).sort()).toEqual([
      'decision',
      'durationMs',
      'method',
      'path',
      'policyId',
      'status',
      'upstreamRequestId',
    ]);
    expect(logs[0]).toMatchObject({
      policyId: policy.id,
      method: 'POST',
      path: '/api/v2/catalog/search',
      decision: 'allow',
      status: 200,
      upstreamRequestId: 'upstream-request-1',
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      type: 'unregistered_mutating_candidate',
      policyId: policy.id,
      method: 'POST',
      path: '/api/v2/catalog/search',
      status: 200,
    });
    expect(Object.keys(warnings[0]).sort()).toEqual([
      'durationMs',
      'method',
      'path',
      'policyId',
      'status',
      'type',
    ]);
  });

  it('rejects conflicting content lengths at the HTTP boundary without forwarding', async () => {
    const { host, auth, forwarded } = await start();
    const response = await rawUnixHttpRequest(host.socketPath, [
      'POST /api/v2/catalog/search HTTP/1.1',
      'Host: localhost',
      `x-botmux-egress-auth: ${auth}`,
      `x-botmux-egress-policy: ${policy.id}`,
      'x-botmux-egress-target: 0',
      'Content-Length: 4',
      'Content-Length: 5',
      'Connection: close',
      '',
      'abcde',
    ].join('\r\n'));

    expect(response).toMatch(/^HTTP\/1\.1 400 /);
    expect(forwarded).toHaveLength(0);
  });

  it('rejects duplicate authorization headers instead of merging credentials', async () => {
    const { host, auth, forwarded } = await start();
    const response = await rawUnixHttpRequest(host.socketPath, [
      'GET /api/v2/catalog/list HTTP/1.1',
      'Host: localhost',
      `x-botmux-egress-auth: ${auth}`,
      `x-botmux-egress-policy: ${policy.id}`,
      'x-botmux-egress-target: 0',
      'Authorization: Bearer first',
      'Authorization: Bearer second',
      'Connection: close',
      '',
      '',
    ].join('\r\n'));

    expect(response).toMatch(/^HTTP\/1\.1 400 /);
    expect(forwarded).toHaveLength(0);
  });

  it('caps request and response bodies at 16 MiB', async () => {
    const { host, auth, forwarded } = await start({
      forward: async incoming => {
        forwarded.push({ ...incoming, body: Buffer.from(incoming.body) });
        return {
          status: 200,
          headers: { 'content-type': 'application/octet-stream' },
          body: Buffer.alloc(MAX_PROTECTED_HTTP_BODY_BYTES + 1, 0x61),
        };
      },
    });

    const oversizedRequest = await unixHttpRequest(
      host.socketPath,
      'POST',
      '/api/v2/catalog/search',
      {
        ...routingHeaders(auth),
        'content-length': String(MAX_PROTECTED_HTTP_BODY_BYTES + 1),
      },
    );
    expect(oversizedRequest.status).toBe(413);
    expect(forwarded).toHaveLength(0);

    const oversizedResponse = await unixHttpRequest(
      host.socketPath,
      'GET',
      '/api/v2/catalog/list',
      routingHeaders(auth),
    );
    expect(oversizedResponse.status).toBe(502);
    expect(oversizedResponse.body.length).toBeLessThan(MAX_PROTECTED_HTTP_BODY_BYTES);
    expect(forwarded).toHaveLength(1);
  });

  it('requires the declared policy digest and unlinks the listener synchronously on close', async () => {
    const socketDir = mkdtempSync(join(tmpdir(), 'botmux-egress-host-invalid-'));
    chmodSync(socketDir, 0o700);
    cleanups.push(() => rmSync(socketDir, { recursive: true, force: true }));
    await expect(startSessionProtectedHttpEgressHost({
      socketDir,
      policy,
      policyDigest: '0'.repeat(64),
      forward: async () => ({ status: 204, headers: {}, body: Buffer.alloc(0) }),
    })).rejects.toThrow('protected_http_egress_policy_digest_mismatch');

    const { host } = await start();
    const closing = host.close();
    expect(() => statSync(host.socketPath)).toThrow();
    await closing;
  });

  it('requires complete frozen IP targets when using the production forwarder', async () => {
    for (const frozenAddresses of [undefined, [[]], [['not-an-ip-address']]]) {
      const socketDir = mkdtempSync(join(tmpdir(), 'botmux-egress-host-unfrozen-'));
      chmodSync(socketDir, 0o700);
      cleanups.push(() => rmSync(socketDir, { recursive: true, force: true }));
      await expect(startSessionProtectedHttpEgressHost({
        socketDir,
        policy,
        policyDigest: protectedHttpEgressPolicyDigest(policy),
        frozenAddresses,
      })).rejects.toThrow('protected_http_egress_target_not_frozen');
    }
  });

  it('snapshots the digest-bound policy before serving requests', async () => {
    const socketDir = mkdtempSync(join(tmpdir(), 'botmux-egress-host-snapshot-'));
    chmodSync(socketDir, 0o700);
    const mutablePolicy = normalizeProtectedHttpEgressPolicy({
      id: 'fixture.snapshot.write.v1',
      targets: [{
        scheme: 'https',
        host: 'snapshot.internal.example',
        port: 443,
        denyRoutes: [{ methods: ['POST'], path: '/v1/protected' }],
      }],
    })!;
    const seenTargets: string[] = [];
    const host = await startSessionProtectedHttpEgressHost({
      socketDir,
      policy: mutablePolicy,
      policyDigest: protectedHttpEgressPolicyDigest(mutablePolicy),
      forward: async incoming => {
        seenTargets.push(incoming.target.host);
        return { status: 204, headers: {}, body: Buffer.alloc(0) };
      },
    });
    cleanups.push(async () => {
      await host.close();
      rmSync(socketDir, { recursive: true, force: true });
    });
    const auth = readFileSync(join(socketDir, 'egress-auth'), 'utf8').trim();
    mutablePolicy.targets[0].host = 'mutated.invalid';
    mutablePolicy.targets[0].denyRoutes[0].path = '/v1/other';

    const denied = await unixHttpRequest(host.socketPath, 'POST', '/v1/protected', {
      'x-botmux-egress-auth': auth,
      'x-botmux-egress-policy': mutablePolicy.id,
      'x-botmux-egress-target': '0',
    });
    const allowed = await unixHttpRequest(host.socketPath, 'GET', '/v1/list', {
      'x-botmux-egress-auth': auth,
      'x-botmux-egress-policy': mutablePolicy.id,
      'x-botmux-egress-target': '0',
    });

    expect(denied.status).toBe(403);
    expect(allowed.status).toBe(204);
    expect(seenTargets).toEqual(['snapshot.internal.example']);
  });

  it('zeros buffered request and response bodies after the response finishes', async () => {
    let requestBody: Buffer | undefined;
    const responseBody = Buffer.from('response-secret');
    const { host, auth } = await start({
      forward: async incoming => {
        requestBody = incoming.body;
        return {
          status: 200,
          headers: { 'content-type': 'application/octet-stream' },
          body: responseBody,
        };
      },
    });

    const response = await unixHttpRequest(
      host.socketPath,
      'POST',
      '/api/v2/catalog/search?token=query-secret',
      routingHeaders(auth),
      Buffer.from('request-secret'),
    );

    expect(response.body.toString('utf8')).toBe('response-secret');
    expect(requestBody).toBeDefined();
    expect(requestBody!.every(byte => byte === 0)).toBe(true);
    expect(responseBody.every(byte => byte === 0)).toBe(true);
  });

  it('zeros an upstream body when unsafe response headers abort forwarding', async () => {
    const responseBody = Buffer.from('response-secret');
    const { host, auth } = await start({
      forward: async () => ({
        status: 200,
        headers: { 'x-invalid': 'value\nsmuggled' },
        body: responseBody,
      }),
    });

    const response = await unixHttpRequest(
      host.socketPath,
      'GET',
      '/api/v2/catalog/list',
      routingHeaders(auth),
    );

    expect(response.status).toBe(502);
    expect(responseBody.every(byte => byte === 0)).toBe(true);
  });

  it('fails closed when the supplied socket directory is a symlink', async () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-egress-symlink-'));
    const realDir = join(root, 'real');
    const planted = join(root, 'planted');
    const { mkdirSync, symlinkSync } = await import('node:fs');
    mkdirSync(realDir, { mode: 0o700 });
    symlinkSync(realDir, planted);
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));

    await expect(startSessionProtectedHttpEgressHost({
      socketDir: planted,
      policy,
      policyDigest: protectedHttpEgressPolicyDigest(policy),
      forward: async () => ({ status: 204, headers: {}, body: Buffer.alloc(0) }),
    })).rejects.toThrow(/not a directory/);
  });
});
