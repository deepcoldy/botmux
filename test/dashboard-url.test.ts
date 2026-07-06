// test/dashboard-url.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the two gates buildDashboardUrl consults. Defaults: remote access OFF,
// no platform binding — i.e. an unbound / local-only host.
vi.mock('../src/global-config.js', () => ({
  isRemoteAccessEnabled: vi.fn(() => false),
}));
vi.mock('../src/platform/binding.js', () => ({
  platformMachineBaseUrl: vi.fn(() => null),
}));

import { buildDashboardUrl, buildDashboardUrls } from '../src/core/dashboard-url.js';
import { isRemoteAccessEnabled } from '../src/global-config.js';
import { platformMachineBaseUrl } from '../src/platform/binding.js';

const setRemote = (on: boolean) => vi.mocked(isRemoteAccessEnabled).mockReturnValue(on);
const setPlatform = (base: string | null) => vi.mocked(platformMachineBaseUrl).mockReturnValue(base);

describe('buildDashboardUrl', () => {
  beforeEach(() => {
    setRemote(false);
    setPlatform(null);
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
});

describe('buildDashboardUrls', () => {
  beforeEach(() => {
    setRemote(false);
    setPlatform(null);
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
});
