/**
 * Daemon-owned storage for schedule Bash preconditions.
 *
 * The schedule row is intentionally limited to an opaque `preconditionRef`.
 * Executable source definitions live below a host-only root that the worker
 * sandbox denies.
 * A record is addressed by hashes of its owner/task identity, but also embeds
 * and validates that identity so a misplaced file can never acquire authority.
 */
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
} from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { config } from '../config.js';
import type { ScheduledTask } from '../types.js';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { computeInputHash } from '../utils/canonical-input-hash.js';
import { withFileLockSync } from '../utils/file-lock.js';
import { fsyncDirectorySyncPortable } from '../utils/fs-durability.js';
import { canonicalScheduleInput } from './schedule-store.js';

const ROOT_DIRECTORY = 'schedule-preconditions';
const TRUSTED_FILES_DIRECTORY = 'trusted-files';
const TRUSTED_FILE_EXAMPLE = 'check-ready.sh';
const RECORD_SCHEMA_VERSION = 2;
const REF_PATTERN = /^spc_[A-Za-z0-9_-]{43}$/;
const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/;
const MAX_RECORD_BYTES = 512 * 1024;

export const MAX_SCHEDULE_PRECONDITION_SCRIPT_BYTES = 64 * 1024;
export const MAX_SCHEDULE_PRECONDITION_FILE_PATH_BYTES = 16 * 1024;

export type SchedulePreconditionStoreErrorCode =
  | 'invalid_input'
  | 'unsafe_layout'
  | 'unreadable_record'
  | 'corrupt_record'
  | 'identity_mismatch'
  | 'transition_conflict'
  | 'sidecar_missing'
  | 'precondition_ref_mismatch'
  | 'precondition_pending'
  | 'canonical_input_mismatch'
  | 'task_instance_mismatch'
  | 'task_owner_mismatch';

export class SchedulePreconditionStoreError extends Error {
  readonly code: SchedulePreconditionStoreErrorCode;
  readonly storagePath?: string;

  constructor(
    code: SchedulePreconditionStoreErrorCode,
    message: string,
    options: { storagePath?: string; cause?: unknown } = {},
  ) {
    super(`[schedule-precondition] ${code}: ${message}`, { cause: options.cause });
    this.name = 'SchedulePreconditionStoreError';
    this.code = code;
    this.storagePath = options.storagePath;
  }
}

export type SchedulePreconditionSource =
  | { kind: 'inline'; script: string }
  | { kind: 'file'; path: string };

export interface SchedulePreconditionDefinition {
  enabled: boolean;
  source: SchedulePreconditionSource;
}

interface SchedulePreconditionBaseRecord extends SchedulePreconditionDefinition {
  schemaVersion: 2;
  state: 'pending' | 'active';
  larkAppId: string;
  taskId: string;
  preconditionRef: string;
  updatedAt: string;
}

export interface PendingSchedulePreconditionRecord extends SchedulePreconditionBaseRecord {
  state: 'pending';
}

export interface ActiveSchedulePreconditionRecord extends SchedulePreconditionBaseRecord {
  state: 'active';
  canonicalInputHash: string;
  taskCreatedAt: string;
}

export type SchedulePreconditionRecord =
  | PendingSchedulePreconditionRecord
  | ActiveSchedulePreconditionRecord;

/** Sensitive rollback material. Keep this value in-process and never log it. */
export type SchedulePreconditionSnapshot =
  | Readonly<{ kind: 'absent' }>
  | Readonly<{ kind: 'record'; record: Readonly<SchedulePreconditionRecord> }>;

export interface StagedSchedulePrecondition {
  preconditionRef: string;
  /** Previous protected value, used only if publication of the task row fails. */
  previous: SchedulePreconditionSnapshot;
}

export type ResolvedSchedulePrecondition =
  | { kind: 'none' }
  | ({ kind: 'configured' } & SchedulePreconditionDefinition);

