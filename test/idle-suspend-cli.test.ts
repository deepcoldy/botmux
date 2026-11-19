import { type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { spawnTsScript } from './helpers/ts-runner.js';
import { DEFAULT_IDLE_SUSPEND_OLDER_THAN_MS } from '../src/cli/idle-suspend-command.js';

const CLI_PATH = join(__dirname, '..', 'src', 'cli.ts');
const tempDirs: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  })));
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function runCli(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawnTsScript(CLI_PATH, args, {
      cwd: join(__dirname, '..'),
      // Defaults clear inherited mode, but an explicitly passed value in `env`
      // wins (the primary-mode rejection test needs to set one).
      env: { ...process.env, BOTMUX_WORKFLOW: '', BOTMUX_COORDINATION_MODE: '', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', status => resolve({ status, stdout, stderr }));
  });
}

function setupDaemon(
  responseBody: Record<string, unknown>,
): Promise<{ env: NodeJS.ProcessEnv; captured: () => Record<string, unknown> | undefined }> {
  const root = mkdtempSync(join(tmpdir(), 'botmux-idle-suspend-cli-'));
  tempDirs.push(root);
  const home = join(root, 'home');
  const dataDir = join(root, 'data');
  const registryDir = join(dataDir, 'dashboard-daemons');
  mkdirSync(join(home, '.botmux'), { recursive: true });
  mkdirSync(registryDir, { recursive: true });
  writeFileSync(join(home, '.botmux', '.dashboard-secret'), 'idle-suspend-test-secret', { mode: 0o600 });

  let capturedBody: Record<string, unknown> | undefined;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      // Only the maintenance POST carries JSON; ignore unrelated probes (e.g.
      // host-wide localhost port scanners) so they can't raise an unhandled
      // parse error against this ephemeral test server.
      const raw = Buffer.concat(chunks).toString('utf8');
      if (req.method === 'POST' && raw.length > 0) capturedBody = JSON.parse(raw);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(responseBody));
    });
  });
  servers.push(server);
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    const port = (server.address() as AddressInfo).port;
    writeFileSync(join(registryDir, 'cli_a.json'), JSON.stringify({
      larkAppId: 'cli_a',
      botName: 'Review Target',
      ipcPort: port,
      lastHeartbeat: Date.now(),
    }));
    resolve({
      env: { HOME: home, USERPROFILE: home, SESSION_DATA_DIR: dataDir },
      captured: () => capturedBody,
    });
  }));
}

describe('maintenance suspend-idle CLI', () => {
  it('fans out a signed dry-run with the explicit seven-day default', async () => {
    const daemon = await setupDaemon({
      ok: true,
      execute: false,
      larkAppId: 'cli_a',
      olderThanMs: DEFAULT_IDLE_SUSPEND_OLDER_THAN_MS,
      candidates: [{
        sessionId: 'session-old',
        larkAppId: 'cli_a',
        title: 'old session',
        lastActivityAt: Date.UTC(2026, 9, 1),
        idleForMs: DEFAULT_IDLE_SUSPEND_OLDER_THAN_MS,
        workerPid: 4242,
        backendType: 'tmux',
        backendTarget: 'bmx-session-old',
        processTypes: ['botmux __worker', 'tmux session', 'traex'],
      }],
      suspended: [],
      failures: [],
      affected: 0,
    });

    const result = await runCli(
      ['maintenance', 'suspend-idle', '--dry-run', '--json'],
      daemon.env,
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(daemon.captured()).toEqual({
      execute: false,
      olderThanMs: DEFAULT_IDLE_SUSPEND_OLDER_THAN_MS,
    });
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      execute: false,
      candidateCount: 1,
      affected: 0,
      failureCount: 0,
      daemons: [{ larkAppId: 'cli_a', botName: 'Review Target' }],
    });
  });

  it('surfaces partial execution failure and returns non-zero', async () => {
    const failedCandidate = {
      sessionId: 'session-failed',
      larkAppId: 'cli_a',
      title: 'old session',
      lastActivityAt: Date.UTC(2026, 9, 1),
      idleForMs: DEFAULT_IDLE_SUSPEND_OLDER_THAN_MS,
      workerPid: 4242,
      backendType: 'tmux',
      backendTarget: 'bmx-session-failed',
      processTypes: ['botmux __worker', 'tmux session', 'traex'],
    };
    const daemon = await setupDaemon({
      ok: false,
      execute: true,
      larkAppId: 'cli_a',
      olderThanMs: DEFAULT_IDLE_SUSPEND_OLDER_THAN_MS,
      candidates: [failedCandidate],
      suspended: [],
      failures: [{ candidate: failedCandidate, error: 'suspend_refused' }],
      affected: 0,
    });

    const result = await runCli(
      ['maintenance', 'suspend-idle', '--yes'],
      daemon.env,
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('suspend_refused');
    expect(result.stdout).toContain('发现 1 个候选');
  });

  it('requires acknowledgement before daemon discovery', async () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-idle-suspend-noack-'));
    tempDirs.push(root);
    const result = await runCli(
      ['maintenance', 'suspend-idle', '--older-than', '12h'],
      { HOME: root, USERPROFILE: root, SESSION_DATA_DIR: join(root, 'data') },
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('必须且只能指定 --dry-run 或 --yes');
  });

  it('refuses --yes locally in durable primary mode before contacting any daemon', async () => {
    // A daemon registry that must never be consulted in primary mode.
    const daemon = await setupDaemon({
      ok: true, execute: true, candidates: [], suspended: [], failures: [], affected: 0,
    });
    const result = await runCli(
      ['maintenance', 'suspend-idle', '--yes'],
      { ...daemon.env, BOTMUX_COORDINATION_MODE: 'primary' },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('BOTMUX_COORDINATION_MODE=primary');
    expect(result.stderr).toContain('maintenance suspend-idle');
    // The rejection happens before daemon discovery: no request body captured.
    expect(daemon.captured()).toBeUndefined();
  });
});
