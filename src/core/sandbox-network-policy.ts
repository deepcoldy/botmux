/** Opt-in destination-address policy. Pure validation and nftables compilation. */
import { isIP } from 'node:net';

export type NetworkMode = 'allow' | 'block' | 'allowlist' | 'denylist';
export interface NetworkRule { cidr: string; protocol?: 'tcp' | 'udp'; ports?: number[] }
export interface NetworkZone { mode: NetworkMode; rules?: NetworkRule[] }
export interface SandboxNetworkPolicy {
  version: 1;
  public: NetworkZone;
  private: NetworkZone;
  /** Explicit DNS capability: these addresses may receive TCP/UDP port 53. */
  dnsServers?: string[];
  /** Explicitly delegate proxied business destinations to an approved exit.
   * Kernel rules still constrain the actual proxy endpoint; env is unchanged. */
  proxyMode?: 'reject' | 'trusted-egress';
}

// Conservative non-public space, including transition/translation addresses.
export const PRIVATE_V4 = ['0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8',
  '169.254.0.0/16', '172.16.0.0/12', '192.0.0.0/24', '192.0.2.0/24', '192.88.99.0/24',
  '192.168.0.0/16', '198.18.0.0/15', '198.51.100.0/24', '203.0.113.0/24', '224.0.0.0/3'];
export const PRIVATE_V6 = ['::/3', '4000::/2', '8000::/1', '2001::/23',
  '2001:db8::/32', '2002::/16', '3fff::/20'];

function object(value: unknown, keys: string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const obj = value as Record<string, unknown>;
  for (const key of Object.keys(obj)) if (!keys.includes(key)) throw new Error(`${label}: unsupported field ${key}`);
  return obj;
}

export function parseAddress(raw: string): { family: 4 | 6; value: bigint; bits: number; cidr: string } {
  const parts = raw.split('/');
  if (parts.length > 2 || raw.includes('%') || raw.trim() !== raw) throw new Error(`invalid IP/CIDR: ${raw}`);
  let ip = parts[0]!;
  let family = isIP(ip);
  if (!family) throw new Error(`only IP/CIDR rules are supported: ${raw}`);
  let bits = parts[1] === undefined ? (family === 4 ? 32 : 128) : Number(parts[1]);
  if (parts[1] !== undefined && !/^\d+$/.test(parts[1])) throw new Error(`invalid prefix: ${raw}`);
  if (!Number.isInteger(bits) || bits < 0 || bits > (family === 4 ? 32 : 128)) throw new Error(`invalid prefix: ${raw}`);
  let value: bigint;
  if (family === 4) value = ip.split('.').reduce((v, octet) => (v << 8n) | BigInt(octet), 0n);
  else {
    ip = new URL(`http://[${ip}]/`).hostname.slice(1, -1);
    const halves = ip.split('::');
    const left = halves[0] ? halves[0].split(':') : [];
    const right = halves[1] ? halves[1].split(':') : [];
    const words = halves.length === 2 ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left;
    value = words.reduce((v, word) => (v << 16n) | BigInt(`0x${word}`), 0n);
    // IPv4-mapped addresses use the IPv4 routing/filtering path on Linux.
    if ((value >> 32n) === 0xffffn) {
      if (bits < 96) throw new Error(`mapped IPv4 prefix must be >= 96: ${raw}`);
      family = 4; bits -= 96; value &= 0xffffffffn;
    }
  }
  const width = family === 4 ? 32 : 128;
  value = (value >> BigInt(width - bits)) << BigInt(width - bits);
  const address = family === 4
    ? [24n, 16n, 8n, 0n].map(shift => Number((value >> shift) & 255n)).join('.')
    : Array.from({ length: 8 }, (_, i) => ((value >> BigInt(112 - i * 16)) & 65535n).toString(16)).join(':');
  return { family: family as 4 | 6, value, bits, cidr: `${address}/${bits}` };
}