export type SchedulePreconditionSummary =
  | { hasPrecondition: false }
  | {
      hasPrecondition: true;
      enabled: boolean;
      sourceKind: SchedulePreconditionSource['kind'];
    };

export interface SchedulePreconditionStoreOptions {
  dataDir?: string;
  /** Test-only clock injection. Runtime callers should omit it. */
  now?: () => string;
  /** Test-only nonce injection. Runtime callers should omit it. */
  createRef?: () => string;
}

function fail(
  code: SchedulePreconditionStoreErrorCode,
  message: string,
  storagePath?: string,
  cause?: unknown,
): never {
  throw new SchedulePreconditionStoreError(code, message, { storagePath, cause });
}

function errnoCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error
    ? String((error as NodeJS.ErrnoException).code)
    : undefined;
}

function hashSegment(domain: string, ...parts: string[]): string {
  const hash = createHash('sha256').update(domain, 'utf8');
  for (const part of parts) hash.update('\0').update(part, 'utf8');
  return hash.digest('hex');
}

function assertIdentityPart(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    fail('invalid_input', `${label} must be a non-empty string`);
  }
}

function nowIso(options: SchedulePreconditionStoreOptions): string {
  const value = options.now?.() ?? new Date().toISOString();
  if (!isCanonicalIsoDate(value)) fail('invalid_input', 'clock returned a non-canonical ISO timestamp');
  return value;
}

function isCanonicalIsoDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const millis = Date.parse(value);
  return Number.isFinite(millis) && new Date(millis).toISOString() === value;
}

function validRef(value: unknown): value is string {
  return typeof value === 'string' && REF_PATTERN.test(value);
}

export function validateSchedulePreconditionScript(script: unknown): string {
  if (typeof script !== 'string') fail('invalid_input', 'script must be a string');
  if (script.trim().length === 0) fail('invalid_input', 'script must not be blank');
  if (Buffer.byteLength(script, 'utf8') > MAX_SCHEDULE_PRECONDITION_SCRIPT_BYTES) {
    fail(
      'invalid_input',
      `script exceeds ${MAX_SCHEDULE_PRECONDITION_SCRIPT_BYTES} UTF-8 bytes`,
    );
  }
  return script;
}

export function validateSchedulePreconditionSource(input: unknown): SchedulePreconditionSource {
  if (!isPlainRecord(input)) fail('invalid_input', 'source must be an object');
  if (input.kind === 'inline') {
    if (!hasExactKeys(input, ['kind', 'script'])) {
      fail('invalid_input', 'inline source contains unexpected fields');
    }
    return { kind: 'inline', script: validateSchedulePreconditionScript(input.script) };
  }
  if (input.kind === 'file') {
    if (!hasExactKeys(input, ['kind', 'path'])) {
      fail('invalid_input', 'file source contains unexpected fields');
    }
    if (typeof input.path !== 'string' || input.path.trim().length === 0) {
      fail('invalid_input', 'file path must be a non-blank string');
    }
    if (input.path.includes('\0')) fail('invalid_input', 'file path must not contain NUL');
    if (input.path.startsWith('~')) {
      fail('invalid_input', 'file path must be absolute or relative to the task working directory');
    }
    if (Buffer.byteLength(input.path, 'utf8') > MAX_SCHEDULE_PRECONDITION_FILE_PATH_BYTES) {
      fail(
        'invalid_input',
        `file path exceeds ${MAX_SCHEDULE_PRECONDITION_FILE_PATH_BYTES} UTF-8 bytes`,
      );
    }
    return { kind: 'file', path: input.path };
  }
  fail('invalid_input', 'source kind must be inline or file');
}

export function validateSchedulePreconditionDefinition(
  input: unknown,
): SchedulePreconditionDefinition {
  if (!isPlainRecord(input) || !hasExactKeys(input, ['enabled', 'source'])) {
    fail('invalid_input', 'definition must contain only enabled and source');
  }
  if (typeof input.enabled !== 'boolean') fail('invalid_input', 'enabled must be boolean');
  return {
    enabled: input.enabled,
    source: validateSchedulePreconditionSource(input.source),
  };
}

