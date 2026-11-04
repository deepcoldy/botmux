import { readFileSync, statSync } from 'node:fs';
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { type AddressInfo, type Socket } from 'node:net';
import { parse } from 'smol-toml';
import {
  protectedHttpEgressAuthTokenPath,
} from './protected-http-egress-host.js';
import type { ProtectedHttpEgressPolicy } from './protected-http-egress.js';

export const PROTECTED_HTTP_LOOPBACK_PLACEHOLDER_ORIGIN = 'http://127.0.0.1:0';

const MAX_CODEX_CONFIG_BYTES = 1024 * 1024;
const ROUTING_HEADERS = new Set([
  'x-botmux-egress-auth',
  'x-botmux-egress-policy',
  'x-botmux-egress-target',
]);

export interface ProtectedHttpEgressLoopbackPlan {
  socketPath: string;
  policyId: string;
  targetIndex: number;
  placeholderOrigin: string;
}

export interface ProtectedHttpEgressLoopbackBridge {
  origin: string;
  close(): Promise<void>;
}

export interface CodexProtectedProviderBridgeSelection {
  providerId: string;
  baseUrlOverride: string;
  bridge: ProtectedHttpEgressLoopbackPlan;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function baseUrlAuthorityEnd(raw: string): number {
  const schemeEnd = raw.indexOf('://');
  if (schemeEnd < 0) return -1;
  const suffix = raw.slice(schemeEnd + 3).search(/[/?#]/);
  return suffix < 0 ? raw.length : schemeEnd + 3 + suffix;
}

/** Select only the provider Codex will actually use. A matching inactive
 * provider does not need a bridge and must not widen the task's loopback exit. */
export function selectCodexProtectedProviderBridge(opts: {
  config: unknown;
  policy: ProtectedHttpEgressPolicy;
  socketPath: string;
}): CodexProtectedProviderBridgeSelection | undefined {
  const config = record(opts.config);
  const providerId = config?.model_provider;
  const providers = record(config?.model_providers);
  if (typeof providerId !== 'string' || !providers) return undefined;
  const provider = record(providers[providerId]);
  const rawBaseUrl = provider?.base_url;
  if (typeof rawBaseUrl !== 'string') return undefined;

  let url: URL;
  try { url = new URL(rawBaseUrl); } catch { return undefined; }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) return undefined;
  const port = url.port ? Number(url.port) : 443;
  const targetIndex = opts.policy.targets.findIndex(target => (
    target.scheme === 'https'
    && target.host === url.hostname
    && target.port === port
  ));
  if (targetIndex < 0) return undefined;
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(providerId)) {
    throw new Error('protected_codex_provider_id_not_overridable');
  }
  const authorityEnd = baseUrlAuthorityEnd(rawBaseUrl);
  if (authorityEnd < 0) throw new Error('protected_codex_provider_base_url_invalid');
  return {
    providerId,
    baseUrlOverride: `${PROTECTED_HTTP_LOOPBACK_PLACEHOLDER_ORIGIN}${rawBaseUrl.slice(authorityEnd)}`,
    bridge: {
      socketPath: opts.socketPath,
      policyId: opts.policy.id,
      targetIndex,
      placeholderOrigin: PROTECTED_HTTP_LOOPBACK_PLACEHOLDER_ORIGIN,
    },
  };
}

/** Read only enough Codex configuration to identify the active provider.
 * Parse failures never include source snippets because config may contain
 * provider credentials. */
export function readCodexProtectedProviderBridge(opts: {
  configPath: string;
  policy: ProtectedHttpEgressPolicy;
  socketPath: string;
}): CodexProtectedProviderBridgeSelection | undefined {
  let source: string;
  try {
    const stat = statSync(opts.configPath);
    if (!stat.isFile() || stat.size > MAX_CODEX_CONFIG_BYTES) {
      throw new Error('protected_codex_provider_config_invalid');
    }
    source = readFileSync(opts.configPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error('protected_codex_provider_config_unreadable');
  }
  let config: unknown;
  try { config = parse(source); } catch { throw new Error('protected_codex_provider_config_invalid'); }
  return selectCodexProtectedProviderBridge({
    config,
    policy: opts.policy,
    socketPath: opts.socketPath,
  });
}

function bridgeHeaders(request: IncomingMessage, authToken: string, plan: ProtectedHttpEgressLoopbackPlan): Record<string, string | string[]> {
  const collected = new Map<string, string[]>();
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    const name = request.rawHeaders[index]!.toLowerCase();
    if (ROUTING_HEADERS.has(name) || name === 'host') continue;
    const values = collected.get(name) ?? [];
    values.push(request.rawHeaders[index + 1]!);
    collected.set(name, values);
  }
  const headers: Record<string, string | string[]> = {};
  for (const [name, values] of collected) headers[name] = values.length === 1 ? values[0]! : values;
  headers['x-botmux-egress-auth'] = authToken;
  headers['x-botmux-egress-policy'] = plan.policyId;
  headers['x-botmux-egress-target'] = String(plan.targetIndex);
  return headers;
}

function bridgeUnavailable(response: ServerResponse): void {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  const body = Buffer.from('{"code":"botmux_protected_egress_unavailable"}');
  response.writeHead(502, {
    'content-type': 'application/json',
    'content-length': String(body.length),
    connection: 'close',
  });
  response.end(body);
}

/** Bind inside the session network namespace. The task sees only an ordinary
 * loopback HTTP origin; the Unix socket authentication material remains owned
 * by this runner process and is injected at the trusted boundary. */
export async function startProtectedHttpEgressLoopbackBridge(
  plan: ProtectedHttpEgressLoopbackPlan,
): Promise<ProtectedHttpEgressLoopbackBridge> {
  const authToken = readFileSync(protectedHttpEgressAuthTokenPath(plan.socketPath), 'utf8').trim();
  if (!authToken || authToken.length > 4096 || /[\r\n]/.test(authToken)) {
    throw new Error('protected_http_loopback_auth_invalid');
  }
  const sockets = new Set<Socket>();
  const server = createServer((incoming, outgoing) => {
    const upstream = httpRequest({
      socketPath: plan.socketPath,
      method: incoming.method,
      path: incoming.url,
      headers: bridgeHeaders(incoming, authToken, plan),
      agent: false,
    }, response => {
      outgoing.writeHead(response.statusCode ?? 502, response.statusMessage, response.headers);
      response.pipe(outgoing);
    });
    upstream.once('error', () => bridgeUnavailable(outgoing));
    incoming.once('aborted', () => upstream.destroy());
    outgoing.once('close', () => {
      if (!outgoing.writableEnded) upstream.destroy();
    });
    incoming.pipe(upstream);
  });
  server.on('connection', socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  server.on('connect', (_request, socket) => socket.destroy());
  server.on('upgrade', (_request, socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(0, '127.0.0.1');
  });
  const address = server.address() as AddressInfo | null;
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('protected_http_loopback_bind_failed');
  }
  let closing: Promise<void> | undefined;
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close(): Promise<void> {
      closing ??= new Promise<void>(resolve => {
        for (const socket of sockets) socket.destroy();
        if (!server.listening) resolve();
        else server.close(() => resolve());
      });
      return closing;
    },
  };
}

export function materializeProtectedHttpLoopbackArgs(
  args: readonly string[],
  placeholderOrigin: string,
  actualOrigin: string,
): string[] {
  let count = 0;
  const materialized = args.map(arg => {
    if (!arg.includes(placeholderOrigin)) return arg;
    count += arg.split(placeholderOrigin).length - 1;
    return arg.split(placeholderOrigin).join(actualOrigin);
  });
  if (count !== 1) throw new Error('protected_http_loopback_placeholder_count');
  return materialized;
}
