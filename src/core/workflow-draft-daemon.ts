/**
 * Dashboard workflow drafts on the orchestrating bot's daemon (design
 * 2026-11-03 workflow-dashboard-orchestration §4.2–4.4, §4.6, §7.2, D2):
 * the IPC routes, and the production collaborators of the draft service.
 *
 * Routes (all under {@link WORKFLOW_DRAFTS_PATH}, deliberately outside the
 * workflow daemon-mutation protocol):
 *
 *   POST /drafts                                {larkAppId, goal}       新建
 *   GET  /drafts/:runId                                                 读（管理员）
 *   POST /drafts/:runId/messages                {text}                  对话一轮
 *   POST /drafts/:runId/clarify/continue                                「继续」
 *   POST /drafts/:runId/spec                    {specMarkdown?, relayProblems?}  定稿 / 改完重新校验
 *   POST /drafts/:runId/approve-spec                                    第一道确认
 *   POST /drafts/:runId/architect               {note?}                 编排 / 重新编排
 *   POST /drafts/:runId/architect/cancel                                取消编排
 *   POST /drafts/:runId/nodes/:nodeId/bot       {larkAppId}             换执行 Bot
 *   POST /drafts/:runId/approve-flow            {flowSummarySha256}     第二道确认
 *   POST /drafts/:runId/revise-spec                                     退回改需求
 *   POST /drafts/:runId/abandon                                         放弃
 *   POST /drafts/:runId/delete                                          删除
 *
 * Every write body may carry `baseVersion` (CAS on the draft version).
 *
 * Authorization, in this order, on the daemon (the page's disabled buttons
 * are display only, §7.2):
 *   1. the request passed the trusted-host signature;
 *   2. `workflow.enabled` and `workflow.nodeExecutor = bot`;
 *   3. writes: the D1 initiator resolution (incl. the I1 canOperate gate),
 *      then the service compares it with the draft's recorded initiator (I6).
 * Reads need 1 and 2 only (any Dashboard admin may look, §7.2).
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

import { config } from '../config.js';
import { loadBotConfigs } from '../bot-registry.js';
import { findOnlineDaemon } from '../utils/daemon-discovery.js';
import { v3BotDisplayNameResolver } from '../im/lark/v3-bot-eligibility.js';
import { getBotCapability } from '../services/bot-profile-store.js';
import { logger } from '../utils/logger.js';
import { defaultBaseDir } from '../workflows/v3/grill-state.js';
import { runArchitect } from '../workflows/v3/architect.js';
import {
  WorkflowDraftError,
  WorkflowDraftService,
  type DraftClarifier,
  type DraftClarifyResult,
} from '../workflows/v3/draft-service.js';
import type { WorkflowDraftInitiator } from '../workflows/v3/draft-store.js';
import type { TriggerRequest, TriggerResponse } from '../services/trigger-types.js';
import type { DaemonSession } from './types.js';
import { initiatorFailureBody, type WorkflowInitiatorResolution } from './workflow-initiator.js';

export const WORKFLOW_DRAFTS_PATH = '/api/v3/orchestration/drafts';

/** How often the daemon closes idle clarify processes (§4.2). */
const IDLE_SWEEP_MS = 5 * 60_000;

type Handler = (req: IncomingMessage, res: ServerResponse, params: Record<string, string>) => Promise<void> | void;

export interface WorkflowDraftIpcContext {
  appId: () => string;
  featureEnabled: () => boolean;
  trustedHost: (req: IncomingMessage) => boolean;
  /** D1's `dashboardWorkflowInitiator`. */
  resolveInitiator: (req: IncomingMessage) => Promise<WorkflowInitiatorResolution>;
  service: () => WorkflowDraftService | undefined;
  readJsonBody: (req: IncomingMessage) => Promise<unknown>;
  jsonRes: (res: ServerResponse, status: number, body: unknown) => void;
}

function bodyObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function baseVersionOf(body: Record<string, unknown>): number | undefined | 'bad' {
  if (body.baseVersion === undefined) return undefined;
  return typeof body.baseVersion === 'number' && Number.isInteger(body.baseVersion) && body.baseVersion >= 1
    ? body.baseVersion
    : 'bad';
}

function hasRequestBody(req: IncomingMessage): boolean {
  const length = req.headers['content-length'];
  if (typeof length === 'string' && /^\d+$/.test(length)) return Number(length) > 0;
  return req.headers['transfer-encoding'] !== undefined;
}

function decodeParam(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  try { return decodeURIComponent(value); } catch { return undefined; }
}

