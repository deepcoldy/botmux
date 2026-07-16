/**
 * Dashboard API for v3 workflow runs.
 *
 * Host-neutral v3 run API: a single
 * `handle...(req, res, url, deps, authed): Promise<boolean>` router that returns
 * `true` once it has handled a route. Read data comes from the v3 run dir via
 * `ops-projection.ts` (journal + dag → RunView); the sole mutation below is
 * proxied to the run's owner daemon.
 *
 *   GET /api/v3/runs                                  → { runs: RunSummary[] }
 *   GET /api/v3/runs/:id                              → RunView | 404
 *   GET /api/v3/runs/:id/nodes/:nodeId/pty-log        → raw PTY bytes (AUTH ONLY)
 *   POST /api/v3/runs/:id/cancel                      → owner-daemon proxy (AUTH ONLY)
 *
 * Security: every route in this module is authenticated. Even though RunView
 * omits write tokens and raw fs paths, its goals, node ids, and run ids may
 * contain project or personal information. The per-node pty-log is more
 * sensitive still because terminal output can contain credentials. Keep the
 * handler-level guard as defense in depth in addition to dashboard/auth.ts.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createReadStream, lstatSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { jsonRes } from './http.js';
import { isValidRunId, listRuns, projectRunById, ptyLogPathFor } from '../workflows/v3/ops-projection.js';
import { workflowDaemonMutationPath } from '../workflows/v3/daemon-ipc-client.js';
import { readRunEnvelope, V3_RUN_ENVELOPE_FILE } from '../workflows/v3/run-envelope.js';
import { readGrillState } from '../workflows/v3/grill-state.js';

export type V3RunsApiDeps = {
  /** Root of the v3 run dirs (`~/.botmux/v3-runs` in production). */
  runsDir: string;
  /** Route a mutation to the daemon that owns the immutable run binding. */
  proxyToDaemon: (larkAppId: string, daemonPath: string, init: RequestInit) => Promise<Response>;
};

/** Cap a single pty-log response so a runaway log can't exhaust the dashboard. */
const PTY_LOG_MAX_BYTES = 4 * 1024 * 1024;

export async function handleV3RunsApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: V3RunsApiDeps,
  authed: boolean = false,
): Promise<boolean> {
  // Fail closed before route matching or filesystem access. This also keeps an
  // unauthenticated caller from using 404/400 differences as a run-id oracle
  // if this router is ever wired without the outer dashboard auth guard.
  if (req.method === 'GET' && url.pathname.startsWith('/api/v3/') && !authed) {
    jsonRes(res, 401, { ok: false, error: 'auth_required' });
    return true;
  }

  // GET /api/v3/runs
  if (req.method === 'GET' && url.pathname === '/api/v3/runs') {
    jsonRes(res, 200, { runs: listRuns(deps.runsDir) });
    return true;
  }

  // GET /api/v3/runs/:id
  let m: RegExpMatchArray | null;
  if (req.method === 'GET' && (m = url.pathname.match(/^\/api\/v3\/runs\/([^/]+)$/))) {
    let runId: string;
    try {
      runId = decodeURIComponent(m[1]!);
    } catch {
      jsonRes(res, 400, { ok: false, error: 'bad_run_id' });
      return true;
    }
    const view = projectRunById(deps.runsDir, runId);
    if (!view) {
      jsonRes(res, 404, { error: 'unknown_run' });
      return true;
    }
    jsonRes(res, 200, view);
    return true;
  }

  // POST /api/v3/runs/:id/cancel
  //
  // The dashboard is deliberately only a router for this mutation. It never
  // appends to journal.ndjson: the owning daemon owns the live AbortController
  // and the single durable cancel seam. New runs route from immutable run.json;
  // pre-envelope compatibility may consult grill.state.json only when run.json
  // is genuinely missing (an invalid envelope always fails closed).
  if (req.method === 'POST' && (m = url.pathname.match(/^\/api\/v3\/runs\/([^/]+)\/cancel$/))) {
    if (!authed) {
      jsonRes(res, 401, { ok: false, error: 'auth_required' });
      return true;
    }
    let runId: string;
    try {
      runId = decodeURIComponent(m[1]!);
    } catch {
      jsonRes(res, 400, { ok: false, error: 'bad_run_id' });
      return true;
    }
    if (!isValidRunId(runId)) {
      jsonRes(res, 400, { ok: false, error: 'bad_run_id' });
      return true;
    }

    const owner = resolveV3RunOwner(deps.runsDir, runId);
    if (owner.kind === 'missing') {
      jsonRes(res, 404, { ok: false, error: 'unknown_run' });
      return true;
    }
    if (owner.kind === 'invalid') {
      jsonRes(res, 409, { ok: false, error: 'invalid_run_envelope' });
      return true;
    }
    if (owner.kind === 'unroutable') {
      jsonRes(res, 409, {
        ok: false,
        error: 'needs_cli_cancel',
        hint: `This run has no immutable daemon owner; use 'botmux workflow cancel ${runId}' instead.`,
      });
      return true;
    }

    try {
      const upstream = await deps.proxyToDaemon(
        owner.larkAppId,
        workflowDaemonMutationPath(runId, 'cancel'),
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ reason: 'cancelled via dashboard' }),
        },
      );
      const body = await upstream.text();
      res.writeHead(upstream.status, {
        'content-type': upstream.headers.get('content-type') ?? 'application/json; charset=utf-8',
      });
      res.end(body);
    } catch {
      jsonRes(res, 502, { ok: false, error: 'daemon_proxy_failed' });
    }
    return true;
  }

  // GET /api/v3/runs/:id/nodes/:nodeId/pty-log  (raw bytes — AUTH required)
  if (req.method === 'GET' && (m = url.pathname.match(/^\/api\/v3\/runs\/([^/]+)\/nodes\/([^/]+)\/pty-log$/))) {
    if (!authed) {
      jsonRes(res, 401, { error: 'auth_required' });
      return true;
    }
    const runId = decodeURIComponent(m[1]!);
    const nodeId = decodeURIComponent(m[2]!);
    const path = ptyLogPathFor(deps.runsDir, runId, nodeId);
    if (!path) {
      jsonRes(res, 404, { error: 'no_pty_log' });
      return true;
    }
    streamPtyLog(res, path);
    return true;
  }

  return false;
}

