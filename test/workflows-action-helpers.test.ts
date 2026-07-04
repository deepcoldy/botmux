import { describe, expect, it, vi } from 'vitest';

import {
  getRunSnapshot,
  listWorkflowRuns,
  runApproveReject,
  runCancel,
  type RunSnapshotLike,
  type WorkflowsActionDeps,
} from '../src/dashboard/workflows-action-helpers.js';

function makeRes(status: number, body: unknown, opts: { textOverride?: string } = {}): Response {
  const text = opts.textOverride ?? JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
    json: async () => body,
  } as unknown as Response;
}

function snapshot(over: Partial<RunSnapshotLike> = {}): RunSnapshotLike {
  return {
    run: { status: 'running' },
    chatBinding: { chatId: 'oc_demo', larkAppId: 'cli_owner' },
    updatedAt: 1_700_000_000_000,
    lastSeq: 42,
    extra: 'preserved-through-scrub',
    ...over,
  };
}

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);

function makeDeps(over: Partial<WorkflowsActionDeps> = {}): WorkflowsActionDeps {
  return {
    runsDir: '/tmp/runs-test',
    proxyToDaemon: vi.fn(async () => makeRes(200, { ok: true })),
    listRuns: vi.fn(async () => [{ runId: 'r1' }, { runId: 'r2' }]),
    readRunSnapshot: vi.fn(async () => snapshot()),
    scrubSnapshotForUnauthed: vi.fn((snap) => ({ ...snap, scrubbed: true })),
    TERMINAL_RUN_STATUSES: TERMINAL,
    isValidRunId: vi.fn(() => true),
    ...over,
  };
}

describe('listWorkflowRuns', () => {
  it('returns 200 with rows from listRuns', async () => {
    const deps = makeDeps();
    const r = await listWorkflowRuns({ all: true }, deps);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ runs: [{ runId: 'r1' }, { runId: 'r2' }] });
    expect(deps.listRuns).toHaveBeenCalledWith('/tmp/runs-test', { all: true, statuses: undefined, includeBinding: true });
  });

  it('passes status filter through', async () => {
    const deps = makeDeps();
    const statuses = new Set(['running', 'waiting']);
    await listWorkflowRuns({ statuses }, deps);
    expect(deps.listRuns).toHaveBeenCalledWith('/tmp/runs-test', { all: false, statuses, includeBinding: true });
  });

  it('returns 500 listRuns_failed on underlying error', async () => {
    const deps = makeDeps({ listRuns: vi.fn(async () => { throw new Error('boom'); }) });
    const r = await listWorkflowRuns({}, deps);
    expect(r.status).toBe(500);
    expect(r.body).toEqual({ error: 'listRuns_failed', message: 'boom' });
  });
});

describe('getRunSnapshot (unauth scrub)', () => {
  it('authed=true returns full snapshot untouched', async () => {
    const snap = snapshot();
    const deps = makeDeps({ readRunSnapshot: vi.fn(async () => snap) });
    const r = await getRunSnapshot('r1', true, deps);
    expect(r.status).toBe(200);
    expect(r.body).toBe(snap);
    expect(deps.scrubSnapshotForUnauthed).not.toHaveBeenCalled();
  });

  it('authed=false routes through scrubSnapshotForUnauthed', async () => {
    const deps = makeDeps();
    const r = await getRunSnapshot('r1', false, deps);
    expect(r.status).toBe(200);
    expect((r.body as any).scrubbed).toBe(true);
    expect(deps.scrubSnapshotForUnauthed).toHaveBeenCalledOnce();
  });

  it('returns 404 unknown_run when snapshot missing', async () => {
    const deps = makeDeps({ readRunSnapshot: vi.fn(async () => null) });
    const r = await getRunSnapshot('missing', true, deps);
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: 'unknown_run' });
  });
});

