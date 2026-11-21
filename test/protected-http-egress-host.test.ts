import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { request, Server as HttpServer } from 'node:http';
import { createConnection, createServer as createNetServer } from 'node:net';
import { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  MAX_PROTECTED_HTTP_BODY_BYTES,
  PROTECTED_HTTP_EGRESS_SOCKET_ENV,
  protectedHttpEgressAuthTokenPath,
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
  id: 'fixture.items.write.v1',
  targets: [{
    scheme: 'https',
    host: 'fixture.internal.example',
    port: 443,
    denyRoutes: [{ methods: ['POST'], path: '/v1/items/update' }],
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
    const auth = readFileSync(protectedHttpEgressAuthTokenPath(host.socketPath), 'utf8').trim();
    return { host, socketDir, auth, forwarded, logs, warnings };
  }

  function routingHeaders(auth: string): Record<string, string> {
    return {
      'x-botmux-egress-auth': auth,
      'x-botmux-egress-policy': policy.id,
      'x-botmux-egress-target': '0',
    };
  }

  function sharedReadHeaders(): Record<string, string> {
    return {
      'x-botmux-egress-client': 'shared-read-v1',
      'x-botmux-egress-policy': policy.id,
      'x-botmux-egress-target': '0',
    };
  }

  it.each(['GET', 'POST'])('allows shared reads without a guard token and preserves the local MIX identity (%s)', async method => {
    const { host, forwarded } = await start({ sharedRead: true });
    const result = await unixHttpRequest(host.socketPath, method, '/v1/items/query?keyword=activity', {
      ...sharedReadHeaders(), authorization: 'Bearer local-user-fixture',
      'x-jwt-token': 'local-jwt-fixture', 'x-botmux-trusted-principal': 'forged-principal',
    }, method === 'POST' ? Buffer.from('{"keyword":"activity"}') : undefined);
    expect(result.status).toBe(200);
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]).toMatchObject({
      targetIndex: 0, method, path: '/v1/items/query?keyword=activity',
      headers: { authorization: 'Bearer local-user-fixture', 'x-jwt-token': 'local-jwt-fixture' },
    });
    expect(Object.keys(forwarded[0]!.headers).some(name => name.startsWith('x-botmux-'))).toBe(false);
  });

  it('does not enable shared reads on an unconfigured guard', async () => {
    const { host, forwarded } = await start();
    expect((await unixHttpRequest(host.socketPath, 'GET', '/v1/items/query', sharedReadHeaders())).status).toBe(403);
    expect(forwarded).toHaveLength(0);
  });

  it('blocks registered writes from the tokenless shared-read client', async () => {
    const { host, forwarded, logs } = await start({ sharedRead: true });
    const result = await unixHttpRequest(host.socketPath, 'POST', '/v1/items/update', sharedReadHeaders(), Buffer.from('{}'));
    expect(result.status).toBe(403);
    expect(JSON.parse(result.body.toString())).toMatchObject({ code: 'botmux_protected_write_required' });
    expect(forwarded).toHaveLength(0);
    expect(logs).toContainEqual(expect.objectContaining({ decision: 'deny', path: '/v1/items/update' }));
  });

  it.each([
    { 'x-botmux-egress-auth': 'not-a-host-token' },
    { 'x-botmux-egress-client': 'unknown-protocol' },
    { 'x-botmux-egress-policy': 'different-policy' },
    { 'x-botmux-egress-target': '9' },
    { 'x-botmux-loopback-service': 'lark-tool-identity' },
    { 'x-botmux-loopback-peer-pid': '1234' },
    { 'x-botmux-loopback-peer-start': '1234' },
    { 'x-botmux-loopback-attestation': 'forged-attestation' },
  ])('rejects shared-read authority or routing overrides %#', async extraHeaders => {
    const forwardedLoopback: unknown[] = [];
    const { host, forwarded } = await start({ sharedRead: true,
      loopbackServices: [{ id: 'lark-tool-identity', method: 'GET', path: '/v1/items/query',
        listenPort: 17950, upstreamPort: 7950, forwardHeaders: [] }],
      forwardLoopbackService: async (_service, incoming) => {
        forwardedLoopback.push(incoming);
        return { status: 200, headers: {}, body: Buffer.from('{}') };
      },
    });
    const result = await unixHttpRequest(host.socketPath, 'GET', '/v1/items/query', {
      ...sharedReadHeaders(), ...extraHeaders,
    });
    expect(result.status).toBeGreaterThanOrEqual(400);
    expect(forwarded).toHaveLength(0);
    expect(forwardedLoopback).toHaveLength(0);
  });

  it('rejects duplicate shared-read protocol headers', async () => {
    const { host, forwarded } = await start({ sharedRead: true });
    const raw = await rawUnixHttpRequest(host.socketPath,
      `GET /v1/items/query HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\nx-botmux-egress-client: shared-read-v1\r\nx-botmux-egress-client: shared-read-v1\r\nx-botmux-egress-policy: ${policy.id}\r\nx-botmux-egress-target: 0\r\n\r\n`);
    expect(raw).toContain('403');
    expect(forwarded).toHaveLength(0);
  });

  it('rejects a shared-read client selecting an internal service without business routing headers', async () => {
    const forwardedLoopback: unknown[] = [];
    const { host, forwarded } = await start({ sharedRead: true,
      loopbackServices: [{ id: 'identity', method: 'POST', path: '/internal/identity',
        listenPort: 17950, upstreamPort: 7950, forwardHeaders: [] }],
      forwardLoopbackService: async (_service, incoming) => {
        forwardedLoopback.push(incoming);
        return { status: 200, headers: {}, body: Buffer.from('{}') };
      },
    });
    const result = await unixHttpRequest(host.socketPath, 'POST', '/internal/identity', {
      'x-botmux-egress-client': 'shared-read-v1', 'x-botmux-loopback-service': 'identity',
    });
    expect(result.status).toBe(403);
    expect(JSON.parse(result.body.toString())).toMatchObject({ code: 'botmux_protected_egress_forbidden' });
    expect(forwarded).toHaveLength(0);
    expect(forwardedLoopback).toHaveLength(0);
  });

  it('keeps egress authentication in a private subtree separate from the socket mount', async () => {
    const { host, socketDir } = await start();
    expect(existsSync(join(socketDir, 'egress-auth'))).toBe(false);
    expect(readFileSync(join(socketDir, 'egress-private', 'egress-auth'), 'utf8').trim()).not.toBe('');
    expect(statSync(join(socketDir, 'egress-private')).mode & 0o777).toBe(0o700);
    expect(host.socketPath).toBe(join(socketDir, 'e.sock'));
  });

  it('removes its authentication file when closed', async () => {
    const { host } = await start();
    const authPath = protectedHttpEgressAuthTokenPath(host.socketPath);
    expect(existsSync(authPath)).toBe(true);
    await host.close();
    expect(existsSync(authPath)).toBe(false);
  });

  it('preserves authentication already rotated by a successor', async () => {
    const { host } = await start();
    const authPath = protectedHttpEgressAuthTokenPath(host.socketPath);
    writeFileSync(authPath, 'successor-token-fixture\n', { mode: 0o600 });
    await host.close();
    expect(readFileSync(authPath, 'utf8')).toBe('successor-token-fixture\n');
  });

  it('does not unlink the socket of a replacement guard when a prior guard closes late', async () => {
    const { host, socketDir } = await start();
    const replacement = await startSessionProtectedHttpEgressHost({
      socketDir, policy, policyDigest: protectedHttpEgressPolicyDigest(policy),
      forward: async () => ({ status: 200, headers: {}, body: Buffer.from('replacement') }),
    });
    cleanups.push(() => replacement.close());
    const auth = readFileSync(protectedHttpEgressAuthTokenPath(replacement.socketPath), 'utf8').trim();
    await host.close();
    expect(await unixHttpRequest(replacement.socketPath, 'GET', '/v1/items/query', routingHeaders(auth)))
      .toMatchObject({ status: 200, body: Buffer.from('replacement') });
  });

  it('closes the socket even when the authentication path cannot be cleaned', async () => {
    const errors: Error[] = [];
    const { host, socketDir } = await start({ onError: error => errors.push(error) });
    const privateDir = dirname(protectedHttpEgressAuthTokenPath(host.socketPath));
    const savedDir = `${privateDir}.saved`;
    renameSync(privateDir, savedDir);
    writeFileSync(privateDir, 'not-a-directory', { mode: 0o600 });
    try {
      await expect(host.close()).resolves.toBeUndefined();
      expect(errors).toHaveLength(1);
      expect(existsSync(host.socketPath)).toBe(false);
      await expect(unixHttpRequest(host.socketPath, 'GET', '/', {})).rejects.toThrow();
    } finally {
      rmSync(privateDir, { force: true });
      renameSync(savedDir, privateDir);
      cleanups.push(() => rmSync(socketDir, { recursive: true, force: true }));
    }
  });

  it.skipIf(process.platform === 'win32')('cleans authentication when the Unix socket cannot listen', async () => {
    const root = mkdtempSync(join(tmpdir(), 'egress-listen-failure-'));
    const socketDir = join(root, 'guard');
    const occupiedPath = join(root, 'occupied.sock');
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const occupied = createNetServer();
    await new Promise<void>((resolve, reject) => {
      occupied.once('error', reject); occupied.listen(occupiedPath, resolve);
    });
    // Keep the real bind/error/cleanup path. Only substitute the bind address:
    // oversized Unix paths fail on Node but are truncated by Bun, so they are
    // not a portable failure fixture. This address really is already in use.
    const originalListen = HttpServer.prototype.listen;
    const bindAddress = vi.spyOn(HttpServer.prototype, 'listen').mockImplementation(function (...args) {
      return Reflect.apply(originalListen, this, [occupiedPath, ...args.slice(1)]);
    });
    try {
      await expect(startSessionProtectedHttpEgressHost({
        socketDir, policy, policyDigest: protectedHttpEgressPolicyDigest(policy),
        forward: async () => ({ status: 200, headers: {}, body: Buffer.alloc(0) }),
      })).rejects.toThrow();
      expect(existsSync(protectedHttpEgressAuthTokenPath(join(socketDir, 'e.sock')))).toBe(false);
    } finally {
      bindAddress.mockRestore();
      await new Promise<void>(resolve => occupied.close(() => resolve()));
    }
  });

  it('exports only the socket locator name and creates sibling 0600 authentication material', async () => {
    const { host, socketDir } = await start();
    expect(PROTECTED_HTTP_EGRESS_SOCKET_ENV).toBe('BOTMUX_PROTECTED_EGRESS_SOCKET');
    expect(host.socketPath).toBe(join(socketDir, 'e.sock'));
    expect(statSync(protectedHttpEgressAuthTokenPath(host.socketPath)).mode & 0o777).toBe(0o600);
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

    const response = await unixHttpRequest(host.socketPath, 'GET', '/v1/items/list', headers);

    expect(response.status).toBe(403);
    expect(forwarded).toHaveLength(0);
  });

  it('denies a registered write before the injected upstream is called', async () => {
    const { host, auth, forwarded, logs } = await start();

    const response = await unixHttpRequest(
      host.socketPath,
      'POST',
      '/v1/items/update?ignored=1',
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
      path: '/v1/items/update',
      decision: 'deny',
      status: 403,
    });
  });

  it('forwards only the configured local service route and its declared headers', async () => {
    const forwarded: Array<Record<string, unknown>> = [];
    const { host, auth } = await start({
      loopbackServices: [{
        id: 'lark-tool-identity',
        listenPort: 7950,
        upstreamPort: 7950,
        method: 'POST',
        path: '/api/sessions/session-a/lark-tool-identity',
        forwardHeaders: ['content-type', 'x-botmux-lark-session'],
        attestProcessPeer: true,
      }],
      forwardLoopbackService: async (service, request) => {
        forwarded.push({ service, incoming: { ...request, body: Buffer.from(request.body) } });
        return {
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: Buffer.from('{"ok":true}'),
        };
      },
    });
    const body = Buffer.from('{"mode":"bot"}');
    const headers = {
      'x-botmux-egress-auth': auth,
      'x-botmux-loopback-service': 'lark-tool-identity',
      'x-botmux-lark-session': 'session-access-key',
      'content-type': 'application/json',
      'x-botmux-loopback-peer-pid': String(process.pid),
      'x-botmux-loopback-peer-start': '12345',
    };

    const allowed = await unixHttpRequest(
      host.socketPath,
      'POST',
      '/api/sessions/session-a/lark-tool-identity',
      headers,
      body,
    );
    const wrongMethod = await unixHttpRequest(
      host.socketPath,
      'GET',
      '/api/sessions/session-a/lark-tool-identity',
      headers,
    );
    const wrongSession = await unixHttpRequest(
      host.socketPath,
      'POST',
      '/api/sessions/session-b/lark-tool-identity',
      headers,
      body,
    );
    const undeclaredHeader = await unixHttpRequest(
      host.socketPath,
      'POST',
      '/api/sessions/session-a/lark-tool-identity',
      { ...headers, 'x-not-declared': 'must-reject' },
      body,
    );
    const mixedRouting = await unixHttpRequest(
      host.socketPath,
      'POST',
      '/api/sessions/session-a/lark-tool-identity',
      { ...headers, 'x-botmux-egress-policy': 'attacker-policy' },
      body,
    );

    expect(allowed.status).toBe(200);
    expect(allowed.body.toString('utf8')).toBe('{"ok":true}');
    expect(wrongMethod.status).toBe(403);
    expect(wrongSession.status).toBe(403);
    expect(undeclaredHeader.status).toBe(403);
    expect(mixedRouting.status).toBe(403);
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]).toEqual({
      service: {
        id: 'lark-tool-identity',
        listenPort: 7950,
        upstreamPort: 7950,
        method: 'POST',
        path: '/api/sessions/session-a/lark-tool-identity',
        forwardHeaders: ['content-type', 'x-botmux-lark-session'],
        attestProcessPeer: true,
      },
      incoming: {
        method: 'POST',
        path: '/api/sessions/session-a/lark-tool-identity',
        headers: {
          'content-length': String(body.length),
          'content-type': 'application/json',
          'x-botmux-lark-session': 'session-access-key',
        },
        body,
        peer: { pid: process.pid, procStart: '12345' },
      },
    });
  });

  it('forwards allowed requests with only safe headers and the policy-selected target', async () => {
    const { host, auth, forwarded, logs, warnings } = await start();
    const body = Buffer.from('{"query":"fixture"}');

    const response = await unixHttpRequest(
      host.socketPath,
      'POST',
      '/v1/items/search?cursor=%aa%2f',
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
      path: '/v1/items/search?cursor=%aa%2f',
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
      path: '/v1/items/search',
      decision: 'allow',
      status: 200,
      upstreamRequestId: 'upstream-request-1',
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      type: 'unregistered_mutating_candidate',
      policyId: policy.id,
      method: 'POST',
      path: '/v1/items/search',
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

  it('streams an allowed upstream response before the upstream body completes', async () => {
    let release!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    const { host, auth } = await start({
      forward: async () => ({
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
        body: Readable.from((async function* () {
          yield Buffer.from('data: first\n\n');
          await hold;
          yield Buffer.from('data: second\n\n');
        })()),
      }),
    });

    let firstChunk!: (value: string) => void;
    const first = new Promise<string>(resolve => { firstChunk = resolve; });
    const completed = new Promise<string>((resolve, reject) => {
      const chunks: string[] = [];
      const req = request({
        socketPath: host.socketPath,
        method: 'GET',
        path: '/v1/items/list',
        headers: routingHeaders(auth),
        agent: false,
      }, res => {
        res.setEncoding('utf8');
        res.on('data', chunk => {
          chunks.push(chunk);
          if (chunks.length === 1) firstChunk(chunk);
        });
        res.once('end', () => resolve(chunks.join('')));
      });
      req.once('error', reject);
      req.end();
    });

    await expect(Promise.race([
      first,
      new Promise<string>((_resolve, reject) => setTimeout(() => reject(new Error('first chunk timed out')), 500)),
    ])).resolves.toBe('data: first\n\n');
    release();
    await expect(completed).resolves.toBe('data: first\n\ndata: second\n\n');
  });

  it('rejects conflicting content lengths at the HTTP boundary without forwarding', async () => {
    const { host, auth, forwarded } = await start();
    const response = await rawUnixHttpRequest(host.socketPath, [
      'POST /v1/items/search HTTP/1.1',
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
      'GET /v1/items/list HTTP/1.1',
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

  it.each([
    ['x-http-method-override', 'POST'],
    ['x-method-override', 'POST'],
    ['x-original-url', '/v1/items/update'],
    ['x-rewrite-url', '/v1/items/update'],
  ])('rejects the routing override header %s before forwarding', async (name, value) => {
    const { host, auth, forwarded } = await start();

    const response = await unixHttpRequest(
      host.socketPath,
      'GET',
      '/v1/items/list',
      { ...routingHeaders(auth), [name]: value },
    );

    expect(response.status).toBe(400);
    expect(forwarded).toHaveLength(0);
  });

  it('removes response headers nominated by Connection', async () => {
    const { host, auth } = await start({
      forward: async () => ({
        status: 200,
        headers: {
          connection: 'x-private, keep-alive',
          'x-private': 'must-not-cross',
          'x-safe-fixture': 'kept',
        },
        body: Buffer.from('ok'),
      }),
    });

    const response = await unixHttpRequest(
      host.socketPath,
      'GET',
      '/v1/items/list',
      routingHeaders(auth),
    );

    expect(response.status).toBe(200);
    expect(response.headers['x-private']).toBeUndefined();
    expect(response.headers['x-safe-fixture']).toBe('kept');
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
      '/v1/items/search',
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
      '/v1/items/list',
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

  it('validates process-attested loopback configuration before creating authentication material', async () => {
    const socketDir = mkdtempSync(join(tmpdir(), 'botmux-egress-host-invalid-loopback-'));
    chmodSync(socketDir, 0o700);
    cleanups.push(() => rmSync(socketDir, { recursive: true, force: true }));

    await expect(startSessionProtectedHttpEgressHost({
      socketDir,
      policy,
      policyDigest: protectedHttpEgressPolicyDigest(policy),
      forward: async () => ({ status: 204, headers: {}, body: Buffer.alloc(0) }),
      loopbackServices: [{
        id: 'lark-tool-identity',
        listenPort: 7950,
        upstreamPort: 7950,
        method: 'POST',
        path: '/api/sessions/session-a/lark-tool-identity',
        forwardHeaders: ['content-type'],
        attestProcessPeer: true,
      }],
    })).rejects.toThrow('invalid_protected_loopback_proxy_attestation');

    expect(existsSync(join(socketDir, 'egress-auth'))).toBe(false);
    expect(existsSync(join(socketDir, 'e.sock'))).toBe(false);
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
    const auth = readFileSync(protectedHttpEgressAuthTokenPath(host.socketPath), 'utf8').trim();
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
      '/v1/items/search?token=query-secret',
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
    const { host, auth, logs } = await start({
      forward: async () => ({
        status: 200,
        headers: { 'x-invalid': 'value\nsmuggled' },
        body: responseBody,
      }),
    });

    const response = await unixHttpRequest(
      host.socketPath,
      'GET',
      '/v1/items/list',
      routingHeaders(auth),
    );

    expect(response.status).toBe(502);
    expect(responseBody.every(byte => byte === 0)).toBe(true);
    expect(logs.at(-1)?.status).toBe(502);
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

  // The default relay cut a silent upstream after a fixed 30s. A daemon route
  // that runs a platform credential grant can legitimately stay silent that
  // long, so it declares its own timeout and the relay must honour it.
  it.each([
    ['delivers a slow answer when the service allows the upstream longer than it takes', 2_000, 200],
    ['still cuts an upstream that stays silent past the service\'s own timeout', 100, 502],
  ] as const)('%s', async (_label, upstreamTimeoutMs, expectedStatus) => {
    const daemon = new HttpServer((req, res) => {
      req.resume();
      req.once('end', () => setTimeout(() => {
        if (res.destroyed) return;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
      }, 400));
    });
    await new Promise<void>(resolve => daemon.listen(0, '127.0.0.1', resolve));
    cleanups.push(() => new Promise<void>(resolve => { daemon.closeAllConnections(); daemon.close(() => resolve()); }));
    const port = (daemon.address() as { port: number }).port;
    const path = '/api/sessions/session-a/lark-tool-identity';
    const { host, auth } = await start({
      loopbackServices: [{
        id: 'lark-tool-identity', listenPort: port, upstreamPort: port, method: 'POST', path,
        forwardHeaders: ['content-type'], upstreamTimeoutMs,
      }],
    });
    const result = await unixHttpRequest(host.socketPath, 'POST', path, {
      'x-botmux-egress-auth': auth,
      'x-botmux-loopback-service': 'lark-tool-identity',
      'content-type': 'application/json',
    }, Buffer.from('{"mode":"user"}'));
    expect(result.status).toBe(expectedStatus);
    if (expectedStatus === 200) expect(result.body.toString('utf8')).toBe('{"ok":true}');
  });

  it.each([0, -1, 1.5, Number.NaN])('rejects a loopback service with upstream timeout %s', async upstreamTimeoutMs => {
    await expect(start({
      loopbackServices: [{
        id: 'lark-tool-identity', listenPort: 7950, upstreamPort: 7950, method: 'POST',
        path: '/api/sessions/session-a/lark-tool-identity', forwardHeaders: ['content-type'], upstreamTimeoutMs,
      }],
    })).rejects.toThrow('invalid_protected_loopback_service');
  });
});
