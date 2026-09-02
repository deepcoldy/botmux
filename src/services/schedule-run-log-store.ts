/**
 * Private, per-bot execution history for scheduled tasks.
 *
 * Each task owns one append-ordered JSONL file under its bot's BOT_HOME. The
 * task id is never used as a path segment directly, and persisted records are
 * projected onto the public type below so prompts, Bash source/output, and
 * model output cannot be written accidentally by a wider runtime object.
 */
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { botHomePath } from '../adapters/cli/read-isolation.js';
import { config } from '../config.js';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { withFileLockSync } from '../utils/file-lock.js';

export const MAX_SCHEDULE_RUN_LOG_ENTRIES = 100;
export const MAX_SCHEDULE_RUN_LOG_ERROR_BYTES = 2 * 1024;

export type ScheduleRunTrigger = 'scheduler' | 'dashboard';
export type ScheduleRunOutcome = 'model_dispatched' | 'precondition_skipped' | 'error';
export type ScheduleRunPrecondition = 'none' | 'disabled' | 'passed' | 'skipped' | 'error';

export interface ScheduleRunLogEntry {
  id: string;
  taskId: string;
  trigger: ScheduleRunTrigger;
  outcome: ScheduleRunOutcome;
  precondition: ScheduleRunPrecondition;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  /** Whether the Bash gate supplied extra prompt content; never stores it. */
  additionalPrompt: boolean;
  errorCode?: string;
  error?: string;
}

export interface ScheduleRunLogQueryOptions {
  limit?: number;
  offset?: number;
}

export interface ScheduleRunLogPage {
  logs: ScheduleRunLogEntry[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

const TRIGGERS = new Set<ScheduleRunTrigger>(['scheduler', 'dashboard']);
const OUTCOMES = new Set<ScheduleRunOutcome>([
  'model_dispatched',
  'precondition_skipped',
  'error',
]);
const PRECONDITIONS = new Set<ScheduleRunPrecondition>([
  'none',
  'disabled',
  'passed',
  'skipped',
  'error',
]);

function assertNonEmpty(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`[schedule-run-log] ${label} must be a non-empty string`);
  }
}

function isCanonicalIsoDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const millis = Date.parse(value);
  return Number.isFinite(millis) && new Date(millis).toISOString() === value;
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  let result = '';
  let bytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, 'utf8');
    if (bytes + characterBytes > maxBytes) break;
    result += character;
    bytes += characterBytes;
  }
  return result;
}

function normalizeLimit(value: unknown): number {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) return 20;
  return Math.max(1, Math.min(Math.floor(number), MAX_SCHEDULE_RUN_LOG_ENTRIES));
}

function normalizeOffset(value: unknown): number {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.floor(number));
}

/** `<BOT_HOME>/schedule-runs`, kept private to the owning bot. */
export function scheduleRunLogDirectory(
  appId: string,
  dataDir: string = config.session.dataDir,
): string {
  assertNonEmpty(appId, 'appId');
  assertNonEmpty(dataDir, 'dataDir');
  return join(botHomePath(dirname(dataDir), appId), 'schedule-runs');
}

/** Exported for callers/tests; the returned filename contains no raw task id. */
export function scheduleRunLogPath(
  taskId: string,
  appId: string,
  dataDir: string = config.session.dataDir,
): string {
  assertNonEmpty(taskId, 'taskId');
  const digest = createHash('sha256').update(taskId, 'utf8').digest('hex');
  return join(scheduleRunLogDirectory(appId, dataDir), `${digest}.jsonl`);
}

function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`[schedule-run-log] storage path is not a real directory: ${path}`);
  }
  chmodSync(path, 0o700);
}

function assertRegularFile(path: string): boolean {
  if (!existsSync(path)) return false;
  let stat: import('node:fs').Stats;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`[schedule-run-log] storage path is not a real file: ${path}`);
  }
  return true;
}

