import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import type { SessionTurnReply } from '../services/session-turns.js';

/**
 * Wire protection for the sandbox-only structured-reply relay.
 *
 * A loopback port can be rebound by another sandboxed process while a daemon
 * restarts. The relay therefore never transmits the bearer capability itself,
 * nor a plaintext reply body. Either the live turn capability or the host IPC
 * secret acts only as local key material:
 *
 * - request HMAC authenticates session/turn/attempt, a random nonce and the
 *   SHA-256 of the sealed body BEFORE the daemon reads that body;
 * - AES-256-GCM keeps the reply text confidential from every listener and
 *   binds decryption to the same request tuple;
 * - response HMAC authenticates status + exact response bytes, so an unrelated
 *   listener cannot forge either a success or a terminal error.
 *
 * The nonce is random per batch attempt. Reusing an encrypted request across
 * candidate ports is safe: a listener without the key cannot read, alter,
 * replay-forge, or acknowledge it. The daemon's live-origin and post-read
 * revalidation remain the authority for settling the write.
 */

export const RELAYED_TURN_REPLY_CRYPTO_VERSION = 1;
export const RELAYED_TURN_REPLY_RESPONSE_MAX_BYTES = 64 * 1024;
export const RELAYED_TURN_REPLY_HEADERS = {
  keyKind: 'x-botmux-turn-reply-key-kind',
  turnId: 'x-botmux-origin-turn-id',
  dispatchAttempt: 'x-botmux-origin-dispatch-attempt',
  requestNonce: 'x-botmux-turn-reply-request-nonce',
  payloadSha256: 'x-botmux-turn-reply-payload-sha256',
  requestProof: 'x-botmux-turn-reply-request-proof',
  responseProof: 'x-botmux-turn-reply-response-proof',
} as const;

export type RelayedTurnReplyKeyKind = 'capability' | 'host';

export interface RelayedTurnReplyKey {
  kind: RelayedTurnReplyKeyKind;
  material: string;
}

export interface RelayedTurnReplyRequestAuth {
  keyKind: RelayedTurnReplyKeyKind;
  turnId: string;
  dispatchAttempt?: number;
  requestNonce: string;
  payloadSha256: string;
  requestProof: string;
}

export interface RelayedTurnReplyWireBody {
  version: 1;
  requestNonce: string;
  sealed: string;
}

export interface RelayedTurnReplyPlaintext {
  expectedTurnId: string;
  replies: SessionTurnReply[];
}

const HEX_32_BYTES_RE = /^[a-f0-9]{64}$/;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;
const REQUEST_DOMAIN = 'botmux.turn-reply/request-v1';
const ENCRYPTION_DOMAIN = 'botmux.turn-reply/encryption-v1';
const RESPONSE_DOMAIN = 'botmux.turn-reply/response-v1';

function safeWireEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

function validRequestTuple(input: {
  key: RelayedTurnReplyKey;
  sessionId: string;
  turnId: string;
  dispatchAttempt?: number;
  requestNonce: string;
  payloadSha256: string;
}): boolean {
  return !!input.key.material
    && (input.key.kind === 'capability' || input.key.kind === 'host')
    && !!input.sessionId && input.sessionId.length <= 512
    && !!input.turnId && input.turnId.length <= 256 && !input.turnId.includes('\0')
    && (input.dispatchAttempt === undefined
      || (Number.isSafeInteger(input.dispatchAttempt) && input.dispatchAttempt > 0))
    && HEX_32_BYTES_RE.test(input.requestNonce)
    && HEX_32_BYTES_RE.test(input.payloadSha256);
}

function canonicalRequest(input: {
  keyKind: RelayedTurnReplyKeyKind;
  sessionId: string;
  turnId: string;
  dispatchAttempt?: number;
  requestNonce: string;
  payloadSha256: string;
}): string {
  return JSON.stringify([
    REQUEST_DOMAIN,
    input.keyKind,
    input.sessionId,
    input.turnId,
    input.dispatchAttempt ?? null,
    input.requestNonce,
    input.payloadSha256,
  ]);
}

function canonicalEncryption(input: {
  keyKind: RelayedTurnReplyKeyKind;
  sessionId: string;
  turnId: string;
  dispatchAttempt?: number;
  requestNonce: string;
}): string {
  return JSON.stringify([
    ENCRYPTION_DOMAIN,
    input.keyKind,
    input.sessionId,
    input.turnId,
    input.dispatchAttempt ?? null,
    input.requestNonce,
  ]);
}

