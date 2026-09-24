import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  closeSync, constants as fsConstants, fstatSync, openSync, readSync, unlinkSync, writeSync,
} from 'node:fs';
import {
  ensureManagedOriginAttestationDirectory,
  managedOriginAttestationProofPath,
} from './managed-origin-capability.js';

const REQUEST_DOMAIN = 'botmux-native-subagent-runtime/v1/request';
const RESPONSE_DOMAIN = 'botmux-native-subagent-runtime/v1/response';
const TIMESTAMP_WINDOW_MS = 30_000;
const NONCE_TTL_MS = 60_000;
const NONCE_STORE_MAX_ENTRIES = 1_024;
const RESPONSE_PROOF_TTL_MS = 5_000;
const RESPONSE_PROOF_MAX_BYTES = 4 * 1024;
export const NATIVE_SUBAGENT_RUNTIME_RESPONSE_MAX_BYTES = 16 * 1024;
export const NATIVE_SUBAGENT_RUNTIME_RESPONSE_PROOF_TTL_MS = RESPONSE_PROOF_TTL_MS;

export const NATIVE_SUBAGENT_RUNTIME_IPC_HEADERS = {
  timestamp: 'x-botmux-native-runtime-ts',
  nonce: 'x-botmux-native-runtime-nonce',
  requestSignature: 'x-botmux-native-runtime-auth',
  responseSignature: 'x-botmux-native-runtime-response-auth',
  targetAppId: 'x-botmux-native-runtime-app',
  targetBootId: 'x-botmux-native-runtime-boot',
} as const;

const B64URL_32_BYTES_RE = /^[A-Za-z0-9_-]{43}$/;
const HEX_32_BYTES_RE = /^[a-f0-9]{64}$/;
const CANONICAL_EPOCH_MS_RE = /^(?:0|[1-9][0-9]{0,15})$/;

type HeaderSource = Headers | Record<string, string | string[] | undefined>;

export interface NativeSubagentRuntimeNonceStore {
  has(nonce: string): boolean;
  add(nonce: string, expiresAtMs: number, scope?: string): boolean;
  size(): number;
}

interface NativeSubagentRuntimeBinding {
  method: string;
  path: string;
  port: number;
  sessionId: string;
  larkAppId: string;
  bootInstanceId: string;
  turnId?: string;
  dispatchAttempt?: number;
}

interface NativeSubagentRuntimeResponseBinding extends NativeSubagentRuntimeBinding {
  requestNonce: string;
  status: number;
  body: string | Uint8Array;
}

function isLoopback(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || Boolean(address?.endsWith('::ffff:127.0.0.1'));
}

function isValidBinding(input: NativeSubagentRuntimeBinding): boolean {
  return Boolean(input.sessionId)
    && !/[\r\n\0]/.test(input.sessionId)
    && Boolean(input.larkAppId)
    && !/[\r\n\0]/.test(input.larkAppId)
    && B64URL_32_BYTES_RE.test(input.bootInstanceId)
    && !/[\r\n\0]/.test(input.path)
    && Number.isSafeInteger(input.port)
    && input.port >= 1
    && input.port <= 65_535
    && (input.turnId === undefined || (input.turnId.length > 0 && input.turnId.length <= 256))
    && (input.dispatchAttempt === undefined
      || (Number.isSafeInteger(input.dispatchAttempt) && input.dispatchAttempt > 0));
}

function headerValue(headers: HeaderSource, name: string): string | undefined {
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  const value = headers[name] ?? headers[name.toLowerCase()];
  return typeof value === 'string' ? value : undefined;
}

function timingSafeWireEqual(value: string | null | undefined, expected: string): boolean {
  if (!value || !B64URL_32_BYTES_RE.test(value) || !B64URL_32_BYTES_RE.test(expected)) return false;
  const left = Buffer.from(value, 'base64url');
  const right = Buffer.from(expected, 'base64url');
  return left.length === right.length && timingSafeEqual(left, right);
}

function canonicalCapabilityRequest(input: NativeSubagentRuntimeBinding & {
  timestamp: string;
  nonce: string;
}): string {
  return JSON.stringify([
    REQUEST_DOMAIN,
    input.timestamp,
    input.nonce,
    input.method.toUpperCase(),
    input.path,
    String(input.port),
    input.sessionId,
    input.larkAppId,
    input.bootInstanceId,
    input.turnId ?? null,
    input.dispatchAttempt ?? null,
  ]);
}

export function generateNativeSubagentRuntimeNonce(): string {
  return randomBytes(32).toString('hex');
}

