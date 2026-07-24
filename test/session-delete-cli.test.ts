/**
 * CLI boundary regression for `botmux delete` daemon-first close semantics.
 *
 * Runs the source CLI through tsx against a tiny fake daemon. The daemon route
 * itself is covered separately; these tests prove the CLI never kills/persists
 * locally while a live owner daemon is authoritative, carries the current
 * session capability, and retains an offline fallback.
 */
import { spawn } from 'node:child_process';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RELAY_ORIGIN_CAPABILITY_BASENAME } from '../src/core/managed-origin-capability.js';

const CLI_PATH = join(__dirname, '..', 'src', 'cli.ts');
const APP_ID = 'cli_delete_test';
const CAPABILITY = 'ab'.repeat(32);
const tempDirs: string[] = [];

interface StoredSession {
  sessionId: string;
  chatId: string;
  rootMessageId: string;
  title: string;
  status: 'active' | 'closed';
  createdAt: string;
  closedAt?: string;
  larkAppId?: string;
  adoptedFrom?: { source: 'tmux'; tmuxTarget: string; cwd: string };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeSession(sessionId: string, overrides: Partial<StoredSession> = {}): StoredSession {
  return {
    sessionId,
    chatId: 'oc_delete_test',
    rootMessageId: 'om_delete_test',
    title: sessionId,
    status: 'active',
    createdAt: '2026-07-22T00:00:00.000Z',
    larkAppId: APP_ID,
    ...overrides,
  };
}

function writeSessions(dataDir: string, sessions: StoredSession[]): string {
  mkdirSync(dataDir, { recursive: true });
  const path = join(dataDir, `sessions-${APP_ID}.json`);
  writeFileSync(path, JSON.stringify(Object.fromEntries(sessions.map(s => [s.sessionId, s]))));
  return path;
}

function writeLegacySessions(dataDir: string, sessions: StoredSession[]): string {
  mkdirSync(dataDir, { recursive: true });
  const path = join(dataDir, 'sessions.json');
  writeFileSync(path, JSON.stringify(Object.fromEntries(sessions.map(s => [s.sessionId, s]))));
  return path;
}

function writeDaemonDescriptor(dataDir: string, port: number): void {
  const dir = join(dataDir, 'dashboard-daemons');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${APP_ID}.json`), JSON.stringify({
    larkAppId: APP_ID,
    ipcPort: port,
    lastHeartbeat: Date.now(),
  }));
}

function writeRelayCapability(relayDir: string): void {
  mkdirSync(relayDir, { recursive: true });
  writeFileSync(
    join(relayDir, RELAY_ORIGIN_CAPABILITY_BASENAME),
    JSON.stringify({ token: CAPABILITY, turnId: 'turn-delete', dispatchAttempt: 3 }),
  );
}

function runDelete(
  dataDir: string,
  args: string[],
  envOverrides: Record<string, string | undefined> = {},
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      SESSION_DATA_DIR: dataDir,
      ...envOverrides,
    };
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete env[key];
    }
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', CLI_PATH, 'delete', ...args],
      { env, stdio: ['ignore', 'pipe', 'pipe'] },
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

function readRequestBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); }
      catch { resolve({}); }
    });
  });
}

describe('botmux delete — daemon-first close', () => {
  it('delegates a current-session close to the daemon with its rotating capability', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-delete-data-'));
    const relayDir = mkdtempSync(join(tmpdir(), 'botmux-delete-relay-'));
    tempDirs.push(dataDir, relayDir);
    const session = makeSession('sess-delete-current');
    const sessionsPath = writeSessions(dataDir, [session]);
    writeRelayCapability(relayDir);

    let requestUrl = '';
    let requestBody: Record<string, unknown> = {};
    const server = createServer(async (req, res) => {
      requestUrl = req.url ?? '';
      requestBody = await readRequestBody(req);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true,"alreadyClosed":false}');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));

    try {
      const port = (server.address() as AddressInfo).port;
      writeDaemonDescriptor(dataDir, port);
      const result = await runDelete(dataDir, [session.sessionId], {
        BOTMUX_SESSION_ID: session.sessionId,
        BOTMUX_LARK_APP_ID: APP_ID,
        BOTMUX_SEND_RELAY: relayDir,
        BOTMUX_DAEMON_IPC_PORT: String(port),
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('已关闭 1 个会话');
      expect(requestUrl).toBe(`/api/sessions/${session.sessionId}/close`);
      expect(requestBody).toMatchObject({
        originCapability: CAPABILITY,
        originTurnId: 'turn-delete',
        originDispatchAttempt: 3,
      });
      // The fake daemon deliberately does not persist. Staying active proves
      // the CLI did not run the legacy local fallback after an IPC success.
      const stored = JSON.parse(readFileSync(sessionsPath, 'utf8'));
      expect(stored[session.sessionId].status).toBe('active');
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close(err => err ? reject(err) : resolve());
      });
    }
  });

  it('fails closed when a discovered daemon rejects the close', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-delete-data-'));
    const relayDir = mkdtempSync(join(tmpdir(), 'botmux-delete-relay-'));
    tempDirs.push(dataDir, relayDir);
    const session = makeSession('sess-delete-rejected');
    const sessionsPath = writeSessions(dataDir, [session]);
    writeRelayCapability(relayDir);

    const server = createServer(async (req, res) => {
      await readRequestBody(req);
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end('{"ok":false,"error":"origin_unproven"}');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));

    try {
      const port = (server.address() as AddressInfo).port;
      writeDaemonDescriptor(dataDir, port);
      const result = await runDelete(dataDir, [session.sessionId], {
        BOTMUX_SESSION_ID: session.sessionId,
        BOTMUX_LARK_APP_ID: APP_ID,
        BOTMUX_SEND_RELAY: relayDir,
        BOTMUX_DAEMON_IPC_PORT: String(port),
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('origin_unproven');
      expect(result.stdout).toContain('0 个会话');
      const stored = JSON.parse(readFileSync(sessionsPath, 'utf8'));
      expect(stored[session.sessionId].status).toBe('active');
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close(err => err ? reject(err) : resolve());
      });
    }
  });

  it('uses the legacy local close only when no daemon is online', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-delete-data-'));
    tempDirs.push(dataDir);
    const session = makeSession('sess-delete-offline', {
      adoptedFrom: { source: 'tmux', tmuxTarget: 'user:1.0', cwd: '/repo' },
    });
    const sessionsPath = writeSessions(dataDir, [session]);

    const result = await runDelete(dataDir, [session.sessionId], {
      BOTMUX_SESSION_ID: undefined,
      BOTMUX_LARK_APP_ID: undefined,
      BOTMUX_SEND_RELAY: undefined,
      BOTMUX_DAEMON_IPC_PORT: undefined,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('daemon 离线，本地收口');
    const stored = JSON.parse(readFileSync(sessionsPath, 'utf8'));
    expect(stored[session.sessionId].status).toBe('closed');
    expect(stored[session.sessionId].closedAt).toBeTruthy();
  });

  it('orders the current session last for delete all', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-delete-data-'));
    const fakeHome = mkdtempSync(join(tmpdir(), 'botmux-delete-home-'));
    tempDirs.push(dataDir, fakeHome);
    const self = makeSession('sess-delete-self');
    const other = makeSession('sess-delete-other');
    writeSessions(dataDir, [self, other]);
    mkdirSync(join(fakeHome, '.botmux'), { recursive: true });
    writeFileSync(join(fakeHome, '.botmux', '.dashboard-secret'), 'delete-test-secret');

    const seen: string[] = [];
    const server = createServer(async (req, res) => {
      seen.push(req.url ?? '');
      await readRequestBody(req);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true,"alreadyClosed":false}');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));

    try {
      const port = (server.address() as AddressInfo).port;
      writeDaemonDescriptor(dataDir, port);
      const result = await runDelete(dataDir, ['all'], {
        HOME: fakeHome,
        BOTMUX_SESSION_ID: self.sessionId,
        BOTMUX_LARK_APP_ID: APP_ID,
        BOTMUX_SEND_RELAY: undefined,
        BOTMUX_DAEMON_IPC_PORT: String(port),
      });

      expect(result.status).toBe(0);
      expect(seen).toEqual([
        `/api/sessions/${other.sessionId}/close`,
        `/api/sessions/${self.sessionId}/close`,
      ]);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close(err => err ? reject(err) : resolve());
      });
    }
  });

  it('closes a legacy session (no larkAppId) locally even when a daemon is online', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-delete-legacy-data-'));
    tempDirs.push(dataDir);
    // Legacy session has no larkAppId and lives in sessions.json, not the
    // per-bot file. A per-bot daemon cannot persist its close.
    const session = makeSession('sess-delete-legacy', { larkAppId: undefined });
    const sessionsPath = writeLegacySessions(dataDir, [session]);

    const seen: string[] = [];
    const server = createServer(async (req, res) => {
      seen.push(req.url ?? '');
      await readRequestBody(req);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true,"alreadyClosed":false}');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));

    try {
      const port = (server.address() as AddressInfo).port;
      writeDaemonDescriptor(dataDir, port);
      const result = await runDelete(dataDir, [session.sessionId], {
        BOTMUX_SESSION_ID: undefined,
        BOTMUX_LARK_APP_ID: undefined,
        BOTMUX_SEND_RELAY: undefined,
        BOTMUX_DAEMON_IPC_PORT: undefined,
      });

      // CLI must not route the legacy session to the daemon: the daemon writes
      // only its own sessions-<appId>.json and would return "200 OK" without
      // actually closing the legacy row.
      expect(seen).toEqual([]);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('daemon 离线，本地收口');
      const stored = JSON.parse(readFileSync(sessionsPath, 'utf8'));
      expect(stored[session.sessionId].status).toBe('closed');
      expect(stored[session.sessionId].closedAt).toBeTruthy();
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close(err => err ? reject(err) : resolve());
      });
    }
  });
});
