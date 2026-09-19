import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseAuthRequestArgs } from '../src/cli/auth-request.js';
import {
  managedOriginCapabilityPath,
  RELAY_ORIGIN_CAPABILITY_BASENAME,
  replaceManagedOriginCapabilityFile,
} from '../src/core/managed-origin-capability.js';
import { seedPersistedSessionRows } from './helpers/session-store-disk.js';
import { spawnTsScript } from './helpers/ts-runner.js';

describe('auth request arguments', () => {
  it('accepts default authorization and preserves requested scope names', () => {
    expect(parseAuthRequestArgs(['request'])).toEqual({ help: false, command: 'request', scopes: [] });
    expect(parseAuthRequestArgs(['request', '--json', '--scope', 'im:chat:read, docs:document:readonly im:chat:read']))
      .toEqual({ help: false, command: 'request', scopes: ['im:chat:read', 'docs:document:readonly'] });
    expect(parseAuthRequestArgs(['wait', '--request-id', 'request-1']))
      .toEqual({ help: false, command: 'wait', requestId: 'request-1' });
  });

  it.each([
    ['login'], ['request', '--scope'], ['request', '--scope', ' , '],
    ['request', '--scope', '--json'], ['request', '--scope', ''],
    ['request', '--user', 'ou_other'], ['request', '--app', 'cli_other'],
    ['request', '--session-id', 'other'], ['request', '--unknown'],
    ['request', '--scope', 'im:chat:read', '--scope', 'im:chat'],
    ['wait'], ['wait', '--request-id', ''], ['wait', '--request-id', '--json'],
    ['wait', '--request-id', 'request-1', '--scope', 'im:chat:read'],
  ])('rejects invalid arguments %j', (...args: string[]) => {
    expect(() => parseAuthRequestArgs(args)).toThrow();
  });

  it('rejects an empty argument list', () => {
    expect(() => parseAuthRequestArgs([])).toThrow();
  });

  it('prints usage only for explicit help', () => {
    expect(parseAuthRequestArgs(['--help'])).toEqual({ help: true });
    expect(parseAuthRequestArgs(['request', '--help'])).toEqual({ help: true });
  });
});

