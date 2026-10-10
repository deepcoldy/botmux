/**
 * CLI boundary for the structured turn-idle report (`botmux turn-idle`).
 *
 * The dsh-tui wrapper plugin execs BOTMUX_TURN_IDLE_COMMAND on every
 * `agent/status === 'idle'`. Like the SessionStart hook client it runs inside a
 * possibly read-isolated CLI, so it must use the worker-injected daemon port and
 * carry this session's rotating per-turn capability.
 */
import { type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { spawnTsScript } from './helpers/ts-runner.js';
import { RELAY_ORIGIN_CAPABILITY_BASENAME } from '../src/core/managed-origin-capability.js';

const CLI_PATH = join(__dirname, '..', 'src', 'cli.ts');
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function runTurnIdle(
  env: NodeJS.ProcessEnv,
  stdinPayload: string,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawnTsScript(
      CLI_PATH,
      ['turn-idle'],
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
    child.stdin.end(stdinPayload);
  });
}

async function withServer(
  handler: (received: { url: string; body: string; headers: Record<string, unknown> }) => void,
  run: (
    port: number,
    received: { url: string; body: string; headers: Record<string, unknown> },
  ) => Promise<void>,
): Promise<void> {
  const received = { url: '', body: '', headers: {} as Record<string, unknown> };
  const server = createServer((req, res) => {
    received.url = req.url ?? '';
    received.headers = req.headers;
    req.setEncoding('utf8');
    req.on('data', chunk => { received.body += chunk; });
    req.on('end', () => {
      handler(received);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await run((server.address() as AddressInfo).port, received);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close(err => err ? reject(err) : resolve());
    });
  }
}

function baseEnv(dataDir: string, relayDir: string, port: number): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    SESSION_DATA_DIR: dataDir,
    BOTMUX_SESSION_ID: 'sess_turn_idle_test',
    BOTMUX_LARK_APP_ID: 'cli_turn_idle_test',
    BOTMUX_SEND_RELAY: relayDir,
    BOTMUX_DAEMON_IPC_PORT: String(port),
  };
  delete env.BOTMUX_TURN_ID;
  delete env.BOTMUX_DISPATCH_ATTEMPT;
  return env;
}

