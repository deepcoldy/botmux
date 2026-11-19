import { createServer, type Server } from 'node:http';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cliAuthBind, verifyHmac } from '../src/dashboard/auth.js';
import { spawnTsEvalWithRepoImports } from './helpers/ts-runner.js';

const SECRET = 'observe-integration-secret';

let server: Server | undefined;
let root: string | undefined;
afterEach(async () => {
  if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
  server = undefined;
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

describe('botmux observe real daemon IPC', () => {
  it('discovers a daemon, authenticates the loopback request, and prints canonical JSON', async () => {
    root = mkdtempSync(join(tmpdir(), 'botmux-observe-e2e-'));
    const home = join(root, 'home');
    const dataDir = join(root, 'data');
    const configDir = join(home, '.botmux');
    const registryDir = join(dataDir, 'dashboard-daemons');
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
    mkdirSync(registryDir, { recursive: true });
    const secretPath = join(configDir, '.dashboard-secret');
    writeFileSync(secretPath, SECRET, { mode: 0o600 });
    chmodSync(secretPath, 0o600);

    let authenticated = false;
    server = createServer((req, res) => {
      const port = (server!.address() as { port: number }).port;
      const pathname = new URL(req.url ?? '/', `http://127.0.0.1:${port}`).pathname;
      const attempt = {
        ts: String(req.headers['x-botmux-cli-ts'] ?? ''),
        nonce: String(req.headers['x-botmux-cli-nonce'] ?? ''),
        sig: String(req.headers['x-botmux-cli-auth'] ?? ''),
      };
      authenticated = verifyHmac(
        SECRET,
        attempt,
        req.socket.remoteAddress ?? '',
        cliAuthBind(req.method ?? 'GET', pathname, port),
      ).ok;
      if (!authenticated) {
        res.writeHead(401).end('unauthorized');
        return;
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ sessions: [{
        sessionId: 'session-live-1',
        larkAppId: 'cli_observe_e2e',
        chatId: 'oc_observe',
        rootMessageId: 'om_observe',
        scope: 'thread',
        botName: 'observe-e2e',
        cliId: 'codex',
        runtimeId: 'codex',
        runtimeDisplayName: 'Codex',
        backendType: 'pty',
        workerPid: 4242,
        adopt: false,
        status: 'working',
        queued: false,
        workingDir: '/workspace/demo',
      }] }));
    });
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject);
      server!.listen(0, '127.0.0.1', resolve);
    });
    const port = (server.address() as { port: number }).port;
    writeFileSync(join(registryDir, 'cli_observe_e2e.json'), JSON.stringify({
      larkAppId: 'cli_observe_e2e',
      ipcPort: port,
      pid: process.pid,
      lastHeartbeat: Date.now(),
    }));

    const child = spawnTsEvalWithRepoImports(
      `import { runObserveCommand } from './src/cli/observe-command.js';
       process.exitCode = await runObserveCommand(['--lark-app', 'cli_observe_e2e']);`,
      {
        cwd: process.cwd(),
        env: { ...process.env, HOME: home, SESSION_DATA_DIR: dataDir },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout!.setEncoding('utf8');
    child.stderr!.setEncoding('utf8');
    child.stdout!.on('data', chunk => { stdout += chunk; });
    child.stderr!.on('data', chunk => { stderr += chunk; });
    const status = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });

    expect(status, stderr).toBe(0);
    const snapshot = JSON.parse(stdout);
    expect(authenticated).toBe(true);
    expect(snapshot.daemons).toHaveLength(1);
    expect(snapshot.daemons[0].probe).toEqual({
      status: 'ok',
      source: 'daemon-ipc',
      larkAppId: 'cli_observe_e2e',
    });
    expect(snapshot.daemons[0].sessions[0]).toEqual(expect.objectContaining({
      schemaVersion: 1,
      identity: expect.objectContaining({ sessionId: 'session-live-1' }),
      cli: expect.objectContaining({ id: 'codex' }),
      backend: expect.objectContaining({ type: 'pty', workerPid: 4242 }),
      liveness: 'alive',
      turn: 'working',
      phase: 'unknown',
      queued: false,
    }));

    process.stdout.write(`OBSERVE_CLI_TRANSCRIPT ${JSON.stringify(snapshot)}\n`);
  });
  it('prints the daemon-computed context block for a single-session probe, and none for a listing', async () => {
    root = mkdtempSync(join(tmpdir(), 'botmux-observe-ctx-'));
    const home = join(root, 'home');
    const dataDir = join(root, 'data');
    const configDir = join(home, '.botmux');
    const registryDir = join(dataDir, 'dashboard-daemons');
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
    mkdirSync(registryDir, { recursive: true });
    const secretPath = join(configDir, '.dashboard-secret');
    writeFileSync(secretPath, SECRET, { mode: 0o600 });
    chmodSync(secretPath, 0o600);

    const measured = {
      usedTokens: 161_240, windowTokens: 1_000_000, compactions: 2,
      measuredAt: 1_790_000_000_000, source: 'claude-transcript',
    };
    const baseRow = {
      sessionId: 'session-ctx-1', larkAppId: 'cli_observe_ctx', chatId: 'oc_observe', rootMessageId: 'om_observe',
      scope: 'thread', botName: 'observe-ctx', cliId: 'claude-code', backendType: 'pty', adopt: false,
      status: 'idle', queued: false, workingDir: '/workspace/demo',
    };
    // Mirrors the daemon: the bulk listing skips transcript scans, the
    // single-session route computes the block.
    server = createServer((req, res) => {
      const port = (server!.address() as { port: number }).port;
      const pathname = new URL(req.url ?? '/', `http://127.0.0.1:${port}`).pathname;
      const ok = verifyHmac(
        SECRET,
        {
          ts: String(req.headers['x-botmux-cli-ts'] ?? ''),
          nonce: String(req.headers['x-botmux-cli-nonce'] ?? ''),
          sig: String(req.headers['x-botmux-cli-auth'] ?? ''),
        },
        req.socket.remoteAddress ?? '',
        cliAuthBind(req.method ?? 'GET', pathname, port),
      ).ok;
      if (!ok) { res.writeHead(401).end('unauthorized'); return; }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(pathname === '/api/sessions'
        ? { sessions: [baseRow] }
        : { session: { ...baseRow, contextUsage: measured } }));
    });
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject);
      server!.listen(0, '127.0.0.1', resolve);
    });
    const port = (server.address() as { port: number }).port;
    writeFileSync(join(registryDir, 'cli_observe_ctx.json'), JSON.stringify({
      larkAppId: 'cli_observe_ctx', ipcPort: port, pid: process.pid, lastHeartbeat: Date.now(),
    }));

    const run = async (args: string[]) => {
      const child = spawnTsEvalWithRepoImports(
        `import { runObserveCommand } from './src/cli/observe-command.js';
         process.exitCode = await runObserveCommand(${JSON.stringify(args)});`,
        { cwd: process.cwd(), env: { ...process.env, HOME: home, SESSION_DATA_DIR: dataDir }, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let stdout = '';
      let stderr = '';
      child.stdout!.setEncoding('utf8');
      child.stderr!.setEncoding('utf8');
      child.stdout!.on('data', chunk => { stdout += chunk; });
      child.stderr!.on('data', chunk => { stderr += chunk; });
      const status = await new Promise<number | null>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', resolve);
      });
      expect(status, stderr).toBe(0);
      return JSON.parse(stdout);
    };

    const single = await run(['--session', 'session-ctx-1', '--lark-app', 'cli_observe_ctx']);
    expect(single.context).toEqual(measured);

    const listing = await run(['--lark-app', 'cli_observe_ctx']);
    expect(listing.daemons[0].sessions[0]).not.toHaveProperty('context');
  });
});

