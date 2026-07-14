import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildSetCookie,
  decideDashboardAuth,
  parseCookie,
} from '../src/dashboard/auth.js';
import { handleWorkflowApi, jsonRes } from '../src/dashboard/workflow-api.js';
import { dashboardRoutes } from '../src/dashboard/web/dashboard-routes.js';
import { computeRevisionId, parseWorkflowDefinition } from '../src/workflows/definition.js';
import { EventLog } from '../src/workflows/events/append.js';
import { createRun } from '../src/workflows/run-init.js';
import { runLoop } from '../src/workflows/loop.js';
import type { WorkerSpawnFn } from '../src/workflows/runtime.js';

const TOKEN = 'test-dashboard-token';

const WAIT_DEF = parseWorkflowDefinition({
  workflowId: 'route-smoke-wait',
  version: 1,
  nodes: {
    approve: {
      type: 'subagent',
      bot: 'bot-a',
      prompt: 'ship it',
      humanGate: { stage: 'before', prompt: 'approve?' },
    },
  },
});

let tempDir: string;
let runsDir: string;
let server: Server | null;
let baseUrl: string;
let proxyCalls: unknown[];

beforeEach(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'dashboard-route-smoke-'));
  runsDir = join(tempDir, 'runs');
  proxyCalls = [];
  await seedWaitingRun('route-smoke-01');
  const started = await startDashboardSmokeServer();
  server = started.server;
  baseUrl = started.baseUrl;
});

afterEach(async () => {
  await new Promise<void>((resolve) => {
    if (!server) return resolve();
    server.close(() => resolve());
  });
  server = null;
  rmSync(tempDir, { recursive: true, force: true });
});

