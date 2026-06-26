/**
 * Dashboard read-only API for v3 workflow runs.
 *
 * Mirrors `workflow-api.ts` (the v0.2 read-only run API): a single
 * `handle...(req, res, url, deps, authed): Promise<boolean>` router that returns
 * `true` once it has handled a route.  All data comes from the v3 run dir via
 * `ops-projection.ts` (journal + dag → RunView) — no daemon proxy needed (v3
 * runs are plain files on disk).
 *
 *   GET /api/v3/runs                                  → { runs: RunSummary[] }
 *   GET /api/v3/runs/:id                              → RunView | 404
 *   GET /api/v3/runs/:id/nodes/:nodeId/pty-log        → raw PTY bytes (AUTH ONLY)
 *
 * Security: the pty-log raw stream can contain secrets that scrolled a node's
 * terminal, so — exactly like v0.2's `…/terminal-log/raw` — it is NOT in the
 * read-only allowlist (see auth.ts) and additionally requires `authed` here.
 * The RunView itself never carries the web-terminal write token or raw fs paths
 * (codex security review 2026-06-02).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { jsonRes } from './workflow-api.js';
import { listRuns, projectRunById, ptyLogPathFor } from '../workflows/v3/ops-projection.js';

export type V3RunsApiDeps = {
  /** Root of the v3 run dirs (`~/.botmux/v3-runs` in production). */
  runsDir: string;
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
  // GET /api/v3/runs
  if (req.method === 'GET' && url.pathname === '/api/v3/runs') {
    jsonRes(res, 200, { runs: listRuns(deps.runsDir) });
    return true;
  }

  // GET /api/v3/runs/:id
  let m: RegExpMatchArray | null;
  if (req.method === 'GET' && (m = url.pathname.match(/^\/api\/v3\/runs\/([^/]+)$/))) {
    const runId = decodeURIComponent(m[1]!);
    const view = projectRunById(deps.runsDir, runId);
    if (!view) {
      jsonRes(res, 404, { error: 'unknown_run' });
      return true;
    }
    jsonRes(res, 200, view);
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
