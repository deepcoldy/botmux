/**
 * Machine-auth client for the central platform's per-turn credential grant.
 *
 * The daemon asks the platform for the CURRENT TURN'S SENDER'S short-lived tool
 * credentials (`POST /v1/machine/credential-grant`). The platform holds the
 * person's refresh credentials (authorized once on its settings page), checks
 * that the person and this machine's owner share a team and that the person
 * consented to that team, mints a short-lived token, audits the grant, and
 * returns only env variables — never a refresh credential.
 *
 * The daemon derives `unionId` from the turn's sender itself; nothing the CLI
 * runs can influence it (see docs/lark-tool-identity.md, "身份选择").
 *
 * Shape mirrors `team-agents-client.ts`: binding + http are injectable so the
 * client is testable without a platform.
 */
import { postJson } from './platform-http.js';
import { readPlatformBinding } from './binding.js';
import type { TriggerUserAuthTool } from '../services/trigger-user-auth.js';

export interface CredentialGrantRequest {
  tool: TriggerUserAuthTool;
  /** Tenant-stable id of the turn's sender (resolved by the daemon). */
  unionId: string;
  /** The bot (Feishu app) on whose behalf the turn runs — audit only. */
  appId: string;
  sessionId: string;
  turnId?: string;
}

export interface CredentialGrant {
  tool: TriggerUserAuthTool;
  unionId: string;
  /** Env entries the identity wrapper publishes for this turn. Keys are
   *  allow-listed per tool (see {@link GRANT_VARIABLE_KEYS}). */
  variables: Record<string, string>;
  /** Epoch ms after which the variables must not be used. */
  expiresAt: number;
}

export type CredentialGrantFailure =
  | { ok: false; reason: 'unbound' }
  | { ok: false; reason: 'network'; error: string }
  /** The person has not authorized this tool on the platform (or must redo it). */
  | { ok: false; reason: 'not_authorized'; authorizeUrl?: string; error: string }
  /** Authorized, but not for the team this machine's owner shares with them. */
  | { ok: false; reason: 'consent_missing'; authorizeUrl?: string; error: string }
  /** The sender and this machine's owner share no team. */
  | { ok: false; reason: 'not_teammate'; error: string }
  | { ok: false; reason: 'forbidden'; status: number; error: string }
  | { ok: false; reason: 'not_deployed'; status: number }
  | { ok: false; reason: 'rate_limited'; status: number; error: string; retryAfterMs?: number }
  | { ok: false; reason: 'unavailable'; status: number; error: string }
  | { ok: false; reason: 'client'; status: number; error: string }
  | { ok: false; reason: 'invalid_response'; error: string };

export type CredentialGrantResult = { ok: true; value: CredentialGrant } | CredentialGrantFailure;

export interface CredentialGrantClientOptions {
  binding?: { platformUrl: string; machineToken: string; machineId: string } | null;
  timeoutMs?: number;
  http?: { post: typeof postJson };
}

/** Env keys a grant may carry, per tool. Anything else is rejected: the
 *  platform must not be able to inject arbitrary environment into a session. */
export const GRANT_VARIABLE_KEYS: Record<TriggerUserAuthTool, { required: readonly string[]; optional: readonly string[] }> = {
  'lark-cli': {
    required: ['LARKSUITE_CLI_APP_ID', 'LARKSUITE_CLI_USER_ACCESS_TOKEN'],
    optional: [],
  },
  bytedcli: {
    required: ['BYTEDCLI_USER_CLOUD_JWT'],
    optional: ['BYTEDCLI_USER_CODE_JWT'],
  },
};

/** Default per-call budget: a grant sits on the turn's critical path. */
const DEFAULT_TIMEOUT_MS = 6_000;
/** Defense in depth: a grant is a per-turn token. Whatever the platform says,
 *  never treat one as valid for longer than this. */
const MAX_GRANT_TTL_MS = 24 * 60 * 60 * 1000;
const UNION_ID_RE = /^[A-Za-z0-9_-]{4,128}$/;
export const CREDENTIAL_GRANT_PATH = '/v1/machine/credential-grant';
/** Settings page on the platform where a person authorizes / consents. */
export const PLATFORM_CREDENTIALS_PAGE = '/credentials';

