import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { TriggerRequest, TriggerResponse } from '../services/trigger-types.js';
import { validateTriggerRequest } from '../services/trigger-types.js';
import { appendTriggerLog } from '../services/trigger-log-store.js';
import { jsonRes } from './workflow-api.js';

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

export async function queryTriggerResult(
  botId: string,
  sessionId: string,
  deps: TriggerApiDeps,
  triggerId?: string,
): Promise<{ status: number; body: TriggerResponse }> {
  const suffix = triggerId ? `?triggerId=${encodeURIComponent(triggerId)}` : '';
  const upstream = await deps.proxyToDaemon(botId, `/api/sessions/${encodeURIComponent(sessionId)}/trigger-result${suffix}`, {
    method: 'GET',
  });
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
  return { status: upstream.status, body: parsed };
}

export async function dispatchTriggerRequest(
  body: TriggerRequest,
  deps: TriggerApiDeps,
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

  const upstream = await deps.proxyToDaemon(botId, '/api/trigger', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
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

  appendTriggerLog({
    triggerId: parsed.triggerId ?? newTriggerId(),
    connectorId: body.source.connectorId,
    action: parsed.ok ? (parsed.action ?? 'delivered') : 'failed',
    status: parsed.ok ? 'ok' : 'error',
    error: parsed.error,
    errorCode: parsed.errorCode,
  });

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
