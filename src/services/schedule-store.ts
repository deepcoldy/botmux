import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, statSync, watch } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { dashboardEventBus } from '../core/dashboard-events.js';
import { computeInputHash } from '../workflows/events/idempotency.js';
import type { ScheduledTask, ParsedSchedule } from '../types.js';

// ─── Idempotency types (events doc v0.1.2 §2.2) ─────────────────────────────

/**
 * Raised by `createTask` when an `id` is supplied but a task already exists
 * with that id AND its canonical input differs from the incoming params.
 *
 * Workflow runtime uses this to detect "same attempt asked to create a
 * different schedule" — a sign the attempt is being mutated (forbidden by
 * attempt-immutability rule, events doc §4.2).
 */
export class IdempotencyConflictError extends Error {
  readonly taskId: string;
  readonly existingInputHash: string;
  readonly incomingInputHash: string;
  constructor(detail: {
    taskId: string;
    existingInputHash: string;
    incomingInputHash: string;
  }) {
    super(
      `IdempotencyConflict: schedule task ${detail.taskId} exists with different canonical input ` +
        `(existing=${detail.existingInputHash.substring(0, 18)}…, incoming=${detail.incomingInputHash.substring(0, 18)}…)`,
    );
    this.name = 'IdempotencyConflictError';
    this.taskId = detail.taskId;
    this.existingInputHash = detail.existingInputHash;
    this.incomingInputHash = detail.incomingInputHash;
  }
}

/**
 * Canonical schedule input used for create-or-return-identical comparison.
 *
 * Includes only the fields that callers control as task **input** (events
 * doc v0.1.2 §3.5 ScheduleCanonicalInput).  Excludes:
 *   - `chatType` (advisory, derived)
 *   - `creator*` (audit metadata, not input)
 *   - `enabled`, `nextRunAt`, `lastRunAt`, `lastStatus`, `lastError`,
 *     `lastDeliveryError` (runtime state, mutates over task lifetime)
 *   - `createdAt` (metadata)
 *   - `repeat.completed` (counter, mutates per run)
 *   - `parsed.display` (UI-facing string, redundant given `expr`/`runAt`)
 *
 * Codex round 4 finding 4: `parsed` is NOT purely derived for one-shot or
 * relative schedules.  `30m`/`2h`/`明天9:00`/`5分钟后` etc compute a
 * concrete `runAt` at parse time using "now"; if a workflow retry re-
 * parses the same raw `schedule`, it gets a different `runAt`.  So the
 * canonical input freezes the resolved schedule shape (`parsed.kind` and
 * whichever of `parsed.runAt`/`parsed.minutes`/`parsed.expr` applies).
 */
function canonicalScheduleInput(t: {
  name: string;
  schedule: string;
  parsed?: ParsedSchedule;
  prompt: string;
  workingDir: string;
  chatId: string;
  rootMessageId?: string;
  scope?: 'thread' | 'chat';
  larkAppId?: string;
  repeat?: { times: number | null; completed?: number };
  deliver?: 'origin' | 'local' | 'new-topic';
}): unknown {
  return {
    name: t.name,
    schedule: t.schedule,
    parsed: t.parsed
      ? {
          kind: t.parsed.kind,
          // Only one of these is present per parsed.kind, but inlining all
          // three keeps the canonical shape uniform — `undefined` slots are
          // dropped by `computeInputHash` upstream.
          runAt: t.parsed.runAt,
          minutes: t.parsed.minutes,
          expr: t.parsed.expr,
        }
      : undefined,
    prompt: t.prompt,
    workingDir: t.workingDir,
    chatId: t.chatId,
    rootMessageId: t.rootMessageId,
    scope: t.scope,
    larkAppId: t.larkAppId,
    // Strip `completed` — it mutates after the task starts running, but
    // `times` is the durable user intent.
    repeat: t.repeat ? { times: t.repeat.times } : undefined,
    deliver: t.deliver ?? 'origin',
  };
}

