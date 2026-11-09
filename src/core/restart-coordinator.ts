import { randomBytes } from 'node:crypto';

/**
 * Who asked for the physical restart. Every in-worker respawn must go through
 * the coordinator: the attemptId-correlated `restart_result` is the only edge
 * that lifts the daemon's workerReady fence (an in-worker respawn never emits a
 * second process-level `ready`), so a bare restart IPC strands the session as
 * `worker_busy` forever.
 *
 *  - `slash` / `card`  — IM `/restart` and the streaming-card button.
 *  - `cli_crash`       — daemon auto-restart after an unexpected CLI exit.
 *  - `dashboard`       — dashboard restart button (operator).
 *  - `cwd_move`        — role-switch working-directory move (respawn in new cwd).
 */
export type RestartSource = 'slash' | 'card' | 'cli_crash' | 'dashboard' | 'cwd_move';
export type RestartTerminalStatus = 'succeeded' | 'failed' | 'timed_out';
/**
 * `cancelled`: the attempt was dropped without a result because the session's
 * worker was retired underneath it (close, transfer, cold restart). Observers
 * hear it so a status they already showed does not stay "in progress" forever.
 */
export type RestartObserverStatus = 'in_progress' | RestartTerminalStatus | 'cancelled';

export interface RestartObserver {
  source: RestartSource;
  /** `attemptId` names the physical attempt: observers that joined the same
   *  attempt receive the same id, so they can share one visible status. */
  notify(status: RestartObserverStatus, attemptId: string): void | Promise<void>;
}

interface RestartAttempt {
  id: string;
  observers: RestartObserver[];
  timer?: NodeJS.Timeout;
  uncertain?: boolean;
}

export class RestartCoordinator {
  private readonly attempts = new Map<string, RestartAttempt>();
  private readonly notifications = new WeakMap<RestartObserver, Promise<void>>();

  constructor(private readonly options: {
    timeoutMs?: number;
    createAttemptId?: () => string;
    persistence?: {
      restore(sessionId: string): { id: string; uncertain: boolean; planned?: boolean } | undefined;
      record(sessionId: string, id: string, phase: 'requested' | 'started' | 'succeeded' | 'failed' | 'failed_before_effect' | 'timed_out'): 'terminal' | 'uncertain' | 'started' | 'joined' | void;
    };
  } = {}) {}

  request(
    sessionId: string,
    observer: RestartObserver,
    startPhysicalRestart: (attemptId: string) => void | Promise<void>,
  ): { attemptId: string; joined: boolean } {
    const restored = !this.attempts.has(sessionId) ? this.options.persistence?.restore(sessionId) : undefined;
    if (restored && !restored.planned) this.attempts.set(sessionId, { id: restored.id, observers: [], uncertain: restored.uncertain });
    const existing = this.attempts.get(sessionId);
    if (existing) {
      existing.observers.push(observer);
      this.enqueueNotify(observer, existing.uncertain ? 'timed_out' : 'in_progress', existing.id);
      return { attemptId: existing.id, joined: true };
    }

    const attemptId = restored?.planned ? restored.id : this.options.createAttemptId?.() ?? randomBytes(12).toString('hex');
    if (!restored?.planned) this.options.persistence?.record(sessionId, attemptId, 'requested');
    const timer = setTimeout(
      () => this.resolve(sessionId, attemptId, 'timed_out'),
      this.options.timeoutMs ?? 40_000,
    );
    timer.unref?.();
    this.attempts.set(sessionId, { id: attemptId, observers: [observer], timer });

    // Notifications are deliberately detached: a slow IM request must not
    // postpone replacing the process.
    this.enqueueNotify(observer, 'in_progress', attemptId);
    let physicalStartInvoked = false;
    try {
      const start = this.options.persistence?.record(sessionId, attemptId, 'started');
      if (start === 'joined') return { attemptId, joined: true };
      physicalStartInvoked = true;
      const started = startPhysicalRestart(attemptId);
      void Promise.resolve(started).catch(() => {
        this.resolve(sessionId, attemptId, 'failed');
      });
    } catch {
      this.resolve(sessionId, attemptId, 'failed', !physicalStartInvoked);
    }
    return { attemptId, joined: false };
  }

  resolve(sessionId: string, attemptId: string, status: RestartTerminalStatus, beforeEffect = false): boolean {
    const attempt = this.attempts.get(sessionId);
    if (!attempt || attempt.id !== attemptId) return false;
    const result = this.options.persistence?.record(sessionId, attemptId, beforeEffect ? 'failed_before_effect' : status);
    if (result === 'uncertain') {
      attempt.uncertain = true;
      clearTimeout(attempt.timer);
      attempt.timer = undefined;
      for (const observer of attempt.observers) this.enqueueNotify(observer, status, attemptId);
      return true;
    }
    this.attempts.delete(sessionId);
    clearTimeout(attempt.timer);
    for (const observer of attempt.observers) this.enqueueNotify(observer, status, attemptId);
    return true;
  }

  failSession(sessionId: string): boolean {
    const attempt = this.attempts.get(sessionId);
    return attempt ? this.resolve(sessionId, attempt.id, 'failed') : false;
  }

  cancelSession(sessionId: string): boolean {
    const attempt = this.attempts.get(sessionId);
    if (!attempt) return false;
    this.attempts.delete(sessionId);
    clearTimeout(attempt.timer);
    for (const observer of attempt.observers) this.enqueueNotify(observer, 'cancelled', attempt.id);
    return true;
  }

  activeAttemptId(sessionId: string): string | undefined {
    return this.attempts.get(sessionId)?.id;
  }

  reset(): void {
    for (const attempt of this.attempts.values()) clearTimeout(attempt.timer);
    this.attempts.clear();
  }

  private async notify(observer: RestartObserver, status: RestartObserverStatus, attemptId: string): Promise<void> {
    try {
      await observer.notify(status, attemptId);
    } catch {
      // Best effort; one observer cannot block the restart or other observers.
    }
  }

  private enqueueNotify(observer: RestartObserver, status: RestartObserverStatus, attemptId: string): void {
    const previous = this.notifications.get(observer) ?? Promise.resolve();
    const next = previous.then(() => this.notify(observer, status, attemptId));
    this.notifications.set(observer, next);
    void next.finally(() => {
      if (this.notifications.get(observer) === next) this.notifications.delete(observer);
    });
  }
}
