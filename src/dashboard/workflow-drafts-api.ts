/**
 * Dashboard routes for workflow drafts (design 2026-11-03
 * workflow-dashboard-orchestration §4.6, §7.2, D2).
 *
 *   GET  /api/v3/orchestration/drafts            草稿列表，Dashboard 直接读盘
 *   POST /api/v3/orchestration/drafts            {larkAppId, goal} → 该 Bot 的 daemon
 *   GET  /api/v3/orchestration/drafts/:runId     → 草稿属主 daemon
 *   POST /api/v3/orchestration/drafts/:runId/…   → 草稿属主 daemon（写）
 *   POST /api/v3/orchestration/drafts/from-source {source, larkAppId?} 复制为新工作流（D6）
 *        → larkAppId 的 daemon；不填 = 来源的编排 Bot（run.json 绑定的主 Bot / 模板所属 Bot，读盘）
 *   GET  /api/v3/orchestration/bots              编排 Bot 下拉框（D3，只读）
 *
 * The Dashboard only classifies the login (D1 `classifyDashboardInitiator`)
 * and routes; the orchestrating bot's daemon resolves the person, applies the
 * I1 gate and compares with the draft's initiator on every write (I6). The
 * owner of an existing draft comes from its draft.json on disk, never from
 * the request. Reads need the management login only (§7.2).
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { jsonRes } from './http.js';
import type { DashboardRequestIdentity } from './request-identity.js';
import { readDashboardPlatformActor } from '../core/dashboard-platform-actor.js';
import {
  classifyDashboardInitiator,
  dashboardInitiatorHeaders,
  initiatorFailureBody,
} from '../core/workflow-initiator.js';
import { listWorkflowDrafts, workflowDraftOwner } from '../workflows/v3/draft-store.js';
import {
  WorkflowCopySourceError,
  parseWorkflowCopySource,
  runCopyDefaultOrchestrator,
  templateCopyDefaultOrchestrator,
} from '../workflows/v3/draft-copy.js';
import { logger } from '../utils/logger.js';
import type { BotConfig } from '../bot-registry.js';
import { v3BotStaticExclusion } from '../workflows/v3/bot-assignment.js';
import { isV3SupportedCli } from '../workflows/v3/contract.js';
import { isStewardBot } from '../core/decision-board/model.js';

export const WORKFLOW_DRAFTS_API_PATH = '/api/v3/orchestration/drafts';
/** 复制为新工作流 (D6). Not a run id: minted ids always end in 8 hex digits. */
export const WORKFLOW_DRAFTS_FROM_SOURCE_TAIL = '/from-source';
const MAX_BODY_BYTES = 1024 * 1024;

export interface WorkflowDraftsApiDeps {
  identity: DashboardRequestIdentity | null;
  canManageHost: boolean;
  platformBound: boolean;
  featureEnabled: () => boolean;
  runsDir: string;
  /** ~/.botmux: the template library (D6 copies from it). */
  libraryDataDir?: string;
  proxyToDaemon: (larkAppId: string, daemonPath: string, init: RequestInit) => Promise<Response>;
  now?: () => Date;
}

export function isWorkflowDraftsPath(pathname: string): boolean {
  return pathname === WORKFLOW_DRAFTS_API_PATH || pathname.startsWith(`${WORKFLOW_DRAFTS_API_PATH}/`);
}

export class BodyTooLargeError extends Error {}

export async function readRawBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk as Buffer;
    total += buf.length;
    if (total > MAX_BODY_BYTES) throw new BodyTooLargeError();
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

export async function relay(res: ServerResponse, upstream: Response): Promise<void> {
  const text = await upstream.text();
  let body: unknown;
  try { body = JSON.parse(text); } catch { body = undefined; }
  if (!body || typeof body !== 'object') {
    jsonRes(res, 502, { ok: false, error: 'daemon_bad_response', retryable: true });
    return;
  }
  const record = body as Record<string, unknown>;
  // An offline daemon answers through proxyToDaemon's own 503 without `retryable`.
  if (record.ok === false && typeof record.retryable !== 'boolean') {
    jsonRes(res, upstream.status, { ...record, ok: false, error: record.error ?? 'daemon_error', retryable: upstream.status >= 500 });
    return;
  }
  jsonRes(res, upstream.status, body);
}

