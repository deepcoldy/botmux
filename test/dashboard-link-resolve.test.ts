import { describe, expect, it } from 'vitest';

import { config } from '../src/config.js';
import {
  maskDashboardToken,
  resolveDashboardAdminLink,
} from '../src/core/dashboard-command/link.js';

const TOKEN = 'abcdef0123456789';

function seams(over: {
  port?: string | null;
  token?: string | null;
  host?: string;
} = {}) {
  return {
    host: over.host ?? '10.20.30.40',
    readPortFile: () => over.port === undefined ? '7900' : over.port,
    readTokenFile: () => (over.token === undefined ? TOKEN : over.token),
  };
}

describe('resolveDashboardAdminLink', () => {
  it('builds the exact admin home URL with the ACTUALLY bound port and current token', () => {
    const r = resolveDashboardAdminLink(seams());
    expect(r.ok).toBe(true);
    const url = (r as any).link.url as string;
    expect(url).toBe(`http://10.20.30.40:7900/?t=${TOKEN}#/`);
  });

  it('never points at a workbench hash route or a web-terminal session path', () => {
    const { url } = (resolveDashboardAdminLink(seams()) as any).link;
    expect(url).toContain('#/');
    expect(url).not.toContain('#/agent-workbench');
    expect(url).not.toContain('/s/');
    expect(url).not.toContain('/workbench');
  });

  it('does not hardcode 7891: reads the bound port file, falling back to the configured default', () => {
    const withFile = resolveDashboardAdminLink(seams({ port: '8123' })) as any;
    expect(withFile.link.port).toBe(8123);
    expect(withFile.link.url).toContain(':8123/');

    const noFile = resolveDashboardAdminLink(seams({ port: null })) as any;
    expect(noFile.link.port).toBe(config.dashboard.port);
    expect(noFile.link.url).toContain(`:${config.dashboard.port}/`);
  });

  it('reads the token live on every call, so rotation is reflected immediately', () => {
    let current = 'token-one';
    const deps = {
      configuredPort: 7891,
      host: '10.20.30.40',
      readPortFile: () => '7900',
      readTokenFile: () => current,
    };
    const first = resolveDashboardAdminLink(deps) as any;
    expect(first.link.url).toContain('?t=token-one#/');
    current = 'token-two';
    const second = resolveDashboardAdminLink(deps) as any;
    expect(second.link.url).toContain('?t=token-two#/');
    expect(second.link.url).not.toContain('token-one');
  });

  it('fails closed when no token is available, returning no URL', () => {
    const r = resolveDashboardAdminLink(seams({ token: null }));
    expect(r).toEqual({ ok: false, reason: 'token_unavailable' });
  });

  it('flags loopback-only hosts so the caller can warn about local-only access', () => {
    for (const host of ['127.0.0.1', 'localhost', '::1']) {
      const r = resolveDashboardAdminLink(seams({ host })) as any;
      expect(r.link.loopbackOnly, host).toBe(true);
      expect(r.link.url, host).toMatch(/^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):7900\//);
    }
    const lan = resolveDashboardAdminLink(seams({ host: '192.168.1.9' })) as any;
    expect(lan.link.loopbackOnly).toBe(false);
  });

  it('prefers an explicitly configured external host verbatim', () => {
    const r = resolveDashboardAdminLink(seams({ host: 'dashboard.example.net' })) as any;
    expect(r.link.host).toBe('dashboard.example.net');
    expect(r.link.url).toBe(`http://dashboard.example.net:7900/?t=${TOKEN}#/`);
    expect(r.link.loopbackOnly).toBe(false);
  });
});

describe('maskDashboardToken', () => {
  it('never reveals the token value', () => {
    expect(maskDashboardToken(TOKEN)).not.toContain(TOKEN);
    expect(maskDashboardToken(TOKEN)).not.toContain('23456789');
    expect(maskDashboardToken('')).toBe('(none)');
    expect(maskDashboardToken(null)).toBe('(none)');
    expect(maskDashboardToken(undefined)).toBe('(none)');
  });

  it('masks the whole credential for tokens no longer than the prefix', () => {
    expect(maskDashboardToken('ab')).toBe('****');
    expect(maskDashboardToken('abcd')).toBe('****');
    expect(maskDashboardToken('abcde')).toBe('abcd***');
  });
});
