/**
 * Daemon-internal API (PR2 C6) — typed Route B server for `/__daemon/*`.
 *
 * Dispatch pipeline:
 *   1) `verifyDaemonRequest` checks HMAC + loopback + ts ±60s + nonce replay.
 *      Reads the body stream EXACTLY ONCE and returns `bodyRaw`.
 *   2) `bodyRaw` is JSON-parsed (empty body → `undefined`); a parse failure
 *      after a valid HMAC returns 400 `bad_json` without re-reading `req`.
 *   3) Dispatch matches `(method, path)` against a typed allowlist of 20
 *      endpoints — there is intentionally NO generic forward, so a daemon
 *      can never use Route B as a path-shifting proxy.
 *
 * Settings-write also enforces the §6.1 union_id owner gate: the body must
 * carry an `ownerUnionId` (`on_`-prefixed) that resolves to a candidate in
 * the global owner set, or the request returns 403 `owner_only`.
 *
 * The factory exposes both `handle(req,res,url)` (production wiring) and
 * `dispatchForTest(method, url, bodyRaw)` (skips HMAC for unit tests that
 * focus on route shape; full HMAC flow is covered by daemon-internal-auth).
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  createNonceStore,
  verifyDaemonRequest,
  type ClockLike,
  type NonceStore,
} from './daemon-internal-auth.js';
import {
  addBotsToGroup,
  bindOncall,
  disbandGroup,
  leaveGroup,
  unbindOncall,
  type GroupsActionDeps,
  type HandlerResult,
} from './groups-action-helpers.js';
import {
  applySettingsWrite,
  type ResolvedDashboardSettingsView,
  type SettingsWriteApplierDeps,
} from './settings-write-applier.js';
import {
  isAuthorizedForGlobalSettings,
  type SettingsOwnerResolverDeps,
} from './settings-owner-resolver.js';
import {
  listWorkflowRuns,
  runApproveReject,
  runCancel,
  type WorkflowsActionDeps,
} from './workflows-action-helpers.js';

export type SimpleHttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

/** Deps the dispatcher needs — all IO is injected. */
export interface DaemonInternalApiDeps {
  /** `.dashboard-secret` body (string used directly as HMAC key — same convention as `/__cli/rotate`). */
  secret: string;
  /** Override for tests to inject a fake clock-aware nonce store. Production uses `createNonceStore()`. */
  nonceStore?: NonceStore;
  /** Override for tests to advance time deterministically inside verifyDaemonRequest. */
  clock?: ClockLike;

  // ─── READ ENDPOINTS ─────────────────────────────────────────────────
  getSessions: () => unknown[];
  getSchedules: () => unknown[];
  resolveDashboardSettings: () => ResolvedDashboardSettingsView;
  /** Returns `{ chats, bots }`; PR1 groups model requires both for missingOnly accuracy. */
  buildGroupsMatrix: () => Promise<{ chats: unknown[]; bots: unknown[] }>;

  // ─── WRITE ACTIONS (via helpers) ───────────────────────────────────
  settingsApplierDeps: SettingsWriteApplierDeps;
  groupsActionDeps: GroupsActionDeps;
  workflowsActionDeps: WorkflowsActionDeps<any>;

  // ─── SIMPLE PROXY TARGETS ─────────────────────────────────────────
  proxyToDaemon: (larkAppId: string, daemonPath: string, init: RequestInit) => Promise<Response>;
  ownerOf: (sessionId: string) => string | undefined;
  scheduleOwnerOf: (id: string) => string | undefined;

  // ─── OWNER CHECK ──────────────────────────────────────────────────
  /** Override for unit tests; production omits and uses the real federation helper. */
  settingsOwnerDeps?: SettingsOwnerResolverDeps;
}

export interface DispatchContext {
  bodyRaw: string;
  body: unknown;
  url: URL;
  /**
   * Authenticated caller's bot `larkAppId` — populated by `handle()` from
   * `verify.appId` (`daemon-internal-auth.ts:232`). Read routes that surface
   * cross-daemon aggregator state (sessions / schedules) MUST scope their
   * response to this id so a bot A owner can't peek into bot B's state.
   * undefined only on the test seam (`dispatchForTest`) where the caller is
   * trusted to assert their own scope.
   */
  callerAppId?: string;
}

