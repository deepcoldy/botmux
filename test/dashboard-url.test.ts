// test/dashboard-url.test.ts
import { describe, it, expect, vi, beforeEach } from 'bun:test';

// Mock the two gates buildDashboardUrl consults. Defaults: remote access OFF,
// no platform binding — i.e. an unbound / local-only host.
vi.mock('../src/global-config.js', () => ({
  isRemoteAccessEnabled: vi.fn(() => false),
}));
vi.mock('../src/platform/binding.js', () => ({
  platformMachineBaseUrl: vi.fn(() => null),
  publicReverseProxyBaseUrl: vi.fn(() => null),
  readPlatformBinding: vi.fn(() => null),
}));
vi.mock('../src/platform/devbox-dashboard-export.js', () => ({
  devboxDashboardBaseUrl: vi.fn(() => null),
}));

import {
  buildDashboardUrl,
  buildDashboardUrls,
  buildPlatformDashboardLoginUrl,
  buildV3RunDetailUrl,
  formatUrlHost,
  workbenchEntryUrl,
  workbenchSpaUrl,
} from '../src/core/dashboard-url.js';
import { isRemoteAccessEnabled } from '../src/global-config.js';
import {
  platformMachineBaseUrl,
  publicReverseProxyBaseUrl,
  readPlatformBinding,
} from '../src/platform/binding.js';
import { devboxDashboardBaseUrl } from '../src/platform/devbox-dashboard-export.js';

const setRemote = (on: boolean) => vi.mocked(isRemoteAccessEnabled).mockReturnValue(on);
const setPlatform = (base: string | null) => vi.mocked(platformMachineBaseUrl).mockReturnValue(base);
const setPublic = (base: string | null) => vi.mocked(publicReverseProxyBaseUrl).mockReturnValue(base);
const setBinding = (binding: ReturnType<typeof readPlatformBinding>) => (
  vi.mocked(readPlatformBinding).mockReturnValue(binding)
);
const setDevbox = (base: string | null) => vi.mocked(devboxDashboardBaseUrl).mockReturnValue(base);

describe('buildDashboardUrl', () => {
  beforeEach(() => {
    setRemote(false);
    setPlatform(null);
    setPublic(null);
    setBinding(null);
    setDevbox(null);
  });

  it('builds a local host:port URL with token when remote access is off', () => {
    expect(buildDashboardUrl({ host: '1.2.3.4', port: 7891, token: 'abc' })).toBe(
      'http://1.2.3.4:7891/?t=abc',
    );
  });

  it('omits the token query when no token is given', () => {
    expect(buildDashboardUrl({ host: '1.2.3.4', port: 7891 })).toBe('http://1.2.3.4:7891/');
  });

  it('stays local when remote access is on but the host is not bound', () => {
    setRemote(true);
    setPlatform(null);
    expect(buildDashboardUrl({ host: '1.2.3.4', port: 7891, token: 'abc' })).toBe(
      'http://1.2.3.4:7891/?t=abc',
    );
  });

  it('stays local when bound but remote access is off (switch gates it)', () => {
    setRemote(false);
    setPlatform('https://m-deadbeef.botmux.example');
    expect(buildDashboardUrl({ host: '1.2.3.4', port: 7891, token: 'abc' })).toBe(
      'http://1.2.3.4:7891/?t=abc',
    );
  });

  it('routes through the platform machine subdomain when remote access is on and bound', () => {
    setRemote(true);
    setPlatform('https://m-deadbeef.botmux.example');
    expect(buildDashboardUrl({ host: '1.2.3.4', port: 7891, token: 'abc' })).toBe(
      'https://m-deadbeef.botmux.example/?t=abc',
    );
  });

  it('keeps the platform subdomain token-less when no token is given', () => {
    setRemote(true);
    setPlatform('https://m-deadbeef.botmux.example');
    expect(buildDashboardUrl({ host: '1.2.3.4', port: 7891 })).toBe(
      'https://m-deadbeef.botmux.example/',
    );
  });

  it('routes through BOTMUX_PUBLIC_URL when set and no platform (self-hosted nginx)', () => {
    setPublic('https://botmux.example.com');
    expect(buildDashboardUrl({ host: '1.2.3.4', port: 7891, token: 'abc' })).toBe(
      'https://botmux.example.com/?t=abc',
    );
  });

  it('lets the platform subdomain win over BOTMUX_PUBLIC_URL when both apply', () => {
    setRemote(true);
    setPlatform('https://m-deadbeef.botmux.example');
    setPublic('https://botmux.example.com');
    expect(buildDashboardUrl({ host: '1.2.3.4', port: 7891, token: 'abc' })).toBe(
      'https://m-deadbeef.botmux.example/?t=abc',
    );
  });

  it('routes through a cached Merlin Devbox export when no explicit remote base exists', () => {
    setDevbox('https://devbox.example.com');
    expect(buildDashboardUrl({ host: '1.2.3.4', port: 9001, token: 'abc' })).toBe(
      'https://devbox.example.com/?t=abc',
    );
  });

  // The Devbox lookup validates the cache against the port the dashboard
  // actually bound (`.dashboard-port`), not against the port this link is for:
  // v3 card callers pass config.dashboard.port, which goes stale after an
  // EADDRINUSE probe, and would otherwise demote a working tunnel link.
  it('asks the Devbox lookup about the bound port, not the caller port', () => {
    setDevbox('https://devbox.example.com');
    expect(buildDashboardUrl({ host: '1.2.3.4', port: 7891, token: 'abc' })).toBe(
      'https://devbox.example.com/?t=abc',
    );
    expect(devboxDashboardBaseUrl).toHaveBeenLastCalledWith();
  });

  it('lets BOTMUX_PUBLIC_URL win over a cached Merlin Devbox export', () => {
    setPublic('https://botmux.example.com');
    setDevbox('https://devbox.example.com');
    expect(buildDashboardUrl({ host: '1.2.3.4', port: 9001, token: 'abc' })).toBe(
      'https://botmux.example.com/?t=abc',
    );
  });
});

