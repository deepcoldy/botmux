/**
 * Workflow v3 daemon-mutation IPC authentication.
 *
 * This protocol deliberately has its own domain and headers.  The historical
 * dashboard CLI HMAC signs only `ts:nonce`; accepting it here would let a
 * credential captured for another local route be replayed against workflow
 * start/retry/grant/cancel.  A v1 credential is instead bound to the exact
 * request bytes and one daemon boot:
 *
 *   [domain, ts, nonce, METHOD, raw req.url, sha256(body), appId, port, bootId]
 *
 * The JSON-array encoding is unambiguous even if a future field contains a
 * newline.  `bootInstanceId` is public audience data, not a secret; including
 * it makes every credential invalid immediately after a daemon restart even
 * when the process reuses the same port and the nonce cache starts empty.
 * The HMAC key remains the established 0600 `.dashboard-secret`: putting a
 * per-boot key in the public discovery descriptor would hand the capability to
 * the exact port-only local process this boundary is intended to reject.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

import { dashboardSecretPath } from '../../core/dashboard-secret.js';
import { loadDashboardSecret } from '../../dashboard/auth.js';

export const WORKFLOW_DAEMON_IPC_DOMAIN = 'botmux-workflow-daemon-ipc/v1';
export const WORKFLOW_DAEMON_IPC_RESPONSE_DOMAIN = 'botmux-workflow-daemon-ipc/v1/response';
/** Dedicated namespace unknown to pre-v1 daemons; never reuse legacy mutation paths. */
export const WORKFLOW_DAEMON_IPC_ROUTE_PREFIX = '/__workflow-ipc/v1/runs';
export const WORKFLOW_DAEMON_IPC_TS_WINDOW_MS = 60_000;
export const WORKFLOW_DAEMON_IPC_NONCE_TTL_MS = 10 * 60_000;
export const WORKFLOW_DAEMON_IPC_BODY_LIMIT_BYTES = 16 * 1024;
export const WORKFLOW_DAEMON_IPC_BODY_READ_TIMEOUT_MS = 5_000;

export const WORKFLOW_DAEMON_IPC_HEADERS = {
  timestamp: 'x-botmux-workflow-ipc-ts',
  nonce: 'x-botmux-workflow-ipc-nonce',
  signature: 'x-botmux-workflow-ipc-signature',
  responseSignature: 'x-botmux-workflow-ipc-response-signature',
} as const;

const B64URL_32_BYTES_RE = /^[A-Za-z0-9_-]{43}$/;
const CANONICAL_EPOCH_MS_RE = /^(?:0|[1-9][0-9]{0,15})$/;

export interface WorkflowDaemonIpcTarget {
  larkAppId: string;
  ipcPort: number;
  bootInstanceId: string;
}

export interface WorkflowDaemonIpcClock {
  now(): number;
}

export interface WorkflowDaemonIpcNonceStore {
  has(nonce: string): boolean;
  add(nonce: string, expiresAt: number): void;
  size(): number;
}

export type WorkflowDaemonIpcVerifyReason =
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

export type WorkflowDaemonIpcVerifyResult =
  | { ok: true; bodyRaw: string; nonce: string; target: WorkflowDaemonIpcTarget }
  | { ok: false; reason: WorkflowDaemonIpcVerifyReason; httpStatus: number };

export interface WorkflowDaemonIpcSignInput {
  secret: string;
  timestamp: string;
  nonce: string;
  method: string;
  pathWithQuery: string;
  body: string | Uint8Array;
  target: WorkflowDaemonIpcTarget;
}

export interface WorkflowDaemonIpcResponseSignInput {
  secret: string;
  requestNonce: string;
  method: string;
  pathWithQuery: string;
  status: number;
  body: string | Uint8Array;
  target: WorkflowDaemonIpcTarget;
}

export interface WorkflowDaemonIpcVerifyOptions {
  secret: string;
  target: Omit<WorkflowDaemonIpcTarget, 'ipcPort'>;
  nonceStore: WorkflowDaemonIpcNonceStore;
  clock?: WorkflowDaemonIpcClock;
  maxBodyBytes?: number;
  bodyReadTimeoutMs?: number;
}

export const workflowDaemonIpcRealClock: WorkflowDaemonIpcClock = { now: () => Date.now() };

function bodyBytes(body: string | Uint8Array): Buffer {
  return typeof body === 'string' ? Buffer.from(body, 'utf8') : Buffer.from(body);
}

