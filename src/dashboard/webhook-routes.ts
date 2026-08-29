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
  dispatchDidRun,
  inspectWebhookIdempotency,
  settleWebhookIdempotency,
  type WebhookIdempotencyDecision,
} from '../services/webhook-idempotency.js';
import {
  renderConnectorTopicTemplate,
  type ResolveConnectorMentionIdentities,
} from '../services/connector-topic-template.js';
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
import { logger } from '../utils/logger.js';
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
  resolveMentionIdentities?: ResolveConnectorMentionIdentities;
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

/** Two-stage limiting, because one bucket cannot serve both purposes.
 *
 *  `admission` runs at the very edge (before the body is read or the signature is
 *  checked) and meters EVERY request, so an unauthenticated flood cannot make the
 *  gateway do unbounded body reads and audit writes. Moving the single old limiter
 *  behind verification — to stop a collapsed duplicate from being answered 429 —
 *  silently removed that protection: a bad-token flood then returned 401 forever
 *  with the limiter never engaging (verified by probe).
 *
 *  `dispatch` meters only deliveries that will actually reach a daemon. A
 *  duplicate we are going to collapse consumes no downstream resource, so it must
 *  not spend this quota (and must never be answered 429, which an at-least-once
 *  sender reads as "not delivered").
 *
 *  Both stages share the connector's configured limit; the admission bucket is
 *  deliberately more permissive (x4) so an honest sender that trips a retry never
 *  gets rejected at the edge before its duplicate can be recognised and folded. */
const rateBucketsAdmission = new Map<string, { windowStart: number; count: number }>();

function consumeBucket(
  buckets: Map<string, { windowStart: number; count: number }>,
  key: string,
  windowSeconds: number,
  maxRequests: number,
): boolean {
  const now = Date.now();
  const cur = buckets.get(key);
  if (!cur || now - cur.windowStart >= windowSeconds * 1000) {
    buckets.set(key, { windowStart: now, count: 1 });
    return true;
  }
  if (cur.count >= maxRequests) return false;
  cur.count += 1;
  return true;
}

/** Edge admission: metered before any body read / signature verification. */
function admissionAllowed(connector: ConnectorDefinition): boolean {
  const rl = connector.rateLimit;
  if (!rl || rl.windowSeconds <= 0 || rl.maxRequests <= 0) return true;
  return consumeBucket(rateBucketsAdmission, connector.id, rl.windowSeconds, rl.maxRequests * 4);
}

