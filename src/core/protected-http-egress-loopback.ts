import { readFileSync, statSync } from 'node:fs';
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { type AddressInfo, type Socket } from 'node:net';
import { parse } from 'smol-toml';
import {
  protectedHttpEgressAuthTokenPath,
} from './protected-http-egress-host.js';
import { normalizeProtectedHttpPath, type ProtectedHttpEgressPolicy } from './protected-http-egress.js';
import { resolveLoopbackPeerProcesses, type ProcessIdentity } from './current-actor-attestation.js';
import {
  PROTECTED_LOOPBACK_ATTESTATION_HEADER,
  PROTECTED_LOOPBACK_PEER_PID_HEADER,
  PROTECTED_LOOPBACK_PEER_START_HEADER,
} from './protected-loopback-attestation.js';

export const PROTECTED_HTTP_LOOPBACK_PLACEHOLDER_ORIGIN = 'http://127.0.0.1:0';

const MAX_CODEX_CONFIG_BYTES = 1024 * 1024;
const ROUTING_HEADERS = new Set([
  'x-botmux-egress-client',
  'x-botmux-egress-auth',
  'x-botmux-egress-policy',
  'x-botmux-egress-target',
  'x-botmux-loopback-service',
  PROTECTED_LOOPBACK_ATTESTATION_HEADER,
  PROTECTED_LOOPBACK_PEER_PID_HEADER,
  PROTECTED_LOOPBACK_PEER_START_HEADER,
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

export interface ProtectedLocalServiceLoopbackPlan {
  socketPath: string;
  serviceId: string;
  listenPort: number;
  method: string;
  path: string;
  forwardHeaders: string[];
  attestProcessPeer?: boolean;
}

export type ProtectedLocalServicePeerResolver = (
  peer: ProcessIdentity,
) => Promise<ProcessIdentity | null>;

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

function bridgeForbidden(response: ServerResponse): void {
  const body = Buffer.from('{"code":"botmux_protected_loopback_forbidden"}');
  response.writeHead(403, {
    'content-type': 'application/json',
    'content-length': String(body.length),
    connection: 'close',
  });
  response.end(body);
}

async function localServiceHeaders(
  request: IncomingMessage,
  authToken: string,
  plan: ProtectedLocalServiceLoopbackPlan,
  resolveProcessPeer: ProtectedLocalServicePeerResolver,
): Promise<Record<string, string> | undefined> {
  const allowed = new Set(['host', 'connection', 'content-length', ...plan.forwardHeaders]);
  const valuesByName = new Map<string, string[]>();
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    const name = request.rawHeaders[index]!.toLowerCase();
    if (!allowed.has(name)) return undefined;
    const values = valuesByName.get(name) ?? [];
    values.push(request.rawHeaders[index + 1]!);
    valuesByName.set(name, values);
  }
  if ([...valuesByName.values()].some(values => values.length !== 1)) return undefined;
  const headers: Record<string, string> = {};
  for (const name of plan.forwardHeaders) {
    const values = valuesByName.get(name) ?? [];
    if (values.length === 1) headers[name] = values[0]!;
  }
  const contentLength = valuesByName.get('content-length')?.[0];
  if (contentLength !== undefined) headers['content-length'] = contentLength;
  if (plan.attestProcessPeer) {
    const peer = await resolveLoopbackPeerProcesses({
      remoteAddress: request.socket.remoteAddress,
      remotePort: request.socket.remotePort,
      localPort: request.socket.localPort,
    });
    if (!peer.ok) return undefined;
    const resolvedPeer = await resolveProcessPeer(peer.peer);
    if (!resolvedPeer) return undefined;
    headers[PROTECTED_LOOPBACK_PEER_PID_HEADER] = String(resolvedPeer.pid);
    headers[PROTECTED_LOOPBACK_PEER_START_HEADER] = resolvedPeer.procStart;
  }
  headers['x-botmux-egress-auth'] = authToken;
  headers['x-botmux-loopback-service'] = plan.serviceId;
  return headers;
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

export async function startProtectedLocalServiceLoopbackBridge(
  plan: ProtectedLocalServiceLoopbackPlan,
  resolveProcessPeer: ProtectedLocalServicePeerResolver = async peer => peer,
): Promise<ProtectedHttpEgressLoopbackBridge> {
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(plan.serviceId)
    || !Number.isSafeInteger(plan.listenPort) || plan.listenPort < 0 || plan.listenPort > 65535
    || !/^[!#$%&'*+\-.^_`|~0-9A-Z]+$/.test(plan.method)
    || plan.method !== plan.method.toUpperCase()
    || normalizeProtectedHttpPath(plan.path) !== plan.path
    || plan.path.includes('?')
    || (plan.attestProcessPeer !== undefined && plan.attestProcessPeer !== true)) {
    throw new Error('protected_local_service_loopback_plan_invalid');
  }
  const forwardHeaders: string[] = [];
  const seen = new Set<string>();
  for (const header of plan.forwardHeaders) {
    if (header !== header.toLowerCase() || !/^[!#$%&'*+\-.^_`|~0-9a-z]+$/.test(header)
      || ROUTING_HEADERS.has(header) || header === 'host' || header === 'content-length'
      || seen.has(header)) {
      throw new Error('protected_local_service_loopback_plan_invalid');
    }
    seen.add(header);
    forwardHeaders.push(header);
  }
  const normalizedPlan = { ...plan, forwardHeaders };
  const authToken = readFileSync(protectedHttpEgressAuthTokenPath(plan.socketPath), 'utf8').trim();
  if (!authToken || authToken.length > 4096 || /[\r\n]/.test(authToken)) {
    throw new Error('protected_http_loopback_auth_invalid');
  }
  const sockets = new Set<Socket>();
  const server = createServer((incoming, outgoing) => {
    void (async () => {
      let path: string;
      try { path = normalizeProtectedHttpPath(incoming.url ?? ''); } catch {
        incoming.resume();
        bridgeForbidden(outgoing);
        return;
      }
      if ((incoming.method ?? '').toUpperCase() !== normalizedPlan.method || path !== normalizedPlan.path) {
        incoming.resume();
        bridgeForbidden(outgoing);
        return;
      }
      const headers = await localServiceHeaders(
        incoming,
        authToken,
        normalizedPlan,
        resolveProcessPeer,
      );
      if (!headers) {
        incoming.resume();
        bridgeForbidden(outgoing);
        return;
      }
      const upstream = httpRequest({
        socketPath: normalizedPlan.socketPath,
        method: normalizedPlan.method,
        path: normalizedPlan.path,
        headers,
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
    })().catch(() => {
      incoming.resume();
      if (!outgoing.headersSent) bridgeForbidden(outgoing);
      else if (!outgoing.writableEnded) outgoing.destroy();
    });
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
    server.listen(normalizedPlan.listenPort, '127.0.0.1');
  });
  const address = server.address() as AddressInfo | null;
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('protected_local_service_loopback_bind_failed');
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

function codexProviderBaseUrlArg(raw: string): {
  providerId: string;
  value: string;
  valueOffset: number;
} | undefined {
  const match = /^([ \t]*model_providers\.([A-Za-z0-9_-]{1,128})\.base_url[ \t]*=[ \t]*)(.*?)[ \t]*$/.exec(raw);
  if (!match) return undefined;
  const rawValue = match[3]!;
  const quote = rawValue[0];
  let value: unknown;
  if (quote === '"' || quote === "'") {
    try { value = parse(`value=${rawValue}`).value; } catch { return undefined; }
  } else {
    // Codex accepts an unquoted CLI value as a string when TOML parsing fails.
    value = rawValue;
  }
  if (typeof value !== 'string') return undefined;
  return {
    providerId: match[2]!,
    value,
    valueOffset: match[1]!.length + (quote === '"' || quote === "'" ? 1 : 0),
  };
}

/** Replace the origin only in one provider base_url passed through -c in the
 * launcher-declared CLI argument slice, never in shell or bwrap arguments.
 * Text in prompts, unrelated settings and the URL suffix is not routing input.
 * A second assignment to that provider is ambiguous even if it uses another
 * origin: Codex's override ordering must not silently undo the bridge. */
export function materializeProtectedHttpLoopbackArgs(
  args: readonly string[],
  placeholderOrigin: string,
  actualOrigin: string,
  cliArgsOffset = 0,
): string[] {
  if (!Number.isSafeInteger(cliArgsOffset) || cliArgsOffset < 0 || cliArgsOffset > args.length) {
    throw new Error('protected_http_loopback_args_offset');
  }
  const materialized = [...args];
  const providers = new Map<string, number>();
  let providerTableAssignments = 0;
  const targets: Array<{ index: number; providerId: string; valueOffset: number }> = [];
  for (let index = cliArgsOffset; index < args.length; index += 1) {
    const flag = args[index]!;
    if (flag === '--') break;
    const canonical = flag === '-c';
    let raw: string | undefined;
    if (canonical || flag === '--config') raw = args[++index];
    else if (flag.startsWith('--config=')) raw = flag.slice('--config='.length);
    else if (flag.startsWith('-c') && flag.length > 2) raw = flag.slice(flag[2] === '=' ? 3 : 2);
    if (raw === undefined) continue;
    // Codex splits CLI override keys on dots; do not treat quoted keys as
    // equivalent TOML paths. Count route writes even if their value cannot be
    // materialized, including replacement of the containing provider table.
    const equals = raw.indexOf('=');
    const assignment = equals < 0 ? undefined
      : /^model_providers(?:\.([A-Za-z0-9_-]{1,128})(?:\.base_url)?)?$/.exec(raw.slice(0, equals).trim());
    if (assignment) {
      const providerId = assignment[1];
      if (providerId) providers.set(providerId, (providers.get(providerId) ?? 0) + 1);
      else providerTableAssignments += 1;
    }
    const override = codexProviderBaseUrlArg(raw);
    if (!canonical || !override) continue;
    if (!override.value.startsWith(placeholderOrigin)
      || !/^(?:[/?#]|$)/.test(override.value.slice(placeholderOrigin.length))
      || raw.slice(override.valueOffset, override.valueOffset + placeholderOrigin.length) !== placeholderOrigin) {
      continue;
    }
    targets.push({ index, providerId: override.providerId, valueOffset: override.valueOffset });
  }
  const target = targets[0];
  if (targets.length !== 1 || !target || providers.get(target.providerId) !== 1 || providerTableAssignments !== 0) {
    throw new Error('protected_http_loopback_placeholder_count');
  }
  const raw = args[target.index]!;
  materialized[target.index] = `${raw.slice(0, target.valueOffset)}${actualOrigin}${raw.slice(target.valueOffset + placeholderOrigin.length)}`;
  return materialized;
}