export async function handleWorkflowDraftsApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: WorkflowDraftsApiDeps,
): Promise<boolean> {
  if (!isWorkflowDraftsPath(url.pathname)) return false;
  const method = req.method ?? 'GET';
  if (!deps.canManageHost) {
    jsonRes(res, 401, { ok: false, error: 'auth_required', retryable: false });
    return true;
  }
  if (!deps.featureEnabled()) {
    jsonRes(res, 409, { ok: false, error: 'feature_disabled', retryable: false });
    return true;
  }
  const tail = url.pathname.slice(WORKFLOW_DRAFTS_API_PATH.length);

  if (tail === '' && method === 'GET') {
    jsonRes(res, 200, { ok: true, drafts: listWorkflowDrafts(deps.runsDir, deps.now?.() ?? new Date()) });
    return true;
  }

  const match = tail.match(/^\/([^/]+)(\/.*)?$/);
  if (tail !== '' && !match) {
    jsonRes(res, 404, { ok: false, error: 'not_found', retryable: false });
    return true;
  }
  if (method !== 'GET' && method !== 'POST') {
    jsonRes(res, 405, { ok: false, error: 'method_not_allowed', retryable: false });
    return true;
  }
  // Reads: the list and one draft. Everything below a draft is a write.
  if (method === 'GET' && match?.[2] !== undefined) {
    jsonRes(res, 405, { ok: false, error: 'method_not_allowed', retryable: false });
    return true;
  }

  // Which daemon: a new draft names its bot; an existing one is routed by
  // the orchestrator recorded in its draft.json.
  let rawBody = '';
  if (method === 'POST') {
    try { rawBody = await readRawBody(req); } catch (error) {
      jsonRes(res, error instanceof BodyTooLargeError ? 413 : 400, { ok: false, error: error instanceof BodyTooLargeError ? 'body_too_large' : 'bad_body', retryable: false });
      return true;
    }
  }
  // Writes carry a JSON object body (`{}` at least): on the platform a
  // body-less request may take the direct path, where nobody is identified.
  let parsed: unknown;
  if (method === 'POST') {
    try { parsed = rawBody.trim() ? JSON.parse(rawBody) : undefined; } catch {
      jsonRes(res, 400, { ok: false, error: 'invalid_json', retryable: false });
      return true;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      jsonRes(res, 400, { ok: false, error: 'json_body_required', retryable: false });
      return true;
    }
  }
  let larkAppId: string | undefined;
  if (tail === WORKFLOW_DRAFTS_FROM_SOURCE_TAIL) {
    if (method !== 'POST') {
      jsonRes(res, 405, { ok: false, error: 'method_not_allowed', retryable: false });
      return true;
    }
    // The orchestrator: the one the page chose, else the source's own —
    // read from disk, never taken from the request.
    const body = parsed as { source?: unknown; larkAppId?: unknown };
    let source: ReturnType<typeof parseWorkflowCopySource>;
    try { source = parseWorkflowCopySource(body.source); } catch (error) {
      jsonRes(res, 400, { ok: false, error: 'bad_request', message: error instanceof WorkflowCopySourceError ? error.message : 'source 不合法', retryable: false });
      return true;
    }
    if (body.larkAppId !== undefined) {
      larkAppId = typeof body.larkAppId === 'string' && body.larkAppId.trim() ? body.larkAppId.trim() : undefined;
      if (!larkAppId) {
        jsonRes(res, 400, { ok: false, error: 'larkAppId_required', retryable: false });
        return true;
      }
    } else if (source.kind === 'run') {
      larkAppId = runCopyDefaultOrchestrator(deps.runsDir, source.runId);
      if (!larkAppId) {
        jsonRes(res, 404, { ok: false, error: 'unknown_run', message: '没有这个运行，或它没有绑定编排 Bot（请指定编排 Bot）', retryable: false });
        return true;
      }
    } else {
      larkAppId = deps.libraryDataDir ? await templateCopyDefaultOrchestrator(deps.libraryDataDir, source.workflowId) : undefined;
      if (!larkAppId) {
        jsonRes(res, 404, { ok: false, error: 'template_not_found', retryable: false });
        return true;
      }
    }
  } else if (tail === '') {
    const named = (parsed as { larkAppId?: unknown } | null)?.larkAppId;
    larkAppId = typeof named === 'string' && named.trim() ? named.trim() : undefined;
    if (!larkAppId) {
      jsonRes(res, 400, { ok: false, error: 'larkAppId_required', retryable: false });
      return true;
    }
  } else {
    let runId: string;
    try { runId = decodeURIComponent(match![1]!); } catch {
      jsonRes(res, 400, { ok: false, error: 'bad_run_id', retryable: false });
      return true;
    }
    larkAppId = workflowDraftOwner(deps.runsDir, runId);
    if (!larkAppId) {
      jsonRes(res, 404, { ok: false, error: 'unknown_draft', retryable: false });
      return true;
    }
  }

  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (method === 'POST') {
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
          `[workflow-drafts] refused platform_direct_unsupported: X-Botmux-Actor on a non-tunnel connection `
          + `(peer=${req.socket?.remoteAddress ?? '?'}:${req.socket?.remotePort ?? '?'})`,
        );
      }
      jsonRes(res, claim.status, initiatorFailureBody(claim));
      return true;
    }
    Object.assign(headers, dashboardInitiatorHeaders(claim));
  }

  let upstream: Response;
  try {
    upstream = await deps.proxyToDaemon(larkAppId, `${url.pathname}`, {
      method,
      headers,
      ...(method === 'POST' ? { body: rawBody } : {}),
    });
  } catch {
    jsonRes(res, 502, { ok: false, error: 'daemon_proxy_failed', retryable: true });
    return true;
  }
  await relay(res, upstream);
  return true;
}

