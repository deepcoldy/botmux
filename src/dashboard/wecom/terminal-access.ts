import { createHash, randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createNonceStore, verifyDaemonRequest } from '../daemon-internal-auth.js';
import type { TerminalDashboardActor } from '../terminal-control.js';
import { localHttpOrigin } from '../../core/dashboard-url.js';
import {
  WECOM_DASHBOARD_ROUTE_PATHS,
  type NativeTerminalIdentity,
  type NativeTerminalRequest,
  type WecomTerminalMintResponse,
} from '../../im/wecom/contract/dashboard-routes.js';

// The request shapes are the gateway's wire contract; re-exported for this
// module's existing importers.
export type { NativeTerminalIdentity, NativeTerminalRequest };
export interface NativeTerminalTarget {
  uiSessionId: string;
  nativeSessionId: string;
  binding: string;
  proxyPort: number;
  epoch: string;
}
interface Claim extends NativeTerminalRequest {
  target: NativeTerminalTarget;
  origin: string;
  expiresAt: number;
}
export interface NativeTerminalBrowser {
  id: string;
  claim: Claim;
  actor: TerminalDashboardActor;
  activated?: boolean;
}
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const nonce = () => randomBytes(32).toString('base64url');
export const NATIVE_TERMINAL_COOKIE = 'bmx_native_terminal';
/** `value` as a bare http(s) origin (no credentials, path, query or fragment), or throws. */
function bareOrigin(value: string): string {
  const u = new URL(value);
  if (u.username || u.password || u.search || u.hash || u.pathname !== '/' || !['https:', 'http:'].includes(u.protocol)) {
    throw new Error('invalid_terminal_origin');
  }
  return u.origin;
}
/**
 * The origin native terminal links are built on. The Dashboard derives it the
 * way it builds its own links (core/dashboard-url.ts), without the central
 * platform: a self-hosted reverse proxy's `BOTMUX_PUBLIC_URL` when set,
 * otherwise `http://<external host>:<listening port>`. The exchange answers
 * with a root-relative redirect and cookie path, so a public URL with a path
 * prefix (or one that is not a bare origin) cannot carry it: the local form is
 * used instead.
 */
export function nativeTerminalOrigin(input: { publicUrl?: string | null; host: string; port: number | string }): string {
  const publicUrl = input.publicUrl?.trim();
  if (publicUrl) {
    try {
      return bareOrigin(publicUrl);
    } catch { /* not usable as the link origin: fall back to the local form */ }
  }
  return bareOrigin(localHttpOrigin(input.host, input.port));
}
export function parseNativeTerminalRequest(value: unknown): NativeTerminalRequest {
  const v = value as NativeTerminalRequest;
  const i = v?.identity;
  if (!i || i.provider !== 'wecom'
    || ['connectionId', 'botId', 'userId'].some(k => typeof i[k as keyof NativeTerminalIdentity] !== 'string'
      || !i[k as keyof NativeTerminalIdentity]
      || i[k as keyof NativeTerminalIdentity].length > 256
      || /[\x00-\x20]/.test(i[k as keyof NativeTerminalIdentity]))
    || typeof v.sessionId !== 'string' || !v.sessionId || v.sessionId.length > 512
    || typeof v.triggerId !== 'string' || !v.triggerId || v.triggerId.length > 512
    || !['read', 'write'].includes(v.permission)) {
    throw new Error('invalid_terminal_request');
  }
  return {
    identity: { provider: 'wecom', connectionId: i.connectionId, botId: i.botId, userId: i.userId },
    sessionId: v.sessionId,
    triggerId: v.triggerId,
    permission: v.permission,
  };
}
/** A URL carries a 60-second, single-use exchange code. Only a path-scoped,
 * HttpOnly browser session survives exchange; worker grants stay on loopback. */
