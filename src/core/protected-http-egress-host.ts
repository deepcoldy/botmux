import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, lstatSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP, type Socket } from 'node:net';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import {
  normalizeProtectedHttpPath,
  normalizeProtectedHttpEgressPolicy,
  protectedHttpEgressDecision,
  protectedHttpEgressPolicyDigest,
  type ProtectedHttpEgressPolicy,
  type ProtectedHttpEgressTarget,
} from './protected-http-egress.js';
import {
  createProtectedLoopbackProxyAttestation,
  PROTECTED_LOOPBACK_ATTESTATION_HEADER,
  PROTECTED_LOOPBACK_PEER_PID_HEADER,
  PROTECTED_LOOPBACK_PEER_START_HEADER,
} from './protected-loopback-attestation.js';
import type { ProcessIdentity } from './current-actor-attestation.js';
import { ensurePrivateGatewayDir, sessionMcpGatewaySocketDir } from './plugins/mcp/socket-dir.js';

export const PROTECTED_HTTP_EGRESS_SOCKET_ENV = 'BOTMUX_PROTECTED_EGRESS_SOCKET';
export const PROTECTED_HTTP_EGRESS_PROTOCOL_ENV = 'BOTMUX_PROTECTED_EGRESS_PROTOCOL';
export const PROTECTED_HTTP_SHARED_READ_PROTOCOL = 'shared-read-v1';
export const PROTECTED_HTTP_EGRESS_AUTH_FILENAME = 'egress-auth';
export const PROTECTED_HTTP_EGRESS_AUTH_DIRNAME = 'egress-private';
export const MAX_PROTECTED_HTTP_BODY_BYTES = 16 * 1024 * 1024;

const PROTECTED_HTTP_EGRESS_SOCKET_FILENAME = 'e.sock';
const UPSTREAM_TIMEOUT_MS = 30_000;
const HTTP_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Z]+$/;
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
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'host',
  'keep-alive',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);
const SINGLE_CREDENTIAL_HEADERS = ['authorization', 'cookie', 'x-jwt-token'] as const;
const ROUTING_OVERRIDE_HEADERS = [
  'x-http-method-override',
  'x-method-override',
  'x-original-url',
  'x-rewrite-url',
] as const;

export interface ProtectedHttpEgressForwardRequest {
  policyId: string;
  targetIndex: number;
  target: ProtectedHttpEgressTarget;
  method: string;
  path: string;
  headers: Record<string, string>;
  body: Buffer;
}

export interface ProtectedHttpEgressForwardResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer | Readable;
}

export interface ProtectedLoopbackService {
  id: string;
  listenPort: number;
  upstreamPort: number;
  method: string;
  path: string;
  forwardHeaders: string[];
  attestProcessPeer?: boolean;
  /** How long the upstream may stay silent before the request is cut (default
   *  {@link UPSTREAM_TIMEOUT_MS}). A route that holds its answer while it
   *  waits on slow work (a platform credential grant) declares a longer one. */
  upstreamTimeoutMs?: number;
}

export interface ProtectedLoopbackForwardRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: Buffer;
  peer?: ProcessIdentity;
}

export interface ProtectedHttpEgressLogEntry {
  policyId: string;
  method: string;
  path: string;
  decision: 'allow' | 'deny';
  status: number;
  durationMs: number;
  upstreamRequestId: string | undefined;
}

export interface ProtectedHttpEgressWarning {
  type: 'unregistered_mutating_candidate';
  policyId: string;
  method: string;
  path: string;
  status: number;
  durationMs: number;
}

export interface SessionProtectedHttpEgressHost {
  socketPath: string;
  socketDir: string;
  policyId: string;
  policyDigest: string;
  loopbackServices: readonly ProtectedLoopbackService[];
  close(): Promise<void>;
}

