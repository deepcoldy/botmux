import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Locale } from '../i18n/index.js';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { FileLockTimeoutError, withFileLockSync } from '../utils/file-lock.js';
import { BoundedMap } from '../utils/bounded-map.js';

export interface OwnerAlertDependencies {
  dataDir: string;
  ownerForApp: (appId: string) => string | undefined;
  botForApp: (appId: string) => { name: string; locale: Locale };
  send: (appId: string, ownerOpenId: string, content: string) => Promise<unknown>;
  onError: (message: string) => void;
  batchMs?: number;
  cooldownMs?: number;
}

interface PendingAlert<T> {
  sessions: Set<string>;
  payload: T;
  timer: ReturnType<typeof setTimeout>;
}

/** Best-effort owner DMs, batched per bot. The recipient-scoped claim survives
 * daemon restarts and serializes duplicate daemons. It limits send ATTEMPTS,
 * including transport failures, so an outage cannot become another flood.
 * A later rejection after the cooldown can retry a failed DM. */
export class OwnerAlertBatcher<T> {
  private readonly pending = new Map<string, PendingAlert<T>>();
  private readonly lastAttempts = new BoundedMap<string, number>(256);
  private readonly batchMs: number;
  private readonly cooldownMs: number;
  private disposed = false;

  constructor(
    private readonly deps: OwnerAlertDependencies,
    private readonly namespace: 'worker-admission-alerts' | 'worker-startup-alerts' | 'worker-install-alerts',
    private readonly format: (bot: { name: string; locale: Locale }, payload: T, sessions: number) => string,
  ) {
    this.batchMs = deps.batchMs ?? 2_000;
    this.cooldownMs = deps.cooldownMs ?? 5 * 60_000;
  }

  report(appId: string, sessionId: string, payload: T): void {
    if (this.disposed) return;
    const existing = this.pending.get(appId);
    if (existing) {
      existing.sessions.add(sessionId);
      existing.payload = payload;
      return;
    }
    const timer = setTimeout(() => this.flush(appId), this.batchMs);
    timer.unref?.();
    this.pending.set(appId, { sessions: new Set([sessionId]), payload, timer });
  }

  dispose(): void {
    this.disposed = true;
    for (const alert of this.pending.values()) clearTimeout(alert.timer);
    this.pending.clear();
  }

  private claim(appId: string, ownerOpenId: string): boolean {
    const key = createHash('sha256').update(JSON.stringify([appId, ownerOpenId])).digest('hex');
    const now = Date.now();
    const recent = (at: unknown): at is number => typeof at === 'number'
      && Number.isFinite(at) && Math.abs(now - at) < this.cooldownMs;
    if (recent(this.lastAttempts.get(key))) return false;
    try {
      const dir = join(this.deps.dataDir, '.' + this.namespace);
      mkdirSync(dir, { recursive: true });
      const marker = join(dir, `${key}.json`);
      const claimed = withFileLockSync(marker, () => {
        try {
          const previous = JSON.parse(readFileSync(marker, 'utf8')) as { at?: unknown };
          if (recent(previous?.at)) return { allowed: false, at: previous.at };
        } catch { /* Missing/corrupt marker permits a fresh claim. */ }
        atomicWriteFileSync(marker, JSON.stringify({ at: now }));
        return { allowed: true, at: now };
      }, { maxWaitMs: 250 });
      this.lastAttempts.set(key, claimed.at);
      return claimed.allowed;
    } catch (error) {
      // A live claimant may still send. Retrying on a later rejection after
      // its lock releases is safer than sending a duplicate now.
      if (error instanceof FileLockTimeoutError) {
        this.deps.onError(`Owner alert claim is busy; deferred (${appId})`);
        return false;
      }
      this.lastAttempts.set(key, now);
      this.deps.onError(`Owner alert cooldown could not be persisted: ${String(error)}`);
      return true; // Retain local throttling when the filesystem is unavailable.
    }
  }

  private flush(appId: string): void {
    const alert = this.pending.get(appId);
    if (!alert) return;
    this.pending.delete(appId);
    try {
      // Resolve at delivery time so a pending batch follows an owner change;
      // an open_id is only ever sent through its own bot's application.
      const owner = this.deps.ownerForApp(appId);
      if (!owner) {
        this.deps.onError(`No bot owner is available for ${this.namespace} alert (${appId})`);
        return;
      }
      const bot = this.deps.botForApp(appId);
      const content = this.format(bot, alert.payload, alert.sessions.size);
      if (!this.claim(appId, owner)) return;
      void Promise.resolve().then(() => this.deps.send(appId, owner, content))
        .catch(error => this.deps.onError(`Owner diagnostic DM failed (${appId}): ${String(error)}`));
    } catch (error) {
      this.deps.onError(`Owner diagnostic alert failed (${appId}): ${String(error)}`);
    }
  }
}
