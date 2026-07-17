import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { getConnector, listConnectors, type ConnectorDefinition } from '../services/connector-store.js';
import { getWebhookSecret } from '../services/webhook-key.js';
import type { TriggerRequest, TriggerResponse } from '../services/trigger-types.js';
import {
  appendTriggerLog,
  pruneTriggerLogsByConnectorRetention,
  type TriggerLogRequest,
  type TriggerLogTarget,
} from '../services/trigger-log-store.js';
import { extractDedupKey } from '../services/webhook-lifecycle-extractors.js';
import {
  webhookAuditRequest,
  webhookAuditResponse,
  webhookAuditTarget,
  withWebhookAuditPayload,
} from '../services/webhook-audit.js';
import {
  activateWebhookLifecycleGroup,
  beginWebhookLifecycleFiring,
  failWebhookLifecycleGroup,
} from '../services/webhook-lifecycle-store.js';
import { jsonRes } from './http.js';
import { dispatchTriggerRequest, newTriggerId, queryTriggerResult, type TriggerApiDeps } from './trigger-api.js';

const replayNonces = new Map<string, number>();
const rateBuckets = new Map<string, { windowStart: number; count: number }>();
let lastRetentionPruneAt = 0;

function pruneExpiredWebhookLogs(): void {
  const now = Date.now();
  if (now - lastRetentionPruneAt < 60 * 60 * 1000) return;
  lastRetentionPruneAt = now;
  const policies = Object.fromEntries(listConnectors().map(connector => [connector.id, connector.loggingPolicy?.retentionDays ?? 14]));
  try {
    pruneTriggerLogsByConnectorRetention(policies, { now, maxEntries: 100_000 });
  } catch { /* logging retention must never break webhook delivery */ }
}

export type WebhookRouteDeps = TriggerApiDeps & {
  createLifecycleGroup?: (
    connector: ConnectorDefinition,
    args: { dedupKey: string },
  ) => Promise<{ chatId: string; creatorLarkAppId?: string }>;
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

// Bearer-token mode: the presented token IS the secret. Constant-time compare,
// no body integrity / replay protection (that's the usability/security trade —
// see `token` verify mode). Empty presented token never matches.
export function verifyWebhookToken(secret: string, presented: string): boolean {
  if (!secret || !presented) return false;
  const a = Buffer.from(secret, 'utf-8');
  const b = Buffer.from(presented, 'utf-8');
  return a.length === b.length && timingSafeEqual(a, b);
}

// Token carriers, in priority order: path segment > ?token= query > Authorization
// Bearer > x-botmux-token header. Path is the default (whole URL = credential).
function extractWebhookToken(req: IncomingMessage, url: URL, pathToken: string | undefined): string | undefined {
  if (pathToken) return pathToken;
  const fromQuery = url.searchParams.get('token');
  if (fromQuery) return fromQuery;
  const auth = headerValue(req, 'authorization');
  if (auth) {
    const m = auth.match(/^Bearer\s+(.+)$/i);
    if (m) return m[1].trim();
  }
  const fromHeader = headerValue(req, 'x-botmux-token');
  if (fromHeader) return fromHeader;
  return undefined;
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

function dynamicSessionId(req: IncomingMessage, url: URL, payload: unknown): string | undefined {
  const fromQuery = url.searchParams.get('sessionId') ?? undefined;
  if (fromQuery) return fromQuery;
  const fromHeader = headerValue(req, 'x-botmux-session-id');
  if (fromHeader) return fromHeader;
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const p = payload as any;
    if (typeof p.sessionId === 'string') return p.sessionId;
    if (p.target && typeof p.target === 'object' && typeof p.target.sessionId === 'string') return p.target.sessionId;
  }
  return undefined;
}

function dynamicRootMessageId(req: IncomingMessage, url: URL, payload: unknown): string | undefined {
  const fromQuery = url.searchParams.get('rootMessageId') ?? undefined;
  if (fromQuery) return fromQuery;
  const fromHeader = headerValue(req, 'x-botmux-root-message-id');
  if (fromHeader) return fromHeader;
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const p = payload as any;
    if (typeof p.rootMessageId === 'string') return p.rootMessageId;
    if (p.target && typeof p.target === 'object' && typeof p.target.rootMessageId === 'string') return p.target.rootMessageId;
  }
  return undefined;
}