type V3RunOwnerResolution =
  | { kind: 'ok'; larkAppId: string }
  | { kind: 'missing' }
  | { kind: 'invalid' }
  | { kind: 'unroutable' };

/** Resolve the daemon owner without trusting mutable projection data. */
function resolveV3RunOwner(runsDir: string, runId: string): V3RunOwnerResolution {
  const root = resolve(runsDir);
  const runDir = resolve(root, runId);
  if (runDir !== root && !runDir.startsWith(root + sep)) return { kind: 'missing' };
  try {
    if (!lstatSync(runDir).isDirectory()) return { kind: 'missing' };
  } catch {
    return { kind: 'missing' };
  }

  // A symlink/non-file run.json is not an immutable owner marker. Reject it
  // before readRunEnvelope instead of treating it like the compatibility case.
  const envelopePath = join(runDir, V3_RUN_ENVELOPE_FILE);
  try {
    if (!lstatSync(envelopePath).isFile()) return { kind: 'invalid' };
  } catch (err) {
    // lstat (rather than existsSync) keeps a broken run.json symlink in the
    // invalid branch instead of silently treating it as a missing envelope.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return { kind: 'invalid' };
  }

  const envelope = readRunEnvelope(runDir, runId);
  if (envelope.kind === 'invalid') return { kind: 'invalid' };
  if (envelope.kind === 'ok') {
    const larkAppId = envelope.envelope.chatBinding?.larkAppId?.trim();
    return larkAppId ? { kind: 'ok', larkAppId } : { kind: 'unroutable' };
  }

  // Compatibility is missing-only. In particular, a corrupt/replaced
  // run.json above must never fall through to this mutable legacy source.
  const grill = readGrillState(runDir);
  const larkAppId = grill?.runId === runId
    ? grill.chatBinding?.larkAppId?.trim()
    : undefined;
  return larkAppId ? { kind: 'ok', larkAppId } : { kind: 'unroutable' };
}

function streamPtyLog(res: ServerResponse, path: string): void {
  let bytes = 0;
  try {
    bytes = statSync(path).size;
  } catch {
    jsonRes(res, 404, { error: 'no_pty_log' });
    return;
  }
  // Serve the TAIL when the log is larger than the cap (the recent activity is
  // what a viewer wants); advertise the real size + whether we truncated.
  const start = bytes > PTY_LOG_MAX_BYTES ? bytes - PTY_LOG_MAX_BYTES : 0;
  res.writeHead(200, {
    'content-type': 'text/plain; charset=utf-8',
    'x-botmux-log-bytes': String(bytes),
    'x-botmux-served-bytes': String(bytes - start),
    'x-botmux-truncated': start > 0 ? '1' : '0',
  });
  createReadStream(path, { start })
    .on('error', () => { try { res.end(); } catch { /* already ended */ } })
    .pipe(res);
}