function normalizeDefinitionInput(input: unknown): SchedulePreconditionDefinition {
  return typeof input === 'string'
    ? { enabled: true, source: { kind: 'inline', script: validateSchedulePreconditionScript(input) } }
    : validateSchedulePreconditionDefinition(input);
}

export function schedulePreconditionRoot(dataDir: string = config.session.dataDir): string {
  assertIdentityPart(dataDir, 'dataDir');
  return join(dataDir, ROOT_DIRECTORY);
}

/** Host directory from which file-backed preconditions are allowed to run. */
export function schedulePreconditionTrustedFilesRoot(
  dataDir: string = config.session.dataDir,
): string {
  // `resolve` makes the value directly copyable in Dashboard even if a test or
  // embedding caller supplied a relative dataDir. Runtime dataDir is already
  // absolute, so this does not change the daemon layout.
  return resolve(schedulePreconditionRoot(dataDir), TRUSTED_FILES_DIRECTORY);
}

/** Copyable starter path shown by Dashboard and documentation. */
export function schedulePreconditionTrustedFileExamplePath(
  dataDir: string = config.session.dataDir,
): string {
  return join(schedulePreconditionTrustedFilesRoot(dataDir), TRUSTED_FILE_EXAMPLE);
}

function ownerDirectory(appId: string, dataDir?: string): string {
  return join(
    schedulePreconditionRoot(dataDir),
    hashSegment('botmux.schedule-precondition.owner.v1', appId),
  );
}

/** Exported for sandbox policy/tests; the returned path contains no raw ids. */
export function schedulePreconditionPath(
  appId: string,
  taskId: string,
  dataDir?: string,
): string {
  assertIdentityPart(appId, 'appId');
  assertIdentityPart(taskId, 'taskId');
  return join(
    ownerDirectory(appId, dataDir),
    `${hashSegment('botmux.schedule-precondition.record.v1', appId, taskId)}.json`,
  );
}

function lstatOptional(path: string): import('node:fs').Stats | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return undefined;
    fail('unsafe_layout', 'could not inspect protected storage', path, error);
  }
}

function assertPrivateDirectory(path: string, create: boolean, recursive = false): boolean {
  let stat = lstatOptional(path);
  if (!stat && create) {
    try {
      mkdirSync(path, { recursive, mode: 0o700 });
    } catch (error) {
      if (errnoCode(error) !== 'EEXIST') {
        fail('unsafe_layout', 'could not create protected directory', path, error);
      }
    }
    stat = lstatOptional(path);
  }
  if (!stat) return false;
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    fail('unsafe_layout', 'protected path is not a real directory', path);
  }
  if (create) {
    try {
      chmodSync(path, 0o700);
      stat = lstatSync(path);
    } catch (error) {
      fail('unsafe_layout', 'could not secure protected directory', path, error);
    }
  }
  if (process.platform !== 'win32' && (stat.mode & 0o777) !== 0o700) {
    fail('unsafe_layout', 'protected directory mode is not 0700', path);
  }
  return true;
}

export function ensureSchedulePreconditionRoot(dataDir?: string): string {
  const root = schedulePreconditionRoot(dataDir);
  assertPrivateDirectory(root, true, true);
  assertPrivateDirectory(schedulePreconditionTrustedFilesRoot(dataDir), true);
  return root;
}

