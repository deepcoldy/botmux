/**
 * Who initiates a workflow from the Dashboard (design 2026-11-03
 * workflow-dashboard-orchestration §7.1, I1–I5).
 *
 * Two halves, joined by the Dashboard's signed host channel to the
 * orchestrating (main) bot's daemon — the same channel and the same platform
 * trust chain as Dashboard schedule creators (core/dashboard-schedule-creator):
 *
 *   Dashboard  {@link classifyDashboardInitiator}: which login this request is.
 *              - local management token          → `dashboard-local`
 *              - platform tunnel + X-Botmux-Actor → `dashboard-platform` (union_id)
 *              - Feishu H5 免登                    → refused (I5)
 *              - platform direct (non-tunnel) request carrying
 *                X-Botmux-Actor                    → refused (see below)
 *              - anything else that names nobody  → refused, never "the owner"
 *   daemon     {@link resolveDashboardWorkflowInitiator}: who that is on the
 *              main bot, with the main bot's own credentials only.
 *              - `dashboard-local`    → the bot owner (`getOwnerOpenId`, I2)
 *              - `dashboard-platform` → union_id → this app's open_id:
 *                  resolved / definitive miss (refuse, I3) / transient (retry)
 *              then the entry gate: the person must `canOperate` the bot (I1).
 *
 * Unlike schedule creators, nothing here falls back to the bot owner: an
 * initiator holds exclusive rights on the run (reassignment, edit approval,
 * delegated identity), so recording the owner for somebody else would be
 * impersonation (design §11 I1/I3).
 *
 * Platform direct path: the platform proxies a request WITHOUT a body to the
 * machine's LAN dashboard port (`directHosts`) instead of the tunnel. Such a
 * request carries the injected management cookie and X-Botmux-Actor but no
 * role, so it looks exactly like a local token login — and would be recorded
 * as the bot owner. On a platform-bound machine, a non-tunnel request that
 * carries X-Botmux-Actor in any shape is therefore refused outright; a local
 * token browser never sends that header. ⚠️ Hence every orchestration route
 * that identifies the initiator MUST be a request with a body (POST + JSON):
 * the platform then goes through the tunnel; without one it goes direct and
 * is refused here.
 *
 * The daemon half is pure over injected lookups so the draft write routes (D2)
 * reuse exactly this decision for every write that names an initiator.
 */

import type { DashboardRequestIdentity } from '../dashboard/request-identity.js';
import type { TargetAppOpenIdResolution } from '../im/lark/client.js';
import { singleUnionId } from './dashboard-platform-actor.js';
import type { V3RunInitiatorSource } from '../workflows/v3/run-envelope.js';

/** Dashboard → daemon: which login the Dashboard established. */
export const DASHBOARD_INITIATOR_SOURCE_HEADER = 'x-botmux-workflow-initiator-source';
/** Dashboard → daemon: the platform-vouched union_id (`dashboard-platform` only). */
export const DASHBOARD_INITIATOR_UNION_HEADER = 'x-botmux-workflow-initiator-union-id';

/** Where a run's initiator came from (run.json `authorization.initiator.source`). */
export type WorkflowInitiatorSource = V3RunInitiatorSource;

export type DashboardInitiatorSource = Exclude<WorkflowInitiatorSource, 'feishu'>;

/** Dashboard route and daemon route share one path. */
export const WORKFLOW_INITIATOR_PATH = '/api/v3/orchestration/initiator';

export type WorkflowInitiatorErrorCode =
  /** `workflow.enabled` or `workflow.nodeExecutor = bot` is off. */
  | 'feature_disabled'
  /** No Dashboard login at all. */
  | 'login_required'
  /** Feishu H5 免登 cannot initiate in v1 (I5). */
  | 'h5_login_unsupported'
  /** A Dashboard login without the management capability (workflow pages are admin-only). */
  | 'admin_required'
  /** The platform reached this machine directly (not through its tunnel):
   *  the person it names cannot be believed, and treating the request as a
   *  local login would record them as the bot owner. */
  | 'platform_direct_unsupported'
  /** The request came through the platform but names no person, or a platform
   *  role login reached the Dashboard outside the tunnel: nobody to record. */
  | 'platform_actor_missing'
  /** The daemon refused a request that did not pass its host signature. */
  | 'untrusted_caller'
  /** Malformed/missing source headers from the Dashboard. */
  | 'initiator_missing'
  /** Local login, but the bot has no resolvable owner to stand for it. */
  | 'owner_unavailable'
  /** The main bot's app definitively cannot see this person (I3). */
  | 'initiator_not_visible'
  /** The union_id → open_id lookup failed transiently. */
  | 'identity_lookup_failed'
  /** The person may not operate the orchestrating bot (I1). */
  | 'cannot_operate'
  /** Dashboard asked a daemon about a bot it does not run. */
  | 'bot_mismatch';

export interface WorkflowInitiatorFailure {
  ok: false;
  error: WorkflowInitiatorErrorCode;
  retryable: boolean;
  /** HTTP status for the route; not part of the body. */
  status: number;
}

const fail = (error: WorkflowInitiatorErrorCode, status: number, retryable = false): WorkflowInitiatorFailure => ({
  ok: false, error, retryable, status,
});

/** Response body for a failure (the status rides on the HTTP response). */
export function initiatorFailureBody(failure: WorkflowInitiatorFailure): { ok: false; error: WorkflowInitiatorErrorCode; retryable: boolean } {
  return { ok: false, error: failure.error, retryable: failure.retryable };
}

// ─── Dashboard half ───────────────────────────────────────────────────────