export interface StartSessionProtectedHttpEgressHostOptions {
  policy: ProtectedHttpEgressPolicy;
  policyDigest: string;
  /** Allow task clients to use the write-filtered business exit without host
   * authentication. This never admits the privileged loopback service exit. */
  sharedRead?: boolean;
  /** An already-resolved session MCP directory; primarily useful to tests. */
  socketDir?: string;
  sessionId?: string;
  dataDir?: string;
  /** Frozen A/AAAA results by policy target index. Required by the default forwarder. */
  frozenAddresses?: readonly (readonly string[])[];
  forward?: (request: ProtectedHttpEgressForwardRequest) => Promise<ProtectedHttpEgressForwardResponse>;
  loopbackServices?: readonly ProtectedLoopbackService[];
  forwardLoopbackService?: (
    service: ProtectedLoopbackService,
    request: ProtectedLoopbackForwardRequest,
  ) => Promise<ProtectedHttpEgressForwardResponse>;
  loopbackProxyAttestation?: {
    secret: string;
    workerGeneration: number;
    sessionId: string;
    currentTurn: () => { turnId?: string; dispatchAttempt?: number };
  };
  log?: (entry: ProtectedHttpEgressLogEntry) => void;
  warn?: (warning: ProtectedHttpEgressWarning) => void;
  onError?: (error: Error) => void;
}

class BodyLimitError extends Error {}
class InvalidRequestError extends Error {}

export function protectedHttpEgressAuthTokenPath(socketPath: string): string {
  return join(dirname(socketPath), PROTECTED_HTTP_EGRESS_AUTH_DIRNAME, PROTECTED_HTTP_EGRESS_AUTH_FILENAME);
}

function normalizedMethod(raw: string | undefined): string {
  const method = (raw ?? '').toUpperCase();
  if (!HTTP_TOKEN.test(method)) throw new InvalidRequestError('invalid_protected_http_method');
  return method;
}

function normalizeLoopbackServices(raw: readonly ProtectedLoopbackService[] | undefined): ProtectedLoopbackService[] {
  const ids = new Set<string>();
  const listenPorts = new Set<number>();
  return (raw ?? []).map(service => {
    if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(service.id)
      || !Number.isSafeInteger(service.listenPort) || service.listenPort < 1 || service.listenPort > 65535
      || !Number.isSafeInteger(service.upstreamPort) || service.upstreamPort < 1 || service.upstreamPort > 65535
      || ids.has(service.id) || listenPorts.has(service.listenPort)) {
      throw new Error('invalid_protected_loopback_service');
    }
    ids.add(service.id);
    listenPorts.add(service.listenPort);
    const method = normalizedMethod(service.method);
    const path = normalizeProtectedHttpPath(service.path);
    if (path.includes('?')) throw new Error('invalid_protected_loopback_service');
    const forwardHeaders: string[] = [];
    const seenHeaders = new Set<string>();
    for (const rawHeader of service.forwardHeaders) {
      const header = rawHeader.toLowerCase();
      if (!HTTP_TOKEN.test(header.toUpperCase()) || header !== rawHeader
        || HOP_BY_HOP_HEADERS.has(header) || ROUTING_HEADERS.has(header)
        || header === 'content-length' || isProxyHeader(header) || seenHeaders.has(header)) {
        throw new Error('invalid_protected_loopback_service');
      }
      seenHeaders.add(header);
      forwardHeaders.push(header);
    }
    if (service.attestProcessPeer !== undefined && service.attestProcessPeer !== true) {
      throw new Error('invalid_protected_loopback_service');
    }
    if (service.upstreamTimeoutMs !== undefined
      && (!Number.isSafeInteger(service.upstreamTimeoutMs) || service.upstreamTimeoutMs <= 0)) {
      throw new Error('invalid_protected_loopback_service');
    }
    return { ...service, method, path, forwardHeaders };
  });
}

function tokenMatches(presented: string, expected: string): boolean {
  const presentedBytes = Buffer.from(presented);
  const expectedBytes = Buffer.from(expected);
  return presentedBytes.length === expectedBytes.length
    && timingSafeEqual(presentedBytes, expectedBytes);
}

function rawHeaderValues(request: IncomingMessage, name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index].toLowerCase() === name) values.push(request.rawHeaders[index + 1]);
  }
  return values;
}

function requiredSingleHeader(request: IncomingMessage, name: string): string {
  const values = rawHeaderValues(request, name);
  if (values.length !== 1 || values[0].length === 0) throw new InvalidRequestError('invalid_header');
  return values[0];
}

function requestContentLength(request: IncomingMessage): number | undefined {
  const values = rawHeaderValues(request, 'content-length');
  if (values.length === 0) return undefined;
  if (values.length !== 1 || !/^(0|[1-9][0-9]*)$/.test(values[0])) {
    throw new InvalidRequestError('invalid_content_length');
  }
  const length = Number(values[0]);
  if (!Number.isSafeInteger(length)) throw new InvalidRequestError('invalid_content_length');
  return length;
}

