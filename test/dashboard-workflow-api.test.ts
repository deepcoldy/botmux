import { createServer, type Server } from 'node:http';
import {
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  handleWorkflowApi,
  jsonRes,
  type WorkflowApiDeps,
} from '../src/dashboard/workflow-api.js';
import { EventLog } from '../src/workflows/events/append.js';
import { parseWorkflowDefinition, type WorkflowDefinition } from '../src/workflows/definition.js';
import { createRun } from '../src/workflows/run-init.js';
import { runLoop } from '../src/workflows/loop.js';
import type { WorkerSpawnFn } from '../src/workflows/runtime.js';

const WAIT_DEF = parseWorkflowDefinition({
  workflowId: 'dash-wait',
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

const DONE_DEF = parseWorkflowDefinition({
  workflowId: 'dash-done',
  version: 1,
  nodes: {
    done: {
      type: 'subagent',
      bot: 'bot-a',
      prompt: 'finish',
    },
  },
});

let tempDir: string;
let runsDir: string;
let server: Server | null;
let baseUrl: string;
let proxyToDaemon: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'wf-dashboard-api-'));
  runsDir = join(tempDir, 'runs');
  proxyToDaemon = vi.fn(async () =>
    new Response(JSON.stringify({ ok: true, pending: true }), {
      status: 202,
      headers: { 'content-type': 'application/json' },
    }),
  );
  const started = await startWorkflowApiServer({
    runsDir,
    proxyToDaemon,
  });
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

describe('dashboard workflow API routes', () => {
  it('serves list, snapshot, and event windows from runsDir', async () => {
    await seedWaitingRun('api-wait-01', WAIT_DEF);

    const listRes = await fetch(`${baseUrl}/api/workflows/runs`);
    expect(listRes.status).toBe(200);
    const listBody = await listRes.json() as { runs: Array<{ runId: string; status: string; dWait: number }> };
    expect(listBody.runs).toEqual([
      expect.objectContaining({ runId: 'api-wait-01', status: 'running', dWait: 1 }),
    ]);

    const snapRes = await fetch(`${baseUrl}/api/workflows/runs/api-wait-01/snapshot`);
    expect(snapRes.status).toBe(200);
    const snap = await snapRes.json() as { run: { workflowId: string; status: string }; dangling: { waits: string[] } };
    expect(snap.run).toMatchObject({ workflowId: 'dash-wait', status: 'running' });
    expect(snap.dangling.waits).toHaveLength(1);

    const eventsRes = await fetch(`${baseUrl}/api/workflows/runs/api-wait-01/events?tail=2`);
    expect(eventsRes.status).toBe(200);
    const events = await eventsRes.json() as { events: Array<{ type: string }>; totalCount: number };
    expect(events.totalCount).toBeGreaterThanOrEqual(4);
    expect(events.events.map((e) => e.type)).toContain('waitCreated');
  });

  it('filters list by comma-separated statuses', async () => {
    await seedWaitingRun('api-running-01', WAIT_DEF);
    await seedSucceededRun('api-succeeded-01', DONE_DEF);

    const res = await fetch(`${baseUrl}/api/workflows/runs?status=running,failed`);
    expect(res.status).toBe(200);
    const body = await res.json() as { runs: Array<{ runId: string; status: string }> };
    expect(body.runs).toEqual([
      expect.objectContaining({ runId: 'api-running-01', status: 'running' }),
    ]);
  });

  it('short-circuits cancel for terminal runs without proxying to daemon', async () => {
    await seedSucceededRun('api-done-01', DONE_DEF);

    const res = await fetch(`${baseUrl}/api/workflows/runs/api-done-01/cancel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'stop' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; alreadyTerminal: boolean; status: string };
    expect(body).toMatchObject({ ok: true, alreadyTerminal: true, status: 'succeeded' });
    expect(proxyToDaemon).not.toHaveBeenCalled();
  });

  it('rejects invalid cancel runId before touching disk or proxying', async () => {
    const res = await fetch(`${baseUrl}/api/workflows/runs/..%2Fescape/cancel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'stop' }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: 'bad_run_id' });
    expect(proxyToDaemon).not.toHaveBeenCalled();
  });

  it('returns unknown_run for missing runDir on cancel', async () => {
    const res = await fetch(`${baseUrl}/api/workflows/runs/missing-run/cancel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'stop' }),
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ ok: false, error: 'unknown_run' });
    expect(proxyToDaemon).not.toHaveBeenCalled();
  });

  it('rejects malformed cancel JSON before reading run state', async () => {
    const res = await fetch(`${baseUrl}/api/workflows/runs/api-wait-01/cancel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{bad json',
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: 'bad_json' });
    expect(proxyToDaemon).not.toHaveBeenCalled();
  });

  it('returns needs_cli_cancel when a non-terminal run has no chat-binding owner', async () => {
    await seedWaitingRun('api-cli-only-01', WAIT_DEF);

    const res = await fetch(`${baseUrl}/api/workflows/runs/api-cli-only-01/cancel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'stop' }),
    });
    expect(res.status).toBe(409);
    const body = await res.json() as { ok: boolean; error: string; hint: string };
    expect(body.ok).toBe(false);
    expect(body.error).toBe('needs_cli_cancel');
    expect(body.hint).toContain('botmux workflow cancel api-cli-only-01');
    expect(proxyToDaemon).not.toHaveBeenCalled();
  });

  it('proxies cancel to the owner daemon from chat-binding', async () => {
    await seedWaitingRun('api-owned-01', WAIT_DEF, {
      chatId: 'oc_owner_chat',
      larkAppId: 'cli_owner',
    });

    const res = await fetch(`${baseUrl}/api/workflows/runs/api-owned-01/cancel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'operator stop' }),
    });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true, pending: true });
    expect(proxyToDaemon).toHaveBeenCalledWith(
      'cli_owner',
      '/api/workflows/runs/api-owned-01/cancel',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ reason: 'operator stop' }),
      }),
    );
  });
});

async function startWorkflowApiServer(deps: WorkflowApiDeps): Promise<{
  server: Server;
  baseUrl: string;
}> {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      if (await handleWorkflowApi(req, res, url, deps)) return;
      jsonRes(res, 404, { error: 'not_found' });
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

async function seedWaitingRun(
  runId: string,
  def: WorkflowDefinition,
  chatBinding?: { chatId: string; larkAppId: string },
): Promise<void> {
  const log = new EventLog(runId, runsDir);
  await createRun(log, {
    def,
    params: {},
    initiator: 'test',
    botResolver: () => ({}),
    chatBinding,
  });
  await runLoop({
    log,
    def,
    spawnSubagent: unusedSpawn,
  });
}

async function seedSucceededRun(runId: string, def: WorkflowDefinition): Promise<void> {
  const log = new EventLog(runId, runsDir);
  await createRun(log, {
    def,
    params: {},
    initiator: 'test',
    botResolver: () => ({}),
  });
  await runLoop({
    log,
    def,
    spawnSubagent: async () => ({ kind: 'success', output: { ok: true } }),
  });
}

const unusedSpawn: WorkerSpawnFn = async () => {
  throw new Error('spawn should not be reached for before humanGate');
};
