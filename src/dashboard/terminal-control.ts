import { randomBytes } from 'node:crypto';
import {
  issueTerminalControlGrant,
  type TerminalControlGrantClaims,
} from '../core/terminal-control-grant.js';
import {
  controlAuditRecord,
  type ControlAuditSink,
} from './control-audit.js';
import { TERMINAL_VIEW_CAPABILITY_TTL_MS } from './terminal-view-capability.js';

export const DEFAULT_TERMINAL_CONTROL_TTL_MS = 5 * 60_000;
// One shared bound for every read capability (per-request proxy grants AND the
// view-link URL capability). The worker closes read sockets at this signed
// boundary (P1-5), so the value doubles as the periodic reconnect cadence for
// long-watching read viewers — 60s would have made every read terminal blink
// once a minute, while logout/expiry still closes sockets immediately through
// the proxy-side index below.
const READ_GRANT_TTL_MS = TERMINAL_VIEW_CAPABILITY_TTL_MS;

export interface TerminalDashboardActor {
  userId: string;
  authSessionId: string;
  expiresAt: number;
  /**
   * `controlled` is the Workbench lease model. A trusted central-platform
   * owner retains its historical always-write role; teammate/guest identities
   * are permanently read-only and cannot promote themselves via takeover.
   */
  terminalCapability?: 'controlled' | 'owner' | 'readonly';
}

export interface TerminalControlSocket {
  readonly destroyed?: boolean;
  destroy(): void;
}

interface TerminalControlLease {
  sessionId: string;
  userId: string;
  authSessionId: string;
  grant: string;
  grantId: string;
  /**
   * Browser-safe marker of the LAST acquisition of this lease. Rotates on every
   * successful takeover, reuse included, and carries no authority of its own —
   * it is a plain equality nonce, unlike `grantId` (a segment of the signed
   * grant, which must never leave this process).
   *
   * It exists for compare-and-swap release: a caller that acquired the lease and
   * then lost track of its UI (pane unmounted before the receipt arrived) can
   * name the acquisition it is compensating for. If somebody else has taken the
   * lease over since — under the SAME login, which reuses this very lease and so
   * is invisible to any session-level check — the marker no longer matches and
   * the release is refused instead of silently stripping write from the pane the
   * user is actually looking at.
   */
  opMarker: string;
  issuedAt: number;
  expiresAt: number;
  timer?: ReturnType<typeof setTimeout>;
  sockets: Set<TerminalControlSocket>;
}

export type TerminalControlTakeoverResult =
  | {
    ok: true;
    mode: 'controlled';
    expiresAt: number;
    reused: boolean;
    /** This acquisition's CAS marker; absent for the leaseless platform-owner
     *  role, which has nothing to compare or release. */
    marker?: string;
  }
  | { ok: false; error: 'authentication_expired' | 'control_busy' | 'terminal_operation_forbidden' };

export type TerminalControlReleaseResult =
  | { ok: true; mode: 'readonly'; released: boolean }
  | {
    ok: false;
    error: 'control_owned_by_another_session'
      | 'terminal_operation_forbidden'
      /** A conditional release named an acquisition that is no longer the current
       *  one. The lease stays exactly as it is — reporting `readonly` here would
       *  tell the caller the opposite of the truth. */
      | 'control_lease_superseded';
  };

/** Internal central-proxy material. The browser receives neither the signed
 * token nor the lease marker; both stay on the loopback hop. */
export interface TerminalProxyGrant {
  token: string;
  scope: 'read' | 'write';
  leaseMarker?: string;
}

export interface TerminalControlManagerOptions {
  secret: string;
  audit: ControlAuditSink;
  ttlMs?: number;
  now?: () => number;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
  grantId?: () => string;
  /** Injectable CAS marker source; production uses a random nonce. */
  opMarker?: () => string;
}

function validControlTtl(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 10_000 && value <= 15 * 60_000;
}

/**
 * Server-authoritative single-controller lease per terminal session. The
 * browser sees only mode/expiry. The signed write grant remains in this
 * process and is injected on the dashboard -> worker loopback hop.
 */
