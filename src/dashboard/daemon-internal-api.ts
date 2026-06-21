/**
 * Daemon-internal API — typed Route B server for `/__daemon/*`.
 *
 * Dispatch pipeline:
 *   1) `verifyDaemonRequest` checks HMAC + loopback + ts ±60s + nonce replay.
 *      Reads the body stream EXACTLY ONCE and returns `bodyRaw`.
 *   2) `bodyRaw` is JSON-parsed (empty body → `undefined`); a parse failure
 *      after a valid HMAC returns 400 `bad_json` without re-reading `req`.
 *   3) Dispatch matches `(method, path)` against a typed allowlist
 *      endpoints — there is intentionally NO generic forward, so a daemon
 *      can never use Route B as a path-shifting proxy.
 *
 * Settings-write also enforces the union_id owner gate: the body must
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
  /** Returns `{ chats, bots }`; groups model requires both for missingOnly accuracy. */
  buildGroupsMatrix: () => Promise<{ chats: unknown[]; bots: unknown[] }>;

  // ─── WRITE ACTIONS (via helpers) ───────────────────────────────────
  settingsApplierDeps: SettingsWriteApplierDeps;
  groupsActionDeps: GroupsActionDeps;
  workflowsActionDeps: WorkflowsActionDeps<any>;

  // ─── SIMPLE PROXY TARGETS ─────────────────────────────────────────
  proxyToDaemon: (larkAppId: string, daemonPath: string, init: RequestInit) => Promise<Response>;
  ownerOf: (sessionId: string) => string | undefined;
  /** Companion of `ownerOf` — tells "row missing" apart from "legacy row".
   *  Same rationale as `scheduleExists`. */
  sessionExists: (sessionId: string) => boolean;
  scheduleOwnerOf: (id: string) => string | undefined;
  /** True iff a schedule row with this id exists at all in the aggregator,
   *  regardless of its `larkAppId` presence. Used by the Route B write gate
   *  to tell apart "legacy schedule (no owner field)" from "unknown id". */
  scheduleExists: (id: string) => boolean;

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
   * `verify.appId` (`daemon-internal-auth.ts:232`). Aggregated read routes
   * use this id for their default per-bot view; `?scope=global` explicitly
   * widens `/dashboard` list reads to the Bot Owner's deployment-wide view.
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
 * Generic per-bot scoping helper — restricts aggregator rows to those owned
 * by the authenticated caller's bot.
 *
 * Default list reads are per-bot: a caller authenticated as bot A should not
 * see bot B rows unless the route explicitly opts into `?scope=global`.
 *
 * Rows whose owner getter returns undefined / empty string (legacy
 * persistence shape) are KEPT so they don't disappear from a freshly-
 * upgraded deploy. callerAppId === undefined means the test seam
 * (`dispatchForTest`) is in use; the test is trusted to assert its own
 * scope so we pass everything through.
 *
 * The owner getter argument lets workflows (nested
 * `chatBinding.larkAppId`) reuse the same filter pipeline as sessions /
 * schedules (top-level `larkAppId`).
 */
function scopeRowsByCaller<T>(
  rows: ReadonlyArray<T>,
  callerAppId: string | undefined,
  getOwnerAppId: (row: T) => string | undefined,
): T[] {
  if (!callerAppId) return rows.slice();
  return rows.filter(r => {
    const owner = getOwnerAppId(r);
    // Keep legacy rows (no owner resolvable) so a fresh deploy doesn't lose them.
    if (typeof owner !== 'string' || owner.length === 0) return true;
    return owner === callerAppId;
  });
}

/**
 * Thin wrapper around `scopeRowsByCaller` for rows with a top-level
 * `larkAppId` field (sessions / schedules / aggregator-shape). Workflows
 * call `scopeRowsByCaller` directly with their own owner getter.
 */
