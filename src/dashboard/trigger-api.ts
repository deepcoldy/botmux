import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { TriggerRequest, TriggerResponse } from '../services/trigger-types.js';
import { validateTriggerRequest } from '../services/trigger-types.js';
import {
  appendTriggerLog,
  type TriggerLogRequest,
  type TriggerLogTarget,
} from '../services/trigger-log-store.js';
import { jsonRes } from './http.js';
import { logger } from '../utils/logger.js';

const MAX_TRIGGER_BODY_BYTES = 512 * 1024;

export async function readJsonBodyWithLimit<T = unknown>(
  req: IncomingMessage,
  maxBytes: number = MAX_TRIGGER_BODY_BYTES,
): Promise<T> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const c of req) {
    const b = c as Buffer;
    total += b.length;
    if (total > maxBytes) throw new Error('body_too_large');
    chunks.push(b);
  }
  if (chunks.length === 0) return {} as T;
  return JSON.parse(Buffer.concat(chunks).toString('utf-8'));
}

export function newTriggerId(): string {
  return `trg_${randomUUID()}`;
}

export type TriggerApiDeps = {
  proxyToDaemon: (larkAppId: string, daemonPath: string, init: RequestInit) => Promise<Response>;
};

export type TriggerDispatchLogContext = {
  createdAt?: string;
  startedAtMs?: number;
  requestId?: string;
  request?: TriggerLogRequest;
  target?: TriggerLogTarget;
};

export async function queryTriggerResult(
  botId: string,
  sessionId: string,
  deps: TriggerApiDeps,
  triggerId?: string,
): Promise<{ status: number; body: TriggerResponse }> {
  const suffix = triggerId ? `?triggerId=${encodeURIComponent(triggerId)}` : '';
  let upstream: Response;
  try {
    upstream = await deps.proxyToDaemon(botId, `/api/sessions/${encodeURIComponent(sessionId)}/trigger-result${suffix}`, {
      method: 'GET',
    });
  } catch (error: any) {
    return {
      status: 502,
      body: {
        ok: false,
        triggerId: triggerId ?? newTriggerId(),
        errorCode: 'daemon_offline',
        error: error?.message ?? 'target daemon is unavailable',
      },
    };
  }
  const text = await upstream.text();
  let parsed: TriggerResponse;
  try {
    parsed = JSON.parse(text) as TriggerResponse;
  } catch {
    parsed = {
      ok: false,
      triggerId: newTriggerId(),
      error: `non-json upstream response (${upstream.status})`,
      errorCode: 'trigger_failed',
    };
  }
  // Legacy-consumer adapter: the daemon's four-state trigger-result returns
  // `ok:true` + HTTP 200 for terminal `failed`/`not_found` (task state lives in
  // `.state`). Existing webhook async pollers + audit logging predate `.state`
  // and branch on BOTH `ok` AND the HTTP status — the pre-four-state baseline was
  // `404 + ok:false` for a missing session. Leaving `200 + ok:true` here would
  // record a failed/lost task as `completed` AND break clients that switch on
  // status. So for THIS webhook path we restore the legacy shape: `ok:false` plus
  // a non-200 status (not_found→404, matching the old session_not_found; failed→
  // 404 too, since to a legacy poller "terminated with no output" is equally "no
  // result to fetch"). `.state` is preserved for consumers that have adopted it.
  // The new four-state contract (raw dashboard proxy → task-runner callers) does
  // NOT pass through queryTriggerResult and is therefore unaffected.
  let status = upstream.status;
  if (parsed.ok && (parsed.state === 'failed' || parsed.state === 'not_found')) {
    parsed = { ...parsed, ok: false };
    if (status === 200) status = 404;
  }
  return { status, body: parsed };
}

export async function dispatchTriggerRequest(
  body: TriggerRequest,
  deps: TriggerApiDeps,
  logContext?: TriggerDispatchLogContext,
): Promise<{ status: number; body: TriggerResponse }> {
  // Both turn and workflow are proxied by botId to the owning daemon's
  // /api/trigger; the daemon IPC handler dispatches turn vs workflow.
  const botId = body.target.botId;
  if (!botId) {
    return {
      status: 400,
      body: { ok: false, errorCode: 'target_required', error: `${body.target.kind} target requires target.botId` },
    };
  }

  let upstream: Response;
  try {
    upstream = await deps.proxyToDaemon(botId, '/api/trigger', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (error: any) {
    upstream = new Response(JSON.stringify({
      ok: false,
      triggerId: newTriggerId(),
      errorCode: 'daemon_offline',
      error: error?.message ?? 'target daemon is unavailable',
    }), { status: 502, headers: { 'content-type': 'application/json' } });
  }
  const text = await upstream.text();
  let parsed: TriggerResponse;
  try {
    parsed = JSON.parse(text) as TriggerResponse;
  } catch {
    parsed = {
      ok: false,
      triggerId: newTriggerId(),
      error: `non-json upstream response (${upstream.status})`,
      errorCode: 'trigger_failed',
    };
  }

  // Audit logging is BEST-EFFORT and must never reverse a delivery decision. By
  // this point the daemon has already accepted (or rejected) the turn, so a
  // throw here — disk full, EIO, EACCES — would turn a proven outcome into a 5xx
  // and, for an idempotent webhook, release the key so an at-least-once sender
  // re-runs a turn that really did queue. Same principle the retention prune
  // already states ("logging must never break webhook delivery").
  try {
    appendTriggerLog({
      triggerId: parsed.triggerId ?? newTriggerId(),
      connectorId: body.source.connectorId,
      requestId: logContext?.requestId ?? body.source.requestId,
      action: parsed.ok ? (parsed.action ?? 'delivered') : 'failed',
      status: parsed.ok ? 'ok' : 'error',
      error: parsed.error,
      errorCode: parsed.errorCode,
      ...(logContext?.request ? { request: logContext.request } : {}),
      ...(logContext?.target ? { target: logContext.target } : {}),
      ...(logContext?.startedAtMs !== undefined ? {
        response: {
          httpStatus: upstream.status,
          durationMs: Math.max(0, Date.now() - logContext.startedAtMs),
          ...(parsed.target?.sessionId ? { sessionId: parsed.target.sessionId } : {}),
          ...(parsed.target?.workflowRunId ? { workflowRunId: parsed.target.workflowRunId } : {}),
          ...(parsed.target?.chatId ? { chatId: parsed.target.chatId } : {}),
        },
      } : {}),
      ...(logContext?.createdAt ? { createdAt: logContext.createdAt } : {}),
    });
  } catch (err) {
    logger.warn(`[trigger] audit log write failed (delivery unaffected): ${(err as Error).message}`);
  }

  return { status: upstream.status, body: parsed };
}

export async function handleDashboardTriggerApi(
  req: IncomingMessage,
  res: ServerResponse,
  deps: TriggerApiDeps,
): Promise<void> {
  let raw: unknown;
  try {
    raw = await readJsonBodyWithLimit(req);
  } catch (e: any) {
    const error = e?.message === 'body_too_large' ? 'request body too large' : 'invalid JSON body';
    return jsonRes(res, 400, { ok: false, errorCode: 'bad_json', error });
  }

  const valid = validateTriggerRequest(raw);
  if (!valid.ok) return jsonRes(res, valid.status, valid.body);

  const body = valid.request;
  const result = await dispatchTriggerRequest(body, deps);
  return jsonRes(res, result.status, result.body);
}
