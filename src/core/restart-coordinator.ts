import { randomBytes } from 'node:crypto';

export type RestartSource = 'slash' | 'card';
export type RestartTerminalStatus = 'succeeded' | 'failed' | 'timed_out';
export type RestartObserverStatus = 'in_progress' | RestartTerminalStatus;

export interface RestartObserver {
  source: RestartSource;
  notify(status: RestartObserverStatus): void | Promise<void>;
}

interface RestartAttempt {
  id: string;
  observers: RestartObserver[];
  timer: NodeJS.Timeout;
}

export class RestartCoordinator {
  private readonly attempts = new Map<string, RestartAttempt>();
  private readonly notifications = new WeakMap<RestartObserver, Promise<void>>();

  constructor(private readonly options: {
    timeoutMs?: number;
    createAttemptId?: () => string;
  } = {}) {}

  request(
    sessionId: string,
    observer: RestartObserver,
    startPhysicalRestart: (attemptId: string) => void | Promise<void>,
  ): { attemptId: string; joined: boolean } {
    const existing = this.attempts.get(sessionId);
    if (existing) {
      existing.observers.push(observer);
      this.enqueueNotify(observer, 'in_progress');
      return { attemptId: existing.id, joined: true };
    }

    const attemptId = this.options.createAttemptId?.() ?? randomBytes(12).toString('hex');
    const timer = setTimeout(
      () => this.resolve(sessionId, attemptId, 'timed_out'),
      this.options.timeoutMs ?? 40_000,
    );
    timer.unref?.();
    this.attempts.set(sessionId, { id: attemptId, observers: [observer], timer });

    // Notifications are deliberately detached: a slow IM request must not
    // postpone replacing the process.
    this.enqueueNotify(observer, 'in_progress');
    try {
      const started = startPhysicalRestart(attemptId);
      void Promise.resolve(started).catch(() => {
        this.resolve(sessionId, attemptId, 'failed');
      });
    } catch {
      this.resolve(sessionId, attemptId, 'failed');
    }
    return { attemptId, joined: false };
  }

  resolve(sessionId: string, attemptId: string, status: RestartTerminalStatus): boolean {
    const attempt = this.attempts.get(sessionId);
    if (!attempt || attempt.id !== attemptId) return false;
    this.attempts.delete(sessionId);
    clearTimeout(attempt.timer);
    for (const observer of attempt.observers) this.enqueueNotify(observer, status);
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
    return true;
  }

  activeAttemptId(sessionId: string): string | undefined {
    return this.attempts.get(sessionId)?.id;
  }

  reset(): void {
    for (const attempt of this.attempts.values()) clearTimeout(attempt.timer);
    this.attempts.clear();
  }

  private async notify(observer: RestartObserver, status: RestartObserverStatus): Promise<void> {
    try {
      await observer.notify(status);
    } catch {
      // Best effort; one observer cannot block the restart or other observers.
    }
  }

  private enqueueNotify(observer: RestartObserver, status: RestartObserverStatus): void {
    const previous = this.notifications.get(observer) ?? Promise.resolve();
    const next = previous.then(() => this.notify(observer, status));
    this.notifications.set(observer, next);
    void next.finally(() => {
      if (this.notifications.get(observer) === next) this.notifications.delete(observer);
    });
  }
}