interface RouteDef {
  method: SimpleHttpMethod;
  /** Anchored regex that matches `url.pathname`. */
  pathRe: RegExp;
  /** Handler invoked with the regex match + dispatch context + deps. */
  handle: (
    m: RegExpMatchArray,
    ctx: DispatchContext,
    deps: DaemonInternalApiDeps,
  ) => Promise<HandlerResult>;
}

/** ─── Helpers ──────────────────────────────────────────────────────── */

function parseStatusesParam(raw: string | null): Set<string> | undefined {
  if (raw === null) return undefined;
  const s = new Set(raw.split(',').map(x => x.trim()).filter(Boolean));
  return s.size > 0 ? s : undefined;
}

async function readUpstream(upstream: Response): Promise<unknown> {
  const text = await upstream.text();
  try { return JSON.parse(text); } catch { return text; }
}

function bodyField<T = unknown>(body: unknown, name: string): T | undefined {
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    return (body as Record<string, unknown>)[name] as T | undefined;
  }
  return undefined;
}

/**
 * Restrict aggregator rows to those owned by the authenticated caller's bot.
 *
 * Per-bot owner gate (PR3) means a bot A owner viewing `/dashboard
 * sessions` against bot A must never see bot B's sessions. The aggregator
 * mixes rows from all daemons (`aggregator.ts:62-63`), so we filter at the
 * Route B read layer using the caller's `verify.appId`.
 *
 * Rows without `larkAppId` (legacy persistence shape) are KEPT so they
 * don't disappear from a freshly-upgraded deploy. callerAppId === undefined
 * means the test seam (`dispatchForTest`) is in use; the test is trusted
 * to assert its own scope so we pass everything through.
 */
function scopeByCaller(
  rows: ReadonlyArray<unknown>,
  callerAppId: string | undefined,
): unknown[] {
  if (!callerAppId) return rows.slice();
  return rows.filter(r => {
    const owner = (r as { larkAppId?: unknown })?.larkAppId;
    // Keep legacy rows (no larkAppId) so a fresh deploy doesn't lose them.
    if (typeof owner !== 'string' || owner.length === 0) return true;
    return owner === callerAppId;
  });
}

/** ─── Route table ────────────────────────────────────────────────── */