/** Dispatch quota: consumed only by a delivery that will really be dispatched. */
function rateAllowed(connector: ConnectorDefinition): boolean {
  const rl = connector.rateLimit;
  if (!rl || rl.windowSeconds <= 0 || rl.maxRequests <= 0) return true;
  return consumeBucket(rateBuckets, connector.id, rl.windowSeconds, rl.maxRequests);
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

/** Resolve the connector-owned topic seed once at the trusted webhook edge.
 * The request body can never override this presentation setting. */
export function connectorTriggerPresentation(
  connector: ConnectorDefinition,
): TriggerRequest['presentation'] | undefined {
  const mode = connector.topicMessage?.mode ?? 'default';
  if (mode === 'none') return { topicMessage: null };
  if (mode !== 'custom') return undefined;
  const text = connector.topicMessage?.text?.trim();
  if (!text) return undefined;
  const source = connector.promptEnvelope.sourceName || connector.name;
  const resolved = text.replaceAll('{source}', source);
  return { topicMessage: Array.from(resolved).slice(0, 200).join('') };
}

interface ConnectorMentionIdentityDeps {
  resolveRaw: (botId: string, identities: string[]) => Promise<{ map: Map<string, string> }>;
  getProfile: (botId: string, userId: string, idType: 'open_id') => Promise<{ status: string }>;
}

/** Resolve indirect identities normally, but require direct open_ids from the
 * untrusted payload to be visible through this target Bot before accepting them. */
export async function resolveConnectorMentionIdentities(
  botId: string,
  identities: string[],
  deps: ConnectorMentionIdentityDeps,
): Promise<Map<string, string>> {
  const directOpenIds = identities.filter(identity => identity.startsWith('ou_'));
  const indirectIdentities = identities.filter(identity => !identity.startsWith('ou_'));
  const resolved = indirectIdentities.length > 0
    ? new Map((await deps.resolveRaw(botId, indirectIdentities)).map)
    : new Map<string, string>();
  await Promise.all(directOpenIds.map(async openId => {
    if (!/^ou_[A-Za-z0-9_-]+$/.test(openId)) return;
    const profile = await deps.getProfile(botId, openId, 'open_id');
    if (profile.status === 'ok') resolved.set(openId, openId);
  }));
  return resolved;
}

async function defaultResolveMentionIdentities(botId: string, identities: string[]): Promise<Map<string, string>> {
  const { getUserProfileStrict, resolveAllowedUsersWithMap } = await import('../im/lark/client.js');
  return resolveConnectorMentionIdentities(botId, identities, {
    resolveRaw: resolveAllowedUsersWithMap,
    getProfile: getUserProfileStrict,
  });
}

/** Template rendering is asynchronous because identities from untrusted event
 *  data must be resolved into this connector Bot's app-scoped open_ids before
 *  they may become native Lark mentions. */
export async function resolveConnectorTriggerPresentation(
  connector: ConnectorDefinition,
  payload: unknown,
  resolveMentions: ResolveConnectorMentionIdentities = defaultResolveMentionIdentities,
): Promise<TriggerRequest['presentation'] | undefined> {
  if (connector.topicMessage?.mode !== 'template') return connectorTriggerPresentation(connector);
  const topicMessage = await renderConnectorTopicTemplate(connector, payload, resolveMentions);
  return topicMessage ? { topicMessage } : undefined;
}

/** Headers accepted as an inbound idempotency key, in priority order.
 *
 *  Deliberately a SET rather than one botmux-specific name. The webhook gateway's
 *  stated design goal is near-zero adaptation for a new upstream, so requiring
 *  senders to emit a botmux-private header would invert it — and an upstream that
 *  already has a unique delivery id emits it under a vendor-neutral name, never
 *  ours. Order: our own control-plane name first (explicit, matches
 *  `x-botmux-chat-id` / `-session-id` / `-root-message-id`), then the
 *  IETF-draft/Stripe spelling that this repo itself sends OUTBOUND from
 *  `platform/device-enroll.ts`, then the `x-` prefixed variant real senders use
 *  (EventHub emits exactly this today, so it needs no change at all). */
const IDEMPOTENCY_KEY_HEADERS = [
  'x-botmux-idempotency-key',
  'idempotency-key',
  'x-idempotency-key',
] as const;

/** Resolve the caller's idempotency key: header > query > connector-configured
 *  body path. The body path exists because plenty of real senders (alert
 *  platforms that only let you paste a URL) cannot add a header — for them the
 *  unique id is a field inside the event JSON. */
function idempotencyKeyOf(
  req: IncomingMessage,
  url: URL,
  payload: unknown,
  connector: ConnectorDefinition,
): string | undefined {
  for (const name of IDEMPOTENCY_KEY_HEADERS) {
    const v = headerValue(req, name)?.trim();
    if (v) return v;
  }
  const fromQuery = url.searchParams.get('idempotencyKey')?.trim();
  if (fromQuery) return fromQuery;
  const path = connector.idempotency?.keyPath;
  return path ? extractDedupKey(payload, path) : undefined;
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
  // Best-effort audit: a log-write failure must not turn a successful
  // suppression into a 5xx, which an at-least-once sender would read as "not
  // delivered" and retry forever (the exact storm this path exists to stop).
  try {
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
  } catch (err) {
    logger.warn(`[webhook] audit log write failed (delivery unaffected): ${(err as Error).message}`);
  }
  return { ok: true, triggerId, action, message };
}

/** Carries the "release my idempotency reservation" duty out to the exported
 *  wrapper, so a `finally` covering the WHOLE handler owns it.
 *
 *  This replaced a `res.once('close')` release. `close` fires when the client
 *  hangs up, which is NOT when the handler stops: the handler can be parked on a
 *  pre-effect `await` (template mention resolution, lifecycle begin) and then
 *  resume and cross into real side effects — creating a group, dispatching a turn
 *  — after the reservation was already handed back. Probe (verified, fixed-group
 *  connector, 400ms mention resolve, abort at 80ms): the retry dispatched AND the
 *  original handler resumed and dispatched, two turns for one event. Scoping the
 *  release to the handler's lifetime makes "who releases" a lexical question
 *  instead of an event-ordering one, so a future side effect added anywhere below
 *  is covered without anyone remembering to re-check a flag. */
interface ReservationGuard {
  release?: () => void;
}

export async function handleWebhookRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: WebhookRouteDeps,
): Promise<boolean> {
  const guard: ReservationGuard = {};
  try {
    return await handleWebhookRouteImpl(req, res, url, deps, guard);
  } finally {
    // Runs on every exit — normal return, early return, or throw. A dispatch that
    // resolved the reservation clears this first, so the only thing released here
    // is a reservation whose event never actually ran.
    guard.release?.();
  }
}

