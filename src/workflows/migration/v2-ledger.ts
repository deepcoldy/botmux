/**
 * Durable v2-definition -> v3 Saved Workflow migration ledger.
 *
 * The legacy definition file is user-authored source material and is never
 * rewritten. One source identity (canonical real path + workflow id) owns one
 * stable Saved Workflow. Every semantic legacy revision then maps to an exact
 * immutable v3 revision. The v2 execution engine is gone; a pending migration
 * is repaired by re-running the migration command without mutating the legacy
 * source bytes.
 */

import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

import { canonicalJsonStringify } from '../../utils/canonical-json.js';
import { fsyncDirectorySyncPortable } from '../../utils/fs-durability.js';
import { withFileLockSync } from '../../utils/file-lock.js';
import { computeRevisionId, type WorkflowDefinition } from '../definition.js';
import {
  SAVED_WORKFLOW_ID_RE,
  SAVED_WORKFLOW_REVISION_ID_RE,
  type SavedWorkflowOwner,
  type SavedWorkflowScope,
} from '../v3/library-schema.js';

export const LEGACY_MIGRATION_LEDGER_SCHEMA_VERSION = 1 as const;
export const LEGACY_SOURCE_KEY_RE = /^src_[0-9a-f]{64}$/;
export const LEGACY_MIGRATION_KEY_RE = /^mig_[0-9a-f]{64}$/;
export const LEGACY_CONTENT_HASH_RE = /^sha256:[0-9a-f]{64}$/;
export const LEGACY_CONVERSION_HASH_RE = /^sha256:[0-9a-f]{64}$/;

export type LegacyMigrationState = 'pending' | 'committed';

export interface LegacySourceIdentity {
  path: string;
  workflowId: string;
}

export interface LegacyDefinitionIdentity extends LegacySourceIdentity {
  contentHash: string;
}

export interface LegacyMigrationTarget {
  workflowId: string;
  owner: SavedWorkflowOwner;
  scope: SavedWorkflowScope;
}

export type LegacyMigrationSupersedeReason =
  'target_latest_changed_before_materialization';

/** Immutable audit row for an explicitly abandoned pending allocation. */
export interface LegacyMigrationSupersededAllocation {
  conversionHash: string;
  targetRevisionId: string;
  targetHumanVersion: number;
  targetCreatedAt: string;
  expectedLatestRevision?: string;
  preparedAt: string;
  supersededAt: string;
  reason: LegacyMigrationSupersedeReason;
}

/**
 * Allocation frozen before touching the v3 library. It contains enough data
 * to reconstruct and byte-check the exact immutable revision after any crash.
 */
export interface LegacyMigrationRevisionRecord {
  migrationKey: string;
  state: LegacyMigrationState;
  contentHash: string;
  conversionHash: string;
  targetRevisionId: string;
  targetHumanVersion: number;
  targetCreatedAt: string;
  expectedLatestRevision?: string;
  preparedAt: string;
  updatedAt: string;
  supersededAllocations?: LegacyMigrationSupersededAllocation[];
}

export interface LegacyMigrationSourceRecord {
  sourceKey: string;
  legacy: LegacySourceIdentity;
  target: LegacyMigrationTarget;
  revisions: Record<string, LegacyMigrationRevisionRecord>;
  createdAt: string;
  updatedAt: string;
}

export interface LegacyMigrationLedger {
  schemaVersion: typeof LEGACY_MIGRATION_LEDGER_SCHEMA_VERSION;
  sources: Record<string, LegacyMigrationSourceRecord>;
}

export type LegacyMigrationLookup =
  | { kind: 'none' }
  | {
    kind: 'exact';
    source: LegacyMigrationSourceRecord;
    revision: LegacyMigrationRevisionRecord;
  }
  | {
    kind: 'changed_after_migration';
    source: LegacyMigrationSourceRecord;
    currentContentHash: string;
  };

export class LegacyMigrationLedgerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LegacyMigrationLedgerError';
  }
}

function emptyLedger(): LegacyMigrationLedger {
  return {
    schemaVersion: LEGACY_MIGRATION_LEDGER_SCHEMA_VERSION,
    sources: Object.create(null) as Record<string, LegacyMigrationSourceRecord>,
  };
}

export function legacyMigrationLedgerPath(dataDir: string): string {
  if (!dataDir) throw new LegacyMigrationLedgerError('dataDir is required');
  return join(dataDir, 'workflow-migrations', 'v2-to-v3.json');
}