let tasks: Map<string, ScheduledTask> = new Map();
let loaded = false;
let cachedMtime = 0;

function getFilePath(): string {
  return join(config.session.dataDir, 'schedules.json');
}

function getOutputDir(): string {
  return join(config.session.dataDir, 'schedules-output');
}

export function getTaskOutputDir(taskId: string): string {
  return join(getOutputDir(), taskId);
}

function ensureDir(d: string): void {
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
}

/**
 * Migrate legacy schedule task (pre-parsed field) to current shape.
 * Legacy tasks had { type, schedule } only — promote schedule+type into parsed.
 */
function migrate(raw: any): ScheduledTask | null {
  if (!raw || typeof raw !== 'object') return null;

  let parsed: ParsedSchedule | undefined = raw.parsed;
  if (!parsed) {
    // Legacy format: always treat as cron (old parser only produced cron)
    if (raw.type === 'cron' && raw.schedule) {
      parsed = { kind: 'cron', expr: raw.schedule, display: raw.schedule };
    } else if (raw.schedule) {
      // Best-effort fallback
      parsed = { kind: 'cron', expr: raw.schedule, display: raw.schedule };
    } else {
      logger.warn(`[schedule-store] Dropping un-migratable task ${raw.id}: missing schedule`);
      return null;
    }
  }

  return {
    id: raw.id,
    name: raw.name,
    schedule: raw.schedule,
    parsed,
    prompt: raw.prompt,
    workingDir: raw.workingDir,
    chatId: raw.chatId,
    rootMessageId: raw.rootMessageId,
    chatType: raw.chatType,
    larkAppId: raw.larkAppId,
    creatorChatId: raw.creatorChatId,
    creatorRootMessageId: raw.creatorRootMessageId,
    creatorLarkAppId: raw.creatorLarkAppId,
    enabled: raw.enabled !== false,
    createdAt: raw.createdAt,
    lastRunAt: raw.lastRunAt,
    nextRunAt: raw.nextRunAt,
    lastStatus: raw.lastStatus,
    lastError: raw.lastError,
    lastDeliveryError: raw.lastDeliveryError,
    repeat: raw.repeat,
    deliver: raw.deliver ?? 'origin',
  };
}

function load(): void {
  ensureDir(dirname(getFilePath()));
  const fp = getFilePath();
  let currentMtime = 0;
  if (existsSync(fp)) {
    try { currentMtime = statSync(fp).mtimeMs; } catch { /* ignore */ }
  }

  // Reload if file has been modified externally (e.g. by `botmux schedule add`)
  // or on first load.
  if (loaded && currentMtime === cachedMtime) return;

  tasks = new Map();
  if (existsSync(fp)) {
    try {
      const data = JSON.parse(readFileSync(fp, 'utf-8'));
      let migratedCount = 0;
      for (const [id, raw] of Object.entries(data)) {
        const migrated = migrate(raw);
        if (migrated) {
          tasks.set(id, migrated);
          if (!(raw as any).parsed) migratedCount++;
        }
      }
      if (!loaded) {
        logger.info(`Loaded ${tasks.size} scheduled tasks from ${fp}${migratedCount ? ` (migrated ${migratedCount} legacy)` : ''}`);
      } else {
        logger.info(`[schedule-store] Reloaded ${tasks.size} tasks (file mtime changed)`);
      }
      if (migratedCount > 0) save(); // persist migration
    } catch (err) {
      logger.error(`Failed to load schedules: ${err}`);
      tasks = new Map();
    }
  }
  cachedMtime = currentMtime;
  loaded = true;
}

function save(): void {
  ensureDir(dirname(getFilePath()));
  const fp = getFilePath();
  const tmpFp = fp + '.tmp';
  const obj: Record<string, ScheduledTask> = {};
  for (const [k, v] of tasks) obj[k] = v;
  writeFileSync(tmpFp, JSON.stringify(obj, null, 2), 'utf-8');
  renameSync(tmpFp, fp);
  try { cachedMtime = statSync(fp).mtimeMs; } catch { /* ignore */ }
}

