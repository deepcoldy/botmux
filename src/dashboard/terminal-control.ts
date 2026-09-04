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
   * The acquisition this lease is currently on: an id the CLIENT minted BEFORE
   * it sent the takeover, which this process merely binds. Rotates on every
   * successful takeover, reuse included, and carries no authority of its own —
   * it is a plain equality nonce, unlike `grantId` (a segment of the signed
   * grant, which must never leave this process).
   *
   * Why the client mints it and not the server: the hard case is "the server
   * committed, the response never arrived". A server-minted marker only ever
   * travels back on a successful response, so exactly the caller that needs it
   * most never receives one — and asking for the CURRENT marker afterwards
   * returns whatever acquisition is live NOW, which after a cross-tab takeover
   * is somebody else's. Compensating with that value deletes the lease the user
   * is actively typing into. A client-minted id is known before the request
   * leaves, so a lost response changes nothing about the caller's ability to
   * name precisely its own acquisition.
   */
  acquisitionId: string;
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
    /** The acquisition this lease is now on; absent for the leaseless
     *  platform-owner role, which has nothing to compare or release. */
    acquisition?: string;
  }
  | {
    ok: false;
    error: 'authentication_expired' | 'control_busy' | 'terminal_operation_forbidden'
      /** The caller sent an acquisition id this process refuses to bind. Failing
       *  closed matters: silently minting one instead would hand back a lease
       *  whose CAS id the caller does not know, i.e. an uncompensatable lease. */
      | 'invalid_acquisition';
  };

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

/** Internal central-proxy material. The signed token never leaves the loopback
 * hop; `acquisition` is the CAS id this grant was minted against, so socket
 * registration and disconnect can both be scoped to that exact acquisition
 * rather than to "whatever lease this login happens to hold now". */
export interface TerminalProxyGrant {
  token: string;
  scope: 'read' | 'write';
  acquisition?: string;
}

/** Bounds for a client-minted acquisition id. Opaque to this process — it only
 * ever gets compared for equality and echoed back to its own minter — so the
 * charset is kept URL-safe and the length bounded, nothing more. */
export function isTerminalAcquisitionId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(value);
}

export interface TerminalControlManagerOptions {
  secret: string;
  audit: ControlAuditSink;
  ttlMs?: number;
  now?: () => number;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
  grantId?: () => string;
  /** Fallback acquisition id for callers that do not mint one (legacy/tokenless
   *  entry points). Production uses a random nonce. */
  acquisitionId?: () => string;
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
  private readonly nextAcquisitionId: () => string;

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
    this.nextAcquisitionId = opts.acquisitionId ?? (() => randomBytes(12).toString('base64url'));
  }

  /**
   * Acquire (or re-acquire) the write lease.
   *
   * `acquisitionId` is minted by the CALLER before the request goes out; this
   * process only binds it. See `TerminalControlLease.acquisitionId` for why the
   * direction matters. Omitting it keeps the historical behavior for entry
   * points that have no compensation path of their own.
   */
  takeover(
    actor: TerminalDashboardActor,
    sessionId: string,
    acquisitionId?: string,
  ): TerminalControlTakeoverResult {
    const now = this.now();
    if (actor.terminalCapability === 'readonly') {
      return { ok: false, error: 'terminal_operation_forbidden' };
    }
    if (acquisitionId !== undefined && !isTerminalAcquisitionId(acquisitionId)) {
      return { ok: false, error: 'invalid_acquisition' };
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
      // Sockets bridged under the previous acquisition keep streaming — they
      // belong to the same login — but their close no longer tears this lease
      // down, because `disconnect` is scoped to the CURRENT acquisition.
      current.acquisitionId = acquisitionId ?? this.nextAcquisitionId();
      return {
        ok: true,
        mode: 'controlled',
        expiresAt: current.expiresAt,
        reused: true,
        acquisition: current.acquisitionId,
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
      acquisitionId: acquisitionId ?? this.nextAcquisitionId(),
      issuedAt: now,
      expiresAt,
      sockets: new Set(),
    };
    lease.timer = this.schedule(() => this.invalidate(sessionId, lease, 'expired'), expiresAt - now);
    lease.timer.unref?.();
    this.leases.set(sessionId, lease);
    return { ok: true, mode: 'controlled', expiresAt, reused: false, acquisition: lease.acquisitionId };
  }

  /**
   * Give up the lease. `expectedAcquisition` makes it a compare-and-swap: the
   * release only applies while the lease is still the acquisition the caller
   * named.
   *
   * Compensation paths (a takeover whose receipt outlived its pane; a pane that
   * closed before its socket ever registered) MUST pass it. Without it, "release
   * whatever this login holds on this session" also releases a lease that a newer
   * pane of the same login has since taken over — same auth session, same lease
   * object, so no identity check can tell the two apart.
   */
  release(
    actor: TerminalDashboardActor,
    sessionId: string,
    expectedAcquisition?: string,
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
    if (expectedAcquisition !== undefined && lease.acquisitionId !== expectedAcquisition) {
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
    acquisition?: string;
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
      // Only the holder learns which acquisition the lease is currently on. A
      // pane compares it against the id IT minted: equal means "still mine",
      // different means somebody (possibly this same login in another tab) has
      // taken over since, and this pane must keep its hands off the lease.
      ...(owned ? { acquisition: lease.acquisitionId } : {}),
    };
  }

  /** Internal-only grant selection for the central terminal proxy. The
   * acquisition id lets the proxy prove that a write lease is still on the exact
   * same acquisition after the asynchronous worker WebSocket handshake. */
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
      return { token: lease.grant, scope: 'write', acquisition: lease.acquisitionId };
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
    expectedAcquisition?: string,
  ): { registered: boolean; acquisition?: string } {
    const now = this.now();
    this.expireSessionIfDue(sessionId, now);
    const lease = this.leases.get(sessionId);
    if (!lease || lease.authSessionId !== actor.authSessionId || lease.userId !== actor.userId) {
      return { registered: false };
    }
    if (socket.destroyed || (expectedAcquisition !== undefined && lease.acquisitionId !== expectedAcquisition)) {
      return { registered: false };
    }
    lease.sockets.add(socket);
    return { registered: true, acquisition: lease.acquisitionId };
  }

  /**
   * A writable bridge for `acquisition` went away — give that acquisition's lease
   * up.
   *
   * Scoped to the CURRENT acquisition on purpose. A same-login takeover reuses
   * this very lease object without reissuing the signed grant, so an older pane's
   * socket closing used to tear down the lease the NEWER pane had just acquired
   * (its own socket may not even have bridged yet). Once the acquisition has
   * rotated, the old socket's close is simply not about this lease any more.
   */
  disconnect(actor: TerminalDashboardActor, sessionId: string, acquisition: string | undefined): boolean {
    const lease = this.leases.get(sessionId);
    if (!lease || !acquisition || lease.acquisitionId !== acquisition
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

  /**
   * 本管理器当前持有状态的全部认证会话（写租约 + 读 socket 两个索引的并集）。
   *
   * 为解绑吊销而加：平台解绑时要关掉这台机器名下**所有**平台身份的连接，但协管者
   * 的 authSessionId 里含 union_id（`<scope>:<actor>:<role>`），调用方无法把人枚举
   * 出来，只能反过来遍历「已建立的会话」再按前缀筛。
   */
  authSessionIds(): string[] {
    const ids = new Set<string>();
    for (const lease of this.leases.values()) ids.add(lease.authSessionId);
    for (const id of this.readSocketsByAuthSession.keys()) ids.add(id);
    return [...ids];
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
