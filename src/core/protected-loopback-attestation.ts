import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import type { ProcessIdentity } from './current-actor-attestation.js';

export const PROTECTED_LOOPBACK_ATTESTATION_HEADER = 'x-botmux-loopback-attestation';
export const PROTECTED_LOOPBACK_PEER_PID_HEADER = 'x-botmux-loopback-peer-pid';
export const PROTECTED_LOOPBACK_PEER_START_HEADER = 'x-botmux-loopback-peer-start';
export const PROTECTED_LOOPBACK_ATTESTATION_SCHEMA = 'botmux.protected-loopback-attestation.v1' as const;

const TOKEN_PART = /^[A-Za-z0-9_-]+$/;
const SECRET = /^[a-f0-9]{64}$/;
const IDENTIFIER = /^[A-Za-z0-9._:-]{1,512}$/;
const SERVICE_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const METHOD = /^[!#$%&'*+\-.^_`|~0-9A-Z]+$/;
const PROC_START = /^\d{1,64}$/;
const NONCE = /^[a-f0-9]{32}$/;
const MAX_AGE_MS = 10_000;

interface ProtectedLoopbackAttestationPayload {
  schema: typeof PROTECTED_LOOPBACK_ATTESTATION_SCHEMA;
  sessionId: string;
  serviceId: string;
  workerGeneration: number;
  turnId?: string;
  dispatchAttempt?: number;
  peerPid: number;
  peerProcStart: string;
  method: string;
  path: string;
  headersDigest: string;
  bodyDigest: string;
  issuedAtMs: number;
  nonce: string;
}

export interface ProtectedLoopbackAttestationRequest {
  sessionId: string;
  serviceId: string;
  workerGeneration: number;
  turnId?: string;
  dispatchAttempt?: number;
  peer: ProcessIdentity;
  method: string;
  path: string;
  headers: Readonly<Record<string, string>>;
  body: Buffer;
  issuedAtMs?: number;
  nonce?: string;
}

export interface ProtectedLoopbackAttestationExpectation {
  sessionId: string;
  serviceId: string;
  workerGeneration: number;
  turnId?: string;
  dispatchAttempt?: number;
  method: string;
  path: string;
  headers: Readonly<Record<string, string>>;
  body: Buffer;
  nowMs?: number;
  maxAgeMs?: number;
}

function digest(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('base64url');
}

function canonicalHeaders(headers: Readonly<Record<string, string>>): string | null {
  const normalized: Array<[string, string]> = [];
  for (const [rawName, value] of Object.entries(headers)) {
    const name = rawName.toLowerCase();
    if (rawName !== name || !/^[!#$%&'*+\-.^_`|~0-9a-z]+$/.test(name)
      || typeof value !== 'string' || /[\r\n]/.test(value)) return null;
    normalized.push([name, value]);
  }
  normalized.sort(([left], [right]) => left.localeCompare(right));
  return JSON.stringify(normalized);
}

function validRequest(input: ProtectedLoopbackAttestationRequest): boolean {
  return IDENTIFIER.test(input.sessionId) && SERVICE_ID.test(input.serviceId)
    && Number.isSafeInteger(input.workerGeneration) && input.workerGeneration > 0
    && (input.turnId === undefined || IDENTIFIER.test(input.turnId))
    && (input.dispatchAttempt === undefined
      || (Number.isSafeInteger(input.dispatchAttempt) && input.dispatchAttempt > 0))
    && Number.isSafeInteger(input.peer.pid) && input.peer.pid > 1
    && PROC_START.test(input.peer.procStart)
    && METHOD.test(input.method) && input.method === input.method.toUpperCase()
    && input.path.startsWith('/') && input.path.length <= 2_048 && !/[\r\n]/.test(input.path)
    && Number.isSafeInteger(input.issuedAtMs ?? Date.now()) && (input.issuedAtMs ?? Date.now()) > 0
    && (input.nonce === undefined || NONCE.test(input.nonce));
}

function payloadKeysValid(value: Record<string, unknown>): boolean {
  return Object.keys(value).every(key => [
    'schema', 'sessionId', 'serviceId', 'workerGeneration', 'turnId', 'dispatchAttempt',
    'peerPid', 'peerProcStart', 'method', 'path', 'headersDigest', 'bodyDigest',
    'issuedAtMs', 'nonce',
  ].includes(key));
}

function sameOptional<T>(left: T | undefined, right: T | undefined): boolean {
  return left === right;
}

export function createProtectedLoopbackProxyAttestation(
  secret: string,
  input: ProtectedLoopbackAttestationRequest,
): string {
  const headers = canonicalHeaders(input.headers);
  if (!SECRET.test(secret) || !headers || !validRequest(input)) {
    throw new Error('invalid_protected_loopback_attestation');
  }
  const payload: ProtectedLoopbackAttestationPayload = {
    schema: PROTECTED_LOOPBACK_ATTESTATION_SCHEMA,
    sessionId: input.sessionId,
    serviceId: input.serviceId,
    workerGeneration: input.workerGeneration,
    ...(input.turnId ? { turnId: input.turnId } : {}),
    ...(input.dispatchAttempt !== undefined ? { dispatchAttempt: input.dispatchAttempt } : {}),
    peerPid: input.peer.pid,
    peerProcStart: input.peer.procStart,
    method: input.method,
    path: input.path,
    headersDigest: digest(headers),
    bodyDigest: digest(input.body),
    issuedAtMs: input.issuedAtMs ?? Date.now(),
    nonce: input.nonce ?? randomBytes(16).toString('hex'),
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = createHmac('sha256', secret).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}

export function verifyProtectedLoopbackProxyAttestation(
  secret: string,
  token: string,
  expected: ProtectedLoopbackAttestationExpectation,
): ProcessIdentity | null {
  if (!SECRET.test(secret) || token.length > 8_192) return null;
  const parts = token.split('.');
  if (parts.length !== 2 || !parts.every(part => TOKEN_PART.test(part))) return null;
  const [encoded, providedSignature] = parts;
  const expectedSignature = createHmac('sha256', secret).update(encoded).digest('base64url');
  const providedBytes = Buffer.from(providedSignature);
  const expectedBytes = Buffer.from(expectedSignature);
  if (providedBytes.length !== expectedBytes.length
    || !timingSafeEqual(providedBytes, expectedBytes)) return null;
  let payload: ProtectedLoopbackAttestationPayload;
  try {
    const value = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (!value || Array.isArray(value) || !payloadKeysValid(value)) return null;
    payload = value as unknown as ProtectedLoopbackAttestationPayload;
  } catch {
    return null;
  }
  const headers = canonicalHeaders(expected.headers);
  const nowMs = expected.nowMs ?? Date.now();
  const maxAgeMs = expected.maxAgeMs ?? MAX_AGE_MS;
  if (!headers || payload.schema !== PROTECTED_LOOPBACK_ATTESTATION_SCHEMA
    || payload.sessionId !== expected.sessionId || payload.serviceId !== expected.serviceId
    || payload.workerGeneration !== expected.workerGeneration
    || !sameOptional(payload.turnId, expected.turnId)
    || !sameOptional(payload.dispatchAttempt, expected.dispatchAttempt)
    || payload.method !== expected.method || payload.path !== expected.path
    || payload.headersDigest !== digest(headers) || payload.bodyDigest !== digest(expected.body)
    || !Number.isSafeInteger(payload.peerPid) || payload.peerPid <= 1
    || !PROC_START.test(payload.peerProcStart)
    || !Number.isSafeInteger(payload.issuedAtMs) || payload.issuedAtMs <= 0
    || !NONCE.test(payload.nonce)
    || !Number.isSafeInteger(maxAgeMs) || maxAgeMs <= 0
    || Math.abs(nowMs - payload.issuedAtMs) > maxAgeMs) return null;
  return { pid: payload.peerPid, procStart: payload.peerProcStart };
}
