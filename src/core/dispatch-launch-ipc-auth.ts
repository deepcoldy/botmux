import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const DISPATCH_LAUNCH_IPC_DOMAIN = 'botmux-dispatch-launch-ipc/v1';
export const DISPATCH_LAUNCH_IPC_RESPONSE_DOMAIN = 'botmux-dispatch-launch-ipc/v1/response';
export const DISPATCH_LAUNCH_IPC_ROUTE_PREFIX = '/__dispatch-launch-ipc/v1/operations';
export const DISPATCH_LAUNCH_IPC_TS_WINDOW_MS = 60_000;
export const DISPATCH_LAUNCH_IPC_NONCE_TTL_MS = 10 * 60_000;
export const DISPATCH_LAUNCH_IPC_BODY_LIMIT_BYTES = 80 * 1024;
export const DISPATCH_LAUNCH_IPC_HEADERS = {
  timestamp: 'x-botmux-dispatch-launch-ipc-ts',
  nonce: 'x-botmux-dispatch-launch-ipc-nonce',
  signature: 'x-botmux-dispatch-launch-ipc-signature',
  responseSignature: 'x-botmux-dispatch-launch-ipc-response-signature',
} as const;

const B64URL_32_BYTES_RE = /^[A-Za-z0-9_-]{43}$/;

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

/** Cryptographic check only; PR 2's route must additionally enforce time window and nonce replay state. */
export function verifyDispatchLaunchIpcRequestSignature(input: DispatchLaunchIpcSignInput & {
  signature: string | undefined;
}): boolean {
  if (!input.signature) return false;
  const expected = signDispatchLaunchIpcRequest(input);
  return wireEqual(input.signature, expected);
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
  const expected = signDispatchLaunchIpcResponse(input);
  return wireEqual(input.signature, expected);
}