describe('auth request CLI', () => {
  let root: string;
  let dataDir: string;
  let env: NodeJS.ProcessEnv;
  let server: Server;
  let requests: Array<{ method?: string; url?: string; headers: IncomingHttpHeaders; body: unknown }>;
  let status: number;
  let responseBody: Record<string, unknown>;
  let responseQueue: Array<Record<string, unknown>>;
  const channelId = 'ab'.repeat(32);
  const capability = 'cd'.repeat(32);

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'botmux-auth-request-'));
    dataDir = join(root, 'data');
    mkdirSync(join(root, '.botmux'), { recursive: true });
    writeFileSync(join(root, '.botmux', 'bots.json'), '[]');
    seedPersistedSessionRows(dataDir, 'cli_auth', {
      session: {
        sessionId: 'session', chatId: 'oc_chat', larkAppId: 'cli_auth',
        rootMessageId: 'om_root', status: 'active', title: 'auth',
        createdAt: new Date(0).toISOString(),
      },
    });
    requests = [];
    status = 200;
    responseBody = {
      ok: true, authUrl: 'https://example.com/authorize?state=test',
      requestId: 'request-1', scopes: ['im:chat:read'], expiresIn: 300, autoCallback: true,
    };
    responseQueue = [];
    server = createServer(async (request, response) => {
      let body = '';
      for await (const chunk of request) body += chunk;
      requests.push({ method: request.method, url: request.url, headers: request.headers, body: JSON.parse(body) });
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(responseQueue.shift() ?? responseBody));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing test server port');
    env = {
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('BOTMUX_'))),
      HOME: root, USERPROFILE: root,
      BOTS_CONFIG: join(root, '.botmux', 'bots.json'),
      SESSION_DATA_DIR: dataDir,
      BOTMUX_SESSION_ID: 'session', BOTMUX_LARK_APP_ID: 'cli_auth',
      BOTMUX_CHAT_ID: 'oc_chat', BOTMUX_ORIGIN_CHANNEL_ID: channelId,
      BOTMUX_DAEMON_IPC_PORT: String(address.port),
    };
  });

  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  });

  function run(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawnTsScript(fileURLToPath(new URL('../src/cli.ts', import.meta.url)), ['auth', ...args], {
        env, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout!.on('data', chunk => { stdout += chunk; });
      child.stderr!.on('data', chunk => { stderr += chunk; });
      child.on('error', reject);
      child.on('close', code => resolve({ code, stdout, stderr }));
    });
  }

  function writeClaim(turnId?: string): void {
    const path = env.BOTMUX_SEND_RELAY
      ? join(env.BOTMUX_SEND_RELAY, RELAY_ORIGIN_CAPABILITY_BASENAME)
      : managedOriginCapabilityPath(dataDir, 'session', channelId);
    replaceManagedOriginCapabilityFile(path, JSON.stringify({
      sessionId: 'session', channelId, capability, turnId, dispatchAttempt: 3,
    }));
  }

  it.each(['host', 'relay'])('requests authorization as the current turn over %s transport', async transport => {
    if (transport === 'host') writeFileSync(join(root, '.botmux', '.dashboard-secret'), 'test-ipc-secret', { mode: 0o600 });
    else env.BOTMUX_SEND_RELAY = join(root, 'relay');
    writeClaim('turn-current');
    const result = await run(['request', '--scope', 'im:chat:read', '--json']);
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(responseBody);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      method: 'POST', url: '/api/sessions/session/auth-request',
      body: {
        sessionId: 'session', scopes: ['im:chat:read'], originCapability: capability,
        originTurnId: 'turn-current', originDispatchAttempt: 3,
      },
    });
    expect(Boolean(requests[0].headers['x-botmux-cli-auth'])).toBe(transport === 'host');
  });

  it('requests authorization over a managed host session with no origin tuple', async () => {
    // The real host runtime injects neither the relay nor the origin channel;
    // the daemon proves the turn from the loopback peer, so the CLI sends the
    // request over the trusted-host secret with no capability tuple at all.
    writeFileSync(join(root, '.botmux', '.dashboard-secret'), 'test-ipc-secret', { mode: 0o600 });
    delete env.BOTMUX_ORIGIN_CHANNEL_ID;
    const result = await run(['request', '--scope', 'im:chat:read', '--json']);
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(responseBody);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      method: 'POST', url: '/api/sessions/session/auth-request',
      body: { sessionId: 'session', scopes: ['im:chat:read'] },
    });
    expect(requests[0].body).not.toHaveProperty('originCapability');
    expect(requests[0].body).not.toHaveProperty('originTurnId');
    expect(requests[0].body).not.toHaveProperty('originDispatchAttempt');
    expect(Boolean(requests[0].headers['x-botmux-cli-auth'])).toBe(true);
  });

  it('waits over a managed host session with no origin tuple', async () => {
    writeFileSync(join(root, '.botmux', '.dashboard-secret'), 'test-ipc-secret', { mode: 0o600 });
    delete env.BOTMUX_ORIGIN_CHANNEL_ID;
    responseQueue = [{ ok: true, status: 'pending' }, { ok: true, status: 'ready' }];
    const result = await run(['wait', '--request-id', 'request-1']);
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ ok: true, status: 'ready' });
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request).toMatchObject({
        method: 'POST', url: '/api/sessions/session/auth-status',
        body: { requestId: 'request-1' },
      });
      expect(request.body).not.toHaveProperty('originCapability');
      expect(Boolean(request.headers['x-botmux-cli-auth'])).toBe(true);
    }
  });

  it('preserves the default scope request and daemon failures in JSON', async () => {
    writeClaim('turn-current');
    status = 403;
    responseBody = { ok: false, error: 'auth_request_actor_unavailable' };
    const result = await run(['request']);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual(responseBody);
    expect(requests[0].body).toMatchObject({ scopes: [] });
  });

  it('waits through pending status with the same turn claim and returns ready', async () => {
    env.BOTMUX_SEND_RELAY = join(root, 'relay');
    writeClaim('turn-current');
    responseQueue = [{ ok: true, status: 'pending' }, { ok: true, status: 'ready' }];
    server.on('request', () => writeClaim('turn-later'));
    const result = await run(['wait', '--request-id', 'request-1']);
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ ok: true, status: 'ready' });
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request).toMatchObject({
        method: 'POST', url: '/api/sessions/session/auth-status',
        body: {
          requestId: 'request-1', originCapability: capability,
          originTurnId: 'turn-current', originDispatchAttempt: 3,
        },
      });
    }
  });

  it('requires a turn even when host IPC authentication is available', async () => {
    writeFileSync(join(root, '.botmux', '.dashboard-secret'), 'test-ipc-secret', { mode: 0o600 });
    writeClaim();
    const result = await run(['request', '--json']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('本轮身份凭据不可用');
    expect(requests).toHaveLength(0);
  });

  it('shows explicit help and rejects unknown flags before requesting authorization', async () => {
    const help = await run(['request', '--help']);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain('用法: botmux auth request');
    const invalid = await run(['request', '--user', 'ou_other']);
    expect(invalid.code).toBe(2);
    expect(invalid.stderr).toContain('未知或重复参数: --user');
    expect(invalid.stderr).not.toContain('用法:');
    expect(requests).toHaveLength(0);
  });
});