function parseTriggerResponseOptions(
  req: IncomingMessage,
  url: URL,
): { dryRun?: true; waitForFinalOutput?: true; asyncReturnSessionId?: true; timeoutMs?: number } {
  const rawDryRun = url.searchParams.get('dryRun') ?? headerValue(req, 'x-botmux-dry-run');
  const dryRun = rawDryRun === '1' || rawDryRun === 'true' || rawDryRun === 'yes';
  const rawWait = url.searchParams.get('wait') ?? headerValue(req, 'x-botmux-wait');
  const wait = rawWait === '1' || rawWait === 'true' || rawWait === 'yes';
  const rawAsync = url.searchParams.get('async') ?? headerValue(req, 'x-botmux-async');
  const asyncReturnSessionId = rawAsync === '1' || rawAsync === 'true' || rawAsync === 'yes';
  const rawTimeout = url.searchParams.get('timeoutMs') ?? headerValue(req, 'x-botmux-timeout-ms');
  const timeoutMs = rawTimeout ? Number(rawTimeout) : undefined;
  return {
    ...(dryRun ? { dryRun: true } : {}),
    ...(wait ? { waitForFinalOutput: true } : {}),
    ...(asyncReturnSessionId ? { asyncReturnSessionId: true } : {}),
    ...(Number.isFinite(timeoutMs) ? { timeoutMs } : {}),
  };
}

function webhookError(
  res: ServerResponse,
  status: number,
  connectorId: string | undefined,
  errorCode: TriggerResponse['errorCode'],
  error: string,
  meta?: {
    createdAt: string;
    startedAtMs: number;
    requestId?: string;
    request: TriggerLogRequest;
    target?: TriggerLogTarget;
  },
): void {
  appendTriggerLog({
    triggerId: newTriggerId(),
    connectorId,
    ...(meta?.requestId ? { requestId: meta.requestId } : {}),
    action: 'failed',
    status: 'error',
    error,
    errorCode,
    ...(meta ? {
      request: meta.request,
      ...(meta.target ? { target: meta.target } : {}),
      response: webhookAuditResponse(status, meta.startedAtMs),
      createdAt: meta.createdAt,
    } : {}),
  });
  jsonRes(res, status, { ok: false, errorCode, error });
}

function webhookOkLog(
  connectorId: string,
  action: 'ignored',
  message: string,
  status: number,
  meta: {
    createdAt: string;
    startedAtMs: number;
    requestId?: string;
    request: TriggerLogRequest;
    target?: TriggerLogTarget;
  },
): TriggerResponse {
  const triggerId = newTriggerId();
  appendTriggerLog({
    triggerId,
    connectorId,
    ...(meta.requestId ? { requestId: meta.requestId } : {}),
    action,
    status: 'ok',
    request: meta.request,
    ...(meta.target ? { target: meta.target } : {}),
    response: webhookAuditResponse(status, meta.startedAtMs),
    createdAt: meta.createdAt,
  });
  return { ok: true, triggerId, action, message };
}

