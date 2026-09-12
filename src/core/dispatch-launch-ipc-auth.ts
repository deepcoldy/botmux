import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

import { dashboardSecretPath } from './dashboard-secret.js';
import { loadDashboardSecret } from '../dashboard/auth.js';

export const DISPATCH_LAUNCH_IPC_DOMAIN = 'botmux-dispatch-launch-ipc/v1';
export const DISPATCH_LAUNCH_IPC_RESPONSE_DOMAIN = 'botmux-dispatch-launch-ipc/v1/response';
export const DISPATCH_LAUNCH_IPC_ROUTE_PREFIX = '/__dispatch-launch-ipc/v1/operations';
export const DISPATCH_LAUNCH_IPC_TS_WINDOW_MS = 60_000;
export const DISPATCH_LAUNCH_IPC_NONCE_TTL_MS = 10 * 60_000;
export const DISPATCH_LAUNCH_IPC_BODY_LIMIT_BYTES = 80 * 1024;
export const DISPATCH_LAUNCH_IPC_BODY_READ_TIMEOUT_MS = 5_000;
export const DISPATCH_LAUNCH_IPC_HEADERS = {
  timestamp: 'x-botmux-dispatch-launch-ipc-ts',
  nonce: 'x-botmux-dispatch-launch-ipc-nonce',
  signature: 'x-botmux-dispatch-launch-ipc-signature',
  responseSignature: 'x-botmux-dispatch-launch-ipc-response-signature',
} as const;

const B64URL_32_BYTES_RE = /^[A-Za-z0-9_-]{43}$/;
const CANONICAL_EPOCH_MS_RE = /^(?:0|[1-9][0-9]{0,15})$/;

export interface DispatchLaunchIpcTarget {
  larkAppId: string;
  ipcPort: number;
  bootInstanceId: string;
}

export interface DispatchLaunchIpcSignInput {
  secret: string;
  timestamp: string;
  nonce: string;
  method: string;
  pathWithQuery: string;
  body: string | Uint8Array;
  target: DispatchLaunchIpcTarget;
}

export interface DispatchLaunchIpcResponseSignInput {
  secret: string;
  requestNonce: string;
  method: string;
  pathWithQuery: string;
  status: number;
  body: string | Uint8Array;
  target: DispatchLaunchIpcTarget;
}

export interface DispatchLaunchIpcClock {
  now(): number;
}

export interface DispatchLaunchIpcNonceStore {
  has(nonce: string): boolean;
  add(nonce: string, expiresAt: number): void;
  size(): number;
}

export type DispatchLaunchIpcVerifyReason =
  | 'remote_not_loopback'
  | 'missing_or_malformed_header'
  | 'timestamp_out_of_window'
  | 'target_identity_unavailable'
  | 'body_too_large'
  | 'body_length_mismatch'
  | 'body_read_timeout'
  | 'body_read_failed'
  | 'body_not_utf8'
  | 'signature_mismatch'
  | 'replay';

export type DispatchLaunchIpcVerifyResult =
  | { ok: true; bodyRaw: string; nonce: string; target: DispatchLaunchIpcTarget }
  | { ok: false; reason: DispatchLaunchIpcVerifyReason; httpStatus: number };

export interface DispatchLaunchIpcVerifyOptions {
  secret: string;
  target: Omit<DispatchLaunchIpcTarget, 'ipcPort'>;
  nonceStore: DispatchLaunchIpcNonceStore;
  clock?: DispatchLaunchIpcClock;
  maxBodyBytes?: number;
  bodyReadTimeoutMs?: number;
}

export const dispatchLaunchIpcRealClock: DispatchLaunchIpcClock = { now: () => Date.now() };

function bodyBytes(body: string | Uint8Array): Buffer {
  return typeof body === 'string' ? Buffer.from(body, 'utf8') : Buffer.from(body);
}

function validTarget(target: DispatchLaunchIpcTarget): boolean {
  return Boolean(target.larkAppId)
    && !/[\r\n\0]/.test(target.larkAppId)
    && Number.isInteger(target.ipcPort)
    && target.ipcPort >= 1
    && target.ipcPort <= 65_535
    && B64URL_32_BYTES_RE.test(target.bootInstanceId);
}

function wireEqual(provided: string | undefined, expected: string): boolean {
  if (!provided || !B64URL_32_BYTES_RE.test(provided) || !B64URL_32_BYTES_RE.test(expected)) return false;
  return timingSafeEqual(Buffer.from(provided, 'base64url'), Buffer.from(expected, 'base64url'));
}

export function createDispatchLaunchIpcNonceStore(
  clock: DispatchLaunchIpcClock = dispatchLaunchIpcRealClock,
): DispatchLaunchIpcNonceStore {
  const entries = new Map<string, number>();
  const gc = (): void => {
    const now = clock.now();
    for (const [nonce, expiresAt] of entries) {
      if (expiresAt <= now) entries.delete(nonce);
    }
  };
  return {
    has(nonce) { gc(); return entries.has(nonce); },
    add(nonce, expiresAt) { entries.set(nonce, expiresAt); },
    size() { gc(); return entries.size; },
  };
}

