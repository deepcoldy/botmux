/**
 * Workflows action helpers — single source of truth for the
 * dashboard workflow-runs routes that used to live inline in
 * `workflow-api.ts`.
 *
 * Each helper returns a `HandlerResult { status, body }` so both
 *   - the existing `workflow-api.ts handleWorkflowApi` dispatcher, and
 *   - the HMAC-gated `/__daemon/workflows-runs/*` route
 * render identical responses. Response shapes, error codes, terminal-state
 * branches, and unauth-scrub semantics are byte-equivalent to the original
 * inline implementation.
 *
 * Attempt resume is intentionally out of scope (cuts it from v1).
 */

import type { HandlerResult } from './groups-action-helpers.js';
export type { HandlerResult } from './groups-action-helpers.js';

// ─── Dependencies plucked from ops-projection / catalog ────────────────────
// We declare these as deps (vs importing eagerly) so unit tests can stub
// `readRunSnapshot` / `scrubSnapshotForUnauthed` without touching the
// real run store on disk.

export interface ListRunsOpts {
  all?: boolean;
  statuses?: Set<string>;
  includeBinding?: boolean;
}

export interface RunChatBinding {
  chatId: string;
  larkAppId: string;
}

export interface RunHeader {
  status: string;
}

export interface RunSnapshotLike {
  run: RunHeader;
  chatBinding?: RunChatBinding;
  updatedAt?: number | string;
  lastSeq?: number;
  /** Arbitrary extra fields (preserved through scrub). */
  [key: string]: unknown;
}

/**
 * Snapshot type parameterised so concrete callers can plug in the richer
 * `RunSnapshotDTO` from `ops-projection.ts` without lying about types. The
 * helper only touches the fields declared in `RunSnapshotLike`; callers
 * narrow.
 */
export interface WorkflowsActionDeps<TSnap extends RunSnapshotLike = RunSnapshotLike> {
  runsDir: string;
  proxyToDaemon: (larkAppId: string, daemonPath: string, init: RequestInit) => Promise<Response>;
  listRuns: (runsDir: string, opts: ListRunsOpts) => Promise<unknown[]>;
  readRunSnapshot: (runsDir: string, runId: string) => Promise<TSnap | undefined | null>;
  scrubSnapshotForUnauthed: (snap: TSnap) => TSnap;
  /** Set of run statuses considered terminal; mirrors `ops-projection.ts:TERMINAL_RUN_STATUSES`. */
  TERMINAL_RUN_STATUSES: ReadonlySet<string>;
  /** Run-id validator (no `..`, no slashes, etc.) — mirrors `ops-projection.ts:isValidRunId`. */
  isValidRunId: (id: string) => boolean;
}

/**
 * Build a real production deps object for the workflow-runs helpers — wires up
 * the `ops-projection` imports as the snapshot/list source and the caller's
 * own `proxyToDaemon` for owner routing. Tests should pass their own mocks.
 */
export function defaultWorkflowsActionDeps<TSnap extends RunSnapshotLike = RunSnapshotLike>(opts: {
  runsDir: string;
  proxyToDaemon: (larkAppId: string, daemonPath: string, init: RequestInit) => Promise<Response>;
  listRuns: (runsDir: string, opts: ListRunsOpts) => Promise<unknown[]>;
  readRunSnapshot: (runsDir: string, runId: string) => Promise<TSnap | undefined | null>;
  scrubSnapshotForUnauthed: (snap: TSnap) => TSnap;
  TERMINAL_RUN_STATUSES: ReadonlySet<string>;
  isValidRunId: (id: string) => boolean;
}): WorkflowsActionDeps<TSnap> {
  return {
    runsDir: opts.runsDir,
    proxyToDaemon: opts.proxyToDaemon,
    listRuns: opts.listRuns,
    readRunSnapshot: opts.readRunSnapshot,
    scrubSnapshotForUnauthed: opts.scrubSnapshotForUnauthed,
    TERMINAL_RUN_STATUSES: opts.TERMINAL_RUN_STATUSES,
    isValidRunId: opts.isValidRunId,
  };
}

function safeParseJson(bodyRaw: string): { ok: true; value: unknown } | { ok: false } {
  if (bodyRaw.length === 0) return { ok: true, value: {} };
  try { return { ok: true, value: JSON.parse(bodyRaw) }; }
  catch { return { ok: false }; }
}

function parseUpstreamBody(text: string): unknown {
  try { return JSON.parse(text); }
  catch { return text; }
}

/** GET /api/workflows/runs — list snapshot rows, optionally filtered. */
export async function listWorkflowRuns(
  query: { all?: boolean; statuses?: Set<string> },
  deps: WorkflowsActionDeps<any>,
): Promise<HandlerResult> {
  try {
    const rows = await deps.listRuns(deps.runsDir, {
      all: !!query.all,
      statuses: query.statuses,
      includeBinding: true,
    });
    return { status: 200, body: { runs: rows } };
  } catch (e: any) {
    return { status: 500, body: { error: 'listRuns_failed', message: e?.message ?? String(e) } };
  }
}

