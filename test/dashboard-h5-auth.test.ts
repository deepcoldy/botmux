import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createDashboardH5AuthController,
  createFeishuH5CodeExchanger,
  DASHBOARD_H5_CLIENT_TIMEOUT_MS,
  DashboardSessionStore,
  DASHBOARD_SESSION_COOKIE,
  safeDashboardH5ReturnTo,
  type DashboardH5AuthConfig,
} from '../src/dashboard/h5-auth.js';
import type { ControlAuditRecord, ControlAuditSink } from '../src/dashboard/control-audit.js';

const config: DashboardH5AuthConfig = {
  enabled: true,
  brand: 'feishu',
  appId: 'cli_test_app',
  appSecret: 'app-secret-never-exposed',
  allowedOpenIds: ['ou_allowed'],
  entryPath: '/auth/feishu',
  sessionTtlMs: 60_000,
  secureCookies: false,
};

class MemoryAudit implements ControlAuditSink {
  records: ControlAuditRecord[] = [];
  append(record: ControlAuditRecord): void { this.records.push(record); }
}

let server: Server | null = null;

afterEach(async () => {
  if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
  server = null;
});

async function startController(openIdOrError: string | Error, nowRef = { value: 1_000 }): Promise<{
  base: string;
  audit: MemoryAudit;
  sessions: DashboardSessionStore;
}> {
  const audit = new MemoryAudit();
  const sessions = new DashboardSessionStore({
    ttlMs: config.sessionTtlMs,
    now: () => nowRef.value,
    randomToken: () => 'A'.repeat(43),
  });
  const controller = createDashboardH5AuthController({
    config,
    sessions,
    audit,
    exchanger: {
      exchange: vi.fn(async () => {
        if (openIdOrError instanceof Error) throw openIdOrError;
        return { openId: openIdOrError };
      }),
    },
  });
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://dashboard.test');
    void controller.handle(req, res, url).then(handled => {
      if (!handled && !res.headersSent) { res.writeHead(404); res.end(); }
    });
  });
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return { base: `http://127.0.0.1:${port}`, audit, sessions };
}

function cookiePair(setCookie: string): string {
  return setCookie.split(';')[0];
}

