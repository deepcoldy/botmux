import { createHash, randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Brand } from '../im/lark/lark-hosts.js';
import { larkHosts } from '../im/lark/lark-hosts.js';
import {
  controlAuditRecord,
  type ControlAuditAction,
  type ControlAuditSink,
} from './control-audit.js';
import { logger } from '../utils/logger.js';

export const DASHBOARD_SESSION_COOKIE = 'botmux_dashboard_session';
export const DEFAULT_DASHBOARD_SESSION_TTL_MS = 30 * 60_000;
export const DASHBOARD_H5_CLIENT_TIMEOUT_MS = 8_000;
const MAX_AUTH_BODY_BYTES = 4 * 1024;
const DEFAULT_EXCHANGE_TIMEOUT_MS = 8_000;

/** Upper bound for the configured reverse-proxy hop count. Deployments chain a
 *  handful of proxies at most; a typo of `99` must not turn into "trust the
 *  whole client-supplied chain". */
export const DASHBOARD_H5_MAX_TRUSTED_PROXY_HOPS = 8;

export interface DashboardH5AuthConfig {
  enabled: boolean;
  brand: Brand;
  appId: string;
  appSecret: string;
  allowedOpenIds: readonly string[];
  entryPath: string;
  sessionTtlMs: number;
  secureCookies: boolean;
  /**
   * How many reverse-proxy hops sit in front of this dashboard and may be
   * trusted to have written `x-forwarded-for`. `0` (the default, and the only
   * safe value for a directly-exposed dashboard) means the header is ignored
   * outright and the socket peer address is the client. Required rather than
   * optional so every construction site states its proxy posture.
   */
  trustedProxyHops: number;
}

export interface DashboardAuthIdentity {
  kind: 'feishu-h5';
  userId: string;
  authSessionId: string;
  issuedAt: number;
  expiresAt: number;
}

export interface FeishuH5CodeExchanger {
  exchange(code: string, signal?: AbortSignal): Promise<{ openId: string }>;
}

export type DashboardSessionEndReason = 'expired' | 'logout';

interface StoredDashboardSession extends DashboardAuthIdentity {
  tokenHash: string;
  timer?: ReturnType<typeof setTimeout>;
}

export interface DashboardSessionStoreOptions {
  ttlMs?: number;
  now?: () => number;
  randomToken?: () => string;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
}

function tokenHash(token: string): string {
  return createHash('sha256').update('botmux-dashboard-h5-session-v1\0').update(token).digest('base64url');
}

/** Single-flight map key. Codes are one-time secrets — only digests may be
 *  used as (short-lived) map keys, mirroring the session-token policy above. */
function exchangeCodeKey(code: string): string {
  return createHash('sha256').update('botmux-dashboard-h5-exchange-code-v1\0').update(code).digest('base64url');
}

function validTtl(ttlMs: number): boolean {
  return Number.isSafeInteger(ttlMs) && ttlMs >= 60_000 && ttlMs <= 24 * 60 * 60_000;
}

/**
 * In-memory fixed-expiry Dashboard sessions. Only SHA-256 token digests are
 * retained; the opaque browser cookie value exists only during Set-Cookie and
 * request parsing. A dashboard restart intentionally signs everyone out.
 */
export class DashboardSessionStore {
  private readonly sessionsByHash = new Map<string, StoredDashboardSession>();
  private readonly hashesById = new Map<string, string>();
  private readonly listeners = new Set<(identity: DashboardAuthIdentity, reason: DashboardSessionEndReason) => void>();
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly randomToken: () => string;
  private readonly schedule: typeof setTimeout;
  private readonly cancel: typeof clearTimeout;

