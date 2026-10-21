import type {
  LinkRefExtractionStats,
  LinkRefMode,
  LinkRefSourceInput,
  LinkRefSourceType,
} from '../services/link-ref-types.js';
import type { LinkRefRuntime } from '../services/link-ref-runtime.js';
import type {
  OutboundLinkRefPayload,
  ResolvedOutboundLinkRefs,
} from '../services/link-ref-resolver.js';

export const LINK_REF_REGISTER_MAX_BODY_BYTES = 1024 * 1024;
export const LINK_REF_RESOLVE_MAX_BODY_BYTES = 4 * 1024 * 1024;

export interface McpLinkRefRegistrationRequest {
  sessionId: string;
  turnId: string;
  dispatchAttempt?: number;
  linkRefMode: 'observe' | 'enabled';
  pluginId: string;
  sourceId: string;
  value: unknown;
}

export interface McpHostDeliveryLinkRefRequest {
  sessionId: string;
  turnId: string;
  dispatchAttempt?: number;
  linkRefMode: 'enabled';
  payload: OutboundLinkRefPayload;
}

interface LinkRefDaemonSessionIdentity {
  appId: string;
  sessionId: string;
  managedTurnOrigin?: {
    turnId?: string;
    dispatchAttempt?: number;
    linkRefMode?: 'observe' | 'enabled';
  };
}

function exactMcpTurnKey(
  daemonSession: LinkRefDaemonSessionIdentity,
  request: Pick<McpLinkRefRegistrationRequest, 'turnId' | 'dispatchAttempt' | 'linkRefMode'>,
) {
  // Production MCP producers always send dispatchAttempt > 0 for attempted
  // turns. Keep exact equality here: the ledger normalizes an omitted attempt
  // to 0 internally, but undefined request provenance must not inherit that
  // storage detail and become equivalent to an explicit attempt.
  const origin = daemonSession.managedTurnOrigin;
  if (!origin
    || typeof request.turnId !== 'string'
    || request.turnId.length === 0
    || request.turnId.length > 256
    || /[\0\r\n]/u.test(request.turnId)
    || request.turnId !== origin.turnId
    || request.dispatchAttempt !== origin.dispatchAttempt
    || request.linkRefMode !== origin.linkRefMode
    || (request.dispatchAttempt !== undefined
      && (!Number.isSafeInteger(request.dispatchAttempt) || request.dispatchAttempt <= 0))) {
    return undefined;
  }
  return {
    appId: daemonSession.appId,
    sessionId: daemonSession.sessionId,
    turnId: origin.turnId,
    ...(origin.dispatchAttempt !== undefined
      ? { dispatchAttempt: origin.dispatchAttempt }
      : {}),
  };
}

function boundedJsonValue(value: unknown, maxBytes: number): boolean {
  try {
    const encoded = JSON.stringify(value);
    return encoded !== undefined && Buffer.byteLength(encoded, 'utf8') <= maxBytes;
  } catch {
    return false;
  }
}

function stableLinkRefError(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = String((error as { code: unknown }).code);
    if (code.startsWith('link_ref_') || code === 'expected_link_invalid_after_link_ref') return code;
  }
  const message = error instanceof Error ? error.message : String(error);
  return message.startsWith('link_ref_') ? message : 'link_ref_ledger_unavailable';
}

export function registerMcpLinkRefsFromWorker(input: {
  ownsWorkerSession: boolean;
  daemonSession: LinkRefDaemonSessionIdentity;
  runtime: LinkRefRuntime;
  request: McpLinkRefRegistrationRequest;
}): ({ ok: true; companion?: string; stats: LinkRefExtractionStats }
  | { ok: false; error: string }) {
  const { request, daemonSession } = input;
  if (!input.ownsWorkerSession
    || request.sessionId !== daemonSession.sessionId
    || !request.turnId
    || !request.pluginId
    || !request.sourceId
    || !boundedJsonValue(request.value, LINK_REF_REGISTER_MAX_BODY_BYTES)) {
    return { ok: false, error: 'link_ref_identity_mismatch' };
  }
  const key = exactMcpTurnKey(daemonSession, request);
  if (!key) return { ok: false, error: 'link_ref_identity_mismatch' };
  try {
    if (request.linkRefMode === 'enabled' && input.runtime.restoreMode(key) !== 'enabled') {
      return { ok: false, error: 'link_ref_turn_not_open' };
    }
    const result = input.runtime.registerSources({
      key,
      mode: request.linkRefMode,
      sources: [{
        sourceType: 'mcp',
        kind: 'structured',
        sourceId: request.sourceId,
        value: request.value,
      }],
    });
    return { ok: true, ...result };
  } catch (error) {
    return { ok: false, error: stableLinkRefError(error) };
  }
}