function isProxyHeader(name: string): boolean {
  return name.startsWith('proxy-')
    || name === 'forwarded'
    || name === 'via'
    || name.startsWith('x-forwarded-');
}

function sanitizedRequestHeaders(request: IncomingMessage): Record<string, string> {
  if (request.headers.upgrade !== undefined || request.headers.expect !== undefined) {
    throw new InvalidRequestError('unsafe_request_header');
  }
  if (SINGLE_CREDENTIAL_HEADERS.some(name => rawHeaderValues(request, name).length > 1)) {
    throw new InvalidRequestError('duplicate_credential_header');
  }
  if (ROUTING_OVERRIDE_HEADERS.some(name => request.headers[name] !== undefined)) {
    throw new InvalidRequestError('routing_override_header');
  }
  const connectionNamed = new Set(
    String(request.headers.connection ?? '')
      .split(',')
      .map(name => name.trim().toLowerCase())
      .filter(Boolean),
  );
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined
      || HOP_BY_HOP_HEADERS.has(name)
      || connectionNamed.has(name)
      || ROUTING_HEADERS.has(name)
      || name.startsWith('x-botmux-')
      || isProxyHeader(name)
      || name === 'content-length') continue;
    headers[name] = Array.isArray(value) ? value.join(', ') : value;
  }
  return headers;
}

function loopbackRequestHeaders(
  request: IncomingMessage,
  service: ProtectedLoopbackService,
): { headers: Record<string, string>; peer?: ProcessIdentity } {
  if (request.headers.upgrade !== undefined || request.headers.expect !== undefined) {
    throw new InvalidRequestError('unsafe_request_header');
  }
  const allowed = new Set([
    'host', 'connection', 'content-length',
    'x-botmux-egress-auth', 'x-botmux-loopback-service',
    ...(service.attestProcessPeer
      ? [PROTECTED_LOOPBACK_PEER_PID_HEADER, PROTECTED_LOOPBACK_PEER_START_HEADER]
      : []),
    ...service.forwardHeaders,
  ]);
  const valuesByName = new Map<string, string[]>();
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    const name = request.rawHeaders[index]!.toLowerCase();
    if (!allowed.has(name)) throw new InvalidRequestError('undeclared_request_header');
    const values = valuesByName.get(name) ?? [];
    values.push(request.rawHeaders[index + 1]!);
    valuesByName.set(name, values);
  }
  if ([...valuesByName.values()].some(values => values.length !== 1)) {
    throw new InvalidRequestError('duplicate_forward_header');
  }
  const headers: Record<string, string> = {};
  for (const name of service.forwardHeaders) {
    const values = valuesByName.get(name) ?? [];
    if (values.length === 1) headers[name] = values[0]!;
  }
  if (!service.attestProcessPeer) return { headers };
  const pidText = valuesByName.get(PROTECTED_LOOPBACK_PEER_PID_HEADER)?.[0];
  const procStart = valuesByName.get(PROTECTED_LOOPBACK_PEER_START_HEADER)?.[0];
  const pid = Number(pidText);
  if (!/^\d+$/.test(pidText ?? '') || !Number.isSafeInteger(pid) || pid <= 1
    || !/^\d{1,64}$/.test(procStart ?? '')) {
    throw new InvalidRequestError('invalid_loopback_peer');
  }
  return { headers, peer: { pid, procStart: procStart! } };
}

function zeroBuffers(buffers: readonly Buffer[]): void {
  for (const buffer of buffers) buffer.fill(0);
}