describe('botmux observe task block and active filter over real daemon IPC', () => {
  it('leaves the default listing unchanged and adds task + filtering only on request', async () => {
    root = mkdtempSync(join(tmpdir(), 'botmux-observe-task-'));
    const home = join(root, 'home');
    const dataDir = join(root, 'data');
    const configDir = join(home, '.botmux');
    const registryDir = join(dataDir, 'dashboard-daemons');
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
    mkdirSync(registryDir, { recursive: true });
    const secretPath = join(configDir, '.dashboard-secret');
    writeFileSync(secretPath, SECRET, { mode: 0o600 });
    chmodSync(secretPath, 0o600);

    const now = Date.now();
    const HOUR = 60 * 60_000;
    const base = {
      larkAppId: 'cli_observe_task', chatId: 'oc_observe', rootMessageId: 'om_observe', scope: 'thread',
      botName: 'observe-task', cliId: 'claude-code', backendType: 'pty', adopt: false, queued: false,
    };
    const rows = [
      { ...base, sessionId: 'running', status: 'working', workerPid: 11, busySinceAt: now - 5 * 60_000, lastMessageAt: now - 5 * 60_000 },
      { ...base, sessionId: 'delivered', status: 'dormant', lastMessageAt: now - 3 * HOUR,
        lastTurn: { turnId: 't1', outcome: 'delivered', at: now - 2 * HOUR, summary: '已合入 master' } },
      { ...base, sessionId: 'stale', status: 'dormant', lastMessageAt: now - 72 * HOUR },
      { ...base, sessionId: 'closed', status: 'closed', closedAt: now - 60_000, lastMessageAt: now - 60_000 },
    ];
    server = createServer((req, res) => {
      const port = (server!.address() as { port: number }).port;
      const pathname = new URL(req.url ?? '/', `http://127.0.0.1:${port}`).pathname;
      const ok = verifyHmac(
        SECRET,
        {
          ts: String(req.headers['x-botmux-cli-ts'] ?? ''),
          nonce: String(req.headers['x-botmux-cli-nonce'] ?? ''),
          sig: String(req.headers['x-botmux-cli-auth'] ?? ''),
        },
        req.socket.remoteAddress ?? '',
        cliAuthBind(req.method ?? 'GET', pathname, port),
      ).ok;
      if (!ok) { res.writeHead(401).end('unauthorized'); return; }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ sessions: rows }));
    });
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject);
      server!.listen(0, '127.0.0.1', resolve);
    });
    const port = (server.address() as { port: number }).port;
    writeFileSync(join(registryDir, 'cli_observe_task.json'), JSON.stringify({
      larkAppId: 'cli_observe_task', ipcPort: port, pid: process.pid, lastHeartbeat: Date.now(),
    }));

    const run = async (args: string[]) => {
      const child = spawnTsEvalWithRepoImports(
        `import { runObserveCommand } from './src/cli/observe-command.js';
         process.exitCode = await runObserveCommand(${JSON.stringify(args)});`,
        { cwd: process.cwd(), env: { ...process.env, HOME: home, SESSION_DATA_DIR: dataDir }, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let stdout = '';
      let stderr = '';
      child.stdout!.setEncoding('utf8');
      child.stderr!.setEncoding('utf8');
      child.stdout!.on('data', chunk => { stdout += chunk; });
      child.stderr!.on('data', chunk => { stderr += chunk; });
      const status = await new Promise<number | null>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', resolve);
      });
      expect(status, stderr).toBe(0);
      return JSON.parse(stdout).daemons[0].sessions as Array<Record<string, any>>;
    };

    const plain = await run(['--lark-app', 'cli_observe_task']);
    expect(plain.map(s => s.identity.sessionId)).toEqual(['running', 'delivered', 'stale', 'closed']);
    for (const s of plain) expect(s).not.toHaveProperty('task');

    const active = await run(['--lark-app', 'cli_observe_task', '--active', '--include-task']);
    expect(active.map(s => [s.identity.sessionId, s.task])).toEqual([
      ['running', { kind: 'working', busySinceAt: now - 5 * 60_000 }],
      ['delivered', { kind: 'delivered', at: now - 2 * HOUR, summary: '已合入 master' }],
    ]);

    const narrow = await run(['--lark-app', 'cli_observe_task', '--since', '1h']);
    expect(narrow.map(s => s.identity.sessionId)).toEqual(['running']);
  });
});
