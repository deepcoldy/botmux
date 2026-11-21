import { describe, expect, it } from 'vitest';
import { compileNetworkNft, parseSandboxNetworkPolicy, type NetworkZone } from '../src/core/sandbox-network-policy.js';
import { networkProxyLaunchError, type ProxyAddressLookup } from '../src/core/sandbox-network-proxy.js';

const trusted = (publicZone: NetworkZone = { mode: 'allow' }, privateZone: NetworkZone = { mode: 'block' }) =>
  parseSandboxNetworkPolicy({ version: 1, public: publicZone, private: privateZone, proxyMode: 'trusted-egress' });

describe('ordinary trusted proxy endpoint admission', () => {
  // A delegated proxy is still unusable when its own socket is denied by nft.
  it.each([
    ['blocked private zone', trusted(), 'http://10.1.2.3:8080'],
    ['IPv4 loopback', trusted({ mode: 'allow' }, { mode: 'allow' }), 'http://127.0.0.1:8080'],
    ['IPv6 loopback', trusted({ mode: 'allow' }, { mode: 'allow' }), 'http://[::1]:8080'],
    ['IPv4 mapped loopback', trusted({ mode: 'allow' }, { mode: 'allow' }), 'http://[::ffff:127.0.0.1]:8080'],
    ['host gateway', trusted({ mode: 'allow' }, { mode: 'allow' }), 'http://10.0.2.2:8080'],
    ['DNS gateway', trusted({ mode: 'allow' }, { mode: 'allow' }), 'http://10.0.2.3:8080'],
    ['IPv6 gateway alias', trusted({ mode: 'allow' }, { mode: 'allow' }), 'http://[fd00::1234]:8080'],
    ['wrong port', trusted({ mode: 'allowlist', rules: [{ cidr: '93.184.216.34', protocol: 'tcp', ports: [443] }] }, { mode: 'block' }), 'http://93.184.216.34:8080'],
    ['wrong protocol', trusted({ mode: 'allowlist', rules: [{ cidr: '93.184.216.34', protocol: 'udp', ports: [8080] }] }, { mode: 'block' }), 'http://93.184.216.34:8080'],
    ['ordered drop', trusted({ mode: 'allowlist', rules: [
      { cidr: '93.184.216.34', protocol: 'tcp', ports: [8080], action: 'drop' },
      { cidr: '93.184.216.0/24' },
    ] }, { mode: 'block' }), 'http://93.184.216.34:8080'],
    ['denylist rule', trusted({ mode: 'denylist', rules: [{ cidr: '93.184.216.34' }] }, { mode: 'allow' }), 'http://93.184.216.34:8080'],
    ['malformed URL', trusted(), 'http://user:secret@'],
    ['missing authority delimiter', trusted(), 'http:/93.184.216.34:8080'],
    ['surrounding whitespace', trusted(), ' http://93.184.216.34:8080 '],
    ['unsupported transport', trusted(), 'ftp://user:secret@93.184.216.34:8080'],
  ])('refuses %s before launch without exposing credentials', async (_reason, policy, url) => {
    const message = await networkProxyLaunchError(policy, { HTTPS_PROXY: url });
    expect(message).toBeTruthy();
    expect(message).toContain('HTTPS_PROXY');
    expect(message).not.toContain('secret');
    expect(message).not.toContain(url);
  });

  it('admits a correctly configured ordinary trusted proxy without widening the kernel rules', async () => {
    const policy = trusted({ mode: 'allowlist', rules: [{ cidr: '93.184.216.34', protocol: 'tcp', ports: [8080] }] }, { mode: 'block' });
    const env = { HTTPS_PROXY: 'http://user:secret@93.184.216.34:8080' };
    const before = structuredClone(policy);
    expect(await networkProxyLaunchError(policy, env)).toBeUndefined();
    expect(compileNetworkNft(policy)).toContain('ip daddr 93.184.216.34/32 meta l4proto tcp tcp dport { 8080 } accept');
    expect(policy).toEqual(before);
    expect(env.HTTPS_PROXY).toBe('http://user:secret@93.184.216.34:8080');
  });

  it.each(['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy'])('checks every configured %s socket', async key => {
    expect(await networkProxyLaunchError(trusted(), {
      HTTPS_PROXY: 'http://93.184.216.34:8080', [key]: 'http://10.1.2.3:8080',
    })).toContain(key);
  });

  it.each([
    ['http://93.184.216.34', 80],
    ['https://93.184.216.34', 443],
    ['socks4://93.184.216.34', 1080],
    ['socks4a://93.184.216.34', 1080],
    ['socks5://93.184.216.34', 1080],
    ['socks5h://93.184.216.34', 1080],
  ])('uses the transport default port for %s', async (url, port) => {
    const allowed = trusted({ mode: 'allowlist', rules: [{ cidr: '93.184.216.34', protocol: 'tcp', ports: [port] }] });
    expect(await networkProxyLaunchError(allowed, { ALL_PROXY: url })).toBeUndefined();
    const blocked = trusted({ mode: 'allowlist', rules: [{ cidr: '93.184.216.34', protocol: 'tcp', ports: [port + 1] }] });
    expect(await networkProxyLaunchError(blocked, { ALL_PROXY: url })).toBeTruthy();
  });

  it('admits every permitted A/AAAA answer using the real ordered socket policy', async () => {
    const policy = trusted({ mode: 'allowlist', rules: [
      { cidr: '93.184.216.34', protocol: 'tcp', ports: [8443] },
      { cidr: '2606:4700::1111', protocol: 'tcp', ports: [8443] },
      { cidr: '93.184.216.35', protocol: 'tcp', ports: [8443] },
    ] });
    const lookup: ProxyAddressLookup = async (hostname, options) => {
      if (hostname !== 'proxy.example' || !options.all || !options.verbatim) throw new Error('incorrect DNS query');
      return [
        { address: '93.184.216.34', family: 4 },
        { address: '2606:4700::1111', family: 6 },
        { address: '93.184.216.35', family: 4 },
      ];
    };
    expect(await networkProxyLaunchError(policy, { HTTPS_PROXY: 'https://user:secret@proxy.example:8443' }, { lookup })).toBeUndefined();
    const rules = compileNetworkNft(policy);
    expect(rules).toContain('ip daddr 93.184.216.34/32 meta l4proto tcp tcp dport { 8443 } accept');
    expect(rules).toContain('ip6 daddr 2606:4700:0:0:0:0:0:1111/128 meta l4proto tcp tcp dport { 8443 } accept');
    expect(rules).toContain('ip daddr 93.184.216.35/32 meta l4proto tcp tcp dport { 8443 } accept');
  });

  it.each([
    { answers: [{ address: '93.184.216.34', family: 4 }, { address: '10.1.2.3', family: 4 }] },
    { answers: [{ address: '2606:4700::1111', family: 6 }, { address: 'fd00::1234', family: 6 }] },
    { answers: [{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }] },
  ])('refuses a hostname when any DNS answer is inaccessible %#', async ({ answers }) => {
    const message = await networkProxyLaunchError(trusted(), { HTTPS_PROXY: 'http://user:secret@proxy.example:8080' }, { lookup: async () => answers });
    expect(message).toBeTruthy();
    expect(message).not.toContain('secret');
  });

  it.each([
    { answers: [] }, { answers: [{ address: 'not-an-ip', family: 4 }] }, { answers: [{ address: '93.184.216.34', family: 6 }] },
  ])('refuses missing or invalid DNS answers %#', async ({ answers }) => {
    const message = await networkProxyLaunchError(trusted(), { HTTPS_PROXY: 'http://proxy.example:8080' }, { lookup: async () => answers });
    expect(message).toBeTruthy();
    expect(message).toContain('DNS');
  });

  it('does not disclose a failing resolver error that contains credentials', async () => {
    const message = await networkProxyLaunchError(trusted(), { HTTPS_PROXY: 'http://user:secret@proxy.example:8080' }, {
      lookup: async () => { throw new Error('lookup http://user:secret@proxy.example failed'); },
    });
    expect(message).toBeTruthy();
    expect(message).not.toContain('secret');
    expect(message).not.toContain('proxy.example');
  });

  it('uses system DNS for a hostname when no resolver is supplied', async () => {
    const message = await networkProxyLaunchError(trusted({ mode: 'allow' }, { mode: 'allow' }), {
      HTTPS_PROXY: 'http://user:secret@localhost:8080',
    });
    expect(message).toBeTruthy();
    expect(message).not.toContain('DNS 解析失败');
    expect(message).not.toContain('secret');
  });

  it('preserves the DNS exception that is actually permitted before a blocked zone', async () => {
    const policy = parseSandboxNetworkPolicy({ ...trusted(), dnsServers: ['10.1.2.3'] });
    expect(await networkProxyLaunchError(policy, { HTTPS_PROXY: 'http://10.1.2.3:53' })).toBeUndefined();
    expect(await networkProxyLaunchError(policy, { HTTPS_PROXY: 'http://10.1.2.3:54' })).toBeTruthy();
  });

  it('preserves an earlier allowlist grant even if a later rule drops that address', async () => {
    const policy = trusted({ mode: 'allowlist', rules: [
      { cidr: '93.184.216.34', protocol: 'tcp', ports: [8080] },
      { cidr: '93.184.216.34', action: 'drop' },
    ] });
    expect(await networkProxyLaunchError(policy, { HTTPS_PROXY: 'http://93.184.216.34:8080' })).toBeUndefined();
  });

  it('preserves ordinary no-policy and no-proxy sessions without DNS resolution', async () => {
    const env = { HTTPS_PROXY: 'invalid URL user:secret', NO_PROXY: '*' };
    const lookup: ProxyAddressLookup = async () => { throw new Error('DNS must not run'); };
    expect(await networkProxyLaunchError(undefined, env, { lookup })).toBeUndefined();
    expect(await networkProxyLaunchError(trusted(), { NO_PROXY: '*' }, { lookup })).toBeUndefined();
    expect(env).toEqual({ HTTPS_PROXY: 'invalid URL user:secret', NO_PROXY: '*' });
  });

  it('rejects protected task proxies before endpoint validation or DNS resolution', async () => {
    const lookup: ProxyAddressLookup = async () => { throw new Error('secret DNS error'); };
    const message = await networkProxyLaunchError(trusted(), { HTTPS_PROXY: 'http://user:secret@proxy.example:8080' }, { protectedHttpEgress: true, lookup });
    expect(message).toContain('HTTPS_PROXY');
    expect(message).not.toContain('trusted-egress');
    expect(message).not.toContain('secret');
    expect(await networkProxyLaunchError(trusted(), {}, { protectedHttpEgress: true, lookup })).toBeUndefined();
  });
});