export type DashboardInitiatorClaim =
  | { ok: true; source: 'dashboard-local' }
  | { ok: true; source: 'dashboard-platform'; unionId: string }
  | WorkflowInitiatorFailure;

/**
 * Which login this Dashboard request is, for initiating a workflow. Pure:
 * `viaPlatformTunnel` / `platformUnionId` come from
 * `readDashboardPlatformActor` (the connection itself), never the request.
 *
 * - A request the platform tunnel delivered is a platform login whatever the
 *   cookie says (m- requests ride the platform's injected management cookie,
 *   so they resolve to `legacy-dashboard`); it must name its person.
 * - A `platform-dashboard` identity (role header) outside the tunnel names
 *   nobody we can believe.
 * - Only a `legacy-dashboard` login off the tunnel is the local token holder.
 */
export function classifyDashboardInitiator(input: {
  identity: Pick<DashboardRequestIdentity, 'kind'> | null;
  canManageHost: boolean;
  viaPlatformTunnel: boolean;
  platformUnionId: string | undefined;
  /** Bound machine, non-tunnel connection, X-Botmux-Actor present in any
   *  shape (`readDashboardPlatformActor().ignoredActorHeader`). */
  directActorHeader: boolean;
}): DashboardInitiatorClaim {
  const kind = input.identity?.kind;
  if (!kind) return fail('login_required', 401);
  // Feishu H5 免登 (the only other identity kind) cannot initiate in v1 (I5).
  if (kind !== 'legacy-dashboard' && kind !== 'platform-dashboard') return fail('h5_login_unsupported', 403);
  if (!input.canManageHost) return fail('admin_required', 403);
  if (input.directActorHeader) return fail('platform_direct_unsupported', 403);
  if (input.viaPlatformTunnel) {
    return input.platformUnionId
      ? { ok: true, source: 'dashboard-platform', unionId: input.platformUnionId }
      : fail('platform_actor_missing', 403);
  }
  if (kind === 'platform-dashboard') return fail('platform_actor_missing', 403);
  return { ok: true, source: 'dashboard-local' };
}

/** Headers the Dashboard forwards to the main bot's daemon for a claim. */
export function dashboardInitiatorHeaders(claim: Extract<DashboardInitiatorClaim, { ok: true }>): Record<string, string> {
  return {
    'content-type': 'application/json',
    [DASHBOARD_INITIATOR_SOURCE_HEADER]: claim.source,
    ...(claim.source === 'dashboard-platform' ? { [DASHBOARD_INITIATOR_UNION_HEADER]: claim.unionId } : {}),
  };
}

// ─── daemon half ──────────────────────────────────────────────────────────

export interface VerifiedWorkflowInitiator {
  /** The main bot app's open_id for this person. App-scoped. */
  openId: string;
  /** Tenant-stable union_id, when the login carried one. */
  unionId?: string;
  source: DashboardInitiatorSource;
}

export type WorkflowInitiatorResolution =
  | { ok: true; initiator: VerifiedWorkflowInitiator }
  | WorkflowInitiatorFailure;

export interface WorkflowInitiatorDaemonDeps {
  /** The main bot's app (the daemon's own). */
  appId: string;
  /** `workflow.enabled` and `workflow.nodeExecutor === 'bot'`. */
  featureEnabled: boolean;
  /** The request passed the daemon's trusted-host signature. */
  trustedHost: boolean;
  /** `getOwnerOpenId` of the main bot. */
  ownerOpenId: (appId: string) => string | undefined;
  /** union_id → open_id through the main bot's OWN app (`resolveTargetAppOpenId`). */
  resolveOpenId: (appId: string, unionId: string) => Promise<TargetAppOpenIdResolution>;
  /** `canOperate` on the main bot. */
  canOperate: (appId: string, openId: string, unionId: string | undefined) => boolean;
}

/**
 * Daemon side: the verified initiator of a Dashboard workflow request, or why
 * there is none. Never returns the bot owner for a platform login.
 */
export async function resolveDashboardWorkflowInitiator(
  headers: { source: unknown; unionId: unknown },
  deps: WorkflowInitiatorDaemonDeps,
): Promise<WorkflowInitiatorResolution> {
  if (!deps.trustedHost) return fail('untrusted_caller', 401);
  if (!deps.featureEnabled) return fail('feature_disabled', 409);
  const source = headers.source;
  let openId: string | undefined;
  let unionId: string | undefined;
  if (source === 'dashboard-local') {
    // I2: the local token holder is the machine owner; they initiate as the
    // bot owner (configured owner while still an admin, else the first admin).
    if (headers.unionId !== undefined) return fail('initiator_missing', 400);
    openId = deps.ownerOpenId(deps.appId);
    if (!openId?.startsWith('ou_')) return fail('owner_unavailable', 409);
  } else if (source === 'dashboard-platform') {
    unionId = singleUnionId(headers.unionId);
    if (!unionId) return fail('initiator_missing', 400);
    let resolved: TargetAppOpenIdResolution;
    try {
      resolved = await deps.resolveOpenId(deps.appId, unionId);
    } catch {
      resolved = { status: 'transient' };
    }
    if (resolved.status === 'transient') return fail('identity_lookup_failed', 503, true);
    if (resolved.status !== 'resolved' || !resolved.openId.startsWith('ou_')) {
      return fail('initiator_not_visible', 403);
    }
    openId = resolved.openId;
  } else {
    return fail('initiator_missing', 400);
  }
  // I1: the entry gate. No fallback to the owner when it fails.
  if (!deps.canOperate(deps.appId, openId, unionId)) return fail('cannot_operate', 403);
  return {
    ok: true,
    initiator: { openId, ...(unionId ? { unionId } : {}), source },
  };
}