  constructor(opts: DashboardSessionStoreOptions = {}) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_DASHBOARD_SESSION_TTL_MS;
    if (!validTtl(this.ttlMs)) throw new RangeError('dashboard session TTL must be between 1 minute and 24 hours');
    this.now = opts.now ?? Date.now;
    this.randomToken = opts.randomToken ?? (() => randomBytes(32).toString('base64url'));
    this.schedule = opts.setTimer ?? setTimeout;
    this.cancel = opts.clearTimer ?? clearTimeout;
  }

  create(userId: string): { token: string; identity: DashboardAuthIdentity } {
    if (!validOpenId(userId)) throw new Error('invalid dashboard session user');
    const now = this.now();
    const token = this.randomToken();
    if (!/^[A-Za-z0-9_-]{32,256}$/.test(token)) throw new Error('invalid dashboard session token source');
    const identity: DashboardAuthIdentity = {
      kind: 'feishu-h5',
      userId,
      authSessionId: randomBytes(18).toString('base64url'),
      issuedAt: now,
      expiresAt: now + this.ttlMs,
    };
    const hash = tokenHash(token);
    const stored: StoredDashboardSession = { ...identity, tokenHash: hash };
    stored.timer = this.schedule(() => { this.expireHash(hash); }, this.ttlMs);
    stored.timer.unref?.();
    this.sessionsByHash.set(hash, stored);
    this.hashesById.set(identity.authSessionId, hash);
    return { token, identity };
  }

  resolveToken(token: string | undefined): DashboardAuthIdentity | null {
    if (!token || token.length > 512 || !/^[A-Za-z0-9_-]+$/.test(token)) return null;
    const hash = tokenHash(token);
    const stored = this.sessionsByHash.get(hash);
    if (!stored) return null;
    if (this.now() >= stored.expiresAt) {
      this.expireHash(hash);
      return null;
    }
    return this.publicIdentity(stored);
  }

  revokeToken(token: string | undefined): boolean {
    if (!token || token.length > 512 || !/^[A-Za-z0-9_-]+$/.test(token)) return false;
    return this.endHash(tokenHash(token), 'logout');
  }

  revokeAuthSession(authSessionId: string, reason: DashboardSessionEndReason = 'logout'): boolean {
    const hash = this.hashesById.get(authSessionId);
    return hash ? this.endHash(hash, reason) : false;
  }

  /** Whether this auth session is still alive (present and unexpired). Used as
   *  the revocation check for capabilities minted under the session (P1-5); a
   *  due-but-unswept session is expired inline so the answer is authoritative. */
  liveAuthSession(authSessionId: string): boolean {
    const hash = this.hashesById.get(authSessionId);
    if (!hash) return false;
    const stored = this.sessionsByHash.get(hash);
    if (!stored) return false;
    if (this.now() >= stored.expiresAt) {
      this.expireHash(hash);
      return false;
    }
    return true;
  }

  sweepExpired(): number {
    const before = this.sessionsByHash.size;
    for (const [hash, session] of this.sessionsByHash) {
      if (this.now() >= session.expiresAt) this.expireHash(hash);
    }
    return before - this.sessionsByHash.size;
  }

  onEnd(listener: (identity: DashboardAuthIdentity, reason: DashboardSessionEndReason) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private expireHash(hash: string): boolean {
    return this.endHash(hash, 'expired');
  }

  private endHash(hash: string, reason: DashboardSessionEndReason): boolean {
    const stored = this.sessionsByHash.get(hash);
    if (!stored) return false;
    this.sessionsByHash.delete(hash);
    this.hashesById.delete(stored.authSessionId);
    if (stored.timer) this.cancel(stored.timer);
    const identity = this.publicIdentity(stored);
    for (const listener of this.listeners) {
      try { listener(identity, reason); } catch { /* listeners are isolation boundaries */ }
    }
    return true;
  }

  private publicIdentity(stored: StoredDashboardSession): DashboardAuthIdentity {
    return {
      kind: 'feishu-h5',
      userId: stored.userId,
      authSessionId: stored.authSessionId,
      issuedAt: stored.issuedAt,
      expiresAt: stored.expiresAt,
    };
  }
}

export function validOpenId(value: string): boolean {
  return value.length >= 3 && value.length <= 256 && !/[\s\0]/.test(value);
}

export function parseNamedCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0 || part.slice(0, eq).trim() !== name) continue;
    return part.slice(eq + 1).trim() || undefined;
  }
  return undefined;
}

