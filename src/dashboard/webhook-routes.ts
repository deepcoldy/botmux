import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { getConnector, type ConnectorDefinition } from '../services/connector-store.js';
import { getWebhookSecret } from '../services/webhook-key.js';
import type { TriggerRequest, TriggerResponse } from '../services/trigger-types.js';
import { appendTriggerLog } from '../services/trigger-log-store.js';
import { extractWebhookLifecycle } from '../services/webhook-lifecycle-extractors.js';
import {
  activateWebhookLifecycleGroup,
  beginWebhookLifecycleFiring,
  failWebhookLifecycleGroup,
  resolveWebhookLifecycleGroup,
  type WebhookLifecycleRecord,
} from '../services/webhook-lifecycle-store.js';
import { jsonRes } from './workflow-api.js';
import { dispatchTriggerRequest, newTriggerId, type TriggerApiDeps } from './trigger-api.js';

const replayNonces = new Map<string, number>();
const rateBuckets = new Map<string, { windowStart: number; count: number }>();

export type WebhookRouteDeps = TriggerApiDeps & {
  createLifecycleGroup?: (
    connector: ConnectorDefinition,
    args: { dedupKey: string },
  ) => Promise<{ chatId: string; creatorLarkAppId?: string }>;
  closeLifecycleGroup?: (
    connector: ConnectorDefinition,
    record: WebhookLifecycleRecord,
  ) => Promise<{ ok: boolean; error?: string }>;
};

function headerValue(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}

async function readRawBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const c of req) {
    const b = c as Buffer;
    total += b.length;
    if (total > maxBytes) throw new Error('body_too_large');
    chunks.push(b);
  }
  return Buffer.concat(chunks);
}

function parseSignature(sig: string): Buffer | null {
  const raw = sig.trim().replace(/^sha256=/i, '');
  if (/^[0-9a-f]+$/i.test(raw) && raw.length % 2 === 0) {
    return Buffer.from(raw, 'hex');
  }
  try {
    const b = Buffer.from(raw, 'base64url');
    return b.length > 0 ? b : null;
  } catch {
    return null;
  }
}

export function verifyWebhookSignature(secret: string, ts: string, rawBody: Buffer, sig: string): boolean {
  const expected = createHmac('sha256', secret)
    .update(ts)
    .update('.')
    .update(rawBody)
    .digest();
  const got = parseSignature(sig);
  return !!got && got.length === expected.length && timingSafeEqual(got, expected);
}

function timestampOk(ts: string, toleranceSeconds: number): boolean {
  const n = Number(ts);
  if (!Number.isFinite(n)) return false;
  const tsMs = n > 10_000_000_000 ? n : n * 1000;
  return Math.abs(Date.now() - tsMs) <= toleranceSeconds * 1000;
}

function claimNonce(connectorId: string, nonce: string, ttlSeconds: number): boolean {
  const now = Date.now();
  for (const [key, exp] of replayNonces) {
    if (exp <= now) replayNonces.delete(key);
  }
  const key = `${connectorId}:${nonce}`;
  if (replayNonces.has(key)) return false;
  replayNonces.set(key, now + ttlSeconds * 1000);
  return true;
}

function rateAllowed(connector: ConnectorDefinition): boolean {
  const rl = connector.rateLimit;
  if (!rl || rl.windowSeconds <= 0 || rl.maxRequests <= 0) return true;
  const now = Date.now();
  const cur = rateBuckets.get(connector.id);
  if (!cur || now - cur.windowStart >= rl.windowSeconds * 1000) {
    rateBuckets.set(connector.id, { windowStart: now, count: 1 });
    return true;
  }
  if (cur.count >= rl.maxRequests) return false;
  cur.count += 1;
  return true;
}

function parsePayload(rawBody: Buffer): { payload: unknown; rawText: string } {
  const rawText = rawBody.toString('utf-8');
  try {
    return { payload: JSON.parse(rawText), rawText };
  } catch {
    return { payload: undefined, rawText };
  }
}

function pickAllowedHeaders(req: IncomingMessage, allowlist: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of allowlist) {
    const v = headerValue(req, h);
    if (typeof v === 'string') out[h.toLowerCase()] = v;
  }
  return out;
}

function dynamicChatId(req: IncomingMessage, url: URL, payload: unknown): string | undefined {
  const fromQuery = url.searchParams.get('chatId') ?? undefined;
  if (fromQuery) return fromQuery;
  const fromHeader = headerValue(req, 'x-botmux-chat-id');
  if (fromHeader) return fromHeader;
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const p = payload as any;
    if (typeof p.chatId === 'string') return p.chatId;
    if (p.target && typeof p.target === 'object' && typeof p.target.chatId === 'string') return p.target.chatId;
  }
  return undefined;
}