describe('buildDashboardUrls', () => {
  beforeEach(() => {
    setRemote(false);
    setPlatform(null);
    setPublic(null);
    setDevbox(null);
  });

  it('local-only: no localUrl fallback when the primary is already local', () => {
    expect(buildDashboardUrls({ host: '1.2.3.4', port: 7891, token: 'abc' })).toEqual({
      url: 'http://1.2.3.4:7891/?t=abc',
      localUrl: undefined,
    });
  });

  it('remote-on but unbound: stays local, still no fallback (primary is local)', () => {
    setRemote(true);
    setPlatform(null);
    expect(buildDashboardUrls({ host: '1.2.3.4', port: 7891, token: 'abc' })).toEqual({
      url: 'http://1.2.3.4:7891/?t=abc',
      localUrl: undefined,
    });
  });

  it('remote-on + bound: platform primary + local ip:port fallback (same token)', () => {
    setRemote(true);
    setPlatform('https://m-deadbeef.botmux.example');
    expect(buildDashboardUrls({ host: '1.2.3.4', port: 7891, token: 'abc' })).toEqual({
      url: 'https://m-deadbeef.botmux.example/?t=abc',
      localUrl: 'http://1.2.3.4:7891/?t=abc',
    });
  });

  it('remote-on + bound, token-less: both forms drop the token query', () => {
    setRemote(true);
    setPlatform('https://m-deadbeef.botmux.example');
    expect(buildDashboardUrls({ host: '1.2.3.4', port: 7891 })).toEqual({
      url: 'https://m-deadbeef.botmux.example/',
      localUrl: 'http://1.2.3.4:7891/',
    });
  });

  it('BOTMUX_PUBLIC_URL: public primary + local ip:port fallback (same token)', () => {
    setPublic('https://botmux.example.com');
    expect(buildDashboardUrls({ host: '1.2.3.4', port: 7891, token: 'abc' })).toEqual({
      url: 'https://botmux.example.com/?t=abc',
      localUrl: 'http://1.2.3.4:7891/?t=abc',
    });
  });

  it('brackets an IPv6 literal host so the URL is valid', () => {
    const { url } = buildDashboardUrls({ host: '::1', port: 7891, token: 'abc' });
    expect(url).toBe('http://[::1]:7891/?t=abc');
    expect(() => new URL(url)).not.toThrow();
  });
});

