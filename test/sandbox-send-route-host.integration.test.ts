import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { seedPersistedSessionRows } from './helpers/session-store-disk.js';
import { spawnTsScript } from './helpers/ts-runner.js';
import {
  SANDBOX_RELAY_ROUTE_GATE_ENV,
  SANDBOX_SEND_ROUTE_AUTHORIZE_ROUTE,
} from '../src/core/sandbox-send-route.js';

// The trusted host re-exec of a sandboxed `botmux send`: real cmdSend, Lark
// HTTP mocked in-process (fixture), daemon IPC answered by a stand-in server.
// Proves the routed send asks the daemon first, and that the daemon's verdict
// — not the sandbox's flags — decides whether any provider message goes out.

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const APP = 'cli_route_probe';
const roots: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise(resolve => server.close(resolve));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function fakeDaemon(verdict: Record<string, unknown>) {
  const requests: Array<{ path: string; body: any }> = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => { raw += String(chunk); });
    req.on('end', () => {
      let body: any = {};
      try { body = JSON.parse(raw || '{}'); } catch { /* keep {} */ }
      requests.push({ path: req.url ?? '', body });
      const ok = req.url === SANDBOX_SEND_ROUTE_AUTHORIZE_ROUTE;
      res.writeHead(ok ? (verdict.ok ? 200 : 403) : 404, { 'content-type': 'application/json' });
      res.end(JSON.stringify(ok ? verdict : { ok: false, error: 'not_found' }));
    });
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { port: (server.address() as AddressInfo).port, requests };
}

function prepare(port: number) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sandbox-route-host-')));
  roots.push(root);
  const data = join(root, 'data');
  mkdirSync(data);
  const bots = join(root, 'bots.json');
  writeFileSync(bots, JSON.stringify([{ larkAppId: APP, larkAppSecret: 'secret', cliId: 'claude-code', allowedUsers: ['ou_owner'] }]), { mode: 0o600 });
  seedPersistedSessionRows(data, APP, { 'route-session': {
    sessionId: 'route-session', chatId: 'oc_self', rootMessageId: 'om_self_root',
    scope: 'chat', chatType: 'group', status: 'active', title: 'probe', ownerOpenId: 'ou_owner',
    createdAt: new Date().toISOString(), larkAppId: APP, cliId: 'claude-code', workingDir: root,
    // The host re-exec is a direct child of the session's worker; this test
    // process plays the worker.
    pid: process.pid,
  } });
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: root,
    BOTS_CONFIG: bots,
    SESSION_DATA_DIR: data,
    BOTMUX_LARK_APP_ID: APP,
    BOTMUX_SESSION_ID: 'route-session',
    BOTMUX_TURN_ID: 'turn-live',
    BOTMUX_HOST_RELAY_AUTHORIZED: '1',
    [SANDBOX_RELAY_ROUTE_GATE_ENV]: '1',
    BOTMUX_DAEMON_IPC_PORT: String(port),
    BOTMUX_NO_CLAIM: '1',
  };
  return { root, env };
}

function runSend(args: string[], env: NodeJS.ProcessEnv, cwd: string) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawnTsScript(join(repoRoot, 'test/fixtures/sandbox-route-send-capture.ts'), ['send', ...args], {
      cwd: repoRoot, env: { ...env, PWD: cwd }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout!.on('data', chunk => { stdout += String(chunk); });
    child.stderr!.on('data', chunk => { stderr += String(chunk); });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`send timed out: ${stderr}`)); }, 25_000);
    child.on('error', reject);
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

const captured = (stdout: string, prefix: string) => stdout.split('\n')
  .filter(line => line.startsWith(prefix))
  .map(line => JSON.parse(line.slice(prefix.length)));

describe('host re-exec of a sandboxed routed send', () => {
  it('refuses a forged chat id the daemon rejects, before any provider message', async () => {
    const daemon = await fakeDaemon({ ok: false, error: 'principal_not_authorized', chatId: 'oc_secret' });
    const { root, env } = prepare(daemon.port);
    const r = await runSend(['--chat-id', 'oc_secret', '--top-level', '--no-mention', 'leak'], env, root);
    expect(r.code, r.stderr).toBe(2);
    expect(r.stderr).toContain('ROUTE_NOT_AUTHORIZED');
    expect(r.stderr).toContain('principal_not_authorized');
    expect(daemon.requests).toEqual([{
      path: SANDBOX_SEND_ROUTE_AUTHORIZE_ROUTE,
      body: { sessionId: 'route-session', chatId: 'oc_secret', turnId: 'turn-live' },
    }]);
    expect(captured(r.stdout, 'CAPTURE_SEND=')).toEqual([]);
    expect(captured(r.stdout, 'CAPTURE_REPLY=')).toEqual([]);
  }, 30_000);

  it('asks the daemon about an explicit --quote, which would otherwise reply into another chat', async () => {
    const daemon = await fakeDaemon({ ok: false, error: 'quote_chat_mismatch', chatId: 'oc_victim' });
    const { root, env } = prepare(daemon.port);
    const r = await runSend(['--quote', 'om_victim', '--no-mention', 'leak'], env, root);
    expect(r.code, r.stderr).toBe(2);
    expect(r.stderr).toContain('quote_chat_mismatch');
    expect(daemon.requests.map(q => q.body)).toEqual([
      { sessionId: 'route-session', quote: 'om_victim', turnId: 'turn-live' },
    ]);
    expect(captured(r.stdout, 'CAPTURE_REPLY=')).toEqual([]);
    expect(captured(r.stdout, 'CAPTURE_SEND=')).toEqual([]);
  }, 30_000);

  it('fails closed when the daemon cannot be asked', async () => {
    const daemon = await fakeDaemon({ ok: true });
    const { root, env } = prepare(daemon.port);
    await new Promise(resolve => servers.pop()!.close(resolve));
    const r = await runSend(['--chat-id', 'oc_team', '--top-level', '--no-mention', 'x'], env, root);
    expect(r.code, r.stderr).toBe(2);
    expect(r.stderr).toContain('ROUTE_NOT_AUTHORIZED');
    expect(captured(r.stdout, 'CAPTURE_SEND=')).toEqual([]);
  }, 30_000);

  it('sends top-level to an authorized other chat once the daemon allows it', async () => {
    const daemon = await fakeDaemon({ ok: true, chatId: 'oc_team', reason: 'authorized' });
    const { root, env } = prepare(daemon.port);
    const r = await runSend(['--chat-id', 'oc_team', '--top-level', '--no-mention', 'broadcast'], env, root);
    expect(r.code, r.stderr).toBe(0);
    expect(daemon.requests.filter(q => q.path === SANDBOX_SEND_ROUTE_AUTHORIZE_ROUTE)).toHaveLength(1);
    expect(captured(r.stdout, 'CAPTURE_SEND=')).toEqual([{ receiveId: 'oc_team' }]);
  }, 30_000);

  it('sends top-level into its own chat without a daemon round-trip', async () => {
    const daemon = await fakeDaemon({ ok: false, error: 'must_not_be_called' });
    const { root, env } = prepare(daemon.port);
    const r = await runSend(['--top-level', '--no-mention', 'announcement'], env, root);
    expect(r.code, r.stderr).toBe(0);
    expect(daemon.requests.filter(q => q.path === SANDBOX_SEND_ROUTE_AUTHORIZE_ROUTE)).toEqual([]);
    expect(captured(r.stdout, 'CAPTURE_SEND=')).toEqual([{ receiveId: 'oc_self' }]);
  }, 30_000);
});
