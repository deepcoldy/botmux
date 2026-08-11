import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const TOKEN_PREFIX = 'bmxg1';
const GRANT_DOMAIN = 'botmux-terminal-control-grant-v1\0';
const MAX_GRANT_BYTES = 4_096;

export type TerminalControlScope = 'read' | 'write';

export interface TerminalControlGrantClaims {
  version: 1;
  scope: TerminalControlScope;
  sessionId: string;
  userId: string;
  authSessionId: string;
  grantId: string;
  issuedAt: number;
  expiresAt: number;
}

export type TerminalControlGrantVerification =
  | { ok: true; claims: TerminalControlGrantClaims }
  | { ok: false; reason: 'missing' | 'malformed' | 'invalid' | 'expired' | 'session_mismatch' };

function boundedIdentity(value: string): boolean {
  return value.length > 0 && value.length <= 512 && !/[\r\n\0]/.test(value);
}

function exactGrantClaims(value: unknown): value is TerminalControlGrantClaims {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expected = [
    'authSessionId', 'expiresAt', 'grantId', 'issuedAt', 'scope', 'sessionId', 'userId', 'version',
  ];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) return false;
  return record.version === 1
    && (record.scope === 'read' || record.scope === 'write')
    && typeof record.sessionId === 'string' && boundedIdentity(record.sessionId)
    && typeof record.userId === 'string' && boundedIdentity(record.userId)
    && typeof record.authSessionId === 'string' && boundedIdentity(record.authSessionId)
    && typeof record.grantId === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(record.grantId)
    && Number.isSafeInteger(record.issuedAt) && (record.issuedAt as number) >= 0
    && Number.isSafeInteger(record.expiresAt) && (record.expiresAt as number) > (record.issuedAt as number);
}

function signature(secret: string, payload: string): Buffer {
  return createHmac('sha256', secret).update(GRANT_DOMAIN).update(payload).digest();
}

/**
 * Mint a dashboard-to-worker grant. The returned capability is for the
 * loopback proxy hop only and must never be returned in an API body or URL.
 */
export function issueTerminalControlGrant(
  secret: string,
  input: Omit<TerminalControlGrantClaims, 'version' | 'grantId'> & { grantId?: string },
): string {
  if (!secret) throw new Error('terminal control secret is required');
  const claims: TerminalControlGrantClaims = {
    version: 1,
    scope: input.scope,
    sessionId: input.sessionId,
    userId: input.userId,
    authSessionId: input.authSessionId,
    grantId: input.grantId ?? randomBytes(18).toString('base64url'),
    issuedAt: input.issuedAt,
    expiresAt: input.expiresAt,
  };
  if (!exactGrantClaims(claims)) throw new Error('invalid terminal control grant claims');
  const payload = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  return `${TOKEN_PREFIX}.${payload}.${signature(secret, payload).toString('base64url')}`;
}

export function verifyTerminalControlGrant(
  secret: string,
  token: string | string[] | undefined,
  expectedSessionId: string,
  now = Date.now(),
): TerminalControlGrantVerification {
  if (typeof token !== 'string' || !token) return { ok: false, reason: 'missing' };
  if (!secret || token.length > MAX_GRANT_BYTES) return { ok: false, reason: 'malformed' };
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX || !/^[A-Za-z0-9_-]+$/.test(parts[1])
    || !/^[A-Za-z0-9_-]+$/.test(parts[2])) {
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
    if (Buffer.byteLength(json) > MAX_GRANT_BYTES) return { ok: false, reason: 'malformed' };
    parsed = JSON.parse(json);
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (!exactGrantClaims(parsed)) return { ok: false, reason: 'malformed' };
  if (parsed.sessionId !== expectedSessionId) return { ok: false, reason: 'session_mismatch' };
  if (!Number.isFinite(now) || now < parsed.issuedAt - 30_000 || now >= parsed.expiresAt) {
    return { ok: false, reason: 'expired' };
  }
  return { ok: true, claims: parsed };
}