describe('runApproveReject', () => {
  it('proxies to owner daemon and echoes upstream response', async () => {
    const proxySpy = vi.fn(async () => makeRes(200, { ok: true, resolved: true }));
    const deps = makeDeps({ proxyToDaemon: proxySpy });
    const r = await runApproveReject('r1', 'approve', '{"comment":"lgtm"}', deps);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, resolved: true });
    const call = proxySpy.mock.calls[0]!;
    expect(call[0]).toBe('cli_owner');
    expect(call[1]).toBe('/api/workflows/runs/r1/approve');
    const init = call[2] as RequestInit;
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ comment: 'lgtm' });
  });

  it('returns 400 bad_run_id when isValidRunId rejects', async () => {
    const deps = makeDeps({ isValidRunId: vi.fn(() => false) });
    const r = await runApproveReject('../bad', 'approve', '{}', deps);
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ ok: false, error: 'bad_run_id' });
  });

  it('returns 400 bad_json on malformed body', async () => {
    const deps = makeDeps();
    const r = await runApproveReject('r1', 'approve', '{not-json', deps);
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ ok: false, error: 'bad_json' });
  });

  it('returns 404 unknown_run when snapshot missing', async () => {
    const deps = makeDeps({ readRunSnapshot: vi.fn(async () => null) });
    const r = await runApproveReject('r1', 'reject', '{}', deps);
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ ok: false, error: 'unknown_run' });
  });

  it('returns 200 alreadyTerminal for terminal runs (no proxy call)', async () => {
    const proxySpy = vi.fn();
    const deps = makeDeps({
      readRunSnapshot: vi.fn(async () => snapshot({ run: { status: 'succeeded' } })),
      proxyToDaemon: proxySpy as any,
    });
    const r = await runApproveReject('r1', 'approve', '{}', deps);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      ok: true,
      runId: 'r1',
      resolution: 'approved',
      activityId: '',
      attemptId: '',
      resolvedAt: 1_700_000_000_000,
      lastSeq: 42,
      alreadyTerminal: true,
    });
    expect(proxySpy).not.toHaveBeenCalled();
  });

  it('reject action returns "rejected" resolution in alreadyTerminal branch', async () => {
    const deps = makeDeps({
      readRunSnapshot: vi.fn(async () => snapshot({ run: { status: 'failed' } })),
    });
    const r = await runApproveReject('r1', 'reject', '{}', deps);
    expect((r.body as any).resolution).toBe('rejected');
  });

  it('returns 409 needs_lark_or_cli when run has no chat-binding owner', async () => {
    const deps = makeDeps({
      readRunSnapshot: vi.fn(async () => snapshot({ chatBinding: undefined })),
    });
    const r = await runApproveReject('r1', 'approve', '{}', deps);
    expect(r.status).toBe(409);
    const body = r.body as any;
    expect(body.ok).toBe(false);
    expect(body.error).toBe('needs_lark_or_cli');
    expect(body.hint).toContain('chat-binding owner');
  });

  it('empty body is OK (treated as no comment)', async () => {
    const proxySpy = vi.fn(async () => makeRes(200, { ok: true }));
    const deps = makeDeps({ proxyToDaemon: proxySpy });
    await runApproveReject('r1', 'approve', '', deps);
    const init = proxySpy.mock.calls[0]![2] as RequestInit;
    expect(JSON.parse(init.body as string)).toEqual({ comment: undefined });
  });
});

describe('runCancel', () => {
  it('proxies to owner daemon with reason default', async () => {
    const proxySpy = vi.fn(async () => makeRes(200, { ok: true, status: 'cancelled' }));
    const deps = makeDeps({ proxyToDaemon: proxySpy });
    const r = await runCancel('r1', '{}', deps);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, status: 'cancelled' });
    const init = proxySpy.mock.calls[0]![2] as RequestInit;
    expect(JSON.parse(init.body as string)).toEqual({ reason: 'cancelled via dashboard' });
  });

  it('honors caller-supplied reason', async () => {
    const proxySpy = vi.fn(async () => makeRes(200, { ok: true }));
    const deps = makeDeps({ proxyToDaemon: proxySpy });
    await runCancel('r1', '{"reason":"  user requested  "}', deps);
    const init = proxySpy.mock.calls[0]![2] as RequestInit;
    expect(JSON.parse(init.body as string)).toEqual({ reason: 'user requested' });
  });

  it('returns 400 bad_run_id when isValidRunId rejects', async () => {
    const deps = makeDeps({ isValidRunId: vi.fn(() => false) });
    const r = await runCancel('../bad', '{}', deps);
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ ok: false, error: 'bad_run_id' });
  });

  it('returns 400 bad_json on malformed body', async () => {
    const deps = makeDeps();
    const r = await runCancel('r1', '{not-json', deps);
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ ok: false, error: 'bad_json' });
  });

  it('returns 404 unknown_run when snapshot missing', async () => {
    const deps = makeDeps({ readRunSnapshot: vi.fn(async () => null) });
    const r = await runCancel('r1', '{}', deps);
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ ok: false, error: 'unknown_run' });
  });

  it('returns 200 alreadyTerminal for terminal runs (no proxy call)', async () => {
    const proxySpy = vi.fn();
    const deps = makeDeps({
      readRunSnapshot: vi.fn(async () => snapshot({ run: { status: 'cancelled' } })),
      proxyToDaemon: proxySpy as any,
    });
    const r = await runCancel('r1', '{}', deps);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      ok: true,
      runId: 'r1',
      status: 'cancelled',
      alreadyTerminal: true,
      lastSeq: 42,
    });
    expect(proxySpy).not.toHaveBeenCalled();
  });

  it('returns 409 needs_cli_cancel when run has no chat-binding owner', async () => {
    const deps = makeDeps({
      readRunSnapshot: vi.fn(async () => snapshot({ chatBinding: undefined })),
    });
    const r = await runCancel('r1', '{}', deps);
    expect(r.status).toBe(409);
    const body = r.body as any;
    expect(body.ok).toBe(false);
    expect(body.error).toBe('needs_cli_cancel');
    expect(body.hint).toContain("botmux workflow cancel r1");
  });
});