function encryptionKey(input: {
  key: RelayedTurnReplyKey;
  sessionId: string;
  turnId: string;
  dispatchAttempt?: number;
}): Buffer {
  return createHmac('sha256', input.key.material)
    .update(JSON.stringify([
      ENCRYPTION_DOMAIN,
      input.key.kind,
      input.sessionId,
      input.turnId,
      input.dispatchAttempt ?? null,
    ]), 'utf8')
    .digest();
}

function requestProof(input: {
  key: RelayedTurnReplyKey;
  sessionId: string;
  auth: Omit<RelayedTurnReplyRequestAuth, 'requestProof'>;
}): string {
  return createHmac('sha256', input.key.material)
    .update(canonicalRequest({
      keyKind: input.key.kind,
      sessionId: input.sessionId,
      turnId: input.auth.turnId,
      dispatchAttempt: input.auth.dispatchAttempt,
      requestNonce: input.auth.requestNonce,
      payloadSha256: input.auth.payloadSha256,
    }), 'utf8')
    .digest('hex');
}

export function sealRelayedTurnReplyRequest(input: {
  key: RelayedTurnReplyKey;
  sessionId: string;
  payload: RelayedTurnReplyPlaintext;
  dispatchAttempt?: number;
  nonce?: string;
}): {
  body: RelayedTurnReplyWireBody;
  headers: Record<string, string>;
  auth: RelayedTurnReplyRequestAuth;
} {
  const requestNonce = input.nonce ?? randomBytes(32).toString('hex');
  const turnId = input.payload.expectedTurnId;
  const tuple = {
    key: input.key,
    sessionId: input.sessionId,
    turnId,
    dispatchAttempt: input.dispatchAttempt,
    requestNonce,
  };
  if (!validRequestTuple({ ...tuple, payloadSha256: '0'.repeat(64) })) {
    throw new Error('Invalid relayed turn-reply request identity');
  }
  const plaintext = Buffer.from(JSON.stringify(input.payload), 'utf8');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(tuple), iv);
  cipher.setAAD(Buffer.from(canonicalEncryption({
    keyKind: input.key.kind,
    sessionId: input.sessionId,
    turnId,
    dispatchAttempt: input.dispatchAttempt,
    requestNonce,
  }), 'utf8'));
  const sealedBytes = Buffer.concat([
    iv,
    cipher.update(plaintext),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  const sealed = sealedBytes.toString('base64url');
  const payloadSha256 = createHash('sha256').update(sealedBytes).digest('hex');
  const authWithoutProof = {
    keyKind: input.key.kind,
    turnId,
    ...(input.dispatchAttempt !== undefined ? { dispatchAttempt: input.dispatchAttempt } : {}),
    requestNonce,
    payloadSha256,
  } as const;
  const auth: RelayedTurnReplyRequestAuth = {
    ...authWithoutProof,
    requestProof: requestProof({ key: input.key, sessionId: input.sessionId, auth: authWithoutProof }),
  };
  return {
    body: { version: RELAYED_TURN_REPLY_CRYPTO_VERSION, requestNonce, sealed },
    auth,
    headers: {
      [RELAYED_TURN_REPLY_HEADERS.keyKind]: auth.keyKind,
      [RELAYED_TURN_REPLY_HEADERS.turnId]: auth.turnId,
      ...(auth.dispatchAttempt !== undefined
        ? { [RELAYED_TURN_REPLY_HEADERS.dispatchAttempt]: String(auth.dispatchAttempt) }
        : {}),
      [RELAYED_TURN_REPLY_HEADERS.requestNonce]: auth.requestNonce,
      [RELAYED_TURN_REPLY_HEADERS.payloadSha256]: auth.payloadSha256,
      [RELAYED_TURN_REPLY_HEADERS.requestProof]: auth.requestProof,
    },
  };
}

export function verifyRelayedTurnReplyRequestProof(input: {
  key: RelayedTurnReplyKey;
  sessionId: string;
  auth: Partial<RelayedTurnReplyRequestAuth>;
}): boolean {
  try {
    const { auth } = input;
    if (!auth.turnId || !auth.requestNonce || !auth.payloadSha256 || !auth.requestProof
      || auth.keyKind !== input.key.kind) return false;
    const tuple = {
      key: input.key,
      sessionId: input.sessionId,
      turnId: auth.turnId,
      dispatchAttempt: auth.dispatchAttempt,
      requestNonce: auth.requestNonce,
      payloadSha256: auth.payloadSha256,
    };
    if (!validRequestTuple(tuple)) return false;
    const expected = requestProof({ key: input.key, sessionId: input.sessionId, auth: {
      keyKind: input.key.kind,
      turnId: auth.turnId,
      ...(auth.dispatchAttempt !== undefined ? { dispatchAttempt: auth.dispatchAttempt } : {}),
      requestNonce: auth.requestNonce,
      payloadSha256: auth.payloadSha256,
    } });
    return safeWireEqual(auth.requestProof, expected);
  } catch {
    return false;
  }
}

export function openRelayedTurnReplyRequest(input: {
  key: RelayedTurnReplyKey;
  sessionId: string;
  auth: RelayedTurnReplyRequestAuth;
  body: unknown;
}): RelayedTurnReplyPlaintext | undefined {
  try {
    if (!input.body || typeof input.body !== 'object' || Array.isArray(input.body)) return undefined;
    const body = input.body as Partial<RelayedTurnReplyWireBody>;
    if (body.version !== RELAYED_TURN_REPLY_CRYPTO_VERSION
      || body.requestNonce !== input.auth.requestNonce
      || typeof body.sealed !== 'string'
      || !BASE64URL_RE.test(body.sealed)) return undefined;
    const sealedBytes = Buffer.from(body.sealed, 'base64url');
    if (sealedBytes.length < 29 || sealedBytes.toString('base64url') !== body.sealed) return undefined;
    const payloadSha256 = createHash('sha256').update(sealedBytes).digest('hex');
    if (!safeWireEqual(payloadSha256, input.auth.payloadSha256)) return undefined;
    const tuple = {
      key: input.key,
      sessionId: input.sessionId,
      turnId: input.auth.turnId,
      dispatchAttempt: input.auth.dispatchAttempt,
      requestNonce: input.auth.requestNonce,
    };
    const iv = sealedBytes.subarray(0, 12);
    const ciphertext = sealedBytes.subarray(12, sealedBytes.length - 16);
    const tag = sealedBytes.subarray(sealedBytes.length - 16);
    const decipher = createDecipheriv('aes-256-gcm', encryptionKey(tuple), iv);
    decipher.setAAD(Buffer.from(canonicalEncryption({
      keyKind: input.key.kind,
      sessionId: input.sessionId,
      turnId: input.auth.turnId,
      dispatchAttempt: input.auth.dispatchAttempt,
      requestNonce: input.auth.requestNonce,
    }), 'utf8'));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    const parsed = JSON.parse(plaintext) as Partial<RelayedTurnReplyPlaintext>;
    if (!parsed || parsed.expectedTurnId !== input.auth.turnId || !Array.isArray(parsed.replies)) {
      return undefined;
    }
    return { expectedTurnId: parsed.expectedTurnId, replies: parsed.replies as SessionTurnReply[] };
  } catch {
    return undefined;
  }
}

function canonicalResponse(input: {
  keyKind: RelayedTurnReplyKeyKind;
  sessionId: string;
  turnId: string;
  dispatchAttempt?: number;
  requestNonce: string;
  status: number;
  raw: string;
}): string {
  return JSON.stringify([
    RESPONSE_DOMAIN,
    input.keyKind,
    input.sessionId,
    input.turnId,
    input.dispatchAttempt ?? null,
    input.requestNonce,
    input.status,
    createHash('sha256').update(input.raw, 'utf8').digest('hex'),
  ]);
}

export function signRelayedTurnReplyResponse(input: {
  key: RelayedTurnReplyKey;
  sessionId: string;
  turnId: string;
  dispatchAttempt?: number;
  requestNonce: string;
  status: number;
  raw: string;
}): string {
  if (!input.key.material || !HEX_32_BYTES_RE.test(input.requestNonce)
    || !Number.isSafeInteger(input.status) || input.status < 100 || input.status > 599) {
    throw new Error('Invalid relayed turn-reply response identity');
  }
  return createHmac('sha256', input.key.material)
    .update(canonicalResponse({ ...input, keyKind: input.key.kind }), 'utf8')
    .digest('hex');
}

export function verifyRelayedTurnReplyResponse(input: {
  key: RelayedTurnReplyKey;
  sessionId: string;
  turnId: string;
  dispatchAttempt?: number;
  requestNonce: string;
  status: number;
  raw: string;
  signature: string | null;
}): boolean {
  try {
    if (!input.signature || !HEX_32_BYTES_RE.test(input.signature)) return false;
    const expected = signRelayedTurnReplyResponse(input);
    return safeWireEqual(input.signature, expected);
  } catch {
    return false;
  }
}
