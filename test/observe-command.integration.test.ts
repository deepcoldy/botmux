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
});