/**
 * Register the draft routes on the daemon IPC server. `route` is
 * dashboard-ipc-server's `ipcRoute`.
 */
export function registerWorkflowDraftIpcRoutes(
  route: (method: string, path: string, handler: Handler) => void,
  ctx: WorkflowDraftIpcContext,
): void {
  const fail = (res: ServerResponse, status: number, error: string, extra: Record<string, unknown> = {}) =>
    ctx.jsonRes(res, status, { ok: false, error, retryable: false, ...extra });

  /** Gates 1–2; the service when they pass. */
  const gate = (req: IncomingMessage, res: ServerResponse): WorkflowDraftService | undefined => {
    if (!ctx.trustedHost(req)) { fail(res, 401, 'untrusted_caller'); return undefined; }
    if (!ctx.featureEnabled()) { fail(res, 409, 'feature_disabled'); return undefined; }
    const service = ctx.service();
    if (!service || !ctx.appId()) { fail(res, 503, 'drafts_unavailable'); return undefined; }
    return service;
  };

  const respondError = (res: ServerResponse, error: unknown, what: string) => {
    if (error instanceof WorkflowDraftError) {
      ctx.jsonRes(res, error.status, { ok: false, error: error.code, message: error.message, retryable: error.retryable, ...error.details });
      return;
    }
    logger.warn(`[workflow-draft] ${what} failed: ${error instanceof Error ? error.message : String(error)}`);
    ctx.jsonRes(res, 500, { ok: false, error: 'internal_error', retryable: true });
  };

  /** A write route: gates, the verified initiator, the JSON body. */
  const write = (
    path: string,
    fn: (input: {
      service: WorkflowDraftService;
      initiator: WorkflowDraftInitiator;
      body: Record<string, unknown>;
      baseVersion?: number;
      runId: string;
      params: Record<string, string>;
    }) => Promise<unknown>,
  ) => route('POST', path, async (req, res, params) => {
    const service = gate(req, res);
    if (!service) return;
    const runId = decodeParam(params.runId) ?? '';
    // Every write names its initiator and carries a JSON object body, `{}` at
    // least: a body-less request may have taken the platform's direct path,
    // where nobody is identified (D1 review).
    if (!hasRequestBody(req)) return fail(res, 400, 'json_body_required');
    let raw: unknown;
    try { raw = await ctx.readJsonBody(req); } catch { return fail(res, 400, 'invalid_json'); }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail(res, 400, 'json_body_required');
    const resolved = await ctx.resolveInitiator(req);
    if (!resolved.ok) return ctx.jsonRes(res, resolved.status, initiatorFailureBody(resolved));
    const body = bodyObject(raw);
    const baseVersion = baseVersionOf(body);
    if (baseVersion === 'bad') return fail(res, 400, 'bad_request', { message: 'baseVersion 必须是正整数' });
    try {
      const result = await fn({ service, initiator: resolved.initiator, body, ...(baseVersion ? { baseVersion } : {}), runId, params });
      ctx.jsonRes(res, 200, { ok: true, ...(result && typeof result === 'object' ? result : {}) });
    } catch (error) {
      respondError(res, error, `${path} ${runId}`);
    }
  });

  write(WORKFLOW_DRAFTS_PATH, async ({ service, initiator, body }) => {
    // The Dashboard routed this to the bot it names; a mis-routed create must
    // not birth a draft under another orchestrator.
    if (body.larkAppId !== ctx.appId()) {
      throw new WorkflowDraftError('bot_mismatch', '请求的编排 Bot 不是这个 daemon 的 Bot');
    }
    return { draft: await service.create(initiator, { goal: body.goal }) };
  });

  route('GET', `${WORKFLOW_DRAFTS_PATH}/:runId`, async (req, res, params) => {
    const service = gate(req, res);
    if (!service) return;
    const runId = decodeParam(params.runId) ?? '';
    try {
      ctx.jsonRes(res, 200, { ok: true, draft: await service.view(runId) });
    } catch (error) {
      respondError(res, error, `view ${runId}`);
    }
  });

  const draftPath = (tail: string) => `${WORKFLOW_DRAFTS_PATH}/:runId/${tail}`;
  write(draftPath('messages'), async ({ service, initiator, body, baseVersion, runId }) =>
    ({ draft: await service.sendMessage(runId, initiator, { text: body.text, baseVersion }) }));
  write(draftPath('clarify/continue'), async ({ service, initiator, baseVersion, runId }) =>
    ({ draft: await service.continueClarify(runId, initiator, { baseVersion }) }));
  write(draftPath('spec'), async ({ service, initiator, body, baseVersion, runId }) =>
    service.finalizeSpec(runId, initiator, { specMarkdown: body.specMarkdown, relayProblems: body.relayProblems, baseVersion }));
  write(draftPath('approve-spec'), async ({ service, initiator, baseVersion, runId }) =>
    ({ draft: await service.approveSpec(runId, initiator, { baseVersion }) }));
  write(draftPath('architect'), async ({ service, initiator, body, baseVersion, runId }) =>
    ({ draft: await service.startArchitect(runId, initiator, { note: body.note, baseVersion }) }));
  write(draftPath('architect/cancel'), async ({ service, initiator, runId }) =>
    ({ draft: await service.cancelArchitect(runId, initiator) }));
  write(draftPath('nodes/:nodeId/bot'), async ({ service, initiator, body, baseVersion, runId, params }) => {
    const nodeId = decodeParam(params.nodeId);
    if (!nodeId) throw new WorkflowDraftError('bad_request', 'nodeId 不合法');
    return { draft: await service.setNodeBot(runId, initiator, nodeId, { larkAppId: body.larkAppId, baseVersion }) };
  });
  write(draftPath('approve-flow'), async ({ service, initiator, body, baseVersion, runId }) =>
    ({ draft: await service.approveFlow(runId, initiator, { flowSummarySha256: body.flowSummarySha256, baseVersion }) }));
  write(draftPath('revise-spec'), async ({ service, initiator, baseVersion, runId }) =>
    ({ draft: await service.reviseSpec(runId, initiator, { baseVersion }) }));
  write(draftPath('abandon'), async ({ service, initiator, runId }) =>
    ({ draft: await service.abandon(runId, initiator) }));
  write(draftPath('delete'), async ({ service, initiator, runId }) => {
    await service.delete(runId, initiator);
    return { deleted: runId };
  });
}

