/**
 * CLI boundary regression for a SessionStart hook running inside file/read
 * isolation, where dashboard-daemons is deliberately masked. The hook must use
 * BOTMUX_DAEMON_IPC_PORT and carry the rotating relay capability.
 */
import { type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { spawnTsScript } from './helpers/ts-runner.js';
import { RELAY_ORIGIN_CAPABILITY_BASENAME } from '../src/core/managed-origin-capability.js';

const CLI_PATH = join(__dirname, '..', 'src', 'cli.ts');
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function runSessionReady(
  dataDir: string,
  relayDir: string,
  port: number,
  command = 'session-ready',
  envOverrides: Record<string, string | undefined> = {},
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      SESSION_DATA_DIR: dataDir,
      BOTMUX_SESSION_ID: 'sess_ready_test',
      BOTMUX_LARK_APP_ID: 'cli_ready_test',
      BOTMUX_SEND_RELAY: relayDir,
      BOTMUX_DAEMON_IPC_PORT: String(port),
    };
    delete env.BOTMUX_TURN_ID;
    delete env.BOTMUX_DISPATCH_ATTEMPT;
    delete env.BOTMUX_WORKFLOW;
    for (const [key, value] of Object.entries(envOverrides)) {
      if (value === undefined) delete env[key];
      else env[key] = value;
    }

    const child = spawnTsScript(
      CLI_PATH,
      [command],
      { env, stdio: ['pipe', 'pipe', 'pipe'] },
    ) as ChildProcessWithoutNullStreams;
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', status => resolve({ status, stdout, stderr }));
    child.stdin.end(JSON.stringify(command === 'session-ready' ? { source: 'startup' } : { hook_event_name: 'PreCompact', trigger: 'auto' }));
  });
}

async function startCapturingDaemon(): Promise<{
  port: number;
  received: { url: string; body: string };
  close: () => Promise<void>;
}> {
  const received = { url: '', body: '' };
  const server = createServer((req, res) => {
    received.url = req.url ?? '';
    req.setEncoding('utf8');
    req.on('data', chunk => { received.body += chunk; });
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as AddressInfo).port,
    received,
    close: () => new Promise<void>((resolve, reject) => {
      server.close(err => err ? reject(err) : resolve());
    }),
  };
}

describe('botmux session-ready — isolated CLI fallback', () => {
  it.each(['session-ready', '__claude-compaction-v1'])('uses authenticated isolated IPC for %s without the discovery directory', async (command) => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-session-ready-data-'));
    const relayDir = mkdtempSync(join(tmpdir(), 'botmux-session-ready-relay-'));
    tempDirs.push(dataDir, relayDir);
    const capability = 'a'.repeat(64);
    mkdirSync(relayDir, { recursive: true });
    writeFileSync(
      join(relayDir, RELAY_ORIGIN_CAPABILITY_BASENAME),
      JSON.stringify({ token: capability }),
      { mode: 0o600 },
    );

    const daemon = await startCapturingDaemon();
    try {
      const result = await runSessionReady(dataDir, relayDir, daemon.port, command);
      expect(result).toEqual({ status: 0, stdout: '', stderr: '' });
      expect(daemon.received.url).toBe(command === 'session-ready' ? '/api/session-ready' : '/api/claude-compaction-start-v1');
      expect(JSON.parse(daemon.received.body)).toMatchObject({
        sessionId: 'sess_ready_test',
        originCapability: capability,
      });
      if (command === 'session-ready') expect(JSON.parse(daemon.received.body).source).toBe('startup');
      else {
        expect(JSON.parse(daemon.received.body).startedAtMs).toEqual(expect.any(Number));
        expect(JSON.parse(daemon.received.body).startedAtMs).toBeLessThanOrEqual(Date.now());
      }
    } finally {
      await daemon.close();
    }
  });
});

// Claude treats a PreCompact hook's exit-0 stdout as custom compaction
// instructions and its exit 2 as "block compaction".
describe('botmux __claude-compaction-v1 — never steers or blocks compaction', () => {
  it('still reaches the daemon from a workflow subagent, with exit 0 and no output', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-compaction-data-'));
    const relayDir = mkdtempSync(join(tmpdir(), 'botmux-compaction-relay-'));
    tempDirs.push(dataDir, relayDir);
    const daemon = await startCapturingDaemon();
    try {
      const result = await runSessionReady(dataDir, relayDir, daemon.port, '__claude-compaction-v1', { BOTMUX_WORKFLOW: '1' });
      expect(result).toEqual({ status: 0, stdout: '', stderr: '' });
      expect(daemon.received.url).toBe('/api/claude-compaction-start-v1');
    } finally {
      await daemon.close();
    }
  });

  it('outside a botmux session exits 0 without output or IPC', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-compaction-data-'));
    const relayDir = mkdtempSync(join(tmpdir(), 'botmux-compaction-relay-'));
    tempDirs.push(dataDir, relayDir);
    const daemon = await startCapturingDaemon();
    try {
      const result = await runSessionReady(dataDir, relayDir, daemon.port, '__claude-compaction-v1', {
        BOTMUX_SESSION_ID: undefined,
        BOTMUX_LARK_APP_ID: undefined,
      });
      expect(result).toEqual({ status: 0, stdout: '', stderr: '' });
      expect(daemon.received.url).toBe('');
    } finally {
      await daemon.close();
    }
  });
});