/**
 * Create a scheduled task — or return the existing one with the same input
 * when called with a workflow-supplied `id` that already exists.
 *
 * Behaviour matrix (events doc v0.1.2 §2.2 Option A):
 *
 *   | scenario                                   | result                       |
 *   |--------------------------------------------|------------------------------|
 *   | no `id`                                    | randomUUID(8) — legacy path  |
 *   | `id` not in store                          | create with the given id     |
 *   | `id` in store + canonical input matches    | return existing (no mutation)|
 *   | `id` in store + canonical input differs    | IdempotencyConflictError     |
 *
 * Use `wf_<hash...>` prefixed ids when called from workflow runtime to
 * avoid collisions with the 8-char randomUUID legacy namespace.
 */
export function createTask(params: {
  id?: string;
  name: string;
  schedule: string;
  parsed: ParsedSchedule;
  prompt: string;
  workingDir: string;
  chatId: string;
  rootMessageId?: string;
  scope?: 'thread' | 'chat';
  chatType?: 'group' | 'p2p' | 'topic_group';
  larkAppId?: string;
  creatorChatId?: string;
  creatorRootMessageId?: string;
  creatorLarkAppId?: string;
  nextRunAt?: string;
  repeat?: { times: number | null; completed: number };
  deliver?: 'origin' | 'local' | 'new-topic';
}): ScheduledTask {
  load();

  if (params.id) {
    const existing = tasks.get(params.id);
    if (existing) {
      const existingHash = computeInputHash(canonicalScheduleInput(existing));
      const incomingHash = computeInputHash(canonicalScheduleInput(params));
      if (existingHash === incomingHash) {
        // create-or-return-identical: same id + same canonical input → no-op.
        // Do NOT mutate `enabled`, `nextRunAt`, `lastRunAt` etc — those are
        // runtime state that the caller has no business overwriting via the
        // create path.  Use `updateTask` / `enableTask` for those.
        logger.debug(
          `[schedule-store] createTask: returning existing task ${params.id} (canonical input identical)`,
        );
        return existing;
      }
      throw new IdempotencyConflictError({
        taskId: params.id,
        existingInputHash: existingHash,
        incomingInputHash: incomingHash,
      });
    }
    // id given but new task — fall through to create with that id.
  }

  const task: ScheduledTask = {
    id: params.id ?? randomUUID().substring(0, 8),
    name: params.name,
    schedule: params.schedule,
    parsed: params.parsed,
    prompt: params.prompt,
    workingDir: params.workingDir,
    chatId: params.chatId,
    rootMessageId: params.rootMessageId,
    scope: params.scope,
    chatType: params.chatType,
    larkAppId: params.larkAppId,
    creatorChatId: params.creatorChatId,
    creatorRootMessageId: params.creatorRootMessageId,
    creatorLarkAppId: params.creatorLarkAppId,
    enabled: true,
    createdAt: new Date().toISOString(),
    nextRunAt: params.nextRunAt,
    repeat: params.repeat,
    deliver: params.deliver ?? 'origin',
  };
  tasks.set(task.id, task);
  save();
  return task;
}

export function getTask(id: string): ScheduledTask | undefined {
  load();
  return tasks.get(id);
}

export function removeTask(id: string): boolean {
  load();
  const existed = tasks.delete(id);
  if (existed) {
    save();
    logger.info(`[schedule-store] Removed task ${id}`);
  }
  return existed;
}

export function updateTask(
  id: string,
  updates: Partial<Pick<ScheduledTask,
    'enabled' | 'lastRunAt' | 'nextRunAt' | 'lastStatus' | 'lastError' | 'lastDeliveryError' | 'repeat' | 'rootMessageId' | 'chatType' | 'deliver'
  >>,
): void {
  load();
  const task = tasks.get(id);
  if (task) {
    Object.assign(task, updates);
    save();
  }
}

