import { randomBytes } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  openSync,
  readSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import {
  ensureManagedOriginAttestationDirectory,
  managedOriginAttestationProofPath,
} from './managed-origin-capability.js';

export const MANAGED_ORIGIN_ATTEST_ROUTE = '/api/session-origin/attest';
export const MANAGED_ORIGIN_PROOF_DOMAIN = 'botmux.managed-origin-attestation.v1';
export const MANAGED_ORIGIN_PROOF_TTL_MS = 5_000;
const MAX_PROOF_BYTES = 8 * 1024;

export interface ManagedOriginAttestationContext {
  sessionId: string;
  channelId: string;
  capability: string;
  dataDir: string;
  /** Routing hints only; the daemon derives identity from its live registry. */
  larkAppId?: string;
  ipcPortFallback?: number;
}

export interface ManagedOriginAttestation {
  sessionId: string;
  turnId: string;
  dispatchAttempt?: number;
  requiresCodexAppLedger: boolean;
}

export interface ManagedOriginAttestationProof extends ManagedOriginAttestation {
  domain: typeof MANAGED_ORIGIN_PROOF_DOMAIN;
  version: 1;
  nonce: string;
  channelId: string;
  issuedAtMs: number;
}

export class ManagedOriginAttestationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ManagedOriginAttestationError';
  }
}

/** Daemon-side proof creation. The nonce is strict and the destination is
 * derived only from the authenticated session + daemon data root. O_EXCL and
 * O_NOFOLLOW make a pre-existing leaf fail closed rather than follow it. */
export function writeManagedOriginAttestationProof(input: {
  dataDir: string;
  proof: ManagedOriginAttestationProof;
}): string {
  const dir = ensureManagedOriginAttestationDirectory(
    input.dataDir,
    input.proof.sessionId,
    input.proof.channelId,
  );
  const path = managedOriginAttestationProofPath(
    input.dataDir,
    input.proof.sessionId,
    input.proof.channelId,
    input.proof.nonce,
  );
  let fd: number | undefined;
  let created = false;
  try {
    fd = openSync(
      path,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL
        | (fsConstants.O_NOFOLLOW ?? 0),
      0o600,
    );
    created = true;
    const stat = fstatSync(fd);
    const expectedUid = process.getuid?.();
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
      || (stat.mode & 0o777) !== 0o600
      || (expectedUid !== undefined && stat.uid !== expectedUid)) {
      throw new Error(`unsafe managed origin proof file under ${dir}`);
    }
    const body = Buffer.from(JSON.stringify(input.proof), 'utf8');
    if (body.length === 0 || body.length > MAX_PROOF_BYTES) {
      throw new Error('managed origin proof exceeds size limit');
    }
    let offset = 0;
    while (offset < body.length) {
      const written = writeSync(fd, body, offset, body.length - offset, null);
      if (written <= 0) throw new Error('managed origin proof write made no progress');
      offset += written;
    }
    return path;
  } catch (err) {
    if (created) {
      try { unlinkSync(path); } catch { /* best effort */ }
    }
    throw err;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* best effort */ }
    }
  }
}

function readManagedOriginAttestationProof(path: string): unknown {
  let fd: number | undefined;
  try {
    fd = openSync(
      path,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | fsConstants.O_NONBLOCK,
    );
    const stat = fstatSync(fd);
    const expectedUid = process.getuid?.();
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
      || (stat.mode & 0o777) !== 0o600
      || (expectedUid !== undefined && stat.uid !== expectedUid)
      || stat.size <= 0 || stat.size > MAX_PROOF_BYTES) {
      return undefined;
    }
    const body = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < body.length) {
      const read = readSync(fd, body, offset, body.length - offset, null);
      if (read <= 0) return undefined;
      offset += read;
    }
    return JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* best effort */ }
    }
  }
}