export class TerminalControlManager {
  private readonly leases = new Map<string, TerminalControlLease>();
  /** P1-5 revocation index: read-only bridged sockets per auth session, so a
   * logout/expiry can close every read stream that authentication opened. */
  private readonly readSocketsByAuthSession = new Map<string, Set<TerminalControlSocket>>();
  private readonly secret: string;
  private readonly audit: ControlAuditSink;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly schedule: typeof setTimeout;
  private readonly cancel: typeof clearTimeout;
  private readonly nextGrantId?: () => string;
  private readonly nextOpMarker: () => string;

  constructor(opts: TerminalControlManagerOptions) {
    if (!opts.secret) throw new Error('terminal control secret is required');
    this.secret = opts.secret;
    this.audit = opts.audit;
    this.ttlMs = opts.ttlMs ?? DEFAULT_TERMINAL_CONTROL_TTL_MS;
    if (!validControlTtl(this.ttlMs)) throw new RangeError('terminal control TTL must be between 10 seconds and 15 minutes');
    this.now = opts.now ?? Date.now;
    this.schedule = opts.setTimer ?? setTimeout;
    this.cancel = opts.clearTimer ?? clearTimeout;
    this.nextGrantId = opts.grantId;
    this.nextOpMarker = opts.opMarker ?? (() => randomBytes(12).toString('base64url'));
  }

  takeover(actor: TerminalDashboardActor, sessionId: string): TerminalControlTakeoverResult {
    const now = this.now();
    if (actor.terminalCapability === 'readonly') {
      return { ok: false, error: 'terminal_operation_forbidden' };
    }
    if (actor.terminalCapability === 'owner') {
      return {
        ok: true,
        mode: 'controlled',
        expiresAt: Math.min(actor.expiresAt, now + READ_GRANT_TTL_MS),
        reused: true,
      };
    }
    this.expireSessionIfDue(sessionId, now);
    if (!Number.isSafeInteger(actor.expiresAt) || actor.expiresAt <= now) {
      return { ok: false, error: 'authentication_expired' };
    }
    const current = this.leases.get(sessionId);
    if (current) {
      if (current.authSessionId !== actor.authSessionId || current.userId !== actor.userId) {
        return { ok: false, error: 'control_busy' };
      }
      this.audit.append(controlAuditRecord(actor.userId, sessionId, 'terminal.takeover_reused', { now: new Date(now) }));
      // Reuse is still an acquisition: whoever asked for it now owns the lease,
      // and any earlier holder's pending compensation must stop applying to it.
      current.opMarker = this.nextOpMarker();
      return {
        ok: true, mode: 'controlled', expiresAt: current.expiresAt, reused: true, marker: current.opMarker,
      };
    }

    const expiresAt = Math.min(now + this.ttlMs, actor.expiresAt);
    if (expiresAt <= now) return { ok: false, error: 'authentication_expired' };
    const grantId = this.nextGrantId?.();
    const grant = issueTerminalControlGrant(this.secret, {
      scope: 'write',
      sessionId,
      userId: actor.userId,
      authSessionId: actor.authSessionId,
      issuedAt: now,
      expiresAt,
      ...(grantId ? { grantId } : {}),
    });
    // Fail closed if the durable audit sink cannot account for takeover.
    this.audit.append(controlAuditRecord(actor.userId, sessionId, 'terminal.takeover', { now: new Date(now) }));
    const verifiedGrantId = grant.split('.')[1];
    const lease: TerminalControlLease = {
      sessionId,
      userId: actor.userId,
      authSessionId: actor.authSessionId,
      grant,
      // Internal equality marker; never serialized or logged. Using the signed
      // payload avoids retaining an additional secret value.
      grantId: verifiedGrantId,
      opMarker: this.nextOpMarker(),
      issuedAt: now,
      expiresAt,
      sockets: new Set(),
    };
    lease.timer = this.schedule(() => this.invalidate(sessionId, lease, 'expired'), expiresAt - now);
    lease.timer.unref?.();
    this.leases.set(sessionId, lease);
    return { ok: true, mode: 'controlled', expiresAt, reused: false, marker: lease.opMarker };
  }

