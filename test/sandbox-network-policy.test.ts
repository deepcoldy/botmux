import { describe, expect, it } from 'vitest';
import { parseSandboxNetworkPolicy, networkZone, compileNetworkNft, addressMatches, networkPolicySupportError, networkProxyError, networkPolicyWarnings, hostDnsServers, proxyEnvKeys, privateBrokerContainmentEnabled, mergeProtectedHttpEgressNetworkPolicy, protectedHttpEgressCliSupportError } from '../src/core/sandbox-network-policy.js';
import { networkSocketFilter } from '../src/core/sandbox-network-launch.js';
import { workflowSandboxInitFields } from '../src/workflows/shared/sandbox-policy.js';
import type { ProtectedHttpEgressWorkerPolicy } from '../src/core/protected-http-egress.js';

const base = { version: 1, public: { mode: 'allow' }, private: { mode: 'block' } };
const frozenEgress: ProtectedHttpEgressWorkerPolicy = {
  pluginId: 'fixture-plugin',
  policy: {
    id: 'fixture.write.v1',
    targets: [{
      scheme: 'https',
      host: 'fixture.internal.example',
      port: 443,
      denyRoutes: [{ methods: ['POST'], path: '/v1/items/update' }],
    }],
  },
  policyDigest: 'a'.repeat(64),
  frozenAddresses: [['10.20.30.40', '2606:4700::40', '10.20.30.40']],
};
describe('network policy', () => {
  it.each(['claude', 'grok', 'antigravity', 'pi', 'unknown'])('refuses protected egress for unsupported %s before CLI launch', cliId => {
    const error = protectedHttpEgressCliSupportError(cliId, frozenEgress);
    expect(error).toBeTruthy();
    expect(error).toContain(cliId);
    expect(error).toContain('codex');
    expect(error).toMatch(/模型.*桥|桥.*模型/);
  });
  it('admits codex and preserves ordinary sessions of every CLI', () => {
    expect(protectedHttpEgressCliSupportError('codex', frozenEgress)).toBeUndefined();
    for (const cliId of ['codex', 'claude', 'grok', 'antigravity', 'pi', 'unknown']) {
      expect(protectedHttpEgressCliSupportError(cliId, undefined)).toBeUndefined();
    }
  });
  it.each(['10.0.0.1','127.0.0.1','169.254.0.1','100.64.0.1','192.168.1.1','198.18.0.1','224.0.0.1','0.0.0.0','255.255.255.255','::1','::','fe80::1','fc00::1','ff02::1','2001:db8::1','2002::1','64:ff9b::a00:1','::ffff:127.0.0.1','3fff::1'])('special/private %s', ip => expect(networkZone(ip)).toBe('private'));
  it.each(['8.8.8.8','1.1.1.1','2606:4700:4700::1111','::ffff:8.8.8.8'])('public %s', ip => expect(networkZone(ip)).toBe('public'));
  it('normalizes CIDR and IPv4 mappings', () => {
    expect(addressMatches('::ffff:10.2.3.4', '10.0.0.0/8')).toBe(true);
    expect(parseSandboxNetworkPolicy({ ...base, private: { mode: 'allowlist', rules: [{ cidr: '::ffff:10.2.3.4/104' }] } }).private.rules![0]!.cidr).toBe('10.0.0.0/8');
  });
  it.each([
    { ...base, proxyMode: 'allow' }, { ...base, proxyMode: true }, { ...base, version: 2 }, { ...base, public: { mode: 'whitelist' } }, { ...base, proxy: 'http://proxy' },
    { ...base, public: { mode: 'allow', rules: [] } }, { ...base, private: { mode: 'allowlist', rules: [{ cidr: 'example.org' }] } },
    { ...base, private: { mode: 'allowlist', rules: [{ cidr: '10.0.0.0/33' }] } },
    { ...base, private: { mode: 'allowlist', rules: [{ cidr: '10.0.0.0/8', ports: [80] }] } },
    { ...base, private: { mode: 'denylist', rules: [{ cidr: '::/0', protocol: 'icmp' }] } },
    { ...base, dnsServers: ['10.0.2.3'] }, { ...base, dnsServers: ['::1'] },
  ])('rejects invalid or unsupported policies %#', raw => expect(() => parseSandboxNetworkPolicy(raw)).toThrow());
  it('freezes workflow policy with no shared mutable lists', () => {
    const policy = parseSandboxNetworkPolicy({ ...base, private: { mode: 'allowlist', rules: [{ cidr: '10.0.0.0/8' }] } });
    const init = workflowSandboxInitFields({ sandbox: true, sandboxNetworkPolicy: policy });
    policy.private.rules![0]!.cidr = '0.0.0.0/0';
    expect(init.sandboxNetworkPolicy!.private.rules![0]!.cidr).toBe('10.0.0.0/8');
    expect(workflowSandboxInitFields(undefined)).not.toHaveProperty('sandboxNetworkPolicy');
  });
  it('legacy sessions retain their original behavior', () => {
    expect(workflowSandboxInitFields({ sandbox: true, sandboxNetwork: false }).sandboxNetwork).toBe(false);
    expect(networkPolicySupportError({ platform: 'darwin', backendType: 'tmux', sandbox: false })).toBeUndefined();
  });
  it.each([['darwin','pty',true], ['linux','tmux',true], ['linux','riff',true], ['linux','pty','scratch'], ['linux','pty',false]])('refuses unsupported %s/%s/%s', (platform, backendType, sandbox) => {
    expect(networkPolicySupportError({ platform: String(platform), backendType: String(backendType), sandbox, policy: base })).toBeTruthy();
  });
  it('refuses adopt and existing app server before launch', () => {
    expect(networkPolicySupportError({ platform: 'linux', backendType: 'pty', sandbox: true, policy: base, adopt: true })).toBeTruthy();
    expect(networkPolicySupportError({ platform: 'linux', backendType: 'pty', sandbox: true, policy: base, existingEndpoint: 'http://localhost' })).toBeTruthy();
  });
  it('emits one namespace-local ruleset and accepts only explicit DNS capability', () => {
    const rules = compileNetworkNft(parseSandboxNetworkPolicy({ ...base, dnsServers: ['1.1.1.1'] }));
    expect(rules).toContain('table inet botmux_network'); expect(rules).not.toContain('flush ruleset');
    for (const gatewayDrop of ['ip daddr { 10.0.2.2, 10.0.2.3 } drop', 'ip6 daddr fd00::/64 drop']) {
      expect(rules).toContain(gatewayDrop);
      expect(rules.indexOf(gatewayDrop)).toBeLessThan(rules.indexOf('jump private'));
      expect(rules.indexOf(gatewayDrop)).toBeLessThan(rules.indexOf('jump public'));
    }
    expect(rules).toContain('ip daddr 1.1.1.1 udp dport 53 accept');
  });
  // Evaluate the emitted classic BPF against seccomp_data, including native
  // arm64 and incompatible ABIs that cannot be executed on the local host.
  function evaluateFilter(
    arch: 'x64' | 'arm64',
    audit: number,
    syscall: number,
    family = 0,
    socketType = 0,
    protocol = 0,
  ): number {
    const program = networkSocketFilter(arch), data = Buffer.alloc(64);
    data.writeUInt32LE(syscall, 0); data.writeUInt32LE(audit, 4); data.writeUInt32LE(family, 16);
    data.writeUInt32LE(socketType, 24); data.writeUInt32LE(protocol, 32);
    let accumulator = 0;
    for (let pc = 0; pc < program.length / 8; pc++) {
      const offset = pc * 8, op = program.readUInt16LE(offset), value = program.readUInt32LE(offset + 4);
      if (op === 0x20) accumulator = data.readUInt32LE(value);
      else if (op === 0x06) return value;
      else if (op === 0x15 || op === 0x45) { const matches = op === 0x15 ? accumulator === value : (accumulator & value) !== 0; pc += program[offset + (matches ? 2 : 3)]!; }
      else throw new Error(`unsupported BPF opcode ${op}`);
    }
    throw new Error('filter did not return');
  }
  it.each([
    ['x64', 0xc000003e, 41, 53, [272, 308, 425, 426, 427]],
    ['arm64', 0xc00000b7, 198, 199, [97, 268, 425, 426, 427]],
  ] as const)('seccomp %s permits mounted Unix, Internet and route-query sockets but rejects other IPC, escape and alternate ABIs', (arch, audit, socket, socketpair, blocked) => {
    for (const family of [1, 2, 10]) expect(evaluateFilter(arch, audit, socket, family)).toBe(0x7fff0000);
    // Node os.networkInterfaces() queries the sandbox-local interface list via
    // AF_NETLINK + NETLINK_ROUTE. Other netlink protocols remain unavailable.
    expect(evaluateFilter(arch, audit, socket, 16, 3 | 0x80000, 0)).toBe(0x7fff0000);
    for (const protocol of [1, 2, 15]) expect(evaluateFilter(arch, audit, socket, 16, 3, protocol)).toBe(0x00050001);
    for (const family of [17, 40]) expect(evaluateFilter(arch, audit, socket, family)).toBe(0x00050001);
    expect(evaluateFilter(arch, audit, socketpair, 1)).toBe(0x7fff0000);
    for (const syscall of blocked) expect(evaluateFilter(arch, audit, syscall)).toBe(0x00050001);
    expect(evaluateFilter(arch, 0x40000003, socket, 2)).toBe(0x80000000);
    if (arch === 'x64') expect(evaluateFilter(arch, audit, 0x40000029, 2)).toBe(0x00050001);
  });
  it('enables actor writes only for a private-blocking policy without delegated proxy egress', () => {
    expect(privateBrokerContainmentEnabled(parseSandboxNetworkPolicy(base))).toBe(true);
    expect(privateBrokerContainmentEnabled(parseSandboxNetworkPolicy({
      ...base,
      proxyMode: 'trusted-egress',
    }))).toBe(false);
    expect(privateBrokerContainmentEnabled(parseSandboxNetworkPolicy({
      ...base,
      private: { mode: 'allow' },
    }))).toBe(false);
    expect(privateBrokerContainmentEnabled(undefined)).toBe(false);
  });
  it('adds exact frozen target denies while leaving unrelated destinations on their existing path', () => {
    const merged = mergeProtectedHttpEgressNetworkPolicy(undefined, frozenEgress, ['10.1.2.3']);
    expect(merged.private.mode).toBe('denylist');
    expect(merged.private.rules).toContainEqual({
      cidr: '10.20.30.40/32', protocol: 'tcp', ports: [443],
    });
    expect(merged.public.mode).toBe('denylist');
    expect(merged.public.rules).toContainEqual({
      cidr: '2606:4700:0:0:0:0:0:40/128', protocol: 'tcp', ports: [443],
    });
    expect(merged.dnsServers).toEqual(['10.1.2.3']);
    const nft = compileNetworkNft(merged);
    expect(nft).toContain('ip daddr 10.20.30.40/32 meta l4proto tcp tcp dport { 443 } drop');
    expect(nft).toContain('ip6 daddr 2606:4700:0:0:0:0:0:40/128 meta l4proto tcp tcp dport { 443 } drop');
    expect(nft).toContain('accept');
    expect(merged.private.rules?.filter(rule => rule.cidr === '10.20.30.40/32')).toHaveLength(1);
  });
  it.each([
    ['IPv4 loopback', '127.0.0.1'],
    ['IPv6 loopback', '::1'],
  ])('rejects a frozen %s target before loopback output can bypass a blocked zone', (_label, address) => {
    const loopback = structuredClone(frozenEgress);
    loopback.frozenAddresses = [[address]];
    expect(() => mergeProtectedHttpEgressNetworkPolicy(
      parseSandboxNetworkPolicy(base),
      loopback,
      ['10.1.2.3'],
    )).toThrow('protected_http_egress_target_collides_with_loopback');
  });
  it('rejects a frozen DNS port target before the DNS exception can bypass a blocked zone', () => {
    const dnsTarget = structuredClone(frozenEgress);
    dnsTarget.policy.targets[0]!.port = 53;
    dnsTarget.frozenAddresses = [['10.1.2.3']];
    expect(() => mergeProtectedHttpEgressNetworkPolicy(
      parseSandboxNetworkPolicy({ ...base, dnsServers: ['10.1.2.3'] }),
      dnsTarget,
      ['10.1.2.3'],
    )).toThrow('protected_http_egress_target_collides_with_dns');
  });
  it.each([
    ['allow', { mode: 'allow' }],
    ['denylist', { mode: 'denylist', rules: [{ cidr: '10.99.0.0/16', protocol: 'tcp', ports: [8443] }] }],
  ] as const)('preserves unrelated operator rules when merging a %s zone', (_label, privateZone) => {
    const operator = parseSandboxNetworkPolicy({
      version: 1,
      public: { mode: 'allow' },
      private: privateZone,
      dnsServers: ['192.168.1.53'],
      proxyMode: 'reject',
    });
    const merged = mergeProtectedHttpEgressNetworkPolicy(operator, frozenEgress, ['10.1.2.3']);
    expect(merged.dnsServers).toEqual(['192.168.1.53']);
    expect(merged.proxyMode).toBe('reject');
    if (privateZone.mode === 'denylist') {
      expect(merged.private.rules).toContainEqual({
        cidr: '10.99.0.0/16', protocol: 'tcp', ports: [8443],
      });
    }
    expect(merged.private.rules).toContainEqual({
      cidr: '10.20.30.40/32', protocol: 'tcp', ports: [443],
    });
  });
  it('keeps block restrictive and inserts an ordered drop ahead of allowlist grants', () => {
    const blocked = mergeProtectedHttpEgressNetworkPolicy(parseSandboxNetworkPolicy({
      version: 1,
      public: { mode: 'allow' },
      private: { mode: 'block' },
    }), frozenEgress, []);
    expect(blocked.private).toEqual({ mode: 'block' });

    const allowlisted = mergeProtectedHttpEgressNetworkPolicy(parseSandboxNetworkPolicy({
      version: 1,
      public: { mode: 'allow' },
      private: { mode: 'allowlist', rules: [{ cidr: '10.0.0.0/8' }] },
    }), frozenEgress, []);
    expect(allowlisted.private.mode).toBe('allowlist');
    expect(allowlisted.private.rules?.[0]).toEqual({
      cidr: '10.20.30.40/32', protocol: 'tcp', ports: [443], action: 'drop',
    });
    expect(allowlisted.private.rules).toContainEqual({ cidr: '10.0.0.0/8' });
    const nft = compileNetworkNft(allowlisted);
    expect(nft.indexOf('ip daddr 10.20.30.40/32 meta l4proto tcp tcp dport { 443 } drop'))
      .toBeLessThan(nft.indexOf('ip daddr 10.0.0.0/8 accept'));
  });
  it('rejects delegated proxy policy conflicts instead of silently changing the operator configuration', () => {
    const operator = parseSandboxNetworkPolicy({
      version: 1,
      public: { mode: 'allow' },
      private: { mode: 'allow' },
      proxyMode: 'trusted-egress',
    });
    expect(() => mergeProtectedHttpEgressNetworkPolicy(operator, frozenEgress, []))
      .toThrow('protected_http_egress_proxy_policy_conflict');
    expect(operator.proxyMode).toBe('trusted-egress');
  });
  it('offers protected model bridge guidance without recommending a conflicting proxy policy', () => {
    const merged = mergeProtectedHttpEgressNetworkPolicy(undefined, frozenEgress, []);
    const message = networkProxyError(merged, {
      HTTPS_PROXY: 'http://user:secret@proxy.internal:8080',
    }, true)!;
    expect(message).toBeTruthy();
    expect(message).toContain('HTTPS_PROXY');
    expect(message).toMatch(/移除|去掉/);
    expect(message).toMatch(/模型.*桥|桥.*模型/);
    expect(message).not.toContain('trusted-egress');
    expect(message).not.toContain('secret');
  });
  it('proxy re-resolution configurations fail closed without changing environment', () => {
    const p = parseSandboxNetworkPolicy(base); const env = { HTTPS_PROXY: 'http://example.org:8080', NO_PROXY: '*' };
    expect(networkProxyError(p, env)).toBeTruthy(); expect(env.HTTPS_PROXY).toBe('http://example.org:8080');
    expect(networkProxyError(p, { NO_PROXY: '*' })).toBeUndefined();
    expect(networkProxyError(undefined, env)).toBeUndefined();
    expect(networkProxyError(parseSandboxNetworkPolicy({ ...base, private: { mode: 'allow' } }), env)).toBeUndefined();
  });
  it.each(['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy'])('requires explicit exit trust for %s without rewriting env or kernel rules', key => {
    const env = { [key]: 'http://93.184.216.34:18090', NO_PROXY: '*' };
    const original = structuredClone(env);
    const restricted = parseSandboxNetworkPolicy(base);
    const trusted = parseSandboxNetworkPolicy({ ...base, proxyMode: 'trusted-egress' });
    expect(networkProxyError(restricted, env)).toBeTruthy();
    expect(networkProxyError(trusted, env)).toBeUndefined();
    expect(trusted.proxyMode).toBe('trusted-egress');
    expect(compileNetworkNft(trusted)).toBe(compileNetworkNft(restricted));
    expect(env).toEqual(original);
    expect(networkProxyError(parseSandboxNetworkPolicy({ ...base, private: { mode: 'allow' }, proxyMode: 'reject' }), env)).toBeTruthy();
  });
  it('freezes explicit proxy delegation with the session workflow policy', () => {
    const policy = parseSandboxNetworkPolicy({ ...base, proxyMode: 'trusted-egress' });
    const snapshot = workflowSandboxInitFields({ sandbox: true, sandboxNetworkPolicy: policy });
    policy.proxyMode = 'reject';
    expect(snapshot.sandboxNetworkPolicy?.proxyMode).toBe('trusted-egress');
  });
  it('unknown socket syscall ABI fails closed', () => expect(() => networkSocketFilter('ia32')).toThrow());
  it('names the launch the policy cannot run on', () => {
    // The worker reports the session's real backend, which can differ from what the save-time check saw.
    for (const backendType of ['tmux', 'zellij', 'riff']) {
      expect(networkPolicySupportError({ platform: 'linux', backendType, sandbox: true, policy: base })).toContain(backendType);
    }
    expect(networkPolicySupportError({ platform: 'linux', backendType: 'tmux', sandbox: true, policy: base, adopt: true })).toContain('adopt');
    expect(networkPolicySupportError({ platform: 'linux', backendType: 'pty', sandbox: 'scratch', policy: base })).toContain('scratch');
    expect(networkPolicySupportError({ platform: 'darwin', backendType: 'pty', sandbox: true, policy: base })).toContain('darwin');
  });
  it('names the proxy variables it refuses, never their values', () => {
    const message = networkProxyError(parseSandboxNetworkPolicy(base), { HTTPS_PROXY: 'http://user:secret@proxy.example:8080', all_proxy: 'socks5://x', NO_PROXY: '*' })!;
    expect(message).toContain('HTTPS_PROXY');
    expect(message).toContain('all_proxy');
    expect(message).not.toContain('secret');
    expect(message).not.toContain('NO_PROXY');
    expect(proxyEnvKeys({ HTTP_PROXY: 'x', https_proxy: '', NO_PROXY: '*' })).toEqual(['HTTP_PROXY']);
  });
  it.each([
    [{ public: { mode: 'allow' }, private: { mode: 'allow' } }, {}, ['dns_servers_missing']],
    [{ public: { mode: 'allow' }, private: { mode: 'block' } }, {}, ['dns_servers_missing']],
    [{ public: { mode: 'allow' }, private: { mode: 'block' }, dnsServers: ['10.0.0.53'] }, {}, []],
    [{ public: { mode: 'allow' }, private: { mode: 'block' }, dnsServers: ['10.0.0.53'] }, { https_proxy: 'http://p:1' }, ['proxy_requires_trusted_egress']],
    [{ public: { mode: 'allow' }, private: { mode: 'block' }, dnsServers: ['10.0.0.53'], proxyMode: 'trusted-egress' }, { https_proxy: 'http://p:1' }, []],
    [{ public: { mode: 'allow' }, private: { mode: 'allow' } }, { HTTP_PROXY: 'http://p:1' }, ['dns_servers_missing']],
  ])('warns about policies that cannot work as configured %#', (zones, env, expected) => {
    // Any policy replaces resolv.conf with dnsServers alone, allow/allow included.
    expect(networkPolicyWarnings(parseSandboxNetworkPolicy({ version: 1, ...zones }), env)).toEqual(expected);
  });
  it('suggests host nameservers the sandbox can actually reach', () => {
    const files = (map: Record<string, string>) => (path: string) => { if (path in map) return map[path]!; throw new Error('ENOENT'); };
    expect(hostDnsServers(files({ '/etc/resolv.conf': 'domain x\nnameserver 10.199.34.255\n  nameserver 2001:4860:4860::8888\n#nameserver 9.9.9.9\nnameserver 10.199.34.255\n' })))
      .toEqual(['10.199.34.255', '2001:4860:4860::8888']);
    // systemd-resolved stub: loopback is the sandbox's own, so use the upstream list.
    expect(hostDnsServers(files({
      '/etc/resolv.conf': 'nameserver 127.0.0.53\noptions edns0\n',
      '/run/systemd/resolve/resolv.conf': 'nameserver 192.168.1.1\nnameserver fe80::1%eth0\n',
    }))).toEqual(['192.168.1.1']);
    expect(hostDnsServers(files({ '/etc/resolv.conf': 'nameserver 127.0.0.53\n' }))).toEqual([]);
    expect(hostDnsServers(files({}))).toEqual([]);
    // Every suggestion is accepted by the policy parser.
    const many = Array.from({ length: 12 }, (_, i) => `nameserver 10.0.0.${i + 1}`).join('\n');
    const suggested = hostDnsServers(files({ '/etc/resolv.conf': many }));
    expect(parseSandboxNetworkPolicy({ ...base, dnsServers: suggested }).dnsServers).toEqual(suggested);
  });
});
