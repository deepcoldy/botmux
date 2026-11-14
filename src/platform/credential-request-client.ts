/**
 * Machine-auth client for the central platform's authorization request.
 *
 * When a governed command is refused for a missing credential or a missing
 * machine consent, the daemon asks the platform (`POST /v1/machine/credential-request`)
 * to send the person ONE authorization card. The platform works out what the
 * person lacks on this machine, stores the request and delivers the card itself
 * (a direct message from the platform bot). The daemon never builds, receives or
 * relays a link: the response carries only a status.
 *
 * Shape mirrors `credential-grant-client.ts`: binding + http are injectable so
 * the client is testable without a platform, and it never throws.
 */
import { postJson } from './platform-http.js';
import { readPlatformBinding } from './binding.js';
import { withHardTimeout } from './credential-grant-client.js';
import type { TriggerUserAuthTool } from '../services/trigger-user-auth.js';

export const CREDENTIAL_REQUEST_PATH = '/v1/machine/credential-request';
/** One request only: a retry after a timeout can deliver the card twice. */
const REQUEST_TIMEOUT_MS = 10_000;

export interface CredentialRequest {
  /** Tenant-stable id of the person the card is for (resolved by the daemon). */
  unionId: string;
  /** The bot (Feishu app) on whose behalf the command ran. */
  appId: string;
  /** Every platform-backed tool the bot runs as the person. */
  tools: readonly TriggerUserAuthTool[];
  /** Extra lark-cli scopes the command needs on top of the person's grant. */
  scopes?: readonly string[];
}

export type CredentialRequestOutcome =
  /** The person lacks nothing on this machine; no card was sent. */
  | { status: 'ready' }
  /** The platform sent the card (`deduped`: an earlier card still covers this). */
  | { status: 'sent'; deduped: boolean }
  /** The platform could not deliver the card; its request is kept. */
  | { status: 'undeliverable'; detail: string };

export type CredentialRequestFailure =
  | { ok: false; reason: 'unbound' }
  /** The platform does not have the endpoint (any 404). */
  | { ok: false; reason: 'not_deployed' }
  /** Several cards were already sent to this person today; nothing was sent. */
  | { ok: false; reason: 'request_cap' }
  | { ok: false; reason: 'failed'; detail: string };

export type CredentialRequestResult = ({ ok: true } & CredentialRequestOutcome) | CredentialRequestFailure;

export interface CredentialRequestClientOptions {
  binding?: { platformUrl: string; machineToken: string; machineId: string } | null;
  timeoutMs?: number;
  http?: { post: typeof postJson };
}

function resolveBinding(opts: CredentialRequestClientOptions) {
  if (opts.binding !== undefined) return opts.binding;
  const b = readPlatformBinding();
  return b ? { platformUrl: b.platformUrl, machineToken: b.machineToken, machineId: b.machineId } : null;
}

function classify(status: number, json: unknown): CredentialRequestFailure {
  const rec = (json && typeof json === 'object' ? json : {}) as Record<string, unknown>;
  const error = typeof rec.error === 'string' ? rec.error : '';
  // The platform never answers a request with 404 itself, so any 404 is a
  // platform without this endpoint.
  if (status === 404) return { ok: false, reason: 'not_deployed' };
  if (status === 429 && error === 'request_cap') return { ok: false, reason: 'request_cap' };
  return { ok: false, reason: 'failed', detail: `http ${status}${error ? ` ${error}` : ''}` };
}

/**
 * Ask the platform to send the person an authorization card. Never throws.
 */
export async function requestCredentialAuthorization(
  req: CredentialRequest,
  opts: CredentialRequestClientOptions = {},
): Promise<CredentialRequestResult> {
  try {
    return await requestInner(req, opts);
  } catch (e) {
    return { ok: false, reason: 'failed', detail: e instanceof Error ? e.message : String(e) };
  }
}

async function requestInner(req: CredentialRequest, opts: CredentialRequestClientOptions): Promise<CredentialRequestResult> {
  const binding = resolveBinding(opts);
  if (!binding) return { ok: false, reason: 'unbound' };
  const http = opts.http ?? { post: postJson };
  const url = `${binding.platformUrl.replace(/\/+$/, '')}${CREDENTIAL_REQUEST_PATH}`;
  const body: Record<string, unknown> = {
    unionId: req.unionId,
    appId: req.appId,
    tools: req.tools,
    ...(req.scopes?.length ? { scopes: req.scopes } : {}),
    machineId: binding.machineId,
  };
  const timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const { status, json } = await withHardTimeout(signal => http.post(url, body, {
    headers: { authorization: `Bearer ${binding.machineToken}` },
    timeoutMs,
    freshConnection: true,
    signal,
  }), timeoutMs);
  if (status < 200 || status >= 300) return classify(status, json);
  const rec = (json && typeof json === 'object' ? json : {}) as Record<string, unknown>;
  if (rec.ok !== true) return { ok: false, reason: 'failed', detail: 'ok flag missing' };
  switch (rec.status) {
    case 'ready': return { ok: true, status: 'ready' };
    case 'sent':
      return { ok: true, status: 'sent', deduped: rec.deduped === true };
    case 'undeliverable': return { ok: true, status: 'undeliverable', detail: typeof rec.detail === 'string' ? rec.detail : '' };
    default: return { ok: false, reason: 'failed', detail: 'unknown status' };
  }
}