function assertStorageLayout(appId: string, dataDir: string | undefined, create: boolean): boolean {
  const root = schedulePreconditionRoot(dataDir);
  if (!assertPrivateDirectory(root, create, create)) return false;
  return assertPrivateDirectory(ownerDirectory(appId, dataDir), create);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function parseRecord(
  raw: string,
  expectedAppId: string,
  expectedTaskId: string,
  path: string,
): SchedulePreconditionRecord {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    fail('corrupt_record', 'protected record is not valid JSON', path, error);
  }
  if (!isPlainRecord(value)) fail('corrupt_record', 'protected record is not an object', path);

  const commonValid = (value.schemaVersion === 1 || value.schemaVersion === RECORD_SCHEMA_VERSION)
    && (value.state === 'pending' || value.state === 'active')
    && typeof value.larkAppId === 'string'
    && typeof value.taskId === 'string'
    && validRef(value.preconditionRef)
    && isCanonicalIsoDate(value.updatedAt);
  if (!commonValid) fail('corrupt_record', 'protected record failed schema validation', path);

  if (value.larkAppId !== expectedAppId || value.taskId !== expectedTaskId) {
    fail('identity_mismatch', 'protected record identity does not match its location', path);
  }

  let definition: SchedulePreconditionDefinition;
  if (value.schemaVersion === 1) {
    const v1Keys = value.state === 'pending'
      ? ['schemaVersion', 'state', 'larkAppId', 'taskId', 'preconditionRef', 'script', 'updatedAt']
      : [
          'schemaVersion', 'state', 'larkAppId', 'taskId', 'preconditionRef', 'script', 'updatedAt',
          'canonicalInputHash', 'taskCreatedAt',
        ];
    if (!hasExactKeys(value, v1Keys)) {
      fail('corrupt_record', 'v1 protected record contains unexpected fields', path);
    }
    let script: string;
    try {
      script = validateSchedulePreconditionScript(value.script);
    } catch (error) {
      fail('corrupt_record', 'v1 protected record contains an invalid script', path, error);
    }
    definition = { enabled: true, source: { kind: 'inline', script } };
  } else {
    const v2Keys = value.state === 'pending'
      ? [
          'schemaVersion', 'state', 'larkAppId', 'taskId', 'preconditionRef', 'enabled', 'source',
          'updatedAt',
        ]
      : [
          'schemaVersion', 'state', 'larkAppId', 'taskId', 'preconditionRef', 'enabled', 'source',
          'updatedAt', 'canonicalInputHash', 'taskCreatedAt',
        ];
    if (!hasExactKeys(value, v2Keys)) {
      fail('corrupt_record', 'v2 protected record contains unexpected fields', path);
    }
    try {
      definition = validateSchedulePreconditionDefinition({
        enabled: value.enabled,
        source: value.source,
      });
    } catch (error) {
      fail('corrupt_record', 'v2 protected record contains an invalid definition', path, error);
    }
  }

  const base = {
    schemaVersion: RECORD_SCHEMA_VERSION,
    state: value.state as 'pending' | 'active',
    larkAppId: value.larkAppId as string,
    taskId: value.taskId as string,
    preconditionRef: value.preconditionRef as string,
    enabled: definition.enabled,
    source: definition.source,
    updatedAt: value.updatedAt as string,
  } as const;
  if (value.state === 'pending') return { ...base, state: 'pending' };

  if (!HASH_PATTERN.test(String(value.canonicalInputHash)) || !isCanonicalIsoDate(value.taskCreatedAt)) {
    fail('corrupt_record', 'active record failed binding validation', path);
  }
  return {
    ...base,
    state: 'active',
    canonicalInputHash: value.canonicalInputHash as string,
    taskCreatedAt: value.taskCreatedAt,
  };
}

