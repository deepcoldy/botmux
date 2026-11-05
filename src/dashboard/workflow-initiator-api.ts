/**
 * Dashboard route: who the current login initiates a workflow as on a given
 * orchestrating bot (design 2026-11-03 workflow-dashboard-orchestration §7.1,
 * D1). The Dashboard only classifies the login; the bot's own daemon resolves
 * the person and applies the I1 entry gate (core/workflow-initiator).
 *
 *   POST /api/v3/orchestration/initiator   body { larkAppId }
 *     200 { ok: true, initiator: { openId, unionId?, source } }
 *     4xx/5xx { ok: false, error, retryable }
 *
 * ⚠️ POST with a JSON body although nothing is written: the platform proxies
 * body-less requests over its direct LAN path, where the person it names
 * cannot be believed (refused as `platform_direct_unsupported`, see
 * core/workflow-initiator). Every orchestration route that identifies the
 * initiator must carry a request body so platform traffic takes the tunnel.
 *
 * Nothing is created. The draft write routes (D2) forward the same
 * headers and the daemon re-runs the same resolution on every write.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { jsonRes } from './http.js';
import type { DashboardRequestIdentity } from './request-identity.js';
import { readDashboardPlatformActor } from '../core/dashboard-platform-actor.js';
import { readJsonBodyWithLimit } from './trigger-api.js';
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
  // The whole orchestration surface (initiator + drafts, D2) answers H5 alike.
  if (!pathname.startsWith('/api/v3/orchestration/') || canManageHost || identity?.kind !== 'feishu-h5') return false;
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
  if (req.method !== 'POST') {
    jsonRes(res, 405, { ok: false, error: 'method_not_allowed', retryable: false });
    return true;
  }
  const actor = readDashboardPlatformActor(req, deps.platformBound);
  const claim = classifyDashboardInitiator({
    identity: deps.identity,
    canManageHost: deps.canManageHost,
    viaPlatformTunnel: actor.viaPlatformTunnel,
    platformUnionId: actor.unionId,
    directActorHeader: actor.ignoredActorHeader,
  });
  if (!claim.ok) {
    if (claim.error === 'platform_direct_unsupported') {
      logger.warn(
        `[workflow-initiator] refused: X-Botmux-Actor on a non-tunnel connection of a platform-bound machine `
        + `(peer=${req.socket?.remoteAddress ?? '?'}:${req.socket?.remotePort ?? '?'}); the platform's direct path `
        + 'cannot vouch for a person, and treating it as a local login would record the bot owner',
      );
    }
    jsonRes(res, claim.status, initiatorFailureBody(claim));
    return true;
  }
  if (!deps.featureEnabled()) {
    jsonRes(res, 409, { ok: false, error: 'feature_disabled', retryable: false });
    return true;
  }
  let body: unknown;
  try {
    body = await readJsonBodyWithLimit(req, 16 * 1024);
  } catch {
    jsonRes(res, 400, { ok: false, error: 'bad_json', retryable: false });
    return true;
  }
  const rawAppId = body && typeof body === 'object' && !Array.isArray(body)
    ? (body as Record<string, unknown>).larkAppId
    : undefined;
  const larkAppId = typeof rawAppId === 'string' ? rawAppId.trim() : '';
  if (!larkAppId) {
    jsonRes(res, 400, { ok: false, error: 'larkAppId_required', retryable: false });
    return true;
  }
  let upstream: Response;
  try {
    upstream = await deps.proxyToDaemon(
      larkAppId,
      WORKFLOW_INITIATOR_PATH,
      { method: 'POST', headers: dashboardInitiatorHeaders(claim), body: JSON.stringify({ larkAppId }) },
    );
  } catch {
    jsonRes(res, 502, { ok: false, error: 'daemon_proxy_failed', retryable: true });
    return true;
  }
  const text = await upstream.text();
  let answer: unknown;
  try { answer = JSON.parse(text); } catch { answer = undefined; }
  if (!answer || typeof answer !== 'object') {
    jsonRes(res, 502, { ok: false, error: 'daemon_bad_response', retryable: true });
    return true;
  }
  const record = answer as Record<string, unknown>;
  // An offline daemon answers through proxyToDaemon's own 503 without the
  // `retryable` bit; the bot may come back, so say it can be retried.
  if (record.ok === false && typeof record.retryable !== 'boolean') {
    jsonRes(res, upstream.status, { ok: false, error: record.error ?? 'daemon_error', retryable: upstream.status >= 500 });
    return true;
  }
  jsonRes(res, upstream.status, answer);
  return true;
}