function readCappedBody(stream: Readable, declaredLength?: number): Promise<Buffer> {
  if (declaredLength !== undefined && declaredLength > MAX_PROTECTED_HTTP_BODY_BYTES) {
    stream.resume();
    throw new BodyLimitError('request_body_too_large');
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let length = 0;
    let settled = false;
    const cleanup = () => {
      stream.off('data', onData);
      stream.off('end', onEnd);
      stream.off('error', onError);
      stream.off('aborted', onAborted);
    };
    const finish = (error?: Error, body?: Buffer) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) {
        zeroBuffers(chunks);
        reject(error);
      } else {
        resolve(body ?? Buffer.alloc(0));
      }
    };
    const onData = (chunk: Buffer | string) => {
      const copy = Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(chunk);
      chunks.push(copy);
      length += copy.length;
      if (length > MAX_PROTECTED_HTTP_BODY_BYTES) {
        stream.resume();
        finish(new BodyLimitError('body_too_large'));
      }
    };
    const onEnd = () => {
      if (declaredLength !== undefined && declaredLength !== length) {
        finish(new InvalidRequestError('content_length_mismatch'));
        return;
      }
      const body = Buffer.concat(chunks, length);
      zeroBuffers(chunks);
      finish(undefined, body);
    };
    const onError = (error: Error) => finish(error);
    const onAborted = () => finish(new InvalidRequestError('request_aborted'));
    stream.on('data', onData);
    stream.once('end', onEnd);
    stream.once('error', onError);
    stream.once('aborted', onAborted);
  });
}

function responseHeaderValue(
  headers: Record<string, string | string[] | undefined>,
  wanted: string,
): string | undefined {
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() !== wanted || value === undefined) continue;
    return Array.isArray(value) ? value[0] : value;
  }
  return undefined;
}

function sanitizedResponseHeaders(
  headers: Record<string, string | string[] | undefined>,
): Record<string, string | string[]> {
  const connectionNamed = new Set<string>();
  for (const [rawName, value] of Object.entries(headers)) {
    if (rawName.toLowerCase() !== 'connection' || value === undefined) continue;
    const values = Array.isArray(value) ? value : [value];
    for (const item of values) {
      for (const name of item.split(',')) {
        const normalized = name.trim().toLowerCase();
        if (normalized) connectionNamed.add(normalized);
      }
    }
  }
  const result: Record<string, string | string[]> = {};
  for (const [rawName, value] of Object.entries(headers)) {
    const name = rawName.toLowerCase();
    if (value === undefined
      || HOP_BY_HOP_HEADERS.has(name)
      || connectionNamed.has(name)
      || name === 'content-length'
      || name.startsWith('x-botmux-')
      || isProxyHeader(name)) continue;
    result[name] = value;
  }
  return result;
}

function sendJson(response: ServerResponse, status: number, code: string): void {
  const body = Buffer.from(JSON.stringify({ code }));
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': String(body.length),
    connection: 'close',
  });
  response.end(body);
}

function emitSafely<T>(sink: ((entry: T) => void) | undefined, entry: T): void {
  try { sink?.(entry); } catch { /* observability must not affect the decision */ }
}

function logPath(path: string): string {
  return path.split('?', 1)[0];
}

