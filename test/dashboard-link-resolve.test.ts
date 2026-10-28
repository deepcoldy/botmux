import { afterEach, describe, expect, it, vi } from 'vitest';

import { config } from '../src/config.js';
import {
  maskDashboardToken,
  resolveDashboardAdminLink,
} from '../src/core/dashboard-command/link.js';

// 默认把中心平台腿关在「未绑定」状态（单测 setup 已把 HOME 重定向到临时目录，这里
// 再显式钉死，避免任何机器的真实 ~/.botmux 远程配置污染基址断言）；平台/反代两种
// 远程形态分别用下面的开关与 BOTMUX_PUBLIC_URL 现场打开。
const remoteState = vi.hoisted(() => ({ platformBase: null as string | null, remote: false }));

vi.mock('../src/global-config.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../src/global-config.js');
  return { ...actual, isRemoteAccessEnabled: () => remoteState.remote };
});
vi.mock('../src/platform/binding.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../src/platform/binding.js');
  return { ...actual, platformMachineBaseUrl: () => remoteState.platformBase };
});

afterEach(() => {
  remoteState.platformBase = null;
  remoteState.remote = false;
  vi.unstubAllEnvs();
});

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
    expect((r as any).link.platformHosted).toBe(false);
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

  it('BOTMUX_PUBLIC_URL reverse proxy: primary flips to the proxy base and KEEPS the token', () => {
    // 自建反代不注入身份，token 仍是唯一凭证 —— 不能像平台托管那样摘掉，否则链接
    // 对任何收件人都是死链。
    vi.stubEnv('BOTMUX_PUBLIC_URL', 'https://botmux.example.com/');
    const r = resolveDashboardAdminLink(seams()) as any;
    expect(r.link.url).toBe(`https://botmux.example.com/?t=${TOKEN}#/`);
    expect(r.link.url).toContain(TOKEN);
    expect(r.link.platformHosted).toBe(false);
    expect(r.link.loopbackOnly).toBe(false);
  });

  it('central-platform hosting: primary flips to the machine subdomain and the token is stripped', () => {
    // 平台在边缘注入身份，?t= 在该链路上无效且不该进聊天记录：主链接必须摘掉
    // token（reportDashboardUrls 语义），并标注 platformHosted。
    remoteState.remote = true;
    remoteState.platformBase = 'https://m-abc.platform.test';
    const r = resolveDashboardAdminLink(seams()) as any;
    expect(r.link.url).toBe('https://m-abc.platform.test/#/');
    expect(r.link.url).not.toContain('t=');
    expect(r.link.url).not.toContain(TOKEN);
    expect(r.link.platformHosted).toBe(true);
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
