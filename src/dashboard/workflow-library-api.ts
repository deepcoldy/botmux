/**
 * Dashboard routes for workflow templates (design 2026-11-03
 * workflow-dashboard-orchestration §5, §7.2, D5).
 *
 *   GET  /api/v3/orchestration/library                       模板列表（读盘，全部 Bot）
 *   GET  /api/v3/orchestration/library/:workflowId           详情 + 版本历史（读盘）
 *   POST /api/v3/orchestration/library/runs/:runId/save/preview  → 该 run 主 Bot 的 daemon
 *   POST /api/v3/orchestration/library/runs/:runId/save          → 同上
 *   POST /api/v3/orchestration/library/:workflowId/run           → 模板所属 Bot 的 daemon
 *
 * 存模板 from a draft goes through the drafts routes
 * (`/drafts/:runId/template/{preview,save}`).
 *
 * Reads need the management login only (§7.2). Writes are routed by what is
 * on disk — a run's bound main bot from its run.json, a template's owning app
 * from its metadata — never by the request, and the daemon resolves the
 * person (D1, incl. the I1 gate) and checks ownership (I9) itself.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';

import { jsonRes } from './http.js';
import type { DashboardRequestIdentity } from './request-identity.js';
import { readDashboardPlatformActor } from '../core/dashboard-platform-actor.js';
import {
  classifyDashboardInitiator,
  dashboardInitiatorHeaders,
  initiatorFailureBody,
} from '../core/workflow-initiator.js';
import { logger } from '../utils/logger.js';
import { BodyTooLargeError, readRawBody, relay } from './workflow-drafts-api.js';
import { listSavedWorkflowCatalogView, loadSavedWorkflowDetailView } from '../workflows/v3/library-catalog.js';
import { SavedWorkflowNotFoundError, readSavedWorkflowMetadata } from '../workflows/v3/library-store.js';
import { SAVED_WORKFLOW_ID_RE } from '../workflows/v3/library-schema.js';
import { readRunEnvelope } from '../workflows/v3/run-envelope.js';
import { isValidRunId } from '../workflows/v3/ops-projection.js';

export const WORKFLOW_LIBRARY_API_PATH = '/api/v3/orchestration/library';

export interface WorkflowLibraryApiDeps {
  identity: DashboardRequestIdentity | null;
  canManageHost: boolean;
  platformBound: boolean;
  featureEnabled: () => boolean;
  /** ~/.botmux: where the library lives (`/workflow save` keeps it there). */
  libraryDataDir: string;
  runsDir: string;
  proxyToDaemon: (larkAppId: string, daemonPath: string, init: RequestInit) => Promise<Response>;
}

export function isWorkflowLibraryPath(pathname: string): boolean {
  return pathname === WORKFLOW_LIBRARY_API_PATH || pathname.startsWith(`${WORKFLOW_LIBRARY_API_PATH}/`);
}

function decode(segment: string): string | undefined {
  try { return decodeURIComponent(segment); } catch { return undefined; }
}