export function dashboardSessionCookie(token: string, ttlMs: number, secure = false): string {
  const maxAge = Math.max(1, Math.floor(ttlMs / 1000));
  return `${DASHBOARD_SESSION_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

export function clearDashboardSessionCookie(secure = false): string {
  return `${DASHBOARD_SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure ? '; Secure' : ''}`;
}

export function resolveDashboardH5AuthConfig(env: NodeJS.ProcessEnv = process.env): DashboardH5AuthConfig {
  const entryCandidate = env.BOTMUX_DASHBOARD_FEISHU_H5_ENTRY_PATH?.trim() || '/auth/feishu';
  const entryPath = /^\/[A-Za-z0-9/_-]{1,127}$/.test(entryCandidate) && !entryCandidate.includes('//')
    ? entryCandidate.replace(/\/$/, '')
    : '/auth/feishu';
  const rawTtl = Number(env.BOTMUX_DASHBOARD_FEISHU_H5_SESSION_TTL_MS);
  const sessionTtlMs = validTtl(rawTtl) ? rawTtl : DEFAULT_DASHBOARD_SESSION_TTL_MS;
  const publicUrl = env.BOTMUX_PUBLIC_URL?.trim() ?? '';
  // Absent/blank/garbage all mean "no trusted proxy" — the value that makes
  // `x-forwarded-for` unspoofable because it is not read at all.
  const rawHops = Number(env.BOTMUX_DASHBOARD_FEISHU_H5_TRUSTED_PROXY_HOPS);
  const trustedProxyHops = Number.isSafeInteger(rawHops)
    && rawHops > 0 && rawHops <= DASHBOARD_H5_MAX_TRUSTED_PROXY_HOPS
    ? rawHops
    : 0;
  return {
    enabled: (env.BOTMUX_DASHBOARD_FEISHU_H5_ENABLED ?? 'false').toLowerCase() === 'true',
    brand: env.BOTMUX_DASHBOARD_FEISHU_H5_BRAND === 'lark' ? 'lark' : 'feishu',
    appId: env.BOTMUX_DASHBOARD_FEISHU_H5_APP_ID?.trim() || '',
    appSecret: env.BOTMUX_DASHBOARD_FEISHU_H5_APP_SECRET?.trim() || '',
    allowedOpenIds: (env.BOTMUX_DASHBOARD_FEISHU_H5_ALLOWED_OPEN_IDS ?? '')
      .split(',').map(value => value.trim()).filter(validOpenId),
    entryPath,
    sessionTtlMs,
    secureCookies: publicUrl.startsWith('https://')
      || (env.BOTMUX_DASHBOARD_FEISHU_H5_SECURE_COOKIE ?? '').toLowerCase() === 'true',
    trustedProxyHops,
  };
}

export interface FeishuH5CodeExchangerOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

interface FeishuEnvelope {
  code?: unknown;
  app_access_token?: unknown;
  data?: Record<string, unknown>;
}

/**
 * Feishu H5 `requestAccess` / `requestAuthCode` compatible exchange. Tokens
 * from Feishu stay in local variables long enough to fetch `open_id` and are
 * never cached, logged, returned, or copied into the Dashboard session.
 */
export function createFeishuH5CodeExchanger(
  config: Pick<DashboardH5AuthConfig, 'brand' | 'appId' | 'appSecret'>,
  opts: FeishuH5CodeExchangerOptions = {},
): FeishuH5CodeExchanger {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_EXCHANGE_TIMEOUT_MS;
  const base = larkHosts(config.brand).openApi;
  return {
    async exchange(code: string, outerSignal?: AbortSignal): Promise<{ openId: string }> {
      if (!config.appId || !config.appSecret) throw new Error('auth_not_configured');
      const controller = new AbortController();
      const onAbort = () => controller.abort();
      outerSignal?.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      timer.unref?.();
      try {
        const appResponse = await fetchImpl(`${base}/open-apis/auth/v3/app_access_token/internal`, {
          method: 'POST',
          headers: { 'content-type': 'application/json; charset=utf-8' },
          body: JSON.stringify({ app_id: config.appId, app_secret: config.appSecret }),
          signal: controller.signal,
        });
        const appBody = await appResponse.json().catch(() => null) as FeishuEnvelope | null;
        const appAccessToken = appBody?.code === 0 && typeof appBody.app_access_token === 'string'
          ? appBody.app_access_token
          : undefined;
        if (!appResponse.ok || !appAccessToken) throw new Error('provider_rejected');

        const userResponse = await fetchImpl(`${base}/open-apis/authen/v1/access_token`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json; charset=utf-8',
            authorization: `Bearer ${appAccessToken}`,
          },
          body: JSON.stringify({ grant_type: 'authorization_code', code }),
          signal: controller.signal,
        });
        const userBody = await userResponse.json().catch(() => null) as FeishuEnvelope | null;
        if (!userResponse.ok || userBody?.code !== 0 || !userBody.data) throw new Error('provider_rejected');
        const directOpenId = userBody.data.open_id;
        if (typeof directOpenId === 'string' && validOpenId(directOpenId)) return { openId: directOpenId };

        // Some compatible responses only return user_access_token. Resolve the
        // identity and immediately discard that token as well.
        const userAccessToken = userBody.data.access_token;
        if (typeof userAccessToken !== 'string' || !userAccessToken) throw new Error('provider_identity_missing');
        const infoResponse = await fetchImpl(`${base}/open-apis/authen/v1/user_info`, {
          headers: {
            authorization: `Bearer ${userAccessToken}`,
            'content-type': 'application/json; charset=utf-8',
          },
          signal: controller.signal,
        });
        const infoBody = await infoResponse.json().catch(() => null) as FeishuEnvelope | null;
        const openId = infoBody?.data?.open_id;
        if (!infoResponse.ok || infoBody?.code !== 0 || typeof openId !== 'string' || !validOpenId(openId)) {
          throw new Error('provider_identity_missing');
        }
        return { openId };
      } finally {
        clearTimeout(timer);
        outerSignal?.removeEventListener('abort', onAbort);
      }
    },
  };
}

export const DASHBOARD_H5_EXCHANGE_WINDOW_MS = 60_000;
export const DASHBOARD_H5_EXCHANGE_MAX_PER_IP_PER_WINDOW = 10;
export const DASHBOARD_H5_EXCHANGE_MAX_CONCURRENT = 4;
/** Ceiling for the endpoint as a whole, across every source address. The
 *  per-IP window alone bounds one client; this bounds the endpoint when the
 *  attacker has many source addresses (or one trusted proxy in front of many
 *  forged client addresses). */
export const DASHBOARD_H5_EXCHANGE_MAX_GLOBAL_PER_WINDOW = 60;
/** Hard cap on tracked per-IP buckets. Reaching it evicts the least recently
 *  used bucket (O(1)); it never degrades into a per-request full-table scan. */
export const DASHBOARD_H5_EXCHANGE_MAX_TRACKED_IPS = 4_096;
const EXCHANGE_BUSY_RETRY_MS = 1_000;
const EXCHANGE_GATE_MAX_SPENT_CODES = 4_096;

function normalizeIpCandidate(value: string | undefined): string {
  const trimmed = (value ?? '').trim();
  if (!trimmed) return '';
  // IPv4-mapped IPv6 prefixes are stripped to match the dashboard's other
  // remote-address handling (dashboard.ts verifyCliRequest).
  return trimmed.replace(/^::ffff:/i, '').slice(0, 100);
}

/**
 * Rate-limit bucket key for the public exchange endpoint, resolved under a
 * TRUSTED-PROXY discipline (`proxy-addr` semantics, zero dependencies).
 *
 * `x-forwarded-for` is client-supplied text: anyone can send it, and each
 * proxy only appends. Trusting the leftmost hop therefore hands an attacker an
 * unlimited supply of distinct bucket keys — a per-IP limiter you can opt out
 * of by typing a new IP, plus an attacker-driven tracking table.
 *
 * So the chain is read from the end WE control: `[socket peer, ...forwarded
 * reversed]`, and `trustedProxyHops` says how many of those leading entries
 * were written by infrastructure we trust. The first entry past them is the
 * client. With the default `0` the header is never consulted at all; with `1`
 * only the rightmost `x-forwarded-for` entry counts — the one the single
 * trusted proxy wrote itself — so any value the client prepended sits beyond
 * the trusted window and can never become a bucket key. A shorter-than-
 * configured chain falls back to the furthest address actually present, which
 * is at worst the direct peer.
 *
 * The value is only ever an opaque bucket key: it grants nothing.
 */
export function dashboardH5ClientIp(req: IncomingMessage, trustedProxyHops = 0): string {
  const socketAddress = normalizeIpCandidate(req.socket?.remoteAddress);
  const hops = Number.isSafeInteger(trustedProxyHops)
    ? Math.min(Math.max(trustedProxyHops, 0), DASHBOARD_H5_MAX_TRUSTED_PROXY_HOPS)
    : 0;
  if (hops === 0) return socketAddress || 'unknown';
  const header = req.headers['x-forwarded-for'];
  // Repeated headers are one logical list in wire order, so join before split.
  const forwarded = (Array.isArray(header) ? header.join(',') : header ?? '')
    .split(',')
    .map(normalizeIpCandidate)
    .filter(Boolean);
  const chain = [socketAddress, ...forwarded.reverse()].filter(Boolean);
  if (chain.length === 0) return 'unknown';
  return chain[Math.min(hops, chain.length - 1)];
}

export interface DashboardH5ExchangeGateOptions {
  now?: () => number;
  windowMs?: number;
  maxPerIpPerWindow?: number;
  maxGlobalPerWindow?: number;
  maxConcurrent?: number;
  maxTrackedIps?: number;
  maxSpentCodes?: number;
  spentCodeTtlMs?: number;
  pruneIntervalMs?: number;
}

export type H5ExchangeAdmission = { ok: true } | { ok: false; retryAfterMs: number };

/**
 * In-process brakes for the public, unauthenticated H5 exchange endpoint.
 * One exchange can cost up to three open-platform requests, so several
 * independent limits apply (LocateRateLimiter-style, zero dependencies).
 *
 * The admission half (`admit`/`prune`) is deliberately generic and is reused by
 * the other pre-auth public surface, `GET /workbench-ticket/<ticket>` (see
 * dashboard/workbench-ticket.ts), with its own budgets; only the code-specific
 * halves (`share`/`markSpent`) are exchange-only:
 *
 *  - per-IP sliding window (`admit`) — only admitted hits consume slots, so
 *    a refused burst cannot lock a NAT'd office out forever;
 *  - global sliding window (`admit`) — the same endpoint-wide ceiling in
 *    requests-per-window, so "many source addresses" is not a way around the
 *    per-IP budget. It is checked AFTER the per-IP budget and consumed only on
 *    admission, so one noisy client can spend at most its own per-IP quota out
 *    of the shared pool. Implemented as a fixed-size ring of admission
 *    timestamps: exact sliding-window semantics with an honest Retry-After, in
 *    O(1) per request and O(cap) memory;
 *  - bounded IP tracking — the table never exceeds `maxTrackedIps`; a new
 *    bucket past the cap evicts the least recently used one in O(1). Pruning
 *    idle buckets (`prune`) is a memory tidy-up on a timer, NOT the bound, so
 *    a saturated table can never turn into a full-table scan per request;
 *  - single-flight per code plus a global in-flight cap (`share`) —
 *    concurrent duplicates of one code join the same upstream flight, and
 *    distinct codes beyond the cap are fast-rejected rather than queued so
 *    spam cannot stack pending exchanges on the dashboard event loop;
 *  - spent-code memory (`markSpent`/`isSpent`) — a code that already minted a
 *    session is refused outright afterwards, so "one-time" holds for a
 *    sequential replay too, not just for the concurrent window. Only the code
 *    DIGEST is kept (never the code, never the session token), with a TTL and
 *    its own bounded LRU.
 *
 * The clock is injectable for tests.
 */
export class DashboardH5ExchangeGate {
  /** Insertion-ordered ⇒ iteration starts at the least recently used bucket. */
  private readonly hitsByIp = new Map<string, number[]>();
  private readonly inFlightByKey = new Map<string, Promise<unknown>>();
  /** code digest → expiry. Uniform TTL ⇒ insertion order is also expiry order. */
  private readonly spentByKey = new Map<string, number>();
  private readonly globalHits: number[];
  private globalNext = 0;
  private globalFilled = 0;
  private readonly now: () => number;
  private readonly windowMs: number;
  private readonly maxPerIpPerWindow: number;
  private readonly maxTrackedIps: number;
  private readonly maxSpentCodes: number;
  private readonly spentCodeTtlMs: number;
  private readonly maxConcurrent: number;
  private readonly pruneIntervalMs: number;
  private lastPruneAt: number;
  private sweeps = 0;

  constructor(opts: DashboardH5ExchangeGateOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.windowMs = opts.windowMs ?? DASHBOARD_H5_EXCHANGE_WINDOW_MS;
    this.maxPerIpPerWindow = opts.maxPerIpPerWindow ?? DASHBOARD_H5_EXCHANGE_MAX_PER_IP_PER_WINDOW;
    this.maxConcurrent = opts.maxConcurrent ?? DASHBOARD_H5_EXCHANGE_MAX_CONCURRENT;
    this.maxTrackedIps = Math.max(1, opts.maxTrackedIps ?? DASHBOARD_H5_EXCHANGE_MAX_TRACKED_IPS);
    this.maxSpentCodes = Math.max(1, opts.maxSpentCodes ?? EXCHANGE_GATE_MAX_SPENT_CODES);
    this.spentCodeTtlMs = Math.max(1, opts.spentCodeTtlMs ?? this.windowMs);
    const globalCap = Math.max(1, Math.min(opts.maxGlobalPerWindow ?? DASHBOARD_H5_EXCHANGE_MAX_GLOBAL_PER_WINDOW, 100_000));
    this.globalHits = new Array<number>(globalCap).fill(0);
    this.pruneIntervalMs = opts.pruneIntervalMs ?? this.windowMs;
    this.lastPruneAt = this.now();
  }

  /**
   * Per-IP then endpoint-wide sliding-window admission. Refusals carry an
   * honest Retry-After and consume nothing — neither budget, and (for an
   * unknown IP) not a tracking-table slot either.
   */
  admit(ip: string): H5ExchangeAdmission {
    const now = this.now();
    // Time-based only. The table's hard bound is the LRU eviction in
    // `remember()`, so a saturated table never makes this a per-request scan.
    if (now - this.lastPruneAt >= this.pruneIntervalMs) this.prune();
    const cutoff = now - this.windowMs;
    const known = this.hitsByIp.get(ip);
    const hits = known ? known.filter(at => at > cutoff) : [];
    if (hits.length >= this.maxPerIpPerWindow) {
      this.remember(ip, hits);
      return { ok: false, retryAfterMs: Math.max(1, hits[0] + this.windowMs - now) };
    }
    const globalRetryAfterMs = this.globalRetryAfterMs(now);
    if (globalRetryAfterMs !== null) {
      // Keep an already-tracked bucket tidy, but never let a refused request
      // from an unknown address create (and evict) a tracking entry.
      if (known) this.remember(ip, hits);
      return { ok: false, retryAfterMs: globalRetryAfterMs };
    }
    this.globalHits[this.globalNext] = now;
    this.globalNext = (this.globalNext + 1) % this.globalHits.length;
    if (this.globalFilled < this.globalHits.length) this.globalFilled += 1;
    hits.push(now);
    this.remember(ip, hits);
    return { ok: true };
  }

  /** `null` when the endpoint-wide window still has room. */
  private globalRetryAfterMs(now: number): number | null {
    if (this.globalFilled < this.globalHits.length) return null;
    const oldest = this.globalHits[this.globalNext];
    const retryAfterMs = oldest + this.windowMs - now;
    return retryAfterMs > 0 ? retryAfterMs : null;
  }

  /** Store a bucket at the young end of the LRU, evicting the oldest if the
   *  table is full. Constant time: `delete` + `set` re-inserts, and at most one
   *  entry is dropped per new key. */
  private remember(ip: string, hits: number[]): void {
    if (!this.hitsByIp.delete(ip) && this.hitsByIp.size >= this.maxTrackedIps) {
      const oldest = this.hitsByIp.keys().next();
      if (!oldest.done) this.hitsByIp.delete(oldest.value);
    }
    this.hitsByIp.set(ip, hits);
  }

  /** Remember that this code digest already minted a session. */
  markSpent(key: string): void {
    if (!this.spentByKey.delete(key) && this.spentByKey.size >= this.maxSpentCodes) {
      const oldest = this.spentByKey.keys().next();
      if (!oldest.done) this.spentByKey.delete(oldest.value);
    }
    this.spentByKey.set(key, this.now() + this.spentCodeTtlMs);
  }

  /** Whether this code digest already minted a session (within the TTL). */
  isSpent(key: string): boolean {
    const expiresAt = this.spentByKey.get(key);
    if (expiresAt === undefined) return false;
    if (this.now() >= expiresAt) {
      this.spentByKey.delete(key);
      return false;
    }
    return true;
  }

  /**
   * Single-flight + global concurrency. A key already in flight joins the
   * existing promise (never re-hits the open platform, exempt from the cap);
   * a new key beyond `maxConcurrent` is refused for a fast 429.
   */
  share<T>(key: string, start: () => Promise<T>):
    | { ok: true; result: Promise<T> }
    | { ok: false; retryAfterMs: number } {
    const existing = this.inFlightByKey.get(key);
    if (existing) return { ok: true, result: existing as Promise<T> };
    if (this.inFlightByKey.size >= this.maxConcurrent) {
      return { ok: false, retryAfterMs: EXCHANGE_BUSY_RETRY_MS };
    }
    const flight = start();
    this.inFlightByKey.set(key, flight);
    const settle = () => { this.inFlightByKey.delete(key); };
    // then(settle, settle) — a .finally() chain would itself reject on
    // failure and surface as an unhandled rejection.
    flight.then(settle, settle);
    return { ok: true, result: flight };
  }

  /** Drop IP buckets and spent-code digests that have left their window. The
   *  one full-table pass in this class — on a timer, never per request. */
  prune(): void {
    const now = this.now();
    const cutoff = now - this.windowMs;
    for (const [ip, hits] of this.hitsByIp) {
      const live = hits.filter(at => at > cutoff);
      if (live.length === 0) this.hitsByIp.delete(ip);
      else if (live.length !== hits.length) this.hitsByIp.set(ip, live);
    }
    for (const [key, expiresAt] of this.spentByKey) {
      if (now >= expiresAt) this.spentByKey.delete(key);
    }
    this.sweeps += 1;
    this.lastPruneAt = now;
  }

  trackedIpCount(): number { return this.hitsByIp.size; }
  inFlightCount(): number { return this.inFlightByKey.size; }
  spentCodeCount(): number { return this.spentByKey.size; }
  /** Full-table sweeps performed so far. Diagnostic: this must stay flat as
   *  request volume grows, otherwise admission has become O(table). */
  sweepCount(): number { return this.sweeps; }
}

export interface DashboardH5AuthControllerOptions {
  config: DashboardH5AuthConfig;
  sessions: DashboardSessionStore;
  exchanger?: FeishuH5CodeExchanger;
  exchangeGate?: DashboardH5ExchangeGate;
  audit: ControlAuditSink;
}

export interface DashboardH5AuthController {
  entryPath: string;
  exchangePath: string;
  sessionPath: string;
  logoutPath: string;
  resolve(req: IncomingMessage): DashboardAuthIdentity | null;
  handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean>;
}

function rateLimited(res: ServerResponse, error: string, retryAfterMs: number): void {
  const retryAfterSeconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
  json(res, 429, { ok: false, error, retryAfterSeconds }, { 'retry-after': String(retryAfterSeconds) });
}

function json(res: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    ...headers,
  });
  res.end(JSON.stringify(value));
}

async function readCode(req: IncomingMessage): Promise<string | null> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const raw of req) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    bytes += chunk.byteLength;
    if (bytes > MAX_AUTH_BODY_BYTES) return null;
    chunks.push(chunk);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return null; }
  const code = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as { code?: unknown }).code
    : undefined;
  return typeof code === 'string' && code.length >= 4 && code.length <= 2_048 && !/[\s\0]/.test(code)
    ? code
    : null;
}

export function safeDashboardH5ReturnTo(value: string | null | undefined): string {
  if (!value || value.length > 1_024 || !value.startsWith('/#/agent-workbench')) return '/';
  const hash = value.slice(1).split('?')[0].replace(/\/+$/, '');
  const bases = ['#/agent-workbench-dock', '#/agent-workbench'];
  for (const base of bases) {
    if (hash === base) return `/${base}`;
    if (!hash.startsWith(`${base}/`)) continue;
    const encoded = hash.slice(base.length + 1);
    let decoded: string;
    try { decoded = decodeURIComponent(encoded); } catch { return '/'; }
    if (!decoded || decoded.length > 512 || /[\u0000-\u001f\u007f]/.test(decoded)) return '/';
    return `/${base}/${encodeURIComponent(decoded)}`;
  }
  return '/';
}

function h5EntryHtml(appId: string, exchangePath: string, returnTo = '/'): string {
  const safeAppId = JSON.stringify(appId).replace(/</g, '\\u003c');
  const safeExchangePath = JSON.stringify(exchangePath).replace(/</g, '\\u003c');
  const safeReturnTo = JSON.stringify(safeDashboardH5ReturnTo(returnTo)).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer"><title>Botmux Dashboard 登录</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f5f6f8;font:15px/1.6 system-ui;color:#1f2329}.card{max-width:420px;margin:24px;padding:28px;border:1px solid #d0d3d8;border-radius:4px;background:#fff}h1{font-size:20px;margin:0 0 8px}p{color:#646a73}button{border:1px solid #3370ff;border-radius:2px;padding:9px 18px;background:#fff;color:#245bdb}#error{color:#d54941}</style>
</head>
<body><main class="card"><h1>正在验证飞书身份</h1><p id="status">请在飞书客户端中打开此入口。</p><p id="error" role="alert"></p><button id="retry" hidden>重试</button></main>
<script>(function(){
var appId=${safeAppId},endpoint=${safeExchangePath},returnTo=${safeReturnTo},status=document.getElementById('status'),error=document.getElementById('error'),retry=document.getElementById('retry'),attempt=0,timer=0,controller=null,sdkScript=null,timeoutMs=${DASHBOARD_H5_CLIENT_TIMEOUT_MS},sdkUrl='https://lf-scm-cn.feishucdn.com/lark/op/h5-js-sdk-1.5.44.js';
function fail(id){if(id!==undefined&&id!==attempt)return;if(controller){controller.abort();controller=null}if(sdkScript){sdkScript.onload=sdkScript.onerror=null;sdkScript.remove();sdkScript=null}clearTimeout(timer);timer=0;attempt++;status.textContent='未能完成免登。';error.textContent='请确认正在飞书客户端中打开，或联系管理员检查入口配置。';retry.hidden=false}
function exchange(code,id){if(id!==attempt)return;controller=typeof AbortController==='function'?new AbortController():null;fetch(endpoint,{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({code:code}),signal:controller?controller.signal:undefined}).then(function(r){if(!r.ok)throw new Error('denied');return r.json()}).then(function(){if(id!==attempt)return;clearTimeout(timer);timer=0;controller=null;location.replace(returnTo)}).catch(function(){fail(id)})}
function auth(id){if(id!==attempt)return;if(!window.tt){fail(id);return}var fallback=function(){if(id!==attempt)return;try{window.tt.requestAuthCode({appId:appId,success:function(r){exchange(r&&r.code,id)},fail:function(){fail(id)}})}catch(e){fail(id)}};try{if(window.tt.requestAccess){window.tt.requestAccess({appID:appId,scopeList:[],success:function(r){exchange(r&&r.code,id)},fail:function(e){if(e&&e.errno===103)fallback();else fail(id)}})}else fallback()}catch(e){fail(id)}}
function ready(id){if(id!==attempt)return;try{if(window.h5sdk&&window.h5sdk.ready)window.h5sdk.ready(function(){auth(id)});else auth(id)}catch(e){fail(id)}}
function loadSdk(id){if(window.tt||window.h5sdk){ready(id);return}sdkScript=document.createElement('script');sdkScript.src=sdkUrl;sdkScript.async=true;sdkScript.referrerPolicy='no-referrer';sdkScript.onload=function(){sdkScript=null;ready(id)};sdkScript.onerror=function(){sdkScript=null;fail(id)};document.head.appendChild(sdkScript)}
function begin(){var id=++attempt;if(controller){controller.abort();controller=null}if(sdkScript){sdkScript.onload=sdkScript.onerror=null;sdkScript.remove();sdkScript=null}clearTimeout(timer);error.textContent='';retry.hidden=true;status.textContent='正在验证飞书身份…';timer=setTimeout(function(){fail(id)},timeoutMs);loadSdk(id)}
retry.addEventListener('click',begin);begin();
})();</script></body></html>`;
}

