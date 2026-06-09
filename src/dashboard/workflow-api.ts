import { createReadStream, promises as fs } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  isValidWorkflowId,
  listWorkflowDefinitions as defaultListWorkflowDefinitions,
  loadCatalogDefinition as defaultLoadCatalogDefinition,
  type CatalogDefinition,
  type CatalogEntry,
} from '../workflows/catalog.js';
import {
  listRuns,
  readRunSnapshot,
  readEventWindow,
  isValidRunId,
  isValidPathSegment,
  isPathInsideDir,
  attemptTerminalLogPath,
  attemptPtyLogPath,
  scrubSnapshotForUnauthed,
  TERMINAL_RUN_STATUSES,
  type RunSnapshotDTO,
} from '../workflows/ops-projection.js';
import {
  getRunSnapshot as getRunSnapshotHelper,
  listWorkflowRuns,
  runApproveReject,
  runCancel,
  type HandlerResult,
  type WorkflowsActionDeps,
} from './workflows-action-helpers.js';

export type WorkflowApiDeps = {
  runsDir: string;
  proxyToDaemon: (
    larkAppId: string,
    daemonPath: string,
    init: RequestInit,
  ) => Promise<Response>;
  /**
   * Test seam: override catalog list/load so route tests can scope to a tmp
   * workflow dir instead of $HOME/.botmux/workflows.  Production callers omit
   * these and the defaults read the real search paths.
   */
  listWorkflowDefinitions?: () => Promise<CatalogEntry[]>;
  loadCatalogDefinition?: (workflowId: string) => Promise<CatalogDefinition | undefined>;
};