describe('formatUrlHost', () => {
  it('brackets a bare IPv6 literal', () => {
    expect(formatUrlHost('::1')).toBe('[::1]');
    expect(formatUrlHost('fe80::1')).toBe('[fe80::1]');
    expect(formatUrlHost('::ffff:1.2.3.4')).toBe('[::ffff:1.2.3.4]');
    expect(formatUrlHost('FE80::1')).toBe('[FE80::1]');
  });

  it('leaves IPv4, hostnames, and already-bracketed literals unchanged', () => {
    expect(formatUrlHost('127.0.0.1')).toBe('127.0.0.1');
    expect(formatUrlHost('dash.example.com')).toBe('dash.example.com');
    expect(formatUrlHost('[::1]')).toBe('[::1]');
  });

  // The invariant every host→URL exit site shares (dashboard link, v3 cards,
  // federation, web terminal): a formatted host interpolated into a URL must
  // always parse. Guards copy-paste exits that forget to wrap.
  it('any formatted host interpolates into a parseable URL', () => {
    for (const host of ['::1', 'fe80::1', '::ffff:1.2.3.4', '127.0.0.1', 'dash.example.com']) {
      const h = formatUrlHost(host);
      expect(() => new URL(`http://${h}:7891/#/v3/run-1`)).not.toThrow();
    }
  });
});

describe('buildPlatformDashboardLoginUrl', () => {
  beforeEach(() => {
    setRemote(false);
    setBinding(null);
  });

  it('builds a token-free platform owner-login URL with a safe root fallback', () => {
    setRemote(true);
    setBinding({
      platformUrl: 'https://platform.example',
      machineId: 'm-1',
      machineToken: 'machine-secret',
    });
    expect(buildPlatformDashboardLoginUrl()).toBe(
      'https://platform.example/open/m-1?next=%2F%23%2F',
    );
    expect(buildPlatformDashboardLoginUrl()).not.toContain('machine-secret');
  });

  it('is unavailable unless remote access and a platform binding are both present', () => {
    setBinding({ platformUrl: 'https://platform.example', machineId: 'm-1', machineToken: 'secret' });
    expect(buildPlatformDashboardLoginUrl()).toBeUndefined();
    setRemote(true);
    setBinding(null);
    expect(buildPlatformDashboardLoginUrl()).toBeUndefined();
  });

  it('rejects a non-http platform binding and safely encodes the machine id path segment', () => {
    setRemote(true);
    setBinding({ platformUrl: 'file:///tmp/platform', machineId: 'm/1', machineToken: 'secret' });
    expect(buildPlatformDashboardLoginUrl()).toBeUndefined();
    setBinding({ platformUrl: 'https://platform.example/base', machineId: 'm/1', machineToken: 'secret' });
    expect(buildPlatformDashboardLoginUrl()).toContain('/open/m%2F1?');
  });

  it('routes a `/s/<sessionId>` next so an owner logging in from the read-only terminal lands back on a writable terminal (#933)', () => {
    setRemote(true);
    setBinding({ platformUrl: 'https://platform.example', machineId: 'm-1', machineToken: 'secret' });
    const url = buildPlatformDashboardLoginUrl('/s/sess-42');
    // The platform routes a `/s/`-prefixed next to the terminal subdomain
    // surface and mints the host-only proxy cookie there; the whole next is
    // percent-encoded as one query value.
    expect(url).toBe('https://platform.example/open/m-1?next=%2Fs%2Fsess-42');
    // Default is unchanged — the existing SPA-401 caller must keep landing on /#/.
    expect(buildPlatformDashboardLoginUrl()).toBe('https://platform.example/open/m-1?next=%2F%23%2F');
  });
});

