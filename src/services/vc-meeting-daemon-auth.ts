/**
 * Shared-host authentication for VC meeting daemon-to-daemon control traffic.
 *
 * Every bot daemon owns one random token under the shared session dataDir.
 * Peer daemons on the same trusted host can read that target-scoped token and
 * present it on internal control-plane requests. Tokens never enter daemon
 * descriptors, worker environments, delivery envelopes, or outboxes.
 *
 * This is intentionally NOT the authorization mechanism for agent-facing
 * managed-action requests. Those must prove a live receiver origin and pass
 * capability/sink-owner policy in the action gate.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { withFileLockSync } from '../utils/file-lock.js';

const AUTH_DIR = 'vc-meeting-daemon-auth';
const TOKEN_PATTERN = /^vcda_[0-9a-f]{64}$/;

export const VC_MEETING_DAEMON_AUTH_HEADER = 'x-botmux-vc-daemon-auth';

export interface VcMeetingDaemonAuthFailure {
  ok: false;
  status: 401;
  body: {
    ok: false;
    errorCode: 'vc_daemon_auth_required';
    error: string;
  };
}

export type VcMeetingDaemonAuthResult = { ok: true } | VcMeetingDaemonAuthFailure;

type HeaderMap = Record<string, string | string[] | undefined>;

function requireAppId(larkAppId: string): string {
  if (typeof larkAppId !== 'string' || !larkAppId.trim() || larkAppId.length > 512) {
    throw new Error('invalid larkAppId for VC daemon auth');
  }
  return larkAppId.trim();
}

/** Digesting the app id keeps arbitrary app-id characters out of filenames. */
export function vcMeetingDaemonAuthTokenPath(dataDir: string, larkAppId: string): string {
  const appId = requireAppId(larkAppId);
  const digest = createHash('sha256').update(appId, 'utf8').digest('hex');
  return join(dataDir, AUTH_DIR, `${digest}.token`);
}

function parseToken(raw: string, fp: string): string {
  const token = raw.trim();
  if (!TOKEN_PATTERN.test(token)) {
    throw new Error(`invalid VC daemon auth token at ${fp}`);
  }
  return token;
}

/** Read an existing target token without creating or rotating it. */
export function readVcMeetingDaemonAuthToken(
  dataDir: string,
  larkAppId: string,
): string | undefined {
  const fp = vcMeetingDaemonAuthTokenPath(dataDir, larkAppId);
  if (!existsSync(fp)) return undefined;
  const stat = lstatSync(fp);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`VC daemon auth token is not a regular file: ${fp}`);
  }
  return parseToken(readFileSync(fp, 'utf8'), fp);
}

/**
 * Create-once/read the target token. File locking prevents two daemon starts
 * from racing to install different credentials for the same app id.
 */
export function ensureVcMeetingDaemonAuthToken(
  dataDir: string,
  larkAppId: string,
): string {
  const fp = vcMeetingDaemonAuthTokenPath(dataDir, larkAppId);
  const dir = join(dataDir, AUTH_DIR);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  return withFileLockSync(fp, () => {
    const existing = readVcMeetingDaemonAuthToken(dataDir, larkAppId);
    if (existing) {
      chmodSync(fp, 0o600);
      return existing;
    }
    const token = `vcda_${randomBytes(32).toString('hex')}`;
    atomicWriteFileSync(fp, `${token}\n`, { mode: 0o600 });
    chmodSync(fp, 0o600);
    return token;
  });
}

function presentedHeader(headers: Headers | HeaderMap): string | undefined {
  if (headers instanceof Headers) {
    const value = headers.get(VC_MEETING_DAEMON_AUTH_HEADER);
    return value?.trim() || undefined;
  }
  const value = headers[VC_MEETING_DAEMON_AUTH_HEADER];
  // Duplicate auth headers are ambiguous and fail closed.
  if (Array.isArray(value)) return undefined;
  return typeof value === 'string' ? value.trim() || undefined : undefined;
}

function constantTimeEqual(expected: string, actual: string): boolean {
  const left = Buffer.from(expected, 'utf8');
  const right = Buffer.from(actual, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Pure route guard result. Callers must invoke it before reading a body. */
export function authorizeVcMeetingDaemonControlRequest(
  dataDir: string,
  targetLarkAppId: string,
  headers: Headers | HeaderMap,
): VcMeetingDaemonAuthResult {
  let expected: string | undefined;
  try {
    expected = readVcMeetingDaemonAuthToken(dataDir, targetLarkAppId);
  } catch {
    expected = undefined;
  }
  const actual = presentedHeader(headers);
  if (expected && actual && constantTimeEqual(expected, actual)) return { ok: true };
  return {
    ok: false,
    status: 401,
    body: {
      ok: false,
      errorCode: 'vc_daemon_auth_required',
      error: 'valid daemon-to-daemon VC control authentication is required',
    },
  };
}

/** Add/replace the target daemon's credential without mutating caller headers. */
export function withVcMeetingDaemonAuthHeader(
  dataDir: string,
  targetLarkAppId: string,
  initHeaders?: HeadersInit,
): Headers {
  const headers = new Headers(initHeaders);
  headers.set(
    VC_MEETING_DAEMON_AUTH_HEADER,
    ensureVcMeetingDaemonAuthToken(dataDir, targetLarkAppId),
  );
  return headers;
}
