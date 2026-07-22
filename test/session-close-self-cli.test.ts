import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RELAY_ORIGIN_CAPABILITY_BASENAME } from '../src/core/managed-origin-capability.js';
import { deriveSessionSelfCloseCapability } from '../src/core/session-self-close.js';

const CLI_PATH = join(__dirname, '..', 'src', 'cli.ts');
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function runCloseSelf(
  dataDir: string,
  relayDir: string,
  port: number,
  extraArgs: string[] = [],
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', CLI_PATH, 'session', 'close-self', ...extraArgs],
      {
        env: {
          ...process.env,
          SESSION_DATA_DIR: dataDir,
          BOTMUX_SESSION_ID: 'session-cli-a',
          BOTMUX_LARK_APP_ID: 'app-cli-a',
          BOTMUX_SEND_RELAY: relayDir,
          BOTMUX_DAEMON_IPC_PORT: String(port),
          BOTMUX_TURN_ID: 'turn-cli-a',
          BOTMUX_DISPATCH_ATTEMPT: '4',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
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

describe('botmux session close-self CLI', () => {
  it('uses the owning injected daemon port without sending a target session id', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-close-self-data-'));
    const relayDir = mkdtempSync(join(tmpdir(), 'botmux-close-self-relay-'));
    tempDirs.push(dataDir, relayDir);
    const originCapability = '56'.repeat(32);
    writeFileSync(
      join(relayDir, RELAY_ORIGIN_CAPABILITY_BASENAME),
      JSON.stringify({ token: originCapability }),
    );

    let receivedUrl = '';
    let receivedBody = '';
    const server = createServer((req, res) => {
      receivedUrl = req.url ?? '';
      req.setEncoding('utf8');
      req.on('data', chunk => { receivedBody += chunk; });
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          ok: true,
          accepted: true,
          sessionId: 'session-cli-a',
          alreadyClosed: false,
        }));
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));

    try {
      const port = (server.address() as AddressInfo).port;
      const result = await runCloseSelf(dataDir, relayDir, port);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('会话关闭已提交');
      expect(result.stderr).toBe('');
      expect(receivedUrl).toBe('/api/sessions/self/close');
      expect(JSON.parse(receivedBody)).toEqual({
        capability: deriveSessionSelfCloseCapability(originCapability),
        turnId: 'turn-cli-a',
        dispatchAttempt: 4,
      });
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close(err => err ? reject(err) : resolve());
      });
    }
  });

  it('rejects every caller-selected target argument before contacting daemon', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-close-self-data-'));
    const relayDir = mkdtempSync(join(tmpdir(), 'botmux-close-self-relay-'));
    tempDirs.push(dataDir, relayDir);
    writeFileSync(
      join(relayDir, RELAY_ORIGIN_CAPABILITY_BASENAME),
      JSON.stringify({ token: '78'.repeat(32) }),
    );
    let requests = 0;
    const server = createServer((_req, res) => {
      requests += 1;
      res.writeHead(500);
      res.end();
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));

    try {
      const port = (server.address() as AddressInfo).port;
      const result = await runCloseSelf(dataDir, relayDir, port, ['session-b']);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('不接受 sessionId');
      expect(requests).toBe(0);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close(err => err ? reject(err) : resolve());
      });
    }
  });
});