export class NativeTerminalAccess {
  private codes = new Map<string, Claim>();
  private browsers = new Map<string, { hash: string; browser: NativeTerminalBrowser }>();
  private nonces = createNonceStore();
  constructor(private options: {
    secret: string;
    resolve(request: NativeTerminalRequest): Promise<NativeTerminalTarget>;
    /** The origin links are built on (nativeTerminalOrigin), read at each mint. A caller never names it. */
    origin(): string;
    now?: () => number;
    exchangeTtlMs?: number;
    browserTtlMs?: number;
  }) {}
  private now() {
    return (this.options.now ?? Date.now)();
  }
  private prune() {
    for (const [id, c] of this.codes) {
      if (c.expiresAt <= this.now()) {
        this.codes.delete(id);
      }
    }
    for (const [id, b] of this.browsers) {
      if (b.browser.claim.expiresAt <= this.now()) {
        this.browsers.delete(id);
      }
    }
  }
  async mint(input: NativeTerminalRequest) {
    this.prune();
    const request = parseNativeTerminalRequest(input);
    const origin = bareOrigin(this.options.origin());
    const target = await this.options.resolve(request);
    const code = nonce();
    const expiresAt = this.now() + (this.options.exchangeTtlMs ?? 60000);
    if (this.codes.size + this.browsers.size >= 10000) {
      throw new Error('terminal_capacity');
    }
    this.codes.set(hash(code), { ...request, target, origin, expiresAt });
    return { url: `${origin}/wecom-terminal/exchange?code=${code}`, expiresAt };
  }
  private async valid(claim: Claim) {
    if (claim.expiresAt <= this.now()) {
      return false;
    }
    try {
      const current = await this.options.resolve(claim);
      return claim.expiresAt > this.now() && current.uiSessionId === claim.target.uiSessionId
        && current.nativeSessionId === claim.target.nativeSessionId && current.binding === claim.target.binding
        && current.proxyPort === claim.target.proxyPort && current.epoch === claim.target.epoch;
    } catch {
      return false;
    }
  }
  async exchange(code: string) {
    const claim = this.codes.get(hash(code));
    this.codes.delete(hash(code));
    if (!claim || !await this.valid(claim)) {
      return;
    }
    const id = nonce();
    const token = nonce();
    claim.expiresAt = this.now() + (this.options.browserTtlMs ?? 300000);
    const browser: NativeTerminalBrowser = {
      id,
      claim,
      actor: {
        userId: `wecom:${hash(JSON.stringify(claim.identity))}`,
        authSessionId: `wecom-terminal:${id}`,
        expiresAt: claim.expiresAt,
        terminalCapability: claim.permission === 'write' ? 'controlled' : 'readonly',
      },
    };
    this.browsers.set(id, { hash: hash(token), browser });
    return { browser, token };
  }
  async authenticate(req: IncomingMessage, id: string): Promise<NativeTerminalBrowser | undefined> {
    const entry = this.browsers.get(id);
    if (!entry) {
      return;
    }
    const cookie = String(req.headers.cookie ?? '')
      .split(';')
      .map(s => s.trim())
      .find(s => s.startsWith(`${NATIVE_TERMINAL_COOKIE}=`))
      ?.slice(NATIVE_TERMINAL_COOKIE.length + 1);
    if (!cookie || hash(cookie) !== entry.hash || req.headers.host !== new URL(entry.browser.claim.origin).host) {
      return;
    }
    if (!await this.valid(entry.browser.claim)) {
      this.browsers.delete(id);
      return;
    }
    return entry.browser;
  }
  async live(id: string): Promise<boolean> {
    const entry = this.browsers.get(id);
    if (!entry) {
      return false;
    }
    if (!await this.valid(entry.browser.claim)) {
      this.browsers.delete(id);
      return false;
    }
    return true;
  }
  isLiveAuthSession(id: string): boolean {
    const entry = this.browsers.get(id.replace(/^wecom-terminal:/, ''));
    return Boolean(entry && entry.browser.claim.expiresAt > this.now());
  }
  async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const reply = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === WECOM_DASHBOARD_ROUTE_PATHS.terminalMint) {
      if (req.method !== 'POST' || !['127.0.0.1', '::ffff:127.0.0.1', '::1'].includes(req.socket.remoteAddress ?? '')) {
        reply(403, { ok: false });
        return true;
      }
      const verified = await verifyDaemonRequest(req, this.options.secret, this.nonces, { maxBodyBytes: 8192 });
      if (!verified.ok) {
        reply(verified.httpStatus, { ok: false });
        return true;
      }
      try {
        // Validated by mint(): the body is whatever the signed caller sent. Only
        // the request fields are read; the link's origin is the Dashboard's own.
        const input = JSON.parse(verified.bodyRaw) as NativeTerminalRequest;
        const minted: WecomTerminalMintResponse = { ok: true, ...await this.mint(input) };
        reply(200, minted);
      } catch {
        const rejected: WecomTerminalMintResponse = { ok: false, error: 'native_terminal_rejected' };
        reply(403, rejected);
      }
      return true;
    }
    if (url.pathname !== '/wecom-terminal/exchange') {
      return false;
    }
    if (req.method !== 'GET') {
      reply(405, { ok: false });
      return true;
    }
    const result = await this.exchange(url.searchParams.get('code') ?? '');
    if (!result) {
      reply(403, { ok: false, error: 'terminal_exchange_expired_or_used' });
      return true;
    }
    if (req.headers.host !== new URL(result.browser.claim.origin).host) {
      this.browsers.delete(result.browser.id);
      reply(403, { ok: false });
      return true;
    }
    const path = `/wecom-terminal/native/${result.browser.id}/`;
    // The secure decision comes from the origin the Dashboard built the link on,
    // never a browser-controlled Forwarded/X-Forwarded-Proto header.
    const secure = result.browser.claim.origin.startsWith('https:') ? '; Secure' : '';
    res.writeHead(303, {
      'location': path,
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'set-cookie': `${NATIVE_TERMINAL_COOKIE}=${result.token}; Path=${path}; HttpOnly; SameSite=Strict; Max-Age=${Math.floor((result.browser.claim.expiresAt - this.now()) / 1000)}${secure}`,
    });
    res.end();
    return true;
  }
}
