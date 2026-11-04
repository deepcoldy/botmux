/**
 * Dashboard route: who the current login initiates a workflow as on a given
 * orchestrating bot (design 2026-11-03 workflow-dashboard-orchestration §7.1,
 * D1). The Dashboard only classifies the login; the bot's own daemon resolves
 * the person and applies the I1 entry gate (core/workflow-initiator).
 *
 *   GET /api/v3/orchestration/initiator?larkAppId=<app>
 *     200 { ok: true, initiator: { openId, unionId?, source } }
 *     4xx/5xx { ok: false, error, retryable }
 *
 * Read-only: nothing is created. The draft write routes (D2) forward the same
 * headers and the daemon re-runs the same resolution on every write.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { jsonRes } from './http.js';
import type { DashboardRequestIdentity } from './request-identity.js';
import { readDashboardPlatformActor } from '../core/dashboard-platform-actor.js';
import {
  WORKFLOW_INITIATOR_PATH,
  classifyDashboardInitiator,
  dashboardInitiatorHeaders,
  initiatorFailureBody,
} from '../core/workflow-initiator.js';
import { logger } from '../utils/logger.js';

export interface WorkflowInitiatorApiDeps {
  identity: DashboardRequestIdentity | null;
  /** The request gate's management capability (`authed`). */
  canManageHost: boolean;
  platformBound: boolean;
  /** `workflow.enabled` and `workflow.nodeExecutor === 'bot'`. */
  featureEnabled: () => boolean;
  proxyToDaemon: (larkAppId: string, daemonPath: string, init: RequestInit) => Promise<Response>;
}

export function isWorkflowInitiatorPath(pathname: string): boolean {
  return pathname === WORKFLOW_INITIATOR_PATH;
}

/**
 * The outer Dashboard gate answers a Feishu H5 identity on a management route
 * with a generic 401. Called before that gate so this route refuses H5 with
 * its explicit code instead (I5) — a different denial, never an allow.
 */
export function workflowInitiatorPreGateDenial(
  res: ServerResponse,
  pathname: string,
  identity: DashboardRequestIdentity | null,
  canManageHost: boolean,
): boolean {
  if (!isWorkflowInitiatorPath(pathname) || canManageHost || identity?.kind !== 'feishu-h5') return false;
  jsonRes(res, 403, { ok: false, error: 'h5_login_unsupported', retryable: false });
  return true;
}

export async function handleWorkflowInitiatorApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: WorkflowInitiatorApiDeps,
): Promise<boolean> {
  if (!isWorkflowInitiatorPath(url.pathname)) return false;
  if (req.method !== 'GET') {
    jsonRes(res, 405, { ok: false, error: 'method_not_allowed', retryable: false });
    return true;
  }
  const actor = readDashboardPlatformActor(req, deps.platformBound);
  const claim = classifyDashboardInitiator({
    identity: deps.identity,
    canManageHost: deps.canManageHost,
    viaPlatformTunnel: actor.viaPlatformTunnel,
    platformUnionId: actor.unionId,
  });
  if (!claim.ok) {
    jsonRes(res, claim.status, initiatorFailureBody(claim));
    return true;
  }
  if (!deps.featureEnabled()) {
    jsonRes(res, 409, { ok: false, error: 'feature_disabled', retryable: false });
    return true;
  }
  const larkAppId = url.searchParams.get('larkAppId')?.trim() ?? '';
  if (!larkAppId) {
    jsonRes(res, 400, { ok: false, error: 'larkAppId_required', retryable: false });
    return true;
  }
  if (actor.ignoredActorHeader) {
    logger.info(
      `[workflow-initiator] X-Botmux-Actor ignored: not a platform tunnel connection `
      + `(peer=${req.socket?.remoteAddress ?? '?'}:${req.socket?.remotePort ?? '?'}); treated as the local token login`,
    );
  }
  let upstream: Response;
  try {
    upstream = await deps.proxyToDaemon(
      larkAppId,
      `${WORKFLOW_INITIATOR_PATH}?larkAppId=${encodeURIComponent(larkAppId)}`,
      { method: 'GET', headers: dashboardInitiatorHeaders(claim) },
    );
  } catch {
    jsonRes(res, 502, { ok: false, error: 'daemon_proxy_failed', retryable: true });
    return true;
  }
  const text = await upstream.text();
  let body: unknown;
  try { body = JSON.parse(text); } catch { body = undefined; }
  if (!body || typeof body !== 'object') {
    jsonRes(res, 502, { ok: false, error: 'daemon_bad_response', retryable: true });
    return true;
  }
  const record = body as Record<string, unknown>;
  // An offline daemon answers through proxyToDaemon's own 503 without the
  // `retryable` bit; the bot may come back, so say it can be retried.
  if (record.ok === false && typeof record.retryable !== 'boolean') {
    jsonRes(res, upstream.status, { ok: false, error: record.error ?? 'daemon_error', retryable: upstream.status >= 500 });
    return true;
  }
  jsonRes(res, upstream.status, body);
  return true;
}