const ROUTES: RouteDef[] = [
  // ── READ ──────────────────────────────
  {
    method: 'GET',
    pathRe: /^\/__daemon\/sessions-list$/,
    handle: async (_m, ctx, deps) => ({ status: 200, body: { sessions: scopeByCaller(deps.getSessions(), ctx.callerAppId) } }),
  },
  // PR3 `/dashboard schedules` slice 1: dedicated list endpoint so the
  // card command doesn't pay the cost of `overview-snapshot` (which also
  // builds the groups matrix). Mirrors `sessions-list` shape.
  {
    method: 'GET',
    pathRe: /^\/__daemon\/schedules-list$/,
    handle: async (_m, ctx, deps) => ({ status: 200, body: { schedules: scopeByCaller(deps.getSchedules(), ctx.callerAppId) } }),
  },
  {
    method: 'GET',
    pathRe: /^\/__daemon\/settings-snapshot$/,
    handle: async (_m, _ctx, deps) => ({ status: 200, body: { settings: deps.resolveDashboardSettings() } }),
  },
  {
    method: 'GET',
    pathRe: /^\/__daemon\/groups-matrix$/,
    handle: async (_m, _ctx, deps) => {
      const matrix = await deps.buildGroupsMatrix();
      return { status: 200, body: matrix };
    },
  },
  {
    method: 'GET',
    pathRe: /^\/__daemon\/workflows-runs-snapshot$/,
    handle: async (_m, ctx, deps) => {
      const query = {
        all: ctx.url.searchParams.get('all') === '1',
        statuses: parseStatusesParam(ctx.url.searchParams.get('status')),
      };
      return listWorkflowRuns(query, deps.workflowsActionDeps);
    },
  },
  {
    method: 'GET',
    pathRe: /^\/__daemon\/overview-snapshot$/,
    handle: async (_m, ctx, deps) => {
      // Per-bot owner gate (PR3): the same scoping applied to
      // sessions-list / schedules-list MUST also apply when the overview
      // surface bundles those lists, otherwise bot A's owner would observe
      // bot B's sessions/schedules through the aggregated overview.
      const groups = await deps.buildGroupsMatrix();
      return {
        status: 200,
        body: {
          sessions: scopeByCaller(deps.getSessions(), ctx.callerAppId),
          schedules: scopeByCaller(deps.getSchedules(), ctx.callerAppId),
          settings: deps.resolveDashboardSettings(),
          groups,
        },
      };
    },
  },

  // ── WRITE: settings ───────────────────
  {
    method: 'PUT',
    pathRe: /^\/__daemon\/settings-write$/,
    handle: async (_m, ctx, deps) => {
      const ownerUnionId = bodyField<unknown>(ctx.body, 'ownerUnionId');
      const allowed = await isAuthorizedForGlobalSettings(
        { senderUnionId: typeof ownerUnionId === 'string' ? ownerUnionId : undefined },
        deps.settingsOwnerDeps,
      );
      if (!allowed) return { status: 403, body: { ok: false, error: 'owner_only' } };
      const patch = bodyField<unknown>(ctx.body, 'patch');
      const r = applySettingsWrite(patch, deps.settingsApplierDeps);
      if (!r.ok) return { status: 400, body: { ok: false, error: r.error } };
      return { status: 200, body: { ok: true, settings: r.settings } };
    },
  },

  // ── WRITE: sessions × 3 ───────────────
  {
    method: 'POST',
    pathRe: /^\/__daemon\/sessions\/([^/]+)\/(close|resume|locate)$/,
    handle: async (m, ctx, deps) => {
      const sessionId = decodeURIComponent(m[1]);
      const action = m[2];
      const owner = deps.ownerOf(sessionId);
      if (!owner) return { status: 404, body: { ok: false, error: 'unknown_session' } };
      const upstream = await deps.proxyToDaemon(
        owner,
        `/api/sessions/${encodeURIComponent(sessionId)}/${action}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: ctx.bodyRaw.length > 0 ? ctx.bodyRaw : '{}',
        },
      );
      return { status: upstream.status, body: await readUpstream(upstream) };
    },
  },

  // ── WRITE: groups × 5 ─────────────────
  {
    method: 'POST',
    pathRe: /^\/__daemon\/groups\/([^/]+)\/leave$/,
    handle: async (m, ctx, deps) =>
      leaveGroup(decodeURIComponent(m[1]), ctx.body, deps.groupsActionDeps),
  },
  {
    method: 'POST',
    pathRe: /^\/__daemon\/groups\/([^/]+)\/disband$/,
    handle: async (m, ctx, deps) =>
      disbandGroup(decodeURIComponent(m[1]), ctx.body, deps.groupsActionDeps),
  },
  {
    method: 'POST',
    pathRe: /^\/__daemon\/groups\/([^/]+)\/add-bots$/,
    handle: async (m, ctx, deps) =>
      addBotsToGroup(decodeURIComponent(m[1]), ctx.bodyRaw, deps.groupsActionDeps),
  },
  {
    method: 'POST',
    pathRe: /^\/__daemon\/groups\/([^/]+)\/oncall\/([^/]+)\/bind$/,
    handle: async (m, ctx, deps) =>
      bindOncall(decodeURIComponent(m[1]), decodeURIComponent(m[2]), ctx.bodyRaw, deps.groupsActionDeps),
  },
  {
    method: 'POST',
    pathRe: /^\/__daemon\/groups\/([^/]+)\/oncall\/([^/]+)\/unbind$/,
    handle: async (m, _ctx, deps) =>
      unbindOncall(decodeURIComponent(m[1]), decodeURIComponent(m[2]), deps.groupsActionDeps),
  },

  // ── WRITE: workflows × 3 ──────────────
  {
    method: 'POST',
    pathRe: /^\/__daemon\/workflows-runs\/([^/]+)\/(approve|reject)$/,
    handle: async (m, ctx, deps) =>
      runApproveReject(
        decodeURIComponent(m[1]),
        m[2] as 'approve' | 'reject',
        ctx.bodyRaw,
        deps.workflowsActionDeps,
      ),
  },
  {
    method: 'POST',
    pathRe: /^\/__daemon\/workflows-runs\/([^/]+)\/cancel$/,
    handle: async (m, ctx, deps) =>
      runCancel(decodeURIComponent(m[1]), ctx.bodyRaw, deps.workflowsActionDeps),
  },

  // ── WRITE: schedules × 3 ──────────────
  {
    method: 'POST',
    pathRe: /^\/__daemon\/schedules\/([^/]+)\/(run|pause|resume)$/,
    handle: async (m, ctx, deps) => {
      const id = decodeURIComponent(m[1]);
      const action = m[2];
      const owner = deps.scheduleOwnerOf(id);
      if (!owner) return { status: 404, body: { ok: false, error: 'unknown_schedule' } };
      const upstream = await deps.proxyToDaemon(
        owner,
        `/api/schedules/${encodeURIComponent(id)}/${action}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: ctx.bodyRaw.length > 0 ? ctx.bodyRaw : '{}',
        },
      );
      return { status: upstream.status, body: await readUpstream(upstream) };
    },
  },
];

