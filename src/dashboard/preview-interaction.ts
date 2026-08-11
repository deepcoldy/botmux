import {
  controlAuditRecord,
  type ControlAuditSink,
} from './control-audit.js';
import type { TerminalDashboardActor } from './terminal-control.js';

/** Product contract: interaction always relocks after fifteen idle minutes. */
export const PREVIEW_INTERACTION_IDLE_MS = 15 * 60_000;
export const PREVIEW_DEFAULT_MODE_LABEL = '预览模式（默认）';
export const PREVIEW_INTERACTIVE_MODE_LABEL = '交互模式';
export const PREVIEW_OVERLAY_SECURITY_NOTICE = '交互蒙层仅用于防止误触，不是应用级强只读安全边界。';

interface InteractionLease {
  authSessionId: string;
  userId: string;
  sessionId: string;
  unlockedAt: number;
  lastActivityAt: number;
  idleExpiresAt: number;
  generation: number;
  timer?: ReturnType<typeof setTimeout>;
}

export interface PreviewInteractionState {
  mode: 'preview' | 'interactive';
  label: string;
  securityNotice: string;
  idleExpiresAt?: number;
}

export interface PreviewInteractionManagerOptions {
  audit: ControlAuditSink;
  now?: () => number;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
}

function leaseKey(authSessionId: string, sessionId: string): string {
  return `${authSessionId}\0${sessionId}`;
}

/**
 * Server-owned preview interaction state. Unlock and activity are explicit;
 * both the scheduled timer and lazy reads enforce the exact idle deadline.
 * This state drives a browser overlay only—it does not claim to neutralize
 * scripts or network side effects inside the proxied application.
 */
export class PreviewInteractionManager {
  private readonly leases = new Map<string, InteractionLease>();
  private readonly audit: ControlAuditSink;
  private readonly now: () => number;
  private readonly schedule: typeof setTimeout;
  private readonly cancel: typeof clearTimeout;
  private generation = 0;

  constructor(opts: PreviewInteractionManagerOptions) {
    this.audit = opts.audit;
    this.now = opts.now ?? Date.now;
    this.schedule = opts.setTimer ?? setTimeout;
    this.cancel = opts.clearTimer ?? clearTimeout;
  }

  state(actor: TerminalDashboardActor, sessionId: string): PreviewInteractionState {
    const lease = this.liveLease(actor, sessionId);
    return lease ? this.interactiveState(lease) : this.previewState();
  }

  unlock(actor: TerminalDashboardActor, sessionId: string): PreviewInteractionState {
    const now = this.now();
    const key = leaseKey(actor.authSessionId, sessionId);
    const previous = this.leases.get(key);
    if (previous?.timer) this.cancel(previous.timer);
    this.audit.append(controlAuditRecord(actor.userId, sessionId, 'preview.unlock', { now: new Date(now) }));
    const lease: InteractionLease = {
      authSessionId: actor.authSessionId,
      userId: actor.userId,
      sessionId,
      unlockedAt: now,
      lastActivityAt: now,
      idleExpiresAt: now + PREVIEW_INTERACTION_IDLE_MS,
      generation: ++this.generation,
    };
    this.arm(key, lease);
    this.leases.set(key, lease);
    return this.interactiveState(lease);
  }

  activity(actor: TerminalDashboardActor, sessionId: string): PreviewInteractionState {
    const lease = this.liveLease(actor, sessionId);
    if (!lease) return this.previewState();
    const now = this.now();
    this.audit.append(controlAuditRecord(actor.userId, sessionId, 'preview.activity', { now: new Date(now) }));
    lease.lastActivityAt = now;
    lease.idleExpiresAt = now + PREVIEW_INTERACTION_IDLE_MS;
    lease.generation = ++this.generation;
    const key = leaseKey(actor.authSessionId, sessionId);
    if (lease.timer) this.cancel(lease.timer);
    this.arm(key, lease);
    return this.interactiveState(lease);
  }

  lock(actor: TerminalDashboardActor, sessionId: string): PreviewInteractionState {
    const key = leaseKey(actor.authSessionId, sessionId);
    const lease = this.leases.get(key);
    if (!lease) return this.previewState();
    this.remove(key, lease);
    try {
      this.audit.append(controlAuditRecord(actor.userId, sessionId, 'preview.lock', { now: new Date(this.now()) }));
    } catch {
      // Relocking is the boundary. Audit storage failure must not turn the
      // already-removed interaction lease back on or fail the browser closed.
    }
    return this.previewState();
  }

  relockAuthSession(authSessionId: string): number {
    let count = 0;
    for (const [key, lease] of [...this.leases]) {
      if (lease.authSessionId !== authSessionId) continue;
      this.remove(key, lease);
      try {
        this.audit.append(controlAuditRecord(
          lease.userId,
          lease.sessionId,
          'preview.session_relock',
          { now: new Date(this.now()) },
        ));
      } catch {
        // Continue revoking the remaining leases for this auth session.
      }
      count++;
    }
    return count;
  }

  expireDue(): number {
    const now = this.now();
    let count = 0;
    for (const [key, lease] of [...this.leases]) {
      if (now < lease.idleExpiresAt) continue;
      this.expire(key, lease, now);
      count++;
    }
    return count;
  }

  private liveLease(actor: TerminalDashboardActor, sessionId: string): InteractionLease | undefined {
    const key = leaseKey(actor.authSessionId, sessionId);
    const lease = this.leases.get(key);
    if (!lease || lease.userId !== actor.userId) return undefined;
    const now = this.now();
    if (now >= lease.idleExpiresAt || now >= actor.expiresAt) {
      this.expire(key, lease, now);
      return undefined;
    }
    return lease;
  }

  private arm(key: string, lease: InteractionLease): void {
    const generation = lease.generation;
    lease.timer = this.schedule(() => {
      const current = this.leases.get(key);
      if (!current || current !== lease || current.generation !== generation) return;
      const now = this.now();
      if (now < current.idleExpiresAt) {
        this.arm(key, current);
        return;
      }
      this.expire(key, current, now);
    }, Math.max(0, lease.idleExpiresAt - this.now()));
    lease.timer.unref?.();
  }

  private expire(key: string, lease: InteractionLease, now: number): void {
    if (this.leases.get(key) !== lease) return;
    this.remove(key, lease);
    try {
      this.audit.append(controlAuditRecord(lease.userId, lease.sessionId, 'preview.idle_relock', {
        now: new Date(now),
      }));
    } catch {
      // The timer must never crash the Dashboard after it safely relocked.
    }
  }

  private remove(key: string, lease: InteractionLease): void {
    if (this.leases.get(key) !== lease) return;
    this.leases.delete(key);
    if (lease.timer) this.cancel(lease.timer);
  }

  private previewState(): PreviewInteractionState {
    return {
      mode: 'preview',
      label: PREVIEW_DEFAULT_MODE_LABEL,
      securityNotice: PREVIEW_OVERLAY_SECURITY_NOTICE,
    };
  }

  private interactiveState(lease: InteractionLease): PreviewInteractionState {
    return {
      mode: 'interactive',
      label: PREVIEW_INTERACTIVE_MODE_LABEL,
      securityNotice: PREVIEW_OVERLAY_SECURITY_NOTICE,
      idleExpiresAt: lease.idleExpiresAt,
    };
  }
}