describe('botmux turn-idle — isolated CLI report', () => {
  it('posts the FROZEN (event-time) identity and token, never the live marker', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-turn-idle-data-'));
    const relayDir = mkdtempSync(join(tmpdir(), 'botmux-turn-idle-relay-'));
    tempDirs.push(dataDir, relayDir);
    const liveCapability = 'a'.repeat(64);
    const frozenCapability = 'c'.repeat(64);
    mkdirSync(relayDir, { recursive: true });
    // The relay token has already rotated to the NEXT dispatch by the time this
    // child runs — reading it here instead of transporting the frozen one would
    // be the very substitution this protocol forbids.
    writeFileSync(
      join(relayDir, RELAY_ORIGIN_CAPABILITY_BASENAME),
      JSON.stringify({ sessionId: 'sess_turn_idle_test', token: liveCapability, turnId: 'live-marker-turn' }),
      { mode: 0o600 },
    );

    await withServer(
      () => undefined,
      async (port, received) => {
        const env = baseEnv(dataDir, relayDir, port);
        env.BOTMUX_TURN_ID = 'live-marker-turn';
        env.BOTMUX_DISPATCH_ATTEMPT = '9';
        const result = await runTurnIdle(env, JSON.stringify({
          v: 2,
          seq: 3,
          pid: 4242,
          turnId: 'frozen-turn-a',
          dispatchAttempt: 3,
          capability: frozenCapability,
        }));
        // fail-open: the plugin's fire-and-forget exec must never produce output
        expect(result).toEqual({ status: 0, stdout: '', stderr: '' });
        expect(received.url).toBe('/api/turn-idle');
        expect(JSON.parse(received.body)).toEqual({
          sessionId: 'sess_turn_idle_test',
          originCapability: frozenCapability,
          originTurnId: 'frozen-turn-a',
          originDispatchAttempt: 3,
          seq: 3,
          pid: 4242,
        });
      },
    );
  });

  it('drops a legacy v1 payload (seq/pid only) instead of claiming a live turn', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-turn-idle-data-'));
    const relayDir = mkdtempSync(join(tmpdir(), 'botmux-turn-idle-relay-'));
    tempDirs.push(dataDir, relayDir);
    writeFileSync(
      join(relayDir, RELAY_ORIGIN_CAPABILITY_BASENAME),
      JSON.stringify({ sessionId: 'sess_turn_idle_test', token: 'a'.repeat(64), turnId: 'live-marker-turn' }),
      { mode: 0o600 },
    );

    await withServer(
      () => undefined,
      async (port, received) => {
        const env = baseEnv(dataDir, relayDir, port);
        env.BOTMUX_TURN_ID = 'live-marker-turn';
        const result = await runTurnIdle(env, JSON.stringify({ seq: 3, pid: 4242 }));
        expect(result).toEqual({ status: 0, stdout: '', stderr: '' });
        // No request at all: the report carried no event-time identity, and the
        // exec-time marker must not be substituted for it.
        expect(received.url).toBe('');
      },
    );
  });

  it('drops a v2 payload without a turn identity', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-turn-idle-data-'));
    tempDirs.push(dataDir);

    await withServer(
      () => undefined,
      async (port, received) => {
        const result = await runTurnIdle(baseEnv(dataDir, '', port), JSON.stringify({ v: 2, seq: 1, pid: 1 }));
        expect(result).toEqual({ status: 0, stdout: '', stderr: '' });
        expect(received.url).toBe('');
      },
    );
  });

  it('carries the frozen identity on the trusted-host (HMAC) auth path too', async () => {
    const home = mkdtempSync(join(tmpdir(), 'botmux-turn-idle-home-'));
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-turn-idle-data-'));
    tempDirs.push(home, dataDir);
    mkdirSync(join(home, '.botmux'), { recursive: true, mode: 0o700 });
    writeFileSync(join(home, '.botmux', '.dashboard-secret'), 'host-secret-value\n', { mode: 0o600 });

    await withServer(
      () => undefined,
      async (port, received) => {
        const env = baseEnv(dataDir, '', port);
        env.HOME = home;
        env.USERPROFILE = home;
        delete env.BOTMUX_SEND_RELAY;
        delete env.BOTMUX_TURN_ID;
        const result = await runTurnIdle(env, JSON.stringify({
          v: 2,
          seq: 5,
          pid: 77,
          turnId: 'frozen-turn-hmac',
          dispatchAttempt: 2,
        }));
        expect(result).toEqual({ status: 0, stdout: '', stderr: '' });
        expect(received.url).toBe('/api/turn-idle');
        expect(JSON.parse(received.body)).toMatchObject({
          sessionId: 'sess_turn_idle_test',
          originTurnId: 'frozen-turn-hmac',
          originDispatchAttempt: 2,
          seq: 5,
        });
        // HMAC path: no capability (the host secret is the credential).
        expect((JSON.parse(received.body) as { originCapability?: string }).originCapability).toBeUndefined();
        expect(received.headers['x-botmux-cli-auth']).toEqual(expect.any(String));
      },
    );
  });

  it('exit 0 with no request when the session env is absent (adopt / non-botmux)', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-turn-idle-data-'));
    tempDirs.push(dataDir);
    const env = baseEnv(dataDir, '', 1);
    delete env.BOTMUX_SESSION_ID;
    delete env.BOTMUX_SEND_RELAY;
    env.BOTMUX_DAEMON_IPC_PORT = '1'; // nothing listens here; must not matter

    const result = await runTurnIdle(env, 'not json');
    expect(result).toEqual({ status: 0, stdout: '', stderr: '' });
  });
});
