/**
 * CLI boundary regression for `botmux delete` daemon-first close semantics.
 *
 * Runs the source CLI through tsx against a tiny fake daemon. The daemon route
 * itself is covered separately; these tests prove the CLI never kills/persists
 * locally while a live owner daemon is authoritative, carries the current
 * session capability, and retains an offline fallback.
 */
import { type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { spawnTsScript } from './helpers/ts-runner.js';
import {
  readPersistedSessionRows,
  seedPersistedSessionRows,
  sessionStorePath,
} from './helpers/session-store-disk.js';
import {
  managedOriginCapabilityPath,
  RELAY_ORIGIN_CAPABILITY_BASENAME,
} from '../src/core/managed-origin-capability.js';

const CLI_PATH = join(__dirname, '..', 'src', 'cli.ts');
const APP_ID = 'cli_delete_test';
const CAPABILITY = 'ab'.repeat(32);
const ORIGIN_CHANNEL = 'cd'.repeat(32);
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
  /** Live preview loopback registered by the worker generation being closed. */
  previewTarget?: { host: string; port: number; registeredAt: string };
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

/** Seed this bot's per-bot store: `session-stores/<appId>/sessions.db`. */
function writeSessions(dataDir: string, sessions: StoredSession[]): void {
  mkdirSync(dataDir, { recursive: true });
  seedPersistedSessionRows(dataDir, APP_ID, Object.fromEntries(sessions.map(s => [s.sessionId, s])));
}

/** Seed the legacy no-appId store: the flat `sessions.db`. */
function writeLegacySessions(dataDir: string, sessions: StoredSession[]): void {
  mkdirSync(dataDir, { recursive: true });
  seedPersistedSessionRows(dataDir, undefined, Object.fromEntries(sessions.map(s => [s.sessionId, s])));
}

function readSessions(dataDir: string): Record<string, StoredSession> {
  return readPersistedSessionRows(dataDir, APP_ID) as Record<string, StoredSession>;
}

function readLegacySessions(dataDir: string): Record<string, StoredSession> {
  return readPersistedSessionRows(dataDir) as Record<string, StoredSession>;
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
  const path = join(relayDir, RELAY_ORIGIN_CAPABILITY_BASENAME);
  writeFileSync(
    path,
    JSON.stringify({ token: CAPABILITY, turnId: 'turn-delete', dispatchAttempt: 3 }),
  );
  chmodSync(path, 0o600);
}

function writeReadIsolatedCapability(dataDir: string, sessionId: string): void {
  const path = managedOriginCapabilityPath(dataDir, sessionId, ORIGIN_CHANNEL);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({
    sessionId,
    channelId: ORIGIN_CHANNEL,
    capability: CAPABILITY,
    turnId: 'turn-delete',
    dispatchAttempt: 3,
  }));
  chmodSync(path, 0o600);
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
    const child = spawnTsScript(
      CLI_PATH,
      ['delete', ...args],
      { env, stdio: ['ignore', 'pipe', 'pipe'] },
    ) as ChildProcessWithoutNullStreams;
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
    const homeDir = mkdtempSync(join(tmpdir(), 'botmux-delete-home-'));
    tempDirs.push(dataDir, homeDir);
    const session = makeSession('sess-delete-current');
    writeSessions(dataDir, [session]);
    writeReadIsolatedCapability(dataDir, session.sessionId);

    let requestUrl = '';
    let requestBody: Record<string, unknown> = {};
    const server = createServer(async (req, res) => {
      requestUrl = req.url ?? '';
      requestBody = await readRequestBody(req);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true,"outcome":"closed","alreadyClosed":false}');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));

    try {
      const port = (server.address() as AddressInfo).port;
      writeDaemonDescriptor(dataDir, port);
      const result = await runDelete(dataDir, [session.sessionId], {
        BOTMUX_SESSION_ID: session.sessionId,
        BOTMUX_LARK_APP_ID: APP_ID,
        BOTMUX_SEND_RELAY: undefined,
        BOTMUX_ORIGIN_CHANNEL_ID: ORIGIN_CHANNEL,
        BOTMUX_DAEMON_IPC_PORT: String(port),
        HOME: homeDir,
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
      const stored = readSessions(dataDir);
      expect(stored[session.sessionId].status).toBe('active');
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close(err => err ? reject(err) : resolve());
      });
    }
  });

  it('does NOT claim a plain delete when the daemon reports an uncancelled remote', async () => {
    // The daemon closed the local row but could not cancel the remote session. The
    // CLI used to flatten the whole response into {ok:true} and print the green
    // "已关闭 N 个会话", so the operator walked away from a live agent that still
    // holds the injected credential.
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-delete-data-'));
    const homeDir = mkdtempSync(join(tmpdir(), 'botmux-delete-home-'));
    tempDirs.push(dataDir, homeDir);
    const session = makeSession('sess-delete-residual');
    writeSessions(dataDir, [session]);
    writeReadIsolatedCapability(dataDir, session.sessionId);

    const server = createServer(async (req, res) => {
      await readRequestBody(req);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        outcome: 'closed_with_residual',
        residual: { reason: 'mojo_lineage_quarantined', taskId: 'mojo-parked-9' },
        alreadyClosed: false,
      }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));

    try {
      const port = (server.address() as AddressInfo).port;
      writeDaemonDescriptor(dataDir, port);
      const result = await runDelete(dataDir, [session.sessionId], {
        BOTMUX_SESSION_ID: session.sessionId,
        BOTMUX_LARK_APP_ID: APP_ID,
        BOTMUX_SEND_RELAY: undefined,
        BOTMUX_ORIGIN_CHANNEL_ID: ORIGIN_CHANNEL,
        BOTMUX_DAEMON_IPC_PORT: String(port),
        HOME: homeDir,
      });

      const output = `${result.stdout}\n${result.stderr}`;
      expect(output).toContain('mojo-parked-9');
      expect(output).toContain('远端会话未取消');
      // The summary must flag it rather than reporting an unqualified success.
      // (Wording is residual-kind-neutral now that a LOCAL subtree residual can
      // also appear here — the per-line message above still names the remote one.)
      expect(output).toContain('有残留需人工清理');
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
    writeSessions(dataDir, [session]);
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
      const stored = readSessions(dataDir);
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
      // A retained target would let a later reader proxy into whatever local
      // server re-acquires the port; offline close must drop it exactly like
      // the daemon-side closeSession() does.
      previewTarget: { host: '127.0.0.1', port: 43111, registeredAt: '2026-07-22T00:00:00.000Z' },
    });
    writeSessions(dataDir, [session]);

    const result = await runDelete(dataDir, [session.sessionId], {
      BOTMUX_SESSION_ID: undefined,
      BOTMUX_LARK_APP_ID: undefined,
      BOTMUX_SEND_RELAY: undefined,
      BOTMUX_DAEMON_IPC_PORT: undefined,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('daemon 离线，本地收口');
    const stored = readSessions(dataDir);
    expect(stored[session.sessionId].status).toBe('closed');
    expect(stored[session.sessionId].closedAt).toBeTruthy();
    expect(stored[session.sessionId]).not.toHaveProperty('previewTarget');
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
      res.end('{"ok":true,"outcome":"closed","alreadyClosed":false}');
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
    // Legacy session has no larkAppId and lives in the flat `sessions.db`, not
    // the per-bot store. A per-bot daemon cannot persist its close.
    const session = makeSession('sess-delete-legacy', { larkAppId: undefined });
    writeLegacySessions(dataDir, [session]);

    const seen: string[] = [];
    const server = createServer(async (req, res) => {
      seen.push(req.url ?? '');
      await readRequestBody(req);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true,"outcome":"closed","alreadyClosed":false}');
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
      // only its own session-stores/<appId>/sessions.db and would return
      // "200 OK" without actually closing the legacy row.
      expect(seen).toEqual([]);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('daemon 离线，本地收口');
      const stored = readLegacySessions(dataDir);
      expect(stored[session.sessionId].status).toBe('closed');
      expect(stored[session.sessionId].closedAt).toBeTruthy();
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close(err => err ? reject(err) : resolve());
      });
    }
  });

  it('closes a legacy current session locally even with an injected daemon port', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-delete-legacy-cur-data-'));
    tempDirs.push(dataDir);
    // A larkAppId-less session that is ALSO the current session: the injected
    // BOTMUX_DAEMON_IPC_PORT reaches a daemon even with no online descriptor.
    // The daemon still writes only its own session-stores/<appId>/sessions.db
    // and would no-op the legacy close, so the larkAppId guard must divert this
    // to the offline path too — the injected port is not a second door around it.
    const session = makeSession('sess-delete-legacy-cur', { larkAppId: undefined });
    writeLegacySessions(dataDir, [session]);

    const seen: string[] = [];
    const server = createServer(async (req, res) => {
      seen.push(req.url ?? '');
      await readRequestBody(req);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true,"outcome":"closed","alreadyClosed":false}');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));

    try {
      const port = (server.address() as AddressInfo).port;
      const result = await runDelete(dataDir, [session.sessionId], {
        BOTMUX_SESSION_ID: session.sessionId,
        BOTMUX_LARK_APP_ID: undefined,
        BOTMUX_SEND_RELAY: undefined,
        BOTMUX_DAEMON_IPC_PORT: String(port),
      });

      // Injected port must not route a legacy session to the daemon.
      expect(seen).toEqual([]);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('daemon 离线，本地收口');
      const stored = readLegacySessions(dataDir);
      expect(stored[session.sessionId].status).toBe('closed');
      expect(stored[session.sessionId].closedAt).toBeTruthy();
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close(err => err ? reject(err) : resolve());
      });
    }
  });

  it('closes a session whose owning daemon has not imported the store yet', async () => {
    // 升级窗口：npm 换了 dist、重指了 launcher，而拥有这些行的 daemon 还在跑
    // 迁移前的版本、仍然读写 JSON。离线关闭必须照常落到那份 JSON 上——读不到
    // 会让 CLI 报「没有活跃会话」，等于告诉用户会话没了；而在这里建 .db 会在
    // 那台 daemon 背后把两种表示分叉，还会关掉它的一次性导入门。
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-delete-unimported-'));
    tempDirs.push(dataDir);
    const session = makeSession('sess-delete-unimported');
    mkdirSync(dataDir, { recursive: true });
    const jsonFp = join(dataDir, `sessions-${APP_ID}.json`);
    writeFileSync(jsonFp, JSON.stringify({ [session.sessionId]: session }));

    const result = await runDelete(dataDir, [session.sessionId], {
      BOTMUX_SESSION_ID: undefined,
      BOTMUX_LARK_APP_ID: APP_ID,
      BOTMUX_SEND_RELAY: undefined,
      BOTMUX_DAEMON_IPC_PORT: undefined,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('没有活跃会话');
    expect(JSON.parse(readFileSync(jsonFp, 'utf-8'))[session.sessionId].status).toBe('closed');
    expect(existsSync(sessionStorePath(dataDir, APP_ID))).toBe(false);
  });
});
