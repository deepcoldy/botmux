import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createConnection } from 'node:net';
import { EventEmitter, once } from 'node:events';
import type { InstalledPluginRecord } from '../src/core/plugins/types.js';
import {
  createPluginWebhookRouteHandler,
  earlyGuardPluginProxyRequest,
  PluginWebhookRateLimiter,
} from '../src/dashboard/plugin-webhook-routes.js';
import type { PluginLoopbackTargetResult } from '../src/core/plugins/webhooks/service-target.js';

interface RecordedUpstreamRequest {
  method: string;
  url: string;
  rawHeaders: string[];
  headers: IncomingMessage['headers'];
  rawBody: Buffer;
}

async function listenServer(server: Server): Promise<number> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return (server.address() as import('node:net').AddressInfo).port;
}

async function closeServer(server: Server | undefined): Promise<void> {
  if (!server?.listening) return;
  server.closeAllConnections?.();
  await new Promise<void>(resolve => server.close(() => resolve()));
}

function sendHttp(port: number, opts: {
  method: string;
  path: string;
  headers?: Record<string, string | string[]>;
  body?: Buffer | string;
  chunked?: boolean;
}): Promise<{ status: number; headers: IncomingMessage['headers']; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host: '127.0.0.1',
      port,
      method: opts.method,
      path: opts.path,
      headers: opts.headers,
      agent: false,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', c => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      res.on('end', () => resolve({
        status: res.statusCode ?? 0,
        headers: res.headers,
        body: Buffer.concat(chunks),
      }));
      res.on('error', reject);
    });
    req.on('error', reject);
    if (opts.chunked && opts.body !== undefined) {
      const buf = Buffer.isBuffer(opts.body) ? opts.body : Buffer.from(opts.body);
      req.write(buf.subarray(0, Math.ceil(buf.length / 2)));
      req.write(buf.subarray(Math.ceil(buf.length / 2)));
      req.end();
    } else if (opts.body !== undefined) {
      req.end(opts.body);
    } else {
      req.end();
    }
  });
}

function sendRawHttpLine(port: number, rawRequest: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = createConnection({ host: '127.0.0.1', port }, () => {
      sock.write(rawRequest);
    });
    const chunks: Buffer[] = [];
    sock.on('data', c => chunks.push(c));
    sock.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    sock.on('error', reject);
  });
}

