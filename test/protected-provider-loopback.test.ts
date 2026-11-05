import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer, request as httpRequest } from 'node:http';
import { type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PROTECTED_HTTP_LOOPBACK_PLACEHOLDER_ORIGIN,
  materializeProtectedHttpLoopbackArgs,
  readCodexProtectedProviderBridge,
  selectCodexProtectedProviderBridge,
  startProtectedLocalServiceLoopbackBridge,
  startProtectedHttpEgressLoopbackBridge,
} from '../src/core/protected-http-egress-loopback.js';
import { buildNetworkLaunchPlan } from '../src/core/sandbox-network-launch.js';
import {
  normalizeProtectedHttpEgressPolicy,
  protectedHttpEgressPolicyDigest,
} from '../src/core/protected-http-egress.js';
import { startSessionProtectedHttpEgressHost } from '../src/core/protected-http-egress-host.js';

const roots: string[] = [];
const servers: Server[] = [];
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  await Promise.allSettled(cleanups.splice(0).map(cleanup => cleanup()));
  await Promise.allSettled(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'botmux-provider-loopback-'));
  roots.push(root);
  return root;
}

const policy = normalizeProtectedHttpEgressPolicy({
  id: 'fixture.items.write.v1',
  targets: [{
    scheme: 'https',
    host: 'fixture.internal.example',
    port: 443,
    denyRoutes: [{ methods: ['POST'], path: '/v1/items/update' }],
  }],
})!;

