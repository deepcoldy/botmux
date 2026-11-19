// Real Dashboard process and HTTP routing for the browser session list (`GET /api/sessions`);
// daemon replies are isolated fixtures. No real worker, session or external service is touched.
import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { join, resolve } from 'node:path';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { ChildProcess } from 'node:child_process';
import { spawnTsScript } from './helpers/ts-runner.js';
import { loadOrCreatePersistedToken } from '../src/dashboard/auth.js';
import { loopbackFetch } from '../src/core/loopback-fetch.js';

type Row = { sessionId: string; status: string; [key: string]: unknown };

async function request(url: string, headers: Record<string, string>) {
  const response = await loopbackFetch(url, { headers, signal: AbortSignal.timeout(2_000) });
  const text = await response.text();
  let body: any;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: response.status, body };
}

async function stopChild(child: ChildProcess | undefined) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const closed = once(child, 'close');
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 5_000);
  timer.unref();
  try { await closed; } finally { clearTimeout(timer); }
}

describe('Dashboard session list route', () => {
  let root = '';
  let child: ChildProcess | undefined;
  const daemons: Server[] = [];

  afterEach(async () => {
    await stopChild(child); child = undefined;
    for (const daemon of daemons.splice(0)) {
      daemon.closeAllConnections();
      if (daemon.listening) await new Promise<void>(done => daemon.close(() => done()));
    }
    if (root) rmSync(root, { recursive: true, force: true });
    root = '';
  });

  it('keeps the legacy full list, bounds the board, and keyword-searches the whole closed archive', async () => {
    root = mkdtempSync(join(tmpdir(), 'botmux-session-list-route-'));
    const isolatedHome = join(root, 'home');
    const botmuxDir = join(isolatedHome, '.botmux');
    const dataDir = join(botmuxDir, 'data');
    const registryDir = join(dataDir, 'dashboard-daemons');
    const botsPath = join(botmuxDir, 'bots.json');
    mkdirSync(registryDir, { recursive: true });
    writeFileSync(join(botmuxDir, '.dashboard-secret'), 'isolated-session-list-test-secret', { mode: 0o600 });
    writeFileSync(join(botmuxDir, '.data-dir'), `${dataDir}\n`, { mode: 0o600 });
    writeFileSync(join(botmuxDir, '.env'), '', { mode: 0o600 });
    // The second bot was renamed: its old closed row still carries the old name.
    const bots = [
      { appId: 'cli-list-plain', name: 'Plain bot' },
      { appId: 'cli-list-renamed', name: 'Night Builder' },
    ];
    writeFileSync(botsPath, JSON.stringify(bots.map(bot => ({
      larkAppId: bot.appId, larkAppSecret: 'fixture-only', botName: bot.name, cliId: 'codex',
    }))));
    const token = loadOrCreatePersistedToken(join(botmuxDir, '.dashboard-token'));
    const base = 1_700_000_000_000;
    const rowsByBot: Record<string, Row[]> = {
      'cli-list-plain': [
        { sessionId: 'live-1', status: 'active', title: 'Live work', lastMessageAt: base + 999_000 },
        ...Array.from({ length: 59 }, (_, index) => ({
          sessionId: `closed-${String(index + 1).padStart(2, '0')}`,
          status: 'closed', title: `Routine ${index + 1}`, botName: 'Plain bot',
          lastMessageAt: base + (index + 1) * 1_000, closedAt: base + (index + 1) * 1_000,
        })),
      ],
      // Oldest closed row of all: far below the first page of 50.
      'cli-list-renamed': [{
        sessionId: 'closed-renamed', status: 'closed', title: 'Routine archive', botName: 'Old name',
        lastMessageAt: base, closedAt: base,
      }],
    };

    for (const [index, bot] of bots.entries()) {
      const daemon = createServer((req, res) => {
        const route = req.url ?? '/';
        if (req.method === 'GET' && route === '/api/events') {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.write(': fixture stream\n\n');
          return;
        }
        if (req.method === 'GET' && route === '/api/sessions') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ sessions: rowsByBot[bot.appId].map(row => ({ ...row, larkAppId: bot.appId, cliId: 'codex' })) }));
          return;
        }
        if (req.method === 'GET' && route === '/api/schedules') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('{"schedules":[]}');
          return;
        }
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end('{"ok":false,"error":"unexpected_route"}');
      });
      daemons.push(daemon);
      daemon.listen(0, '127.0.0.1'); await once(daemon, 'listening');
      const port = (daemon.address() as import('node:net').AddressInfo).port;
      writeFileSync(join(registryDir, `${bot.appId}.json`), JSON.stringify({ larkAppId: bot.appId,
        botName: bot.name, botIndex: index, ipcPort: port, pid: process.pid,
        startedAt: Date.now(), lastHeartbeat: Date.now() }));
    }

    child = spawnTsScript(resolve('src/index-dashboard.ts'), [], {
      cwd: resolve('.'),
      env: { ...process.env, HOME: isolatedHome, USERPROFILE: isolatedHome, SESSION_DATA_DIR: dataDir,
        BOTS_CONFIG: botsPath, BOTMUX_DASHBOARD_PORT: '7891', BOTMUX_DASHBOARD_HOST: '127.0.0.1',
        BOTMUX_DASHBOARD_PUBLIC_READONLY: 'false' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let logs = '';
    child.stdout?.on('data', chunk => { logs += String(chunk); });
    child.stderr?.on('data', chunk => { logs += String(chunk); });
    const auth = { cookie: `botmux_dashboard_token=${token}` };
    let origin = '';
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) throw Error(`Dashboard exited early\n${logs}`);
      try {
        const port = Number(readFileSync(join(botmuxDir, '.dashboard-port'), 'utf8').trim());
        const candidate = `http://127.0.0.1:${port}`;
        const snapshot = await request(`${candidate}/api/sessions`, auth);
        if (snapshot.status === 200 && snapshot.body.sessions?.length === 61) { origin = candidate; break; }
      } catch { /* Wait for the real process and both daemon snapshots. */ }
      await new Promise(done => setTimeout(done, 50));
    }
    expect(origin, logs).not.toBe('');
    const list = (search: string) => request(`${origin}/api/sessions${search}`, auth);

    // Callers without `view` (Workbench doctor, older browsers) still get every row and no paging fields.
    const legacy = await list('');
    expect(legacy.body.sessions).toHaveLength(61);
    expect(legacy.body).not.toHaveProperty('closedCursor');

    const board = await list('?view=board');
    expect(board.status).toBe(200);
    const boardIds = (board.body.sessions as Row[]).map(row => row.sessionId);
    expect(boardIds).toContain('live-1');
    expect(boardIds.filter(id => id !== 'live-1')).toHaveLength(50);
    expect(boardIds).not.toContain('closed-renamed');
    expect(board.body).toMatchObject({ closedTotal: 60, closedCursor: expect.any(String) });

    // The renamed bot's current name finds its oldest closed row; the row is shown under that name.
    const found = await list(`?view=closed&q=${encodeURIComponent('night builder')}`);
    expect(found.status).toBe(200);
    expect(found.body).toMatchObject({ closedTotal: 1, closedCursor: null });
    expect(found.body.sessions).toEqual([expect.objectContaining({ sessionId: 'closed-renamed', botName: 'Night Builder' })]);

    expect(await list(`?view=closed&q=${'x'.repeat(201)}`)).toEqual({ status: 400, body: { ok: false, error: 'invalid_session_query' } });
    expect(await list('?view=board&q=routine')).toEqual({ status: 400, body: { ok: false, error: 'invalid_session_query' } });
  }, 60_000);
});
