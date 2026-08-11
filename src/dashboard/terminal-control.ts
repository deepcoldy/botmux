import {
  issueTerminalControlGrant,
  type TerminalControlGrantClaims,
} from '../core/terminal-control-grant.js';
import {
  controlAuditRecord,
  type ControlAuditSink,
} from './control-audit.js';

export const DEFAULT_TERMINAL_CONTROL_TTL_MS = 5 * 60_000;
const READ_GRANT_TTL_MS = 60_000;

export interface TerminalDashboardActor {
  userId: string;
  authSessionId: string;
  expiresAt: number;
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
  issuedAt: number;
  expiresAt: number;
  timer?: ReturnType<typeof setTimeout>;
  sockets: Set<TerminalControlSocket>;
}

export type TerminalControlTakeoverResult =
  | { ok: true; mode: 'controlled'; expiresAt: number; reused: boolean }
  | { ok: false; error: 'authentication_expired' | 'control_busy' };

export type TerminalControlReleaseResult =
  | { ok: true; mode: 'readonly'; released: boolean }
  | { ok: false; error: 'control_owned_by_another_session' };

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
  private readonly secret: string;
  private readonly audit: ControlAuditSink;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly schedule: typeof setTimeout;
  private readonly cancel: typeof clearTimeout;
  private readonly nextGrantId?: () => string;

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
  }

  takeover(actor: TerminalDashboardActor, sessionId: string): TerminalControlTakeoverResult {
    const now = this.now();
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
      return { ok: true, mode: 'controlled', expiresAt: current.expiresAt, reused: true };
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
      issuedAt: now,
      expiresAt,
      sockets: new Set(),
    };
    lease.timer = this.schedule(() => this.invalidate(sessionId, lease, 'expired'), expiresAt - now);
    lease.timer.unref?.();
    this.leases.set(sessionId, lease);
    return { ok: true, mode: 'controlled', expiresAt, reused: false };
  }

  release(actor: TerminalDashboardActor, sessionId: string): TerminalControlReleaseResult {
    const now = this.now();
    this.expireSessionIfDue(sessionId, now);
    const lease = this.leases.get(sessionId);
    if (!lease) return { ok: true, mode: 'readonly', released: false };
    if (lease.authSessionId !== actor.authSessionId || lease.userId !== actor.userId) {
      return { ok: false, error: 'control_owned_by_another_session' };
    }
    this.invalidate(sessionId, lease, 'release', now);
    return { ok: true, mode: 'readonly', released: true };
  }

  state(actor: TerminalDashboardActor, sessionId: string): {
    mode: 'readonly' | 'controlled';
    owned: boolean;
    expiresAt?: number;
  } {
    const now = this.now();
    this.expireSessionIfDue(sessionId, now);
    const lease = this.leases.get(sessionId);
    if (!lease) return { mode: 'readonly', owned: false };
    return {
      mode: 'controlled',
      owned: lease.authSessionId === actor.authSessionId && lease.userId === actor.userId,
      expiresAt: lease.expiresAt,
    };
  }

  /** Internal-only grant selection for the central terminal proxy. The marker
   * lets the proxy prove that a write lease is still the exact same lease after
   * the asynchronous worker WebSocket handshake completes. */
  grantForProxy(actor: TerminalDashboardActor, sessionId: string): TerminalProxyGrant {
    const now = this.now();
    this.expireSessionIfDue(sessionId, now);
    const lease = this.leases.get(sessionId);
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

  releaseByAuthSession(authSessionId: string): number {
    let released = 0;
    for (const [sessionId, lease] of [...this.leases]) {
      if (lease.authSessionId !== authSessionId) continue;
      this.invalidate(sessionId, lease, 'disconnect');
      released++;
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
