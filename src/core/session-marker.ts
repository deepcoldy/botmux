import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { readManagedOriginCapability } from './managed-origin-capability.js';

export interface AncestorSessionContext {
  sessionId: string;
  turnId?: string;
  dispatchAttempt?: number;
}

interface IdentityBoundSessionMarker extends AncestorSessionContext {
  procStart?: string;
}

export interface AuthenticatedAncestorSessionContext extends AncestorSessionContext {
  markerPid: number;
  procStart: string;
}

export class SessionMarkerAuthenticationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionMarkerAuthenticationError';
  }
}

const LINUX_BOOT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Kernel-generated identity that changes on every Linux boot. */
export function readLinuxBootIdentity(): string | undefined {
  if (process.platform !== 'linux') return undefined;
  try {
    const bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    return LINUX_BOOT_ID_RE.test(bootId) ? bootId.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Stable process-birth identity used to reject stale marker files after PID
 * reuse. Linux exposes start ticks in /proc; macOS/other Unix falls back to
 * ps(1)'s process start timestamp so mutating commands remain cross-platform.
 */
export function readProcessStartIdentity(pid: number): string | undefined {
  if (!Number.isInteger(pid) || pid <= 1) return undefined;
  if (process.platform === 'linux') {
    try {
      const raw = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const closeParen = raw.lastIndexOf(')');
      if (closeParen >= 0) {
        const fields = raw.slice(closeParen + 2).trim().split(/\s+/);
        if (fields[19]) return fields[19];
      }
    } catch { /* disappeared or unreadable: never fall through to ambient ps */ }
    return undefined;
  }
  const ps = systemPsBin();
  if (!ps) return undefined;
  try {
    const started = execFileSync(
      ps,
      ['-o', 'lstart=', '-p', String(pid)],
      {
        encoding: 'utf-8',
        timeout: 2000,
        stdio: ['ignore', 'pipe', 'ignore'],
        env: { PATH: '/usr/bin:/bin', LANG: 'C' },
      },
    ).trim();
    return started || undefined;
  } catch {
    return undefined;
  }
}

function systemPsBin(): string | undefined {
  for (const candidate of ['/usr/bin/ps', '/bin/ps']) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

function readParentPid(pid: number): number | undefined {
  if (process.platform === 'linux') {
    try {
      const raw = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const closeParen = raw.lastIndexOf(')');
      if (closeParen < 0) return undefined;
      const fields = raw.slice(closeParen + 2).trim().split(/\s+/);
      const parent = Number(fields[1]);
      return Number.isSafeInteger(parent) && parent > 0 ? parent : undefined;
    } catch { return undefined; }
  }
  const ps = systemPsBin();
  if (!ps) return undefined;
  try {
    const out = execFileSync(ps, ['-o', 'ppid=', '-p', String(pid)], {
      encoding: 'utf-8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'],
      env: { PATH: '/usr/bin:/bin', LANG: 'C' },
    }).trim();
    const parent = Number(out);
    return Number.isSafeInteger(parent) && parent > 0 ? parent : undefined;
  } catch { return undefined; }
}

function parseDispatchAttempt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

function parseIdentityBoundSessionMarker(raw: string): IdentityBoundSessionMarker {
  const text = raw.trim();
  if (!text.startsWith('{')) return { sessionId: text };
  try {
    const parsed = JSON.parse(text) as {
      sessionId?: unknown; turnId?: unknown; dispatchAttempt?: unknown; procStart?: unknown;
    };
    const dispatchAttempt = parseDispatchAttempt(parsed.dispatchAttempt);
    return {
      sessionId: typeof parsed.sessionId === 'string' ? parsed.sessionId : '',
      ...(typeof parsed.turnId === 'string' ? { turnId: parsed.turnId } : {}),
      ...(dispatchAttempt !== undefined ? { dispatchAttempt } : {}),
      ...(typeof parsed.procStart === 'string' ? { procStart: parsed.procStart } : {}),
    };
  } catch {
    return { sessionId: '' };
  }
}

export function parseSessionMarker(raw: string): AncestorSessionContext {
  const parsed = parseIdentityBoundSessionMarker(raw);
  return {
    sessionId: parsed.sessionId,
    ...(parsed.turnId ? { turnId: parsed.turnId } : {}),
    ...(parsed.dispatchAttempt !== undefined ? { dispatchAttempt: parsed.dispatchAttempt } : {}),
  };
}

/**
 * Strong marker lookup for authority-bearing commands. Unlike the legacy
 * read/reply resolver, this requires the worker's JSON procStart binding and
 * verifies it against the live ancestor process before returning identity.
 */
export function findAuthenticatedAncestorSessionContext(
  dataDir: string,
  startPid: number = process.ppid,
): AuthenticatedAncestorSessionContext | null {
  const markersDir = join(dataDir, '.botmux-cli-pids');
  if (!existsSync(markersDir)) return null;

  let pid = startPid;
  for (let depth = 0; depth < 8 && pid > 1; depth++) {
    const markerPath = join(markersDir, String(pid));
    if (existsSync(markerPath)) {
      let marker: IdentityBoundSessionMarker;
      try {
        marker = parseIdentityBoundSessionMarker(readFileSync(markerPath, 'utf-8'));
      } catch (err) {
        throw new SessionMarkerAuthenticationError(
          `无法读取 CLI process marker ${markerPath}：${err instanceof Error ? err.message : String(err)}`,
        );
      }
      if (!marker.sessionId || !marker.turnId || !marker.procStart) {
        throw new SessionMarkerAuthenticationError(
          `CLI process marker ${markerPath} 缺少 sessionId/turnId/procStart，不能用于变更操作授权`,
        );
      }
      const liveStart = readProcessStartIdentity(pid);
      if (!liveStart || liveStart !== marker.procStart) {
        throw new SessionMarkerAuthenticationError(
          `CLI process marker ${markerPath} 已过期或 PID 被复用，拒绝授权`,
        );
      }
      return {
        sessionId: marker.sessionId,
        turnId: marker.turnId,
        ...(marker.dispatchAttempt !== undefined ? { dispatchAttempt: marker.dispatchAttempt } : {}),
        markerPid: pid,
        procStart: marker.procStart,
      };
    }
    const parent = readParentPid(pid);
    if (!parent) break;
    pid = parent;
  }
  return null;
}

/**
 * Walk the process tree looking for a CLI-pid marker written by the botmux
 * worker. Legacy markers contain just the session id; new markers are JSON and
 * also carry the current inbound turn id so long-lived CLI processes can route
 * `botmux send` to the correct topic alias on the 2nd/Nth turn.
 */
export function findAncestorSessionContext(dataDir: string, startPid: number = process.ppid): AncestorSessionContext | null {
  const markersDir = join(dataDir, '.botmux-cli-pids');
  if (!existsSync(markersDir)) return null;

  let pid = startPid;
  for (let depth = 0; depth < 8 && pid > 1; depth++) {
    const markerPath = join(markersDir, String(pid));
    if (existsSync(markerPath)) {
      try { return parseSessionMarker(readFileSync(markerPath, 'utf-8')); } catch { return { sessionId: '' }; }
    }
    const parent = readParentPid(pid);
    if (!parent) break;
    pid = parent;
  }
  return null;
}

/**
 * Resolve the owning session for an in-session subcommand (`botmux send`, etc.).
 *
 * Primary signal: the process-tree marker walk above — it carries the fresh
 * per-turn turnId, so it's preferred whenever it resolves a session id.
 *
 * Fallback: `BOTMUX_SESSION_ID` from the environment. The marker walk depends on
 * an unbroken ancestry between this process and the CLI's spawn pid. That link
 * is severed whenever the subcommand runs in a detached/backgrounded process
 * (`run_in_background`, `nohup`, `&`, `setsid` → reparented to init/pid 1),
 * nested deeper than the 8-level walk, or under a separate pid-namespace — in all
 * of which the marker walk returns null even though we ARE inside a botmux
 * session. The worker injects `BOTMUX_SESSION_ID` into the CLI's env, and every
 * descendant inherits it regardless of reparenting, so it stays correct. The
 * session id never changes after spawn, so this fallback can't route to the wrong
 * session; turnId is intentionally omitted (env can't be refreshed per-turn for a
 * long-lived CLI — callers fall back to `BOTMUX_TURN_ID` when they need it).
 */
export function resolveSessionContext(
  dataDir: string,
  envSessionId: string | undefined,
  startPid: number = process.ppid,
): AncestorSessionContext | null {
  const fromMarker = findAncestorSessionContext(dataDir, startPid);
  // A live process-tree marker is the primary source whenever it is visible.
  // Per-session capability snapshots may survive SIGKILL or a later config
  // change that disables read isolation; they are only a fallback for the
  // macOS profile where the shared marker directory is intentionally hidden.
  if (fromMarker && fromMarker.sessionId) return fromMarker;
  // Read-isolated macOS sessions cannot read the shared PID-marker directory.
  // Their exact per-session capability carve-out carries one atomically rotated
  // turn snapshot, preserving fresh routing without treating the tuple itself
  // as daemon authority. It is consulted only when no live marker is visible,
  // so fields from two generations are never mixed.
  const protectedClaim = envSessionId
    ? readManagedOriginCapability(dataDir, envSessionId)
    : null;
  if (protectedClaim) {
    return {
      sessionId: protectedClaim.sessionId,
      ...(protectedClaim.turnId ? { turnId: protectedClaim.turnId } : {}),
      ...(protectedClaim.dispatchAttempt !== undefined
        ? { dispatchAttempt: protectedClaim.dispatchAttempt }
        : {}),
    };
  }
  if (envSessionId) return { sessionId: envSessionId };
  return fromMarker;
}
