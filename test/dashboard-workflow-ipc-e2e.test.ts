import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  handleWorkflowApi,
  jsonRes,
  type WorkflowApiDeps,
} from '../src/dashboard/workflow-api.js';
import { cancelWorkflowRun } from '../src/workflows/cancel-run.js';
import { parseWorkflowDefinition } from '../src/workflows/definition.js';
import { EventLog } from '../src/workflows/events/append.js';
import { replay } from '../src/workflows/events/replay.js';
import { createRun } from '../src/workflows/run-init.js';
import { runLoop } from '../src/workflows/loop.js';
import type {
  WorkflowRuntimeContext,
  WorkerSpawnFn,
} from '../src/workflows/runtime.js';

const WAIT_DEF = parseWorkflowDefinition({
  workflowId: 'ipc-wait',
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
let dashboardServer: Server | null;
let daemonServer: Server | null;
let dashboardBaseUrl: string;
let daemonBaseUrl: string;
let daemonContexts: Map<string, WorkflowRuntimeContext>;
let daemonRequests: Array<{ path: string; body: unknown }>;

beforeEach(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'wf-dashboard-ipc-'));
  runsDir = join(tempDir, 'runs');
  daemonContexts = new Map();
  daemonRequests = [];

  const daemon = await startDaemonIpcServer();
  daemonServer = daemon.server;
  daemonBaseUrl = daemon.baseUrl;

  const dashboard = await startWorkflowApiServer({
    runsDir,
    proxyToDaemon: async (_larkAppId, daemonPath, init) =>
      fetch(`${daemonBaseUrl}${daemonPath}`, init),
  });
  dashboardServer = dashboard.server;
  dashboardBaseUrl = dashboard.baseUrl;
});

afterEach(async () => {
  await closeServer(dashboardServer);
  await closeServer(daemonServer);
  dashboardServer = null;
  daemonServer = null;
  rmSync(tempDir, { recursive: true, force: true });
});

describe('dashboard workflow IPC e2e', () => {
  it('proxies dashboard cancel to daemon IPC and writes real cancel events', async () => {
    const { log } = await seedOwnedWaitingRun('ipc-owned-01', {
      chatId: 'oc_owner',
      larkAppId: 'cli_owner',
    });

    const res = await fetch(`${dashboardBaseUrl}/api/workflows/runs/ipc-owned-01/cancel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'operator stop' }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      runId: 'ipc-owned-01',
      status: 'cancelled',
      alreadyTerminal: false,
    });
    expect(daemonRequests).toEqual([
      {
        path: '/api/workflows/runs/ipc-owned-01/cancel',
        body: { reason: 'operator stop' },
      },
    ]);

    const events = await log.readAll();
    expect(events.map((e) => e.type)).toEqual([
      'runCreated',
      'runStarted',
      'attemptCreated',
      'waitCreated',
      'cancelRequested',
      'resumeStarted',
      'activityCanceled',
      'nodeCanceled',
      'runCanceled',
    ]);
    const snapshot = replay(events);
    expect(snapshot.run.status).toBe('cancelled');
    expect(snapshot.cancelledRunIntent).toBeUndefined();
  });
});

async function startWorkflowApiServer(deps: WorkflowApiDeps): Promise<{
  server: Server;
  baseUrl: string;
}> {
  return startServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      if (await handleWorkflowApi(req, res, url, deps)) return;
      jsonRes(res, 404, { error: 'not_found' });
    } catch (err) {
      jsonRes(res, 500, { error: String(err) });
    }
  });
}

async function startDaemonIpcServer(): Promise<{
  server: Server;
  baseUrl: string;
}> {
  return startServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      const m = url.pathname.match(/^\/api\/workflows\/runs\/([^/]+)\/cancel$/);
      if (req.method !== 'POST' || !m) {
        jsonRes(res, 404, { ok: false, error: 'not_found' });
        return;
      }

      let body: { reason?: unknown };
      try {
        body = await readJsonBody(req);
      } catch {
        jsonRes(res, 400, { ok: false, error: 'bad_json' });
        return;
      }
      daemonRequests.push({ path: url.pathname, body });

      const runId = decodeURIComponent(m[1]!);
      const ctx = daemonContexts.get(runId);
      if (!ctx) {
        jsonRes(res, 409, { ok: false, error: 'workflow_not_attached' });
        return;
      }
      const reason =
        typeof body.reason === 'string' && body.reason.trim()
          ? body.reason.trim()
          : 'cancelled via dashboard';
      const result = await cancelWorkflowRun({
        ctx,
        reason,
        by: 'dashboard',
        actor: 'human',
        maxTicks: 50,
      });
      jsonRes(res, 200, {
        ok: true,
        runId,
        status: result.snapshot.run.status,
        alreadyTerminal: result.alreadyTerminal,
        cancelAlreadyRequested: result.cancelAlreadyRequested,
        cancelEventId: result.cancelEventId,
        loopReason: result.loopResult?.reason,
        lastSeq: result.snapshot.lastSeq,
      });
    } catch (err) {
      jsonRes(res, 500, { ok: false, error: String(err) });
    }
  });
}

async function startServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer((req, res) => {
    void handler(req, res);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address();
  if (!addr || typeof addr !== 'object') throw new Error('server did not bind');
  return { server, baseUrl: `http://127.0.0.1:${addr.port}` };
}

async function closeServer(server: Server | null): Promise<void> {
  await new Promise<void>((resolve) => {
    if (!server) return resolve();
    server.close(() => resolve());
  });
}

async function readJsonBody<T = unknown>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (chunks.length === 0) return {} as T;
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function seedOwnedWaitingRun(
  runId: string,
  chatBinding: { chatId: string; larkAppId: string },
): Promise<{ log: EventLog; ctx: WorkflowRuntimeContext }> {
  const log = new EventLog(runId, runsDir);
  await createRun(log, {
    def: WAIT_DEF,
    params: {},
    initiator: 'test',
    botResolver: () => ({}),
    chatBinding,
  });
  const ctx: WorkflowRuntimeContext = {
    log,
    def: WAIT_DEF,
    spawnSubagent: unusedSpawn,
  };
  await runLoop(ctx);
  daemonContexts.set(runId, ctx);
  return { log, ctx };
}

const unusedSpawn: WorkerSpawnFn = async () => {
  throw new Error('spawn should not be reached for before humanGate');
};
