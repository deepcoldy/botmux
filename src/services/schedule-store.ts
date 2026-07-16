import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  watch,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { dashboardEventBus } from '../core/dashboard-events.js';
import { computeInputHash } from '../utils/canonical-input-hash.js';
import { withFileLockSync } from '../utils/file-lock.js';
import { fsyncDirectorySyncPortable } from '../utils/fs-durability.js';
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
export function canonicalScheduleInput(t: {
  name: string;
  schedule: string;
  parsed?: ParsedSchedule;
  prompt: string;
  workingDir: string;
  chatId: string;
  chatType?: 'group' | 'p2p' | 'topic_group';
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
    // This changes how the future worker session replies (especially P2P), so
    // it is provider input rather than advisory display metadata.
    chatType: t.chatType,
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
let cachedFileVersion = 'missing';

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

function fileVersion(fp: string): string {
  try {
    const stat = statSync(fp);
    // Atomic rename can replace a file without advancing mtime on coarse
    // filesystems. Include inode/size/ctime so a stale process notices the
    // replacement before serving another read.
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
  } catch (err: any) {
    if (err?.code === 'ENOENT') return 'missing';
    throw err;
  }
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
    scope: raw.scope === 'thread' || raw.scope === 'chat' ? raw.scope : undefined,
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

interface DiskSnapshot {
  map: Map<string, ScheduledTask>;
  migratedCount: number;
}

function readDiskSnapshot(fp: string, strict: boolean): DiskSnapshot {
  const map = new Map<string, ScheduledTask>();
  if (!existsSync(fp)) return { map, migratedCount: 0 };

  try {
    const data = JSON.parse(readFileSync(fp, 'utf-8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error('schedules.json root must be an object');
    }
    let migratedCount = 0;
    for (const [id, raw] of Object.entries(data)) {
      const migrated = migrate(raw);
      if (migrated) {
        map.set(id, migrated);
        if (!(raw as any).parsed) migratedCount++;
      }
    }
    return { map, migratedCount };
  } catch (err) {
    if (strict) throw err;
    logger.error(`Failed to load schedules: ${err}`);
    return { map: new Map(), migratedCount: 0 };
  }
}

function serializeTasks(map: ReadonlyMap<string, ScheduledTask>): string {
  const obj: Record<string, ScheduledTask> = {};
  for (const [id, task] of map) obj[id] = task;
  return JSON.stringify(obj, null, 2);
}

// Deliberately inert outside Vitest. This lets the durability regression test
// inject a failure after the temp file is fsynced but before the atomic rename,
// without weakening or monkey-patching Node's filesystem API in production.
let beforeRenameTestHook: (() => void) | undefined;
export function __setScheduleStoreBeforeRenameTestHook(hook?: () => void): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('schedule-store persistence hook is test-only');
  }
  beforeRenameTestHook = hook;
}

/**
 * Crash-durable replace. The random O_EXCL temp prevents two writers from
 * sharing a staging file; the caller's schedules.json lock serializes the
 * reload/mutate/commit transaction. The old file remains authoritative until
 * rename, and the parent fsync makes the rename durable before callers see the
 * new in-memory snapshot.
 */
function persistDiskSnapshot(fp: string, map: ReadonlyMap<string, ScheduledTask>): void {
  const parent = dirname(fp);
  ensureDir(parent);
  const tmpFp = join(
    parent,
    `.${basename(fp)}.tmp.${process.pid}.${randomBytes(8).toString('hex')}`,
  );
  let fd: number | undefined;
  let renamed = false;
  try {
    fd = openSync(
      tmpFp,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    writeFileSync(fd, serializeTasks(map), 'utf-8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    beforeRenameTestHook?.();
    renameSync(tmpFp, fp);
    renamed = true;
    fsyncDirectorySyncPortable(parent);
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* best effort */ }
    }
    if (!renamed) {
      try { unlinkSync(tmpFp); } catch { /* absent or already cleaned */ }
    }
  }
}

function installSnapshot(map: Map<string, ScheduledTask>, fp: string): void {
  tasks = map;
  cachedFileVersion = fileVersion(fp);
  loaded = true;
}

interface MutationResult<T> {
  result: T;
  changed: boolean;
}

/**
 * Every schedules.json mutation goes through one cross-process transaction:
 * lock -> force reload -> mutate an isolated map -> durable replace -> publish
 * to memory. A failed write therefore cannot create an in-memory ghost, and a
 * stale daemon/CLI process cannot overwrite another process's newer update.
 */
function mutateTasks<T>(
  mutate: (working: Map<string, ScheduledTask>) => MutationResult<T>,
): T {
  const fp = getFilePath();
  ensureDir(dirname(fp));
  return withFileLockSync(fp, () => {
    const working = readDiskSnapshot(fp, true).map;
    const outcome = mutate(working);
    if (outcome.changed) persistDiskSnapshot(fp, working);
    // Install only after the commit succeeds. No-op/idempotent mutations still
    // refresh a stale process from the authoritative disk snapshot.
    installSnapshot(working, fp);
    return outcome.result;
  });
}

function load(): void {
  ensureDir(dirname(getFilePath()));
  const fp = getFilePath();
  const currentVersion = fileVersion(fp);

  // Reload if the file has been atomically replaced externally (e.g. by
  // `botmux schedule add`) or on first load.
  if (loaded && currentVersion === cachedFileVersion) return;

  const snapshot = readDiskSnapshot(fp, false);
  let nextMap = snapshot.map;

  // Persist legacy normalization under the same mutation lock. Re-read inside
  // the lock so migration cannot overwrite a concurrent modern writer.
  if (snapshot.migratedCount > 0) {
    try {
      nextMap = withFileLockSync(fp, () => {
        const current = readDiskSnapshot(fp, true);
        if (current.migratedCount > 0) persistDiskSnapshot(fp, current.map);
        return current.map;
      });
    } catch (err) {
      // Reading remains backward compatible even if the optional normalization
      // write fails. Future mutations still fail closed on malformed storage.
      logger.error(`[schedule-store] Failed to persist legacy migration: ${err}`);
      // A different process may have committed between our optimistic read and
      // lock acquisition. Never pair that newer file version with the stale
      // pre-lock map, or this process could serve stale data indefinitely.
      nextMap = readDiskSnapshot(fp, false).map;
    }
  }

  if (!loaded) {
    logger.info(
      `Loaded ${nextMap.size} scheduled tasks from ${fp}` +
      `${snapshot.migratedCount ? ` (migrated ${snapshot.migratedCount} legacy)` : ''}`,
    );
  } else {
    logger.info(`[schedule-store] Reloaded ${nextMap.size} tasks (file changed)`);
  }
  installSnapshot(nextMap, fp);
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
  return mutateTasks(working => {
    if (params.id) {
      const existing = working.get(params.id);
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
          return { result: existing, changed: false };
        }
        throw new IdempotencyConflictError({
          taskId: params.id,
          existingInputHash: existingHash,
          incomingInputHash: incomingHash,
        });
      }
      // id given but new task — fall through to create with that id.
    }

    let id = params.id ?? randomUUID().substring(0, 8);
    while (!params.id && working.has(id)) id = randomUUID().substring(0, 8);
    const task: ScheduledTask = {
      id,
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
    working.set(task.id, task);
    return { result: task, changed: true };
  });
}

export function getTask(id: string): ScheduledTask | undefined {
  load();
  return tasks.get(id);
}

export function removeTask(id: string): boolean {
  const existed = mutateTasks(working => {
    const removed = working.delete(id);
    return { result: removed, changed: removed };
  });
  if (existed) logger.info(`[schedule-store] Removed task ${id}`);
  return existed;
}

export function updateTask(
  id: string,
  updates: Partial<Pick<ScheduledTask,
    'enabled' | 'lastRunAt' | 'nextRunAt' | 'lastStatus' | 'lastError' | 'lastDeliveryError' | 'repeat' | 'rootMessageId' | 'chatType' | 'deliver'
  >>,
): void {
  mutateTasks(working => {
    const task = working.get(id);
    if (!task) return { result: undefined, changed: false };
    Object.assign(task, updates);
    return { result: undefined, changed: true };
  });
}

/**
 * Record a run outcome and auto-manage repeat counter.  If the task has a
 * finite repeat count and we've hit it, the task is removed.
 */
export function markRun(id: string, success: boolean, error?: string, deliveryError?: string): void {
  const completedRepeat = mutateTasks(working => {
    const task = working.get(id);
    if (!task) return { result: undefined, changed: false };

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
        working.delete(id);
        return { result: times, changed: true };
      }
    }

    // One-shot: disable after run. Otherwise next_run was already advanced by scheduler.
    if (task.parsed.kind === 'once') {
      task.enabled = false;
      task.nextRunAt = undefined;
    }
    return { result: undefined, changed: true };
  });
  if (completedRepeat !== undefined) {
    logger.info(`[schedule-store] Task ${id} removed after completing ${completedRepeat} runs`);
  }
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
 * The existing `load()` already reloads when the on-disk file identity differs
 * from `cachedFileVersion`, so this watcher snapshots the in-memory map, calls
 * `load()` to refresh, then diffs and publishes. fs.watch can fire multiple
 * events for one logical write — the identity guard inside `load()` makes
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
    try {
      mutateTasks(working => ({ result: undefined, changed: !existsSync(fp) && working.size === 0 }));
    } catch { /* best effort */ }
  }
  // Prime the cached file identity so the first watcher fire is comparable.
  load();

  try {
    // Watch the directory, not the file inode: every commit atomically replaces
    // schedules.json, so a file-level watcher would remain attached to the old
    // inode after the first external write.
    watch(dirname(fp), { persistent: false }, (_eventType, filename) => {
      try {
        if (filename && filename.toString() !== basename(fp)) return;
        if (!existsSync(fp)) return;
        if (fileVersion(fp) === cachedFileVersion) return;

        // Snapshot in-memory state, then let load() refresh from disk.
        // load() compares file identity internally and updates the cache.
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