export async function handleWorkflowLibraryApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: WorkflowLibraryApiDeps,
): Promise<boolean> {
  if (!isWorkflowLibraryPath(url.pathname)) return false;
  const method = req.method ?? 'GET';
  if (!deps.canManageHost) {
    jsonRes(res, 401, { ok: false, error: 'auth_required', retryable: false });
    return true;
  }
  if (!deps.featureEnabled()) {
    jsonRes(res, 409, { ok: false, error: 'feature_disabled', retryable: false });
    return true;
  }
  const segments = url.pathname.slice(WORKFLOW_LIBRARY_API_PATH.length).split('/').filter(Boolean);

  if (method === 'GET') {
    if (segments.length === 0) {
      try {
        const listed = await listSavedWorkflowCatalogView(deps.libraryDataDir);
        jsonRes(res, 200, { ok: true, templates: listed.entries, unreadable: listed.unreadable });
      } catch (error) {
        logger.warn(`[workflow-library] list failed: ${error instanceof Error ? error.message : String(error)}`);
        jsonRes(res, 500, { ok: false, error: 'library_unavailable', retryable: true });
      }
      return true;
    }
    const workflowId = segments.length === 1 ? decode(segments[0]!) : undefined;
    if (!workflowId || !SAVED_WORKFLOW_ID_RE.test(workflowId)) {
      jsonRes(res, 404, { ok: false, error: 'not_found', retryable: false });
      return true;
    }
    try {
      jsonRes(res, 200, { ok: true, template: await loadSavedWorkflowDetailView(deps.libraryDataDir, workflowId) });
    } catch (error) {
      if (error instanceof SavedWorkflowNotFoundError) {
        jsonRes(res, 404, { ok: false, error: 'template_not_found', retryable: false });
      } else {
        logger.warn(`[workflow-library] detail ${workflowId} failed: ${error instanceof Error ? error.message : String(error)}`);
        jsonRes(res, 500, { ok: false, error: 'library_unavailable', retryable: true });
      }
    }
    return true;
  }
  if (method !== 'POST') {
    jsonRes(res, 405, { ok: false, error: 'method_not_allowed', retryable: false });
    return true;
  }

  // Which daemon: decided by what is on disk.
  let larkAppId: string | undefined;
  const isRunSave = segments[0] === 'runs' && segments.length >= 3 && segments[2] === 'save'
    && (segments.length === 3 || (segments.length === 4 && segments[3] === 'preview'));
  const isTemplateRun = segments.length === 2 && segments[1] === 'run';
  if (isRunSave) {
    const runId = decode(segments[1]!);
    if (!runId || !isValidRunId(runId)) {
      jsonRes(res, 400, { ok: false, error: 'bad_run_id', retryable: false });
      return true;
    }
    const envelope = readRunEnvelope(join(deps.runsDir, runId), runId);
    larkAppId = envelope.kind === 'ok' ? envelope.envelope.chatBinding?.larkAppId : undefined;
    if (!larkAppId) {
      jsonRes(res, 404, { ok: false, error: 'unknown_run', retryable: false });
      return true;
    }
  } else if (isTemplateRun) {
    const workflowId = decode(segments[0]!);
    if (!workflowId || !SAVED_WORKFLOW_ID_RE.test(workflowId)) {
      jsonRes(res, 404, { ok: false, error: 'template_not_found', retryable: false });
      return true;
    }
    try {
      const metadata = await readSavedWorkflowMetadata(deps.libraryDataDir, workflowId);
      if (metadata.status === 'archived') throw new SavedWorkflowNotFoundError(workflowId);
      // I9: a chat-scoped template runs only in its chat — no daemon is asked.
      if (metadata.scope.kind === 'chat') {
        jsonRes(res, 409, { ok: false, error: 'template_scope', retryable: false });
        return true;
      }
      larkAppId = metadata.owner.larkAppId;
    } catch (error) {
      if (!(error instanceof SavedWorkflowNotFoundError)) {
        logger.warn(`[workflow-library] reading ${workflowId} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      jsonRes(res, 404, { ok: false, error: 'template_not_found', retryable: false });
      return true;
    }
  } else {
    jsonRes(res, 404, { ok: false, error: 'not_found', retryable: false });
    return true;
  }

  // Writes carry a JSON object body (`{}` at least): on the platform a
  // body-less request may take the direct path, where nobody is identified.
  let rawBody: string;
  try { rawBody = await readRawBody(req); } catch (error) {
    jsonRes(res, error instanceof BodyTooLargeError ? 413 : 400, { ok: false, error: error instanceof BodyTooLargeError ? 'body_too_large' : 'bad_body', retryable: false });
    return true;
  }
  let parsed: unknown;
  try { parsed = rawBody.trim() ? JSON.parse(rawBody) : undefined; } catch {
    jsonRes(res, 400, { ok: false, error: 'invalid_json', retryable: false });
    return true;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    jsonRes(res, 400, { ok: false, error: 'json_body_required', retryable: false });
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
    jsonRes(res, claim.status, initiatorFailureBody(claim));
    return true;
  }
  let upstream: Response;
  try {
    upstream = await deps.proxyToDaemon(larkAppId, url.pathname, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...dashboardInitiatorHeaders(claim) },
      body: rawBody,
    });
  } catch {
    jsonRes(res, 502, { ok: false, error: 'daemon_proxy_failed', retryable: true });
    return true;
  }
  await relay(res, upstream);
  return true;
}
