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
import { requestCancel } from '../src/workflows/cancel.js';
import { resolveWait } from '../src/workflows/wait.js';
import { triggerWorkflowRun } from '../src/workflows/trigger-run.js';
import type { RawParamInput } from '../src/workflows/params.js';
import { parseWorkflowDefinition } from '../src/workflows/definition.js';
import { EventLog } from '../src/workflows/events/append.js';
import type { WorkflowEvent } from '../src/workflows/events/schema.js';
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

const DONE_DEF = parseWorkflowDefinition({
  workflowId: 'ipc-done',
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
let dashboardServer: Server | null;
let daemonServer: Server | null;
let dashboardBaseUrl: string;
let daemonBaseUrl: string;
let daemonContexts: Map<string, { ctx: WorkflowRuntimeContext; running?: boolean }>;
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
    expect(findEvent(events, 'cancelRequested')?.payload).toMatchObject({
      reason: 'operator stop',
      by: 'dashboard',
    });
  });

  it('short-circuits terminal owned runs before daemon IPC', async () => {
    const { log } = await seedOwnedSucceededRun('ipc-terminal-01', {
      chatId: 'oc_owner',
      larkAppId: 'cli_owner',
    });
    const before = await log.readAll();

    const res = await fetch(`${dashboardBaseUrl}/api/workflows/runs/ipc-terminal-01/cancel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'too late' }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      runId: 'ipc-terminal-01',
      status: 'succeeded',
      alreadyTerminal: true,
    });
    expect(daemonRequests).toEqual([]);
    expect(await log.readAll()).toEqual(before);
  });

  it('proxies dashboard approve to daemon IPC and writes resolveWait events', async () => {
    const { log } = await seedOwnedWaitingRun('ipc-approve-01', {
      chatId: 'oc_owner',
      larkAppId: 'cli_owner',
    });

    const res = await fetch(`${dashboardBaseUrl}/api/workflows/runs/ipc-approve-01/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ comment: 'lgtm' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      runId: string;
      resolution: string;
      activityId: string;
      attemptId: string;
    };
    expect(body.ok).toBe(true);
    expect(body.runId).toBe('ipc-approve-01');
    expect(body.resolution).toBe('approved');
    expect(body.activityId).toBeTruthy();
    expect(body.attemptId).toBeTruthy();

    expect(daemonRequests).toEqual([
      {
        path: '/api/workflows/runs/ipc-approve-01/approve',
        body: { comment: 'lgtm' },
      },
    ]);

    const events = await log.readAll();
    expect(events.map((e) => e.type)).toEqual([
      'runCreated',
      'runStarted',
      'attemptCreated',
      'waitCreated',
      'waitResolved',
      'activitySucceeded',
    ]);
    expect(findEvent(events, 'waitResolved')?.payload).toMatchObject({
      resolution: 'approved',
      by: 'dashboard',
      comment: 'lgtm',
    });
  });

  it('proxies dashboard reject to daemon IPC and writes failure terminal', async () => {
    const { log } = await seedOwnedWaitingRun('ipc-reject-01', {
      chatId: 'oc_owner',
      larkAppId: 'cli_owner',
    });

    const res = await fetch(`${dashboardBaseUrl}/api/workflows/runs/ipc-reject-01/reject`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ comment: 'nope' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { resolution: string };
    expect(body.resolution).toBe('rejected');

    const events = await log.readAll();
    expect(events.map((e) => e.type)).toEqual([
      'runCreated',
      'runStarted',
      'attemptCreated',
      'waitCreated',
      'waitResolved',
      'activityFailed',
    ]);
    expect(findEvent(events, 'waitResolved')?.payload).toMatchObject({
      resolution: 'rejected',
      by: 'dashboard',
      comment: 'nope',
    });
  });

  it('proxies dashboard catalog trigger to daemon IPC and writes runCreated', async () => {
    const res = await fetch(`${dashboardBaseUrl}/api/workflows/definitions/${WAIT_DEF.workflowId}/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        params: {},
        chatBinding: { chatId: 'oc_owner', larkAppId: 'cli_owner' },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      runId: string;
      workflowId: string;
      status: string;
    };
    expect(body.ok).toBe(true);
    expect(body.runId).toBe('ipc-trigger:test-run');
    expect(body.workflowId).toBe(WAIT_DEF.workflowId);
    expect(body.status).toBe('running');

    expect(daemonRequests).toEqual([
      {
        path: `/api/workflows/definitions/${WAIT_DEF.workflowId}/run`,
        body: {
          params: {},
          chatBinding: { chatId: 'oc_owner', larkAppId: 'cli_owner' },
        },
      },
    ]);

    const log = new EventLog(body.runId, runsDir);
    const events = await log.readAll();
    expect(events.map((e) => e.type)).toEqual(['runCreated', 'runStarted']);
  });

  it('surfaces daemon unknown_workflow as 404 on trigger', async () => {
    const res = await fetch(`${dashboardBaseUrl}/api/workflows/definitions/nope-missing/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        params: {},
        chatBinding: { chatId: 'oc_owner', larkAppId: 'cli_owner' },
      }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body).toMatchObject({ ok: false, error: 'unknown_workflow' });
  });

  it('passes daemon pending cancel responses through without draining the run', async () => {
    const { log } = await seedOwnedWaitingRun(
      'ipc-running-01',
      {
        chatId: 'oc_owner',
        larkAppId: 'cli_owner',
      },
      { running: true },
    );

    const res = await fetch(`${dashboardBaseUrl}/api/workflows/runs/ipc-running-01/cancel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'wait for worker' }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      runId: 'ipc-running-01',
      status: 'running',
      alreadyTerminal: false,
      pending: true,
      loopReason: 'already-running',
    });

    const events = await log.readAll();
    expect(events.map((e) => e.type)).toEqual([
      'runCreated',
      'runStarted',
      'attemptCreated',
      'waitCreated',
      'cancelRequested',
    ]);
    expect(findEvent(events, 'cancelRequested')?.payload).toMatchObject({
      reason: 'wait for worker',
      by: 'dashboard',
    });
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
      if (req.method !== 'POST') {
        jsonRes(res, 404, { ok: false, error: 'not_found' });
        return;
      }
      const triggerMatch = url.pathname.match(
        /^\/api\/workflows\/definitions\/([^/]+)\/run$/,
      );
      if (triggerMatch) {
        await handleTrigger(req, res, url, triggerMatch);
        return;
      }
      const approveMatch = url.pathname.match(
        /^\/api\/workflows\/runs\/([^/]+)\/(approve|reject)$/,
      );
      if (approveMatch) {
        await handleApproveReject(req, res, url, approveMatch);
        return;
      }
      const m = url.pathname.match(/^\/api\/workflows\/runs\/([^/]+)\/cancel$/);
      if (!m) {
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
      const entry = daemonContexts.get(runId);
      if (!entry) {
        jsonRes(res, 409, { ok: false, error: 'workflow_not_attached' });
        return;
      }
      const reason =
        typeof body.reason === 'string' && body.reason.trim()
          ? body.reason.trim()
          : 'cancelled via dashboard';
      if (entry.running) {
        const snapshot = replay(await entry.ctx.log.readAll());
        let cancelEventId = snapshot.cancelledRunIntent?.cancelOriginEventId;
        if (!cancelEventId) {
          const cancel = await requestCancel(
            entry.ctx.log,
            {
              target: { kind: 'run', runId },
              reason,
              by: 'dashboard',
            },
            'human',
          );
          cancelEventId = cancel.eventId;
        }
        const after = replay(await entry.ctx.log.readAll());
        jsonRes(res, 200, {
          ok: true,
          runId,
          status: after.run.status,
          alreadyTerminal: false,
          cancelEventId,
          loopReason: 'already-running',
          pending: true,
          lastSeq: after.lastSeq,
        });
        return;
      }

      const result = await cancelWorkflowRun({
        ctx: entry.ctx,
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

async function handleTrigger(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  match: RegExpMatchArray,
): Promise<void> {
  let body: { params?: unknown; chatBinding?: unknown };
  try {
    body = await readJsonBody(req);
  } catch {
    jsonRes(res, 400, { ok: false, error: 'bad_json' });
    return;
  }
  daemonRequests.push({ path: url.pathname, body });
  const workflowId = decodeURIComponent(match[1]!);
  // Fake daemon trigger: drive triggerWorkflowRun with a known def so the
  // dashboard ↔ daemon proxy can be exercised end-to-end without booting the
  // real daemon.
  const triggerResult = await triggerWorkflowRun(
    {
      workflowId,
      rawParams: rawParamsFromBody(body.params),
      chatBinding: body.chatBinding as { chatId: string; larkAppId: string },
      initiator: 'dashboard',
    },
    {
      spawnSubagent: unusedSpawn,
      botResolver: () => ({}),
      makeRuntimeContext: (log, def, spawn) => ({ log, def, spawnSubagent: spawn }),
      attachRuntime: () => ({}),
      driveRun: () => { /* fire-and-forget; tests don't need a real loop */ },
      loadWorkflowDefinition: async (id) =>
        id === WAIT_DEF.workflowId
          ? WAIT_DEF
          : (() => {
              throw new Error(`Workflow '${id}' not found. Looked in:\n- /nope`);
            })(),
      makeRunId: () => 'ipc-trigger:test-run',
      makeEventLog: (runId) => new EventLog(runId, runsDir),
    },
  );
  if (!triggerResult.ok) {
    const status =
      triggerResult.error === 'unknown_workflow' ? 404 :
        triggerResult.error === 'invalid_params' ? 400 : 500;
    jsonRes(res, status, triggerResult);
    return;
  }
  jsonRes(res, 200, triggerResult);
}

function rawParamsFromBody(raw: unknown): Record<string, RawParamInput> {
  const out: Record<string, RawParamInput> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    out[k] = { kind: 'json', value: v };
  }
  return out;
}

async function handleApproveReject(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  match: RegExpMatchArray,
): Promise<void> {
  let body: { comment?: unknown };
  try {
    body = await readJsonBody(req);
  } catch {
    jsonRes(res, 400, { ok: false, error: 'bad_json' });
    return;
  }
  daemonRequests.push({ path: url.pathname, body });

  const runId = decodeURIComponent(match[1]!);
  const resolution: 'approved' | 'rejected' =
    match[2] === 'approve' ? 'approved' : 'rejected';
  const comment =
    typeof body.comment === 'string' && body.comment.trim()
      ? body.comment.trim()
      : undefined;

  const entry = daemonContexts.get(runId);
  if (!entry) {
    jsonRes(res, 409, { ok: false, error: 'workflow_not_attached' });
    return;
  }

  const events = await entry.ctx.log.readAll();
  // Pick the unique dangling human-gate wait — mirrors daemon's
  // `resolveDashboardWait` selection rule.
  const snap = replay(events);
  const candidates: Array<{ activityId: string; attemptId: string }> = [];
  for (const activityId of snap.danglingWaits) {
    const activity = snap.activities.get(activityId);
    const at = activity?.attempts[activity.attempts.length - 1];
    if (!at?.wait || at.wait.waitKind !== 'human-gate') continue;
    candidates.push({ activityId, attemptId: at.attemptId });
  }
  if (candidates.length === 0) {
    jsonRes(res, 409, { ok: false, error: 'no_open_wait' });
    return;
  }
  if (candidates.length > 1) {
    jsonRes(res, 409, { ok: false, error: 'ambiguous_wait' });
    return;
  }
  const target = candidates[0]!;
  const resolved = await resolveWait(entry.ctx.log, {
    activityId: target.activityId,
    attemptId: target.attemptId,
    resolution,
    by: 'dashboard',
    comment,
  });
  const after = replay(await entry.ctx.log.readAll());
  jsonRes(res, 200, {
    ok: true,
    runId,
    resolution,
    activityId: target.activityId,
    attemptId: target.attemptId,
    resolvedAt: resolved.resolutionEvent.timestamp,
    lastSeq: after.lastSeq,
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
  opts: { running?: boolean } = {},
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
  daemonContexts.set(runId, { ctx, running: opts.running });
  return { log, ctx };
}

async function seedOwnedSucceededRun(
  runId: string,
  chatBinding: { chatId: string; larkAppId: string },
): Promise<{ log: EventLog; ctx: WorkflowRuntimeContext }> {
  const log = new EventLog(runId, runsDir);
  await createRun(log, {
    def: DONE_DEF,
    params: {},
    initiator: 'test',
    botResolver: () => ({}),
    chatBinding,
  });
  const ctx: WorkflowRuntimeContext = {
    log,
    def: DONE_DEF,
    spawnSubagent: async () => ({ kind: 'success', output: { ok: true } }),
  };
  await runLoop(ctx);
  return { log, ctx };
}

function findEvent<T extends WorkflowEvent['type']>(
  events: WorkflowEvent[],
  type: T,
): Extract<WorkflowEvent, { type: T }> | undefined {
  return events.find((e): e is Extract<WorkflowEvent, { type: T }> => e.type === type);
}

const unusedSpawn: WorkerSpawnFn = async () => {
  throw new Error('spawn should not be reached for before humanGate');
};
