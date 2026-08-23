import { spawn } from 'node:child_process';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RELAY_ORIGIN_CAPABILITY_BASENAME } from '../src/core/managed-origin-capability.js';

const CLI_PATH = join(__dirname, '..', 'src', 'cli.ts');
const SESSION_ID = 'session-preview-cli';
const CAPABILITY = 'ce'.repeat(32);
const tempDirs: string[] = [];
let daemon: Server | null = null;

afterEach(async () => {
  if (daemon) await new Promise<void>(resolve => daemon!.close(() => resolve()));
  daemon = null;
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function relayCapabilityDir(): string {
  const relayDir = mkdtempSync(join(tmpdir(), 'botmux-preview-relay-'));
  tempDirs.push(relayDir);
  mkdirSync(relayDir, { recursive: true });
  // readManagedOriginAuthorityFile only accepts an owner-private 0600 regular
  // file — a capability readable by anyone else is not authority. Real writers
  // create it that way; the fixture must match or the claim is silently dropped.
  writeFileSync(join(relayDir, RELAY_ORIGIN_CAPABILITY_BASENAME), JSON.stringify({
    token: CAPABILITY,
    turnId: 'turn-preview',
    dispatchAttempt: 4,
  }), { mode: 0o600 });
  return relayDir;
}

function runPreview(input: {
  args: string[];
  dataDir: string;
  relayDir?: string;
  daemonPort?: number;
  sessionId?: string;
  workflow?: string;
}): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      SESSION_DATA_DIR: input.dataDir,
      BOTMUX_SESSION_ID: input.sessionId,
      BOTMUX_LARK_APP_ID: 'app-preview-cli',
      BOTMUX_SEND_RELAY: input.relayDir,
      BOTMUX_DAEMON_IPC_PORT: input.daemonPort === undefined ? undefined : String(input.daemonPort),
      BOTMUX_WORKFLOW: input.workflow,
    };
    for (const [name, value] of Object.entries(env)) if (value === undefined) delete env[name];
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', CLI_PATH, 'preview', ...input.args],
      { env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
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

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise(resolve => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(raw)); } catch { resolve({}); }
    });
  });
}

describe('botmux preview <port>', () => {
  it('uses only the current session + injected daemon port and never prints a capability/token/target', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-preview-data-'));
    tempDirs.push(dataDir);
    const relayDir = relayCapabilityDir();
    let requestUrl = '';
    let requestBody: Record<string, unknown> = {};
    daemon = createServer(async (req, res) => {
      requestUrl = req.url ?? '';
      requestBody = await readJson(req);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        preview: { path: `/preview/${SESSION_ID}/`, registeredAt: '2026-08-11T12:00:00.000Z' },
      }));
    });
    await new Promise<void>(resolve => daemon!.listen(0, '127.0.0.1', resolve));
    const daemonPort = (daemon.address() as { port: number }).port;

    const result = await runPreview({
      args: ['4173'],
      dataDir,
      relayDir,
      daemonPort,
      sessionId: SESSION_ID,
      // Preview is intentionally admitted through the workflow safety gate: it
      // is local/session-scoped and produces no chat/deploy effect.
      workflow: '1',
    });

    expect(result.status).toBe(0);
    expect(requestUrl).toBe(`/api/sessions/${SESSION_ID}/preview`);
    expect(requestBody).toEqual({
      port: 4173,
      originCapability: CAPABILITY,
      originTurnId: 'turn-preview',
      originDispatchAttempt: 4,
    });
    expect(result.stdout).toContain(`/preview/${SESSION_ID}/`);
    for (const forbidden of [CAPABILITY, '4173', '127.0.0.1', 'token=', 'originCapability']) {
      expect(result.stdout).not.toContain(forbidden);
      expect(result.stderr).not.toContain(forbidden);
    }
  });

  it('rejects invalid ports before contacting a daemon', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-preview-data-'));
    tempDirs.push(dataDir);
    for (const value of ['0', '65536', '-1', '3.14', 'not-a-port']) {
      const result = await runPreview({ args: [value], dataDir, sessionId: SESSION_ID });
      expect(result.status, value).toBe(1);
      expect(result.stderr, value).toMatch(/用法|1-65535/);
    }
  });

  it('requires an actual current session and exposes no --session override', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-preview-data-'));
    tempDirs.push(dataDir);
    const result = await runPreview({ args: ['3000'], dataDir });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('只能在 botmux 会话内注册');
  });

  it('maps an unreachable target to a stable user-facing error without echoing daemon details', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-preview-data-'));
    tempDirs.push(dataDir);
    const relayDir = relayCapabilityDir();
    daemon = createServer(async (req, res) => {
      await readJson(req);
      res.writeHead(422, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'preview_unreachable', detail: '127.0.0.1:49999' }));
    });
    await new Promise<void>(resolve => daemon!.listen(0, '127.0.0.1', resolve));

    const result = await runPreview({
      args: ['49999'],
      dataDir,
      relayDir,
      daemonPort: (daemon.address() as { port: number }).port,
      sessionId: SESSION_ID,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('端口不可达');
    expect(result.stderr).not.toContain('49999');
    expect(result.stderr).not.toContain('127.0.0.1');
  });
});
