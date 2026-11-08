/** Launch-time admission of ordinary, explicitly delegated proxy sockets. */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import {
  addressMatches,
  networkProxyError,
  networkZone,
  parseSandboxNetworkPolicy,
  proxyEnvKeys,
  type SandboxNetworkPolicy,
} from './sandbox-network-policy.js';

export type ProxyAddressLookup = (hostname: string, options: { all: true; verbatim: true }) => Promise<readonly { address: string; family: number }[]>;

/** Mirrors the TCP verdict of compileNetworkNft, including output exceptions
 * and ordered zone rules. Local/gateway proxies are never delegated exits. */
function proxySocketAllowed(policy: SandboxNetworkPolicy, address: string, port: number): boolean {
  if (['127.0.0.0/8', '::1/128', '10.0.2.2/32', '10.0.2.3/32', 'fd00::/64']
    .some(cidr => addressMatches(address, cidr))) return false;
  if (port === 53 && (policy.dnsServers ?? []).some(server => addressMatches(address, server))) return true;
  const zone = policy[networkZone(address)];
  for (const rule of zone.rules ?? []) {
    if (!addressMatches(address, rule.cidr)) continue;
    if (rule.protocol && rule.protocol !== 'tcp') continue;
    if (rule.ports && !rule.ports.includes(port)) continue;
    return rule.action !== 'drop' && zone.mode === 'allowlist';
  }
  return zone.mode === 'allow' || zone.mode === 'denylist';
}

function proxyEndpoint(raw: string): { hostname: string; port: number } {
  if (raw.trim() !== raw || !/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) throw new Error('invalid proxy URL');
  const url = new URL(raw);
  const defaults: Record<string, number> = {
    'http:': 80, 'https:': 443, 'socks:': 1080,
    'socks4:': 1080, 'socks4a:': 1080, 'socks5:': 1080, 'socks5h:': 1080,
  };
  const defaultPort = defaults[url.protocol];
  if (!defaultPort || !url.hostname || (url.pathname && url.pathname !== '/') || url.search || url.hash) throw new Error('invalid proxy endpoint');
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const port = url.port ? Number(url.port) : defaultPort;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid proxy port');
  return { hostname, port };
}

/** Never logs URL values or DNS exception text: both can contain credentials.
 * Resolving all A/AAAA answers verifies admission without changing env or nft.
 * The kernel continues filtering whichever endpoint the CLI actually chooses. */
export async function networkProxyLaunchError(
  policy: SandboxNetworkPolicy | undefined,
  env: Record<string, string | undefined>,
  options: { protectedHttpEgress?: boolean; lookup?: ProxyAddressLookup } = {},
): Promise<string | undefined> {
  const modeError = networkProxyError(policy, env, options.protectedHttpEgress);
  if (modeError) return modeError;
  if (!policy || policy.proxyMode !== 'trusted-egress') return;
  const parsed = parseSandboxNetworkPolicy(policy);
  const resolve: ProxyAddressLookup = options.lookup ?? ((hostname, lookupOptions) => lookup(hostname, lookupOptions));
  for (const key of proxyEnvKeys(env)) {
    let endpoint: { hostname: string; port: number };
    try { endpoint = proxyEndpoint(env[key]!); }
    catch { return `代理变量 ${key} 的端点 URL 无效或使用了不支持的代理协议，会话不会启动。请修正该代理变量`; }
    let addresses: readonly { address: string; family: number }[];
    try {
      addresses = isIP(endpoint.hostname)
        ? [{ address: endpoint.hostname, family: isIP(endpoint.hostname) }]
        : await resolve(endpoint.hostname, { all: true, verbatim: true });
      if (!addresses.length || addresses.some(answer => !isIP(answer.address) || isIP(answer.address) !== answer.family)) throw new Error('invalid DNS answer');
    } catch { return `代理变量 ${key} 的端点 DNS 解析失败或没有有效地址，会话不会启动。请检查代理地址和 DNS 配置`; }
    if (addresses.some(answer => !proxySocketAllowed(parsed, answer.address, endpoint.port))) {
      return `代理变量 ${key} 的端点存在不被实际内核网络规则允许的 TCP 地址或端口，会话不会启动。请使用策略允许的代理端点并核对全部 A/AAAA 地址；loopback 与网络网关别名不能作为代理出口`;
    }
  }
}