export function addressMatches(address: string, cidr: string): boolean {
  const a = parseAddress(address), c = parseAddress(cidr);
  return a.family === c.family && (a.value >> BigInt((c.family === 4 ? 32 : 128) - c.bits)) === (c.value >> BigInt((c.family === 4 ? 32 : 128) - c.bits));
}
export function networkZone(address: string): 'public' | 'private' {
  const a = parseAddress(address);
  return (a.family === 4 ? PRIVATE_V4 : PRIVATE_V6).some(c => addressMatches(address, c)) ? 'private' : 'public';
}

export function parseSandboxNetworkPolicy(raw: unknown): SandboxNetworkPolicy {
  const obj = object(raw, ['version', 'public', 'private', 'dnsServers', 'proxyMode'], 'sandboxNetworkPolicy');
  if (obj.version !== 1) throw new Error('sandboxNetworkPolicy.version must be 1');
  const zone = (rawZone: unknown, label: string): NetworkZone => {
    const z = object(rawZone, ['mode', 'rules'], label);
    if (!['allow', 'block', 'allowlist', 'denylist'].includes(String(z.mode))) throw new Error(`${label}: invalid mode`);
    const mode = z.mode as NetworkMode;
    if (z.rules !== undefined && (!Array.isArray(z.rules) || z.rules.length > 256)) throw new Error(`${label}: rules must be an array (max 256)`);
    if ((mode === 'allow' || mode === 'block') && z.rules !== undefined) throw new Error(`${label}: rules require a list mode`);
    const rules = (z.rules as unknown[] | undefined)?.map(rawRule => {
      const r = object(rawRule, ['cidr', 'protocol', 'ports'], `${label}.rule`);
      if (typeof r.cidr !== 'string') throw new Error('rule.cidr must be IP/CIDR');
      const cidr = parseAddress(r.cidr).cidr;
      if (r.protocol !== undefined && r.protocol !== 'tcp' && r.protocol !== 'udp') throw new Error('protocol must be tcp or udp');
      if (r.ports !== undefined && (!r.protocol || !Array.isArray(r.ports) || !r.ports.length || r.ports.length > 256 || !r.ports.every(p => Number.isInteger(p) && Number(p) >= 1 && Number(p) <= 65535))) throw new Error('ports require tcp/udp and integers 1..65535');
      return { cidr, ...(r.protocol ? { protocol: r.protocol as 'tcp' | 'udp' } : {}), ...(r.ports ? { ports: [...new Set(r.ports as number[])] } : {}) };
    });
    return { mode, ...(rules ? { rules } : {}) };
  };
  if (obj.dnsServers !== undefined && (!Array.isArray(obj.dnsServers) || obj.dnsServers.length > 8 || !obj.dnsServers.every(ip => typeof ip === 'string' && isIP(ip) && !ip.includes('%') && !ip.includes('/')))) throw new Error('dnsServers must contain at most 8 IP addresses');
  if (obj.proxyMode !== undefined && obj.proxyMode !== 'reject' && obj.proxyMode !== 'trusted-egress') throw new Error('proxyMode must be reject or trusted-egress');
  const dnsServers = (obj.dnsServers as string[] | undefined)?.map(ip => {
    const address = parseAddress(ip).cidr.split('/')[0]!;
    if (['10.0.2.2', '10.0.2.3', '127.0.0.0/8', '::1', 'fd00::/64'].some(c => addressMatches(address, c))) throw new Error('DNS cannot use loopback or the network gateway aliases');
    return address;
  });
  return { version: 1, public: zone(obj.public, 'public'), private: zone(obj.private, 'private'), ...(dnsServers ? { dnsServers } : {}), ...(obj.proxyMode !== undefined ? { proxyMode: obj.proxyMode as 'reject' | 'trusted-egress' } : {}) };
}

export function networkPolicyAllows(policy: SandboxNetworkPolicy, ip: string, protocol: 'tcp' | 'udp', port: number): boolean {
  const z = policy[networkZone(ip)];
  if (z.mode === 'allow') return true;
  if (z.mode === 'block') return false;
  const matched = z.rules?.some(r => addressMatches(ip, r.cidr) && (!r.protocol || r.protocol === protocol) && (!r.ports || r.ports.includes(port))) ?? false;
  return z.mode === 'allowlist' ? matched : !matched;
}

