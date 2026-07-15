/**
 * Regression coverage for the SessionStart ready nonce plumbing.
 *
 * The CLI boundary runs as a real subprocess against a tiny fake daemon. The
 * daemon itself is intentionally source-checked because importing daemon.ts
 * boots the long-lived process and would make this unit test own global state.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const CLI_PATH = join(__dirname, '..', 'src', 'cli.ts');
const tempDirs: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
    server.close(err => err ? reject(err) : resolve());
  })));
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function startFakeDaemon(): Promise<{
  dataDir: string;
  bodies: unknown[];
}> {
  const bodies: unknown[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      bodies.push(JSON.parse(body));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);

  const dataDir = mkdtempSync(join(tmpdir(), 'botmux-session-ready-'));
  tempDirs.push(dataDir);
  const registryDir = join(dataDir, 'dashboard-daemons');
  mkdirSync(registryDir, { recursive: true });
  writeFileSync(join(registryDir, 'cli_test.json'), JSON.stringify({
    larkAppId: 'cli_test',
    ipcPort: (server.address() as AddressInfo).port,
    lastHeartbeat: Date.now(),
  }));
  return { dataDir, bodies };
}

function runSessionReady(dataDir: string, generation?: string): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env } as NodeJS.ProcessEnv;
    if (generation === undefined) delete env.BOTMUX_READY_GENERATION;
    else env.BOTMUX_READY_GENERATION = generation;
    Object.assign(env, {
      SESSION_DATA_DIR: dataDir,
      BOTMUX_SESSION_ID: 'sess_test',
      BOTMUX_LARK_APP_ID: 'cli_test',
    });
    const child = spawn(process.execPath, ['--import', 'tsx', CLI_PATH, 'session-ready'], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdin.end(JSON.stringify({ source: 'startup' }));
    child.once('error', reject);
    child.once('close', resolve);
  });
}

describe('botmux session-ready generation', () => {
  it('posts the inherited per-spawn generation with the ready signal', async () => {
    const { dataDir, bodies } = await startFakeDaemon();
    const generation = '0123456789abcdef0123456789abcdef';

    expect(await runSessionReady(dataDir, generation)).toBe(0);
    expect(bodies).toEqual([{ sessionId: 'sess_test', source: 'startup', generation }]);
  });

  it.each([undefined, '', 'old-generation', 'A'.repeat(32)])(
    'silently drops a missing or malformed generation (%s)',
    async generation => {
      const { dataDir, bodies } = await startFakeDaemon();
      expect(await runSessionReady(dataDir, generation)).toBe(0);
      expect(bodies).toEqual([]);
    },
  );

  it('validates and forwards generation at the daemon/type boundary', () => {
    const daemonSource = readFileSync(join(__dirname, '..', 'src', 'daemon.ts'), 'utf8');
    const routeStart = daemonSource.indexOf("ipcRoute('POST', '/api/session-ready'");
    const routeEnd = daemonSource.indexOf('// ─── hooks emit', routeStart);
    const route = daemonSource.slice(routeStart, routeEnd);
    const typesSource = readFileSync(join(__dirname, '..', 'src', 'types.ts'), 'utf8');

    expect(routeStart).toBeGreaterThan(-1);
    expect(route).toContain('generation?: unknown');
    expect(route).toContain("error: 'invalid_generation'");
    expect(route).toContain("ds.worker.send({ type: 'session_ready', source, generation }");
    expect(typesSource).toContain("{ type: 'session_ready'; source?: string; generation: string }");
  });
});