export function createNativeSubagentRuntimeNonceStore(
  clock: { now(): number } = { now: () => Date.now() },
  maxEntries = NONCE_STORE_MAX_ENTRIES,
): NativeSubagentRuntimeNonceStore {
  const entries = new Map<string, { expiresAtMs: number; scope: string }>();
  const scopeCounts = new Map<string, number>();
  const gcOldest = (): void => {
    const now = clock.now();
    for (;;) {
      const oldest = entries.entries().next().value as [string, { expiresAtMs: number; scope: string }] | undefined;
      if (!oldest || oldest[1].expiresAtMs > now) break;
      entries.delete(oldest[0]);
      const scope = oldest[1].scope;
      const remaining = (scopeCounts.get(scope) ?? 1) - 1;
      if (remaining > 0) scopeCounts.set(scope, remaining);
      else scopeCounts.delete(scope);
    }
  };
  return {
    has(nonce) { gcOldest(); return entries.has(nonce); },
    add(nonce, expiresAtMs, scope = '') {
      gcOldest();
      if (entries.size >= Math.max(1, maxEntries) || (scopeCounts.get(scope) ?? 0) >= 64) return false;
      entries.set(nonce, { expiresAtMs, scope });
      scopeCounts.set(scope, (scopeCounts.get(scope) ?? 0) + 1);
      return true;
    },
    size() { gcOldest(); return entries.size; },
  };
}

export function nativeSubagentRuntimeHostChallengeHeaders(
  input: { larkAppId: string; bootInstanceId: string; nonce?: string },
): Record<string, string> {
  const nonce = input.nonce ?? generateNativeSubagentRuntimeNonce();
  if (!HEX_32_BYTES_RE.test(nonce)) throw new Error('native subagent runtime nonce is invalid');
  if (!input.larkAppId || /[\r\n\0]/.test(input.larkAppId)
    || !B64URL_32_BYTES_RE.test(input.bootInstanceId)) {
    throw new Error('native subagent runtime host target is invalid');
  }
  return {
    [NATIVE_SUBAGENT_RUNTIME_IPC_HEADERS.nonce]: nonce,
    [NATIVE_SUBAGENT_RUNTIME_IPC_HEADERS.targetAppId]: input.larkAppId,
    [NATIVE_SUBAGENT_RUNTIME_IPC_HEADERS.targetBootId]: input.bootInstanceId,
  };
}

export function nativeSubagentRuntimeHostRequestNonce(
  headers: HeaderSource,
  expected: { larkAppId: string; bootInstanceId: string },
): string | undefined {
  const nonce = nativeSubagentRuntimeRequestNonce(headers);
  return nonce
    && headerValue(headers, NATIVE_SUBAGENT_RUNTIME_IPC_HEADERS.targetAppId) === expected.larkAppId
    && headerValue(headers, NATIVE_SUBAGENT_RUNTIME_IPC_HEADERS.targetBootId) === expected.bootInstanceId
    ? nonce
    : undefined;
}

export function nativeSubagentRuntimeCapabilityHeaders(
  input: NativeSubagentRuntimeBinding & {
    capability: string;
    timestamp?: string;
    nonce?: string;
  },
): Record<string, string> {
  if (!input.capability || !isValidBinding(input)) {
    throw new Error('native subagent runtime capability request is invalid');
  }
  const timestamp = input.timestamp ?? String(Date.now());
  const nonce = input.nonce ?? generateNativeSubagentRuntimeNonce();
  if (!CANONICAL_EPOCH_MS_RE.test(timestamp) || !HEX_32_BYTES_RE.test(nonce)) {
    throw new Error('native subagent runtime request freshness fields are invalid');
  }
  const signature = createHmac('sha256', input.capability)
    .update(canonicalCapabilityRequest({ ...input, timestamp, nonce }), 'utf8')
    .digest('base64url');
  return {
    [NATIVE_SUBAGENT_RUNTIME_IPC_HEADERS.timestamp]: timestamp,
    [NATIVE_SUBAGENT_RUNTIME_IPC_HEADERS.nonce]: nonce,
    [NATIVE_SUBAGENT_RUNTIME_IPC_HEADERS.requestSignature]: signature,
  };
}

export type NativeSubagentRuntimeCapabilityVerifyResult =
  | { ok: true; nonce: string }
  | { ok: false; reason: 'remote_not_loopback' | 'missing_or_malformed_header' | 'timestamp_out_of_window' | 'signature_mismatch' | 'replay' | 'capacity_exceeded' };