Object.freeze(ROUTES);
for (const r of ROUTES) Object.freeze(r);

/**
 * Pure dispatcher: matches `(method, path)` against the typed allowlist.
 * Returns `unknown_endpoint` (404) when no path matches, `method_not_allowed`
 * (405) when a path matches but the method does not, or hands off to the
 * matched handler.
 */
export async function dispatchDaemonInternalRequest(
  method: string,
  url: URL,
  bodyRaw: string,
  deps: DaemonInternalApiDeps,
  callerAppId?: string,
): Promise<HandlerResult> {
  let body: unknown = undefined;
  if (bodyRaw.length > 0) {
    try { body = JSON.parse(bodyRaw); }
    catch { return { status: 400, body: { ok: false, error: 'bad_json' } }; }
  }

  const ctx: DispatchContext = { bodyRaw, body, url, callerAppId };

  let pathMatchedButMethodWrong = false;
  for (const route of ROUTES) {
    const m = url.pathname.match(route.pathRe);
    if (!m) continue;
    if (route.method !== method) { pathMatchedButMethodWrong = true; continue; }
    return route.handle(m, ctx, deps);
  }

  if (pathMatchedButMethodWrong) {
    return { status: 405, body: { ok: false, error: 'method_not_allowed' } };
  }
  return { status: 404, body: { ok: false, error: 'unknown_endpoint' } };
}

/** Render a HandlerResult onto a ServerResponse. */
function writeHandlerResult(res: ServerResponse, result: HandlerResult): void {
  const headers = { 'content-type': 'application/json', ...(result.headers ?? {}) };
  res.writeHead(result.status, headers);
  res.end(typeof result.body === 'string' ? result.body : JSON.stringify(result.body));
}

export interface DaemonInternalApi {
  /** Production entry point: verify HMAC, JSON-parse, dispatch, write response. */
  handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean>;
  /** Test seam: bypass HMAC, exercise dispatch shape directly. `callerAppId`
   *  emulates the authenticated bot id so read-scoping tests can drive the
   *  per-bot filter without going through HMAC. */
  dispatchForTest(method: string, url: URL, bodyRaw?: string, callerAppId?: string): Promise<HandlerResult>;
}

export function createDaemonInternalApi(deps: DaemonInternalApiDeps): DaemonInternalApi {
  const nonceStore = deps.nonceStore ?? createNonceStore();

  async function handle(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): Promise<boolean> {
    // ⚠️ Source-of-truth for both the `/__daemon/` gate and dispatch routing
    // MUST be `req.url` (the exact bytes the HMAC was computed over). The
    // caller's `url` is only trusted for its `origin` so URL parsing succeeds.
    // Decoupling these allows a signature minted for path X to drive
    // dispatch to path Y if a caller passes a mismatched `url`.
    const reqPath = req.url ?? '/';
    const requestUrl = new URL(reqPath, url.origin);
    if (!requestUrl.pathname.startsWith('/__daemon/')) return false;

    const verify = await verifyDaemonRequest(req, deps.secret, nonceStore, { clock: deps.clock });
    if (!verify.ok) {
      writeHandlerResult(res, {
        status: verify.httpStatus,
        body: { ok: false, error: verify.reason },
      });
      return true;
    }

    const result = await dispatchDaemonInternalRequest(
      req.method ?? 'GET',
      requestUrl,
      verify.bodyRaw,
      deps,
      verify.appId,
    );
    writeHandlerResult(res, result);
    return true;
  }

  async function dispatchForTest(
    method: string,
    url: URL,
    bodyRaw: string = '',
    callerAppId?: string,
  ): Promise<HandlerResult> {
    return dispatchDaemonInternalRequest(method, url, bodyRaw, deps, callerAppId);
  }

  return { handle, dispatchForTest };
}