export function jsonRes(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

/** Render a HandlerResult through res. Tolerates string bodies (helper may return raw upstream text). */
function writeHandlerResult(res: ServerResponse, result: HandlerResult): void {
  const headers = { 'content-type': 'application/json', ...(result.headers ?? {}) };
  res.writeHead(result.status, headers);
  res.end(typeof result.body === 'string' ? result.body : JSON.stringify(result.body));
}

async function readBodyString(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function readJsonBody<T = unknown>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (chunks.length === 0) return {} as T;
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function parseChatBinding(
  raw: unknown,
): { chatId: string; larkAppId: string } | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as { chatId?: unknown; larkAppId?: unknown };
  if (typeof r.chatId !== 'string' || !r.chatId.trim()) return undefined;
  if (typeof r.larkAppId !== 'string' || !r.larkAppId.trim()) return undefined;
  return { chatId: r.chatId.trim(), larkAppId: r.larkAppId.trim() };
}

/**
 * Dashboard workflow API router.
 *
 * Kept separate from `dashboard.ts` so route behavior can be exercised with a
 * small HTTP smoke test without starting the top-level dashboard process,
 * daemon registry, or SSE fanout.
 *
 * `authed` reflects whether the request presented a valid cookie/token; the
 * caller (`dashboard.ts`) computes this from `decideDashboardAuth` and
 * passes it through.  Public-read endpoints (`GET /snapshot`) use it to
 * scrub log bytes from the response when the reader is unauthenticated —
 * see `scrubSnapshotForUnauthed`.  Defaults to `false` so test callers
 * that omit the flag get the secure-by-default behavior.
 */
export async function handleWorkflowApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: WorkflowApiDeps,
  authed: boolean = false,
): Promise<boolean> {
  let m: RegExpMatchArray | null;

  // ─── Catalog: definitions list / detail / trigger ──────────────────────────
  // GET list + detail are intentionally public-read (auth boundary in
  // `decideDashboardAuth` allows any `GET /api/workflows/*`).  Trigger is POST,
  // so the same boundary forces cookie auth before this handler runs.
  const listDefinitions = deps.listWorkflowDefinitions ?? defaultListWorkflowDefinitions;
  const loadDefinition = deps.loadCatalogDefinition ?? defaultLoadCatalogDefinition;

  if (req.method === 'GET' && url.pathname === '/api/workflows/definitions') {
    try {
      const definitions = await listDefinitions();
      jsonRes(res, 200, { definitions });
    } catch (e: any) {
      jsonRes(res, 500, {
        error: 'list_definitions_failed',
        message: e?.message ?? String(e),
      });
    }
    return true;
  }

  if (
    req.method === 'GET' &&
    (m = url.pathname.match(/^\/api\/workflows\/definitions\/([^/]+)$/))
  ) {
    const id = decodeURIComponent(m[1]);
    if (!isValidWorkflowId(id)) {
      jsonRes(res, 400, { error: 'bad_id' });
      return true;
    }
    try {
      const found = await loadDefinition(id);
      if (!found) {
        jsonRes(res, 404, { error: 'unknown_workflow' });
        return true;
      }
      jsonRes(res, 200, found);
    } catch (e: any) {
      jsonRes(res, 500, {
        error: 'load_definition_failed',
        message: e?.message ?? String(e),
      });
    }
    return true;
  }

  if (
    req.method === 'POST' &&
    (m = url.pathname.match(/^\/api\/workflows\/definitions\/([^/]+)\/run$/))
  ) {
    const id = decodeURIComponent(m[1]);
    if (!isValidWorkflowId(id)) {
      jsonRes(res, 400, { ok: false, error: 'bad_id' });
      return true;
    }
    let body: { params?: unknown; chatBinding?: unknown };
    try {
      body = await readJsonBody<{ params?: unknown; chatBinding?: unknown }>(req);
    } catch {
      jsonRes(res, 400, { ok: false, error: 'bad_json' });
      return true;
    }
    const chatBinding = parseChatBinding(body.chatBinding);
    if (!chatBinding) {
      jsonRes(res, 400, {
        ok: false,
        error: 'missing_chat_binding',
        hint:
          'Body must include chatBinding={chatId, larkAppId}. The chatId/larkAppId ' +
          'pair binds the run to a Lark chat for approval cards + cancel routing; ' +
          'pick a chat the target bot is already in (see /api/groups).',
      });
      return true;
    }
    // Params: optional record of arbitrary JSON values.  Validate the wrapper
    // shape here; the owner daemon does per-field coercion against the schema.
    if (body.params !== undefined) {
      if (
        typeof body.params !== 'object' ||
        body.params === null ||
        Array.isArray(body.params)
      ) {
        jsonRes(res, 400, { ok: false, error: 'bad_params_shape' });
        return true;
      }
    }
    const upstream = await deps.proxyToDaemon(
      chatBinding.larkAppId,
      `/api/workflows/definitions/${encodeURIComponent(id)}/run`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ params: body.params, chatBinding }),
      },
    );
    res.writeHead(upstream.status, { 'content-type': 'application/json' });
    res.end(await upstream.text());
    return true;
  }

  // Shared deps for the workflow-runs action helpers — these handlers and the
  // PR2 C6 HMAC-gated `/__daemon/workflows-runs/*` route both go through the
  // same helpers so response shapes / error codes stay identical.
  const wfActionDeps: WorkflowsActionDeps<RunSnapshotDTO> = {
    runsDir: deps.runsDir,
    proxyToDaemon: deps.proxyToDaemon,
    listRuns,
    readRunSnapshot,
    scrubSnapshotForUnauthed,
    TERMINAL_RUN_STATUSES,
    isValidRunId,
  };

  if (req.method === 'GET' && url.pathname === '/api/workflows/runs') {
    const all = url.searchParams.get('all') === '1';
    const statusParam = url.searchParams.get('status');
    const statuses = statusParam
      ? new Set(statusParam.split(',').map(s => s.trim()).filter(Boolean))
      : undefined;
    const result = await listWorkflowRuns({ all, statuses }, wfActionDeps);
    writeHandlerResult(res, result);
    return true;
  }

  if (req.method === 'GET' && (m = url.pathname.match(/^\/api\/workflows\/runs\/([^/]+)\/snapshot$/))) {
    const runId = decodeURIComponent(m[1]);
    const result = await getRunSnapshotHelper(runId, authed, wfActionDeps);
    writeHandlerResult(res, result);
    return true;
  }

  if (req.method === 'GET' && (m = url.pathname.match(/^\/api\/workflows\/runs\/([^/]+)\/events$/))) {
    const runId = decodeURIComponent(m[1]);
    const q = url.searchParams;
    const optNum = (name: string): number | undefined => {
      const v = q.get(name);
      if (v === null) return undefined;
      const n = Number(v);
      return Number.isFinite(n) ? n : undefined;
    };
    const window = await readEventWindow(deps.runsDir, runId, {
      tail: optNum('tail'),
      beforeSeq: optNum('beforeSeq'),
      afterSeq: optNum('afterSeq'),
      limit: optNum('limit'),
    });
    if (!window) jsonRes(res, 404, { error: 'unknown_run' });
    else jsonRes(res, 200, window);
    return true;
  }

  // ─── Attempt raw terminal.log ──────────────────────────────────────────────
  // Cookie-auth only (carved OUT of `decideDashboardAuth`'s
  // `GET /api/workflows/*` public-read allowlist by `b5d23a6` — raw PTY +
  // diagnostic streams can leak API keys / env / tokens; `/snapshot`'s
  // log preview is scrubbed under the same posture via
  // `scrubSnapshotForUnauthed`).
  // Streams `runs/<runId>/attempts/<activityId>/<attemptId>/terminal.log` for
  // the dashboard replay viewer.  Default behavior tails the last 10 MB; pass
  // `?tailBytes=N` to widen the window (capped at MAX_TAIL_BYTES) or
  // `?download=1` to receive an attachment (also unbounded by the tail cap).
  //
  // Why a separate endpoint vs reusing `previewAttemptLog`: preview returns a
  // 100 KB UTF-8 string baked into the snapshot DTO; this endpoint streams raw
  // bytes (ANSI escapes preserved) so an xterm.js replay viewer can render the
  // exact terminal state the worker left behind.
  m = url.pathname.match(
    /^\/api\/workflows\/runs\/([^/]+)\/attempts\/([^/]+)\/([^/]+)\/terminal-log\/raw$/,
  );
  if (req.method === 'GET' && m) {
    const runId = decodeURIComponent(m[1]);
    const activityId = decodeURIComponent(m[2]);
    const attemptId = decodeURIComponent(m[3]);
    if (
      !isValidRunId(runId) ||
      !isValidPathSegment(activityId) ||
      !isValidPathSegment(attemptId)
    ) {
      jsonRes(res, 400, { error: 'bad_id' });
      return true;
    }
    // ?stream=pty selects the raw PTY byte log (terminal cinema); default is
    // the diagnostic `terminal.log` for back-compat — older clients that
    // omit the param keep their existing behavior.
    const streamParam = url.searchParams.get('stream');
    const stream: 'pty' | 'diag' = streamParam === 'pty' ? 'pty' : 'diag';
    const logPath = stream === 'pty'
      ? attemptPtyLogPath(deps.runsDir, runId, activityId, attemptId)
      : attemptTerminalLogPath(deps.runsDir, runId, activityId, attemptId);
    if (!isPathInsideDir(deps.runsDir, logPath)) {
      // Defense-in-depth — `isValidPathSegment` already rejects `..` and `/`,
      // but the path guard keeps us honest if the regex is ever relaxed.
      jsonRes(res, 400, { error: 'bad_path' });
      return true;
    }
    await streamAttemptTerminalLog(res, logPath, {
      runId,
      activityId,
      attemptId,
      tailBytesParam: url.searchParams.get('tailBytes'),
      download: url.searchParams.get('download') === '1',
    });
    return true;
  }

  // approve / reject share the same shape: { comment? } body, route to the
  // owner daemon via chat-binding. See
  // `dashboard/workflows-action-helpers.ts:runApproveReject` for the
  // alreadyTerminal / needs_lark_or_cli / proxy branches.
  m = url.pathname.match(/^\/api\/workflows\/runs\/([^/]+)\/(approve|reject)$/);
  if (req.method === 'POST' && m) {
    const runId = decodeURIComponent(m[1]);
    const action = m[2] as 'approve' | 'reject';
    const bodyRaw = await readBodyString(req);
    const result = await runApproveReject(runId, action, bodyRaw, wfActionDeps);
    writeHandlerResult(res, result);
    return true;
  }

  m = url.pathname.match(
    /^\/api\/workflows\/runs\/([^/]+)\/attempts\/([^/]+)\/([^/]+)\/resume(\/end)?$/,
  );
  if (req.method === 'POST' && m) {
    const runId = decodeURIComponent(m[1]);
    const activityId = decodeURIComponent(m[2]);
    const attemptId = decodeURIComponent(m[3]);
    const end = m[4] === '/end';
    if (
      !isValidRunId(runId) ||
      !isValidPathSegment(activityId) ||
      !isValidPathSegment(attemptId)
    ) {
      jsonRes(res, 400, { ok: false, error: 'bad_id' });
      return true;
    }
    let body: { reason?: unknown } = {};
    try {
      body = await readJsonBody<{ reason?: unknown }>(req);
    } catch {
      jsonRes(res, 400, { ok: false, error: 'bad_json' });
      return true;
    }
    const snap = await readRunSnapshot(deps.runsDir, runId);
    if (!snap) {
      jsonRes(res, 404, { ok: false, error: 'unknown_run' });
      return true;
    }
    const owner = snap.chatBinding?.larkAppId;
    if (!owner) {
      jsonRes(res, 409, {
        ok: false,
        error: 'needs_lark_owner',
        hint: 'Attempt resume is routed through the workflow owner daemon; this run has no chat binding.',
      });
      return true;
    }
    const upstream = await deps.proxyToDaemon(
      owner,
      `/api/workflows/runs/${encodeURIComponent(runId)}` +
        `/attempts/${encodeURIComponent(activityId)}` +
        `/${encodeURIComponent(attemptId)}/resume${end ? '/end' : ''}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          reason:
            typeof body.reason === 'string' && body.reason.trim()
              ? body.reason.trim()
              : undefined,
        }),
      },
    );
    res.writeHead(upstream.status, { 'content-type': 'application/json' });
    res.end(await upstream.text());
    return true;
  }

  if (req.method === 'POST' && (m = url.pathname.match(/^\/api\/workflows\/runs\/([^/]+)\/cancel$/))) {
    const runId = decodeURIComponent(m[1]);
    const bodyRaw = await readBodyString(req);
    const result = await runCancel(runId, bodyRaw, wfActionDeps);
    writeHandlerResult(res, result);
    return true;
  }

  return false;
}

// ─── Attempt raw terminal.log streaming ──────────────────────────────────────

/**
 * Tail cap for the replay viewer.  10 MB is enough for ~60-90 minutes of
 * verbose CLI output and small enough to xterm.write-chunk in a few seconds
 * without blowing the browser tab.  Operators who want the whole file pass
 * `?download=1`, which is uncapped (subject to RAW_LOG_DOWNLOAD_MAX).
 */
const RAW_LOG_TAIL_BYTES_DEFAULT = 10 * 1024 * 1024;
const RAW_LOG_TAIL_BYTES_MAX = 64 * 1024 * 1024;
/** Hard ceiling for `?download=1` so a runaway log can't blow up streaming. */
const RAW_LOG_DOWNLOAD_MAX = 512 * 1024 * 1024;

async function streamAttemptTerminalLog(
  res: ServerResponse,
  logPath: string,
  opts: {
    runId: string;
    activityId: string;
    attemptId: string;
    tailBytesParam: string | null;
    download: boolean;
  },
): Promise<void> {
  let stat: import('node:fs').Stats;
  try {
    stat = await fs.stat(logPath);
  } catch (err: any) {
    if (err && err.code === 'ENOENT') {
      jsonRes(res, 404, { error: 'no_terminal_log' });
      return;
    }
    jsonRes(res, 500, {
      error: 'stat_failed',
      message: err?.message ?? String(err),
    });
    return;
  }
  if (!stat.isFile()) {
    jsonRes(res, 404, { error: 'no_terminal_log' });
    return;
  }

  const totalBytes = stat.size;
  const wantsDownload = opts.download;
  const tailParam = parsePositiveInt(opts.tailBytesParam);
  const cap = wantsDownload ? RAW_LOG_DOWNLOAD_MAX : RAW_LOG_TAIL_BYTES_MAX;
  const requested = wantsDownload
    ? totalBytes
    : Math.min(tailParam ?? RAW_LOG_TAIL_BYTES_DEFAULT, cap);
  const bytesToServe = Math.min(totalBytes, requested);
  const start = Math.max(0, totalBytes - bytesToServe);
  const truncated = start > 0;

  const headers: Record<string, string> = {
    'content-type': wantsDownload
      ? 'application/octet-stream'
      : 'text/plain; charset=utf-8',
    'content-length': String(bytesToServe),
    'cache-control': 'no-store',
    'x-botmux-log-bytes': String(totalBytes),
    'x-botmux-served-bytes': String(bytesToServe),
    'x-botmux-truncated': truncated ? '1' : '0',
  };
  if (wantsDownload) {
    const filename = `terminal-${opts.runId}-${opts.activityId}-${opts.attemptId}.log`
      .replace(/[^A-Za-z0-9._:-]/g, '_');
    headers['content-disposition'] = `attachment; filename="${filename}"`;
  }
  res.writeHead(200, headers);

  if (bytesToServe === 0) {
    res.end();
    return;
  }
  const stream = createReadStream(logPath, { start, end: totalBytes - 1 });
  stream.on('error', () => {
    if (!res.headersSent) {
      jsonRes(res, 500, { error: 'stream_failed' });
    } else {
      try {
        res.end();
      } catch {
        /* ignore */
      }
    }
  });
  stream.pipe(res);
}

function parsePositiveInt(raw: string | null): number | undefined {
  if (raw === null) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.floor(n);
}
