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
  handler: (received: { url: string; body: string }) => void,
  run: (port: number, received: { url: string; body: string }) => Promise<void>,
): Promise<void> {
  const received = { url: '', body: '' };
  const server = createServer((req, res) => {
    received.url = req.url ?? '';
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
  it('posts the report with the relay capability and exits silently', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-turn-idle-data-'));
    const relayDir = mkdtempSync(join(tmpdir(), 'botmux-turn-idle-relay-'));
    tempDirs.push(dataDir, relayDir);
    const capability = 'b'.repeat(64);
    mkdirSync(relayDir, { recursive: true });
    writeFileSync(
      join(relayDir, RELAY_ORIGIN_CAPABILITY_BASENAME),
      JSON.stringify({ token: capability }),
      { mode: 0o600 },
    );

    await withServer(
      () => undefined,
      async (port, received) => {
        const result = await runTurnIdle(
          baseEnv(dataDir, relayDir, port),
          JSON.stringify({ seq: 3, pid: 4242 }),
        );
        // fail-open: the plugin's fire-and-forget exec must never produce output
        expect(result).toEqual({ status: 0, stdout: '', stderr: '' });
        expect(received.url).toBe('/api/turn-idle');
        expect(JSON.parse(received.body)).toMatchObject({
          sessionId: 'sess_turn_idle_test',
          originCapability: capability,
          seq: 3,
          pid: 4242,
        });
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