/**
 * GET /api/workflows/runs/:id/snapshot — public-read with unauth scrub.
 *
 * `authed=true` returns the full snapshot; `authed=false` strips log bytes
 * via `scrubSnapshotForUnauthed` (terminal.log preview can leak env-var dumps
 * and API key errors). Caller decides `authed` from `decideDashboardAuth`.
 */
export async function getRunSnapshot(
  runId: string,
  authed: boolean,
  deps: WorkflowsActionDeps<any>,
): Promise<HandlerResult> {
  const snap = await deps.readRunSnapshot(deps.runsDir, runId);
  if (!snap) return { status: 404, body: { error: 'unknown_run' } };
  return { status: 200, body: authed ? snap : deps.scrubSnapshotForUnauthed(snap) };
}

/**
 * POST /api/workflows/runs/:id/(approve|reject) — proxy to the owning daemon.
 *
 * Behaviour mirrors `workflow-api.ts`:
 *   - bad_run_id (400) if `isValidRunId` rejects
 *   - bad_json (400) on parse failure
 *   - unknown_run (404) if snapshot missing
 *   - 200 + alreadyTerminal for terminal runs
 *   - 409 + needs_lark_or_cli when no chat-binding owner
 *   - else proxy + echo upstream response
 */
export async function runApproveReject(
  runId: string,
  action: 'approve' | 'reject',
  bodyRaw: string,
  deps: WorkflowsActionDeps<any>,
): Promise<HandlerResult> {
  if (!deps.isValidRunId(runId)) {
    return { status: 400, body: { ok: false, error: 'bad_run_id' } };
  }
  const parsed = safeParseJson(bodyRaw);
  if (!parsed.ok) return { status: 400, body: { ok: false, error: 'bad_json' } };
  const body = (parsed.value && typeof parsed.value === 'object'
    ? parsed.value as { comment?: unknown }
    : {});
  const comment = typeof body.comment === 'string' && body.comment.trim()
    ? body.comment.trim()
    : undefined;

  const snap = await deps.readRunSnapshot(deps.runsDir, runId);
  if (!snap) return { status: 404, body: { ok: false, error: 'unknown_run' } };

  if (deps.TERMINAL_RUN_STATUSES.has(snap.run.status)) {
    return {
      status: 200,
      body: {
        ok: true,
        runId,
        resolution: action === 'approve' ? 'approved' : 'rejected',
        activityId: '',
        attemptId: '',
        resolvedAt: snap.updatedAt,
        lastSeq: snap.lastSeq,
        alreadyTerminal: true,
      },
    };
  }

  const owner = snap.chatBinding?.larkAppId;
  if (!owner) {
    return {
      status: 409,
      body: {
        ok: false,
        error: 'needs_lark_or_cli',
        hint:
          `This run has no chat-binding owner; dashboard approval requires ` +
          `the owning daemon. Use the Lark approval card for now.`,
      },
    };
  }

  const upstream = await deps.proxyToDaemon(
    owner,
    `/api/workflows/runs/${encodeURIComponent(runId)}/${action}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ comment }),
    },
  );
  const text = await upstream.text();
  return { status: upstream.status, body: parseUpstreamBody(text) };
}

/**
 * POST /api/workflows/runs/:id/cancel — proxy to the owning daemon.
 *
 * Behaviour mirrors `workflow-api.ts`:
 *   - bad_run_id (400) if `isValidRunId` rejects
 *   - bad_json (400) on parse failure
 *   - unknown_run (404) if snapshot missing
 *   - 200 + alreadyTerminal for terminal runs
 *   - 409 + needs_cli_cancel when no chat-binding owner
 *   - else proxy + echo upstream response
 */
export async function runCancel(
  runId: string,
  bodyRaw: string,
  deps: WorkflowsActionDeps<any>,
): Promise<HandlerResult> {
  if (!deps.isValidRunId(runId)) {
    return { status: 400, body: { ok: false, error: 'bad_run_id' } };
  }
  const parsed = safeParseJson(bodyRaw);
  if (!parsed.ok) return { status: 400, body: { ok: false, error: 'bad_json' } };
  const body = (parsed.value && typeof parsed.value === 'object'
    ? parsed.value as { reason?: unknown }
    : {});
  const reason = typeof body.reason === 'string' && body.reason.trim()
    ? body.reason.trim()
    : 'cancelled via dashboard';

  const snap = await deps.readRunSnapshot(deps.runsDir, runId);
  if (!snap) return { status: 404, body: { ok: false, error: 'unknown_run' } };

  if (deps.TERMINAL_RUN_STATUSES.has(snap.run.status)) {
    return {
      status: 200,
      body: {
        ok: true,
        runId,
        status: snap.run.status,
        alreadyTerminal: true,
        lastSeq: snap.lastSeq,
      },
    };
  }

  const owner = snap.chatBinding?.larkAppId;
  if (!owner) {
    return {
      status: 409,
      body: {
        ok: false,
        error: 'needs_cli_cancel',
        hint: `This run has no chat-binding owner; use 'botmux workflow cancel ${runId}' instead.`,
      },
    };
  }

  const upstream = await deps.proxyToDaemon(
    owner,
    `/api/workflows/runs/${encodeURIComponent(runId)}/cancel`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason }),
    },
  );
  const text = await upstream.text();
  return { status: upstream.status, body: parseUpstreamBody(text) };
}