export async function handleWebhookRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: WebhookRouteDeps,
): Promise<boolean> {
  // Second path segment (optional) carries the bearer token for `token` mode:
  //   /webhook/<connectorId>            → token via query / Authorization header
  //   /webhook/<connectorId>/<token>    → token baked into the URL (default)
  const m = url.pathname.match(/^\/webhook\/([^/]+)(?:\/([^/]+))?$/);
  if (!m) return false;
  pruneExpiredWebhookLogs();
  const createdAt = new Date().toISOString();
  const startedAtMs = Date.now();
  const connectorId = decodeURIComponent(m[1]);
  let requestId: string | undefined;
  let auditRequest = webhookAuditRequest(req, url);
  let auditTarget: TriggerLogTarget | undefined;
  const auditMeta = () => ({ createdAt, startedAtMs, requestId, request: auditRequest, target: auditTarget });
  const fail = (
    status: number,
    errorCode: TriggerResponse['errorCode'],
    error: string,
  ): void => webhookError(res, status, connectorId, errorCode, error, auditMeta());

  if (req.method !== 'POST' && req.method !== 'GET') {
    fail(405, 'bad_request', 'method not allowed');
    return true;
  }

  const pathToken = m[2] ? decodeURIComponent(m[2]) : undefined;
  const connector = getConnector(connectorId);
  if (!connector || !connector.enabled) {
    fail(404, 'bad_request', 'unknown or disabled connector');
    return true;
  }
  auditRequest = webhookAuditRequest(req, url, connector);
  auditTarget = webhookAuditTarget(connector);

  if (req.method === 'GET') {
    // Async polling has no body, so HMAC mode signs over an empty payload.
    const verify = connector.verify;
    if (verify.type === 'token') {
      const presented = extractWebhookToken(req, url, pathToken);
      const secret = getWebhookSecret(verify.secretRef);
      if (!presented || !secret || !verifyWebhookToken(secret, presented)) {
        fail(401, 'invalid_signature', 'token verification failed');
        return true;
      }
    } else {
      const ts = headerValue(req, verify.timestampHeader);
      const nonce = headerValue(req, verify.nonceHeader);
      const sig = headerValue(req, verify.signatureHeader);
      if (!ts || !nonce || !sig) {
        fail(401, 'invalid_signature', 'missing signature, timestamp, or nonce header');
        return true;
      }
      if (!timestampOk(ts, verify.toleranceSeconds)) {
        fail(401, 'replay', 'timestamp outside tolerance window');
        return true;
      }
      const secret = getWebhookSecret(verify.secretRef);
      if (!secret || !verifyWebhookSignature(secret, ts, Buffer.alloc(0), sig)) {
        fail(401, 'invalid_signature', 'signature verification failed');
        return true;
      }
    }
    const botId = connector.target.botId;
    if (!botId) {
      fail(400, 'target_required', 'target botId is required');
      return true;
    }
    if (connector.target.kind !== 'turn') {
      fail(400, 'bad_request', 'async polling is only supported for turn connectors');
      return true;
    }
    const sessionId = url.searchParams.get('sessionId') ?? undefined;
    const triggerId = url.searchParams.get('triggerId') ?? undefined;
    if (!sessionId) {
      fail(400, 'target_required', 'sessionId is required for async polling');
      return true;
    }
    requestId = triggerId;
    auditTarget = { ...auditTarget, sessionId };
    const result = await queryTriggerResult(botId, sessionId, deps, triggerId);
    appendTriggerLog({
      triggerId: result.body.triggerId ?? triggerId ?? newTriggerId(),
      connectorId,
      ...(requestId ? { requestId } : {}),
      action: result.body.ok ? (result.body.action ?? 'completed') : 'failed',
      status: result.body.ok ? 'ok' : 'error',
      error: result.body.error,
      errorCode: result.body.errorCode,
      request: auditRequest,
      target: auditTarget,
      response: webhookAuditResponse(result.status, startedAtMs, result.body),
      createdAt,
    });
    jsonRes(res, result.status, result.body);
    return true;
  }

  if (!rateAllowed(connector)) {
    fail(429, 'rate_limited', 'connector rate limit exceeded');
    return true;
  }

  let rawBody: Buffer;
  try {
    rawBody = await readRawBody(req, connector.promptEnvelope.maxBodyBytes);
  } catch {
    fail(413, 'bad_request', 'request body too large');
    return true;
  }
  const parsed = parsePayload(rawBody);
  auditRequest = withWebhookAuditPayload(auditRequest, rawBody, parsed.payload, connector);

  // `requestId` becomes source.requestId on the trigger. HMAC mode reuses the
  // caller's nonce; token mode has no nonce so we mint one.
  const verify = connector.verify;
  if (verify.type === 'token') {
    const presented = extractWebhookToken(req, url, pathToken);
    const secret = getWebhookSecret(verify.secretRef);
    if (!presented || !secret || !verifyWebhookToken(secret, presented)) {
      fail(401, 'invalid_signature', 'token verification failed');
      return true;
    }
    requestId = `whk_${randomUUID()}`;
  } else {
    const ts = headerValue(req, verify.timestampHeader);
    const nonce = headerValue(req, verify.nonceHeader);
    const sig = headerValue(req, verify.signatureHeader);
    if (!ts || !nonce || !sig) {
      fail(401, 'invalid_signature', 'missing signature, timestamp, or nonce header');
      return true;
    }
    if (!timestampOk(ts, verify.toleranceSeconds)) {
      fail(401, 'replay', 'timestamp outside tolerance window');
      return true;
    }
    if (!claimNonce(connector.id, nonce, verify.toleranceSeconds)) {
      fail(409, 'replay', 'nonce replay detected');
      return true;
    }
    const secret = getWebhookSecret(verify.secretRef);
    if (!secret || !verifyWebhookSignature(secret, ts, rawBody, sig)) {
      fail(401, 'invalid_signature', 'signature verification failed');
      return true;
    }
    requestId = nonce;
  }

  const responseOptions = parseTriggerResponseOptions(req, url);
  // Stored workflow connectors are tombstones only after the v2 runtime
  // retirement. Fail before lifecycle state or group creation; dispatching to
  // a daemon would make the safety property depend on daemon version/skew.
  if (connector.target.kind === 'workflow') {
    webhookError(
      res,
      410,
      connectorId,
      'legacy_workflow_retired',
      'v2 workflow connector targets are retired; migrate the definition and replace this connector with a turn target',
    );
    return true;
  }
  if ((responseOptions.waitForFinalOutput || responseOptions.asyncReturnSessionId) && connector.target.kind !== 'turn') {
    fail(400, 'bad_request', 'wait mode is only supported for turn connectors');
    return true;
  }
  if (responseOptions.waitForFinalOutput || responseOptions.asyncReturnSessionId) {
    const chatId = connector.target.mode === 'fixed'
      ? connector.target.chatId
      : dynamicChatId(req, url, parsed.payload);
    const sessionId = dynamicSessionId(req, url, parsed.payload);
    const rootMessageId = dynamicRootMessageId(req, url, parsed.payload);
    auditTarget = { ...auditTarget, ...(chatId ? { chatId } : {}), ...(sessionId ? { sessionId } : {}), ...(rootMessageId ? { rootMessageId } : {}) };
    const allowChats = connector.target.allowChats ?? [];
    if (chatId && allowChats.length > 0 && !allowChats.includes(chatId)) {
      fail(403, 'chat_not_allowed', 'chatId is not allowed for this connector');
      return true;
    }
    const trigger: TriggerRequest = {
      source: {
        type: 'webhook',
        connectorId: connector.id,
        requestId,
        receivedAt: new Date().toISOString(),
      },
      target: {
        kind: connector.target.kind,
        botId: connector.target.botId,
        ...(chatId ? { chatId } : {}),
        ...(sessionId ? { sessionId } : {}),
        ...(rootMessageId ? { rootMessageId } : {}),
      },
      envelope: {
        format: 'botmux.webhook.v1',
        sourceName: connector.promptEnvelope.sourceName || connector.name,
        trusted: false,
        headers: pickAllowedHeaders(req, connector.promptEnvelope.headerAllowlist),
        payload: parsed.payload,
        ...(connector.promptEnvelope.includeRawText ? { rawText: parsed.rawText } : {}),
      },
      ...(connector.promptEnvelope.instruction ? { instruction: connector.promptEnvelope.instruction } : {}),
      options: responseOptions,
    };

    const result = await dispatchTriggerRequest(trigger, deps, auditMeta());
    jsonRes(res, result.status, result.body);
    return true;
  }
  if (connector.target.mode === 'new-group') {
    // A turn-targeted dry-run cannot be truthfully preflighted before a chat
    // exists. Never satisfy a read-only request by creating lifecycle state or
    // a Feishu group; reject it explicitly instead.
    if (responseOptions.dryRun && connector.target.kind === 'turn') {
      webhookError(
        res,
        400,
        connectorId,
        'bad_request',
        'dryRun is not supported for new-group turn connectors because no target chat exists yet',
      );
      return true;
    }
    // Dedup is optional. Configured → events with the same extracted value share
    // one group (create once, reuse after). Not configured → every event spins
    // up a fresh group. (No firing/resolved status; groups are never auto-closed.)
    const dedupPath = connector.lifecycleExtractors?.dedupKey;
    let chatId: string | undefined;
    let dedupKey: string | undefined;
    let action: 'create' | 'reuse' = 'create';

    if (dedupPath) {
      const value = extractDedupKey(parsed.payload, dedupPath);
      if (!value) {
        fail(400, 'lifecycle_extract_failed', 'dedup_key_not_found');
        return true;
      }
      dedupKey = value;
    }

    if (dedupPath) {
      // Extraction above either returned or assigned this value. Keep the
      // narrowed alias local to the lifecycle branch so every side-effecting
      // store/group call receives the exact preflighted key.
      const lifecycleDedupKey = dedupKey!;
      const begun = await beginWebhookLifecycleFiring(connector.id, lifecycleDedupKey);
      if (begun.action === 'creating') {
        jsonRes(res, 202, {
          ...webhookOkLog(connector.id, 'ignored', 'lifecycle group creation already in progress', 202, auditMeta()),
          lifecycle: { dedupKey, action: 'creating' },
        });
        return true;
      }
      if (begun.action === 'reuse') {
        action = 'reuse';
        chatId = begun.record.chatId;
      } else {
        if (!deps.createLifecycleGroup) {
          await failWebhookLifecycleGroup(connector.id, lifecycleDedupKey, begun.record.lifecycleId);
          fail(501, 'group_create_failed', 'createLifecycleGroup hook not configured');
          return true;
        }
        let created: { chatId: string; creatorLarkAppId?: string };
        try {
          created = await deps.createLifecycleGroup(connector, { dedupKey: lifecycleDedupKey });
        } catch (e: any) {
          await failWebhookLifecycleGroup(connector.id, lifecycleDedupKey, begun.record.lifecycleId);
          fail(502, 'group_create_failed', e?.message ?? String(e));
          return true;
        }
        const activated = await activateWebhookLifecycleGroup(
          connector.id,
          lifecycleDedupKey,
          begun.record.lifecycleId,
          created.chatId,
          { creatorLarkAppId: created.creatorLarkAppId },
        );
        if (activated.status !== 'active' || !activated.record?.chatId) {
          fail(409, 'replay', 'lifecycle record was replaced before activation');
          return true;
        }
        chatId = activated.record.chatId;
      }
    } else {
      // No dedup: a brand-new group per event (the group name uses the requestId
      // for uniqueness). No lifecycle store record is kept — nothing to reuse.
      if (!deps.createLifecycleGroup) {
        fail(501, 'group_create_failed', 'createLifecycleGroup hook not configured');
        return true;
      }
      try {
        const created = await deps.createLifecycleGroup(connector, { dedupKey: requestId.slice(0, 16) });
        chatId = created.chatId;
      } catch (e: any) {
        fail(502, 'group_create_failed', e?.message ?? String(e));
        return true;
      }
    }

    if (!chatId) {
      fail(500, 'trigger_failed', 'lifecycle group has no chatId');
      return true;
    }
    auditTarget = { ...auditTarget, chatId };

    const trigger: TriggerRequest = {
      source: {
        type: 'webhook',
        connectorId: connector.id,
        requestId,
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
      ...(connector.promptEnvelope.instruction ? { instruction: connector.promptEnvelope.instruction } : {}),
      options: { ...(dedupKey ? { dedupKey } : {}), ...responseOptions },
    };

    const result = await dispatchTriggerRequest(trigger, deps, auditMeta());
    jsonRes(res, result.status, { ...result.body, lifecycle: { ...(dedupKey ? { dedupKey } : {}), action, chatId } });
    return true;
  }

  const chatId = connector.target.mode === 'fixed'
    ? connector.target.chatId
    : dynamicChatId(req, url, parsed.payload);
  const rootMessageId = dynamicRootMessageId(req, url, parsed.payload);
  auditTarget = { ...auditTarget, ...(chatId ? { chatId } : {}), ...(rootMessageId ? { rootMessageId } : {}) };
  if (rootMessageId && !chatId) {
    fail(400, 'target_required', 'rootMessageId requires target chatId');
    return true;
  }
  if (!chatId && !responseOptions.waitForFinalOutput) {
    fail(400, 'target_required', 'target chatId is required');
    return true;
  }
  const allowChats = connector.target.allowChats ?? [];
  if (chatId && allowChats.length > 0 && !allowChats.includes(chatId)) {
    fail(403, 'chat_not_allowed', 'chatId is not allowed for this connector');
    return true;
  }

  const trigger: TriggerRequest = {
    source: {
      type: 'webhook',
      connectorId: connector.id,
      requestId,
      receivedAt: new Date().toISOString(),
    },
    target: {
      kind: connector.target.kind,
      botId: connector.target.botId,
      chatId,
      ...(rootMessageId ? { rootMessageId } : {}),
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
    ...(connector.promptEnvelope.instruction ? { instruction: connector.promptEnvelope.instruction } : {}),
    options: responseOptions,
  };

  const result = await dispatchTriggerRequest(trigger, deps, auditMeta());
  jsonRes(res, result.status, result.body);
  return true;
}