async function handleWebhookRouteImpl(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: WebhookRouteDeps,
  guard: ReservationGuard,
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

  // Edge admission: meters EVERY POST before the body is read or the signature
  // checked, so an unauthenticated flood stays bounded. The narrower dispatch
  // quota is charged later, only for deliveries that really reach a daemon.
  if (!admissionAllowed(connector)) {
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
    // Signature BEFORE the nonce claim: an unauthenticated caller must not be able
    // to write into `replayNonces` (uncapped, TTL-only) with a bogus signature, nor
    // poison a nonce the real sender is about to use.
    const secret = getWebhookSecret(verify.secretRef);
    if (!secret || !verifyWebhookSignature(secret, ts, rawBody, sig)) {
      fail(401, 'invalid_signature', 'signature verification failed');
      return true;
    }
    // The nonce is claimed HERE, before the idempotency gate. Consequence, and it
    // is a deliberate scope decision: a gateway that replays the IDENTICAL signed
    // request (same timestamp/nonce/signature) is answered 409 replay rather than
    // folded as a duplicate. HMAC senders must mint a fresh nonce and re-sign for
    // each retry — documented in the webhook guide.
    //
    // Deferring the claim past the gate (so verbatim retries could fold) only works
    // for a first delivery that SUCCEEDS: if it fails, the nonce is already spent
    // and the retry that should take over is refused 409 instead (verified by
    // probe). Making it correct needs a second reserve/settle state machine for
    // nonces, CAS-bound to a full dispatch-affecting fingerprint — because the HMAC
    // covers only `timestamp.rawBody`, NOT the idempotency key, query string, or the
    // `x-botmux-chat-id` / `-session-id` / `-root-message-id` routing headers, so a
    // releasable nonce would otherwise let a captured signature be replayed with
    // altered routing. That is a bigger, security-sensitive change than the problem
    // this PR set out to fix (token-mode fixed group), so it stays out.
    if (!claimNonce(connector.id, nonce, verify.toleranceSeconds)) {
      fail(409, 'replay', 'nonce replay detected');
      return true;
    }
    requestId = nonce;
  }

  const responseOptions = parseTriggerResponseOptions(req, url);

  // ── Inbound idempotency (duplicate-delivery suppression) ──
  // Ordering matters in three ways:
  //  * AFTER verification — an unauthenticated request must never be able to burn
  //    a key and get a real later delivery dropped.
  //  * BEFORE the rate limiter — a duplicate we are going to collapse consumes no
  //    downstream resource, so it must not be answered 429. It used to be: the
  //    limiter ran first, a duplicate got 429, and an at-least-once sender read
  //    that as "not delivered" and retried, which then hit the limiter again — the
  //    suppression path was unreachable exactly when it was needed most.
  //  * BEFORE every dispatch branch — fixed / dynamic / new-group / wait / async
  //    are all covered by this one gate instead of four separate ones.
  //
  // dryRun is exempt: it dispatches nothing, so it has no duplicate to suppress
  // and must not consume the key that the real delivery will present.
  const idempotencyKey = connector.idempotency?.disabled
    ? undefined
    : idempotencyKeyOf(req, url, parsed.payload, connector);
  let idempotency: WebhookIdempotencyDecision = { kind: 'disabled' };
  const suppressDuplicate = (key: string, firstTriggerId?: string): true => {
    // 200 + action:'ignored', never 4xx: an at-least-once sender treats a non-2xx
    // as "not delivered" and keeps retrying, so answering an already-handled
    // duplicate with an error would manufacture the retry storm this feature
    // exists to stop. `firstTriggerId` lets the sender reconcile the suppressed
    // retry against the turn that actually ran.
    jsonRes(res, 200, {
      ...webhookOkLog(connector.id, 'ignored', 'duplicate delivery suppressed by idempotency key', 200, auditMeta()),
      idempotency: { key, action: 'duplicate', ...(firstTriggerId ? { firstTriggerId } : {}) },
    });
    return true;
  };
  if (idempotencyKey && !responseOptions.dryRun) {
    // Resolve to a terminal verdict. An `in_flight` verdict means a delivery of
    // this same event is mid-flight and its outcome is unknown; we must not ACK
    // that as handled (if it then fails, a sender that stopped retrying has lost
    // the event), so we join it and re-inspect. The loop is bounded because each
    // pass either returns, becomes `first`, or the owner reservation's deadline
    // has passed and the slot is reclaimed.
    for (;;) {
      idempotency = inspectWebhookIdempotency(connector.id, idempotencyKey, rawBody);
      if (idempotency.kind !== 'in_flight') break;
      // Tie the wait to THIS request's lifetime: if our client hangs up we stop
      // holding a resolver on the owner's entry. This cancels only our own waiter —
      // the owner reservation is untouched.
      const waitAbort = new AbortController();
      const onClose = () => waitAbort.abort();
      res.once('close', onClose);
      let outcome;
      try {
        outcome = await idempotency.join(waitAbort.signal);
      } finally {
        res.removeListener('close', onClose);
      }
      if (outcome.kind === 'ran') return suppressDuplicate(idempotency.key, outcome.triggerId);
      if (outcome.kind === 'aborted') {
        // Our client is gone. Stop here: re-inspecting could make a disconnected
        // request become the new owner and dispatch, which is the opposite of
        // cancelling. Nothing was reserved by us, so there is nothing to release.
        return true;
      }
      // 'released' — the first delivery failed or its slot was reclaimed, so the
      // event did NOT run. Re-inspect rather than dispatching straight away:
      // several waiters can wake together and only one may take over as `first`.
    }
    if (idempotency.kind === 'overloaded') {
      // Too many duplicates of this same event are already parked. Answer a
      // RETRYABLE 503 (never 2xx: nothing has been confirmed, and an
      // at-least-once sender must come back) and do not dispatch.
      fail(503, 'trigger_failed', 'too many concurrent duplicate deliveries for this idempotency key; retry shortly');
      return true;
    }
    if (idempotency.kind === 'duplicate') return suppressDuplicate(idempotency.key, idempotency.firstTriggerId);
    if (idempotency.kind === 'conflict') {
      // Same key, different body ⇒ the sender's key is not a reliable unique id.
      // Fail OPEN (dispatch anyway): silently dropping what may be a distinct
      // production alert is worse than running a duplicate turn. Recorded so the
      // anomaly is visible in the call log instead of being invisible.
      logger.warn(
        `[webhook] connector ${connector.id} reused idempotency key ${idempotency.key} with a different body; dispatching anyway (key is not a reliable unique id)`,
      );
    }
    if (idempotency.kind === 'first') {
      // `inspect` RESERVED the key for this request. Hand the release duty to the
      // wrapper's `finally` (see ReservationGuard): it must outlive every early
      // return, throw, AND a client hang-up, because the handler can be parked on
      // a pre-effect await and later resume into real side effects.
      const reserved = idempotency;
      guard.release = () => settleWebhookIdempotency(connector.id, reserved.key, reserved.token, undefined);
    }
  }

  // The limiter runs only for deliveries we are actually going to act on, so a
  // collapsed duplicate never consumes quota (and never gets a retry-provoking
  // 429). Placed after the idempotency gate for exactly that reason.
  if (!rateAllowed(connector)) {
    fail(429, 'rate_limited', 'connector rate limit exceeded');
    return true;
  }

  /** Dispatch, and resolve the idempotency reservation from the real outcome.
   *
   *  Ran (see `dispatchDidRun`) → keep the reservation as a dedup record carrying
   *  the turn's id, so later retries fold onto it. This is NOT `body.ok`: a
   *  `wait_timeout` reports ok:false about a turn that was already dispatched and
   *  is probably still running, and releasing there let a retry run it twice.
   *
   *  Otherwise → release (clear the guard's duty by settling it here), so an
   *  at-least-once sender's retry can still run an event that never happened. */
  const dispatchWithIdempotency = async (trigger: TriggerRequest) => {
    try {
      const result = await dispatchTriggerRequest(trigger, deps, auditMeta());
      if (idempotency.kind === 'first') {
        guard.release = undefined;
        settleWebhookIdempotency(
          connector.id,
          idempotency.key,
          idempotency.token,
          dispatchDidRun(result.body) ? (result.body.triggerId ?? newTriggerId()) : undefined,
        );
      }
      return result;
    } catch (err) {
      // An unexpected throw is commit-unknown; stay fail-open (release) so the
      // event is not permanently swallowed. The guard's finally would do this
      // anyway — doing it here keeps the intent explicit.
      if (idempotency.kind === 'first') {
        guard.release = undefined;
        settleWebhookIdempotency(connector.id, idempotency.key, idempotency.token, undefined);
      }
      throw err;
    }
  };
  /** Echo the key back on a first (dispatched) delivery, so a caller can tell
   *  that suppression is actually armed for this connector — otherwise a sender
   *  cannot distinguish "key honoured" from "key silently ignored". */
  const withIdempotencyEcho = (body: TriggerResponse): TriggerResponse =>
    // Only claim 'accepted' when the turn actually ran. A failed dispatch (e.g.
    // daemon_offline) has already RELEASED the key, so echoing accepted there would
    // contradict both the type's meaning ("dispatched") and the store's state.
    (idempotency.kind === 'first' && dispatchDidRun(body)
      ? { ...body, idempotency: { key: idempotency.key, action: 'accepted' as const } }
      : body);
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
  const presentation = await resolveConnectorTriggerPresentation(
    connector,
    parsed.payload,
    deps.resolveMentionIdentities,
  );
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
      ...(presentation ? { presentation } : {}),
      options: responseOptions,
    };

    const result = await dispatchWithIdempotency(trigger);
    jsonRes(res, result.status, withIdempotencyEcho(result.body));
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
      ...(presentation ? { presentation } : {}),
      options: {
        ...(dedupKey ? { dedupKey } : {}),
        ...responseOptions,
        ...(connector.suppressFinalOutput ? { suppressFinalOutput: true } : {}),
      },
    };

    const result = await dispatchWithIdempotency(trigger);
    jsonRes(res, result.status, { ...withIdempotencyEcho(result.body), lifecycle: { ...(dedupKey ? { dedupKey } : {}), action, chatId } });
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
    ...(presentation ? { presentation } : {}),
    options: {
      ...responseOptions,
      ...(connector.suppressFinalOutput ? { suppressFinalOutput: true } : {}),
    },
  };

  const result = await dispatchWithIdempotency(trigger);
  jsonRes(res, result.status, withIdempotencyEcho(result.body));
  return true;
}