/** Outcome of the ONE upstream exchange a given code is ever allowed to drive.
 *  It carries the minted session, so concurrent replays of the code join the
 *  same flight and receive this same cookie instead of each minting their own
 *  independently-revocable session. */
type H5ExchangeOutcome =
  | { ok: true; openId: string; token: string; expiresAt: number }
  | { ok: false; openId: string };

/**
 * 本地环节（审计落盘、会话创建）失败的标记，与「飞书上游换取 open_id 失败」
 * 严格区分：两者的排查方向完全相反——上游失败要去查飞书应用配置与网络，本地
 * 失败是磁盘满 / 审计路径不可写。把两者都报成 `feishu_exchange_failed`，会让
 * 一块写满的磁盘看起来像飞书应用配错了。
 */
class DashboardH5LocalFailure extends Error {
  constructor(readonly stage: string, readonly reason: unknown) {
    super(`dashboard h5 local failure at ${stage}`);
    this.name = 'DashboardH5LocalFailure';
  }
}

/** 只进本机 daemon 日志的错因摘要——绝不进 HTTP 响应体（错误串可能带审计文件
 *  路径 / errno，那是运维信息，不是给客户端看的）。 */
function describeFailure(reason: unknown): string {
  return reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason);
}

export function createDashboardH5AuthController(opts: DashboardH5AuthControllerOptions): DashboardH5AuthController {
  const { config, sessions, audit } = opts;
  const exchanger = opts.exchanger ?? createFeishuH5CodeExchanger(config);
  const exchangeGate = opts.exchangeGate ?? new DashboardH5ExchangeGate();
  const allowed = new Set(config.allowedOpenIds);
  const entryPath = config.entryPath;
  const exchangePath = `${entryPath}/exchange`;
  const sessionPath = `${entryPath}/session`;
  const logoutPath = `${entryPath}/logout`;
  const resolve = (req: IncomingMessage) => sessions.resolveToken(
    parseNamedCookie(req.headers.cookie, DASHBOARD_SESSION_COOKIE),
  );

  /** 落日志前抹掉 appSecret：错因只进本机 daemon 日志，但上游客户端的错误串万一
   *  带上凭据，也不能就这么写进日志文件。 */
  const describeForLog = (reason: unknown): string => {
    const text = describeFailure(reason);
    return config.appSecret ? text.split(config.appSecret).join('***') : text;
  };

  /** 审计写不进去 = fail closed，但要让调用方认得出这是本地故障而非上游故障。 */
  const auditOrFail = (userId: string, action: ControlAuditAction): void => {
    try {
      audit.append(controlAuditRecord(userId, 'dashboard', action));
    } catch (error) {
      throw new DashboardH5LocalFailure(`audit ${action}`, error);
    }
  };

  /**
   * The whole login decision for one code, run exactly once under the gate's
   * single-flight: provider call, allowlist check, session creation and the
   * audit record. Everything lives inside so that N concurrent replays produce
   * ONE upstream call, ONE session and ONE audit line — not N of each.
   */
  const exchangeOnce = async (codeKey: string, code: string): Promise<H5ExchangeOutcome> => {
    let openId: string;
    try {
      ({ openId } = await exchanger.exchange(code));
    } catch (error) {
      // 上游的错因优先：审计再写不进去也不能把它盖掉，否则日志里只剩本地错误、
      // 看不出飞书那边到底怎么了。这条路径本来就要抛，没有任何状态要 fail closed。
      try {
        audit.append(controlAuditRecord('unknown', 'dashboard', 'auth.login_denied'));
      } catch (auditError) {
        logger.error(`[dashboard-h5] auth.login_denied 审计写入失败：${describeForLog(auditError)}`);
      }
      throw error;
    }
    if (!allowed.has(openId)) {
      auditOrFail(openId, 'auth.login_denied');
      return { ok: false, openId };
    }
    // 审计先行，与 terminal-control 的 takeover 同一套 fail-closed 顺序：durable
    // 审计写不进去就一条不可逆状态都不落。反过来（先建 session、先烧 code、再写
    // 审计）一旦写失败，会留下浏览器永远拿不到的孤儿 session，还白白烧掉这个一
    // 次性 code，让用户连重试都换不回登录。
    // openId 已过 allowlist（配置侧按 validOpenId 过滤），create 只会因非法
    // openId/token 抛错，此处不会在审计落地后再失败。
    auditOrFail(openId, 'auth.login');
    let created: { token: string; identity: DashboardAuthIdentity };
    try {
      created = sessions.create(openId);
    } catch (error) {
      throw new DashboardH5LocalFailure('session create', error);
    }
    // Burn the code the moment it becomes a session: a later, non-concurrent
    // replay must not mint a second one even if the provider would answer
    // again. Only the digest is retained — never the code, never the token.
    exchangeGate.markSpent(codeKey);
    return { ok: true, openId, token: created.token, expiresAt: created.identity.expiresAt };
  };

  const handle = async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> => {
    const relevant = url.pathname === entryPath || url.pathname === exchangePath
      || url.pathname === sessionPath || url.pathname === logoutPath;
    if (!relevant) return false;
    if (!config.enabled) {
      json(res, 404, { ok: false, error: 'h5_auth_disabled' });
      return true;
    }
    if (!config.appId || !config.appSecret || allowed.size === 0) {
      json(res, 503, { ok: false, error: 'h5_auth_not_configured' });
      return true;
    }

    if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname === entryPath) {
      const body = h5EntryHtml(config.appId, exchangePath, url.searchParams.get('returnTo') ?? '/');
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; script-src 'self' 'unsafe-inline' https://lf-scm-cn.feishucdn.com; style-src 'unsafe-inline'; connect-src 'self'; img-src 'none'; base-uri 'none'; frame-ancestors 'self' https://*.feishu.cn https://*.larksuite.com",
      });
      if (req.method === 'HEAD') res.end(); else res.end(body);
      return true;
    }

    if (req.method === 'POST' && url.pathname === exchangePath) {
      // Requiring JSON makes cross-origin browser submission non-simple: a
      // hostile origin must pass a CORS preflight, and this controller exposes
      // no CORS permission. Plain HTML forms/text bodies therefore cannot turn
      // a one-time code into a login-CSRF cookie.
      const contentType = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
      if (contentType !== 'application/json') {
        json(res, 415, { ok: false, error: 'unsupported_media_type' });
        return true;
      }
      // Public endpoint, and each exchange can cost up to three open-platform
      // requests: rate-limit per IP before even reading the body. The slot is
      // consumed on attempt (invalid bodies included), like LocateRateLimiter.
      const admission = exchangeGate.admit(dashboardH5ClientIp(req, config.trustedProxyHops));
      if (!admission.ok) {
        rateLimited(res, 'rate_limited', admission.retryAfterMs);
        return true;
      }
      const code = await readCode(req);
      if (!code) {
        json(res, 400, { ok: false, error: 'invalid_authorization_code' });
        return true;
      }
      const codeKey = exchangeCodeKey(code);
      // The spent check and the single-flight lookup must observe the same
      // tick — no `await` between them. Otherwise a code whose flight settles
      // in the gap would be seen as neither spent nor in flight, and the
      // replay would open a second flight and mint a second session.
      if (exchangeGate.isSpent(codeKey)) {
        json(res, 409, { ok: false, error: 'authorization_code_already_used' });
        return true;
      }
      // Concurrent duplicates of one code share a single upstream flight AND
      // its single session; distinct codes beyond the global cap 429
      // immediately (never queue, so spam cannot stack pending exchanges on
      // the event loop).
      const flight = exchangeGate.share(codeKey, () => exchangeOnce(codeKey, code));
      if (!flight.ok) {
        rateLimited(res, 'exchange_busy', flight.retryAfterMs);
        return true;
      }
      let outcome: H5ExchangeOutcome;
      try {
        outcome = await flight.result;
      } catch (error) {
        // 错因分流：本地故障（审计不可写 / 建会话失败）报 503，飞书上游故障才
        // 报 502。原始错因只落 daemon 日志——曾经这里是裸 catch，磁盘写满会让
        // 全量登录静默失败并谎称是飞书的问题，日志里一条线索都没有。
        if (error instanceof DashboardH5LocalFailure) {
          logger.error(`[dashboard-h5] 登录本地失败（${error.stage}）：${describeForLog(error.reason)}`);
          json(res, 503, { ok: false, error: 'login_unavailable' });
          return true;
        }
        logger.warn(`[dashboard-h5] 飞书换取 open_id 失败：${describeForLog(error)}`);
        json(res, 502, { ok: false, error: 'feishu_exchange_failed' });
        return true;
      }
      if (!outcome.ok) {
        json(res, 403, { ok: false, error: 'open_id_not_allowed' });
        return true;
      }
      json(res, 200, {
        ok: true,
        user: { openId: outcome.openId },
        expiresAt: outcome.expiresAt,
        redirectTo: '/',
      }, { 'set-cookie': dashboardSessionCookie(outcome.token, config.sessionTtlMs, config.secureCookies) });
      return true;
    }

    if (req.method === 'GET' && url.pathname === sessionPath) {
      const identity = resolve(req);
      if (!identity) {
        json(res, 401, { ok: false, error: 'authentication_required' });
      } else {
        json(res, 200, { ok: true, user: { openId: identity.userId }, expiresAt: identity.expiresAt });
      }
      return true;
    }

    if (req.method === 'POST' && url.pathname === logoutPath) {
      const identity = resolve(req);
      if (!identity) {
        json(res, 401, { ok: false, error: 'authentication_required' });
        return true;
      }
      const token = parseNamedCookie(req.headers.cookie, DASHBOARD_SESSION_COOKIE);
      // 撤销在前（登出的安全动作已经完成、不可撤回），审计写失败不能再把清
      // Cookie 的成功响应吞掉：否则浏览器留着一枚已死的 cookie，页面还以为自己
      // 没登出。审计失败单独落日志，运维照样看得见。
      sessions.revokeToken(token);
      try {
        audit.append(controlAuditRecord(identity.userId, 'dashboard', 'auth.logout'));
      } catch (error) {
        logger.error(`[dashboard-h5] auth.logout 审计写入失败（会话已撤销）：${describeForLog(error)}`);
      }
      json(res, 200, { ok: true }, { 'set-cookie': clearDashboardSessionCookie(config.secureCookies) });
      return true;
    }

    json(res, 405, { ok: false, error: 'method_not_allowed' });
    return true;
  };

  return { entryPath, exchangePath, sessionPath, logoutPath, resolve, handle };
}