// ─── Production collaborators ─────────────────────────────────────────────

export interface ProductionDraftClarifierDeps {
  activeSessions: () => Map<string, DaemonSession> | undefined;
  createHeadlessSession: (
    activeSessions: Map<string, DaemonSession>,
    args: { larkAppId: string; title: string },
  ) => Promise<{ ok: true; headlessId: string; sessionId: string } | { ok: false; error: string }>;
  triggerSessionTurn: (req: TriggerRequest, deps: { larkAppId: string; activeSessions: Map<string, DaemonSession> }) => Promise<TriggerResponse>;
  lookupTriggerResult: (sessionId: string, triggerId: string) => TriggerResponse;
  sessionStatus: (sessionId: string) => string | undefined;
  suspendWorker: (ds: DaemonSession, reason: string) => boolean;
  /** tmux / herdr / zellij / zmx: the process can go dormant. */
  isSuspendable: (ds: DaemonSession) => boolean;
  /** Not remote, not in transfer, no protected dispatch ownership. */
  canRetireWorker: (ds: DaemonSession) => boolean;
  killWorker: (ds: DaemonSession) => void;
  /** A worker of this session is being retired / restarted right now. */
  lifecycleInFlight: (ds: DaemonSession) => boolean;
  closeSession: (sessionId: string) => Promise<unknown>;
  deleteHeadlessRecord: (headlessId: string) => void;
}

/** The clarify session over the daemon's own headless-session machinery
 *  (the same calls `/api/headless/sessions`, `/api/trigger` and
 *  `/trigger-result` make), in process. */
