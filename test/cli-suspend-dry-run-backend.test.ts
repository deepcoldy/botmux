/**
 * `botmux suspend --dry-run` predicts the daemon suspend route from the rows
 * of a live daemon. The backend gate must agree with the route: a persistent
 * backend (hc included) is predicted suspendable, a pty session is refused.
 */
import { type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { spawnTsScript } from './helpers/ts-runner.js';
import { seedPersistedSessionRows } from './helpers/session-store-disk.js';

const CLI_PATH = join(__dirname, '..', 'src', 'cli.ts');
const APP_ID = 'cli_suspend_dry_run';
const tempDirs: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise(resolve => server.close(resolve));
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const SESSIONS = [
  { sessionId: 'hc000001-1111-4111-8111-111111111111', backendType: 'hc' },
  { sessionId: 'zmx00001-1111-4111-8111-111111111111', backendType: 'zmx' },
  { sessionId: 'pty00001-1111-4111-8111-111111111111', backendType: 'pty' },
];

async function startFakeDaemon(): Promise<number> {
  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/api/sessions') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ sessions: SESSIONS.map(s => ({ ...s, status: 'idle' })) }));
      return;
    }
    res.writeHead(500);
    res.end('dry-run must not mutate');
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

function runCli(home: string, dataDir: string, args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, SESSION_DATA_DIR: dataDir };
    for (const key of ['BOTMUX_SESSION_ID', 'BOTMUX_LARK_APP_ID', 'BOTMUX_SEND_RELAY', 'BOTMUX_DAEMON_IPC_PORT', 'BOTMUX_COORDINATION_MODE']) {
      delete env[key];
    }
    const child = spawnTsScript(CLI_PATH, args, { env, stdio: ['ignore', 'pipe', 'pipe'] }) as ChildProcessWithoutNullStreams;
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', status => resolve({ status, stdout, stderr }));
  });
}

describe('botmux suspend --dry-run backend gate', () => {
  it('predicts hc and zmx sessions as suspendable and refuses pty', async () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-suspend-dry-run-'));
    tempDirs.push(root);
    const home = join(root, 'home');
    const dataDir = join(root, 'data');
    mkdirSync(join(home, '.botmux'), { recursive: true });
    writeFileSync(join(home, '.botmux', '.dashboard-secret'), 'suspend-dry-run-secret', { mode: 0o600 });
    seedPersistedSessionRows(dataDir, APP_ID, Object.fromEntries(SESSIONS.map(s => [s.sessionId, {
      sessionId: s.sessionId,
      chatId: 'oc_dry_run',
      rootMessageId: `om_${s.backendType}`,
      title: `${s.backendType}-row`,
      status: 'active',
      createdAt: '2026-07-30T00:00:00.000Z',
      larkAppId: APP_ID,
      backendType: s.backendType,
    }])));
    const port = await startFakeDaemon();
    mkdirSync(join(dataDir, 'dashboard-daemons'), { recursive: true });
    writeFileSync(join(dataDir, 'dashboard-daemons', `${APP_ID}.json`), JSON.stringify({
      larkAppId: APP_ID,
      ipcPort: port,
      lastHeartbeat: Date.now(),
    }));

    const result = await runCli(home, dataDir, ['suspend', 'all', '--dry-run']);

    expect(result.status, result.stderr).toBe(0);
    const lineFor = (backend: string) => result.stdout.split('\n').find(line => line.includes(`${backend}-row`)) ?? '';
    expect(lineFor('hc')).toMatch(/^· 将挂起: /);
    expect(lineFor('zmx')).toMatch(/^· 将挂起: /);
    expect(lineFor('pty')).toMatch(/^· 将拒绝/);
  });
});
