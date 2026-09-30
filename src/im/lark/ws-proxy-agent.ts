/**
 * Proxy agent for the Lark/Feishu WebSocket long connection.
 *
 * Why this module exists: the daemon used to hand `proxy-agent`'s `ProxyAgent`
 * to `Lark.WSClient({ agent })`. Under Node the `ws` package drives the agent
 * through `agent.connect()`, so the CONNECT tunnel is built and the proxy is
 * honoured. Bun replaces the `ws` package with its own implementation, which
 * never calls `agent.connect()` — it only reads a proxy URL off the agent
 * object (`agent.proxy` / `agent.connectOpts.proxy`, the shape `HttpsProxyAgent`
 * exposes). `ProxyAgent` has neither, so on Bun the proxy was silently dropped,
 * the client dialled `open.feishu.cn` directly and, on a proxy-only host, the
 * log filled with `[ws] ws connect failed` while `status` still read healthy.
 *
 * Resolution reuses `proxy-from-env`, the same library Axios consults for the
 * SDK's preceding HTTPS bootstrap request, so both phases agree on
 * `https_proxy` / `all_proxy` / `npm_config_*` precedence and on `no_proxy`.
 * The lookup is keyed on the **https** form of the Open API domain: the
 * bootstrap request is HTTPS and `proxy-from-env` would otherwise look for a
 * separate `WSS_PROXY` for the socket itself.
 */
import type { Agent } from 'node:http';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { ProxyAgent } from 'proxy-agent';
import { getProxyForUrl } from 'proxy-from-env';
import { logger } from '../../utils/logger.js';

export type LarkWsProxyKind = 'direct' | 'http' | 'other';

export interface LarkWsProxyResolution {
  /** Proxy URL exactly as configured (may carry userinfo — never log it raw). */
  proxyUrl?: string;
  /** `direct` = no proxy applies; `http` = http(s) CONNECT proxy; `other` = socks/pac/…  */
  kind: LarkWsProxyKind;
}

/** Normalise an Open API domain (`https://open.feishu.cn` or bare host) to the
 *  https URL `proxy-from-env` should evaluate `no_proxy` against. */
function openApiHttpsUrl(openApiDomain: string): string {
  const trimmed = openApiDomain.trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  const url = new URL(withScheme);
  // The socket is wss:// — evaluate the env as HTTPS so NO_PROXY and
  // HTTPS_PROXY apply, matching the SDK's Axios bootstrap call.
  if (url.protocol === 'wss:' || url.protocol === 'ws:') url.protocol = 'https:';
  return url.href;
}

/** Decide, from the process environment, how the ws long connection should
 *  reach `openApiDomain`. Pure apart from reading `process.env`.
 *
 *  DELIBERATE BEHAVIOUR CHANGE vs the pre-fix per-connection `ProxyAgent`:
 *  the SDK does not dial `openApiDomain` for the socket — it first POSTs
 *  `/callback/ws/endpoint` and connects to the dynamic frontier host it returns
 *  (e.g. `wss://msg-frontier.feishu.cn/ws/v2?…`). The old agent re-evaluated
 *  `getProxyForUrl` at `connect()` time against that real host; a static
 *  `HttpsProxyAgent` cannot, so both the proxy choice and the `no_proxy`
 *  decision are made once here against the Open API domain instead. A `no_proxy`
 *  suffix such as `.feishu.cn` covers both hosts and behaves identically; only
 *  an exact-host `no_proxy` differs (`open.feishu.cn` now goes direct;
 *  `msg-frontier.feishu.cn` no longer does). Standard suffix configs — the ones
 *  real deployments use — are unaffected. */
export function resolveLarkWsProxy(openApiDomain: string): LarkWsProxyResolution {
  const proxyUrl = getProxyForUrl(openApiHttpsUrl(openApiDomain));
  if (!proxyUrl) return { kind: 'direct' };
  let protocol: string | undefined;
  try {
    protocol = new URL(proxyUrl).protocol;
  } catch {
    protocol = undefined;
  }
  return { proxyUrl, kind: protocol === 'http:' || protocol === 'https:' ? 'http' : 'other' };
}

/** `bun 1.4.2` / `node v22.1.0` — the runtime decides which ws implementation
 *  (and therefore which agent shape) is in play, so every ws log line says it. */
export function describeWsRuntime(): string {
  const bun = (process.versions as Record<string, string | undefined>).bun;
  return bun ? `bun ${bun}` : `node ${process.version}`;
}

/** Log-safe rendering: userinfo stripped, path dropped. */
export function describeLarkWsProxy(resolution: LarkWsProxyResolution): string {
  if (resolution.kind === 'direct' || !resolution.proxyUrl) return 'direct';
  try {
    const url = new URL(resolution.proxyUrl);
    return `${url.protocol}//${url.host}`;
  } catch {
    return `<unparseable ${resolution.kind} proxy>`;
  }
}

/** Legacy agent for the non-HTTP case (socks / pac / …). Kept exactly as the
 *  pre-fix code so Node behaviour there is unchanged; Bun's ws cannot tunnel
 *  through it, which the caller logs. */
function legacyProxyAgent(): ProxyAgent {
  const agent = new ProxyAgent();
  const resolveEnvProxy = agent.getProxyForUrl;
  agent.getProxyForUrl = (url, req) => {
    const target = new URL(url);
    if (target.protocol === 'wss:') target.protocol = 'https:';
    else if (target.protocol === 'ws:') target.protocol = 'http:';
    return resolveEnvProxy(target.href, req);
  };
  return agent;
}

/** Build the agent for `resolution`, or `undefined` for a direct connection
 *  (identical to the pre-fix behaviour when no proxy env is set). */
export function larkWsAgentFor(resolution: LarkWsProxyResolution): Agent | undefined {
  if (resolution.kind === 'direct' || !resolution.proxyUrl) return undefined;
  if (resolution.kind === 'http') {
    // HttpsProxyAgent works on both runtimes: Node's `ws` calls `agent.connect()`
    // (CONNECT tunnel with the target *hostname*, which corporate proxies
    // require); Bun's built-in ws reads `agent.proxy` and tunnels itself.
    return new HttpsProxyAgent(resolution.proxyUrl);
  }
  if ((process.versions as Record<string, string | undefined>).bun) {
    logger.warn(
      `[ws] proxy=${describeLarkWsProxy(resolution)} is not an HTTP proxy; `
      + `Bun's WebSocket cannot tunnel through it and will connect directly`,
    );
  }
  return legacyProxyAgent();
}

/** Convenience: resolve + build in one call. */
export function createLarkWsAgent(openApiDomain: string): Agent | undefined {
  return larkWsAgentFor(resolveLarkWsProxy(openApiDomain));
}