export function verifyNativeSubagentRuntimeCapabilityRequest(
  input: NativeSubagentRuntimeBinding & {
    capability: string;
    headers: HeaderSource;
    remoteAddress?: string;
    nonceStore: NativeSubagentRuntimeNonceStore;
    nowMs?: number;
  },
): NativeSubagentRuntimeCapabilityVerifyResult {
  if (!isLoopback(input.remoteAddress)) return { ok: false, reason: 'remote_not_loopback' };
  const timestamp = headerValue(input.headers, NATIVE_SUBAGENT_RUNTIME_IPC_HEADERS.timestamp);
  const nonce = headerValue(input.headers, NATIVE_SUBAGENT_RUNTIME_IPC_HEADERS.nonce);
  const signature = headerValue(input.headers, NATIVE_SUBAGENT_RUNTIME_IPC_HEADERS.requestSignature);
  if (!timestamp || !CANONICAL_EPOCH_MS_RE.test(timestamp)
    || !nonce || !HEX_32_BYTES_RE.test(nonce)
    || !signature || !B64URL_32_BYTES_RE.test(signature)
    || !input.capability || !isValidBinding(input)) {
    return { ok: false, reason: 'missing_or_malformed_header' };
  }
  const nowMs = input.nowMs ?? Date.now();
  if (Math.abs(nowMs - Number(timestamp)) > TIMESTAMP_WINDOW_MS) {
    return { ok: false, reason: 'timestamp_out_of_window' };
  }
  const nonceKey = `${input.sessionId}\0${createHash('sha256').update(input.capability).digest('hex')}\0${nonce}`;
  if (input.nonceStore.has(nonceKey)) return { ok: false, reason: 'replay' };
  const expected = createHmac('sha256', input.capability)
    .update(canonicalCapabilityRequest({ ...input, timestamp, nonce }), 'utf8')
    .digest('base64url');
  if (!timingSafeWireEqual(signature, expected)) {
    return { ok: false, reason: 'signature_mismatch' };
  }
  if (!input.nonceStore.add(nonceKey, nowMs + NONCE_TTL_MS, input.sessionId)) {
    return { ok: false, reason: 'capacity_exceeded' };
  }
  return { ok: true, nonce };
}

export function nativeSubagentRuntimeRequestNonce(headers: HeaderSource): string | undefined {
  const nonce = headerValue(headers, NATIVE_SUBAGENT_RUNTIME_IPC_HEADERS.nonce);
  return nonce && HEX_32_BYTES_RE.test(nonce) ? nonce : undefined;
}

function canonicalResponse(input: NativeSubagentRuntimeResponseBinding): string {
  const digest = createHash('sha256')
    .update(typeof input.body === 'string' ? Buffer.from(input.body, 'utf8') : input.body)
    .digest('hex');
  const common: unknown[] = [
    RESPONSE_DOMAIN,
    input.requestNonce,
    input.method.toUpperCase(),
    input.path,
    String(input.port),
    String(input.status),
    digest,
    input.sessionId,
    input.larkAppId,
    input.bootInstanceId,
  ];
  common.push(input.turnId ?? null, input.dispatchAttempt ?? null);
  return JSON.stringify(common);
}

export function signNativeSubagentRuntimeResponse(
  input: NativeSubagentRuntimeResponseBinding & { key: string },
): string {
  if (!input.key || !HEX_32_BYTES_RE.test(input.requestNonce)
    || !Number.isInteger(input.status) || input.status < 100 || input.status > 599
    || !isValidBinding(input)) {
    throw new Error('native subagent runtime response binding is invalid');
  }
  return createHmac('sha256', input.key)
    .update(canonicalResponse(input), 'utf8')
    .digest('base64url');
}

interface NativeSubagentRuntimeResponseProof {
  domain: 'botmux-native-subagent-runtime/v1/host-proof';
  version: 1;
  nonce: string;
  channelId: string;
  issuedAtMs: number;
  responseMaterial: string;
}

function responseProofPath(dataDir: string, sessionId: string, channelId: string, nonce: string): string {
  return managedOriginAttestationProofPath(dataDir, sessionId, channelId, nonce);
}

export function writeNativeSubagentRuntimeResponseProof(input: {
  dataDir: string;
  channelId: string;
  nonce: string;
  issuedAtMs?: number;
  response: Omit<NativeSubagentRuntimeResponseBinding, 'requestNonce'>;
}): string {
  if (!HEX_32_BYTES_RE.test(input.nonce) || !/^[a-f0-9]{64}$/.test(input.channelId)
    || !isValidBinding(input.response)) {
    throw new Error('native subagent runtime response proof binding is invalid');
  }
  ensureManagedOriginAttestationDirectory(input.dataDir, input.response.sessionId, input.channelId);
  const path = responseProofPath(input.dataDir, input.response.sessionId, input.channelId, input.nonce);
  const proof: NativeSubagentRuntimeResponseProof = {
    domain: 'botmux-native-subagent-runtime/v1/host-proof',
    version: 1,
    nonce: input.nonce,
    channelId: input.channelId,
    issuedAtMs: input.issuedAtMs ?? Date.now(),
    responseMaterial: canonicalResponse({
      ...input.response,
      requestNonce: input.nonce,
    }),
  };
  const bytes = Buffer.from(JSON.stringify(proof), 'utf8');
  if (bytes.length > RESPONSE_PROOF_MAX_BYTES) throw new Error('native subagent runtime response proof too large');
  let fd: number | undefined;
  let created = false;
  try {
    fd = openSync(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL
      | (fsConstants.O_NOFOLLOW ?? 0), 0o600);
    created = true;
    const stat = fstatSync(fd);
    const expectedUid = process.getuid?.();
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600
      || (expectedUid !== undefined && stat.uid !== expectedUid)) {
      throw new Error('native subagent runtime response proof file is unsafe');
    }
    let offset = 0;
    while (offset < bytes.length) {
      const written = writeSync(fd, bytes, offset, bytes.length - offset, null);
      if (written <= 0) throw new Error('native subagent runtime response proof write made no progress');
      offset += written;
    }
    return path;
  } catch (error) {
    if (created) { try { unlinkSync(path); } catch { /* best effort */ } }
    throw error;
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* best effort */ } }
  }
}

