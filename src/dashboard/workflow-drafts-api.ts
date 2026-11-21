/**
 * Dashboard routes for workflow drafts (design 2026-11-03
 * workflow-dashboard-orchestration §4.6, §7.2, D2).
 *
 *   GET  /api/v3/orchestration/drafts            草稿列表，Dashboard 直接读盘
 *   POST /api/v3/orchestration/drafts            {larkAppId, goal, project?} → 该 Bot 的 daemon
 *   GET  /api/v3/orchestration/drafts/:runId     → 草稿属主 daemon
 *   POST /api/v3/orchestration/drafts/:runId/…   → 草稿属主 daemon（写）
 *   POST /api/v3/orchestration/drafts/from-source {source, larkAppId?} 复制为新工作流（D6）
 *        → larkAppId 的 daemon；不填 = 来源的编排 Bot（run.json 绑定的主 Bot / 模板所属 Bot，读盘）
 *   POST /api/v3/orchestration/drafts/:runId/orchestrator {larkAppId, baseVersion?} 换编排 Bot：
 *        先问新 Bot 的 daemon「我是谁」（I1），再让现编排 Bot prepare（关澄清会话），
 *        最后让新 Bot accept（接管）；中途断了，页面再点一次从断处接着做
 *   GET  /api/v3/orchestration/bots              编排 Bot 下拉框（D3，只读；带「最近一次调用模型失败」）
 *   GET  /api/v3/orchestration/projects?larkAppId=… | ?runId=…  「项目」（只读）→ 该 Bot 的 daemon；
 *        runId = 复制这个运行且没另选 Bot（取它的编排 Bot，同 from-source）
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
  WORKFLOW_INITIATOR_PATH,
} from '../core/workflow-initiator.js';
import { listWorkflowDrafts, workflowDraftOwner, type WorkflowDraftFailureSummary } from '../workflows/v3/draft-store.js';
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
/** 换编排 Bot: the one draft route the Dashboard runs itself (two daemons). */
export const WORKFLOW_DRAFT_ORCHESTRATOR_TAIL = '/orchestrator';
/** Daemon draft routes the page never calls directly (取消更换 stays open). */
const WORKFLOW_DRAFT_INTERNAL_TAILS: ReadonlySet<string> = new Set(['/handoff/prepare', '/handoff/accept']);
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
  if (method === 'POST' && match?.[2] === WORKFLOW_DRAFT_ORCHESTRATOR_TAIL) {
    let runId: string;
    try { runId = decodeURIComponent(match[1]!); } catch {
      jsonRes(res, 400, { ok: false, error: 'bad_run_id', retryable: false });
      return true;
    }
    const headers = initiatorHeadersOrRefuse(req, res, deps);
    if (!headers) return true;
    await switchOrchestrator(res, runId, parsed as Record<string, unknown>, headers, deps);
    return true;
  }

  // The handoff's two steps run only inside POST /orchestrator, which checks
  // the person on the target (I1) first and keeps the token off the page.
  if (match?.[2] !== undefined && WORKFLOW_DRAFT_INTERNAL_TAILS.has(match[2])) {
    jsonRes(res, 404, { ok: false, error: 'not_found', retryable: false });
    return true;
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

  let headers: Record<string, string> = { 'content-type': 'application/json' };
  if (method === 'POST') {
    const withInitiator = initiatorHeadersOrRefuse(req, res, deps);
    if (!withInitiator) return true;
    headers = withInitiator;
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

/** The login as the daemon reads it (D1), or the refusal answered. */
function initiatorHeadersOrRefuse(req: IncomingMessage, res: ServerResponse, deps: WorkflowDraftsApiDeps): Record<string, string> | undefined {
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
    return undefined;
  }
  return { 'content-type': 'application/json', ...dashboardInitiatorHeaders(claim) };
}

async function readUpstream(upstream: Response): Promise<{ status: number; body: Record<string, unknown> | undefined }> {
  const text = await upstream.text();
  let body: unknown;
  try { body = JSON.parse(text); } catch { body = undefined; }
  return { status: upstream.status, body: body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : undefined };
}

function answer(res: ServerResponse, upstream: { status: number; body: Record<string, unknown> | undefined }): void {
  if (!upstream.body) {
    jsonRes(res, 502, { ok: false, error: 'daemon_bad_response', retryable: true });
    return;
  }
  const body = upstream.body;
  if (body.ok === false && typeof body.retryable !== 'boolean') {
    jsonRes(res, upstream.status, { ...body, ok: false, error: body.error ?? 'daemon_error', retryable: upstream.status >= 500 });
    return;
  }
  jsonRes(res, upstream.status, body);
}

/**
 * 换编排 Bot, run by the Dashboard across the two daemons (each checks the
 * person itself; the Dashboard only sequences):
 *   1. the target's daemon resolves the login (I1) — refused: nothing changed;
 *   2. the current owner (from draft.json) prepares: records the target and
 *      closes its clarify session;
 *   3. the target accepts: takes the draft over in one write, starts a new
 *      session with the conversation carried in.
 * Interrupted after 2: the page shows the pending handoff; asking again
 * repeats 2 (same token) and does 3. Already moved: the target answers.
 */
async function switchOrchestrator(
  res: ServerResponse,
  runId: string,
  body: Record<string, unknown>,
  headers: Record<string, string>,
  deps: WorkflowDraftsApiDeps,
): Promise<void> {
  const target = typeof body.larkAppId === 'string' && body.larkAppId.trim() ? body.larkAppId.trim() : undefined;
  if (!target) {
    jsonRes(res, 400, { ok: false, error: 'larkAppId_required', retryable: false });
    return;
  }
  const owner = workflowDraftOwner(deps.runsDir, runId);
  if (!owner) {
    jsonRes(res, 404, { ok: false, error: 'unknown_draft', retryable: false });
    return;
  }
  const draftPath = `${WORKFLOW_DRAFTS_API_PATH}/${encodeURIComponent(runId)}`;
  const call = async (larkAppId: string, path: string, payload: unknown) => {
    try {
      return await readUpstream(await deps.proxyToDaemon(larkAppId, path, { method: 'POST', headers, body: JSON.stringify(payload) }));
    } catch {
      return undefined;
    }
  };
  // Moved already (a second tab, or a retry after the accept landed): the
  // target answers the draft.
  const answerMoved = async () => {
    let upstream: Response;
    try { upstream = await deps.proxyToDaemon(target, draftPath, { method: 'GET', headers: { 'content-type': 'application/json' } }); } catch {
      jsonRes(res, 502, { ok: false, error: 'daemon_proxy_failed', retryable: true });
      return;
    }
    await relay(res, upstream);
  };
  // A step refused as bot_mismatch: the draft changed hands meanwhile — if
  // to the target (another tab's handoff landed), that is this one's answer.
  const movedToTarget = (step: { body: Record<string, unknown> | undefined }) =>
    step.body?.error === 'bot_mismatch' && workflowDraftOwner(deps.runsDir, runId) === target;
  if (owner === target) {
    await answerMoved();
    return;
  }
  const who = await call(target, WORKFLOW_INITIATOR_PATH, { larkAppId: target });
  if (!who) { jsonRes(res, 502, { ok: false, error: 'daemon_proxy_failed', retryable: true }); return; }
  if (who.body?.ok !== true) { answer(res, who); return; }
  const baseVersion = typeof body.baseVersion === 'number' ? body.baseVersion : undefined;
  const prepared = await call(owner, `${draftPath}/handoff/prepare`, { toLarkAppId: target, ...(baseVersion !== undefined ? { baseVersion } : {}) });
  if (!prepared) { jsonRes(res, 502, { ok: false, error: 'daemon_proxy_failed', retryable: true }); return; }
  if (prepared.body?.ok !== true || typeof prepared.body.token !== 'string') {
    if (movedToTarget(prepared)) await answerMoved(); else answer(res, prepared);
    return;
  }
  const accepted = await call(target, `${draftPath}/handoff/accept`, { token: prepared.body.token });
  if (!accepted) { jsonRes(res, 502, { ok: false, error: 'daemon_proxy_failed', retryable: true }); return; }
  if (accepted.body?.ok !== true && movedToTarget(accepted)) { await answerMoved(); return; }
  // A refused accept leaves the handoff ready on the old bot: the page offers
  // 「继续更换」 / 「取消更换」 (and the draft as it stands now).
  if (accepted.body?.ok !== true && prepared.body.draft) {
    answer(res, { status: accepted.status, body: { ...accepted.body, draft: prepared.body.draft } });
    return;
  }
  answer(res, accepted);
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
  /** Its latest model call recorded on a draft failed, and none went through
   *  since (read from the draft records; no model is called to find out).
   *  Shown next to the option, never blocking. */
  recentFailure?: WorkflowDraftFailureSummary;
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
  recentFailures: ReadonlyMap<string, WorkflowDraftFailureSummary> = new Map(),
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
      ...(recentFailures.get(bot.larkAppId) ? { recentFailure: recentFailures.get(bot.larkAppId)! } : {}),
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

// ─── 项目（新建 / 运行模板 / 复制）────────────────────────────────────────

export const WORKFLOW_PROJECTS_API_PATH = '/api/v3/orchestration/projects';

/**
 * GET /api/v3/orchestration/projects — where a new draft of the bot is
 * clarified (its default dir, or the repo picker's candidates), read on that
 * bot's own daemon, which also checks the choice. Read only, management login.
 */
export async function handleWorkflowProjectsApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: Pick<WorkflowDraftsApiDeps, 'canManageHost' | 'featureEnabled' | 'runsDir' | 'proxyToDaemon'>,
): Promise<boolean> {
  if (url.pathname !== WORKFLOW_PROJECTS_API_PATH) return false;
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
  let larkAppId = url.searchParams.get('larkAppId')?.trim() || undefined;
  const runId = url.searchParams.get('runId')?.trim() || undefined;
  if (!larkAppId && runId) {
    larkAppId = runCopyDefaultOrchestrator(deps.runsDir, runId);
    if (!larkAppId) {
      jsonRes(res, 404, { ok: false, error: 'unknown_run', retryable: false });
      return true;
    }
  }
  if (!larkAppId) {
    jsonRes(res, 400, { ok: false, error: 'larkAppId_required', retryable: false });
    return true;
  }
  let upstream: Response;
  try {
    upstream = await deps.proxyToDaemon(larkAppId, WORKFLOW_PROJECTS_API_PATH, { method: 'GET', headers: { 'content-type': 'application/json' } });
  } catch {
    jsonRes(res, 502, { ok: false, error: 'daemon_proxy_failed', retryable: true });
    return true;
  }
  await relay(res, upstream);
  return true;
}
