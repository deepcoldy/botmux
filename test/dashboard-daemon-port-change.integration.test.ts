import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { ChildProcess } from 'node:child_process';
import { spawnTsEvalWithRepoImports } from './helpers/ts-runner.js';

// A bot daemon that comes back on a DIFFERENT IPC port while its registry
// descriptor stays present (rewritten in place, never deleted) must be followed
// by the dashboard. Field shape: a transient second daemon took 7950, the real
// one fell back to 7951; after a restart it listened on 7950 again, the
// descriptor said 7950, yet the dashboard's event subscription kept retrying
// 7951 every second because it was keyed by app id alone.

const appId = 'cli_port_change';
const managementToken = 'port-change-test-management-token';
const botmuxDir = join(homedir(), '.botmux');
const dataDir = join(botmuxDir, 'data');
const registryDir = join(dataDir, 'dashboard-daemons');
let child: ChildProcess;
let logs = '';
const servers: Server[] = [];

interface FakeDaemon { server: Server; port: number; eventStreams: () => number }

async function fakeDaemon(): Promise<FakeDaemon> {
  let eventStreams = 0;
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://daemon').pathname;
    if (path === '/api/events') {
      eventStreams += 1;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(': connected\n\n');
      return; // held open, like the real SSE stream
    }
    const body = path === '/api/sessions' ? { sessions: [] }
      : path === '/api/schedules' ? { schedules: [] }
      : undefined;
    res.writeHead(body ? 200 : 404, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body ?? {}));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  servers.push(server);
  return { server, port: (server.address() as AddressInfo).port, eventStreams: () => eventStreams };
}

/** Rewrite the descriptor the way a live daemon's heartbeat does: in place. */
function writeDescriptor(ipcPort: number): void {
  const target = join(registryDir, `${appId}.json`);
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, JSON.stringify({
    larkAppId: appId, botName: appId, botIndex: 0, ipcPort, pid: process.pid,
    startedAt: Date.now(), lastHeartbeat: Date.now(),
  }));
  renameSync(tmp, target);
}

async function waitFor(fn: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await new Promise(r => setTimeout(r, 100));
  }
  return fn();
}

let first: FakeDaemon;

beforeAll(async () => {
  mkdirSync(registryDir, { recursive: true });
  writeFileSync(join(botmuxDir, 'bots.json'), JSON.stringify([
    { larkAppId: appId, larkAppSecret: 'test-secret', cliId: 'claude-code' },
  ]));
  writeFileSync(join(botmuxDir, '.dashboard-token'), managementToken, { mode: 0o600 });
  writeFileSync(join(botmuxDir, '.dashboard-secret'), 'port-change-test-secret', { mode: 0o600 });
  writeFileSync(join(botmuxDir, '.data-dir'), dataDir);
  first = await fakeDaemon();
  writeDescriptor(first.port);

  child = spawnTsEvalWithRepoImports(`
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input.url ?? String(input));
      if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return realFetch(input, init);
      throw new Error('External network disabled in port-change regression');
    };
    await import('./src/index-dashboard.js');
  `, {
    cwd: resolve('.'),
    env: {
      ...process.env,
      SESSION_DATA_DIR: dataDir,
      BOTS_CONFIG: join(botmuxDir, 'bots.json'),
      BOTMUX_DASHBOARD_PORT: '17996',
      BOTMUX_DASHBOARD_HOST: '127.0.0.1',
      BOTMUX_DASHBOARD_PUBLIC_READONLY: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', chunk => { logs += String(chunk); });
  child.stderr?.on('data', chunk => { logs += String(chunk); });
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(logs);
    try {
      const port = Number(readFileSync(join(botmuxDir, '.dashboard-port'), 'utf8'));
      const health = await fetch(`http://127.0.0.1:${port}/__health`, { signal: AbortSignal.timeout(2_000) });
      if (health.ok) return;
    } catch { /* wait for the isolated dashboard */ }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`Dashboard startup timeout: ${logs}`);
}, 25_000);

afterAll(async () => {
  for (const server of servers) { server.closeAllConnections(); server.close(); }
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const closed = once(child, 'close');
  child.kill('SIGTERM');
  const force = setTimeout(() => child.kill('SIGKILL'), 5_000);
  try { await closed; } finally { clearTimeout(force); }
});

describe('dashboard daemon subscription', () => {
  it('follows a daemon that restarts on a different IPC port', async () => {
    expect(await waitFor(() => first.eventStreams() > 0, 10_000)).toBe(true);

    // The daemon restarts: the old port goes away, the new one comes up and
    // the descriptor is rewritten in place with the new port.
    first.server.closeAllConnections();
    first.server.close();
    const second = await fakeDaemon();
    writeDescriptor(second.port);

    // Generous enough to cover the registry's 15s poll even without fs.watch.
    expect(await waitFor(() => second.eventStreams() > 0, 20_000)).toBe(true);
  }, 35_000);
});