function resolveBinding(opts: CredentialGrantClientOptions) {
  if (opts.binding !== undefined) return opts.binding;
  const b = readPlatformBinding();
  return b ? { platformUrl: b.platformUrl, machineToken: b.machineToken, machineId: b.machineId } : null;
}

/** Where to send a person to authorize on the platform (null when unbound). */
export function platformCredentialsUrl(opts: CredentialGrantClientOptions = {}): string | null {
  const binding = resolveBinding(opts);
  if (!binding) return null;
  return `${binding.platformUrl.replace(/\/+$/, '')}${PLATFORM_CREDENTIALS_PAGE}`;
}

function isSafeValue(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && !/[\r\n\0]/.test(v);
}

function pickVariables(tool: TriggerUserAuthTool, raw: unknown): Record<string, string> | string {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'variables missing';
  const rec = raw as Record<string, unknown>;
  const spec = GRANT_VARIABLE_KEYS[tool];
  const out: Record<string, string> = {};
  for (const key of spec.required) {
    if (!isSafeValue(rec[key])) return `variable ${key} missing or unsafe`;
    out[key] = rec[key] as string;
  }
  for (const key of spec.optional) {
    if (rec[key] === undefined || rec[key] === null || rec[key] === '') continue;
    if (!isSafeValue(rec[key])) return `variable ${key} unsafe`;
    out[key] = rec[key] as string;
  }
  const allowed = new Set<string>([...spec.required, ...spec.optional]);
  const extra = Object.keys(rec).filter(k => !allowed.has(k));
  if (extra.length) return `unexpected variables: ${extra.join(', ')}`;
  return out;
}

/** Only a link on the bound platform itself is relayed to the person; anything
 *  else (a tampered or misconfigured platform) falls back to the known page. */
function sameOriginUrl(platformUrl: string, candidate: unknown): string | undefined {
  if (typeof candidate !== 'string') return undefined;
  try {
    const a = new URL(candidate);
    const b = new URL(platformUrl);
    return a.protocol === 'https:' && a.origin === b.origin ? candidate : undefined;
  } catch {
    return undefined;
  }
}

function classify(status: number, json: unknown, platformUrl: string): CredentialGrantFailure {
  const rec = (json && typeof json === 'object' ? json : {}) as Record<string, unknown>;
  const error = typeof rec.error === 'string' ? rec.error : '';
  const authorizeUrl = sameOriginUrl(platformUrl, rec.authorizeUrl);
  if (status === 429) {
    const retryAfterMs = typeof rec.retryAfterMs === 'number' ? rec.retryAfterMs : undefined;
    return { ok: false, reason: 'rate_limited', status, error: error || 'rate_limited', ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) };
  }
  if (status === 404 && error === 'credential_not_found') {
    return { ok: false, reason: 'not_authorized', error, ...(authorizeUrl ? { authorizeUrl } : {}) };
  }
  // Any other 404 is a platform without this endpoint (older build, generic
  // router 404 body or not) — not a verdict about the person.
  if (status === 404) return { ok: false, reason: 'not_deployed', status };
  if (status === 409 && error === 'credential_reauth_required') {
    return { ok: false, reason: 'not_authorized', error, ...(authorizeUrl ? { authorizeUrl } : {}) };
  }
  if (status === 403 && error === 'consent_missing') {
    return { ok: false, reason: 'consent_missing', error, ...(authorizeUrl ? { authorizeUrl } : {}) };
  }
  if (status === 403 && error === 'not_teammate') return { ok: false, reason: 'not_teammate', error };
  if (status === 401 || status === 403) return { ok: false, reason: 'forbidden', status, error: error || `http_${status}` };
  if (status >= 500) return { ok: false, reason: 'unavailable', status, error: error || `http_${status}` };
  return { ok: false, reason: 'client', status, error: error || `http_${status}` };
}