function webhookError(
  res: ServerResponse,
  status: number,
  connectorId: string | undefined,
  errorCode: TriggerResponse['errorCode'],
  error: string,
): void {
  appendTriggerLog({
    triggerId: newTriggerId(),
    connectorId,
    action: 'failed',
    status: 'error',
    error,
    errorCode,
  });
  jsonRes(res, status, { ok: false, errorCode, error });
}

function webhookOkLog(
  connectorId: string,
  action: 'ignored',
  message: string,
): TriggerResponse {
  const triggerId = newTriggerId();
  appendTriggerLog({
    triggerId,
    connectorId,
    action,
    status: 'ok',
  });
  return { ok: true, triggerId, action, message };
}

export async function handleWebhookRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: WebhookRouteDeps,
): Promise<boolean> {
  const m = url.pathname.match(/^\/webhook\/([^/]+)$/);
  if (!m) return false;
  if (req.method !== 'POST') {
    jsonRes(res, 405, { ok: false, errorCode: 'bad_request', error: 'method not allowed' });
    return true;
  }

  const connectorId = decodeURIComponent(m[1]);
  const connector = getConnector(connectorId);
  if (!connector || !connector.enabled) {
    webhookError(res, 404, connectorId, 'bad_request', 'unknown or disabled connector');
    return true;
  }

  if (!rateAllowed(connector)) {
    webhookError(res, 429, connectorId, 'rate_limited', 'connector rate limit exceeded');
    return true;
  }

  let rawBody: Buffer;
  try {
    rawBody = await readRawBody(req, connector.promptEnvelope.maxBodyBytes);
  } catch {
    webhookError(res, 413, connectorId, 'bad_request', 'request body too large');
    return true;
  }

  const verify = connector.verify;
  const ts = headerValue(req, verify.timestampHeader);
  const nonce = headerValue(req, verify.nonceHeader);
  const sig = headerValue(req, verify.signatureHeader);
  if (!ts || !nonce || !sig) {
    webhookError(res, 401, connectorId, 'invalid_signature', 'missing signature, timestamp, or nonce header');
    return true;
  }
  if (!timestampOk(ts, verify.toleranceSeconds)) {
    webhookError(res, 401, connectorId, 'replay', 'timestamp outside tolerance window');
    return true;
  }
  if (!claimNonce(connector.id, nonce, verify.toleranceSeconds)) {
    webhookError(res, 409, connectorId, 'replay', 'nonce replay detected');
    return true;
  }
  const secret = getWebhookSecret(verify.secretRef);
  if (!secret || !verifyWebhookSignature(secret, ts, rawBody, sig)) {
    webhookError(res, 401, connectorId, 'invalid_signature', 'signature verification failed');
    return true;
  }

  const parsed = parsePayload(rawBody);
  if (connector.target.mode === 'new-group') {
    const extracted = extractWebhookLifecycle(parsed.payload, connector.lifecycleExtractors);
    if (!extracted.ok) {
      webhookError(res, 400, connectorId, 'lifecycle_extract_failed', extracted.error);
      return true;
    }
    const { dedupKey, status } = extracted.lifecycle;

    if (status === 'resolved') {
      const resolved = await resolveWebhookLifecycleGroup(connector.id, dedupKey);
      let closeResult: { ok: boolean; error?: string } | undefined;
      if (resolved.action === 'close' && resolved.record?.chatId) {
        closeResult = deps.closeLifecycleGroup
          ? await deps.closeLifecycleGroup(connector, resolved.record)
          : { ok: false, error: 'closeLifecycleGroup hook not configured' };
      }
      const body = webhookOkLog(connector.id, 'ignored', `lifecycle ${resolved.action}`);
      jsonRes(res, closeResult?.ok === false ? 502 : 200, {
        ...body,
        lifecycle: { dedupKey, status, action: resolved.action, chatId: resolved.record?.chatId },
        ...(closeResult?.ok === false ? { ok: false, errorCode: 'trigger_failed', error: closeResult.error } : {}),
      });
      return true;
    }

    const begun = await beginWebhookLifecycleFiring(connector.id, dedupKey);
    if (begun.action === 'creating') {
      jsonRes(res, 202, {
        ...webhookOkLog(connector.id, 'ignored', 'lifecycle group creation already in progress'),
        lifecycle: { dedupKey, status, action: 'creating' },
      });
      return true;
    }

    let chatId = begun.action === 'reuse' ? begun.record.chatId : undefined;
    if (begun.action === 'create') {
      if (!deps.createLifecycleGroup) {
        await failWebhookLifecycleGroup(connector.id, dedupKey, begun.record.lifecycleId);
        webhookError(res, 501, connector.id, 'group_create_failed', 'createLifecycleGroup hook not configured');
        return true;
      }
      let created: { chatId: string; creatorLarkAppId?: string };
      try {
        created = await deps.createLifecycleGroup(connector, { dedupKey });
      } catch (e: any) {
        await failWebhookLifecycleGroup(connector.id, dedupKey, begun.record.lifecycleId);
        webhookError(res, 502, connector.id, 'group_create_failed', e?.message ?? String(e));
        return true;
      }
      const activated = await activateWebhookLifecycleGroup(
        connector.id,
        dedupKey,
        begun.record.lifecycleId,
        created.chatId,
        { creatorLarkAppId: created.creatorLarkAppId },
      );
      if (activated.status === 'pending_resolved') {
        const closeResult = deps.closeLifecycleGroup && activated.record
          ? await deps.closeLifecycleGroup(connector, activated.record)
          : { ok: true };
        jsonRes(res, closeResult.ok ? 200 : 502, {
          ...webhookOkLog(connector.id, 'ignored', 'lifecycle resolved before group activation'),
          lifecycle: { dedupKey, status: 'resolved', action: 'closed', chatId: created.chatId },
          ...(closeResult.ok ? {} : { ok: false, errorCode: 'trigger_failed', error: closeResult.error }),
        });
        return true;
      }
      if (activated.status !== 'active' || !activated.record?.chatId) {
        webhookError(res, 409, connector.id, 'replay', 'lifecycle record was replaced before activation');
        return true;
      }
      chatId = activated.record.chatId;
    }

    if (!chatId) {
      webhookError(res, 500, connector.id, 'trigger_failed', 'lifecycle group has no chatId');
      return true;
    }

    const trigger: TriggerRequest = {
      source: {
        type: 'webhook',
        connectorId: connector.id,
        requestId: nonce,
        receivedAt: new Date().toISOString(),
      },
      target: {
        kind: connector.target.kind,
        botId: connector.target.botId,
        chatId,
        workflowId: connector.target.workflowId,
      },
      envelope: {
        format: 'botmux.webhook.v1',
        sourceName: connector.promptEnvelope.sourceName || connector.name,
        trusted: false,
        headers: pickAllowedHeaders(req, connector.promptEnvelope.headerAllowlist),
        payload: parsed.payload,
        ...(connector.promptEnvelope.includeRawText ? { rawText: parsed.rawText } : {}),
      },
      options: { dedupKey, status },
    };

    const result = await dispatchTriggerRequest(trigger, deps);
    jsonRes(res, result.status, { ...result.body, lifecycle: { dedupKey, action: begun.action, chatId } });
    return true;
  }

  const chatId = connector.target.mode === 'fixed'
    ? connector.target.chatId
    : dynamicChatId(req, url, parsed.payload);
  if (!chatId) {
    webhookError(res, 400, connectorId, 'target_required', 'target chatId is required');
    return true;
  }
  const allowChats = connector.target.allowChats ?? [];
  if (allowChats.length > 0 && !allowChats.includes(chatId)) {
    webhookError(res, 403, connectorId, 'chat_not_allowed', 'chatId is not allowed for this connector');
    return true;
  }

  const trigger: TriggerRequest = {
    source: {
      type: 'webhook',
      connectorId: connector.id,
      requestId: nonce,
      receivedAt: new Date().toISOString(),
    },
    target: {
      kind: connector.target.kind,
      botId: connector.target.botId,
      chatId,
      workflowId: connector.target.workflowId,
    },
    envelope: {
      format: 'botmux.webhook.v1',
      sourceName: connector.promptEnvelope.sourceName || connector.name,
      trusted: false,
      headers: pickAllowedHeaders(req, connector.promptEnvelope.headerAllowlist),
      payload: parsed.payload,
      ...(connector.promptEnvelope.includeRawText ? { rawText: parsed.rawText } : {}),
    },
    options: {},
  };

  const result = await dispatchTriggerRequest(trigger, deps);
  jsonRes(res, result.status, result.body);
  return true;
}
