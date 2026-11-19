/**
 * CLI boundary for Claude's StopFailure hook client (`botmux __claude-stop-failure-v1`).
 *
 * Claude runs it inside the CLI process when a turn ends on an API error, so,
 * like the SessionStart client, it must reach the daemon through the injected
 * port with this session's rotating capability, and stay silent and exit 0
 * whatever happens (Claude ignores StopFailure output, but a hanging or noisy
 * hook would still delay the turn's close).
 */
import { type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { spawnTsScript } from './helpers/ts-runner.js';
import { RELAY_ORIGIN_CAPABILITY_BASENAME } from '../src/core/managed-origin-capability.js';
import {
  CLAUDE_STOP_FAILURE_OUTBOX_SUFFIX,
  drainClaudeStopFailureOutbox,
} from '../src/services/claude-stop-failure.js';

const CLI_PATH = join(__dirname, '..', 'src', 'cli.ts');
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const SESSION_ID = '7bb7a763-27bb-449b-9b1f-72159ee31588';
const payload = {
  session_id: SESSION_ID,
  transcript_path: `/home/u/.claude/projects/-work/${SESSION_ID}.jsonl`,
  cwd: '/home/u/work',
  hook_event_name: 'StopFailure',
  error: 'server_error',
  last_assistant_message: 'API Error: Connection lost mid-response. The response above may be incomplete.',
};

function runHook(
  env: NodeJS.ProcessEnv,
  stdinPayload: string,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawnTsScript(
      CLI_PATH,
      ['__claude-stop-failure-v1'],
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
  run: (port: number, received: { url: string; body: string }) => Promise<void>,
  status = 200,
): Promise<void> {
  const received = { url: '', body: '' };
  const server = createServer((req, res) => {
    received.url = req.url ?? '';
    req.setEncoding('utf8');
    req.on('data', chunk => { received.body += chunk; });
    req.on('end', () => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(status === 200 ? '{"ok":true}' : '{"ok":false,"error":"origin_unproven"}');
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

function relayOf(env: NodeJS.ProcessEnv): string[] {
  return readdirSync(env.BOTMUX_SEND_RELAY!).filter(name => name.endsWith(CLAUDE_STOP_FAILURE_OUTBOX_SUFFIX));
}

function sessionEnv(port: number): NodeJS.ProcessEnv {
  const dataDir = mkdtempSync(join(tmpdir(), 'botmux-stop-failure-data-'));
  const relayDir = mkdtempSync(join(tmpdir(), 'botmux-stop-failure-relay-'));
  tempDirs.push(dataDir, relayDir);
  writeFileSync(
    join(relayDir, RELAY_ORIGIN_CAPABILITY_BASENAME),
    JSON.stringify({ sessionId: 'sess_stop_failure_test', token: 'a'.repeat(64), turnId: 'om_failed_turn' }),
    { mode: 0o600 },
  );
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    SESSION_DATA_DIR: dataDir,
    BOTMUX_SESSION_ID: 'sess_stop_failure_test',
    BOTMUX_LARK_APP_ID: 'cli_stop_failure_test',
    BOTMUX_SEND_RELAY: relayDir,
    BOTMUX_DAEMON_IPC_PORT: String(port),
    BOTMUX_TURN_ID: 'om_failed_turn',
    CLAUDE_PID: '4242',
  };
  delete env.BOTMUX_DISPATCH_ATTEMPT;
  return env;
}

describe('botmux __claude-stop-failure-v1', () => {
  it('forwards the error type and the firing CLI identity with the session capability', async () => {
    await withServer(async (port, received) => {
      const env = sessionEnv(port);
      const result = await runHook(env, JSON.stringify(payload));
      expect(result).toEqual({ status: 0, stdout: '', stderr: '' });
      expect(received.url).toBe('/api/claude-stop-failure');
      // Delivered: nothing goes to the relay outbox.
      expect(relayOf(env)).toEqual([]);
      expect(JSON.parse(received.body)).toMatchObject({
        sessionId: 'sess_stop_failure_test',
        originCapability: 'a'.repeat(64),
        originTurnId: 'om_failed_turn',
        error: 'server_error',
        lastAssistantMessage: payload.last_assistant_message,
        cliSessionId: SESSION_ID,
        transcriptPath: payload.transcript_path,
        claudePid: 4242,
      });
    });
  });

  it('falls back to the relay outbox when the daemon refuses the (revoked) turn capability', async () => {
    await withServer(async (port, received) => {
      const env = sessionEnv(port);
      const result = await runHook(env, JSON.stringify(payload));
      expect(result).toEqual({ status: 0, stdout: '', stderr: '' });
      expect(received.url).toBe('/api/claude-stop-failure');
      expect(drainClaudeStopFailureOutbox(env.BOTMUX_SEND_RELAY!)).toEqual([{
        report: {
          error: 'server_error',
          lastAssistantMessage: payload.last_assistant_message,
          cliSessionId: SESSION_ID,
          transcriptPath: payload.transcript_path,
          claudePid: 4242,
        },
        turnId: 'om_failed_turn',
        atMs: expect.any(Number),
      }]);
    }, 403);
  });

  it('has no outbox to fall back to outside a sandbox', async () => {
    await withServer(async port => {
      const env = sessionEnv(port);
      const relay = env.BOTMUX_SEND_RELAY!;
      delete env.BOTMUX_SEND_RELAY;
      // Keep the client off this host's real daemon secret.
      env.HOME = env.USERPROFILE = mkdtempSync(join(tmpdir(), 'botmux-stop-failure-home-'));
      tempDirs.push(env.HOME);
      expect(await runHook(env, JSON.stringify(payload))).toEqual({ status: 0, stdout: '', stderr: '' });
      expect(readdirSync(relay).filter(name => name.endsWith(CLAUDE_STOP_FAILURE_OUTBOX_SUFFIX))).toEqual([]);
    }, 403);
  });

  it('sends nothing for a payload that is not a StopFailure with an error type', async () => {
    await withServer(async (port, received) => {
      for (const body of ['not json', JSON.stringify({ ...payload, hook_event_name: 'Stop' }), JSON.stringify({ ...payload, error: '' })]) {
        expect(await runHook(sessionEnv(port), body)).toEqual({ status: 0, stdout: '', stderr: '' });
      }
      expect(received.url).toBe('');
    });
  });

  it('exits 0 silently outside a botmux session (standalone or adopted Claude)', async () => {
    await withServer(async (port, received) => {
      const env = sessionEnv(port);
      delete env.BOTMUX_SESSION_ID;
      expect(await runHook(env, JSON.stringify(payload))).toEqual({ status: 0, stdout: '', stderr: '' });
      expect(received.url).toBe('');
    });
  });

  it('exits 0 silently when the daemon is unreachable', async () => {
    const env = sessionEnv(1);
    expect(await runHook(env, JSON.stringify(payload))).toEqual({ status: 0, stdout: '', stderr: '' });
  });
});
