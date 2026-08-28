import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Path-scoped capability that authorises ONE session's preview content stream.
 *
 * Why this exists at all: the preview iframe is now an opaque-origin sandbox
 * (no `allow-same-origin`), which is what severs "agent HTML runs on the
 * dashboard origin → management API → debug terminal → host bash". The price
 * of an opaque origin is that the framed document's own subresource and
 * WebSocket requests are *cross-site* to the browser, so the dashboard cookie
 * is no longer attached to them — the dev server's own JS/CSS/WS would 401.
 *
 * Accepting `Origin: null` as proof of "this came from our sandboxed frame"
 * is NOT an option: any page anywhere (and plain `curl -H 'Origin: null'`)
 * can produce it, which would turn the preview proxy into an unauthenticated
 * SSRF hop into loopback dev servers. So the guard shell — which IS cookie
 * authenticated — mints this capability and puts it in the iframe's path.
 * Relative subresources and WebSockets inherit the path automatically, and no
 * ambient authority is involved.
 *
 * Scope: this capability proves nothing except "may proxy to the registered
 * preview target of session X". It is never accepted on /api, /events, the
 * terminal proxy or the debug terminal, and it carries no dashboard token.
 * It is bound to the minting auth session so logout / token rotation revokes
 * it centrally (see `isAuthSessionLive` in the proxy options), and expiry
 * bounds a leaked URL even without revocation.
 */

const TOKEN_PREFIX = 'bmxpv1';
const CAPABILITY_DOMAIN = 'botmux-preview-content-capability-v1\0';
const MAX_CAPABILITY_BYTES = 4_096;

/** Long enough for an ordinary working session, short enough that a copied
 *  preview URL dies on its own. The guard shell refreshes itself shortly
 *  before this elapses so a long-lived pane never silently breaks. */
export const PREVIEW_CONTENT_CAPABILITY_TTL_MS = 2 * 60 * 60_000;

/** Characters a capability may use inside a URL path segment. */
export const PREVIEW_CONTENT_CAPABILITY_PATTERN = /^[A-Za-z0-9_.-]{1,4096}$/;

export interface PreviewContentCapabilityClaims {
  version: 1;
  purpose: 'preview-content';
  sessionId: string;
  userId: string;
  authSessionId: string;
  capabilityId: string;
  issuedAt: number;
  expiresAt: number;
}

export interface PreviewContentCapabilityIdentity {
  userId: string;
  authSessionId: string;
  /** Authentication expiry of the minting identity; the capability never
   *  outlives the session that created it. */
  expiresAt: number;
}

export type PreviewContentCapabilityVerification =
  | { ok: true; claims: PreviewContentCapabilityClaims }
  | {
      ok: false;
      reason: 'missing' | 'malformed' | 'invalid' | 'expired' | 'session_mismatch';
    };

function boundedIdentity(value: string): boolean {
  return value.length > 0 && value.length <= 512 && !/[\r\n\0]/.test(value);
}

function exactCapabilityClaims(value: unknown): value is PreviewContentCapabilityClaims {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expected = [
    'authSessionId', 'capabilityId', 'expiresAt', 'issuedAt', 'purpose', 'sessionId', 'userId', 'version',
  ];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) return false;
  return record.version === 1
    && record.purpose === 'preview-content'
    && typeof record.sessionId === 'string' && boundedIdentity(record.sessionId)
    && typeof record.userId === 'string' && boundedIdentity(record.userId)
    && typeof record.authSessionId === 'string' && boundedIdentity(record.authSessionId)
    && typeof record.capabilityId === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(record.capabilityId)
    && Number.isSafeInteger(record.issuedAt) && (record.issuedAt as number) >= 0
    && Number.isSafeInteger(record.expiresAt) && (record.expiresAt as number) > (record.issuedAt as number);
}

function signature(secret: string, payload: string): Buffer {
  return createHmac('sha256', secret).update(CAPABILITY_DOMAIN).update(payload).digest();
}

/**
 * Mint the capability for one session. Returns null (never a fallback token)
 * for out-of-shape identities or an already-expired authentication, so the
 * caller fails closed instead of serving an unauthenticated content path.
 */
export function mintPreviewContentCapability(
  secret: string,
  sessionId: string,
  identity: PreviewContentCapabilityIdentity,
  now = Date.now(),
): { token: string; expiresAt: number } | null {
  if (!secret) return null;
  const expiresAt = Math.min(identity.expiresAt, now + PREVIEW_CONTENT_CAPABILITY_TTL_MS);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) return null;
  const claims: PreviewContentCapabilityClaims = {
    version: 1,
    purpose: 'preview-content',
    sessionId,
    userId: identity.userId,
    authSessionId: identity.authSessionId,
    capabilityId: randomBytes(18).toString('base64url'),
    issuedAt: now,
    expiresAt,
  };
  if (!exactCapabilityClaims(claims)) return null;
  const payload = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  const token = `${TOKEN_PREFIX}.${payload}.${signature(secret, payload).toString('base64url')}`;
  // A capability that cannot survive a URL path round-trip must not be issued.
  if (!PREVIEW_CONTENT_CAPABILITY_PATTERN.test(token)) return null;
  return { token, expiresAt };
}

export function verifyPreviewContentCapability(
  secret: string,
  token: string | undefined,
  expectedSessionId: string,
  now = Date.now(),
): PreviewContentCapabilityVerification {
  if (typeof token !== 'string' || !token) return { ok: false, reason: 'missing' };
  if (!secret || token.length > MAX_CAPABILITY_BYTES) return { ok: false, reason: 'malformed' };
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX
    || !/^[A-Za-z0-9_-]+$/.test(parts[1]) || !/^[A-Za-z0-9_-]+$/.test(parts[2])) {
    return { ok: false, reason: 'malformed' };
  }
  const expected = signature(secret, parts[1]);
  const provided = Buffer.from(parts[2], 'base64url');
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return { ok: false, reason: 'invalid' };
  }
  let parsed: unknown;
  try {
    const json = Buffer.from(parts[1], 'base64url').toString('utf8');
    if (Buffer.byteLength(json) > MAX_CAPABILITY_BYTES) return { ok: false, reason: 'malformed' };
    parsed = JSON.parse(json);
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (!exactCapabilityClaims(parsed)) return { ok: false, reason: 'malformed' };
  // Session binding is checked before expiry so a capability for another
  // session never reads as "merely stale".
  if (parsed.sessionId !== expectedSessionId) return { ok: false, reason: 'session_mismatch' };
  if (!Number.isFinite(now) || now < parsed.issuedAt - 30_000 || now >= parsed.expiresAt) {
    return { ok: false, reason: 'expired' };
  }
  return { ok: true, claims: parsed };
}