  /**
   * Give up the lease. `expectedMarker` makes it a compare-and-swap: the release
   * only applies while the lease is still the acquisition the caller named.
   *
   * Compensation paths (a takeover whose receipt outlived its pane) MUST pass it.
   * Without it, "release whatever this login holds on this session" also releases
   * a lease that a newer pane of the same login has since taken over — same auth
   * session, same lease object, so no identity check can tell the two apart.
   */
  release(
    actor: TerminalDashboardActor,
    sessionId: string,
    expectedMarker?: string,
  ): TerminalControlReleaseResult {
    if (actor.terminalCapability === 'readonly' || actor.terminalCapability === 'owner') {
      return { ok: false, error: 'terminal_operation_forbidden' };
    }
    const now = this.now();
    this.expireSessionIfDue(sessionId, now);
    const lease = this.leases.get(sessionId);
    if (!lease) return { ok: true, mode: 'readonly', released: false };
    if (lease.authSessionId !== actor.authSessionId || lease.userId !== actor.userId) {
      return { ok: false, error: 'control_owned_by_another_session' };
    }
    if (expectedMarker !== undefined && lease.opMarker !== expectedMarker) {
      return { ok: false, error: 'control_lease_superseded' };
    }
    this.invalidate(sessionId, lease, 'release', now);
    return { ok: true, mode: 'readonly', released: true };
  }

  state(actor: TerminalDashboardActor, sessionId: string): {
    mode: 'readonly' | 'controlled';
    owned: boolean;
    expiresAt?: number;
    fixed?: boolean;
    marker?: string;
  } {
    const now = this.now();
    if (actor.terminalCapability === 'readonly') return { mode: 'readonly', owned: false };
    if (actor.terminalCapability === 'owner') {
      return { mode: 'controlled', owned: true, fixed: true };
    }
    this.expireSessionIfDue(sessionId, now);
    const lease = this.leases.get(sessionId);
    if (!lease) return { mode: 'readonly', owned: false };
    const owned = lease.authSessionId === actor.authSessionId && lease.userId === actor.userId;
    return {
      mode: 'controlled',
      owned,
      expiresAt: lease.expiresAt,
      // Only the holder learns which acquisition the lease is currently on — it
      // is what lets a compensation decide "still mine" vs "someone took over".
      ...(owned ? { marker: lease.opMarker } : {}),
    };
  }

  /** Internal-only grant selection for the central terminal proxy. The marker
   * lets the proxy prove that a write lease is still the exact same lease after
   * the asynchronous worker WebSocket handshake completes. */
  grantForProxy(actor: TerminalDashboardActor, sessionId: string): TerminalProxyGrant {
    const now = this.now();
    if (actor.terminalCapability === 'owner') {
      const expiresAt = Math.min(actor.expiresAt, now + READ_GRANT_TTL_MS);
      return {
        token: issueTerminalControlGrant(this.secret, {
          scope: 'write',
          sessionId,
          userId: actor.userId,
          authSessionId: actor.authSessionId,
          issuedAt: now,
          expiresAt,
        }),
        scope: 'write',
      };
    }
    this.expireSessionIfDue(sessionId, now);
    const lease = actor.terminalCapability === 'readonly' ? undefined : this.leases.get(sessionId);
    if (lease && lease.authSessionId === actor.authSessionId && lease.userId === actor.userId) {
      return { token: lease.grant, scope: 'write', leaseMarker: lease.grantId };
    }
    const expiresAt = Math.min(actor.expiresAt, now + READ_GRANT_TTL_MS);
    if (expiresAt <= now) return { token: '', scope: 'read' };
    return {
      token: issueTerminalControlGrant(this.secret, {
        scope: 'read',
        sessionId,
        userId: actor.userId,
        authSessionId: actor.authSessionId,
        issuedAt: now,
        expiresAt,
      }),
      scope: 'read',
    };
  }

  /** Backward-compatible narrow accessor used by direct manager tests. */
  grantFor(actor: TerminalDashboardActor, sessionId: string): string {
    return this.grantForProxy(actor, sessionId).token;
  }

  registerWritableSocket(
    actor: TerminalDashboardActor,
    sessionId: string,
    socket: TerminalControlSocket,
    expectedLeaseMarker?: string,
  ): { registered: boolean; leaseMarker?: string } {
    const now = this.now();
    this.expireSessionIfDue(sessionId, now);
    const lease = this.leases.get(sessionId);
    if (!lease || lease.authSessionId !== actor.authSessionId || lease.userId !== actor.userId) {
      return { registered: false };
    }
    if (socket.destroyed || (expectedLeaseMarker !== undefined && lease.grantId !== expectedLeaseMarker)) {
      return { registered: false };
    }
    lease.sockets.add(socket);
    return { registered: true, leaseMarker: lease.grantId };
  }