export function compileNetworkNft(raw: SandboxNetworkPolicy): string {
  const p = parseSandboxNetworkPolicy(raw);
  const zone = (name: 'public' | 'private') => {
    const z = p[name];
    const lines = [` chain ${name} {`];
    for (const r of z.rules ?? []) {
      const family = parseAddress(r.cidr).family === 4 ? 'ip' : 'ip6';
      const proto = r.protocol ? ` meta l4proto ${r.protocol}` : '';
      const ports = r.ports ? ` ${r.protocol} dport { ${r.ports.join(', ')} }` : '';
      lines.push(`  ${family} daddr ${r.cidr}${proto}${ports} ${z.mode === 'allowlist' ? 'accept' : 'drop'}`);
    }
    lines.push(`  ${z.mode === 'allow' || z.mode === 'denylist' ? 'accept' : 'drop'}`, ' }');
    return lines;
  };
  return [
    'table inet botmux_network {', ...zone('private'), ...zone('public'),
    ' chain output { type filter hook output priority 0; policy drop;',
    // Neighbor discovery must precede the gateway-alias drop: the router is
    // reached through that link, without granting task TCP/UDP to its address.
    '  meta l4proto ipv6-icmp icmpv6 type { nd-neighbor-solicit, nd-neighbor-advert, nd-router-solicit } accept',
    // Gateway aliases can tunnel to host loopback or the host DNS forwarder.
    '  ip daddr { 10.0.2.2, 10.0.2.3 } drop', '  ip6 daddr fd00::/64 drop',
    // This namespace has its own loopback, never the host loopback.
    '  oifname "lo" accept',
    ...((p.dnsServers ?? []).flatMap(ip => ['tcp', 'udp'].map(proto => `  ${isIP(ip) === 4 ? 'ip' : 'ip6'} daddr ${ip} ${proto} dport 53 accept`))),
    `  ip daddr { ${PRIVATE_V4.join(', ')} } jump private`,
    `  ip6 daddr { ${PRIVATE_V6.join(', ')} } jump private`,
    '  jump public', ' }',
    ' chain input { type filter hook input priority 0; policy drop;',
    '  iifname "lo" accept', '  ct state established,related accept',
    // IPv6 neighbor discovery is link control, not task egress.
    '  meta l4proto ipv6-icmp icmpv6 type { nd-neighbor-solicit, nd-neighbor-advert, nd-router-advert } accept',
    ' }', '}', '',
  ].join('\n');
}

export function networkPolicySupportError(input: { platform: string; backendType: string; sandbox: unknown; adopt?: boolean; existingEndpoint?: string; policy?: unknown }): string | undefined {
  if (input.policy === undefined) return;
  parseSandboxNetworkPolicy(input.policy);
  if (input.platform !== 'linux') return 'sandboxNetworkPolicy requires Linux';
  if (input.backendType !== 'pty' || input.adopt || input.existingEndpoint) return 'sandboxNetworkPolicy requires a new local PTY process; remote, persistent and adopt backends are unsupported';
  if (input.sandbox !== true && input.sandbox !== 'oncall') return 'sandboxNetworkPolicy requires sandbox oncall';
}

/** Default to rejecting proxy configuration for restricted policies. An
 * explicit trusted-egress mode delegates business destination control to that
 * exit, while namespace rules continue to filter its actual endpoint IP. */
export function networkProxyError(policy: SandboxNetworkPolicy | undefined, env: Record<string, string | undefined>): string | undefined {
  if (!policy || policy.proxyMode === 'trusted-egress') return;
  if (policy.proxyMode === undefined && policy.public.mode === 'allow' && policy.private.mode === 'allow') return;
  if (['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy'].some(key => !!env[key])) return 'restricted sandboxNetworkPolicy does not support upstream proxy destination re-resolution; use direct permitted egress or explicitly delegate destination control with proxyMode trusted-egress';
}