function makePluginRecord(
  id: string,
  webhooks?: NonNullable<InstalledPluginRecord['contributions']>['webhooks'],
  extraContributions?: Partial<NonNullable<InstalledPluginRecord['contributions']>>,
): InstalledPluginRecord {
  return {
    id,
    packageName: `botmux-plugin-${id}`,
    version: '1.0.0',
    source: { type: 'local', spec: '/tmp/plugin' },
    manifest: { schemaVersion: 1, id, service: { mode: 'manual' } },
    contributions: {
      service: { entry: 'service/index.js', mode: 'manual' },
      ...(webhooks ? { webhooks } : {}),
      ...(extraContributions ?? {}),
    },
    installedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

describe('plugin webhook route gateway (POST /webhook/plugin/:pluginId/*)', () => {
  const servers: Server[] = [];

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    while (servers.length > 0) {
      await closeServer(servers.pop());
    }
  });

  async function startFixture(opts: {
    plugins: Record<string, InstalledPluginRecord>;
    resolveTarget?: (id: string) => PluginLoopbackTargetResult;
    upstreamHandler?: (req: IncomingMessage, rawBody: Buffer, res: ServerResponse) => void;
    rateLimiter?: PluginWebhookRateLimiter;
    trustedProxyHops?: number;
    timeoutMs?: number;
    bodyReadTimeoutMs?: number;
    bodyIdleTimeoutMs?: number;
    maxResponseBytes?: number;
    maxConcurrent?: number;
    maxConcurrentPerIp?: number;
    maxConcurrentPerPlugin?: number;
    maxInflightBytes?: number;
    maxInflightBytesPerIp?: number;
    maxInflightBytesPerPlugin?: number;
  }) {
    const recorded: RecordedUpstreamRequest[] = [];
    const upstream = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', c => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      req.on('end', () => {
        const rawBody = Buffer.concat(chunks);
        recorded.push({
          method: req.method ?? '',
          url: req.url ?? '',
          rawHeaders: [...req.rawHeaders],
          headers: { ...req.headers },
          rawBody,
        });
        if (opts.upstreamHandler) {
          opts.upstreamHandler(req, rawBody, res);
          return;
        }
        res.writeHead(202, {
          'content-type': 'application/json',
          'set-cookie': 'evil=1; Path=/',
          'access-control-allow-origin': '*',
          'x-botmux-login-url': 'https://phish.example',
        });
        res.end(JSON.stringify({ accepted: true, bytes: rawBody.byteLength }));
      });
    });
    servers.push(upstream);
    const upstreamPort = await listenServer(upstream);
    const loopbackToken = 'W'.repeat(43);

    const handler = createPluginWebhookRouteHandler({
      getInstalledPlugin: id => (Object.hasOwn(opts.plugins, id) ? opts.plugins[id] : undefined),
      resolveTarget: opts.resolveTarget ?? (() => ({
        ok: true, host: '127.0.0.1', port: upstreamPort, token: loopbackToken, pid: process.pid, processStart: 'boot-1',
      })),
      rateLimiter: opts.rateLimiter,
      trustedProxyHops: opts.trustedProxyHops,
      timeoutMs: opts.timeoutMs,
      bodyReadTimeoutMs: opts.bodyReadTimeoutMs,
      bodyIdleTimeoutMs: opts.bodyIdleTimeoutMs,
      maxResponseBytes: opts.maxResponseBytes,
      maxConcurrent: opts.maxConcurrent,
      maxConcurrentPerIp: opts.maxConcurrentPerIp,
      maxConcurrentPerPlugin: opts.maxConcurrentPerPlugin,
      maxInflightBytes: opts.maxInflightBytes,
      maxInflightBytesPerIp: opts.maxInflightBytesPerIp,
      maxInflightBytesPerPlugin: opts.maxInflightBytesPerPlugin,
    });

    const front = createServer(async (req, res) => {
      if (earlyGuardPluginProxyRequest(req, res)) return;
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      if (url.pathname === '/__health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (await handler.handle(req, res, url)) return;
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'fell_through' }));
    });
    servers.push(front);
    const frontPort = await listenServer(front);
    return { frontPort, upstreamPort, loopbackToken, recorded, handler };
  }

  it('forwards exact raw body bytes (HMAC-verifiable), chunked bodies, headers, query string, and loopback token without touching global fetch or $http_proxy', async () => {
    vi.stubEnv('http_proxy', 'http://127.0.0.1:1');
    vi.stubEnv('HTTP_PROXY', 'http://127.0.0.1:1');
    vi.stubEnv('no_proxy', '');
    vi.stubEnv('NO_PROXY', '');
    const globalFetch = vi.fn(async () => {
      throw new Error('webhook proxy must not use global fetch');
    });
    vi.stubGlobal('fetch', globalFetch);

    const secret = 'vendor-webhook-signing-secret';
    const { frontPort, loopbackToken, recorded } = await startFixture({
      plugins: {
        demo: makePluginRecord('demo', {
          schemaVersion: 1,
          routes: [
            { path: '/events' },
            { path: '/hooks', prefix: true, endpoint: '/internal/hooks' },
          ],
        }),
      },
    });

    const nonCanonicalJson = Buffer.from('{  "z": 2,   "a": [ 1, 2 ] }\n', 'utf8');
    const signature = `sha256=${createHmac('sha256', secret).update(nonCanonicalJson).digest('hex')}`;

    const res = await sendHttp(frontPort, {
      method: 'POST',
      path: '/webhook/plugin/demo/hooks/repo-42?delivery=1&flag',
      headers: {
        'content-type': 'application/json',
        'x-signature-256': signature,
        'x-event-type': 'push',
        'x-multi': ['first', 'second'],
        cookie: 'botmux_dashboard_token=should-never-leak',
        authorization: 'Bearer external-caller-token',
        'x-botmux-webhook-plugin-id': 'spoofed-plugin',
        connection: 'x-hop-secret',
        'x-hop-secret': 'drop-me',
      },
      body: nonCanonicalJson,
    });

    expect(res.status).toBe(202);
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect(res.headers['x-botmux-login-url']).toBeUndefined();
    expect(res.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['cross-origin-resource-policy']).toBe('same-origin');
    expect(res.headers['cache-control']).toBe('no-store');

    expect(recorded).toHaveLength(1);
    const up = recorded[0];
    expect(up.url).toBe('/internal/hooks/repo-42?delivery=1&flag');
    expect(up.rawBody.equals(nonCanonicalJson)).toBe(true);
    const recomputed = `sha256=${createHmac('sha256', secret).update(up.rawBody).digest('hex')}`;
    expect(recomputed).toBe(up.headers['x-signature-256']);
    expect(up.headers.authorization).toBe(`Bearer ${loopbackToken}`);
    expect(up.headers['x-botmux-webhook-forwarded-authorization']).toBe('Bearer external-caller-token');
    expect(up.headers['x-botmux-webhook-plugin-id']).toBe('demo');
    expect(up.headers['x-botmux-webhook-route']).toBe('/hooks');
    expect(up.headers['x-botmux-webhook-original-path']).toBe('/hooks/repo-42');
    expect(up.headers.cookie).toBeUndefined();
    expect(up.headers['x-hop-secret']).toBeUndefined();
    expect(up.headers['x-event-type']).toBe('push');
    expect(up.rawHeaders.filter((_, i) => i % 2 === 0 && up.rawHeaders[i].toLowerCase() === 'x-multi')).toHaveLength(2);

    // Valid multi-chunk chunked body fidelity + Transfer-Encoding stripped + Content-Length synthesized
    const chunkedPayload = Buffer.from('{ "chunked": true, "bytes": [1,2,3] }', 'utf8');
    const chunkedRes = await sendHttp(frontPort, {
      method: 'POST',
      path: '/webhook/plugin/demo/events',
      headers: { 'content-type': 'application/json', 'transfer-encoding': 'chunked' },
      body: chunkedPayload,
      chunked: true,
    });
    expect(chunkedRes.status).toBe(202);
    expect(recorded[1].rawBody.equals(chunkedPayload)).toBe(true);
    expect(recorded[1].headers['transfer-encoding']).toBeUndefined();
    expect(recorded[1].headers['content-length']).toBe(String(chunkedPayload.byteLength));

    // Binary / invalid UTF-8 / NUL bytes + Content-Encoding preserved untouched
    const rawBinary = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0xff, 0xfe, 0x80, 0xc0, 0xaf, 0x00, 0x42]);
    const binRes = await sendHttp(frontPort, {
      method: 'POST',
      path: '/webhook/plugin/demo/events',
      headers: { 'content-type': 'application/octet-stream', 'content-encoding': 'gzip' },
      body: rawBinary,
    });
    expect(binRes.status).toBe(202);
    expect(recorded[2].rawBody.equals(rawBinary)).toBe(true);
    expect(recorded[2].headers['content-encoding']).toBe('gzip');

    // Zero-byte body fidelity
    const emptyRes = await sendHttp(frontPort, {
      method: 'POST',
      path: '/webhook/plugin/demo/events',
      body: Buffer.alloc(0),
    });
    expect(emptyRes.status).toBe(202);
    expect(recorded[3].rawBody.byteLength).toBe(0);
    expect(recorded[3].headers['content-length']).toBe('0');
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it('strips arbitrary x-botmux-* headers, rejects duplicate Authorization, and resists Connection-nomination spoofing', async () => {
    const { frontPort, loopbackToken, recorded } = await startFixture({
      plugins: {
        demo: makePluginRecord('demo', { schemaVersion: 1, routes: [{ path: '/events' }] }),
      },
    });

    // 1. Arbitrary spoofed x-botmux-* headers without incoming Authorization must be stripped
    const spoofRes = await sendHttp(frontPort, {
      method: 'POST',
      path: '/webhook/plugin/demo/events',
      headers: {
        'content-type': 'application/json',
        'x-botmux-role': 'owner',
        'x-botmux-proxy-source': 'dashboard',
        'x-botmux-webhook-forwarded-authorization': 'Bearer forged-external-token',
      },
      body: '{}',
    });
    expect(spoofRes.status).toBe(202);
    expect(recorded).toHaveLength(1);
    expect(recorded[0].headers['x-botmux-role']).toBeUndefined();
    expect(recorded[0].headers['x-botmux-proxy-source']).toBeUndefined();
    expect(recorded[0].headers['x-botmux-webhook-forwarded-authorization']).toBeUndefined();
    expect(recorded[0].headers['x-botmux-webhook-plugin-id']).toBe('demo');
    expect(recorded[0].headers.authorization).toBe(`Bearer ${loopbackToken}`);

    // 2. Duplicate Authorization headers fail closed with 400 duplicate_authorization_header
    const dupAuthRaw = await sendRawHttpLine(
      frontPort,
      `POST /webhook/plugin/demo/events HTTP/1.1\r\nHost: 127.0.0.1:${frontPort}\r\nAuthorization: Bearer first\r\nAuthorization: Bearer second\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}`,
    );
    expect(dupAuthRaw).toMatch(/^HTTP\/1\.1 400 /);
    expect(JSON.parse(dupAuthRaw.slice(dupAuthRaw.indexOf('\r\n\r\n') + 4))).toEqual({
      ok: false,
      error: 'duplicate_authorization_header',
    });
    expect(recorded).toHaveLength(1);

    // 3. Connection-nominated Authorization / host headers cannot leak incoming auth or strip host headers
    const connNomRaw = await sendRawHttpLine(
      frontPort,
      `POST /webhook/plugin/demo/events HTTP/1.1\r\nHost: 127.0.0.1:${frontPort}\r\nConnection: close, authorization, x-botmux-webhook-plugin-id\r\nAuthorization: Bearer nominated-external-token\r\nX-Botmux-Webhook-Plugin-Id: spoofed-plugin\r\nContent-Length: 2\r\n\r\n{}`,
    );
    expect(connNomRaw).toMatch(/^HTTP\/1\.1 202 /);
    expect(recorded).toHaveLength(2);
    expect(recorded[1].headers.authorization).toBe(`Bearer ${loopbackToken}`);
    expect(recorded[1].headers['x-botmux-webhook-plugin-id']).toBe('demo');
    expect(recorded[1].headers['x-botmux-webhook-forwarded-authorization']).toBeUndefined();
  });

  it('blocks runtime-overlapping reserved internal endpoints, corrupted registry definitions, and prototype keys (constructor)', async () => {
    const { frontPort, recorded } = await startFixture({
      plugins: {
        // Hand-edited registry record bypassing scan-time overlap check
        tampered: makePluginRecord(
          'tampered',
          {
            schemaVersion: 1,
            routes: [
              { path: '/botmux/inputs/v1' },
              { path: '/hooks', prefix: true, endpoint: '/rpc' },
            ],
          },
          { commands: { schemaVersion: 1, endpoint: '/rpc/cmd', commands: [{ name: '/demo-cmd' }] } },
        ),
        corrupt: makePluginRecord('corrupt', { schemaVersion: 99 as 1, routes: [] }),
        'no-hooks': makePluginRecord('no-hooks'),
        demo: makePluginRecord('demo', {
          schemaVersion: 1,
          routes: [{ path: '/events' }, { path: '/hooks', prefix: true }],
        }),
      },
    });

    for (const [path, expectedError] of [
      ['/webhook/plugin/unknown/events', 'plugin_not_found'],
      ['/webhook/plugin/constructor/events', 'plugin_not_found'],
      ['/webhook/plugin/no-hooks/events', 'webhook_route_not_found'],
      ['/webhook/plugin/corrupt/events', 'webhook_route_not_found'],
      ['/webhook/plugin/tampered/botmux/inputs/v1', 'webhook_route_not_found'],
      ['/webhook/plugin/tampered/hooks/cmd', 'webhook_route_not_found'],
      ['/webhook/plugin/demo/other', 'webhook_route_not_found'],
      ['/webhook/plugin/demo/hooks-admin', 'webhook_route_not_found'],
      ['/webhook/plugin/demo/events/sub', 'webhook_route_not_found'],
      ['/webhook/plugin/demo/events/', 'webhook_route_not_found'],
      ['/webhook/plugin/demo', 'webhook_route_not_found'],
      ['/webhook/plugin/demo/', 'webhook_route_not_found'],
      ['/webhook/plugin', 'webhook_route_not_found'],
    ] as const) {
      const res = await sendHttp(frontPort, { method: 'POST', path, body: '{}' });
      expect(res.status).toBe(404);
      expect(JSON.parse(res.body.toString('utf8'))).toEqual({ ok: false, error: expectedError });
    }
    expect(recorded).toHaveLength(0);
  });

  it('rejects non-POST methods with 405 and Allow: POST, and rejects smuggled HTTP framing over TCP', async () => {
    const { frontPort, recorded } = await startFixture({
      plugins: { demo: makePluginRecord('demo', { schemaVersion: 1, routes: [{ path: '/events' }] }) },
    });

    const getRes = await sendHttp(frontPort, { method: 'GET', path: '/webhook/plugin/demo/events' });
    expect(getRes.status).toBe(405);
    expect(getRes.headers.allow).toBe('POST');

    // Transfer-Encoding: gzip, chunked reaches handler in both Node and Bun -> 501
    const badTe = await sendRawHttpLine(
      frontPort,
      `POST /webhook/plugin/demo/events HTTP/1.1\r\nHost: 127.0.0.1:${frontPort}\r\nTransfer-Encoding: gzip, chunked\r\nConnection: close\r\n\r\n0\r\n\r\n`,
    );
    expect(badTe).toMatch(/^HTTP\/1\.1 501 /);
    expect(badTe.toLowerCase()).toContain('connection: close');
    expect(JSON.parse(badTe.slice(badTe.indexOf('\r\n\r\n') + 4))).toEqual({
      ok: false,
      error: 'unsupported_transfer_encoding',
    });

    // Duplicate Content-Length -> 400 (parser in Node, handler in Bun)
    const dupCl = await sendRawHttpLine(
      frontPort,
      `POST /webhook/plugin/demo/events HTTP/1.1\r\nHost: 127.0.0.1:${frontPort}\r\nContent-Length: 2\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}`,
    );
    expect(dupCl).toMatch(/^HTTP\/1\.1 400 /);
    expect(dupCl.toLowerCase()).toContain('connection: close');
    const dupBody = dupCl.slice(dupCl.indexOf('\r\n\r\n') + 4).trim();
    if (dupBody) expect(JSON.parse(dupBody)).toEqual({ ok: false, error: 'duplicate_content_length' });

    // TE + CL -> 400
    const teCl = await sendRawHttpLine(
      frontPort,
      `POST /webhook/plugin/demo/events HTTP/1.1\r\nHost: 127.0.0.1:${frontPort}\r\nTransfer-Encoding: chunked\r\nContent-Length: 5\r\nConnection: close\r\n\r\n0\r\n\r\n`,
    );
    expect(teCl).toMatch(/^HTTP\/1\.1 400 /);
    expect(recorded).toHaveLength(0);
  });

  it('enforces exact maxBodyBytes boundary, headers-only fast-fail 413, chunked 413, and body read timeouts (408)', async () => {
    const { frontPort, recorded } = await startFixture({
      plugins: {
        demo: makePluginRecord('demo', {
          schemaVersion: 1,
          routes: [{ path: '/events', maxBodyBytes: 64 }],
        }),
      },
      bodyIdleTimeoutMs: 80,
      bodyReadTimeoutMs: 250,
    });

    // Exact 64 bytes succeeds
    const exactOk = await sendHttp(frontPort, {
      method: 'POST',
      path: '/webhook/plugin/demo/events',
      body: Buffer.alloc(64, 0x61),
    });
    expect(exactOk.status).toBe(202);
    expect(recorded[0].rawBody.byteLength).toBe(64);

    // 65 bytes fails with 413
    const overOne = await sendHttp(frontPort, {
      method: 'POST',
      path: '/webhook/plugin/demo/events',
      body: Buffer.alloc(65, 0x61),
    });
    expect(overOne.status).toBe(413);
    expect(JSON.parse(overOne.body.toString('utf8'))).toMatchObject({ ok: false, error: 'body_too_large', maxBodyBytes: 64 });

    // Headers-only fast-fail 413 (0 body bytes transmitted; must not wait for 408 idle timeout)
    const fastFailRaw = await new Promise<string>((resolve, reject) => {
      const sock = createConnection({ host: '127.0.0.1', port: frontPort }, () => {
        sock.write(`POST /webhook/plugin/demo/events HTTP/1.1\r\nHost: 127.0.0.1:${frontPort}\r\nContent-Length: 10000\r\n\r\n`);
      });
      const chunks: Buffer[] = [];
      sock.on('data', c => {
        chunks.push(c);
        const text = Buffer.concat(chunks).toString('utf8');
        if (text.includes('"body_too_large"')) {
          sock.end();
          resolve(text);
        }
      });
      sock.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      sock.on('error', reject);
    });
    expect(fastFailRaw).toMatch(/^HTTP\/1\.1 413 /);
    expect(fastFailRaw.toLowerCase()).toContain('connection: close');

    // Chunked streaming overflow -> 413
    const bigChunked = await sendHttp(frontPort, {
      method: 'POST',
      path: '/webhook/plugin/demo/events',
      headers: { 'transfer-encoding': 'chunked' },
      body: Buffer.alloc(65, 0x62),
      chunked: true,
    });
    expect(bigChunked.status).toBe(413);

    // Idle body read timeout -> 408 request_timeout
    const idleTimeoutRaw = await new Promise<string>((resolve, reject) => {
      const sock = createConnection({ host: '127.0.0.1', port: frontPort }, () => {
        sock.write(`POST /webhook/plugin/demo/events HTTP/1.1\r\nHost: 127.0.0.1:${frontPort}\r\nContent-Length: 32\r\n\r\n`);
      });
      const chunks: Buffer[] = [];
      sock.on('data', c => {
        chunks.push(c);
        const text = Buffer.concat(chunks).toString('utf8');
        if (text.includes('"request_timeout"')) {
          sock.end();
          resolve(text);
        }
      });
      sock.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      sock.on('error', reject);
    });
    expect(idleTimeoutRaw).toMatch(/^HTTP\/1\.1 408 /);
    expect(recorded).toHaveLength(1);
  });

  it('rejects synthetic truncated body (complete=true with short byte count) with 400 truncated_request_body', async () => {
    const { handler } = await startFixture({
      plugins: { demo: makePluginRecord('demo', { schemaVersion: 1, routes: [{ path: '/events' }] }) },
    });
    const req = Object.assign(new EventEmitter(), {
      method: 'POST',
      url: '/webhook/plugin/demo/events',
      rawHeaders: ['Content-Length', '10'],
      headers: { 'content-length': '10' },
      complete: true,
      socket: { remoteAddress: '127.0.0.1', destroy: vi.fn() },
      pause: vi.fn(),
      resume: vi.fn(() => {
        queueMicrotask(() => {
          req.emit('data', Buffer.from('abc'));
          req.emit('end');
        });
      }),
    }) as unknown as IncomingMessage;
    let statusCode = 0;
    let endedBody = '';
    const res = Object.assign(new EventEmitter(), {
      headersSent: false,
      writableEnded: false,
      writeHead: (code: number) => { statusCode = code; res.headersSent = true; },
      end: (buf?: Buffer | string) => { endedBody = String(buf ?? ''); res.writableEnded = true; res.emit('finish'); },
      destroy: vi.fn(),
    }) as unknown as ServerResponse;

    await handler.handle(req, res, new URL('http://localhost/webhook/plugin/demo/events'));
    expect(statusCode).toBe(400);
    expect(JSON.parse(endedBody)).toEqual({ ok: false, error: 'truncated_request_body' });
  });

  it('blocks path traversal (including 4-level /__health escape), encoded/cased/double-slash prefix bypasses, and absolute-form URLs with 400', async () => {
    const { frontPort, recorded } = await startFixture({
      plugins: {
        demo: makePluginRecord('demo', { schemaVersion: 1, routes: [{ path: '/events', prefix: true }] }),
      },
    });

    for (const rawTarget of [
      '/webhook/plugin/demo/events/../../../../__health',
      '/webhook/plugin/demo/events/../../secret',
      '/webhook/plugin/demo/events/%2e%2e/secret',
      '/webhook/plugin/demo/events/a%2fb',
      '/webhook/%70lugin/demo/events',
      '/webhook/a/../%70lugin/demo/events',
      '/./webhook/Plugin/demo/events',
      '/webhook//plugin/demo/events/../../../../../__health',
      '/webhook/foo/../plugin/demo/events',
      'http://evil.example/webhook/plugin/demo/events',
    ]) {
      const rawRes = await sendRawHttpLine(
        frontPort,
        `POST ${rawTarget} HTTP/1.1\r\nHost: 127.0.0.1:${frontPort}\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}`,
      );
      expect(rawRes).toMatch(/^HTTP\/1\.1 400 /);
    }
    expect(recorded).toHaveLength(0);
  });

  it('partitions concurrency and in-flight buffer budgets across IPs and plugins and frees buffers after upstream write', async () => {
    const pendingRes: ServerResponse[] = [];
    const { frontPort } = await startFixture({
      plugins: {
        alpha: makePluginRecord('alpha', { schemaVersion: 1, routes: [{ path: '/events' }] }),
        beta: makePluginRecord('beta', { schemaVersion: 1, routes: [{ path: '/events' }] }),
      },
      trustedProxyHops: 1,
      maxConcurrent: 4,
      maxConcurrentPerIp: 1,
      maxConcurrentPerPlugin: 2,
      upstreamHandler: (_req, _body, res) => {
        pendingRes.push(res);
      },
    });

    // IP 1 occupies its 1-slot per-IP concurrency limit on alpha
    const firstPromise = sendHttp(frontPort, {
      method: 'POST',
      path: '/webhook/plugin/alpha/events',
      headers: { 'x-forwarded-for': '198.51.100.1' },
      body: '1234',
    });
    await new Promise(r => setTimeout(r, 40));

    // Same IP 1 hitting beta is rejected with 429 webhook_concurrency_limited
    const ip1Second = await sendHttp(frontPort, {
      method: 'POST',
      path: '/webhook/plugin/beta/events',
      headers: { 'x-forwarded-for': '198.51.100.1' },
      body: '1234',
    });
    expect(ip1Second.status).toBe(429);
    expect(JSON.parse(ip1Second.body.toString('utf8')).error).toBe('webhook_concurrency_limited');

    // Different IP 2 still succeeds on beta (single IP cannot DoS everyone else)
    const ip2Promise = sendHttp(frontPort, {
      method: 'POST',
      path: '/webhook/plugin/beta/events',
      headers: { 'x-forwarded-for': '198.51.100.2' },
      body: '1234',
    });
    await new Promise(r => setTimeout(r, 40));
    expect(pendingRes).toHaveLength(2);

    for (const r of pendingRes) {
      r.writeHead(202, { 'content-type': 'application/json' });
      r.end('{"ok":true}');
    }
    expect((await firstPromise).status).toBe(202);
    expect((await ip2Promise).status).toBe(202);
  });

  it('enforces edge, global, and per-plugin rate limits and ignores X-Forwarded-For when trustedProxyHops is 0', async () => {
    let now = 1_000_000;
    const directLimiter = new PluginWebhookRateLimiter({
      now: () => now,
      windowMs: 60_000,
      maxPerIpPerWindow: 2,
      maxGlobalPerWindow: 3,
      maxTrackedIps: 2,
    });
    expect(directLimiter.admitEdge('1.1.1.1').ok).toBe(true);
    expect(directLimiter.admitEdge('1.1.1.1').ok).toBe(true);
    expect(directLimiter.admitEdge('1.1.1.1').ok).toBe(false);
    expect(directLimiter.admitEdge('2.2.2.2').ok).toBe(true);
    // Global cap hit (3)
    expect(directLimiter.admitEdge('3.3.3.3').ok).toBe(false);
    // Window expires
    now += 61_000;
    expect(directLimiter.admitEdge('1.1.1.1').ok).toBe(true);

    // HTTP test: trustedProxyHops=0 ignores spoofed X-Forwarded-For, and nonexistent plugin IDs cannot evict `demo`
    const httpLimiter = new PluginWebhookRateLimiter({
      windowMs: 60_000,
      maxPerIpPerWindow: 2,
      maxPerPluginPerWindow: 10,
      maxGlobalPerWindow: 20,
    });
    const { frontPort } = await startFixture({
      plugins: { demo: makePluginRecord('demo', { schemaVersion: 1, routes: [{ path: '/events' }] }) },
      rateLimiter: httpLimiter,
      trustedProxyHops: 0,
    });
    expect((await sendHttp(frontPort, { method: 'POST', path: '/webhook/plugin/demo/events', headers: { 'x-forwarded-for': '203.0.113.1' }, body: '{}' })).status).toBe(202);
    expect((await sendHttp(frontPort, { method: 'POST', path: '/webhook/plugin/demo/events', headers: { 'x-forwarded-for': '203.0.113.2' }, body: '{}' })).status).toBe(202);
    const blocked = await sendHttp(frontPort, { method: 'POST', path: '/webhook/plugin/demo/events', headers: { 'x-forwarded-for': '203.0.113.3' }, body: '{}' });
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThanOrEqual(1);
  });

  it('handles 503 missing token/unreachable, 504 timeout, 502 101/oversized/bad-TE, 204/205 zero-length framing, and upstream FIN truncation', async () => {
    // Missing token -> 503
    const { frontPort: noTokPort } = await startFixture({
      plugins: { demo: makePluginRecord('demo', { schemaVersion: 1, routes: [{ path: '/events' }] }) },
      resolveTarget: () => ({ ok: false, status: 503, error: 'plugin_service_token_unavailable' }),
    });
    const noTok = await sendHttp(noTokPort, { method: 'POST', path: '/webhook/plugin/demo/events', body: '{}' });
    expect(noTok.status).toBe(503);
    expect(JSON.parse(noTok.body.toString('utf8'))).toEqual({ ok: false, error: 'plugin_service_token_unavailable' });

    // ECONNREFUSED -> 503 plugin_service_unreachable
    const deadServer = createServer();
    const deadPort = await listenServer(deadServer);
    await closeServer(deadServer);
    const { frontPort: deadFront } = await startFixture({
      plugins: { demo: makePluginRecord('demo', { schemaVersion: 1, routes: [{ path: '/events' }] }) },
      resolveTarget: () => ({ ok: true, host: '127.0.0.1', port: deadPort, token: 'W'.repeat(43), pid: 1, processStart: 'x' }),
    });
    const unreachable = await sendHttp(deadFront, { method: 'POST', path: '/webhook/plugin/demo/events', body: '{}' });
    expect(unreachable.status).toBe(503);
    expect(JSON.parse(unreachable.body.toString('utf8'))).toEqual({ ok: false, error: 'plugin_service_unreachable' });

    // Timeout -> 504
    const { frontPort: timeoutPort } = await startFixture({
      plugins: { demo: makePluginRecord('demo', { schemaVersion: 1, routes: [{ path: '/events' }] }) },
      timeoutMs: 120,
      upstreamHandler: () => { /* hang intentionally */ },
    });
    const tRes = await sendHttp(timeoutPort, { method: 'POST', path: '/webhook/plugin/demo/events', body: '{}' });
    expect(tRes.status).toBe(504);
    expect(JSON.parse(tRes.body.toString('utf8')).error).toBe('plugin_service_timeout');

    // 204 strips content-length, 205 normalizes content-length to '0', oversized response -> 502, unsupported upstream TE -> 502
    const { frontPort: statusPort } = await startFixture({
      plugins: { demo: makePluginRecord('demo', { schemaVersion: 1, routes: [{ path: '/events', prefix: true }] }) },
      maxResponseBytes: 32,
      upstreamHandler: (req, _body, res) => {
        if (req.url === '/events/204') {
          res.writeHead(204, { 'content-length': '0' });
          res.end();
        } else if (req.url === '/events/205') {
          res.writeHead(205, { 'content-length': '5' });
          res.end('hello');
        } else if (req.url === '/events/big') {
          res.writeHead(200, { 'content-length': '64' });
          res.end('x'.repeat(64));
        } else if (req.url === '/events/bad-te') {
          res.socket?.write('HTTP/1.1 200 OK\r\nTransfer-Encoding: gzip, chunked\r\n\r\n0\r\n\r\n');
          res.socket?.end();
        } else {
          res.socket?.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
        }
      },
    });
    const r204 = await sendHttp(statusPort, { method: 'POST', path: '/webhook/plugin/demo/events/204', body: '{}' });
    expect(r204.status).toBe(204);
    expect(r204.headers['content-length']).toBeUndefined();

    const r205 = await sendHttp(statusPort, { method: 'POST', path: '/webhook/plugin/demo/events/205', body: '{}' });
    expect(r205.status).toBe(205);
    expect(r205.headers['content-length']).toBe('0');
    expect(r205.body.byteLength).toBe(0);

    const rBig = await sendHttp(statusPort, { method: 'POST', path: '/webhook/plugin/demo/events/big', body: '{}' });
    expect(rBig.status).toBe(502);
    expect(JSON.parse(rBig.body.toString('utf8')).error).toBe('plugin_service_response_too_large');

    const rBadTe = await sendHttp(statusPort, { method: 'POST', path: '/webhook/plugin/demo/events/bad-te', body: '{}' });
    expect(rBadTe.status).toBe(502);
    expect(JSON.parse(rBadTe.body.toString('utf8')).error).toBe('plugin_service_invalid_response');

    const r101 = await sendHttp(statusPort, { method: 'POST', path: '/webhook/plugin/demo/events/101', body: '{}' });
    expect(r101.status).toBe(502);
  });
});