function scopeByCaller(
  rows: ReadonlyArray<unknown>,
  callerAppId: string | undefined,
): unknown[] {
  return scopeRowsByCaller(
    rows,
    callerAppId,
    r => (r as { larkAppId?: unknown })?.larkAppId as string | undefined,
  );
}

/**
 * Per-bot scoping for the `groups-matrix` endpoint.
 *
 * The groups matrix returns `{ chats, bots }` where neither container has a
 * top-level `larkAppId`, so the generic `scopeByCaller` / `scopeRowsByCaller`
 * helpers don't fit. Default fail-closed rules:
 *
 *   - bots: filter to ONLY entries whose `larkAppId === callerAppId`.
 *   - chats: keep ONLY chats where some memberBots entry has
 *     `larkAppId === callerAppId AND inChat === true`. A bot that's listed as
 *     a member but `inChat=false` does NOT qualify.
 *   - each retained chat's `memberBots` is trimmed to JUST the caller's
 *     single entry, so other bots' roster never leaks.
 *   - NO legacy fallback: rows / bots without a recognized `larkAppId` are
 *     dropped (fail-closed). Unlike sessions / schedules, the groups matrix
 *     has no historical persistence shape to preserve.
 *
 * `callerAppId === undefined` is the `dispatchForTest` seam — pass through
 * the full unscoped matrix so tests can assert raw aggregator output.
 *
 * The helper does NOT mutate the input matrix: each kept chat is spread into
 * a new object before its `memberBots` is overwritten.
 */
function scopeGroupsMatrixByCaller(
  matrix: { chats: unknown[]; bots: unknown[] },
  callerAppId: string | undefined,
): { chats: unknown[]; bots: unknown[] } {
  if (callerAppId === undefined) return matrix;
  const filteredBots = matrix.bots.filter(b =>
    typeof (b as { larkAppId?: unknown })?.larkAppId === 'string' &&
    (b as { larkAppId?: unknown }).larkAppId === callerAppId,
  );
  const filteredChats: unknown[] = [];
  for (const c of matrix.chats) {
    const members = (c as { memberBots?: unknown })?.memberBots as
      | Array<{ larkAppId?: string; inChat?: boolean }>
      | undefined;
    if (!Array.isArray(members)) continue;
    const ourMember = members.find(m =>
      m?.larkAppId === callerAppId && m?.inChat === true,
    );
    if (!ourMember) continue;
    filteredChats.push({ ...(c as object), memberBots: [ourMember] });
  }
  return { chats: filteredChats, bots: filteredBots };
}

/** ─── Route table ────────────────────────────────────────────────── */