describe('protected provider loopback selection', () => {
  it('bridges only the active Codex provider when its HTTPS origin is protected', () => {
    const selected = selectCodexProtectedProviderBridge({
      config: {
        model_provider: 'active',
        model_providers: {
          inactive: { base_url: 'https://fixture.internal.example/inactive' },
          active: { base_url: 'https://fixture.internal.example/model/relay' },
        },
      },
      policy,
      socketPath: '/run/private/egress.sock',
    });

    expect(selected).toEqual({
      providerId: 'active',
      baseUrlOverride: `${PROTECTED_HTTP_LOOPBACK_PLACEHOLDER_ORIGIN}/model/relay`,
      bridge: {
        socketPath: '/run/private/egress.sock',
        policyId: policy.id,
        targetIndex: 0,
        placeholderOrigin: PROTECTED_HTTP_LOOPBACK_PLACEHOLDER_ORIGIN,
      },
    });
  });

  it('does not bridge an inactive matching provider or an unrelated active origin', () => {
    expect(selectCodexProtectedProviderBridge({
      config: {
        model_provider: 'active',
        model_providers: {
          active: { base_url: 'https://model.example/v1' },
          inactive: { base_url: 'https://fixture.internal.example/model/relay' },
        },
      },
      policy,
      socketPath: '/run/private/egress.sock',
    })).toBeUndefined();
  });

  it('reads the active provider from config.toml without exposing parse-time credentials', () => {
    const root = tempRoot();
    const configPath = join(root, 'config.toml');
    writeFileSync(configPath, [
      'model_provider = "active"',
      '[model_providers.active]',
      'base_url = "https://fixture.internal.example/model/relay"',
      '[model_providers.active.http_headers]',
      'Authorization = "Bearer provider-secret-fixture"',
      '',
    ].join('\n'));
    expect(readCodexProtectedProviderBridge({
      configPath,
      policy,
      socketPath: '/run/private/egress.sock',
    })?.providerId).toBe('active');

    writeFileSync(configPath, 'credential = "provider-secret-fixture\n');
    let message = '';
    try {
      readCodexProtectedProviderBridge({ configPath, policy, socketPath: '/run/private/egress.sock' });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe('protected_codex_provider_config_invalid');
    expect(message).not.toContain('provider-secret-fixture');
  });
});

describe('protected HTTP loopback bridge', () => {
  it('keeps guard credentials out of task args and injects trusted routing headers at the Unix boundary', async () => {
    const root = tempRoot();
    chmodSync(root, 0o700);
    const socketPath = join(root, 'e.sock');
    const auth = 'guard-auth-token-fixture';
    writeFileSync(join(root, 'egress-auth'), `${auth}\n`, { mode: 0o600 });
    let observed = '';
    const unix = createHttpServer((request, response) => {
      const body: Buffer[] = [];
      request.on('data', chunk => body.push(Buffer.from(chunk)));
      request.once('end', () => {
        observed = [
          `${request.method} ${request.url} HTTP/${request.httpVersion}`,
          ...request.rawHeaders.reduce<string[]>((lines, value, index) => {
            if (index % 2 === 0) lines.push(`${value}: ${request.rawHeaders[index + 1]}`);
            return lines;
          }, []),
          '',
          Buffer.concat(body).toString('utf8'),
        ].join('\r\n');
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.write('data: first\n\n');
        response.end('data: second\n\n');
      });
    });
    servers.push(unix);
    await new Promise<void>((resolve, reject) => {
      unix.once('error', reject);
      unix.listen(socketPath, resolve);
    });

    const bridge = await startProtectedHttpEgressLoopbackBridge({
      socketPath,
      policyId: policy.id,
      targetIndex: 0,
      placeholderOrigin: PROTECTED_HTTP_LOOPBACK_PLACEHOLDER_ORIGIN,
    });
    cleanups.push(() => bridge.close());

    const response = await new Promise<{ status: number; chunks: string[] }>((resolve, reject) => {
      const chunks: string[] = [];
      const req = httpRequest(`${bridge.origin}/model/responses`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer model-token',
          'content-type': 'application/json',
          'x-botmux-egress-auth': 'attacker-value',
          'x-botmux-egress-policy': 'attacker-policy',
          'x-botmux-egress-target': '7',
        },
      }, res => {
        res.setEncoding('utf8');
        res.on('data', chunk => chunks.push(chunk));
        res.once('end', () => resolve({ status: res.statusCode ?? 0, chunks }));
      });
      req.once('error', reject);
      req.end('{"stream":true}');
    });

    expect(response.status).toBe(200);
    expect(response.chunks.join('')).toBe('data: first\n\ndata: second\n\n');
    expect(observed).toContain('POST /model/responses HTTP/1.1');
    expect(observed).toContain(`x-botmux-egress-auth: ${auth}`);
    expect(observed).toContain(`x-botmux-egress-policy: ${policy.id}`);
    expect(observed).toContain('x-botmux-egress-target: 0');
    expect(observed).toContain('authorization: Bearer model-token');
    expect(observed).not.toContain('attacker-value');
    expect(observed).not.toContain('attacker-policy');
  });

  it('replaces exactly one provider placeholder after the bridge binds a dynamic port', () => {
    expect(materializeProtectedHttpLoopbackArgs(
      ['-c', `model_providers.fixture.base_url="${PROTECTED_HTTP_LOOPBACK_PLACEHOLDER_ORIGIN}/relay"`, 'resume', 'sid'],
      PROTECTED_HTTP_LOOPBACK_PLACEHOLDER_ORIGIN,
      'http://127.0.0.1:43123',
    )).toEqual([
      '-c', 'model_providers.fixture.base_url="http://127.0.0.1:43123/relay"', 'resume', 'sid',
    ]);
    expect(() => materializeProtectedHttpLoopbackArgs(
      ['resume', 'sid'],
      PROTECTED_HTTP_LOOPBACK_PLACEHOLDER_ORIGIN,
      'http://127.0.0.1:43123',
    )).toThrow('protected_http_loopback_placeholder_count');
  });

  it('preserves the existing guard decision: reads pass and registered writes are rejected', async () => {
    const root = tempRoot();
    chmodSync(root, 0o700);
    let forwarded = 0;
    const host = await startSessionProtectedHttpEgressHost({
      socketDir: root,
      policy,
      policyDigest: protectedHttpEgressPolicyDigest(policy),
      forward: async () => {
        forwarded++;
        return { status: 200, headers: { 'content-type': 'application/json' }, body: Buffer.from('{"ok":true}') };
      },
    });
    cleanups.push(() => host.close());
    const bridge = await startProtectedHttpEgressLoopbackBridge({
      socketPath: host.socketPath,
      policyId: policy.id,
      targetIndex: 0,
      placeholderOrigin: PROTECTED_HTTP_LOOPBACK_PLACEHOLDER_ORIGIN,
    });
    cleanups.push(() => bridge.close());
    const call = (method: string, path: string) => new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = httpRequest(`${bridge.origin}${path}`, { method }, response => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', chunk => { body += chunk; });
        response.once('end', () => resolve({ status: response.statusCode ?? 0, body }));
      });
      req.once('error', reject);
      req.end();
    });

    await expect(call('GET', '/v1/items/list')).resolves.toEqual({ status: 200, body: '{"ok":true}' });
    await expect(call('POST', '/v1/items/update')).resolves.toEqual({
      status: 403,
      body: '{"code":"botmux_protected_write_required"}',
    });
    expect(forwarded).toBe(1);
  });

  it('carries the bridge contract in the immutable network launch plan', () => {
    const bridge = {
      socketPath: '/run/private/e.sock',
      policyId: policy.id,
      targetIndex: 0,
      placeholderOrigin: PROTECTED_HTTP_LOOPBACK_PLACEHOLDER_ORIGIN,
    };
    const plan = buildNetworkLaunchPlan({
      nft: '/usr/sbin/nft',
      ip: '/usr/sbin/ip',
      unshare: '/usr/bin/unshare',
      slirp: '/usr/bin/slirp4netns',
      nftRules: 'table inet fixture {}',
      command: '/usr/bin/bwrap',
      args: ['--', '/usr/bin/codex'],
      protectedHttpBridge: bridge,
    });

    expect(plan.protectedHttpBridge).toEqual(bridge);
    expect(plan.args).toEqual(['--', '/usr/bin/codex']);
  });

  it('exposes a configured local service on loopback without exposing guard routing controls', async () => {
    const root = tempRoot();
    chmodSync(root, 0o700);
    const socketPath = join(root, 'e.sock');
    const auth = 'guard-auth-token-fixture';
    writeFileSync(join(root, 'egress-auth'), `${auth}\n`, { mode: 0o600 });
    const observed: Array<Record<string, string | undefined>> = [];
    const unix = createHttpServer((request, response) => {
      observed.push({
        method: request.method,
        path: request.url,
        auth: request.headers['x-botmux-egress-auth'] as string | undefined,
        service: request.headers['x-botmux-loopback-service'] as string | undefined,
        session: request.headers['x-botmux-lark-session'] as string | undefined,
        attackerPolicy: request.headers['x-botmux-egress-policy'] as string | undefined,
      });
      request.resume();
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"ok":true}');
    });
    servers.push(unix);
    await new Promise<void>((resolve, reject) => {
      unix.once('error', reject);
      unix.listen(socketPath, resolve);
    });

    const bridge = await startProtectedLocalServiceLoopbackBridge({
      socketPath,
      serviceId: 'lark-tool-identity',
      listenPort: 0,
      method: 'POST',
      path: '/api/sessions/session-a/lark-tool-identity',
      forwardHeaders: ['content-type', 'x-botmux-lark-session'],
      attestProcessPeer: true,
    });
    cleanups.push(() => bridge.close());

    const call = (method: string, path: string, extraHeaders: Record<string, string> = {}) => new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = httpRequest(`${bridge.origin}${path}`, {
        method,
        headers: {
          'content-type': 'application/json',
          'x-botmux-lark-session': 'session-access-key',
          ...extraHeaders,
        },
      }, response => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', chunk => { body += chunk; });
        response.once('end', () => resolve({ status: response.statusCode ?? 0, body }));
      });
      req.once('error', reject);
      req.end('{"mode":"bot"}');
    });

    await expect(call('POST', '/api/sessions/session-a/lark-tool-identity')).resolves.toEqual({
      status: 200,
      body: '{"ok":true}',
    });
    await expect(call('GET', '/api/sessions/session-a/lark-tool-identity')).resolves.toMatchObject({ status: 403 });
    await expect(call('POST', '/api/sessions/session-b/lark-tool-identity')).resolves.toMatchObject({ status: 403 });
    await expect(call('POST', '/api/sessions/session-a/lark-tool-identity', {
      'x-not-declared': 'must-reject',
    })).resolves.toMatchObject({ status: 403 });
    await expect(call('POST', '/api/sessions/session-a/lark-tool-identity', {
      'x-botmux-egress-auth': 'attacker-auth',
      'x-botmux-egress-policy': 'attacker-policy',
      'x-botmux-loopback-service': 'attacker-service',
    })).resolves.toMatchObject({ status: 403 });
    expect(observed).toEqual([{
      method: 'POST',
      path: '/api/sessions/session-a/lark-tool-identity',
      auth,
      service: 'lark-tool-identity',
      session: 'session-access-key',
      attackerPolicy: undefined,
    }]);
  });

  it('deep-copies local service bridge declarations in the immutable network launch plan', () => {
    const service = {
      socketPath: '/run/private/e.sock',
      serviceId: 'lark-tool-identity',
      listenPort: 7950,
      method: 'POST',
      path: '/api/sessions/session-a/lark-tool-identity',
      forwardHeaders: ['content-type', 'x-botmux-lark-session'],
      attestProcessPeer: true,
    };
    const plan = buildNetworkLaunchPlan({
      nft: '/usr/sbin/nft',
      ip: '/usr/sbin/ip',
      unshare: '/usr/bin/unshare',
      slirp: '/usr/bin/slirp4netns',
      nftRules: 'table inet fixture {}',
      command: '/usr/bin/bwrap',
      args: ['--', '/usr/bin/codex'],
      localServiceBridges: [service],
    } as Parameters<typeof buildNetworkLaunchPlan>[0] & { localServiceBridges: typeof service[] });

    service.forwardHeaders.push('authorization');
    expect((plan as unknown as { localServiceBridges: typeof service[] }).localServiceBridges).toEqual([{
      socketPath: '/run/private/e.sock',
      serviceId: 'lark-tool-identity',
      listenPort: 7950,
      method: 'POST',
      path: '/api/sessions/session-a/lark-tool-identity',
      forwardHeaders: ['content-type', 'x-botmux-lark-session'],
      attestProcessPeer: true,
    }]);
  });
});