describe('dashboard route smoke auth boundary', () => {
  it('registers the monitoring route', () => {
    expect(dashboardRoutes.some(route => route.id === 'monitoring' && route.routePrefix === '#/monitoring')).toBe(true);
  });

  it('allows workflow read-only APIs without cookie', async () => {
    const list = await fetch(`${baseUrl}/api/workflows/runs`);
    expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({
      runs: [expect.objectContaining({ runId: 'route-smoke-01' })],
    });

    const snapshot = await fetch(`${baseUrl}/api/workflows/runs/route-smoke-01/snapshot`);
    expect(snapshot.status).toBe(200);
    expect(await snapshot.json()).toMatchObject({
      runId: 'route-smoke-01',
      run: expect.objectContaining({ workflowId: 'route-smoke-wait' }),
    });
  });

  it('requires auth for workflow mutations and non-workflow APIs', async () => {
    const cancel = await fetch(`${baseUrl}/api/workflows/runs/route-smoke-01/cancel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'stop' }),
    });
    expect(cancel.status).toBe(401);
    expect(proxyCalls).toEqual([]);

    const approve = await fetch(`${baseUrl}/api/workflows/runs/route-smoke-01/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(approve.status).toBe(401);
    const reject = await fetch(`${baseUrl}/api/workflows/runs/route-smoke-01/reject`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(reject.status).toBe(401);
    expect(proxyCalls).toEqual([]);

    const trigger = await fetch(`${baseUrl}/api/workflows/definitions/route-smoke-wait/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        params: {},
        chatBinding: { chatId: 'oc_chat', larkAppId: 'cli_owner' },
      }),
    });
    expect(trigger.status).toBe(401);
    expect(proxyCalls).toEqual([]);

    const sessions = await fetch(`${baseUrl}/api/sessions`);
    expect(sessions.status).toBe(401);
  });

  it('allows GET catalog definitions list + detail without cookie', async () => {
    const list = await fetch(`${baseUrl}/api/workflows/definitions`);
    expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({ definitions: expect.any(Array) });

    const detail = await fetch(
      `${baseUrl}/api/workflows/definitions/route-smoke-wait`,
    );
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({
      definition: expect.objectContaining({ workflowId: 'route-smoke-wait' }),
      revisionId: expect.stringMatching(/^sha256:/),
    });
  });

  it('keeps health and static shell public while missing assets stay public 404', async () => {
    const health = await fetch(`${baseUrl}/__health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true });

    const root = await fetch(`${baseUrl}/`);
    expect(root.status).toBe(200);
    expect(await root.text()).toContain('dashboard shell');

    const missingAsset = await fetch(`${baseUrl}/assets/missing.js`);
    expect(missingAsset.status).toBe(404);
    expect(await missingAsset.json()).toEqual({ error: 'not_found_yet', path: '/assets/missing.js' });
  });

  it('sets a cookie for a correct token URL without granting wrong public tokens', async () => {
    const good = await fetch(`${baseUrl}/?t=${TOKEN}`, { redirect: 'manual' });
    expect(good.status).toBe(302);
    expect(good.headers.get('location')).toBe('/');
    expect(good.headers.get('set-cookie')).toContain(`botmux_dashboard_token=${TOKEN}`);

    const bad = await fetch(`${baseUrl}/?t=wrong`, { redirect: 'manual' });
    expect(bad.status).toBe(200);
    expect(bad.headers.get('set-cookie')).toBeNull();
  });

  it('denies wrong token URLs on protected routes', async () => {
    const bad = await fetch(`${baseUrl}/api/sessions?t=wrong`, { redirect: 'manual' });
    expect(bad.status).toBe(401);
  });

  it('allows protected routes with the dashboard cookie', async () => {
    const res = await fetch(`${baseUrl}/api/sessions`, {
      headers: { cookie: `botmux_dashboard_token=${TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sessions: [] });
  });
});

async function startDashboardSmokeServer(): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      if (url.pathname === '/__health') return jsonRes(res, 200, { ok: true });

      const queryToken = url.searchParams.get('t');
      const presentedToken = queryToken === TOKEN ? queryToken : parseCookie(req.headers.cookie);
      const decision = decideDashboardAuth({
        method: req.method ?? 'GET',
        pathname: url.pathname,
        hasTokenParam: url.searchParams.has('t'),
        presentedToken,
        activeToken: TOKEN,
      });
      if (decision.kind === 'deny401') {
        res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' });
        res.end('<h1>Token expired</h1>');
        return;
      }
      if (decision.kind === 'allow+set-cookie') {
        res.writeHead(302, {
          'set-cookie': buildSetCookie(decision.token),
          'location': decision.redirectTo,
        });
        res.end();
        return;
      }

      if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end('<html><body>dashboard shell</body></html>');
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/sessions') {
        return jsonRes(res, 200, { sessions: [] });
      }

      if (await handleWorkflowApi(req, res, url, {
        runsDir,
        proxyToDaemon: async (larkAppId, daemonPath, init) => {
          proxyCalls.push({ larkAppId, daemonPath, init });
          return new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        },
        listWorkflowDefinitions: async () => [{
          workflowId: 'route-smoke-wait',
          version: 1,
          path: '/tmp/route-smoke-wait.workflow.json',
          revisionId: computeRevisionId(WAIT_DEF),
          paramCount: 0,
          requiredParamCount: 0,
          nodeCount: 1,
        }],
        loadCatalogDefinition: async (id) =>
          id === 'route-smoke-wait'
            ? {
                definition: WAIT_DEF,
                revisionId: computeRevisionId(WAIT_DEF),
                path: '/tmp/route-smoke-wait.workflow.json',
              }
            : undefined,
      })) return;

      jsonRes(res, 404, { error: 'not_found_yet', path: url.pathname });
    } catch (err) {
      jsonRes(res, 500, { error: String(err) });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address();
  if (!addr || typeof addr !== 'object') throw new Error('server did not bind');
  return { server, baseUrl: `http://127.0.0.1:${addr.port}` };
}

async function seedWaitingRun(runId: string): Promise<void> {
  const log = new EventLog(runId, runsDir);
  await createRun(log, {
    def: WAIT_DEF,
    params: {},
    initiator: 'test',
    botResolver: () => ({}),
  });
  await runLoop({
    log,
    def: WAIT_DEF,
    spawnSubagent: unusedSpawn,
  });
}

const unusedSpawn: WorkerSpawnFn = async () => {
  throw new Error('spawn should not be reached for before humanGate');
};