function isValidTarget(target: WorkflowDaemonIpcTarget): boolean {
  return Boolean(target.larkAppId) &&
    !/[\r\n\0]/.test(target.larkAppId) &&
    Number.isInteger(target.ipcPort) &&
    target.ipcPort >= 1 &&
    target.ipcPort <= 65_535 &&
    B64URL_32_BYTES_RE.test(target.bootInstanceId);
}

/** Canonical bytes covered by the v1 HMAC. Exported for golden tests/audits. */
export function canonicalWorkflowDaemonIpcMaterial(
  input: Omit<WorkflowDaemonIpcSignInput, 'secret'>,
): string {
  const bytes = bodyBytes(input.body);
  const bodySha256 = createHash('sha256').update(bytes).digest('hex');
  return JSON.stringify([
    WORKFLOW_DAEMON_IPC_DOMAIN,
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

export function signWorkflowDaemonIpcRequest(input: WorkflowDaemonIpcSignInput): string {
  if (!input.secret) throw new Error('workflow daemon IPC secret is empty');
  if (!isValidTarget(input.target)) throw new Error('workflow daemon IPC target descriptor is invalid');
  const material = canonicalWorkflowDaemonIpcMaterial(input);
  return createHmac('sha256', input.secret).update(material, 'utf8').digest('base64url');
}

export function canonicalWorkflowDaemonIpcResponseMaterial(
  input: Omit<WorkflowDaemonIpcResponseSignInput, 'secret'>,
): string {
  const responseSha256 = createHash('sha256').update(bodyBytes(input.body)).digest('hex');
  return JSON.stringify([
    WORKFLOW_DAEMON_IPC_RESPONSE_DOMAIN,
    input.requestNonce,
    input.method.toUpperCase(),
    input.pathWithQuery,
    String(input.status),
    responseSha256,
    input.target.larkAppId,
    String(input.target.ipcPort),
    input.target.bootInstanceId,
  ]);
}

export function signWorkflowDaemonIpcResponse(input: WorkflowDaemonIpcResponseSignInput): string {
  if (!input.secret) throw new Error('workflow daemon IPC secret is empty');
  if (!B64URL_32_BYTES_RE.test(input.requestNonce)) {
    throw new Error('workflow daemon IPC request nonce is invalid');
  }
  if (!Number.isInteger(input.status) || input.status < 100 || input.status > 599) {
    throw new Error('workflow daemon IPC response status is invalid');
  }
  if (!isValidTarget(input.target)) throw new Error('workflow daemon IPC target descriptor is invalid');
  return createHmac('sha256', input.secret)
    .update(canonicalWorkflowDaemonIpcResponseMaterial(input), 'utf8')
    .digest('base64url');
}

export function verifyWorkflowDaemonIpcResponse(input: WorkflowDaemonIpcResponseSignInput & {
  signature: string | null | undefined;
}): boolean {
  if (!input.signature) return false;
  const expected = signWorkflowDaemonIpcResponse(input);
  return timingSafeWireEqual(input.signature, expected);
}

export function createWorkflowDaemonIpcNonceStore(
  clock: WorkflowDaemonIpcClock = workflowDaemonIpcRealClock,
): WorkflowDaemonIpcNonceStore {
  const entries = new Map<string, number>();
  const gc = (): void => {
    const now = clock.now();
    for (const [nonce, expiresAt] of entries) {
      if (expiresAt <= now) entries.delete(nonce);
    }
  };
  return {
    has(nonce: string): boolean {
      gc();
      return entries.has(nonce);
    },
    add(nonce: string, expiresAt: number): void {
      entries.set(nonce, expiresAt);
    },
    size(): number {
      gc();
      return entries.size;
    },
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
    req.destroy(new Error('workflow daemon IPC body read timeout'));
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

function timingSafeWireEqual(wire: string, expectedWire: string): boolean {
  if (!B64URL_32_BYTES_RE.test(wire) || !B64URL_32_BYTES_RE.test(expectedWire)) return false;
  const provided = Buffer.from(wire, 'base64url');
  const expected = Buffer.from(expectedWire, 'base64url');
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

/**
 * Authenticate one inbound Workflow daemon mutation. The request body is read
 * exactly once here and returned to the route; handlers must never read `req`.
 */
export async function verifyWorkflowDaemonIpcRequest(
  req: IncomingMessage,
  options: WorkflowDaemonIpcVerifyOptions,
): Promise<WorkflowDaemonIpcVerifyResult> {
  if (!isLoopback(req.socket?.remoteAddress)) {
    return { ok: false, reason: 'remote_not_loopback', httpStatus: 403 };
  }

  const timestamp = headerString(req, WORKFLOW_DAEMON_IPC_HEADERS.timestamp);
  const nonce = headerString(req, WORKFLOW_DAEMON_IPC_HEADERS.nonce);
  const signature = headerString(req, WORKFLOW_DAEMON_IPC_HEADERS.signature);
  if (
    !timestamp || !CANONICAL_EPOCH_MS_RE.test(timestamp) || String(Number(timestamp)) !== timestamp ||
    !nonce || !B64URL_32_BYTES_RE.test(nonce) ||
    !signature || !B64URL_32_BYTES_RE.test(signature)
  ) {
    return { ok: false, reason: 'missing_or_malformed_header', httpStatus: 401 };
  }

  const clock = options.clock ?? workflowDaemonIpcRealClock;
  const timestampMs = Number(timestamp);
  if (Math.abs(clock.now() - timestampMs) > WORKFLOW_DAEMON_IPC_TS_WINDOW_MS) {
    return { ok: false, reason: 'timestamp_out_of_window', httpStatus: 401 };
  }

  const localPort = req.socket?.localPort;
  const target: WorkflowDaemonIpcTarget = {
    ...options.target,
    ipcPort: typeof localPort === 'number' ? localPort : 0,
  };
  if (!isValidTarget(target)) {
    return { ok: false, reason: 'target_identity_unavailable', httpStatus: 503 };
  }

  const read = await readBoundedBody(
    req,
    options.maxBodyBytes ?? WORKFLOW_DAEMON_IPC_BODY_LIMIT_BYTES,
    options.bodyReadTimeoutMs ?? WORKFLOW_DAEMON_IPC_BODY_READ_TIMEOUT_MS,
  );
  if (!read.ok) {
    return {
      ok: false,
      reason: read.reason,
      httpStatus: read.reason === 'body_too_large'
        ? 413
        : read.reason === 'body_read_timeout' ? 408 : 400,
    };
  }
  const bodyRaw = decodeUtf8Strict(read.bytes);
  if (bodyRaw === null) return { ok: false, reason: 'body_not_utf8', httpStatus: 400 };

  // No await may occur between nonce lookup and insert. Concurrent requests
  // with the same nonce therefore have exactly one winner in this process.
  if (options.nonceStore.has(nonce)) {
    return { ok: false, reason: 'replay', httpStatus: 401 };
  }
  const expected = signWorkflowDaemonIpcRequest({
    secret: options.secret,
    timestamp,
    nonce,
    method: req.method ?? 'GET',
    pathWithQuery: req.url ?? '/',
    body: read.bytes,
    target,
  });
  if (!timingSafeWireEqual(signature, expected)) {
    return { ok: false, reason: 'signature_mismatch', httpStatus: 401 };
  }
  options.nonceStore.add(nonce, clock.now() + WORKFLOW_DAEMON_IPC_NONCE_TTL_MS);
  return { ok: true, bodyRaw, nonce, target };
}

export function generateWorkflowDaemonBootInstanceId(): string {
  return randomBytes(32).toString('base64url');
}

export function generateWorkflowDaemonIpcNonce(): string {
  return randomBytes(32).toString('base64url');
}

export function defaultWorkflowDaemonIpcSecretPath(): string {
  return dashboardSecretPath();
}

export function loadWorkflowDaemonIpcSecret(secretPath = defaultWorkflowDaemonIpcSecretPath()): string {
  const secret = loadDashboardSecret(secretPath);
  if (!secret) {
    throw new Error('缺少 .dashboard-secret；请协调重启全部 botmux daemon 与 dashboard 后重试');
  }
  return secret;
}

export function workflowDaemonIpcHeaders(input: {
  secret: string;
  method: string;
  pathWithQuery: string;
  bodyRaw: string;
  target: WorkflowDaemonIpcTarget;
  timestamp?: string;
  nonce?: string;
}): Record<string, string> {
  const timestamp = input.timestamp ?? String(Date.now());
  const nonce = input.nonce ?? generateWorkflowDaemonIpcNonce();
  const signature = signWorkflowDaemonIpcRequest({
    secret: input.secret,
    timestamp,
    nonce,
    method: input.method,
    pathWithQuery: input.pathWithQuery,
    body: input.bodyRaw,
    target: input.target,
  });
  return {
    'X-Botmux-Workflow-Ipc-Ts': timestamp,
    'X-Botmux-Workflow-Ipc-Nonce': nonce,
    'X-Botmux-Workflow-Ipc-Signature': signature,
  };
}