  disconnect(actor: TerminalDashboardActor, sessionId: string, leaseMarker: string | undefined): boolean {
    const lease = this.leases.get(sessionId);
    if (!lease || !leaseMarker || lease.grantId !== leaseMarker
      || lease.authSessionId !== actor.authSessionId || lease.userId !== actor.userId) {
      return false;
    }
    this.invalidate(sessionId, lease, 'disconnect');
    return true;
  }

  /**
   * Index a read-only bridged socket under the auth session that opened it.
   * `releaseByAuthSession` (fired on logout/session expiry) then closes it
   * immediately instead of waiting for the worker-side grant expiry timer.
   * Returns a deregistration closure for the socket's own natural close.
   */
  registerReadSocket(authSessionId: string, socket: TerminalControlSocket): () => void {
    let sockets = this.readSocketsByAuthSession.get(authSessionId);
    if (!sockets) {
      sockets = new Set();
      this.readSocketsByAuthSession.set(authSessionId, sockets);
    }
    sockets.add(socket);
    return () => {
      const current = this.readSocketsByAuthSession.get(authSessionId);
      if (!current) return;
      current.delete(socket);
      if (current.size === 0) this.readSocketsByAuthSession.delete(authSessionId);
    };
  }

  releaseByAuthSession(authSessionId: string): number {
    let released = 0;
    for (const [sessionId, lease] of [...this.leases]) {
      if (lease.authSessionId !== authSessionId) continue;
      this.invalidate(sessionId, lease, 'disconnect');
      released++;
    }
    // Read streams are not leases but must die with the authentication that
    // opened them (P1-5). Only THIS auth session's sockets close — a different
    // viewer's read stream on the same terminal is untouched.
    const readSockets = this.readSocketsByAuthSession.get(authSessionId);
    if (readSockets) {
      this.readSocketsByAuthSession.delete(authSessionId);
      for (const socket of readSockets) {
        try { if (!socket.destroyed) socket.destroy(); } catch { /* already closed */ }
      }
    }
    return released;
  }

  expireDue(): number {
    const now = this.now();
    let expired = 0;
    for (const sessionId of [...this.leases.keys()]) {
      if (this.expireSessionIfDue(sessionId, now)) expired++;
    }
    return expired;
  }

  private expireSessionIfDue(sessionId: string, now: number): boolean {
    const lease = this.leases.get(sessionId);
    if (!lease || now < lease.expiresAt) return false;
    this.invalidate(sessionId, lease, 'expired', now);
    return true;
  }

  private invalidate(
    sessionId: string,
    lease: TerminalControlLease,
    reason: 'release' | 'expired' | 'disconnect',
    now = this.now(),
  ): void {
    if (this.leases.get(sessionId) !== lease) return;
    this.leases.delete(sessionId);
    if (lease.timer) this.cancel(lease.timer);
    const action = reason === 'release' ? 'terminal.release'
      : reason === 'expired' ? 'terminal.expired'
      : 'terminal.disconnected';
    try {
      this.audit.append(controlAuditRecord(lease.userId, sessionId, action, { now: new Date(now) }));
    } catch {
      // Revocation is the security boundary. A teardown audit failure must not
      // resurrect the lease, skip later leases in a logout sweep, or crash an
      // expiry/disconnect timer. New takeovers still fail closed on audit above.
    } finally {
      for (const socket of lease.sockets) {
        try { if (!socket.destroyed) socket.destroy(); } catch { /* already closed */ }
      }
      lease.sockets.clear();
    }
  }
}

/** Parse a bounded operator-tunable lease TTL while preserving a short cap. */
export function terminalControlTtlFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const candidate = Number(env.BOTMUX_DASHBOARD_TERMINAL_CONTROL_TTL_MS);
  return validControlTtl(candidate) ? candidate : DEFAULT_TERMINAL_CONTROL_TTL_MS;
}

/** Type-only assertion used by downstream callers without exporting leases. */
export type TerminalControlGrant = TerminalControlGrantClaims;