function canonicalExistingSourcePath(path: string): string {
  let canonical: string;
  try {
    canonical = realpathSync(path);
  } catch (err) {
    throw new LegacyMigrationLedgerError(
      `cannot resolve legacy definition ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const stat = lstatSync(canonical);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new LegacyMigrationLedgerError(`legacy definition must resolve to a regular file: ${path}`);
  }
  return canonical;
}

export function legacyDefinitionIdentity(
  path: string,
  definition: WorkflowDefinition,
): LegacyDefinitionIdentity {
  return {
    path: canonicalExistingSourcePath(path),
    workflowId: definition.workflowId,
    contentHash: computeRevisionId(definition),
  };
}

export function legacySourceKey(identity: LegacySourceIdentity): string {
  const digest = createHash('sha256')
    .update([
      'botmux:v2-to-v3-source:v1',
      identity.path,
      identity.workflowId,
    ].join('\0'))
    .digest('hex');
  return `src_${digest}`;
}

export function legacyMigrationKey(identity: LegacyDefinitionIdentity): string {
  const digest = createHash('sha256')
    .update([
      'botmux:v2-to-v3-revision:v1',
      identity.path,
      identity.workflowId,
      identity.contentHash,
    ].join('\0'))
    .digest('hex');
  return `mig_${digest}`;
}

/** Stable across legacy revisions so semantic edits append v3 revisions. */
export function migratedSavedWorkflowId(identity: LegacySourceIdentity): string {
  const digest = createHash('sha256')
    .update([
      'botmux:v2-to-v3-saved-workflow:v1',
      identity.path,
      identity.workflowId,
    ].join('\0'))
    .digest('hex')
    .slice(0, 32);
  return `wf_${digest}`;
}

export function computeLegacyConversionHash(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJsonStringify(value)).digest('hex')}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], where: string): void {
  const extras = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extras.length > 0) {
    throw new LegacyMigrationLedgerError(`${where} has unsupported key(s): ${extras.join(', ')}`);
  }
}

function nonEmptyString(value: unknown, where: string, max = 4096): string {
  if (typeof value !== 'string' || !value || value.length > max) {
    throw new LegacyMigrationLedgerError(`${where} must be a non-empty string <= ${max} chars`);
  }
  return value;
}

function isoString(value: unknown, where: string): string {
  const text = nonEmptyString(value, where, 64);
  if (!Number.isFinite(Date.parse(text))) {
    throw new LegacyMigrationLedgerError(`${where} must be a valid ISO timestamp`);
  }
  return text;
}

function parseOwner(value: unknown, where: string): SavedWorkflowOwner {
  if (!isRecord(value)) throw new LegacyMigrationLedgerError(`${where} must be an object`);
  exactKeys(value, ['openId', 'larkAppId'], where);
  return {
    openId: nonEmptyString(value.openId, `${where}.openId`, 256),
    larkAppId: nonEmptyString(value.larkAppId, `${where}.larkAppId`, 256),
  };
}

function parseScope(value: unknown, where: string): SavedWorkflowScope {
  if (!isRecord(value)) throw new LegacyMigrationLedgerError(`${where} must be an object`);
  if (value.kind === 'global') {
    exactKeys(value, ['kind'], where);
    return { kind: 'global' };
  }
  if (value.kind === 'chat') {
    exactKeys(value, ['kind', 'chatId'], where);
    return { kind: 'chat', chatId: nonEmptyString(value.chatId, `${where}.chatId`, 256) };
  }
  throw new LegacyMigrationLedgerError(`${where}.kind must be global or chat`);
}

function parseSourceIdentity(value: unknown, where: string): LegacySourceIdentity {
  if (!isRecord(value)) throw new LegacyMigrationLedgerError(`${where} must be an object`);
  exactKeys(value, ['path', 'workflowId'], where);
  const path = nonEmptyString(value.path, `${where}.path`);
  if (!isAbsolute(path) || resolve(path) !== path) {
    throw new LegacyMigrationLedgerError(`${where}.path must be a normalized absolute path`);
  }
  return {
    path,
    workflowId: nonEmptyString(value.workflowId, `${where}.workflowId`, 256),
  };
}

function parseTarget(value: unknown, where: string): LegacyMigrationTarget {
  if (!isRecord(value)) throw new LegacyMigrationLedgerError(`${where} must be an object`);
  exactKeys(value, ['workflowId', 'owner', 'scope'], where);
  const workflowId = nonEmptyString(value.workflowId, `${where}.workflowId`, 64);
  if (!SAVED_WORKFLOW_ID_RE.test(workflowId)) {
    throw new LegacyMigrationLedgerError(`${where}.workflowId must match wf_<32 lowercase hex>`);
  }
  return {
    workflowId,
    owner: parseOwner(value.owner, `${where}.owner`),
    scope: parseScope(value.scope, `${where}.scope`),
  };
}

function parseSupersededAllocation(
  value: unknown,
  where: string,
): LegacyMigrationSupersededAllocation {
  if (!isRecord(value)) throw new LegacyMigrationLedgerError(`${where} must be an object`);
  exactKeys(value, [
    'conversionHash',
    'targetRevisionId',
    'targetHumanVersion',
    'targetCreatedAt',
    'expectedLatestRevision',
    'preparedAt',
    'supersededAt',
    'reason',
  ], where);
  const conversionHash = nonEmptyString(value.conversionHash, `${where}.conversionHash`, 80);
  if (!LEGACY_CONVERSION_HASH_RE.test(conversionHash)) {
    throw new LegacyMigrationLedgerError(`${where}.conversionHash must match sha256:<64 lowercase hex>`);
  }
  const targetRevisionId = nonEmptyString(value.targetRevisionId, `${where}.targetRevisionId`, 80);
  if (!SAVED_WORKFLOW_REVISION_ID_RE.test(targetRevisionId)) {
    throw new LegacyMigrationLedgerError(`${where}.targetRevisionId must be a v3 revision id`);
  }
  if (!Number.isSafeInteger(value.targetHumanVersion) || (value.targetHumanVersion as number) < 1) {
    throw new LegacyMigrationLedgerError(`${where}.targetHumanVersion must be a positive integer`);
  }
  let expectedLatestRevision: string | undefined;
  if (value.expectedLatestRevision !== undefined) {
    expectedLatestRevision = nonEmptyString(
      value.expectedLatestRevision,
      `${where}.expectedLatestRevision`,
      80,
    );
    if (!SAVED_WORKFLOW_REVISION_ID_RE.test(expectedLatestRevision)) {
      throw new LegacyMigrationLedgerError(`${where}.expectedLatestRevision must be a v3 revision id`);
    }
  }
  const targetCreatedAt = isoString(value.targetCreatedAt, `${where}.targetCreatedAt`);
  const preparedAt = isoString(value.preparedAt, `${where}.preparedAt`);
  const supersededAt = isoString(value.supersededAt, `${where}.supersededAt`);
  if (Date.parse(supersededAt) < Date.parse(preparedAt)) {
    throw new LegacyMigrationLedgerError(`${where}.supersededAt must not precede preparedAt`);
  }
  if (value.reason !== 'target_latest_changed_before_materialization') {
    throw new LegacyMigrationLedgerError(`${where}.reason is unsupported`);
  }
  return {
    conversionHash,
    targetRevisionId,
    targetHumanVersion: value.targetHumanVersion as number,
    targetCreatedAt,
    ...(expectedLatestRevision ? { expectedLatestRevision } : {}),
    preparedAt,
    supersededAt,
    reason: value.reason,
  };
}

function parseRevision(
  value: unknown,
  expectedContentHash: string,
  identity: LegacyDefinitionIdentity,
  where: string,
): LegacyMigrationRevisionRecord {
  if (!isRecord(value)) throw new LegacyMigrationLedgerError(`${where} must be an object`);
  exactKeys(value, [
    'migrationKey',
    'state',
    'contentHash',
    'conversionHash',
    'targetRevisionId',
    'targetHumanVersion',
    'targetCreatedAt',
    'expectedLatestRevision',
    'preparedAt',
    'updatedAt',
    'supersededAllocations',
  ], where);
  const contentHash = nonEmptyString(value.contentHash, `${where}.contentHash`, 80);
  if (contentHash !== expectedContentHash || !LEGACY_CONTENT_HASH_RE.test(contentHash)) {
    throw new LegacyMigrationLedgerError(`${where}.contentHash does not match its revisions key`);
  }
  const migrationKey = nonEmptyString(value.migrationKey, `${where}.migrationKey`, 80);
  if (!LEGACY_MIGRATION_KEY_RE.test(migrationKey) || migrationKey !== legacyMigrationKey(identity)) {
    throw new LegacyMigrationLedgerError(`${where}.migrationKey does not match its source revision`);
  }
  if (value.state !== 'pending' && value.state !== 'committed') {
    throw new LegacyMigrationLedgerError(`${where}.state must be pending or committed`);
  }
  const conversionHash = nonEmptyString(value.conversionHash, `${where}.conversionHash`, 80);
  if (!LEGACY_CONVERSION_HASH_RE.test(conversionHash)) {
    throw new LegacyMigrationLedgerError(`${where}.conversionHash must match sha256:<64 lowercase hex>`);
  }
  const targetRevisionId = nonEmptyString(value.targetRevisionId, `${where}.targetRevisionId`, 80);
  if (!SAVED_WORKFLOW_REVISION_ID_RE.test(targetRevisionId)) {
    throw new LegacyMigrationLedgerError(`${where}.targetRevisionId must match rev_<64 lowercase hex>`);
  }
  if (!Number.isSafeInteger(value.targetHumanVersion) || (value.targetHumanVersion as number) < 1) {
    throw new LegacyMigrationLedgerError(`${where}.targetHumanVersion must be a positive integer`);
  }
  let expectedLatestRevision: string | undefined;
  if (value.expectedLatestRevision !== undefined) {
    expectedLatestRevision = nonEmptyString(
      value.expectedLatestRevision,
      `${where}.expectedLatestRevision`,
      80,
    );
    if (!SAVED_WORKFLOW_REVISION_ID_RE.test(expectedLatestRevision)) {
      throw new LegacyMigrationLedgerError(`${where}.expectedLatestRevision must be a v3 revision id`);
    }
  }
  const targetCreatedAt = isoString(value.targetCreatedAt, `${where}.targetCreatedAt`);
  const preparedAt = isoString(value.preparedAt, `${where}.preparedAt`);
  const updatedAt = isoString(value.updatedAt, `${where}.updatedAt`);
  if (Date.parse(updatedAt) < Date.parse(preparedAt)) {
    throw new LegacyMigrationLedgerError(`${where}.updatedAt must not precede preparedAt`);
  }
  let supersededAllocations: LegacyMigrationSupersededAllocation[] | undefined;
  if (value.supersededAllocations !== undefined) {
    if (!Array.isArray(value.supersededAllocations) || value.supersededAllocations.length === 0) {
      throw new LegacyMigrationLedgerError(`${where}.supersededAllocations must be a non-empty array`);
    }
    if (value.supersededAllocations.length > 64) {
      throw new LegacyMigrationLedgerError(`${where}.supersededAllocations exceeds 64 audit rows`);
    }
    supersededAllocations = value.supersededAllocations.map((item, index) =>
      parseSupersededAllocation(item, `${where}.supersededAllocations[${index}]`));
  }
  return {
    migrationKey,
    state: value.state,
    contentHash,
    conversionHash,
    targetRevisionId,
    targetHumanVersion: value.targetHumanVersion as number,
    targetCreatedAt,
    ...(expectedLatestRevision ? { expectedLatestRevision } : {}),
    preparedAt,
    updatedAt,
    ...(supersededAllocations ? { supersededAllocations } : {}),
  };
}

export function validateLegacyMigrationSourceRecord(
  raw: unknown,
  expectedSourceKey?: string,
): LegacyMigrationSourceRecord {
  if (!isRecord(raw)) throw new LegacyMigrationLedgerError('migration source must be an object');
  exactKeys(raw, ['sourceKey', 'legacy', 'target', 'revisions', 'createdAt', 'updatedAt'], 'source');
  const legacy = parseSourceIdentity(raw.legacy, 'source.legacy');
  const sourceKey = nonEmptyString(raw.sourceKey, 'source.sourceKey', 80);
  if (!LEGACY_SOURCE_KEY_RE.test(sourceKey) || sourceKey !== legacySourceKey(legacy)) {
    throw new LegacyMigrationLedgerError('source.sourceKey does not match its legacy identity');
  }
  if (expectedSourceKey && sourceKey !== expectedSourceKey) {
    throw new LegacyMigrationLedgerError(`source key ${sourceKey} does not match sources key ${expectedSourceKey}`);
  }
  const target = parseTarget(raw.target, 'source.target');
  if (target.workflowId !== migratedSavedWorkflowId(legacy)) {
    throw new LegacyMigrationLedgerError('source.target.workflowId is not the deterministic id for this source');
  }
  if (!isRecord(raw.revisions)) {
    throw new LegacyMigrationLedgerError('source.revisions must be an object');
  }
  const revisions = Object.create(null) as Record<string, LegacyMigrationRevisionRecord>;
  for (const [contentHash, value] of Object.entries(raw.revisions)) {
    if (!LEGACY_CONTENT_HASH_RE.test(contentHash)) {
      throw new LegacyMigrationLedgerError(`invalid source revision key ${JSON.stringify(contentHash)}`);
    }
    revisions[contentHash] = parseRevision(
      value,
      contentHash,
      { ...legacy, contentHash },
      `source.revisions[${JSON.stringify(contentHash)}]`,
    );
  }
  if (Object.keys(revisions).length === 0) {
    throw new LegacyMigrationLedgerError('source.revisions must not be empty');
  }
  const createdAt = isoString(raw.createdAt, 'source.createdAt');
  const updatedAt = isoString(raw.updatedAt, 'source.updatedAt');
  if (Date.parse(updatedAt) < Date.parse(createdAt)) {
    throw new LegacyMigrationLedgerError('source.updatedAt must not precede createdAt');
  }
  return { sourceKey, legacy, target, revisions, createdAt, updatedAt };
}

export function validateLegacyMigrationLedger(raw: unknown): LegacyMigrationLedger {
  if (!isRecord(raw)) throw new LegacyMigrationLedgerError('migration ledger root must be an object');
  exactKeys(raw, ['schemaVersion', 'sources'], 'ledger');
  if (raw.schemaVersion !== LEGACY_MIGRATION_LEDGER_SCHEMA_VERSION) {
    throw new LegacyMigrationLedgerError(
      `ledger.schemaVersion must be ${LEGACY_MIGRATION_LEDGER_SCHEMA_VERSION}`,
    );
  }
  if (!isRecord(raw.sources)) throw new LegacyMigrationLedgerError('ledger.sources must be an object');
  const sources = Object.create(null) as Record<string, LegacyMigrationSourceRecord>;
  for (const [key, value] of Object.entries(raw.sources)) {
    if (!LEGACY_SOURCE_KEY_RE.test(key)) {
      throw new LegacyMigrationLedgerError(`invalid ledger source key ${JSON.stringify(key)}`);
    }
    sources[key] = validateLegacyMigrationSourceRecord(value, key);
  }
  return { schemaVersion: LEGACY_MIGRATION_LEDGER_SCHEMA_VERSION, sources };
}

function assertRegularPrivateLedger(path: string): void {
  if (!existsSync(path)) return;
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new LegacyMigrationLedgerError(`migration ledger must be a regular file: ${path}`);
  }
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
    throw new LegacyMigrationLedgerError(`migration ledger permissions must be 0600: ${path}`);
  }
}

export function readLegacyMigrationLedger(dataDir: string): LegacyMigrationLedger {
  const path = legacyMigrationLedgerPath(dataDir);
  if (!existsSync(path)) return emptyLedger();
  assertRegularPrivateLedger(path);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf-8'));
  } catch (err) {
    throw new LegacyMigrationLedgerError(
      `cannot parse migration ledger ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return validateLegacyMigrationLedger(raw);
}

function persistLedger(path: string, ledger: LegacyMigrationLedger): void {
  const parent = dirname(path);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') chmodSync(parent, 0o700);
  assertRegularPrivateLedger(path);
  const tmp = join(
    parent,
    `.${basename(path)}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`,
  );
  let fd: number | undefined;
  let renamed = false;
  try {
    fd = openSync(
      tmp,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    fchmodSync(fd, 0o600);
    writeFileSync(fd, `${canonicalJsonStringify(ledger)}\n`, 'utf-8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, path);
    renamed = true;
    fsyncDirectorySyncPortable(parent);
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* best effort */ }
    }
    if (!renamed) {
      try { unlinkSync(tmp); } catch { /* best effort */ }
    }
  }
}

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalJsonStringify(left) === canonicalJsonStringify(right);
}

export interface PrepareLegacyMigrationInput {
  identity: LegacyDefinitionIdentity;
  target: LegacyMigrationTarget;
  conversionHash: string;
  targetRevisionId: string;
  targetHumanVersion: number;
  targetCreatedAt: string;
  expectedLatestRevision?: string;
  now?: Date;
}

/**
 * First durable phase. The exact target allocation is immutable once written.
 * A repeated call must reproduce it byte-for-byte or fail closed.
 */
export function prepareLegacyMigration(
  dataDir: string,
  input: PrepareLegacyMigrationInput,
): {
  source: LegacyMigrationSourceRecord;
  revision: LegacyMigrationRevisionRecord;
  created: boolean;
} {
  const now = (input.now ?? new Date()).toISOString();
  const sourceIdentity: LegacySourceIdentity = {
    path: input.identity.path,
    workflowId: input.identity.workflowId,
  };
  const sourceKey = legacySourceKey(sourceIdentity);
  const migrationKey = legacyMigrationKey(input.identity);
  const path = legacyMigrationLedgerPath(dataDir);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  return withFileLockSync(path, () => {
    const ledger = readLegacyMigrationLedger(dataDir);
    const existingSource = ledger.sources[sourceKey];
    if (existingSource) {
      if (!sameJson(existingSource.legacy, sourceIdentity) || !sameJson(existingSource.target, input.target)) {
        throw new LegacyMigrationLedgerError(
          `source ${sourceKey} already maps to a different identity, owner, scope, or target`,
        );
      }
      const existingRevision = existingSource.revisions[input.identity.contentHash];
      if (existingRevision) {
        const expected: LegacyMigrationRevisionRecord = {
          migrationKey,
          state: existingRevision.state,
          contentHash: input.identity.contentHash,
          conversionHash: input.conversionHash,
          targetRevisionId: input.targetRevisionId,
          targetHumanVersion: input.targetHumanVersion,
          targetCreatedAt: input.targetCreatedAt,
          ...(input.expectedLatestRevision ? { expectedLatestRevision: input.expectedLatestRevision } : {}),
          preparedAt: existingRevision.preparedAt,
          updatedAt: existingRevision.updatedAt,
          ...(existingRevision.supersededAllocations
            ? { supersededAllocations: existingRevision.supersededAllocations }
            : {}),
        };
        if (!sameJson(existingRevision, expected)) {
          throw new LegacyMigrationLedgerError(
            `pending allocation for ${migrationKey} does not match the reconstructed conversion`,
          );
        }
        return { source: existingSource, revision: existingRevision, created: false };
      }
    }

    const revision: LegacyMigrationRevisionRecord = {
      migrationKey,
      state: 'pending',
      contentHash: input.identity.contentHash,
      conversionHash: input.conversionHash,
      targetRevisionId: input.targetRevisionId,
      targetHumanVersion: input.targetHumanVersion,
      targetCreatedAt: input.targetCreatedAt,
      ...(input.expectedLatestRevision ? { expectedLatestRevision: input.expectedLatestRevision } : {}),
      preparedAt: now,
      updatedAt: now,
    };
    const source: LegacyMigrationSourceRecord = existingSource
      ? {
        ...existingSource,
        revisions: { ...existingSource.revisions, [input.identity.contentHash]: revision },
        updatedAt: now,
      }
      : {
        sourceKey,
        legacy: sourceIdentity,
        target: input.target,
        revisions: { [input.identity.contentHash]: revision },
        createdAt: now,
        updatedAt: now,
      };
    ledger.sources[sourceKey] = source;
    persistLedger(path, validateLegacyMigrationLedger(ledger));
    return { source, revision, created: true };
  });
}

export interface SupersedePendingLegacyMigrationInput extends PrepareLegacyMigrationInput {
  /** CAS guard: the exact pending allocation the operator inspected. */
  previousTargetRevisionId: string;
  reason: LegacyMigrationSupersedeReason;
}

/**
 * Explicit recovery for a pending allocation that was never materialized but
 * whose optimistic library base moved. The abandoned allocation is retained
 * as immutable audit evidence; committed rows can never be superseded.
 *
 * The service must prove the previous target revision is absent before calling
 * this ledger seam. A concurrent drift after reallocation is harmless: the
 * library CAS fails and the operator may explicitly supersede again.
 */
export function supersedePendingLegacyMigration(
  dataDir: string,
  input: SupersedePendingLegacyMigrationInput,
): { source: LegacyMigrationSourceRecord; revision: LegacyMigrationRevisionRecord } {
  const path = legacyMigrationLedgerPath(dataDir);
  const sourceKey = legacySourceKey(input.identity);
  const now = (input.now ?? new Date()).toISOString();
  return withFileLockSync(path, () => {
    const ledger = readLegacyMigrationLedger(dataDir);
    const source = ledger.sources[sourceKey];
    const previous = source?.revisions[input.identity.contentHash];
    if (!source || !previous) {
      throw new LegacyMigrationLedgerError('cannot supersede a missing pending migration allocation');
    }
    if (previous.state !== 'pending') {
      throw new LegacyMigrationLedgerError('committed migration allocations cannot be superseded');
    }
    if (
      previous.targetRevisionId !== input.previousTargetRevisionId ||
      !sameJson(source.target, input.target)
    ) {
      throw new LegacyMigrationLedgerError('pending migration changed before supersede CAS');
    }
    if ((previous.supersededAllocations?.length ?? 0) >= 64) {
      throw new LegacyMigrationLedgerError('pending migration supersede audit limit reached');
    }
    const audit: LegacyMigrationSupersededAllocation = {
      conversionHash: previous.conversionHash,
      targetRevisionId: previous.targetRevisionId,
      targetHumanVersion: previous.targetHumanVersion,
      targetCreatedAt: previous.targetCreatedAt,
      ...(previous.expectedLatestRevision
        ? { expectedLatestRevision: previous.expectedLatestRevision }
        : {}),
      preparedAt: previous.preparedAt,
      supersededAt: now,
      reason: input.reason,
    };
    const revision: LegacyMigrationRevisionRecord = {
      migrationKey: previous.migrationKey,
      state: 'pending',
      contentHash: previous.contentHash,
      conversionHash: input.conversionHash,
      targetRevisionId: input.targetRevisionId,
      targetHumanVersion: input.targetHumanVersion,
      targetCreatedAt: input.targetCreatedAt,
      ...(input.expectedLatestRevision
        ? { expectedLatestRevision: input.expectedLatestRevision }
        : {}),
      preparedAt: now,
      updatedAt: now,
      supersededAllocations: [...(previous.supersededAllocations ?? []), audit],
    };
    const updatedSource: LegacyMigrationSourceRecord = {
      ...source,
      revisions: { ...source.revisions, [input.identity.contentHash]: revision },
      updatedAt: now,
    };
    ledger.sources[sourceKey] = updatedSource;
    persistLedger(path, validateLegacyMigrationLedger(ledger));
    return { source: updatedSource, revision };
  });
}

export function commitLegacyMigration(
  dataDir: string,
  identity: LegacyDefinitionIdentity,
  now: Date = new Date(),
): { source: LegacyMigrationSourceRecord; revision: LegacyMigrationRevisionRecord } {
  const path = legacyMigrationLedgerPath(dataDir);
  return withFileLockSync(path, () => {
    const ledger = readLegacyMigrationLedger(dataDir);
    const sourceKey = legacySourceKey(identity);
    const source = ledger.sources[sourceKey];
    const revision = source?.revisions[identity.contentHash];
    if (!source || !revision) {
      throw new LegacyMigrationLedgerError(
        `cannot commit migration ${legacyMigrationKey(identity)} before its pending allocation`,
      );
    }
    if (revision.state === 'committed') return { source, revision };
    const updatedAt = now.toISOString();
    const committed: LegacyMigrationRevisionRecord = {
      ...revision,
      state: 'committed',
      updatedAt,
    };
    const updatedSource: LegacyMigrationSourceRecord = {
      ...source,
      revisions: { ...source.revisions, [identity.contentHash]: committed },
      updatedAt,
    };
    ledger.sources[sourceKey] = updatedSource;
    persistLedger(path, validateLegacyMigrationLedger(ledger));
    return { source: updatedSource, revision: committed };
  });
}

export function findLegacyMigration(
  dataDir: string,
  identity: LegacyDefinitionIdentity,
): LegacyMigrationLookup {
  const ledger = readLegacyMigrationLedger(dataDir);
  const source = ledger.sources[legacySourceKey(identity)];
  if (!source) return { kind: 'none' };
  const revision = source.revisions[identity.contentHash];
  if (revision) return { kind: 'exact', source, revision };
  return {
    kind: 'changed_after_migration',
    source,
    currentContentHash: identity.contentHash,
  };
}
