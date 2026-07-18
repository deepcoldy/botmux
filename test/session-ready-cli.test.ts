/**
 * CLI boundary regression for a SessionStart hook running inside file/read
 * isolation, where dashboard-daemons is deliberately masked. The hook must use
 * BOTMUX_DAEMON_IPC_PORT and carry the rotating relay capability.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
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
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      SESSION_DATA_DIR: dataDir,
      BOTMUX_SESSION_ID: 'sess_ready_test',
      BOTMUX_LARK_APP_ID: 'cli_ready_test',
      BOTMUX_SEND_RELAY: relayDir,
      BOTMUX_DAEMON_IPC_PORT: String(port),
    };
    delete env.BOTMUX_TURN_ID;
    delete env.BOTMUX_DISPATCH_ATTEMPT;

    const child = spawn(
      process.execPath,
      ['--import', 'tsx', CLI_PATH, 'session-ready'],
      { env, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', status => resolve({ status, stdout, stderr }));
    child.stdin.end(JSON.stringify({ source: 'startup' }));
  });
}

describe('botmux session-ready — isolated CLI fallback', () => {
  it('uses the injected daemon port when the discovery directory is absent', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-session-ready-data-'));
    const relayDir = mkdtempSync(join(tmpdir(), 'botmux-session-ready-relay-'));
    tempDirs.push(dataDir, relayDir);
    const capability = 'a'.repeat(64);
    mkdirSync(relayDir, { recursive: true });
    writeFileSync(
      join(relayDir, RELAY_ORIGIN_CAPABILITY_BASENAME),
      JSON.stringify({ token: capability }),
    );

    let receivedBody = '';
    let receivedUrl = '';
    const server = createServer((req, res) => {
      receivedUrl = req.url ?? '';
      req.setEncoding('utf8');
      req.on('data', chunk => { receivedBody += chunk; });
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));

    try {
      const port = (server.address() as AddressInfo).port;
      const result = await runSessionReady(dataDir, relayDir, port);
      expect(result).toEqual({ status: 0, stdout: '', stderr: '' });
      expect(receivedUrl).toBe('/api/session-ready');
      expect(JSON.parse(receivedBody)).toMatchObject({
        sessionId: 'sess_ready_test',
        source: 'startup',
        originCapability: capability,
      });
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close(err => err ? reject(err) : resolve());
      });
    }
  });
});