export function readNativeSubagentRuntimeResponseProof(input: {
  dataDir: string;
  channelId: string;
  nonce: string;
  nowMs?: number;
  response: Omit<NativeSubagentRuntimeResponseBinding, 'requestNonce'>;
}): boolean {
  if (!HEX_32_BYTES_RE.test(input.nonce) || !/^[a-f0-9]{64}$/.test(input.channelId)
    || !isValidBinding(input.response)) return false;
  const path = responseProofPath(input.dataDir, input.response.sessionId, input.channelId, input.nonce);
  let fd: number | undefined;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | fsConstants.O_NONBLOCK);
    const stat = fstatSync(fd);
    const expectedUid = process.getuid?.();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size <= 0 || stat.size > RESPONSE_PROOF_MAX_BYTES
      || (stat.mode & 0o777) !== 0o600
      || (expectedUid !== undefined && stat.uid !== expectedUid)) return false;
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = readSync(fd, bytes, offset, bytes.length - offset, null);
      if (read <= 0) return false;
      offset += read;
    }
    const proof = JSON.parse(bytes.toString('utf8')) as Partial<NativeSubagentRuntimeResponseProof>;
    const nowMs = input.nowMs ?? Date.now();
    const expectedMaterial = canonicalResponse({
      ...input.response,
      requestNonce: input.nonce,
    });
    return proof.domain === 'botmux-native-subagent-runtime/v1/host-proof'
      && proof.version === 1
      && proof.nonce === input.nonce
      && proof.channelId === input.channelId
      && typeof proof.issuedAtMs === 'number'
      && proof.issuedAtMs <= nowMs + 1_000
      && nowMs - proof.issuedAtMs <= RESPONSE_PROOF_TTL_MS
      && proof.responseMaterial === expectedMaterial;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* best effort */ } }
  }
}

export function verifyNativeSubagentRuntimeResponse(
  input: NativeSubagentRuntimeResponseBinding & { key: string; signature: string | null | undefined },
): boolean {
  let expected: string;
  try { expected = signNativeSubagentRuntimeResponse(input); }
  catch { return false; }
  return timingSafeWireEqual(input.signature, expected);
}

export class NativeSubagentRuntimeResponseReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NativeSubagentRuntimeResponseReadError';
  }
}

/** Consume a policy response without ever retaining more than the configured
 * byte bound. Cancellation tears down the loopback socket through loopbackFetch. */
export async function readBoundedNativeSubagentRuntimeResponse(
  response: Response,
  options: { maxBytes?: number; signal?: AbortSignal } = {},
): Promise<string> {
  const maxBytes = options.maxBytes ?? NATIVE_SUBAGENT_RUNTIME_RESPONSE_MAX_BYTES;
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null) {
    if (!/^(?:0|[1-9][0-9]*)$/.test(contentLength) || Number(contentLength) > maxBytes) {
      void response.body?.cancel().catch(() => {});
      throw new NativeSubagentRuntimeResponseReadError('native subagent runtime response too large');
    }
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const onAbort = () => { void reader.cancel(options.signal?.reason).catch(() => {}); };
  options.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    for (;;) {
      if (options.signal?.aborted) throw options.signal.reason;
      const { done, value } = await reader.read();
      if (options.signal?.aborted) throw options.signal.reason;
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        void reader.cancel().catch(() => {});
        throw new NativeSubagentRuntimeResponseReadError('native subagent runtime response too large');
      }
      chunks.push(value);
    }
  } finally {
    options.signal?.removeEventListener('abort', onAbort);
  }
  const bytes = Buffer.allocUnsafe(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new NativeSubagentRuntimeResponseReadError('native subagent runtime response is not UTF-8'); }
}