// ─── 编排 Bot 下拉框（§4.1，D3）─────────────────────────────────────────────

export const WORKFLOW_ORCHESTRATOR_BOTS_PATH = '/api/v3/orchestration/bots';

/**
 * Why a configured bot cannot orchestrate, as far as the Dashboard can tell
 * without asking its daemon. `cannot_operate` (I1) is not here: it depends on
 * the person and is answered by the initiator route of the chosen bot.
 */
export type WorkflowOrchestratorUnavailableCode =
  | 'cli_unsupported'
  | 'bypass_disabled'
  | 'codex_profile'
  /** The steward bot does not orchestrate (daemon refuses with orchestrator_ineligible). */
  | 'steward'
  | 'daemon_offline';

export interface WorkflowOrchestratorBotOption {
  larkAppId: string;
  name: string;
  cliId: string;
  online: boolean;
  unavailable?: { code: WorkflowOrchestratorUnavailableCode; why: string };
}

/**
 * The orchestrator picker rows: every bot in bots.json, in file order. The
 * static rules are the ones draft creation enforces on the daemon
 * (`v3BotStaticExclusion`, and the steward bot via `isStewardBot`); the code
 * only picks the label.
 */
export function workflowOrchestratorBotOptions(
  bots: readonly BotConfig[],
  isOnline: (larkAppId: string) => boolean,
  nameOf: (larkAppId: string) => string,
): WorkflowOrchestratorBotOption[] {
  return bots.map((bot) => {
    const online = isOnline(bot.larkAppId);
    const staticWhy = v3BotStaticExclusion(bot);
    const steward = !staticWhy && isStewardBot(bot.steward);
    const why = staticWhy ?? (steward ? '管家 Bot 不能当编排 Bot' : undefined);
    const code: WorkflowOrchestratorUnavailableCode | undefined = staticWhy
      ? (!isV3SupportedCli(bot.cliId) ? 'cli_unsupported' : bot.disableCliBypass === true ? 'bypass_disabled' : 'codex_profile')
      : steward ? 'steward' : online ? undefined : 'daemon_offline';
    return {
      larkAppId: bot.larkAppId,
      name: nameOf(bot.larkAppId),
      cliId: bot.cliId,
      online,
      ...(code ? { unavailable: { code, why: why ?? 'daemon 不在线' } } : {}),
    };
  });
}

export interface WorkflowOrchestratorBotsApiDeps {
  canManageHost: boolean;
  featureEnabled: () => boolean;
  listBots: () => WorkflowOrchestratorBotOption[];
}

/** GET /api/v3/orchestration/bots — read only, management login. */
export function handleWorkflowOrchestratorBotsApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: WorkflowOrchestratorBotsApiDeps,
): boolean {
  if (url.pathname !== WORKFLOW_ORCHESTRATOR_BOTS_PATH) return false;
  if (req.method !== 'GET') {
    jsonRes(res, 405, { ok: false, error: 'method_not_allowed', retryable: false });
    return true;
  }
  if (!deps.canManageHost) {
    jsonRes(res, 401, { ok: false, error: 'auth_required', retryable: false });
    return true;
  }
  if (!deps.featureEnabled()) {
    jsonRes(res, 409, { ok: false, error: 'feature_disabled', retryable: false });
    return true;
  }
  let bots: WorkflowOrchestratorBotOption[];
  try {
    bots = deps.listBots();
  } catch (error) {
    logger.warn(`[workflow-drafts] listing orchestrator bots failed: ${error instanceof Error ? error.message : String(error)}`);
    jsonRes(res, 500, { ok: false, error: 'bots_unavailable', retryable: true });
    return true;
  }
  jsonRes(res, 200, { ok: true, bots });
  return true;
}