function headerString(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return typeof value === 'string' ? value : undefined;
}

function isLoopback(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || Boolean(address?.endsWith('::ffff:127.0.0.1'));
}

async function readBoundedBody(
  req: IncomingMessage,
  maxBytes: number,
  timeoutMs: number,
): Promise<
  | { ok: true; bytes: Buffer }
  | { ok: false; reason: 'body_too_large' | 'body_length_mismatch' | 'body_read_timeout' | 'body_read_failed' }
> {
  const contentLength = headerString(req, 'content-length');
  const transferEncoding = headerString(req, 'transfer-encoding');
  if (contentLength !== undefined && transferEncoding !== undefined) {
    return { ok: false, reason: 'body_length_mismatch' };
  }
  let declaredLength: number | undefined;
  if (contentLength !== undefined) {
    if (!/^(?:0|[1-9][0-9]*)$/.test(contentLength)) {
      return { ok: false, reason: 'body_length_mismatch' };
    }
    declaredLength = Number(contentLength);
    if (declaredLength > maxBytes) return { ok: false, reason: 'body_too_large' };
  }
  const chunks: Buffer[] = [];
  let total = 0;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    req.destroy(new Error('dispatch launch IPC body read timeout'));
  }, timeoutMs);
  timer.unref?.();
  try {
    for await (const chunk of req) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      total += bytes.length;
      if (total > maxBytes) return { ok: false, reason: 'body_too_large' };
      chunks.push(bytes);
    }
  } catch {
    return { ok: false, reason: timedOut ? 'body_read_timeout' : 'body_read_failed' };
  } finally {
    clearTimeout(timer);
  }
  if (declaredLength !== undefined && declaredLength !== total) {
    return { ok: false, reason: 'body_length_mismatch' };
  }
  return { ok: true, bytes: Buffer.concat(chunks, total) };
}

function decodeUtf8Strict(bytes: Buffer): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** Exact request bytes, target identity and daemon boot are all in the HMAC audience. */
export function canonicalDispatchLaunchIpcMaterial(
  input: Omit<DispatchLaunchIpcSignInput, 'secret'>,
): string {
  const bodySha256 = createHash('sha256').update(bodyBytes(input.body)).digest('hex');
  return JSON.stringify([
    DISPATCH_LAUNCH_IPC_DOMAIN,
    input.timestamp,
    input.nonce,
    input.method.toUpperCase(),
    input.pathWithQuery,
    bodySha256,
    input.target.larkAppId,
    String(input.target.ipcPort),
    input.target.bootInstanceId,
  ]);
}

export function signDispatchLaunchIpcRequest(input: DispatchLaunchIpcSignInput): string {
  if (!input.secret) throw new Error('dispatch launch IPC secret is empty');
  if (!B64URL_32_BYTES_RE.test(input.nonce)) throw new Error('dispatch launch IPC nonce is invalid');
  if (!validTarget(input.target)) throw new Error('dispatch launch IPC target descriptor is invalid');
  return createHmac('sha256', input.secret)
    .update(canonicalDispatchLaunchIpcMaterial(input), 'utf8')
    .digest('base64url');
}

/**
 * Total cryptographic guard: malformed wire input is a normal false result,
 * never an exception. PR 2's route must additionally enforce timestamp window
 * and nonce replay state.
 */
export function verifyDispatchLaunchIpcRequestSignature(input: DispatchLaunchIpcSignInput & {
  signature: string | undefined;
}): boolean {
  if (!input.signature) return false;
  try {
    const expected = signDispatchLaunchIpcRequest(input);
    return wireEqual(input.signature, expected);
  } catch {
    return false;
  }
}

export function canonicalDispatchLaunchIpcResponseMaterial(
  input: Omit<DispatchLaunchIpcResponseSignInput, 'secret'>,
): string {
  const bodySha256 = createHash('sha256').update(bodyBytes(input.body)).digest('hex');
  return JSON.stringify([
    DISPATCH_LAUNCH_IPC_RESPONSE_DOMAIN,
    input.requestNonce,
    input.method.toUpperCase(),
    input.pathWithQuery,
    String(input.status),
    bodySha256,
    input.target.larkAppId,
    String(input.target.ipcPort),
    input.target.bootInstanceId,
  ]);
}

export function signDispatchLaunchIpcResponse(input: DispatchLaunchIpcResponseSignInput): string {
  if (!input.secret) throw new Error('dispatch launch IPC secret is empty');
  if (!B64URL_32_BYTES_RE.test(input.requestNonce)) throw new Error('dispatch launch IPC request nonce is invalid');
  if (!Number.isInteger(input.status) || input.status < 100 || input.status > 599) {
    throw new Error('dispatch launch IPC response status is invalid');
  }
  if (!validTarget(input.target)) throw new Error('dispatch launch IPC target descriptor is invalid');
  return createHmac('sha256', input.secret)
    .update(canonicalDispatchLaunchIpcResponseMaterial(input), 'utf8')
    .digest('base64url');
}

