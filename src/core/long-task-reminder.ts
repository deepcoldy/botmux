import { createHash } from 'node:crypto';
import type { DaemonSession } from './types.js';
import type { LongTaskReminderConfig } from '../services/long-task-reminder-policy.js';

/** An execution observed at the native input write, never at queue admission. */
export interface LongTaskExecution {
  /** Session whose live worker owns this execution. */
  session: DaemonSession;
  /** Exact turn/attempt key used by the worker execution observations. */
  executionKey: string;
  /** Logical turn used to resolve the original reply destination. */
  turnId: string;
  /** Exact retry/replay attempt; absent for ordinary non-versioned turns. */
  dispatchAttempt?: number;
  /** Epoch milliseconds of the real execution start. */
  startedAtMs: number;
  /** Fences late sends after worker replacement. */
  workerGeneration: number;
}

/** Volatile delivery state: never restore timing without live worker evidence. */
interface ReminderCycle {
  /** Last successful delivery time; absent before the first reminder. */
  lastSentAt?: number;
  /** Retains the same provider dedupe key when a response is ambiguous. */
  uuid?: string;
  /** Bounded backoff after a provider failure, in epoch milliseconds. */
  retryAt?: number;
}

/** Inject runtime/config reads so every delivery can revalidate after awaits. */
export interface LongTaskReminderDeps {
  /** Current per-bot preferences, including edits made while a scan waits. */
  config(): Readonly<LongTaskReminderConfig>;
  /** Current session registry, including removals made while a scan waits. */
  sessions(): Iterable<DaemonSession>;
  /** Whether the session has a real supported IM destination. */
  canSend(session: DaemonSession, turnId: string, dispatchAttempt?: number): boolean;
  /** Send an interactive card, invoking beforeWrite at the provider boundary. */
  send(task: LongTaskExecution, elapsedMinutes: number, uuid: string, beforeWrite: () => void): Promise<void>;
  /** Wall clock is injectable for deterministic timing and concurrency probes. */
  now(): number;
  /** Report failures without stopping reminders for unrelated sessions. */
  onError?(error: unknown): void;
}

/** Return only executions belonging to the current, living worker generation. */
export function runningLongTasks(session: DaemonSession): LongTaskExecution[] {
  if (session.session.status !== 'active' || session.session.queued
    || !session.worker || session.worker.killed) {
    return [];
  }
  /** Each live turn has its own clock, even while a follow-up is being queued. */
  const tasks: LongTaskExecution[] = [];
  // Each native-write observation is scoped to a turn and dispatch attempt.
  for (const [executionKey, observation] of session.replyExecutionStarts ?? []) {
    /** Keys are minted locally by worker-pool at the real native write. */
    const [turnId, dispatchAttempt] = JSON.parse(executionKey) as [string, number | null];
    if (observation.completed || observation.workerGeneration !== session.workerGeneration
      || observation.workerGeneration !== session.session.workerGeneration) {
      continue;
    }
    tasks.push({ session, executionKey, turnId, dispatchAttempt: dispatchAttempt ?? undefined, ...observation });
  }
  return tasks;
}

/**
 * Single-flight scan of live executions with per-task delivery deduplication.
 * Runtime timing is intentionally not persisted or inferred after a restart.
 * @author fangyeqing
 */
export class LongTaskReminderController {
  /** Per-execution delivery windows, pruned whenever execution ends. */
  private readonly cycles = new Map<string, ReminderCycle>();
  /** Prevent overlapping interval ticks from delivering the same cycle twice. */
  private scanning = false;

  /** Bind the live runtime and delivery seams for one bot. */
  constructor(private readonly deps: LongTaskReminderDeps) {}

  /** Identify a worker execution independently of later turns in the session. */
  private key(task: LongTaskExecution): string {
    return JSON.stringify([task.session.session.sessionId, task.workerGeneration, task.executionKey, task.startedAtMs]);
  }

  /** Revalidate configuration, registry membership, worker and terminal state. */
  private due(task: LongTaskExecution, cycle: ReminderCycle): boolean {
    /** Read hot preferences at the instant of evaluation, including disables. */
    const config = this.deps.config();
    /** Elapsed time uses the native start until a successful notification. */
    const base = cycle.lastSentAt ?? task.startedAtMs;
    /** First and repeat windows are independent user-facing settings. */
    const minutes = cycle.lastSentAt === undefined ? config.thresholdMinutes : config.intervalMinutes;
    if (!config.enabled || this.deps.now() - base < minutes * 60_000
      || !this.deps.canSend(task.session, task.turnId, task.dispatchAttempt)) {
      return false;
    }
    // Registry object identity prevents a removed/recreated session from inheriting a send.
    for (const session of this.deps.sessions()) {
      if (session === task.session) {
        return runningLongTasks(session).some(current => this.key(current) === this.key(task));
      }
    }
    return false;
  }

  /** Deliver due cards and discard records for finished, cancelled or removed tasks. */
  async scan(): Promise<void> {
    if (this.scanning) {
      return;
    }
    this.scanning = true;
    try {
      if (!this.deps.config().enabled) {
        this.cycles.clear();
        return;
      }
      /** Snapshot active tasks; each send is fenced again before provider IO. */
      const tasks = Array.from(this.deps.sessions()).flatMap(runningLongTasks);
      /** Only retain records whose exact execution is still observed. */
      const live = new Set(tasks.map(task => this.key(task)));
      // A settled execution no longer owns any retry or repeat-delivery window.
      for (const key of this.cycles.keys()) {
        if (!live.has(key)) {
          this.cycles.delete(key);
        }
      }
      // Evaluate every execution independently so one finished turn cannot silence a sibling.
      for (const task of tasks) {
        /** All retries of an unresolved delivery reuse this cycle object. */
        const key = this.key(task);
        /** No successful send means threshold timing still starts at native write. */
        const cycle = this.cycles.get(key) ?? {};
        this.cycles.set(key, cycle);
        if (!this.due(task, cycle) || this.deps.now() < (cycle.retryAt ?? 0)) {
          continue;
        }
        cycle.uuid ??= `long-task-${createHash('sha256').update(`${key}:${cycle.lastSentAt ?? 'first'}`).digest('hex').slice(0, 32)}`;
        try {
          await this.deps.send(task, Math.floor((this.deps.now() - task.startedAtMs) / 60_000), cycle.uuid, () => {
            if (!this.due(task, cycle)) {
              throw new Error('long_task_reminder_no_longer_due');
            }
          });
          cycle.lastSentAt = this.deps.now();
          cycle.uuid = undefined;
          cycle.retryAt = undefined;
        } catch (error) {
          cycle.retryAt = this.deps.now() + 60_000;
          this.deps.onError?.(error);
        }
      }
    } finally {
      this.scanning = false;
    }
  }
}