export function resolveMcpHostDeliveryLinkRefsFromWorker(input: {
  ownsWorkerSession: boolean;
  daemonSession: LinkRefDaemonSessionIdentity;
  runtime: LinkRefRuntime;
  request: McpHostDeliveryLinkRefRequest;
}): ({ ok: true; payload: ResolvedOutboundLinkRefs } | { ok: false; error: string }) {
  const { request, daemonSession } = input;
  if (!input.ownsWorkerSession
    || request.sessionId !== daemonSession.sessionId
    || !request.turnId
    || !boundedJsonValue(request.payload, LINK_REF_RESOLVE_MAX_BODY_BYTES)) {
    return { ok: false, error: 'link_ref_identity_mismatch' };
  }
  const key = exactMcpTurnKey(daemonSession, request);
  if (!key) return { ok: false, error: 'link_ref_identity_mismatch' };
  try {
    if (input.runtime.restoreMode(key) !== 'enabled') {
      return { ok: false, error: 'link_ref_turn_not_open' };
    }
    return {
      ok: true,
      payload: input.runtime.resolveForDaemon(key, 'enabled', request.payload),
    };
  } catch (error) {
    return { ok: false, error: stableLinkRefError(error) };
  }
}

const REGISTER_BODY_KEYS = new Set([
  'sourceType',
  'sourceId',
  'value',
  'originCapability',
  'originTurnId',
  'originDispatchAttempt',
]);
const RESOLVE_BODY_KEYS = new Set([
  'payload',
  'originCapability',
  'originTurnId',
  'originDispatchAttempt',
]);
const RESOLVE_PAYLOAD_KEYS = new Set([
  'text', 'preparedText', 'card', 'completionProposal', 'expectedLinks',
]);

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function parseLinkRefResolveBody(
  value: unknown,
): { ok: true; payload: OutboundLinkRefPayload } | { ok: false } {
  if (!plainRecord(value) || Object.keys(value).some(key => !RESOLVE_BODY_KEYS.has(key))) {
    return { ok: false };
  }
  const payload = value.payload;
  if (!plainRecord(payload) || Object.keys(payload).some(key => !RESOLVE_PAYLOAD_KEYS.has(key))) {
    return { ok: false };
  }
  if (payload.text !== undefined && typeof payload.text !== 'string') return { ok: false };
  if (payload.preparedText !== undefined && typeof payload.preparedText !== 'string') return { ok: false };
  if (payload.card !== undefined && !plainRecord(payload.card)) return { ok: false };
  if (payload.completionProposal !== undefined && !plainRecord(payload.completionProposal)) return { ok: false };
  if (payload.expectedLinks !== undefined
    && (!Array.isArray(payload.expectedLinks)
      || payload.expectedLinks.some(link => typeof link !== 'string'))) return { ok: false };
  return { ok: true, payload: payload as OutboundLinkRefPayload };
}

export function emptyLinkRefExtractionStats(): LinkRefExtractionStats {
  return {
    scannedBytes: 0,
    found: 0,
    candidateCount: 0,
    filteredCredential: 0,
    filteredMetadata: 0,
    filteredInvalid: 0,
  };
}

export function parseLinkRefRegistrationBody(
  value: unknown,
): { ok: true; source: LinkRefSourceInput } | { ok: false } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false };
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return { ok: false };
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some(key => !REGISTER_BODY_KEYS.has(key))) return { ok: false };
  if (!Object.hasOwn(body, 'value')) return { ok: false };
  if (body.sourceType !== 'history' && body.sourceType !== 'quoted') return { ok: false };
  if (body.sourceId !== undefined
      && (typeof body.sourceId !== 'string'
        || body.sourceId.length === 0
        || Buffer.byteLength(body.sourceId) > 1024)) {
    return { ok: false };
  }
  return {
    ok: true,
    source: {
      sourceType: body.sourceType,
      kind: 'structured',
      value: body.value,
      ...(typeof body.sourceId === 'string' ? { sourceId: body.sourceId } : {}),
    },
  };
}

export interface CliLinkRefRegistrationPayload {
  sourceType: Extract<LinkRefSourceType, 'history' | 'quoted'>;
  sourceId?: string;
  value: unknown;
}

export interface CliLinkRefRegistrationResult {
  companion?: string;
  stats?: Partial<LinkRefExtractionStats>;
}

export async function decorateCliLinkRefResult<T extends object>(input: {
  mode: LinkRefMode;
  sourceType: Extract<LinkRefSourceType, 'history' | 'quoted'>;
  sourceId?: string;
  value: T;
  register: (payload: CliLinkRefRegistrationPayload) => Promise<CliLinkRefRegistrationResult>;
}): Promise<T | (T & { linkRefs: { companion: string } })> {
  if (input.mode === 'disabled') return input.value;
  try {
    const result = await input.register({
      sourceType: input.sourceType,
      ...(input.sourceId ? { sourceId: input.sourceId } : {}),
      value: input.value,
    });
    if (input.mode !== 'enabled' || !result.companion) return input.value;
    return { ...input.value, linkRefs: { companion: result.companion } };
  } catch {
    return input.value;
  }
}
