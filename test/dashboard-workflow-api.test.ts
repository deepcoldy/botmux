import { createServer, type Server } from 'node:http';
import {
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  handleWorkflowApi,
  jsonRes,
  type WorkflowApiDeps,
} from '../src/dashboard/workflow-api.js';
import { EventLog } from '../src/workflows/events/append.js';
import {
  computeRevisionId,
  parseWorkflowDefinition,
  type WorkflowDefinition,
} from '../src/workflows/definition.js';
import { createRun } from '../src/workflows/run-init.js';
import { runLoop } from '../src/workflows/loop.js';
import type { WorkerSpawnFn } from '../src/workflows/runtime.js';
import type { CatalogEntry } from '../src/workflows/catalog.js';

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
let catalogEntries: CatalogEntry[];
let catalogDefs: Map<string, { definition: WorkflowDefinition; revisionId: string; path: string }>;

beforeEach(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'wf-dashboard-api-'));
  runsDir = join(tempDir, 'runs');
  proxyToDaemon = vi.fn(async () =>
    new Response(JSON.stringify({ ok: true, pending: true }), {
      status: 202,
      headers: { 'content-type': 'application/json' },
    }),
  );
  catalogEntries = [];
  catalogDefs = new Map();
  const started = await startWorkflowApiServer({
    runsDir,
    proxyToDaemon,
    listWorkflowDefinitions: async () => catalogEntries,
    loadCatalogDefinition: async (id) => catalogDefs.get(id),
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

  it('GET /snapshot strips io.log.text for unauth\'d callers but keeps it for auth\'d', async () => {
    // Seed a succeeded run with a terminal.log carrying a fake secret.
    await seedSucceededRun('api-secret-01', DONE_DEF);
    // The runtime helpers in this test seed the events but don't actually
    // write per-attempt terminal.log files — synthesize one so the
    // projection has bytes to scrub.
    const snapPeek = await fetch(`${baseUrl}/api/workflows/runs/api-secret-01/snapshot`, {
      headers: { 'x-test-authed': '1' },
    });
    const snapPeekBody = await snapPeek.json() as {
      attemptIO: Record<string, { input?: unknown }>;
    };
    const attemptId = Object.keys(snapPeekBody.attemptIO)[0];
    expect(attemptId).toBeTruthy();
    // attemptId format: <runId>::work::<node>::att-N → strip the att-N suffix
    // to recover the parent activityId for the on-disk attempts directory.
    const activityId = attemptId.split('::att-')[0];
    const attemptDir = join(
      runsDir,
      'api-secret-01',
      'attempts',
      activityId,
      attemptId,
    );
    await mkdir(attemptDir, { recursive: true });
    await writeFile(
      join(attemptDir, 'terminal.log'),
      '[ts] stderr LEAKED_TOKEN=sk-fake-must-not-leak\n',
    );
    await writeFile(
      join(attemptDir, 'terminal.json'),
      JSON.stringify({
        schemaVersion: 1,
        sessionId: 'wf-api-secret',
        webPort: 32999,
        status: 'closed',
        cliId: 'claude-code',
        logPath: join(attemptDir, 'terminal.log'),
        startedAt: 1,
        updatedAt: 2,
      }),
    );

    // Unauthenticated public read — log bytes must be stripped, metadata kept.
    const unauthRes = await fetch(
      `${baseUrl}/api/workflows/runs/api-secret-01/snapshot`,
    );
    expect(unauthRes.status).toBe(200);
    const unauth = await unauthRes.json() as {
      attemptIO: Record<string, {
        log?: { text?: string; redacted?: boolean; outputBytes?: number };
        terminal?: { logPath?: string; sessionId?: string; webPort?: number };
      }>;
    };
    const unauthIO = unauth.attemptIO[attemptId];
    expect(unauthIO?.log?.text).toBeUndefined();
    expect(unauthIO?.log?.redacted).toBe(true);
    expect(unauthIO?.log?.outputBytes).toBeGreaterThan(0);
    expect(unauthIO?.terminal?.logPath).toBeUndefined();
    expect(unauthIO?.terminal?.sessionId).toBe('wf-api-secret');
    expect(unauthIO?.terminal?.webPort).toBe(32999);

    // Authenticated read still sees the full log + logPath — same data
    // a logged-in `botmux dashboard` user has always seen.
    const authRes = await fetch(
      `${baseUrl}/api/workflows/runs/api-secret-01/snapshot`,
      { headers: { 'x-test-authed': '1' } },
    );
    expect(authRes.status).toBe(200);
    const authed = await authRes.json() as {
      attemptIO: Record<string, {
        log?: { text?: string; redacted?: boolean };
        terminal?: { logPath?: string };
      }>;
    };
    const authedIO = authed.attemptIO[attemptId];
    expect(authedIO?.log?.text).toContain('LEAKED_TOKEN=sk-fake-must-not-leak');
    expect(authedIO?.log?.redacted).toBeUndefined();
    expect(authedIO?.terminal?.logPath).toBe(join(attemptDir, 'terminal.log'));
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

  // ─── approve / reject ────────────────────────────────────────────────────

  it('short-circuits approve for terminal runs without proxying to daemon', async () => {
    await seedSucceededRun('api-done-approve', DONE_DEF);
    const res = await fetch(`${baseUrl}/api/workflows/runs/api-done-approve/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ comment: 'looks good' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; alreadyTerminal: boolean };
    expect(body.ok).toBe(true);
    expect(body.alreadyTerminal).toBe(true);
    expect(proxyToDaemon).not.toHaveBeenCalled();
  });

  it('rejects invalid approve runId before touching disk or proxying', async () => {
    const res = await fetch(
      `${baseUrl}/api/workflows/runs/${encodeURIComponent('../boom')}/approve`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: 'bad_run_id' });
    expect(proxyToDaemon).not.toHaveBeenCalled();
  });

  it('returns unknown_run for missing runDir on approve / reject', async () => {
    for (const action of ['approve', 'reject'] as const) {
      const res = await fetch(`${baseUrl}/api/workflows/runs/no-such-run/${action}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ ok: false, error: 'unknown_run' });
    }
    expect(proxyToDaemon).not.toHaveBeenCalled();
  });

  it('rejects malformed approve JSON before reading run state', async () => {
    const res = await fetch(`${baseUrl}/api/workflows/runs/api-bad-json/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not-json',
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: 'bad_json' });
    expect(proxyToDaemon).not.toHaveBeenCalled();
  });

  it('returns needs_lark_or_cli when run has no chat-binding owner', async () => {
    await seedWaitingRun('api-no-owner-approve', WAIT_DEF);
    const res = await fetch(`${baseUrl}/api/workflows/runs/api-no-owner-approve/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { ok: boolean; error: string; hint: string };
    expect(body.ok).toBe(false);
    expect(body.error).toBe('needs_lark_or_cli');
    expect(body.hint).toMatch(/Lark/);
    expect(proxyToDaemon).not.toHaveBeenCalled();
  });

  it('proxies approve to the owner daemon from chat-binding', async () => {
    await seedWaitingRun('api-owned-approve', WAIT_DEF, {
      chatId: 'oc_owner_chat',
      larkAppId: 'cli_owner',
    });
    const res = await fetch(`${baseUrl}/api/workflows/runs/api-owned-approve/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ comment: 'lgtm' }),
    });
    expect(res.status).toBe(202);
    expect(proxyToDaemon).toHaveBeenCalledWith(
      'cli_owner',
      '/api/workflows/runs/api-owned-approve/approve',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ comment: 'lgtm' }),
      }),
    );
  });

  it('proxies reject to the owner daemon from chat-binding', async () => {
    await seedWaitingRun('api-owned-reject', WAIT_DEF, {
      chatId: 'oc_owner_chat',
      larkAppId: 'cli_owner',
    });
    const res = await fetch(`${baseUrl}/api/workflows/runs/api-owned-reject/reject`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ comment: 'nope' }),
    });
    expect(res.status).toBe(202);
    expect(proxyToDaemon).toHaveBeenCalledWith(
      'cli_owner',
      '/api/workflows/runs/api-owned-reject/reject',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ comment: 'nope' }),
      }),
    );
  });

  it('proxies attempt resume start/end to the owner daemon from chat-binding', async () => {
    await seedWaitingRun('api-owned-resume', WAIT_DEF, {
      chatId: 'oc_owner_chat',
      larkAppId: 'cli_owner',
    });
    const activityId = 'api-owned-resume::work::approve';
    const attemptId = 'api-owned-resume::work::approve::att-1';

    const start = await fetch(
      `${baseUrl}/api/workflows/runs/api-owned-resume/attempts/${encodeURIComponent(activityId)}/${encodeURIComponent(attemptId)}/resume`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
    );
    expect(start.status).toBe(202);
    expect(proxyToDaemon).toHaveBeenCalledWith(
      'cli_owner',
      `/api/workflows/runs/api-owned-resume/attempts/${encodeURIComponent(activityId)}/${encodeURIComponent(attemptId)}/resume`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ reason: undefined }),
      }),
    );

    const end = await fetch(
      `${baseUrl}/api/workflows/runs/api-owned-resume/attempts/${encodeURIComponent(activityId)}/${encodeURIComponent(attemptId)}/resume/end`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason: 'operator done' }),
      },
    );
    expect(end.status).toBe(202);
    expect(proxyToDaemon).toHaveBeenCalledWith(
      'cli_owner',
      `/api/workflows/runs/api-owned-resume/attempts/${encodeURIComponent(activityId)}/${encodeURIComponent(attemptId)}/resume/end`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ reason: 'operator done' }),
      }),
    );
  });

  // ─── Catalog: definitions list / detail / trigger ─────────────────────────

  it('lists workflow definitions via injected catalog dep', async () => {
    catalogEntries = [
      {
        workflowId: 'demo-a',
        version: 1,
        path: '/tmp/demo-a.workflow.json',
        revisionId: 'sha256:abc',
        paramCount: 2,
        requiredParamCount: 1,
        nodeCount: 3,
      },
    ];
    const res = await fetch(`${baseUrl}/api/workflows/definitions`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { definitions: CatalogEntry[] };
    expect(body.definitions).toEqual(catalogEntries);
  });

  it('returns load_definitions_failed when the catalog source throws', async () => {
    catalogEntries = [];
    server!.close();
    const started = await startWorkflowApiServer({
      runsDir,
      proxyToDaemon,
      listWorkflowDefinitions: async () => {
        throw new Error('disk gone');
      },
    });
    server = started.server;
    baseUrl = started.baseUrl;
    const res = await fetch(`${baseUrl}/api/workflows/definitions`);
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: 'list_definitions_failed' });
  });

  it('serves a single definition by id', async () => {
    const def = parseWorkflowDefinition({
      workflowId: 'detail-demo',
      version: 1,
      params: { name: { type: 'string', required: true } },
      nodes: { d: { type: 'subagent', bot: 'cli_x', prompt: 'p' } },
    });
    catalogDefs.set('detail-demo', {
      definition: def,
      revisionId: computeRevisionId(def),
      path: '/tmp/detail-demo.workflow.json',
    });
    const res = await fetch(`${baseUrl}/api/workflows/definitions/detail-demo`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { definition: WorkflowDefinition; revisionId: string; path: string };
    expect(body.definition).toMatchObject({ workflowId: 'detail-demo', version: 1 });
    expect(body.revisionId).toMatch(/^sha256:/);
    expect(body.path).toContain('detail-demo');
  });

  it('rejects bad_id on definition detail before touching catalog', async () => {
    const res = await fetch(`${baseUrl}/api/workflows/definitions/${encodeURIComponent('../escape')}`);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'bad_id' });
  });

  it('returns unknown_workflow when catalog returns undefined', async () => {
    const res = await fetch(`${baseUrl}/api/workflows/definitions/missing`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'unknown_workflow' });
  });

  it('proxies the trigger POST to the owning daemon', async () => {
    const res = await fetch(`${baseUrl}/api/workflows/definitions/demo/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        params: { name: 'alice' },
        chatBinding: { chatId: 'oc_chat', larkAppId: 'cli_owner' },
      }),
    });
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ ok: true });
    expect(proxyToDaemon).toHaveBeenCalledWith(
      'cli_owner',
      '/api/workflows/definitions/demo/run',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          params: { name: 'alice' },
          chatBinding: { chatId: 'oc_chat', larkAppId: 'cli_owner' },
        }),
      }),
    );
  });

  it('rejects trigger with missing chat binding before proxying', async () => {
    const res = await fetch(`${baseUrl}/api/workflows/definitions/demo/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ params: { name: 'alice' } }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; hint?: string };
    expect(body.error).toBe('missing_chat_binding');
    expect(body.hint).toMatch(/chatBinding/);
    expect(proxyToDaemon).not.toHaveBeenCalled();
  });

  it('rejects trigger with bad_id before proxying', async () => {
    const res = await fetch(
      `${baseUrl}/api/workflows/definitions/${encodeURIComponent('../boom')}/run`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          params: {},
          chatBinding: { chatId: 'oc_chat', larkAppId: 'cli_owner' },
        }),
      },
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: 'bad_id' });
    expect(proxyToDaemon).not.toHaveBeenCalled();
  });

  it('rejects trigger with bad params shape (non-object) before proxying', async () => {
    const res = await fetch(`${baseUrl}/api/workflows/definitions/demo/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        params: ['not', 'an', 'object'],
        chatBinding: { chatId: 'oc_chat', larkAppId: 'cli_owner' },
      }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: 'bad_params_shape' });
    expect(proxyToDaemon).not.toHaveBeenCalled();
  });

  it('rejects trigger with malformed JSON body before proxying', async () => {
    const res = await fetch(`${baseUrl}/api/workflows/definitions/demo/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not-json',
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: 'bad_json' });
    expect(proxyToDaemon).not.toHaveBeenCalled();
  });
});

describe('dashboard workflow API attempt terminal-log raw', () => {
  const runId = 'api-replay-01';
  const activityId = 'api-replay-01::work::draft';
  const attemptId = 'api-replay-01::work::draft::att-1';

  async function seedTerminalLog(body: Buffer | string): Promise<string> {
    const dir = join(runsDir, runId, 'attempts', activityId, attemptId);
    await mkdir(dir, { recursive: true });
    const logPath = join(dir, 'terminal.log');
    await writeFile(logPath, body);
    return logPath;
  }

  function rawUrl(query = ''): string {
    return (
      `${baseUrl}/api/workflows/runs/${encodeURIComponent(runId)}` +
      `/attempts/${encodeURIComponent(activityId)}` +
      `/${encodeURIComponent(attemptId)}/terminal-log/raw${query}`
    );
  }

  it('streams a small log fully with metadata headers', async () => {
    const payload = '\x1b[31mhello\x1b[0m world';
    await seedTerminalLog(payload);

    const res = await fetch(rawUrl());
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/plain/);
    expect(res.headers.get('x-botmux-log-bytes')).toBe(String(Buffer.byteLength(payload)));
    expect(res.headers.get('x-botmux-served-bytes')).toBe(String(Buffer.byteLength(payload)));
    expect(res.headers.get('x-botmux-truncated')).toBe('0');
    expect(await res.text()).toBe(payload);
  });

  it('tails the requested bytes and marks truncation', async () => {
    const tail = '##TAIL_MARKER##\n';
    const padding = Buffer.alloc(64, 0x61); // 64 bytes of 'a'
    await seedTerminalLog(Buffer.concat([padding, Buffer.from(tail)]));

    const res = await fetch(rawUrl(`?tailBytes=${tail.length}`));
    expect(res.status).toBe(200);
    expect(res.headers.get('x-botmux-log-bytes')).toBe(
      String(padding.length + tail.length),
    );
    expect(res.headers.get('x-botmux-served-bytes')).toBe(String(tail.length));
    expect(res.headers.get('x-botmux-truncated')).toBe('1');
    expect(await res.text()).toBe(tail);
  });

  it('returns attachment headers when ?download=1', async () => {
    await seedTerminalLog('payload');
    const res = await fetch(rawUrl('?download=1'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    const disp = res.headers.get('content-disposition');
    expect(disp).toContain('attachment;');
    expect(disp).toContain('terminal-');
    expect(disp).toContain(runId);
  });

  it('returns 404 when terminal.log is missing', async () => {
    const res = await fetch(rawUrl());
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'no_terminal_log' });
  });

  it('rejects malformed activityId that fails the segment regex', async () => {
    // `*` is outside `[A-Za-z0-9._:-]` so isValidPathSegment rejects it.
    // (Direct `..` doesn't reach the handler — fetch/URL normalize it away,
    // which is why the segment regex + isPathInsideDir is defense-in-depth
    // rather than the primary guard.)
    const badActivity = encodeURIComponent('with*star');
    const url =
      `${baseUrl}/api/workflows/runs/${encodeURIComponent(runId)}` +
      `/attempts/${badActivity}` +
      `/${encodeURIComponent(attemptId)}/terminal-log/raw`;
    const res = await fetch(url);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'bad_id' });
  });

  it('rejects invalid runId before touching disk', async () => {
    const url =
      `${baseUrl}/api/workflows/runs/${encodeURIComponent('..bad')}` +
      `/attempts/${encodeURIComponent(activityId)}` +
      `/${encodeURIComponent(attemptId)}/terminal-log/raw`;
    const res = await fetch(url);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'bad_id' });
  });

  it('?stream=pty serves the raw pty.log payload', async () => {
    const dir = join(runsDir, runId, 'attempts', activityId, attemptId);
    await mkdir(dir, { recursive: true });
    // Seed a terminal.log with placeholder text and a distinct pty.log so a
    // pass-through bug (still reading terminal.log under ?stream=pty) is
    // caught by the body comparison rather than passing trivially.
    await writeFile(join(dir, 'terminal.log'), 'diag-payload');
    const ptyPayload = '\x1b[32mPTY\x1b[0m';
    await writeFile(join(dir, 'pty.log'), ptyPayload);
    const res = await fetch(rawUrl('?stream=pty'));
    expect(res.status).toBe(200);
    expect(res.headers.get('x-botmux-log-bytes')).toBe(String(Buffer.byteLength(ptyPayload)));
    expect(await res.text()).toBe(ptyPayload);
  });

  it('?stream=pty 404s when pty.log is absent (older attempt)', async () => {
    // Only terminal.log on disk — the diag fallback is the client's job, the
    // endpoint must report missing pty.log honestly so the UI can disable
    // the terminal toggle.
    await seedTerminalLog('only-diag');
    const res = await fetch(rawUrl('?stream=pty'));
    expect(res.status).toBe(404);
  });

  it('omitted ?stream= keeps the legacy terminal.log behavior', async () => {
    const dir = join(runsDir, runId, 'attempts', activityId, attemptId);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'terminal.log'), 'diag-only');
    await writeFile(join(dir, 'pty.log'), 'pty-only');
    // No stream= param → must serve terminal.log (back-compat with older
    // dashboard bundles that don't know about ?stream=).
    const res = await fetch(rawUrl());
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('diag-only');
  });
});

async function startWorkflowApiServer(deps: WorkflowApiDeps): Promise<{
  server: Server;
  baseUrl: string;
}> {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      // Test seam: `x-test-authed: 1` request header simulates a logged-in
      // dashboard session for tests that want to verify the auth-gated
      // branch (e.g. snapshot scrub).  Default (no header) mirrors a
      // public-read request that came in via the `decideDashboardAuth`
      // carve-out — same auth posture as a Lark card recipient.
      const isAuthed = req.headers['x-test-authed'] === '1';
      if (await handleWorkflowApi(req, res, url, deps, isAuthed)) return;
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