describe('Feishu H5 passwordless dashboard auth', () => {
  it('exchanges a code into a fixed-expiry HttpOnly session without returning or URL-embedding a token', async () => {
    const nowRef = { value: 10_000 };
    const { base, audit } = await startController('ou_allowed', nowRef);
    const entry = await fetch(`${base}/auth/feishu`);
    expect(entry.status).toBe(200);
    const html = await entry.text();
    expect(html).toContain('requestAccess');
    expect(html).toContain('requestAuthCode');
    expect(html).toContain("document.createElement('script')");
    expect(html).toContain('window.h5sdk.ready(function(){auth(id)})');
    expect(html).toContain(`timeoutMs=${DASHBOARD_H5_CLIENT_TIMEOUT_MS}`);
    expect(html).toContain("typeof AbortController==='function'");
    expect(html).not.toContain(config.appSecret);

    const response = await fetch(`${base}/auth/feishu/exchange`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'one-time-code-do-not-log' }),
    });
    expect(response.status).toBe(200);
    const bodyText = await response.text();
    const body = JSON.parse(bodyText);
    expect(body).toEqual({
      ok: true,
      user: { openId: 'ou_allowed' },
      expiresAt: 70_000,
      redirectTo: '/',
    });
    expect(bodyText).not.toContain('one-time-code-do-not-log');
    expect(bodyText).not.toContain('A'.repeat(43));
    expect(response.url).not.toContain('code=');
    const setCookie = response.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain(`${DASHBOARD_SESSION_COOKIE}=`);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');

    const session = await fetch(`${base}/auth/feishu/session`, {
      headers: { cookie: cookiePair(setCookie) },
    });
    expect(await session.json()).toEqual({
      ok: true,
      user: { openId: 'ou_allowed' },
      expiresAt: 70_000,
    });
    expect(audit.records).toEqual([
      expect.objectContaining({ user: 'ou_allowed', session: 'dashboard', action: 'auth.login' }),
    ]);
    expect(JSON.stringify(audit.records)).not.toContain('one-time-code-do-not-log');
  });

  it('rejects an open_id outside the exact allowlist and mints no cookie', async () => {
    const { base, audit } = await startController('ou_stranger');
    const response = await fetch(`${base}/auth/feishu/exchange`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'valid-but-not-authorized' }),
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ ok: false, error: 'open_id_not_allowed' });
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(audit.records).toEqual([
      expect.objectContaining({ user: 'ou_stranger', session: 'dashboard', action: 'auth.login_denied' }),
    ]);
  });

  it('rejects simple cross-origin form media types before exchanging a code', async () => {
    const { base, audit } = await startController('ou_allowed');
    const response = await fetch(`${base}/auth/feishu/exchange`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: JSON.stringify({ code: 'cross-origin-form-code' }),
    });
    expect(response.status).toBe(415);
    expect(await response.json()).toEqual({ ok: false, error: 'unsupported_media_type' });
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(audit.records).toHaveLength(0);
  });

  it('returns a bounded provider failure without credentials, provider detail, code, or cookie', async () => {
    const { base, audit } = await startController(new Error('upstream leaked app-secret-never-exposed'));
    const response = await fetch(`${base}/auth/feishu/exchange`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'secret-auth-code' }),
    });
    const text = await response.text();
    expect(response.status).toBe(502);
    expect(JSON.parse(text)).toEqual({ ok: false, error: 'feishu_exchange_failed' });
    expect(text).not.toContain(config.appSecret);
    expect(text).not.toContain('secret-auth-code');
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(audit.records[0]).toEqual(expect.objectContaining({
      user: 'unknown', session: 'dashboard', action: 'auth.login_denied',
    }));
  });

  it('expires the Dashboard session at its fixed deadline', async () => {
    const nowRef = { value: 1_000 };
    const { base, sessions } = await startController('ou_allowed', nowRef);
    const response = await fetch(`${base}/auth/feishu/exchange`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'fresh-code' }),
    });
    const cookie = cookiePair(response.headers.get('set-cookie') ?? '');
    nowRef.value = 61_000;
    sessions.sweepExpired();
    const expired = await fetch(`${base}/auth/feishu/session`, { headers: { cookie } });
    expect(expired.status).toBe(401);
    expect(await expired.json()).toEqual({ ok: false, error: 'authentication_required' });
  });

  it('supports a fully mocked Feishu exchange and discards provider access tokens', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fakeFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith('/auth/v3/app_access_token/internal')) {
        return new Response(JSON.stringify({ code: 0, app_access_token: 'app-provider-token' }), { status: 200 });
      }
      return new Response(JSON.stringify({
        code: 0,
        data: { open_id: 'ou_allowed', access_token: 'user-provider-token' },
      }), { status: 200 });
    });
    const exchanger = createFeishuH5CodeExchanger(config, { fetchImpl: fakeFetch as typeof fetch });
    const result = await exchanger.exchange('mock-code');
    expect(result).toEqual({ openId: 'ou_allowed' });
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toContain('/auth/v3/app_access_token/internal');
    expect(calls[1].url).toContain('/authen/v1/access_token');
    expect(JSON.stringify(result)).not.toContain('app-provider-token');
    expect(JSON.stringify(result)).not.toContain('user-provider-token');
  });

  it('normalizes only Workbench appCenter/Dock return routes', () => {
    expect(safeDashboardH5ReturnTo('/#/agent-workbench/session%2Fone')).toBe('/#/agent-workbench/session%2Fone');
    expect(safeDashboardH5ReturnTo('/#/agent-workbench-dock/session%2Fone?ignored=1')).toBe('/#/agent-workbench-dock/session%2Fone');
    expect(safeDashboardH5ReturnTo('/#/agent-workbench-other')).toBe('/');
    expect(safeDashboardH5ReturnTo('/#/settings')).toBe('/');
    expect(safeDashboardH5ReturnTo('/#/agent-workbench/%E0%A4%A')).toBe('/');
  });
});
