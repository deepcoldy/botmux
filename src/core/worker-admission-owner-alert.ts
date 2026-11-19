import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { t, type Locale } from '../i18n/index.js';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { FileLockTimeoutError, withFileLockSync } from '../utils/file-lock.js';
import { BoundedMap } from '../utils/bounded-map.js';
import { formatMemoryBytes, type WorkerAdmissionDecision } from './worker-budget.js';

/** Host diagnostics require the application's CURRENT runtime owner. A raw
 * setup owner can have been revoked while a replacement remains unresolved. */
export function resolveWorkerAdmissionOwner(appId: string, registry: {
  getBot(appId: string): { config: { apiOnly?: boolean } };
  getOwnerOpenId(appId: string): string | undefined;
}): string | undefined {
  return registry.getBot(appId).config.apiOnly ? undefined : registry.getOwnerOpenId(appId);
}

export function formatWorkerAdmissionOwnerAlert(
  botName: string, decision: WorkerAdmissionDecision, affectedSessions: number, locale: Locale,
): string {
  return t('worker.memory_admission_owner_alert', {
    botName,
    count: affectedSessions,
    available: decision.pressure.availableMemoryBytes === undefined
      ? '?' : formatMemoryBytes(decision.pressure.availableMemoryBytes),
    reserve: formatMemoryBytes(decision.policy.minAvailableMemoryBytes),
    psi: decision.pressure.memoryFullAvg10 === undefined
      ? '?' : decision.pressure.memoryFullAvg10.toFixed(2),
    psiLimit: decision.policy.maxMemoryFullAvg10.toFixed(2),
    reason: decision.reasons.join('; '),
  }, locale);
}

interface AlertDependencies {
  dataDir: string;
  ownerForApp: (appId: string) => string | undefined;
  botForApp: (appId: string) => { name: string; locale: Locale };
  send: (appId: string, ownerOpenId: string, content: string) => Promise<unknown>;
  onError: (message: string) => void;
  batchMs?: number;
  cooldownMs?: number;
}

interface PendingAlert {
  sessions: Set<string>;
  decision: WorkerAdmissionDecision;
  timer: ReturnType<typeof setTimeout>;
}

/** Best-effort owner DMs, batched per bot. The recipient-scoped claim survives
 * daemon restarts and serializes duplicate daemons. It limits send ATTEMPTS,
 * including transport failures, so an outage cannot become another flood.
 * A later rejection after the cooldown can retry a failed DM. */
export class WorkerAdmissionOwnerAlerts {
  private readonly pending = new Map<string, PendingAlert>();
  private readonly lastAttempts = new BoundedMap<string, number>(256);
  private readonly batchMs: number;
  private readonly cooldownMs: number;
  private disposed = false;

  constructor(private readonly deps: AlertDependencies) {
    this.batchMs = deps.batchMs ?? 2_000;
    this.cooldownMs = deps.cooldownMs ?? 5 * 60_000;
  }

  report(appId: string, sessionId: string, decision: WorkerAdmissionDecision): void {
    if (this.disposed || decision.allowed) return;
    const existing = this.pending.get(appId);
    if (existing) {
      existing.sessions.add(sessionId);
      existing.decision = decision;
      return;
    }
    const timer = setTimeout(() => this.flush(appId), this.batchMs);
    timer.unref?.();
    this.pending.set(appId, { sessions: new Set([sessionId]), decision, timer });
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
      const dir = join(this.deps.dataDir, '.worker-admission-alerts');
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
        this.deps.onError(`No bot owner is available for worker admission alert (${appId})`);
        return;
      }
      const bot = this.deps.botForApp(appId);
      const content = formatWorkerAdmissionOwnerAlert(bot.name, alert.decision, alert.sessions.size, bot.locale);
      if (!this.claim(appId, owner)) return;
      void Promise.resolve().then(() => this.deps.send(appId, owner, content))
        .catch(error => this.deps.onError(`Worker admission owner DM failed (${appId}): ${String(error)}`));
    } catch (error) {
      this.deps.onError(`Worker admission owner alert failed (${appId}): ${String(error)}`);
    }
  }
}
