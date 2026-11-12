import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { seedPersistedSessionRows } from './helpers/session-store-disk.js';
import { isBunRuntime, spawnTsScript } from './helpers/ts-runner.js';
import { executeRiffHostTool, RiffHostTools } from '../src/services/riff-host-tools.js';
import { callRiffHostTool } from '../src/cli/riff-host-tools.js';
import { handleSessionChatTool, SESSION_CHAT_TOOLS_ROUTE } from '../src/core/session-chat-tools.js';
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

async function fakeDaemon(verdict: Record<string, unknown>, chatTool?: (body: any) => Promise<{ status: number; body: Record<string, unknown> }>) {
  const requests: Array<{ path: string; body: any }> = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => { raw += String(chunk); });
    req.on('end', async () => {
      let body: any = {};
      try { body = JSON.parse(raw || '{}'); } catch { /* keep {} */ }
      requests.push({ path: req.url ?? '', body });
      if (req.url === SESSION_CHAT_TOOLS_ROUTE && chatTool) {
        const result = await chatTool(body);
        res.writeHead(result.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(result.body));
        return;
      }
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
  it('creates a chat once, resolves QA in the same app, then sends directly from the original Riff task', async () => {
    let creations = 0;
    const daemon = await fakeDaemon({ ok: true, chatId: 'oc_created', reason: 'authorized' }, body => handleSessionChatTool(body, {
      sessionId: 'route-session', larkAppId: APP, chatId: 'oc_self', turnId: 'turn-live',
      callerOpenId: 'ou_caller', humanCaller: true, enabled: true, isCurrent: () => true,
    }, {
      route: {
        lookupMessageChatId: async () => null, getChatInfo: async () => ({ external: false, mode: 'group' }),
        isBotInChat: async () => true, listMemberOpenIds: async () => ['ou_caller', 'ou_qa'], canTalk: () => true,
      },
      canCreateChat: () => true,
      canTalkInNewChat: () => true,
      resolveMembers: async () => new Map([['qa@example.com', 'ou_qa']]),
      listMembers: async () => [{ openId: 'ou_qa', name: 'QA' }],
      create: async input => {
        creations++;
        expect(input.userIds).toEqual(['ou_caller', 'ou_qa']);
        return { chatId: 'oc_created', invalidUserIds: [] };
      },
    }));
    const { root, env } = prepare(daemon.port);
    delete env[SANDBOX_RELAY_ROUTE_GATE_ENV];
    if (!isBunRuntime()) env.NODE_OPTIONS = `--import=${createRequire(import.meta.url).resolve('tsx')}`;
    const gateway = new RiffHostTools();
    const server = createServer((req, res) => { void gateway.handle(req, res); });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const binding = gateway.bind(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/riff-host-tools`, {
      sessionId: 'route-session', turnId: 'turn-live', dataDir: env.SESSION_DATA_DIR!, workingDir: root, env,
      cliPath: join(repoRoot, 'test/fixtures/sandbox-route-send-capture.ts'), isCurrent: () => true,
    });
    const create = { operationId: 'riff-create-0001', argv: ['chat', 'create', '--name', 'Verification', '--member', 'qa@example.com'] };
    const created = await callRiffHostTool(binding, create);
    expect(created.exitCode, created.stderr).toBe(0);
    expect(JSON.parse(created.stdout)).toMatchObject({ ok: true, larkAppId: APP, chatId: 'oc_created', complete: true });
    expect(await callRiffHostTool(binding, create)).toEqual(created);
    expect(creations).toBe(1);
    const members = await callRiffHostTool(binding, { operationId: 'riff-members-0001', argv: ['chat', 'members', '--chat-id', 'oc_created'] });
    expect(members.exitCode, members.stderr).toBe(0);
    expect(JSON.parse(members.stdout)).toMatchObject({ larkAppId: APP, members: [{ openId: 'ou_qa' }] });
    const sent = await callRiffHostTool(binding, { operationId: 'riff-notify-0001',
      argv: ['send', '--chat-id', 'oc_created', '--top-level', '--mention', 'ou_qa', 'ready for verification'] });
    expect(sent.exitCode, sent.stderr).toBe(0);
    expect(captured(sent.stdout, 'CAPTURE_SEND=')).toEqual([{ receiveId: 'oc_created' }]);
    expect(captured(sent.stdout, 'CAPTURE_CONTENT=').join()).toContain('<at id=ou_qa>');
    expect(daemon.requests.filter(q => q.path === SESSION_CHAT_TOOLS_ROUTE).map(q => q.body)).toEqual([
      { sessionId: 'route-session', action: 'create', name: 'Verification', members: ['qa@example.com'], chatMode: 'group', turnId: 'turn-live' },
      { sessionId: 'route-session', action: 'members', chatId: 'oc_created', turnId: 'turn-live' },
    ]);
  }, 30_000);

  it.each([true, false])('authorizes a Riff routed send through the real host CLI: allowed=%s', async allowed => {
    const daemon = await fakeDaemon(allowed
      ? { ok: true, chatId: 'oc_team', reason: 'authorized' }
      : { ok: false, error: 'principal_not_authorized' });
    const { root, env } = prepare(daemon.port);
    // The Riff executor must install its own route gate, rather than inherit
    // the sandbox outbox's environment. The target and mentions travel intact.
    delete env[SANDBOX_RELAY_ROUTE_GATE_ENV];
    if (!isBunRuntime()) env.NODE_OPTIONS = `--import=${createRequire(import.meta.url).resolve('tsx')}`;
    const result = await executeRiffHostTool({ operationId: 'riff-route-0001',
      argv: ['send', '--chat-id=oc_team', '--top-level', '--mention', 'ou_qa', 'ready for verification'] }, {
      sessionId: 'route-session', turnId: 'turn-live', dataDir: env.SESSION_DATA_DIR!,
      workingDir: root, env,
      cliPath: join(repoRoot, 'test/fixtures/sandbox-route-send-capture.ts'), isCurrent: () => true,
    });
    expect(daemon.requests.filter(q => q.path === SANDBOX_SEND_ROUTE_AUTHORIZE_ROUTE).map(q => q.body)).toEqual([
      { sessionId: 'route-session', chatId: 'oc_team', turnId: 'turn-live' },
    ]);
    expect(result.exitCode, result.stderr).toBe(allowed ? 0 : 2);
    expect(captured(result.stdout, 'CAPTURE_SEND=')).toEqual(allowed ? [{ receiveId: 'oc_team' }] : []);
    if (allowed) expect(captured(result.stdout, 'CAPTURE_CONTENT=').join()).toContain('<at id=ou_qa>');
    else expect(result.stderr).toContain('principal_not_authorized');
  }, 30_000);

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