function readRecord(
  appId: string,
  taskId: string,
  options: SchedulePreconditionStoreOptions,
): SchedulePreconditionRecord | undefined {
  assertIdentityPart(appId, 'appId');
  assertIdentityPart(taskId, 'taskId');
  if (!assertStorageLayout(appId, options.dataDir, false)) return undefined;

  const path = schedulePreconditionPath(appId, taskId, options.dataDir);
  const pathStat = lstatOptional(path);
  if (!pathStat) return undefined;
  if (!pathStat.isFile() || pathStat.isSymbolicLink()) {
    fail('unsafe_layout', 'protected record is not a real regular file', path);
  }
  if (process.platform !== 'win32' && (pathStat.mode & 0o777) !== 0o600) {
    fail('unsafe_layout', 'protected record mode is not 0600', path);
  }
  if (pathStat.size > MAX_RECORD_BYTES) fail('corrupt_record', 'protected record is too large', path);

  let fd: number | undefined;
  try {
    const noFollow = process.platform === 'win32' ? 0 : constants.O_NOFOLLOW;
    fd = openSync(path, constants.O_RDONLY | noFollow);
    const before = fstatSync(fd);
    if (!before.isFile()) fail('unsafe_layout', 'opened protected record is not regular', path);
    if (process.platform !== 'win32' && (before.mode & 0o777) !== 0o600) {
      fail('unsafe_layout', 'opened protected record mode is not 0600', path);
    }
    if (before.size > MAX_RECORD_BYTES) fail('corrupt_record', 'protected record is too large', path);
    const raw = readFileSync(fd, 'utf8');
    const after = fstatSync(fd);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
        || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      fail('unreadable_record', 'protected record changed while being read', path);
    }
    return parseRecord(raw, appId, taskId, path);
  } catch (error) {
    if (error instanceof SchedulePreconditionStoreError) throw error;
    if (errnoCode(error) === 'ENOENT') return undefined;
    fail('unreadable_record', 'could not read protected record', path, error);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function writeRecord(record: SchedulePreconditionRecord, options: SchedulePreconditionStoreOptions): void {
  const path = schedulePreconditionPath(record.larkAppId, record.taskId, options.dataDir);
  atomicWriteFileSync(path, `${JSON.stringify(record)}\n`, {
    mode: 0o600,
    durable: true,
    followTargetSymlink: false,
  });
}

function unlinkRecord(path: string): void {
  try {
    unlinkSync(path);
    fsyncDirectorySyncPortable(dirname(path));
  } catch (error) {
    if (errnoCode(error) !== 'ENOENT') throw error;
  }
}

function cloneRecord(record: SchedulePreconditionRecord): Readonly<SchedulePreconditionRecord> {
  return Object.freeze({
    ...record,
    source: Object.freeze({ ...record.source }),
  });
}

function snapshot(record: SchedulePreconditionRecord | undefined): SchedulePreconditionSnapshot {
  return record
    ? Object.freeze({ kind: 'record' as const, record: cloneRecord(record) })
    : Object.freeze({ kind: 'absent' as const });
}

function taskRef(task: ScheduledTask): string | undefined {
  if (task.preconditionRef === undefined) return undefined;
  if (!validRef(task.preconditionRef)) {
    fail('precondition_ref_mismatch', 'task contains an invalid precondition reference');
  }
  return task.preconditionRef;
}

function assertTaskIdentity(task: ScheduledTask, appId: string): void {
  assertIdentityPart(appId, 'appId');
  assertIdentityPart(task.id, 'task.id');
  if (task.larkAppId !== undefined && task.larkAppId !== appId) {
    fail('task_owner_mismatch', 'task owner does not match requested app');
  }
}

function assertTaskBinding(
  task: ScheduledTask,
  appId: string,
  record: SchedulePreconditionRecord,
): void {
  assertTaskIdentity(task, appId);
  const ref = taskRef(task);
  if (!ref || ref !== record.preconditionRef) {
    fail('precondition_ref_mismatch', 'task and protected record references do not match');
  }
  if (!isCanonicalIsoDate(task.createdAt)) {
    fail('invalid_input', 'task createdAt is not a canonical ISO timestamp');
  }
}

function assertActiveTaskBinding(
  task: ScheduledTask,
  record: ActiveSchedulePreconditionRecord,
): void {
  if (record.taskCreatedAt !== task.createdAt) {
    fail('task_instance_mismatch', 'protected record belongs to a different task instance');
  }
  const hash = computeInputHash(canonicalScheduleInput(task));
  if (record.canonicalInputHash !== hash) {
    fail('canonical_input_mismatch', 'task input does not match protected record binding');
  }
}

function createReference(options: SchedulePreconditionStoreOptions): string {
  const ref = options.createRef?.() ?? `spc_${randomBytes(32).toString('base64url')}`;
  if (!validRef(ref)) fail('invalid_input', 'reference generator returned an invalid value');
  return ref;
}

export function stageSchedulePrecondition(
  appId: string,
  taskId: string,
  definitionInput: unknown,
  options: SchedulePreconditionStoreOptions = {},
): StagedSchedulePrecondition {
  assertIdentityPart(appId, 'appId');
  assertIdentityPart(taskId, 'taskId');
  const definition = normalizeDefinitionInput(definitionInput);
  assertStorageLayout(appId, options.dataDir, true);
  const path = schedulePreconditionPath(appId, taskId, options.dataDir);
  return withFileLockSync(path, () => {
    const previous = readRecord(appId, taskId, options);
    const preconditionRef = createReference(options);
    writeRecord({
      schemaVersion: RECORD_SCHEMA_VERSION,
      state: 'pending',
      larkAppId: appId,
      taskId,
      preconditionRef,
      enabled: definition.enabled,
      source: definition.source,
      updatedAt: nowIso(options),
    }, options);
    return { preconditionRef, previous: snapshot(previous) };
  });
}

export function abortSchedulePrecondition(
  appId: string,
  taskId: string,
  preconditionRef: string,
  previous: SchedulePreconditionSnapshot,
  options: SchedulePreconditionStoreOptions = {},
): void {
  assertIdentityPart(appId, 'appId');
  assertIdentityPart(taskId, 'taskId');
  if (!validRef(preconditionRef)) fail('invalid_input', 'invalid staged reference');
  if (!previous || (previous.kind !== 'absent' && previous.kind !== 'record')) {
    fail('invalid_input', 'invalid rollback snapshot');
  }
  assertStorageLayout(appId, options.dataDir, true);
  const path = schedulePreconditionPath(appId, taskId, options.dataDir);
  withFileLockSync(path, () => {
    const current = readRecord(appId, taskId, options);
    if (!current || current.state !== 'pending' || current.preconditionRef !== preconditionRef) {
      fail('transition_conflict', 'staged record is no longer current');
    }
    if (previous.kind === 'absent') {
      unlinkRecord(path);
      return;
    }
    const prior = previous.record;
    if (prior.larkAppId !== appId || prior.taskId !== taskId) {
      fail('identity_mismatch', 'rollback snapshot identity does not match target');
    }
    // Re-parse the snapshot through the same strict schema boundary before it
    // is allowed to regain authority.
    const validated = parseRecord(JSON.stringify(prior), appId, taskId, path);
    writeRecord(validated, options);
  });
}

export function activateSchedulePrecondition(
  task: ScheduledTask,
  appId: string,
  options: SchedulePreconditionStoreOptions = {},
): void {
  assertTaskIdentity(task, appId);
  if (!taskRef(task)) fail('precondition_ref_mismatch', 'task has no precondition reference');
  if (!assertStorageLayout(appId, options.dataDir, false)) {
    fail('sidecar_missing', 'staged protected record is missing');
  }
  const path = schedulePreconditionPath(appId, task.id, options.dataDir);
  withFileLockSync(path, () => {
    const record = readRecord(appId, task.id, options);
    if (!record) fail('sidecar_missing', 'staged protected record is missing');
    if (record.state !== 'pending') fail('transition_conflict', 'protected record is not pending');
    assertTaskBinding(task, appId, record);
    writeRecord({
      ...record,
      state: 'active',
      canonicalInputHash: computeInputHash(canonicalScheduleInput(task)),
      taskCreatedAt: task.createdAt,
      updatedAt: nowIso(options),
    }, options);
  });
}

export function resolveSchedulePrecondition(
  task: ScheduledTask,
  appId: string,
  options: SchedulePreconditionStoreOptions = {},
): ResolvedSchedulePrecondition {
  assertTaskIdentity(task, appId);
  const marker = taskRef(task);
  // Always query by app/task identity. Absence of the sandbox-writable marker
  // must not be enough to bypass an existing protected condition.
  const record = readRecord(appId, task.id, options);
  if (!record) {
    if (marker) fail('sidecar_missing', 'task references a missing protected record');
    return { kind: 'none' };
  }
  assertTaskBinding(task, appId, record);
  if (record.state === 'pending') fail('precondition_pending', 'protected record is pending');
  assertActiveTaskBinding(task, record);
  return {
    kind: 'configured',
    enabled: record.enabled,
    source: { ...record.source },
  };
}

export function rebindSchedulePrecondition(
  task: ScheduledTask,
  appId: string,
  options: SchedulePreconditionStoreOptions = {},
): void {
  assertTaskIdentity(task, appId);
  const marker = taskRef(task);
  const path = schedulePreconditionPath(appId, task.id, options.dataDir);
  const rootExists = assertStorageLayout(appId, options.dataDir, false);
  if (!rootExists) {
    if (marker) fail('sidecar_missing', 'task references a missing protected record');
    return;
  }
  withFileLockSync(path, () => {
    const record = readRecord(appId, task.id, options);
    if (!record) {
      if (marker) fail('sidecar_missing', 'task references a missing protected record');
      return;
    }
    assertTaskBinding(task, appId, record);
    if (record.state === 'pending') fail('precondition_pending', 'protected record is pending');
    if (record.taskCreatedAt !== task.createdAt) {
      fail('task_instance_mismatch', 'protected record belongs to a different task instance');
    }
    writeRecord({
      ...record,
      canonicalInputHash: computeInputHash(canonicalScheduleInput(task)),
      updatedAt: nowIso(options),
    }, options);
  });
}

export function setSchedulePreconditionEnabled(
  task: ScheduledTask,
  appId: string,
  enabled: boolean,
  options: SchedulePreconditionStoreOptions = {},
): void {
  assertTaskIdentity(task, appId);
  if (typeof enabled !== 'boolean') fail('invalid_input', 'enabled must be boolean');
  if (!taskRef(task)) fail('precondition_ref_mismatch', 'task has no precondition reference');
  if (!assertStorageLayout(appId, options.dataDir, false)) {
    fail('sidecar_missing', 'protected record is missing');
  }
  const path = schedulePreconditionPath(appId, task.id, options.dataDir);
  withFileLockSync(path, () => {
    const record = readRecord(appId, task.id, options);
    if (!record) fail('sidecar_missing', 'protected record is missing');
    assertTaskBinding(task, appId, record);
    if (record.state === 'pending') fail('precondition_pending', 'protected record is pending');
    assertActiveTaskBinding(task, record);
    writeRecord({
      ...record,
      enabled,
      updatedAt: nowIso(options),
    }, options);
  });
}

export function getSchedulePreconditionSummary(
  task: ScheduledTask,
  appId: string,
  options: SchedulePreconditionStoreOptions = {},
): SchedulePreconditionSummary {
  const resolved = resolveSchedulePrecondition(task, appId, options);
  if (resolved.kind === 'none') return { hasPrecondition: false };
  return {
    hasPrecondition: true,
    enabled: resolved.enabled,
    sourceKind: resolved.source.kind,
  };
}

export function removeSchedulePrecondition(
  appId: string,
  taskId: string,
  options: SchedulePreconditionStoreOptions = {},
): boolean {
  assertIdentityPart(appId, 'appId');
  assertIdentityPart(taskId, 'taskId');
  if (!assertStorageLayout(appId, options.dataDir, false)) return false;
  const path = schedulePreconditionPath(appId, taskId, options.dataDir);
  return withFileLockSync(path, () => {
    const record = readRecord(appId, taskId, options);
    if (!record) return false;
    unlinkRecord(path);
    return true;
  });
}