describe('buildV3RunDetailUrl', () => {
  // Mirrors the buildDashboardUrls flip so a REMOTE recipient tapping a v3
  // card's「Web 详情」can actually reach the SPA (→ 401 → one-click login),
  // instead of the old always-LAN link that was unreachable off-LAN.
  beforeEach(() => {
    setRemote(false);
    setPlatform(null);
    setPublic(null);
  });

  const opts = { host: '1.2.3.4', port: 7891 };

  it('stays local host:port when remote access is off', () => {
    expect(buildV3RunDetailUrl('run-1', opts)).toBe('http://1.2.3.4:7891/#/v3/run-1');
  });

  it('stays local when remote access is on but the host is not bound', () => {
    setRemote(true);
    setPlatform(null);
    expect(buildV3RunDetailUrl('run-1', opts)).toBe('http://1.2.3.4:7891/#/v3/run-1');
  });

  it('stays local when bound but remote access is off (switch gates it)', () => {
    setRemote(false);
    setPlatform('https://m-deadbeef.botmux.example');
    expect(buildV3RunDetailUrl('run-1', opts)).toBe('http://1.2.3.4:7891/#/v3/run-1');
  });

  it('routes through the platform machine subdomain when remote access is on and bound', () => {
    setRemote(true);
    setPlatform('https://m-deadbeef.botmux.example');
    expect(buildV3RunDetailUrl('run-1', opts)).toBe(
      'https://m-deadbeef.botmux.example/#/v3/run-1',
    );
  });

  it('routes through BOTMUX_PUBLIC_URL when set and no platform (self-hosted nginx)', () => {
    setPublic('https://botmux.example.com');
    expect(buildV3RunDetailUrl('run-1', opts)).toBe('https://botmux.example.com/#/v3/run-1');
  });

  it('lets the platform subdomain win over BOTMUX_PUBLIC_URL when both apply', () => {
    setRemote(true);
    setPlatform('https://m-deadbeef.botmux.example');
    setPublic('https://botmux.example.com');
    expect(buildV3RunDetailUrl('run-1', opts)).toBe(
      'https://m-deadbeef.botmux.example/#/v3/run-1',
    );
  });

  it('never appends a token and URL-encodes the runId (both local and platform)', () => {
    expect(buildV3RunDetailUrl('run with space', opts)).toBe(
      'http://1.2.3.4:7891/#/v3/run%20with%20space',
    );
    setRemote(true);
    setPlatform('https://m-deadbeef.botmux.example');
    const url = buildV3RunDetailUrl('run with space', opts);
    expect(url).toBe('https://m-deadbeef.botmux.example/#/v3/run%20with%20space');
    expect(url).not.toContain('?t=');
    expect(url).not.toContain('token');
  });

  it('brackets an IPv6 literal host in the local form', () => {
    expect(buildV3RunDetailUrl('run-1', { host: '::1', port: 7891 })).toBe(
      'http://[::1]:7891/#/v3/run-1',
    );
  });
});

describe('workbench entry URL shapes', () => {
  // Both derive from an already-built dashboard URL, so they inherit whatever
  // base buildDashboardUrls picked (local host:port / platform subdomain /
  // BOTMUX_PUBLIC_URL) with no second copy of that precedence rule.
  const dashboardUrl = 'http://1.2.3.4:7891/?t=abc';

  beforeEach(() => {
    setRemote(false);
    setPlatform(null);
    setPublic(null);
    setBinding(null);
  });

  it('workbenchSpaUrl keeps the ?t= token and adds the SPA hash route', () => {
    expect(workbenchSpaUrl(dashboardUrl)).toBe('http://1.2.3.4:7891/?t=abc#/agent-workbench');
  });

  it('workbenchEntryUrl swaps the path and drops the fragment', () => {
    expect(workbenchEntryUrl(dashboardUrl)).toBe('http://1.2.3.4:7891/workbench?t=abc');
    // Already-hashed input normalizes to the same fragment-free entry.
    expect(workbenchEntryUrl('http://1.2.3.4:7891/?t=abc#/agent-workbench'))
      .toBe('http://1.2.3.4:7891/workbench?t=abc');
  });

  it('follows the platform base rather than re-deriving host:port', () => {
    setRemote(true);
    setPlatform('https://m-deadbeef.botmux.example');
    const { url } = buildDashboardUrls({ host: '1.2.3.4', port: 7891, token: 'abc' });
    expect(workbenchSpaUrl(url)).toBe('https://m-deadbeef.botmux.example/?t=abc#/agent-workbench');
    expect(workbenchEntryUrl(url)).toBe('https://m-deadbeef.botmux.example/workbench?t=abc');
  });

  it('tolerates a token-less dashboard URL (user logs in on arrival)', () => {
    expect(workbenchSpaUrl('http://1.2.3.4:7891/')).toBe('http://1.2.3.4:7891/#/agent-workbench');
    expect(workbenchEntryUrl('http://1.2.3.4:7891/')).toBe('http://1.2.3.4:7891/workbench');
  });

  it('returns null for unparseable or non-http input instead of a half link', () => {
    for (const bad of ['', 'not a url', 'javascript:alert(1)', 'file:///etc/passwd']) {
      expect(workbenchSpaUrl(bad)).toBeNull();
      expect(workbenchEntryUrl(bad)).toBeNull();
    }
  });
});