const ROUTES: RouteDef[] = [
  // ── READ ──────────────────────────────
  {
    method: 'GET',
    pathRe: /^\/__daemon\/sessions-list$/,
    handle: async (_m, ctx, deps) => {
      const isGlobal = ctx.url.searchParams.get('scope') === 'global';
      const sessions = isGlobal
        ? deps.getSessions()
        : scopeByCaller(deps.getSessions(), ctx.callerAppId);
      return { status: 200, body: { sessions } };
    },
  },
  // Dedicated schedules list endpoint. `?scope=global` widens only the read
  // row set; HMAC, admin, invoker, and write owner-routing gates are unchanged.
  {
    method: 'GET',
    pathRe: /^\/__daemon\/schedules-list$/,
    handle: async (_m, ctx, deps) => {
      const isGlobal = ctx.url.searchParams.get('scope') === 'global';
      const schedules = isGlobal
        ? deps.getSchedules()
        : scopeByCaller(deps.getSchedules(), ctx.callerAppId);
      return { status: 200, body: { schedules } };
    },
  },
  {
    method: 'GET',
    pathRe: /^\/__daemon\/settings-snapshot$/,
    handle: async (_m, _ctx, deps) => ({ status: 200, body: { settings: deps.resolveDashboardSettings() } }),
  },
  {
    method: 'GET',
    pathRe: /^\/__daemon\/groups-matrix$/,
    handle: async (_m, ctx, deps) => {
      // Default: per-bot owner gate. Filter the matrix so the caller's bot
      // only sees rows where it's actually a member (`inChat`), and trim
      // each chat's memberBots to the caller's single entry to avoid leaking
      // other bots' membership state.
      //
      // `?scope=global`: `/dashboard` is a Bot Owner global tool panel, so
      // return the full matrix. HMAC / owner / invoker gates are unchanged;
      // only the read row scope widens.
      const matrix = await deps.buildGroupsMatrix();
      const scoped = ctx.url.searchParams.get('scope') === 'global'
        ? matrix
        : scopeGroupsMatrixByCaller(matrix, ctx.callerAppId);
      return { status: 200, body: scoped };
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
      // listWorkflowRuns returns HandlerResult, not a raw array. Filter only
      // successful `{ runs }` bodies; pass through errors and malformed bodies
      // so callers see the real failure instead of an empty list.
      const result = await listWorkflowRuns(query, deps.workflowsActionDeps);
      if (
        result.status === 200 &&
        result.body &&
        typeof result.body === 'object' &&
        Array.isArray((result.body as { runs?: unknown }).runs)
      ) {
        const runs = (result.body as { runs: ReadonlyArray<unknown> }).runs;
        const scoped = ctx.url.searchParams.get('scope') === 'global'
          ? runs.slice()
          : scopeRowsByCaller(
              runs,
              ctx.callerAppId,
              r => (r as { chatBinding?: { larkAppId?: unknown } })?.chatBinding?.larkAppId as string | undefined,
            );
        return {
          status: 200,
          body: { ...(result.body as Record<string, unknown>), runs: scoped },
        };
      }
      return result;
    },
  },
  {
    method: 'GET',
    pathRe: /^\/__daemon\/overview-snapshot$/,
    handle: async (_m, ctx, deps) => {
      // Default: apply the same per-bot scoping as the dedicated list
      // endpoints when overview bundles aggregator state.
      //
      // `?scope=global`: `/dashboard` is a global tool panel. All list
      // modules except settings widen their read scope together; settings
      // remains per-calling-bot until it has an explicit global write model.
      const isGlobal = ctx.url.searchParams.get('scope') === 'global';
      const groups = await deps.buildGroupsMatrix();
      return {
        status: 200,
        body: {
          sessions: isGlobal
            ? deps.getSessions()
            : scopeByCaller(deps.getSessions(), ctx.callerAppId),
          schedules: isGlobal
            ? deps.getSchedules()
            : scopeByCaller(deps.getSchedules(), ctx.callerAppId),
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
      const r = await applySettingsWrite(patch, deps.settingsApplierDeps);
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

      // Three-state routing mirrors schedules:
      //  - owner !== undefined + caller mismatch → 403 session_owner_mismatch
      //  - owner !== undefined + caller match (or test seam) → proxy owner
      //  - owner === undefined + sessionExists + callerAppId set → legacy,
      //    proxy to caller's bot (same bot that fetched the row via the
      //    scoped read endpoint).
      //  - row genuinely missing → 404 unknown_session
      // Route B fails closed too, not only the IM card layer.
      const owner = deps.ownerOf(sessionId);
      if (owner === undefined) {
        if (!deps.sessionExists(sessionId)) {
          return { status: 404, body: { ok: false, error: 'unknown_session' } };
        }
        if (ctx.callerAppId === undefined) {
          // test seam preserves the historical 404 — production callers
          // always have an HMAC-resolved appId.
          return { status: 404, body: { ok: false, error: 'unknown_session' } };
        }
        const upstream = await deps.proxyToDaemon(
          ctx.callerAppId,
          `/api/sessions/${encodeURIComponent(sessionId)}/${action}`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: ctx.bodyRaw.length > 0 ? ctx.bodyRaw : '{}',
          },
        );
        return { status: upstream.status, body: await readUpstream(upstream) };
      }
      const isGlobal = ctx.url.searchParams.get('scope') === 'global';
      if (!isGlobal && ctx.callerAppId !== undefined && owner !== ctx.callerAppId) {
        return { status: 403, body: { ok: false, error: 'session_owner_mismatch' } };
      }
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
  {
    method: 'GET',
    pathRe: /^\/__daemon\/groups\/([^/]+)\/roles\/([^/]+)$/,
    handle: async (m, _ctx, deps) => {
      const chatId = decodeURIComponent(m[1]);
      const appId = decodeURIComponent(m[2]);
      const upstream = await deps.proxyToDaemon(
        appId,
        `/api/roles/${encodeURIComponent(chatId)}`,
        { method: 'GET' },
      );
      return { status: upstream.status, body: await readUpstream(upstream) };
    },
  },
  {
    method: 'PUT',
    pathRe: /^\/__daemon\/groups\/([^/]+)\/roles\/([^/]+)$/,
    handle: async (m, ctx, deps) => {
      const chatId = decodeURIComponent(m[1]);
      const appId = decodeURIComponent(m[2]);
      const upstream = await deps.proxyToDaemon(
        appId,
        `/api/roles/${encodeURIComponent(chatId)}`,
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: ctx.bodyRaw.length > 0 ? ctx.bodyRaw : '{}',
        },
      );
      return { status: upstream.status, body: await readUpstream(upstream) };
    },
  },
  {
    method: 'DELETE',
    pathRe: /^\/__daemon\/groups\/([^/]+)\/roles\/([^/]+)$/,
    handle: async (m, _ctx, deps) => {
      const chatId = decodeURIComponent(m[1]);
      const appId = decodeURIComponent(m[2]);
      const upstream = await deps.proxyToDaemon(
        appId,
        `/api/roles/${encodeURIComponent(chatId)}`,
        { method: 'DELETE' },
      );
      return { status: upstream.status, body: await readUpstream(upstream) };
    },
  },

  // ── WRITE: workflows × 3 ──────────────
  //
  // Cross-bot owner gate. The workflow helpers resolve routing from
  // readRunSnapshot, so Route B checks the owner before proxying. Unlike
  // sessions/schedules, workflows have no legacy "proxy to caller" fallback:
  // a run without chatBinding has no routable owner and should fall through to
  // the helper's existing 409 (`needs_lark_or_cli` / `needs_cli_cancel`).
  //
  //   - snapshot null → 404 unknown_run (don't expose the helper's
  //     non-existent run path)
  //   - owner !== undefined + caller mismatch → 403 workflow_owner_mismatch
  //   - owner !== undefined + caller match (or test seam) → fall through
  //   - owner === undefined → fall through (helper returns 409)
  //
  // Apply the same gate to approve/reject even if the current card only
  // exposes cancel.
  {
    method: 'POST',
    pathRe: /^\/__daemon\/workflows-runs\/([^/]+)\/(approve|reject)$/,
    handle: async (m, ctx, deps) => {
      const runId = decodeURIComponent(m[1]);
      const action = m[2] as 'approve' | 'reject';
      // Preserve bad-input semantics: invalid ids return 400 bad_run_id rather
      // than being shadowed as 404 unknown_run by the owner snapshot lookup.
      if (!deps.workflowsActionDeps.isValidRunId(runId)) {
        return { status: 400, body: { ok: false, error: 'bad_run_id' } };
      }
      const snap = await deps.workflowsActionDeps.readRunSnapshot(
        deps.workflowsActionDeps.runsDir,
        runId,
      );
      if (!snap) return { status: 404, body: { ok: false, error: 'unknown_run' } };
      const owner = snap.chatBinding?.larkAppId;
      const isGlobal = ctx.url.searchParams.get('scope') === 'global';
      if (!isGlobal && owner !== undefined && ctx.callerAppId !== undefined && owner !== ctx.callerAppId) {
        return { status: 403, body: { ok: false, error: 'workflow_owner_mismatch' } };
      }
      return runApproveReject(runId, action, ctx.bodyRaw, deps.workflowsActionDeps);
    },
  },
  {
    method: 'POST',
    pathRe: /^\/__daemon\/workflows-runs\/([^/]+)\/cancel$/,
    handle: async (m, ctx, deps) => {
      const runId = decodeURIComponent(m[1]);
      // Preserve the same bad-input semantics as approve/reject.
      if (!deps.workflowsActionDeps.isValidRunId(runId)) {
        return { status: 400, body: { ok: false, error: 'bad_run_id' } };
      }
      const snap = await deps.workflowsActionDeps.readRunSnapshot(
        deps.workflowsActionDeps.runsDir,
        runId,
      );
      if (!snap) return { status: 404, body: { ok: false, error: 'unknown_run' } };
      const owner = snap.chatBinding?.larkAppId;
      const isGlobal = ctx.url.searchParams.get('scope') === 'global';
      if (!isGlobal && owner !== undefined && ctx.callerAppId !== undefined && owner !== ctx.callerAppId) {
        return { status: 403, body: { ok: false, error: 'workflow_owner_mismatch' } };
      }
      return runCancel(runId, ctx.bodyRaw, deps.workflowsActionDeps);
    },
  },

  // ── WRITE: schedules × 4 ──────────────
  {
    method: 'POST',
    pathRe: /^\/__daemon\/schedules\/([^/]+)\/(run|pause|resume|delivery)$/,
    handle: async (m, ctx, deps) => {
      const id = decodeURIComponent(m[1]);
      const action = m[2];

      // Three-state routing:
      //  - row missing entirely → 404 unknown_schedule
      //  - row present with larkAppId → cross-bot gate (403 on mismatch)
      //  - row present WITHOUT larkAppId (legacy, e.g. pre-v0.4 persistence)
      //    → proxy to the caller's own bot. legacy rows are kept visible
      //    in the read path (`scopeByCaller` short-circuits when caller is
      //    undefined OR when the row has no owner) AND continue to be
      //    executed by `scheduler.belongsToOwner` on the primary daemon.
      //    Without this branch, the user would see the row + actionable
      //    buttons but every POST would 404. With this branch, the caller's
      //    bot proxies the action just like an explicit-owner row would.
      const owner = deps.scheduleOwnerOf(id);
      if (owner === undefined) {
        if (!deps.scheduleExists(id)) {
          return { status: 404, body: { ok: false, error: 'unknown_schedule' } };
        }
        // Legacy row. Production: route to the authenticated caller's bot.
        // Test seam (callerAppId undefined): preserve historical behaviour
        // (404) so existing dispatchForTest tests stay deterministic.
        if (ctx.callerAppId === undefined) {
          return { status: 404, body: { ok: false, error: 'unknown_schedule' } };
        }
        const upstream = await deps.proxyToDaemon(
          ctx.callerAppId,
          `/api/schedules/${encodeURIComponent(id)}/${action}`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: ctx.bodyRaw.length > 0 ? ctx.bodyRaw : '{}',
          },
        );
        return { status: upstream.status, body: await readUpstream(upstream) };
      }
      // Owned row. Cross-bot guard: refuse when the caller is not the
      // owning bot. test seam keeps the historical pass-through.
      //
      // In global dashboard scope, the card can show rows from any bot. We
      // still proxy to the row's true owner daemon, so global only changes
      // "owner exists + caller mismatch" from 403 to "proxy owner".
      const isGlobal = ctx.url.searchParams.get('scope') === 'global';
      if (!isGlobal && ctx.callerAppId !== undefined && owner !== ctx.callerAppId) {
        return { status: 403, body: { ok: false, error: 'schedule_owner_mismatch' } };
      }
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