function validateProof(input: {
  value: unknown;
  context: ManagedOriginAttestationContext;
  nonce: string;
  nowMs: number;
}): ManagedOriginAttestation | undefined {
  if (!input.value || typeof input.value !== 'object' || Array.isArray(input.value)) return undefined;
  const proof = input.value as Record<string, unknown>;
  if (proof.domain !== MANAGED_ORIGIN_PROOF_DOMAIN || proof.version !== 1
    || proof.nonce !== input.nonce
    || proof.sessionId !== input.context.sessionId
    || proof.channelId !== input.context.channelId
    || typeof proof.turnId !== 'string' || proof.turnId.length === 0 || proof.turnId.length > 256
    || typeof proof.issuedAtMs !== 'number' || !Number.isFinite(proof.issuedAtMs)
    || proof.issuedAtMs > input.nowMs + 1_000
    || input.nowMs - proof.issuedAtMs > MANAGED_ORIGIN_PROOF_TTL_MS
    || typeof proof.requiresCodexAppLedger !== 'boolean') {
    return undefined;
  }
  const dispatchAttempt = proof.dispatchAttempt === undefined
    ? undefined
    : typeof proof.dispatchAttempt === 'number'
      && Number.isSafeInteger(proof.dispatchAttempt)
      && proof.dispatchAttempt > 0
      ? proof.dispatchAttempt
      : null;
  if (dispatchAttempt === null) return undefined;
  return {
    sessionId: input.context.sessionId,
    turnId: proof.turnId,
    ...(dispatchAttempt !== undefined ? { dispatchAttempt } : {}),
    requiresCodexAppLedger: proof.requiresCodexAppLedger,
  };
}

/**
 * Exchange a rotating capability for a host-file proof of the daemon's exact
 * live tuple. HTTP is transport only: a stale child can bind a released port
 * and forge a response, but Seatbelt prevents it from creating the random
 * nonce proof in the host-owned read-only directory.
 */
export async function attestManagedOrigin(input: {
  context: ManagedOriginAttestationContext;
  resolveIpcPort?: (larkAppId: string | undefined) => number | undefined;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  nonce?: string;
  now?: () => number;
  wait?: (delayMs: number) => Promise<void>;
}): Promise<ManagedOriginAttestation> {
  const discovered = input.resolveIpcPort?.(input.context.larkAppId);
  // The capability leaf is host-written and read-only in Seatbelt. Daemon
  // discovery descriptors remain ordinary filesystem data that the confined
  // child may poison, so they are only a compatibility fallback when an older
  // capability lacks the owning port.
  const port = input.context.ipcPortFallback ?? discovered;
  if (!Number.isSafeInteger(port) || !port || port <= 0) {
    throw new ManagedOriginAttestationError(
      '找不到目标 daemon 端口；无法验证当前 worker 的 managed origin',
    );
  }
  const nonce = input.nonce ?? randomBytes(32).toString('hex');
  if (!/^[a-f0-9]{64}$/.test(nonce)) {
    throw new ManagedOriginAttestationError('managed origin challenge nonce 无效');
  }
  const proofPath = managedOriginAttestationProofPath(
    input.context.dataDir,
    input.context.sessionId,
    input.context.channelId,
    nonce,
  );
  const timeoutMs = input.timeoutMs ?? 3_000;
  const now = input.now ?? Date.now;
  const wait = input.wait ?? (delayMs => new Promise(resolve => setTimeout(resolve, delayMs)));
  const deadline = now() + timeoutMs;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  let response: Response;
  try {
    response = await (input.fetchImpl ?? fetch)(
      `http://127.0.0.1:${port}${MANAGED_ORIGIN_ATTEST_ROUTE}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sessionId: input.context.sessionId,
          channelId: input.context.channelId,
          originCapability: input.context.capability,
          nonce,
        }),
        signal: controller.signal,
      },
    );
  } catch (err) {
    throw new ManagedOriginAttestationError(
      controller.signal.aborted
        ? 'daemon managed-origin 验证超时'
        : `无法连接 owning daemon 验证 managed origin: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    try { await response.body?.cancel(); } catch { /* transport body is untrusted */ }
    throw new ManagedOriginAttestationError(`daemon 拒绝 managed origin: HTTP ${response.status}`);
  }
  // Ignore the response body completely. Only a valid protected proof is
  // authority, and a fake loopback listener cannot write one.
  try { await response.body?.cancel(); } catch { /* authority never comes from HTTP */ }
  for (;;) {
    const nowMs = now();
    const proof = validateProof({
      value: readManagedOriginAttestationProof(proofPath),
      context: input.context,
      nonce,
      nowMs,
    });
    if (proof) return proof;
    if (nowMs >= deadline) {
      throw new ManagedOriginAttestationError('daemon 未生成有效的 managed-origin host proof');
    }
    await wait(Math.min(20, Math.max(1, deadline - nowMs)));
  }
}