export function verifyDispatchLaunchIpcResponseSignature(input: DispatchLaunchIpcResponseSignInput & {
  signature: string | undefined;
}): boolean {
  if (!input.signature) return false;
  try {
    const expected = signDispatchLaunchIpcResponse(input);
    return wireEqual(input.signature, expected);
  } catch {
    return false;
  }
}

/** Read and authenticate an inbound request exactly once. */
export async function verifyDispatchLaunchIpcRequest(
  req: IncomingMessage,
  options: DispatchLaunchIpcVerifyOptions,
): Promise<DispatchLaunchIpcVerifyResult> {
  if (!isLoopback(req.socket?.remoteAddress)) {
    return { ok: false, reason: 'remote_not_loopback', httpStatus: 403 };
  }
  const timestamp = headerString(req, DISPATCH_LAUNCH_IPC_HEADERS.timestamp);
  const nonce = headerString(req, DISPATCH_LAUNCH_IPC_HEADERS.nonce);
  const signature = headerString(req, DISPATCH_LAUNCH_IPC_HEADERS.signature);
  if (!timestamp || !CANONICAL_EPOCH_MS_RE.test(timestamp) || String(Number(timestamp)) !== timestamp
      || !nonce || !B64URL_32_BYTES_RE.test(nonce)
      || !signature || !B64URL_32_BYTES_RE.test(signature)) {
    return { ok: false, reason: 'missing_or_malformed_header', httpStatus: 401 };
  }
  const clock = options.clock ?? dispatchLaunchIpcRealClock;
  if (Math.abs(clock.now() - Number(timestamp)) > DISPATCH_LAUNCH_IPC_TS_WINDOW_MS) {
    return { ok: false, reason: 'timestamp_out_of_window', httpStatus: 401 };
  }
  const target: DispatchLaunchIpcTarget = {
    ...options.target,
    ipcPort: typeof req.socket?.localPort === 'number' ? req.socket.localPort : 0,
  };
  if (!validTarget(target)) {
    return { ok: false, reason: 'target_identity_unavailable', httpStatus: 503 };
  }
  const read = await readBoundedBody(
    req,
    options.maxBodyBytes ?? DISPATCH_LAUNCH_IPC_BODY_LIMIT_BYTES,
    options.bodyReadTimeoutMs ?? DISPATCH_LAUNCH_IPC_BODY_READ_TIMEOUT_MS,
  );
  if (!read.ok) {
    return {
      ok: false,
      reason: read.reason,
      httpStatus: read.reason === 'body_too_large' ? 413 : read.reason === 'body_read_timeout' ? 408 : 400,
    };
  }
  const bodyRaw = decodeUtf8Strict(read.bytes);
  if (bodyRaw === null) return { ok: false, reason: 'body_not_utf8', httpStatus: 400 };
  if (options.nonceStore.has(nonce)) return { ok: false, reason: 'replay', httpStatus: 401 };
  if (!verifyDispatchLaunchIpcRequestSignature({
    secret: options.secret,
    timestamp,
    nonce,
    method: req.method ?? 'GET',
    pathWithQuery: req.url ?? '/',
    body: read.bytes,
    target,
    signature,
  })) {
    return { ok: false, reason: 'signature_mismatch', httpStatus: 401 };
  }
  options.nonceStore.add(nonce, clock.now() + DISPATCH_LAUNCH_IPC_NONCE_TTL_MS);
  return { ok: true, bodyRaw, nonce, target };
}

export function generateDispatchLaunchIpcNonce(): string {
  return randomBytes(32).toString('base64url');
}

export function loadDispatchLaunchIpcSecret(secretPath = dashboardSecretPath()): string {
  const secret = loadDashboardSecret(secretPath);
  if (!secret) throw new Error('dispatch launch IPC secret is unavailable');
  return secret;
}

export function dispatchLaunchIpcHeaders(input: {
  secret: string;
  method: string;
  pathWithQuery: string;
  bodyRaw: string;
  target: DispatchLaunchIpcTarget;
  timestamp?: string;
  nonce?: string;
}): Record<string, string> {
  const timestamp = input.timestamp ?? String(Date.now());
  const nonce = input.nonce ?? generateDispatchLaunchIpcNonce();
  const signature = signDispatchLaunchIpcRequest({
    secret: input.secret, timestamp, nonce, method: input.method,
    pathWithQuery: input.pathWithQuery, body: input.bodyRaw, target: input.target,
  });
  return {
    'X-Botmux-Dispatch-Launch-Ipc-Ts': timestamp,
    'X-Botmux-Dispatch-Launch-Ipc-Nonce': nonce,
    'X-Botmux-Dispatch-Launch-Ipc-Signature': signature,
  };
}