/**
 * Record a run outcome and auto-manage repeat counter.  If the task has a
 * finite repeat count and we've hit it, the task is removed.
 */
export function markRun(id: string, success: boolean, error?: string, deliveryError?: string): void {
  load();
  const task = tasks.get(id);
  if (!task) return;

  const now = new Date().toISOString();
  task.lastRunAt = now;
  task.lastStatus = success ? 'ok' : 'error';
  task.lastError = success ? undefined : error;
  task.lastDeliveryError = deliveryError;

  // Advance repeat counter
  if (task.repeat) {
    task.repeat.completed = (task.repeat.completed ?? 0) + 1;
    const times = task.repeat.times;
    if (times !== null && times !== undefined && times > 0 && task.repeat.completed >= times) {
      tasks.delete(id);
      save();
      logger.info(`[schedule-store] Task ${id} removed after completing ${times} runs`);
      return;
    }
  }

  // One-shot: disable after run. Otherwise next_run was already advanced by scheduler.
  if (task.parsed.kind === 'once') {
    task.enabled = false;
    task.nextRunAt = undefined;
  }
  save();
}

export function listTasks(): ScheduledTask[] {
  load();
  return [...tasks.values()];
}

/** Ensure per-task output dir exists and return path to today's run log. */
export function appendOutputLog(taskId: string, content: string): string {
  const dir = getTaskOutputDir(taskId);
  ensureDir(dir);
  const fname = new Date().toISOString().replace(/[:.]/g, '-') + '.md';
  const fp = join(dir, fname);
  writeFileSync(fp, content, 'utf-8');
  return fp;
}

/**
 * Watch schedules.json for changes from external processes (e.g. `botmux
 * schedule add` running outside the daemon) and emit dashboard events for
 * the diff. Idempotent — calling twice is a no-op.
 *
 * The existing `load()` already reloads when the on-disk mtime differs from
 * `cachedMtime`, so this watcher just snapshots the in-memory map, calls
 * `load()` to refresh, then diffs and publishes. fs.watch can fire multiple
 * events for one logical write — the mtime guard inside `load()` makes
 * redundant fires no-ops, and an unchanged diff produces no events anyway.
 */
let watcherStarted = false;
export function startExternalWriteWatcher(): void {
  if (watcherStarted) return;
  watcherStarted = true;

  // Make sure the data dir + file exist before we try to watch — fs.watch on
  // a non-existent path throws ENOENT.
  ensureDir(dirname(getFilePath()));
  const fp = getFilePath();
  if (!existsSync(fp)) {
    try { writeFileSync(fp, '{}', 'utf-8'); } catch { /* best effort */ }
  }
  // Prime cachedMtime so the first watcher fire is comparable.
  load();

  try {
    watch(fp, { persistent: false }, () => {
      try {
        if (!existsSync(fp)) return;
        const stat = statSync(fp);
        if (stat.mtimeMs <= cachedMtime) return; // no real change since last reload

        // Snapshot in-memory state, then let load() refresh from disk.
        // load() compares mtime internally and updates cachedMtime.
        const before = new Map<string, ScheduledTask>();
        for (const [k, v] of tasks) before.set(k, v);
        load();

        // Diff and publish.
        for (const [id, t] of tasks) {
          const prev = before.get(id);
          if (!prev) {
            dashboardEventBus.publish({ type: 'schedule.created', body: { schedule: t } });
          } else if (JSON.stringify(prev) !== JSON.stringify(t)) {
            dashboardEventBus.publish({ type: 'schedule.updated', body: { id, patch: t } });
          }
        }
        for (const id of before.keys()) {
          if (!tasks.has(id)) {
            dashboardEventBus.publish({ type: 'schedule.deleted', body: { id } });
          }
        }
      } catch (err) {
        logger.debug(`[schedule-store] watch handler error: ${err}`);
      }
    });
    logger.info(`[schedule-store] Watching ${fp} for external writes`);
  } catch (err: any) {
    logger.warn(`[schedule-store] Failed to start file watcher: ${err.message}`);
  }
}