function rotateEgressAuthToken(socketPath: string): string {
  const token = randomBytes(32).toString('base64url');
  const finalPath = protectedHttpEgressAuthTokenPath(socketPath);
  ensurePrivateGatewayDir(dirname(finalPath));
  const tmpPath = `${finalPath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    writeFileSync(tmpPath, `${token}\n`, { mode: 0o600, flag: 'wx' });
    renameSync(tmpPath, finalPath);
    chmodSync(finalPath, 0o600);
  } catch (error) {
    rmSync(tmpPath, { force: true });
    throw error;
  }
  return token;
}

/** A late close must not remove authentication already rotated by a successor. */
function removeOwnedEgressAuthToken(socketPath: string, token: string): void {
  const path = protectedHttpEgressAuthTokenPath(socketPath);
  try {
    if (!lstatSync(path).isFile() || readFileSync(path, 'utf8').trim() !== token) return;
    rmSync(path, { force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function defaultForwarder(
  frozenAddresses: readonly (readonly string[])[],
): (request: ProtectedHttpEgressForwardRequest) => Promise<ProtectedHttpEgressForwardResponse> {
  return async request => {
    const addresses = frozenAddresses?.[request.targetIndex];
    const address = addresses?.[0];
    const family = address ? isIP(address) : 0;
    if (!address || family === 0) throw new Error('protected_http_egress_target_not_frozen');
    return new Promise((resolve, reject) => {
      const upstream = httpsRequest({
        protocol: 'https:',
        hostname: request.target.host,
        port: request.target.port,
        method: request.method,
        path: request.path,
        servername: request.target.host,
        agent: false,
        timeout: UPSTREAM_TIMEOUT_MS,
        headers: {
          ...request.headers,
          host: request.target.port === 443
            ? request.target.host
            : `${request.target.host}:${request.target.port}`,
        },
        lookup: (_hostname, options, callback) => {
          if (options.all) callback(null, [{ address, family }]);
          else callback(null, address, family);
        },
      }, async response => {
        resolve({
          status: response.statusCode ?? 502,
          headers: response.headers,
          body: response,
        });
      });
      upstream.once('timeout', () => upstream.destroy(new Error('protected_http_egress_timeout')));
      upstream.once('error', reject);
      upstream.end(request.body);
    });
  };
}

function defaultLoopbackForwarder(
  proxy: StartSessionProtectedHttpEgressHostOptions['loopbackProxyAttestation'],
  service: ProtectedLoopbackService,
  request: ProtectedLoopbackForwardRequest,
): Promise<ProtectedHttpEgressForwardResponse> {
  return new Promise((resolve, reject) => {
    const headers = { ...request.headers };
    if (service.attestProcessPeer) {
      if (!proxy || !request.peer) {
        reject(new Error('protected_loopback_attestation_unavailable'));
        return;
      }
      const currentTurn = proxy.currentTurn();
      const signedHeaders = Object.fromEntries(
        service.forwardHeaders.flatMap(name => request.headers[name] === undefined
          ? [] : [[name, request.headers[name]!]]),
      );
      headers[PROTECTED_LOOPBACK_ATTESTATION_HEADER] = createProtectedLoopbackProxyAttestation(
        proxy.secret,
        {
          sessionId: proxy.sessionId,
          serviceId: service.id,
          workerGeneration: proxy.workerGeneration,
          ...currentTurn,
          peer: request.peer,
          method: request.method,
          path: request.path,
          headers: signedHeaders,
          body: request.body,
        },
      );
    }
    const upstream = httpRequest({
      host: '127.0.0.1',
      port: service.upstreamPort,
      method: request.method,
      path: request.path,
      headers,
      agent: false,
      timeout: service.upstreamTimeoutMs ?? UPSTREAM_TIMEOUT_MS,
    }, response => resolve({
      status: response.statusCode ?? 502,
      headers: response.headers,
      body: response,
    }));
    upstream.once('timeout', () => upstream.destroy(new Error('protected_loopback_service_timeout')));
    upstream.once('error', reject);
    upstream.end(request.body);
  });
}

async function streamCappedResponseBody(source: Readable, response: ServerResponse): Promise<void> {
  let length = 0;
  try {
    for await (const raw of source) {
      const chunk = Buffer.isBuffer(raw) ? Buffer.from(raw) : Buffer.from(raw);
      length += chunk.length;
      if (length > MAX_PROTECTED_HTTP_BODY_BYTES) {
        chunk.fill(0);
        throw new BodyLimitError('response_body_too_large');
      }
      await new Promise<void>((resolve, reject) => {
        response.write(chunk, error => {
          chunk.fill(0);
          error ? reject(error) : resolve();
        });
      });
    }
    await new Promise<void>(resolve => response.end(resolve));
  } catch (error) {
    source.destroy();
    throw error;
  }
}

function snapshotFrozenAddresses(
  policy: ProtectedHttpEgressPolicy,
  raw: readonly (readonly string[])[] | undefined,
): readonly (readonly string[])[] {
  if (!raw || raw.length !== policy.targets.length) {
    throw new Error('protected_http_egress_target_not_frozen');
  }
  return raw.map(addresses => {
    if (addresses.length === 0 || addresses.some(address => isIP(address) === 0)) {
      throw new Error('protected_http_egress_target_not_frozen');
    }
    return [...addresses];
  });
}

function resolvedSocketDir(opts: StartSessionProtectedHttpEgressHostOptions): string {
  if (opts.socketDir) return opts.socketDir;
  if (!opts.sessionId || !opts.dataDir) throw new Error('protected_http_egress_socket_dir_required');
  return sessionMcpGatewaySocketDir(opts.sessionId, opts.dataDir);
}

export async function startSessionProtectedHttpEgressHost(
  opts: StartSessionProtectedHttpEgressHostOptions,
): Promise<SessionProtectedHttpEgressHost> {
  const policy = normalizeProtectedHttpEgressPolicy(opts.policy);
  if (!policy) throw new Error('invalid_protected_http_egress_policy');
  const actualDigest = protectedHttpEgressPolicyDigest(policy);
  if (actualDigest !== opts.policyDigest) {
    throw new Error('protected_http_egress_policy_digest_mismatch');
  }
  const socketDir = resolvedSocketDir(opts);
  const socketPath = join(socketDir, PROTECTED_HTTP_EGRESS_SOCKET_FILENAME);
  // libuv unlinks its original Unix listen pathname on close. Give each
  // generation a unique bind name, then publish at the stable session path;
  // a late old close must not unlink a replacement guard's socket.
  const listenPath = join(socketDir, `e.${randomBytes(4).toString('hex')}.sock`);
  const frozenAddresses = opts.forward
    ? opts.frozenAddresses?.map(addresses => [...addresses])
    : snapshotFrozenAddresses(policy, opts.frozenAddresses);
  const loopbackServices = normalizeLoopbackServices(opts.loopbackServices);
  if (!opts.forwardLoopbackService && loopbackServices.some(service => service.attestProcessPeer)
    && (!opts.loopbackProxyAttestation
      || !/^[a-f0-9]{64}$/.test(opts.loopbackProxyAttestation.secret)
      || !Number.isSafeInteger(opts.loopbackProxyAttestation.workerGeneration)
      || opts.loopbackProxyAttestation.workerGeneration <= 0
      || !/^[A-Za-z0-9._-]{1,200}$/.test(opts.loopbackProxyAttestation.sessionId))) {
    throw new Error('invalid_protected_loopback_proxy_attestation');
  }
  ensurePrivateGatewayDir(socketDir);
  rmSync(socketPath, { force: true });
  const authToken = rotateEgressAuthToken(socketPath);
  const forward = opts.forward ?? defaultForwarder(frozenAddresses!);
  const loopbackServicesById = new Map(loopbackServices.map(service => [service.id, service]));
  const forwardLoopbackService = opts.forwardLoopbackService
    ?? ((service, request) => defaultLoopbackForwarder(opts.loopbackProxyAttestation, service, request));
  const sockets = new Set<Socket>();
  const sensitiveBuffers = new Set<Buffer>();
  let closing: Promise<void> | undefined;
  let ownedSocket: { dev: number; ino: number } | undefined;

  const reportError = (_error: unknown): void => {
    try {
      opts.onError?.(new Error('protected_http_egress_error'));
    } catch { /* error reporting must not affect the guard */ }
  };
  const cleanupPaths = (): void => {
    // Filesystem cleanup failure must not keep connections or the listener
    // alive, and must not replace the original listen/startup error.
    try { removeOwnedEgressAuthToken(socketPath, authToken); } catch (error) { reportError(error); }
    try {
      const current = lstatSync(socketPath);
      if (ownedSocket && current.dev === ownedSocket.dev && current.ino === ownedSocket.ino) {
        rmSync(socketPath, { force: true });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') reportError(error);
    }
  };

  const server = createServer((request, response) => {
    void (async () => {
      const startedAt = Date.now();
      let method: string;
      let path: string;
      try {
        const presentedAuthValues = rawHeaderValues(request, 'x-botmux-egress-auth');
        const clientValues = rawHeaderValues(request, 'x-botmux-egress-client');
        const sharedRead = clientValues.length > 0;
        const authorized = sharedRead
          ? opts.sharedRead === true
            && clientValues.length === 1
            && clientValues[0] === PROTECTED_HTTP_SHARED_READ_PROTOCOL
            && presentedAuthValues.length === 0
            && !request.rawHeaders.some((name, index) => index % 2 === 0
              && name.toLowerCase().startsWith('x-botmux-loopback-'))
          : presentedAuthValues.length === 1 && tokenMatches(presentedAuthValues[0], authToken);
        if (!authorized) {
          request.resume();
          sendJson(response, 403, 'botmux_protected_egress_forbidden');
          return;
        }
        const loopbackServiceValues = rawHeaderValues(request, 'x-botmux-loopback-service');
        if (loopbackServiceValues.length > 0) {
          if (loopbackServiceValues.length !== 1
            || rawHeaderValues(request, 'x-botmux-egress-policy').length > 0
            || rawHeaderValues(request, 'x-botmux-egress-target').length > 0) {
            request.resume();
            sendJson(response, 403, 'botmux_protected_loopback_forbidden');
            return;
          }
          const service = loopbackServicesById.get(loopbackServiceValues[0]);
          method = normalizedMethod(request.method);
          path = normalizeProtectedHttpPath(request.url ?? '');
          if (!service || method !== service.method || path !== service.path) {
            request.resume();
            sendJson(response, 403, 'botmux_protected_loopback_forbidden');
            return;
          }
          const declaredLength = requestContentLength(request);
          let loopbackRequest: ReturnType<typeof loopbackRequestHeaders>;
          try {
            loopbackRequest = loopbackRequestHeaders(request, service);
          } catch (error) {
            if (!(error instanceof InvalidRequestError)) throw error;
            request.resume();
            sendJson(response, 403, 'botmux_protected_loopback_forbidden');
            return;
          }
          const headers = loopbackRequest.headers;
          const body = await readCappedBody(request, declaredLength);
          sensitiveBuffers.add(body);
          if (body.length > 0) headers['content-length'] = String(body.length);
          let pendingUpstreamBody: Buffer | undefined;
          try {
            const upstream = await forwardLoopbackService(service, {
              method, path, headers, body,
              ...(loopbackRequest.peer ? { peer: loopbackRequest.peer } : {}),
            });
            if (!Number.isInteger(upstream.status) || upstream.status < 100 || upstream.status > 599) {
              throw new Error('invalid_protected_loopback_status');
            }
            if (!Buffer.isBuffer(upstream.body) && !(upstream.body instanceof Readable)) {
              throw new Error('invalid_protected_loopback_body');
            }
            if (Buffer.isBuffer(upstream.body)) {
              pendingUpstreamBody = upstream.body;
              sensitiveBuffers.add(upstream.body);
              if (upstream.body.length > MAX_PROTECTED_HTTP_BODY_BYTES) {
                sendJson(response, 502, 'botmux_protected_loopback_response_too_large');
                upstream.body.fill(0);
                sensitiveBuffers.delete(upstream.body);
                pendingUpstreamBody = undefined;
              } else {
                response.writeHead(upstream.status, sanitizedResponseHeaders(upstream.headers));
                const responseBody = upstream.body;
                const clearResponseBody = () => {
                  responseBody.fill(0);
                  sensitiveBuffers.delete(responseBody);
                };
                response.once('finish', clearResponseBody);
                response.once('close', clearResponseBody);
                response.end(responseBody);
                pendingUpstreamBody = undefined;
              }
            } else {
              response.writeHead(upstream.status, sanitizedResponseHeaders(upstream.headers));
              await streamCappedResponseBody(upstream.body, response);
            }
          } catch (error) {
            pendingUpstreamBody?.fill(0);
            if (pendingUpstreamBody) sensitiveBuffers.delete(pendingUpstreamBody);
            if (!response.headersSent) sendJson(response, 502, 'botmux_protected_loopback_unavailable');
            else if (!response.writableEnded) response.destroy();
            reportError(error);
          } finally {
            body.fill(0);
            sensitiveBuffers.delete(body);
          }
          return;
        }
        const policyId = requiredSingleHeader(request, 'x-botmux-egress-policy');
        const targetText = requiredSingleHeader(request, 'x-botmux-egress-target');
        if (policyId !== policy.id) {
          request.resume();
          sendJson(response, 403, 'botmux_protected_egress_forbidden');
          return;
        }
        if (!/^(0|[1-9][0-9]*)$/.test(targetText)) throw new InvalidRequestError('invalid_target');
        const targetIndex = Number(targetText);
        const target = policy.targets[targetIndex];
        if (!Number.isSafeInteger(targetIndex) || !target) throw new InvalidRequestError('invalid_target');

        method = normalizedMethod(request.method);
        path = normalizeProtectedHttpPath(request.url ?? '');
        const decision = protectedHttpEgressDecision(policy, policyId, targetIndex, method, path);
        if (decision === 'deny') {
          request.resume();
          sendJson(response, 403, 'botmux_protected_write_required');
          emitSafely(opts.log, {
            policyId,
            method,
            path: logPath(path),
            decision,
            status: 403,
            durationMs: Date.now() - startedAt,
            upstreamRequestId: undefined,
          });
          return;
        }

        const declaredLength = requestContentLength(request);
        const headers = sanitizedRequestHeaders(request);
        const body = await readCappedBody(request, declaredLength);
        sensitiveBuffers.add(body);
        if (body.length > 0) headers['content-length'] = String(body.length);

        let status = 502;
        let upstreamRequestId: string | undefined;
        let pendingUpstreamBody: Buffer | undefined;
        try {
          const upstream = await forward({
            policyId,
            targetIndex,
            target,
            method,
            path,
            headers,
            body,
          });
          if (!Number.isInteger(upstream.status) || upstream.status < 100 || upstream.status > 599) {
            throw new Error('invalid_protected_http_egress_status');
          }
          if (!Buffer.isBuffer(upstream.body) && !(upstream.body instanceof Readable)) {
            throw new Error('invalid_protected_http_egress_body');
          }
          status = upstream.status;
          upstreamRequestId = responseHeaderValue(upstream.headers, 'x-request-id');
          if (Buffer.isBuffer(upstream.body)) {
            pendingUpstreamBody = upstream.body;
            sensitiveBuffers.add(upstream.body);
            if (upstream.body.length > MAX_PROTECTED_HTTP_BODY_BYTES) {
              status = 502;
              sendJson(response, 502, 'botmux_protected_egress_response_too_large');
              upstream.body.fill(0);
              sensitiveBuffers.delete(upstream.body);
              pendingUpstreamBody = undefined;
            } else {
              response.writeHead(status, sanitizedResponseHeaders(upstream.headers));
              const responseBody = upstream.body;
              const clearResponseBody = () => {
                responseBody.fill(0);
                sensitiveBuffers.delete(responseBody);
              };
              response.once('finish', clearResponseBody);
              response.once('close', clearResponseBody);
              response.end(responseBody);
              pendingUpstreamBody = undefined;
            }
          } else {
            response.writeHead(status, sanitizedResponseHeaders(upstream.headers));
            await streamCappedResponseBody(upstream.body, response);
          }
        } catch (error) {
          status = 502;
          pendingUpstreamBody?.fill(0);
          if (pendingUpstreamBody) sensitiveBuffers.delete(pendingUpstreamBody);
          if (!response.headersSent) sendJson(response, 502, 'botmux_protected_egress_unavailable');
          else if (!response.writableEnded) response.destroy();
          reportError(error);
        } finally {
          body.fill(0);
          sensitiveBuffers.delete(body);
        }

        const durationMs = Date.now() - startedAt;
        emitSafely(opts.log, {
          policyId,
          method,
          path: logPath(path),
          decision: 'allow',
          status,
          durationMs,
          upstreamRequestId,
        });
        if (method !== 'GET' && method !== 'HEAD') {
          emitSafely(opts.warn, {
            type: 'unregistered_mutating_candidate',
            policyId,
            method,
            path: logPath(path),
            status,
            durationMs,
          });
        }
      } catch (error) {
        request.resume();
        if (!response.headersSent) {
          if (error instanceof BodyLimitError) {
            sendJson(response, 413, 'botmux_protected_egress_request_too_large');
          } else if (error instanceof InvalidRequestError
            || (error instanceof Error && (
              error.message === 'invalid_protected_http_path'
              || error.message === 'invalid_protected_http_method'
            ))) {
            sendJson(response, 400, 'botmux_protected_egress_invalid_request');
          } else {
            sendJson(response, 403, 'botmux_protected_egress_forbidden');
          }
        }
      }
    })().catch(reportError);
  });
  server.on('connection', socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    const onInitialError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onInitialError);
      try {
        const stat = lstatSync(listenPath);
        renameSync(listenPath, socketPath);
        ownedSocket = { dev: stat.dev, ino: stat.ino };
        resolve();
      } catch (error) { reject(error); }
    };
    server.once('error', onInitialError);
    server.once('listening', onListening);
    server.listen(listenPath);
  }).catch(error => {
    cleanupPaths();
    if (server.listening) server.close();
    throw error;
  });
  server.on('error', reportError);
  try {
    chmodSync(socketPath, 0o600);
  } catch (error) {
    server.close();
    cleanupPaths();
    throw error;
  }

  return {
    socketPath,
    socketDir,
    policyId: policy.id,
    policyDigest: actualDigest,
    loopbackServices,
    close(): Promise<void> {
      closing ??= (async () => {
        cleanupPaths();
        for (const socket of sockets) socket.destroy();
        for (const buffer of sensitiveBuffers) buffer.fill(0);
        sensitiveBuffers.clear();
        await new Promise<void>(resolve => {
          if (!server.listening) resolve();
          else server.close(() => resolve());
        });
      })();
      return closing;
    },
  };
}