function projectEntry(value: unknown, expectedTaskId?: string): ScheduleRunLogEntry | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (
    typeof raw.id !== 'string' || raw.id.length === 0 ||
    typeof raw.taskId !== 'string' || raw.taskId.length === 0 ||
    (expectedTaskId !== undefined && raw.taskId !== expectedTaskId) ||
    !TRIGGERS.has(raw.trigger as ScheduleRunTrigger) ||
    !OUTCOMES.has(raw.outcome as ScheduleRunOutcome) ||
    !PRECONDITIONS.has(raw.precondition as ScheduleRunPrecondition) ||
    !isCanonicalIsoDate(raw.startedAt) ||
    !isCanonicalIsoDate(raw.finishedAt) ||
    typeof raw.durationMs !== 'number' || !Number.isFinite(raw.durationMs) || raw.durationMs < 0 ||
    typeof raw.additionalPrompt !== 'boolean' ||
    (raw.errorCode !== undefined && typeof raw.errorCode !== 'string') ||
    (raw.error !== undefined && typeof raw.error !== 'string')
  ) {
    return undefined;
  }

  return {
    id: raw.id,
    taskId: raw.taskId,
    trigger: raw.trigger as ScheduleRunTrigger,
    outcome: raw.outcome as ScheduleRunOutcome,
    precondition: raw.precondition as ScheduleRunPrecondition,
    startedAt: raw.startedAt,
    finishedAt: raw.finishedAt,
    durationMs: raw.durationMs,
    additionalPrompt: raw.additionalPrompt,
    ...(raw.errorCode !== undefined ? { errorCode: raw.errorCode } : {}),
    ...(raw.error !== undefined
      ? { error: truncateUtf8(raw.error, MAX_SCHEDULE_RUN_LOG_ERROR_BYTES) }
      : {}),
  };
}

function normalizeEntry(entry: ScheduleRunLogEntry): ScheduleRunLogEntry {
  const normalized = projectEntry(entry, entry.taskId);
  if (!normalized) throw new Error('[schedule-run-log] entry failed schema validation');
  return normalized;
}

function readEntries(path: string, taskId: string): ScheduleRunLogEntry[] {
  if (!assertRegularFile(path)) return [];
  const entries: ScheduleRunLogEntry[] = [];
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    if (!line) continue;
    try {
      const entry = projectEntry(JSON.parse(line), taskId);
      if (entry) entries.push(entry);
    } catch {
      // A torn/manual/corrupt line must not hide the remaining history.
    }
  }
  return entries;
}

function serialize(entries: readonly ScheduleRunLogEntry[]): string {
  if (entries.length === 0) return '';
  return `${entries.map(entry => JSON.stringify(entry)).join('\n')}\n`;
}

/**
 * Append one record and retain only the latest 100 valid records. The complete
 * read/append/trim/replace transaction is serialized across daemon processes.
 */
export function appendScheduleRunLog(
  entry: ScheduleRunLogEntry,
  appId: string,
  dataDir: string = config.session.dataDir,
): ScheduleRunLogEntry {
  const normalized = normalizeEntry(entry);
  const path = scheduleRunLogPath(normalized.taskId, appId, dataDir);
  ensurePrivateDirectory(dirname(path));
  return withFileLockSync(path, () => {
    const entries = readEntries(path, normalized.taskId);
    entries.push(normalized);
    const retained = entries.slice(-MAX_SCHEDULE_RUN_LOG_ENTRIES);
    atomicWriteFileSync(path, serialize(retained), {
      mode: 0o600,
      followTargetSymlink: false,
    });
    return normalized;
  });
}

/** Query one task's retained history, newest append first. */
export function queryScheduleRunLogs(
  taskId: string,
  opts: ScheduleRunLogQueryOptions,
  appId: string,
  dataDir: string = config.session.dataDir,
): ScheduleRunLogPage {
  const limit = normalizeLimit(opts?.limit);
  const offset = normalizeOffset(opts?.offset);
  const path = scheduleRunLogPath(taskId, appId, dataDir);
  const logs = readEntries(path, taskId).slice(-MAX_SCHEDULE_RUN_LOG_ENTRIES).reverse();
  return {
    logs: logs.slice(offset, offset + limit),
    total: logs.length,
    limit,
    offset,
    hasMore: offset + limit < logs.length,
  };
}

/** Delete only the selected task's history. Returns whether a file existed. */
export function removeScheduleRunLogs(
  taskId: string,
  appId: string,
  dataDir: string = config.session.dataDir,
): boolean {
  const path = scheduleRunLogPath(taskId, appId, dataDir);
  if (!existsSync(dirname(path))) return false;
  return withFileLockSync(path, () => {
    if (!assertRegularFile(path)) return false;
    unlinkSync(path);
    return true;
  });
}
