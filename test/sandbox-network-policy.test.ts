import { describe, expect, it } from 'vitest';
import { parseSandboxNetworkPolicy, networkZone, networkPolicyAllows, compileNetworkNft, addressMatches, networkPolicySupportError, networkProxyError, type NetworkMode } from '../src/core/sandbox-network-policy.js';
import { networkSocketFilter } from '../src/core/sandbox-network-launch.js';
import { workflowSandboxInitFields } from '../src/workflows/shared/sandbox-policy.js';

const base = { version: 1, public: { mode: 'allow' }, private: { mode: 'block' } };
const modes: NetworkMode[] = ['allow', 'block', 'allowlist', 'denylist'];
describe('network policy', () => {
  for (const publicMode of modes) for (const privateMode of modes) {
    it(`${publicMode}/${privateMode} are independent`, () => {
      const p = parseSandboxNetworkPolicy({ version: 1,
        public: { mode: publicMode, ...(['allowlist', 'denylist'].includes(publicMode) ? { rules: [{ cidr: '8.8.8.8', protocol: 'tcp', ports: [443] }] } : {}) },
        private: { mode: privateMode, ...(['allowlist', 'denylist'].includes(privateMode) ? { rules: [{ cidr: '10.1.2.3', protocol: 'tcp', ports: [443] }] } : {}) },
      });
      for (const [ip, mode] of [['8.8.8.8', publicMode], ['10.1.2.3', privateMode]] as const) {
        expect(networkPolicyAllows(p, ip, 'tcp', 443)).toBe(mode === 'allow' || mode === 'allowlist');
        expect(networkPolicyAllows(p, ip, 'udp', 443)).toBe(mode === 'allow' || mode === 'denylist');
        expect(networkPolicyAllows(p, ip, 'tcp', 444)).toBe(mode === 'allow' || mode === 'denylist');
      }
    });
  }
  it.each(['10.0.0.1','127.0.0.1','169.254.0.1','100.64.0.1','192.168.1.1','198.18.0.1','224.0.0.1','0.0.0.0','255.255.255.255','::1','::','fe80::1','fc00::1','ff02::1','2001:db8::1','2002::1','64:ff9b::a00:1','::ffff:127.0.0.1','3fff::1'])('special/private %s', ip => expect(networkZone(ip)).toBe('private'));
  it.each(['8.8.8.8','1.1.1.1','2606:4700:4700::1111','::ffff:8.8.8.8'])('public %s', ip => expect(networkZone(ip)).toBe('public'));
  it('normalizes CIDR and IPv4 mappings', () => {
    expect(addressMatches('::ffff:10.2.3.4', '10.0.0.0/8')).toBe(true);
    expect(parseSandboxNetworkPolicy({ ...base, private: { mode: 'allowlist', rules: [{ cidr: '::ffff:10.2.3.4/104' }] } }).private.rules![0]!.cidr).toBe('10.0.0.0/8');
  });
  it.each([
    { ...base, version: 2 }, { ...base, public: { mode: 'whitelist' } }, { ...base, proxy: 'http://proxy' },
    { ...base, public: { mode: 'allow', rules: [] } }, { ...base, private: { mode: 'allowlist', rules: [{ cidr: 'example.org' }] } },
    { ...base, private: { mode: 'allowlist', rules: [{ cidr: '10.0.0.0/33' }] } },
    { ...base, private: { mode: 'allowlist', rules: [{ cidr: '10.0.0.0/8', ports: [80] }] } },
    { ...base, private: { mode: 'denylist', rules: [{ cidr: '::/0', protocol: 'icmp' }] } },
    { ...base, dnsServers: ['10.0.2.3'] }, { ...base, dnsServers: ['::1'] },
  ])('rejects invalid or unsupported policies %#', raw => expect(() => parseSandboxNetworkPolicy(raw)).toThrow());
  it('empty lists have explicit inverse semantics', () => {
    expect(networkPolicyAllows(parseSandboxNetworkPolicy({ ...base, public: { mode: 'allowlist', rules: [] } }), '8.8.8.8', 'tcp', 443)).toBe(false);
    expect(networkPolicyAllows(parseSandboxNetworkPolicy({ ...base, public: { mode: 'denylist', rules: [] } }), '8.8.8.8', 'tcp', 443)).toBe(true);
  });
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
    expect(rules.indexOf('10.0.2.3')).toBeLessThan(rules.indexOf('jump private'));
    expect(rules).toContain('ip daddr 1.1.1.1 udp dport 53 accept');
  });
  // Evaluate the emitted classic BPF against seccomp_data, including native
  // arm64 and incompatible ABIs that cannot be executed on the local host.
  function evaluateFilter(arch: 'x64' | 'arm64', audit: number, syscall: number, family = 0): number {
    const program = networkSocketFilter(arch), data = Buffer.alloc(64);
    data.writeUInt32LE(syscall, 0); data.writeUInt32LE(audit, 4); data.writeUInt32LE(family, 16);
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
  ] as const)('seccomp %s rejects IPC, escape and alternate ABIs', (arch, audit, socket, socketpair, blocked) => {
    for (const family of [2, 10]) expect(evaluateFilter(arch, audit, socket, family)).toBe(0x7fff0000);
    for (const family of [1, 16, 17, 40]) expect(evaluateFilter(arch, audit, socket, family)).toBe(0x00050001);
    expect(evaluateFilter(arch, audit, socketpair, 1)).toBe(0x7fff0000);
    for (const syscall of blocked) expect(evaluateFilter(arch, audit, syscall)).toBe(0x00050001);
    expect(evaluateFilter(arch, 0x40000003, socket, 2)).toBe(0x80000000);
    if (arch === 'x64') expect(evaluateFilter(arch, audit, 0x40000029, 2)).toBe(0x00050001);
  });
  it('proxy re-resolution configurations fail closed without changing environment', () => {
    const p = parseSandboxNetworkPolicy(base); const env = { HTTPS_PROXY: 'http://example.org:8080', NO_PROXY: '*' };
    expect(networkProxyError(p, env)).toBeTruthy(); expect(env.HTTPS_PROXY).toBe('http://example.org:8080');
    expect(networkProxyError(p, { NO_PROXY: '*' })).toBeUndefined();
    expect(networkProxyError(undefined, env)).toBeUndefined();
    expect(networkProxyError(parseSandboxNetworkPolicy({ ...base, private: { mode: 'allow' } }), env)).toBeUndefined();
  });
  it('unknown socket syscall ABI fails closed', () => expect(() => networkSocketFilter('ia32')).toThrow());
});