/**
 * Ask the platform for this turn's credentials. Never throws.
 */
export async function requestCredentialGrant(
  req: CredentialGrantRequest,
  opts: CredentialGrantClientOptions = {},
): Promise<CredentialGrantResult> {
  try {
    return await requestCredentialGrantInner(req, opts);
  } catch (e) {
    // Honour "never throws": a broken binding file or an unexpected shape must
    // surface as a withheld identity, not take the turn down.
    return { ok: false, reason: 'network', error: e instanceof Error ? e.message : String(e) };
  }
}

async function requestCredentialGrantInner(
  req: CredentialGrantRequest,
  opts: CredentialGrantClientOptions,
): Promise<CredentialGrantResult> {
  const binding = resolveBinding(opts);
  if (!binding) return { ok: false, reason: 'unbound' };
  if (!UNION_ID_RE.test(req.unionId)) {
    return { ok: false, reason: 'client', status: 0, error: 'invalid_union_id' };
  }
  if (!GRANT_VARIABLE_KEYS[req.tool]) {
    return { ok: false, reason: 'client', status: 0, error: 'unsupported_tool' };
  }
  const http = opts.http ?? { post: postJson };
  const url = `${binding.platformUrl.replace(/\/+$/, '')}${CREDENTIAL_GRANT_PATH}`;
  let status: number;
  let json: unknown;
  try {
    const body: Record<string, unknown> = {
      unionId: req.unionId,
      tool: req.tool,
      appId: req.appId,
      sessionId: req.sessionId,
      ...(req.turnId ? { turnId: req.turnId } : {}),
      machineId: binding.machineId,
    };
    const r = await http.post(url, body, {
      headers: { authorization: `Bearer ${binding.machineToken}` },
      timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
    status = r.status;
    json = r.json;
  } catch (e) {
    return { ok: false, reason: 'network', error: e instanceof Error ? e.message : String(e) };
  }
  if (status < 200 || status >= 300) return classify(status, json, binding.platformUrl);
  const rec = (json && typeof json === 'object' ? json : {}) as Record<string, unknown>;
  if (rec.ok !== true) return { ok: false, reason: 'invalid_response', error: 'ok flag missing' };
  if (rec.tool !== req.tool) return { ok: false, reason: 'invalid_response', error: 'tool mismatch' };
  if (rec.unionId !== req.unionId) return { ok: false, reason: 'invalid_response', error: 'unionId mismatch' };
  const now = Date.now();
  const rawExpiresAt = typeof rec.expiresAt === 'number' && Number.isFinite(rec.expiresAt) ? rec.expiresAt : NaN;
  if (!Number.isFinite(rawExpiresAt) || rawExpiresAt <= now) {
    return { ok: false, reason: 'invalid_response', error: 'expiresAt missing or already past' };
  }
  const expiresAt = Math.min(rawExpiresAt, now + MAX_GRANT_TTL_MS);
  const variables = pickVariables(req.tool, rec.variables);
  if (typeof variables === 'string') return { ok: false, reason: 'invalid_response', error: variables };
  return { ok: true, value: { tool: req.tool, unionId: req.unionId, variables, expiresAt } };
}

/** One-line, secret-free description for logs. */
export function describeCredentialGrantFailure(f: CredentialGrantFailure): string {
  switch (f.reason) {
    case 'unbound': return 'machine is not bound to a platform';
    case 'network': return `network: ${f.error}`;
    case 'not_authorized': return `not authorized on platform (${f.error})`;
    case 'consent_missing': return 'authorized on platform but no consent for this team';
    case 'not_teammate': return 'sender and machine owner share no team';
    case 'forbidden': return `forbidden (${f.status} ${f.error})`;
    case 'not_deployed': return `platform has no credential-grant endpoint (${f.status})`;
    case 'rate_limited': return `rate limited (${f.status})`;
    case 'unavailable': return `platform unavailable (${f.status} ${f.error})`;
    case 'client': return `client error (${f.status} ${f.error})`;
    case 'invalid_response': return `invalid response: ${f.error}`;
  }
}
