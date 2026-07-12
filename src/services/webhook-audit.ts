import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import type { ConnectorDefinition } from './connector-store.js';
import type { TriggerLogRequest, TriggerLogResponse, TriggerLogTarget } from './trigger-log-store.js';
import type { TriggerResponse } from './trigger-types.js';

const REDACTED = '[REDACTED]';
const MAX_STORED_PAYLOAD_BYTES = 128 * 1024;
const SENSITIVE_KEY = /(?:^|[-_])(authorization|cookie|password|passwd|secret|token|api[-_]?key|access[-_]?key|private[-_]?key|signature)(?:$|[-_])/i;

function isSensitiveKey(key: string, connector?: ConnectorDefinition): boolean {
  const normalized = key.trim().toLowerCase();
  if (SENSITIVE_KEY.test(normalized)) return true;
  const compact = normalized.replace(/[^a-z0-9]/g, '');
  if (['authorization', 'cookie', 'password', 'passwd', 'secret', 'token', 'apikey', 'accesskey', 'privatekey', 'signature']
    .some(candidate => compact === candidate || compact.endsWith(candidate))) return true;
  if (!connector) return false;
  return normalized === connector.verify.signatureHeader.toLowerCase();
}

export function redactWebhookValue(value: unknown, key = '', depth = 0): unknown {
  if (key && isSensitiveKey(key)) return REDACTED;
  if (depth >= 12) return '[TRUNCATED_DEPTH]';
  if (Array.isArray(value)) {
    const visible = value.slice(0, 200).map(item => redactWebhookValue(item, '', depth + 1));
    return value.length > visible.length ? [...visible, `[TRUNCATED_${value.length - visible.length}_ITEMS]`] : visible;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>).slice(0, 500)) {
      out[childKey] = isSensitiveKey(childKey)
        ? REDACTED
        : redactWebhookValue(childValue, childKey, depth + 1);
    }
    if (Object.keys(value as Record<string, unknown>).length > 500) out.__botmux_truncated__ = true;
    return out;
  }
  return value;
}

function sanitizedHeaders(headers: IncomingHttpHeaders, connector?: ConnectorDefinition): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (isSensitiveKey(key, connector)) {
      out[key.toLowerCase()] = REDACTED;
    } else if (Array.isArray(value)) {
      out[key.toLowerCase()] = value.map(String);
    } else {
      out[key.toLowerCase()] = String(value);
    }
  }
  return out;
}

function sanitizedQuery(url: URL, connector?: ConnectorDefinition): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const key of new Set(url.searchParams.keys())) {
    const values = url.searchParams.getAll(key);
    const clean = isSensitiveKey(key, connector) ? values.map(() => REDACTED) : values;
    out[key] = clean.length === 1 ? clean[0] : clean;
  }
  return out;
}

function redactedWebhookPath(pathname: string): string {
  return pathname.replace(/^(\/webhook\/[^/]+)\/[^/]+$/, '$1/[REDACTED]');
}

export function webhookAuditRequest(
  req: IncomingMessage,
  url: URL,
  connector?: ConnectorDefinition,
): TriggerLogRequest {
  return {
    method: (req.method ?? 'GET').toUpperCase(),
    path: redactedWebhookPath(url.pathname),
    query: sanitizedQuery(url, connector),
    ...(connector?.loggingPolicy?.storeHeaders === false ? {} : { headers: sanitizedHeaders(req.headers, connector) }),
    ...(req.socket.remoteAddress ? { remoteAddress: req.socket.remoteAddress } : {}),
    payloadStored: false,
    payloadOmittedReason: connector?.loggingPolicy?.storePayload === false ? 'disabled' : 'not_available',
  };
}

export function withWebhookAuditPayload(
  request: TriggerLogRequest,
  rawBody: Buffer,
  parsedPayload: unknown,
  connector: ConnectorDefinition,
): TriggerLogRequest {
  const base: TriggerLogRequest = { ...request, bodyBytes: rawBody.byteLength };
  if (connector.loggingPolicy?.storePayload === false) {
    return { ...base, payloadStored: false, payloadOmittedReason: 'disabled' };
  }
  if (parsedPayload === undefined || rawBody.byteLength === 0) {
    return { ...base, payloadStored: false, payloadOmittedReason: 'not_available' };
  }
  const payload = redactWebhookValue(parsedPayload);
  let encodedBytes = Number.POSITIVE_INFINITY;
  try {
    encodedBytes = Buffer.byteLength(JSON.stringify(payload), 'utf-8');
  } catch { /* non-serializable payloads are omitted */ }
  if (encodedBytes > MAX_STORED_PAYLOAD_BYTES) {
    return { ...base, payloadStored: false, payloadOmittedReason: 'too_large' };
  }
  return { ...base, payload, payloadStored: true, payloadOmittedReason: undefined };
}

export function webhookAuditTarget(
  connector: ConnectorDefinition,
  overrides: Partial<TriggerLogTarget> = {},
): TriggerLogTarget {
  return {
    kind: connector.target.kind,
    mode: connector.target.mode,
    botId: connector.target.botId,
    ...(connector.target.chatId ? { chatId: connector.target.chatId } : {}),
    ...(connector.target.workflowId ? { workflowId: connector.target.workflowId } : {}),
    ...overrides,
  };
}

export function webhookAuditResponse(
  httpStatus: number,
  startedAtMs: number,
  body?: TriggerResponse,
): TriggerLogResponse {
  return {
    httpStatus,
    durationMs: Math.max(0, Date.now() - startedAtMs),
    ...(body?.target?.sessionId ? { sessionId: body.target.sessionId } : {}),
    ...(body?.target?.workflowRunId ? { workflowRunId: body.target.workflowRunId } : {}),
    ...(body?.target?.chatId ? { chatId: body.target.chatId } : {}),
  };
}