export function createProductionDraftClarifier(deps: ProductionDraftClarifierDeps): DraftClarifier {
  const findActive = (sessionId: string): DaemonSession | undefined => {
    for (const ds of deps.activeSessions()?.values() ?? []) {
      if (ds.session.sessionId === sessionId) return ds;
    }
    return undefined;
  };
  return {
    async create({ larkAppId, title }) {
      const active = deps.activeSessions();
      if (!active) return { ok: false, error: 'registry_unavailable' };
      return deps.createHeadlessSession(active, { larkAppId, title });
    },
    async send({ larkAppId, sessionId, headlessId, prompt, requestId }) {
      const active = deps.activeSessions();
      if (!active) return { ok: false, error: 'registry_unavailable', disconnected: false };
      // A closed session is not resumed here: 「继续」 starts a fresh one with
      // the spec so far (§9).
      const status = deps.sessionStatus(sessionId);
      if (!status || status === 'closed') return { ok: false, error: 'session_closed', disconnected: true };
      // Between retiring a worker (idle release, restart) and the old worker's
      // exit, a turn would race the dying process: ask to retry instead.
      const live = findActive(sessionId);
      if (live && deps.lifecycleInFlight(live)) return { ok: false, error: 'session_lifecycle_in_flight', disconnected: false, busy: true };
      const request: TriggerRequest = {
        source: {
          type: 'headless',
          connectorId: 'botmux-workflow-draft',
          requestId: `${headlessId}:${requestId}`.slice(0, 256),
          receivedAt: new Date().toISOString(),
        },
        target: { kind: 'turn', botId: larkAppId, sessionId },
        envelope: {
          format: 'botmux.headless.v1',
          sourceName: 'botmux workflow draft',
          trusted: false,
          payload: { prompt },
          rawText: prompt,
        },
        instruction: prompt,
        options: { asyncReturnSessionId: true },
      };
      const response = await deps.triggerSessionTurn(request, { larkAppId, activeSessions: active });
      if (response.ok && response.triggerId) return { ok: true, triggerId: response.triggerId };
      return {
        ok: false,
        error: response.error ?? response.errorCode ?? 'trigger_failed',
        disconnected: response.errorCode === 'session_not_found',
      };
    },
    result(sessionId, triggerId): DraftClarifyResult {
      const response = deps.lookupTriggerResult(sessionId, triggerId);
      if (response.state === 'completed') {
        return { state: 'completed', content: response.output?.content ?? '', ...(response.finishedAt ? { finishedAt: response.finishedAt } : {}) };
      }
      if (response.state === 'running') return { state: 'running' };
      if (response.state === 'failed') return { state: 'failed', ...(response.error ? { error: response.error } : {}) };
      return { state: 'not_found' };
    },
    suspend(sessionId) {
      const ds = findActive(sessionId);
      if (!ds) return true; // nothing live: the goal state already holds
      if (!ds.worker || ds.worker.killed) return true;
      if (deps.isSuspendable(ds)) return deps.suspendWorker(ds, 'workflow_draft_idle');
      // A pty-like backend cannot go dormant: retire the worker as /cd does
      // there — the session record stays and the next message cold-starts the
      // CLI with resume. A remote backend (riff / mojo) is never retired this
      // way, nor a session in transfer or holding dispatch ownership.
      if (!deps.canRetireWorker(ds)) return false;
      ds.hasHistory = true;
      deps.killWorker(ds);
      return true;
    },
    async close({ sessionId, headlessId }) {
      if (deps.sessionStatus(sessionId) && deps.sessionStatus(sessionId) !== 'closed') {
        const result = await deps.closeSession(sessionId);
        // A refused close leaves the session active: report it so the draft
        // keeps the id and the sweep retries.
        if (result && typeof result === 'object' && (result as { ok?: unknown }).ok === false) {
          throw new Error(`close refused: ${String((result as { error?: unknown }).error ?? 'unknown')}`);
        }
      }
      if (headlessId) deps.deleteHeadlessRecord(headlessId);
    },
  };
}

let installed: WorkflowDraftService | undefined;
let sweepTimer: ReturnType<typeof setInterval> | undefined;

/** The daemon's draft service (one per daemon process). */
export function workflowDraftService(): WorkflowDraftService | undefined {
  return installed;
}

/**
 * Daemon boot: build the service for this bot, return drafts left 编排中 by
 * the previous process to 待编排 (§9), and start the idle sweep (§4.2). Also
 * the test seam: tests install a service with fake collaborators.
 */
export function installWorkflowDraftService(service: WorkflowDraftService, opts: { sweep?: boolean } = {}): void {
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = undefined;
  installed = service;
  service.recoverInterrupted();
  if (opts.sweep !== false) {
    sweepTimer = setInterval(() => {
      void service.sweepIdleClarify().catch(() => {});
    }, IDLE_SWEEP_MS);
    sweepTimer.unref?.();
  }
}

export function resetWorkflowDraftServiceForTests(): void {
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = undefined;
  installed = undefined;
}

export function createProductionWorkflowDraftService(appId: string, clarifier: DraftClarifier): WorkflowDraftService {
  return new WorkflowDraftService({
    appId,
    baseDir: defaultBaseDir(),
    loadBots: () => loadBotConfigs(),
    nameOf: () => v3BotDisplayNameResolver(),
    roleOf: () => (larkAppId) => getBotCapability(config.session.dataDir, larkAppId) ?? undefined,
    isDaemonOnline: (larkAppId) => {
      try { return findOnlineDaemon(larkAppId, config.session.dataDir) !== null; } catch { return false; }
    },
    clarifier,
    runArchitect,
    log: (message) => logger.info(message),
  });
}
