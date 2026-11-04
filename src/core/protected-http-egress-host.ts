import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP, type Socket } from 'node:net';
import { dirname, join } from 'node:path';
import type { Readable } from 'node:stream';
import {
  normalizeProtectedHttpPath,
  normalizeProtectedHttpEgressPolicy,
  protectedHttpEgressDecision,
  protectedHttpEgressPolicyDigest,
  type ProtectedHttpEgressPolicy,
  type ProtectedHttpEgressTarget,
} from './protected-http-egress.js';
import { ensurePrivateGatewayDir, sessionMcpGatewaySocketDir } from './plugins/mcp/socket-dir.js';

export const PROTECTED_HTTP_EGRESS_SOCKET_ENV = 'BOTMUX_PROTECTED_EGRESS_SOCKET';
export const PROTECTED_HTTP_EGRESS_REQUIRED_ENV = 'BOTMUX_PROTECTED_EGRESS_REQUIRED';
export const PROTECTED_HTTP_EGRESS_AUTH_FILENAME = 'egress-auth';
export const MAX_PROTECTED_HTTP_BODY_BYTES = 16 * 1024 * 1024;

const PROTECTED_HTTP_EGRESS_SOCKET_FILENAME = 'e.sock';
const UPSTREAM_TIMEOUT_MS = 30_000;
const HTTP_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Z]+$/;
const ROUTING_HEADERS = new Set([
  'x-botmux-egress-auth',
  'x-botmux-egress-policy',
  'x-botmux-egress-target',
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
  body: Buffer;
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
  close(): Promise<void>;
}

export interface StartSessionProtectedHttpEgressHostOptions {
  policy: ProtectedHttpEgressPolicy;
  policyDigest: string;
  /** An already-resolved session MCP directory; primarily useful to tests. */
  socketDir?: string;
  sessionId?: string;
  dataDir?: string;
  /** Frozen A/AAAA results by policy target index. Required by the default forwarder. */
  frozenAddresses?: readonly (readonly string[])[];
  forward?: (request: ProtectedHttpEgressForwardRequest) => Promise<ProtectedHttpEgressForwardResponse>;
  log?: (entry: ProtectedHttpEgressLogEntry) => void;
  warn?: (warning: ProtectedHttpEgressWarning) => void;
  onError?: (error: Error) => void;
}

class BodyLimitError extends Error {}
class InvalidRequestError extends Error {}

export function protectedHttpEgressAuthTokenPath(socketPath: string): string {
  return join(dirname(socketPath), PROTECTED_HTTP_EGRESS_AUTH_FILENAME);
}

function normalizedMethod(raw: string | undefined): string {
  const method = (raw ?? '').toUpperCase();
  if (!HTTP_TOKEN.test(method)) throw new InvalidRequestError('invalid_protected_http_method');
  return method;
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
        lookup: (_hostname, _options, callback) => callback(null, address, family),
      }, async response => {
        try {
          const body = await readCappedBody(response);
          resolve({
            status: response.statusCode ?? 502,
            headers: response.headers,
            body,
          });
        } catch (error) {
          response.destroy();
          reject(error);
        }
      });
      upstream.once('timeout', () => upstream.destroy(new Error('protected_http_egress_timeout')));
      upstream.once('error', reject);
      upstream.end(request.body);
    });
  };
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
  const frozenAddresses = opts.forward
    ? opts.frozenAddresses?.map(addresses => [...addresses])
    : snapshotFrozenAddresses(policy, opts.frozenAddresses);
  ensurePrivateGatewayDir(socketDir);
  rmSync(socketPath, { force: true });
  const authToken = rotateEgressAuthToken(socketPath);
  const forward = opts.forward ?? defaultForwarder(frozenAddresses!);
  const sockets = new Set<Socket>();
  const sensitiveBuffers = new Set<Buffer>();
  let closing: Promise<void> | undefined;

  const reportError = (_error: unknown): void => {
    try {
      opts.onError?.(new Error('protected_http_egress_error'));
    } catch { /* error reporting must not affect the guard */ }
  };

  const server = createServer((request, response) => {
    void (async () => {
      const startedAt = Date.now();
      let method: string;
      let path: string;
      try {
        const presentedAuthValues = rawHeaderValues(request, 'x-botmux-egress-auth');
        if (presentedAuthValues.length !== 1 || !tokenMatches(presentedAuthValues[0], authToken)) {
          request.resume();
          sendJson(response, 403, 'botmux_protected_egress_forbidden');
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
          if (!Buffer.isBuffer(upstream.body)) throw new Error('invalid_protected_http_egress_body');
          pendingUpstreamBody = upstream.body;
          sensitiveBuffers.add(upstream.body);
          if (upstream.body.length > MAX_PROTECTED_HTTP_BODY_BYTES) {
            sendJson(response, 502, 'botmux_protected_egress_response_too_large');
            upstream.body.fill(0);
            sensitiveBuffers.delete(upstream.body);
            pendingUpstreamBody = undefined;
          } else {
            status = upstream.status;
            upstreamRequestId = responseHeaderValue(upstream.headers, 'x-request-id');
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
        } catch (error) {
          status = 502;
          pendingUpstreamBody?.fill(0);
          if (pendingUpstreamBody) sensitiveBuffers.delete(pendingUpstreamBody);
          if (!response.headersSent) sendJson(response, 502, 'botmux_protected_egress_unavailable');
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
      resolve();
    };
    server.once('error', onInitialError);
    server.once('listening', onListening);
    server.listen(socketPath);
  }).catch(error => {
    rmSync(socketPath, { force: true });
    throw error;
  });
  server.on('error', reportError);
  try {
    chmodSync(socketPath, 0o600);
  } catch (error) {
    server.close();
    rmSync(socketPath, { force: true });
    throw error;
  }

  return {
    socketPath,
    socketDir,
    policyId: policy.id,
    policyDigest: actualDigest,
    close(): Promise<void> {
      closing ??= (async () => {
        rmSync(socketPath, { force: true });
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
