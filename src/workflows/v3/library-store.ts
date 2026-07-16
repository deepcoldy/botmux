/**
 * Filesystem store for v3 Saved Workflows.
 *
 * The caller always supplies `dataDir`; this store never consults HOME/cwd and
 * therefore cannot accidentally mix the new library with the legacy workflow
 * search paths. Mutable metadata updates are locked + atomic. Revision files
 * are immutable, content-addressed, and installed without replacement.
 */

import { constants as fsConstants, promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { atomicWriteFile } from '../../utils/atomic-write.js';
import {
  fsyncDirectorySyncPortable,
  fsyncRegularFileSync,
} from '../../utils/fs-durability.js';
import { withFileLock } from '../../utils/file-lock.js';
import {
  SAVED_WORKFLOW_ID_RE,
  SAVED_WORKFLOW_METADATA_SCHEMA_VERSION,
  SAVED_WORKFLOW_REVISION_ID_RE,
  buildSavedWorkflowRevision,
  canonicalJsonStringify,
  loadSavedWorkflowRevision,
  mintSavedWorkflowId,
  normalizeSavedWorkflowLookupKey,
  validateSavedWorkflowMetadata,
  type LoadedSavedWorkflowRevision,
  type SavedWorkflowMetadata,
  type SavedWorkflowOwner,
  type SavedWorkflowRevisionDraft,
  type SavedWorkflowRevisionPayloadV1,
  type SavedWorkflowScope,
  type StoredSavedWorkflowRevision,
} from './library-schema.js';

const LIBRARY_DIR = 'workflow-library';
const METADATA_FILE = 'metadata.json';
const REVISIONS_DIR = 'revisions';

export class SavedWorkflowNotFoundError extends Error {
  constructor(public readonly workflowId: string) {
    super(`Saved workflow '${workflowId}' not found`);
    this.name = 'SavedWorkflowNotFoundError';
  }
}

export class SavedWorkflowPermissionError extends Error {
  constructor(public readonly workflowId: string) {
    super(`Only the owner may modify saved workflow '${workflowId}'`);
    this.name = 'SavedWorkflowPermissionError';
  }
}

export class SavedWorkflowConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SavedWorkflowConflictError';
  }
}

export interface CreateSavedWorkflowInput {
  displayName: string;
  aliases?: string[];
  owner: SavedWorkflowOwner;
  scope: SavedWorkflowScope;
  revision: SavedWorkflowRevisionDraft;
  /** true => immediately runnable; false => draft-only. Defaults to true. */
  publish?: boolean;
  /** Test/import seam. Production callers let the store mint the id. */
  workflowId?: string;
  now?: Date;
}

export interface AppendSavedWorkflowRevisionInput {
  actor: SavedWorkflowOwner;
  revision: SavedWorkflowRevisionDraft;
  publish?: boolean;
  /** Optimistic concurrency guard. */
  expectedLatestRevision?: string;
  now?: Date;
}

export interface SavedWorkflowWriteResult {
  metadata: SavedWorkflowMetadata;
  revision: LoadedSavedWorkflowRevision;
}

/**
 * Fully allocated deterministic library object used by crash-recoverable
 * host-owned publishers. Unlike `createSavedWorkflow`, this API never adopts
 * or removes a partial final directory: an existing target must be the exact
 * canonical object the caller expected.
 */
export interface CreateOrRecoverExactSavedWorkflowInput {
  expectedMetadata: SavedWorkflowMetadata;
  expectedRevision: StoredSavedWorkflowRevision;
  /** Committed-state verification sets this false so missing bytes stay fatal. */
  createIfMissing?: boolean;
}

export interface ExactSavedWorkflowWriteResult extends SavedWorkflowWriteResult {
  created: boolean;
}

export interface ListSavedWorkflowOptions {
  chatId?: string;
  actor?: SavedWorkflowOwner;
  includeArchived?: boolean;
  /** Draft-only workflows are owner-visible by default; this can suppress them. */
  includeDrafts?: boolean;
}

export interface SavedWorkflowListResult {
  entries: SavedWorkflowMetadata[];
  invalid: Array<{ workflowId: string; error: string }>;
}

export type SavedWorkflowResolution =
  | { kind: 'not_found' }
  | { kind: 'resolved'; metadata: SavedWorkflowMetadata }
  | { kind: 'ambiguous'; matches: SavedWorkflowMetadata[] };

export function workflowLibraryRoot(dataDir: string): string {
  if (!dataDir) throw new Error('dataDir is required');
  return join(dataDir, LIBRARY_DIR);
}

export function savedWorkflowDir(dataDir: string, workflowId: string): string {
  assertWorkflowId(workflowId);
  return join(workflowLibraryRoot(dataDir), workflowId);
}

export function savedWorkflowMetadataPath(dataDir: string, workflowId: string): string {
  return join(savedWorkflowDir(dataDir, workflowId), METADATA_FILE);
}

/** Stable lock outside the not-yet-created workflow directory. */
function savedWorkflowMutationLockTarget(dataDir: string, workflowId: string): string {
  assertWorkflowId(workflowId);
  return join(workflowLibraryRoot(dataDir), `.mutation-${workflowId}`);
}

/**
 * Existing workflows take both the stable library lock and the pre-v3.1
 * metadata lock. This preserves mutual exclusion during a coordinated rolling
 * upgrade while keeping the stable lock available before a workflow directory
 * exists. Lock order is always stable -> legacy metadata; no new caller takes
 * the reverse order.
 */
function withExistingSavedWorkflowMutationLock<T>(
  dataDir: string,
  workflowId: string,
  fn: () => Promise<T>,
): Promise<T> {
  return withFileLock(savedWorkflowMutationLockTarget(dataDir, workflowId), () =>
    withFileLock(savedWorkflowMetadataPath(dataDir, workflowId), fn));
}

export function savedWorkflowRevisionPath(dataDir: string, workflowId: string, revisionId: string): string {
  assertRevisionId(revisionId);
  return join(savedWorkflowDir(dataDir, workflowId), REVISIONS_DIR, `${revisionId}.json`);
}

function assertWorkflowId(workflowId: string): void {
  if (!SAVED_WORKFLOW_ID_RE.test(workflowId)) {
    throw new Error(`Invalid saved workflow id: ${JSON.stringify(workflowId)}`);
  }
}

function assertRevisionId(revisionId: string): void {
  if (!SAVED_WORKFLOW_REVISION_ID_RE.test(revisionId)) {
    throw new Error(`Invalid saved workflow revision id: ${JSON.stringify(revisionId)}`);
  }
}

function sameOwner(a: SavedWorkflowOwner | undefined, b: SavedWorkflowOwner): boolean {
  return !!a && a.openId === b.openId && a.larkAppId === b.larkAppId;
}

function assertOwner(metadata: SavedWorkflowMetadata, actor: SavedWorkflowOwner): void {
  if (!sameOwner(metadata.owner, actor)) throw new SavedWorkflowPermissionError(metadata.workflowId);
}

function buildRevisionPayload(
  workflowId: string,
  humanVersion: number,
  createdAt: string,
  createdBy: SavedWorkflowOwner,
  draft: SavedWorkflowRevisionDraft,
): SavedWorkflowRevisionPayloadV1 {
  return {
    ...draft,
    workflowId,
    humanVersion,
    createdAt,
    createdBy,
  };
}

function loadedFromStored(stored: StoredSavedWorkflowRevision): LoadedSavedWorkflowRevision {
  return loadSavedWorkflowRevision(stored, {
    workflowId: (stored.payload as SavedWorkflowRevisionPayloadV1).workflowId,
    revisionId: stored.revisionId,
  });
}

function exactLibraryBytes(input: CreateOrRecoverExactSavedWorkflowInput): {
  metadata: SavedWorkflowMetadata;
  revision: StoredSavedWorkflowRevision;
  metadataBytes: string;
  revisionBytes: string;
  loadedRevision: LoadedSavedWorkflowRevision;
} {
  const metadata = validateSavedWorkflowMetadata(input.expectedMetadata);
  if (canonicalJsonStringify(metadata) !== canonicalJsonStringify(input.expectedMetadata)) {
    throw new SavedWorkflowConflictError('Expected Saved Workflow metadata is not canonical');
  }
  const revisionKeys = Object.keys(input.expectedRevision).sort();
  if (canonicalJsonStringify(revisionKeys) !== canonicalJsonStringify([
    'contentHash', 'payload', 'revisionId', 'schemaVersion',
  ])) {
    throw new SavedWorkflowConflictError('Expected Saved Workflow revision has unsupported fields');
  }
  const loadedRevision = loadSavedWorkflowRevision(input.expectedRevision, {
    workflowId: metadata.workflowId,
    revisionId: input.expectedRevision.revisionId,
  });
  const rebuiltRevision = buildSavedWorkflowRevision(loadedRevision.payload);
  if (canonicalJsonStringify(rebuiltRevision) !== canonicalJsonStringify(input.expectedRevision)) {
    throw new SavedWorkflowConflictError('Expected Saved Workflow revision is not canonical');
  }
  if (
    metadata.latestRevision !== loadedRevision.revisionId ||
    (metadata.publishedRevision !== undefined && metadata.publishedRevision !== loadedRevision.revisionId)
  ) {
    throw new SavedWorkflowConflictError('Expected Saved Workflow metadata/revision pointers do not match');
  }
  return {
    metadata,
    revision: input.expectedRevision,
    metadataBytes: `${canonicalJsonStringify(metadata)}\n`,
    revisionBytes: `${canonicalJsonStringify(input.expectedRevision)}\n`,
    loadedRevision,
  };
}

function exactMode(stat: { mode: number }, expected: number): boolean {
  return process.platform === 'win32' || (stat.mode & 0o777) === expected;
}

async function assertExactPrivateDirectory(path: string, label: string): Promise<void> {
  let stat;
  try {
    stat = await fs.lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new SavedWorkflowNotFoundError(label);
    }
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink() || !exactMode(stat, 0o700)) {
    throw new SavedWorkflowConflictError(`Saved Workflow ${label} has unsafe directory topology or permissions`);
  }
}

async function readPrivateFileBytes(path: string, label: string): Promise<string> {
  let before;
  try {
    before = await fs.lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new SavedWorkflowConflictError(`Saved Workflow ${label} is missing`);
    }
    throw error;
  }
  if (
    !before.isFile() || before.isSymbolicLink() || !exactMode(before, 0o600) ||
    (process.platform !== 'win32' && before.nlink !== 1)
  ) {
    throw new SavedWorkflowConflictError(`Saved Workflow ${label} has unsafe file topology or permissions`);
  }
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  const handle = await fs.open(path, fsConstants.O_RDONLY | noFollow);
  try {
    const opened = await handle.stat();
    if (opened.dev !== before.dev || opened.ino !== before.ino || !opened.isFile()) {
      throw new SavedWorkflowConflictError(`Saved Workflow ${label} changed while being verified`);
    }
    const bytes = await handle.readFile({ encoding: 'utf8' });
    const after = await handle.stat();
    const finalPath = await fs.lstat(path);
    if (
      after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs ||
      finalPath.dev !== opened.dev || finalPath.ino !== opened.ino ||
      !finalPath.isFile() || finalPath.isSymbolicLink() ||
      !exactMode(finalPath, 0o600) ||
      (process.platform !== 'win32' && finalPath.nlink !== 1)
    ) {
      throw new SavedWorkflowConflictError(`Saved Workflow ${label} changed while being verified`);
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

async function readExactPrivateFile(path: string, expected: string, label: string): Promise<void> {
  if (await readPrivateFileBytes(path, label) !== expected) {
    throw new SavedWorkflowConflictError(`Saved Workflow ${label} bytes do not match the expected object`);
  }
}

async function assertExactSavedWorkflowDirectory(
  dataDir: string,
  expected: ReturnType<typeof exactLibraryBytes>,
): Promise<void> {
  const workflowId = expected.metadata.workflowId;
  const dir = savedWorkflowDir(dataDir, workflowId);
  const revisionsDir = join(dir, REVISIONS_DIR);
  await assertExactPrivateDirectory(dir, workflowId);
  const rootEntries = (await fs.readdir(dir)).sort();
  if (canonicalJsonStringify(rootEntries) !== canonicalJsonStringify([METADATA_FILE, REVISIONS_DIR])) {
    throw new SavedWorkflowConflictError(`Saved workflow '${workflowId}' has unexpected entries`);
  }
  await assertExactPrivateDirectory(revisionsDir, `${workflowId}/${REVISIONS_DIR}`);
  const revisionName = `${expected.revision.revisionId}.json`;
  const revisionEntries = await fs.readdir(revisionsDir);
  if (revisionEntries.length !== 1 || revisionEntries[0] !== revisionName) {
    throw new SavedWorkflowConflictError(`Saved workflow '${workflowId}' has unexpected revisions`);
  }
  await readExactPrivateFile(
    savedWorkflowMetadataPath(dataDir, workflowId),
    expected.metadataBytes,
    `${workflowId}/${METADATA_FILE}`,
  );
  await readExactPrivateFile(
    savedWorkflowRevisionPath(dataDir, workflowId, expected.revision.revisionId),
    expected.revisionBytes,
    `${workflowId}/${REVISIONS_DIR}/${revisionName}`,
  );
}

async function writePrivateStagedFile(path: string, bytes: string): Promise<void> {
  await fs.writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
  await fs.chmod(path, 0o600);
  fsyncRegularFileSync(path);
}

/**
 * Publish one deterministic Saved Workflow as an all-or-nothing directory.
 * The final target is never cleaned up or repaired in place. Recovery accepts
 * it only after exact topology, permission, and canonical-byte verification.
 */
export async function createOrRecoverExactSavedWorkflow(
  dataDir: string,
  input: CreateOrRecoverExactSavedWorkflowInput,
): Promise<ExactSavedWorkflowWriteResult> {
  const expected = exactLibraryBytes(input);
  const workflowId = expected.metadata.workflowId;
  const root = workflowLibraryRoot(dataDir);
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  fsyncDirectorySyncPortable(dataDir);
  const lockTarget = savedWorkflowMutationLockTarget(dataDir, workflowId);
  return withFileLock(lockTarget, async () => {
    try {
      await assertExactSavedWorkflowDirectory(dataDir, expected);
      // A prior process may have renamed the final directory and crashed
      // before fsyncing the library root. Recovery must close that durability
      // window before it reports the exact object as committed.
      fsyncRegularFileSync(savedWorkflowMetadataPath(dataDir, workflowId));
      fsyncRegularFileSync(savedWorkflowRevisionPath(
        dataDir, workflowId, expected.revision.revisionId,
      ));
      fsyncDirectorySyncPortable(join(savedWorkflowDir(dataDir, workflowId), REVISIONS_DIR));
      fsyncDirectorySyncPortable(savedWorkflowDir(dataDir, workflowId));
      fsyncDirectorySyncPortable(root);
      return { metadata: expected.metadata, revision: expected.loadedRevision, created: false };
    } catch (error) {
      if (!(error instanceof SavedWorkflowNotFoundError)) throw error;
      if (input.createIfMissing === false) throw error;
    }

    const stage = join(root, `.staging-exact-${workflowId}-${randomUUID()}`);
    const stagedRevisions = join(stage, REVISIONS_DIR);
    let stageOwned = false;
    try {
      await fs.mkdir(stage, { mode: 0o700 });
      stageOwned = true;
      await fs.chmod(stage, 0o700);
      await fs.mkdir(stagedRevisions, { mode: 0o700 });
      await fs.chmod(stagedRevisions, 0o700);
      await writePrivateStagedFile(join(stage, METADATA_FILE), expected.metadataBytes);
      await writePrivateStagedFile(
        join(stagedRevisions, `${expected.revision.revisionId}.json`),
        expected.revisionBytes,
      );
      fsyncDirectorySyncPortable(stagedRevisions);
      fsyncDirectorySyncPortable(stage);

      // The workflow-specific lock serializes cooperating publishers. Refuse
      // any pre-existing final path; in particular, never rm or adopt a
      // foreign partial directory.
      try {
        await fs.lstat(savedWorkflowDir(dataDir, workflowId));
        throw new SavedWorkflowConflictError(`Saved workflow '${workflowId}' already exists incompletely`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      await fs.rename(stage, savedWorkflowDir(dataDir, workflowId));
      stageOwned = false;
      fsyncDirectorySyncPortable(root);
      await assertExactSavedWorkflowDirectory(dataDir, expected);
      return { metadata: expected.metadata, revision: expected.loadedRevision, created: true };
    } finally {
      if (stageOwned) {
        try { await fs.rm(stage, { recursive: true, force: true }); } catch { /* owned staging only */ }
      }
    }
  });
}

/**
 * Recover an exact publisher after its original single-revision directory was
 * legitimately advanced by ordinary owner mutations. The immutable origin
 * revision must still have the exact canonical bytes and private topology that
 * were approved; current metadata and later revisions are read under the same
 * workflow mutation lock and must themselves remain canonical private files.
 */
export async function verifyExactSavedWorkflowOrigin(
  dataDir: string,
  input: CreateOrRecoverExactSavedWorkflowInput,
): Promise<SavedWorkflowWriteResult> {
  const expected = exactLibraryBytes(input);
  const workflowId = expected.metadata.workflowId;
  return withExistingSavedWorkflowMutationLock(dataDir, workflowId, async () => {
    const dir = savedWorkflowDir(dataDir, workflowId);
    const revisionsDir = join(dir, REVISIONS_DIR);
    await assertExactPrivateDirectory(dir, workflowId);
    const rootEntries = (await fs.readdir(dir)).sort();
    // This verifier deliberately holds the legacy metadata lock as the inner
    // half of the rolling-upgrade dual lock. Stale-break protocols may leave
    // rigorously named, inert hard-link/owner artifacts after the public lock
    // is gone. They never participate in metadata/revision reads, but rejecting
    // them here would permanently wedge deterministic commit recovery.
    const requiredRootEntries = [
      METADATA_FILE,
      `${METADATA_FILE}.lock`,
      REVISIONS_DIR,
    ];
    const allowedLockArtifact = (name: string): boolean =>
      name === `${METADATA_FILE}.lock.stale-claim` ||
      /^\.botmux-stale-claim-[0-9a-f]{24}(?:\.owner-[0-9]{12})?$/.test(name);
    const unexpected = rootEntries.filter((name) =>
      !requiredRootEntries.includes(name) && !allowedLockArtifact(name));
    if (unexpected.length > 0 || requiredRootEntries.some((name) => !rootEntries.includes(name))) {
      throw new SavedWorkflowConflictError(`Saved workflow '${workflowId}' has unexpected entries`);
    }
    for (const name of rootEntries.filter(allowedLockArtifact)) {
      const artifact = await fs.lstat(join(dir, name));
      if (!artifact.isFile() || artifact.isSymbolicLink()) {
        throw new SavedWorkflowConflictError(`Saved workflow '${workflowId}' has unsafe lock artifacts`);
      }
    }
    await assertExactPrivateDirectory(revisionsDir, `${workflowId}/${REVISIONS_DIR}`);

    const metadataBytes = await readPrivateFileBytes(
      savedWorkflowMetadataPath(dataDir, workflowId),
      `${workflowId}/${METADATA_FILE}`,
    );
    let metadata: SavedWorkflowMetadata;
    try {
      metadata = validateSavedWorkflowMetadata(JSON.parse(metadataBytes));
    } catch {
      throw new SavedWorkflowConflictError(`Saved workflow '${workflowId}' metadata is invalid`);
    }
    if (metadataBytes !== `${canonicalJsonStringify(metadata)}\n`) {
      throw new SavedWorkflowConflictError(`Saved workflow '${workflowId}' metadata is not canonical`);
    }

    const revisionNames = (await fs.readdir(revisionsDir)).sort();
    const expectedName = `${expected.revision.revisionId}.json`;
    if (!revisionNames.includes(expectedName)) {
      throw new SavedWorkflowConflictError(`Saved workflow '${workflowId}' origin revision is missing`);
    }
    const loadedRevisions: LoadedSavedWorkflowRevision[] = [];
    for (const name of revisionNames) {
      const revisionId = name.endsWith('.json') ? name.slice(0, -5) : '';
      if (!SAVED_WORKFLOW_REVISION_ID_RE.test(revisionId)) {
        throw new SavedWorkflowConflictError(`Saved workflow '${workflowId}' has an invalid revision entry`);
      }
      const path = savedWorkflowRevisionPath(dataDir, workflowId, revisionId);
      if (name === expectedName) {
        await readExactPrivateFile(
          path,
          expected.revisionBytes,
          `${workflowId}/${REVISIONS_DIR}/${name}`,
        );
        loadedRevisions.push(expected.loadedRevision);
        continue;
      }
      const bytes = await readPrivateFileBytes(path, `${workflowId}/${REVISIONS_DIR}/${name}`);
      try {
        const parsed = JSON.parse(bytes) as unknown;
        const loaded = loadSavedWorkflowRevision(parsed, { workflowId, revisionId });
        if (bytes !== `${canonicalJsonStringify(buildSavedWorkflowRevision(loaded.payload))}\n`) {
          throw new Error('non-canonical');
        }
        loadedRevisions.push(loaded);
      } catch {
        throw new SavedWorkflowConflictError(`Saved workflow '${workflowId}' has an invalid revision`);
      }
    }
    const expectedOwner = canonicalJsonStringify(expected.metadata.owner);
    const versions = new Map<number, StoredSavedWorkflowRevision>();
    for (const revision of loadedRevisions) {
      if (canonicalJsonStringify(revision.payload.createdBy) !== expectedOwner ||
          versions.has(revision.payload.humanVersion)) {
        throw new SavedWorkflowConflictError(`Saved workflow '${workflowId}' revision lineage is invalid`);
      }
      versions.set(revision.payload.humanVersion, revision);
    }
    const minVersion = expected.loadedRevision.payload.humanVersion;
    const maxVersion = Math.max(...versions.keys());
    for (let version = minVersion; version <= maxVersion; version++) {
      if (!versions.has(version)) {
        throw new SavedWorkflowConflictError(`Saved workflow '${workflowId}' revision lineage is incomplete`);
      }
    }
    const latest = versions.get(maxVersion)!;
    const stableMetadata =
      metadata.workflowId === expected.metadata.workflowId &&
      metadata.displayName === expected.metadata.displayName &&
      canonicalJsonStringify(metadata.aliases) === canonicalJsonStringify(expected.metadata.aliases) &&
      canonicalJsonStringify(metadata.owner) === expectedOwner &&
      canonicalJsonStringify(metadata.scope) === canonicalJsonStringify(expected.metadata.scope) &&
      metadata.createdAt === expected.metadata.createdAt;
    if (
      !stableMetadata ||
      (metadata.status !== 'active' && metadata.status !== 'archived') ||
      metadata.latestRevision !== latest.revisionId ||
      !metadata.publishedRevision ||
      !revisionNames.includes(`${metadata.publishedRevision}.json`)
    ) {
      throw new SavedWorkflowConflictError(`Saved workflow '${workflowId}' metadata lineage is invalid`);
    }
    fsyncRegularFileSync(savedWorkflowMetadataPath(dataDir, workflowId));
    for (const name of revisionNames) {
      fsyncRegularFileSync(join(revisionsDir, name));
    }
    fsyncDirectorySyncPortable(revisionsDir);
    fsyncDirectorySyncPortable(dir);
    fsyncDirectorySyncPortable(workflowLibraryRoot(dataDir));
    return { metadata, revision: expected.loadedRevision };
  });
}

export async function createSavedWorkflow(
  dataDir: string,
  input: CreateSavedWorkflowInput,
): Promise<SavedWorkflowWriteResult> {
  const workflowId = input.workflowId ?? mintSavedWorkflowId();
  assertWorkflowId(workflowId);
  const now = (input.now ?? new Date()).toISOString();
  const stored = buildSavedWorkflowRevision(
    buildRevisionPayload(workflowId, 1, now, input.owner, input.revision),
  );
  const publish = input.publish !== false;
  const metadata = validateSavedWorkflowMetadata({
    schemaVersion: SAVED_WORKFLOW_METADATA_SCHEMA_VERSION,
    workflowId,
    displayName: input.displayName,
    aliases: input.aliases ?? [],
    owner: input.owner,
    scope: input.scope,
    status: publish ? 'active' : 'draft',
    latestRevision: stored.revisionId,
    ...(publish ? { publishedRevision: stored.revisionId } : {}),
    createdAt: now,
    updatedAt: now,
  });

  const root = workflowLibraryRoot(dataDir);
  const dir = savedWorkflowDir(dataDir, workflowId);
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  fsyncDirectorySyncPortable(dataDir);
  return withFileLock(savedWorkflowMutationLockTarget(dataDir, workflowId), async () => {
    try {
      await fs.mkdir(dir, { mode: 0o700 });
      fsyncDirectorySyncPortable(root);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new SavedWorkflowConflictError(`Saved workflow '${workflowId}' already exists`);
      }
      throw err;
    }

    try {
      await fs.mkdir(join(dir, REVISIONS_DIR), { mode: 0o700 });
      fsyncDirectorySyncPortable(dir);
      await writeImmutableRevision(dataDir, workflowId, stored);
      await writeMetadata(dataDir, metadata);
    } catch (err) {
      // The id was newly allocated by this call. A failed create is not visible
      // through metadata, so remove its private partial directory best-effort.
      try { await fs.rm(dir, { recursive: true, force: true }); } catch { /* best effort */ }
      throw err;
    }

    return { metadata, revision: loadedFromStored(stored) };
  });
}

export async function readSavedWorkflowMetadata(
  dataDir: string,
  workflowId: string,
): Promise<SavedWorkflowMetadata> {
  const path = savedWorkflowMetadataPath(dataDir, workflowId);
  let raw: string;
  try {
    raw = await fs.readFile(path, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new SavedWorkflowNotFoundError(workflowId);
    throw err;
  }
  return validateSavedWorkflowMetadata(JSON.parse(raw));
}

export async function readSavedWorkflowRevision(
  dataDir: string,
  workflowId: string,
  revisionId: string,
): Promise<LoadedSavedWorkflowRevision> {
  const path = savedWorkflowRevisionPath(dataDir, workflowId, revisionId);
  let raw: string;
  try {
    raw = await fs.readFile(path, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new SavedWorkflowNotFoundError(`${workflowId}@${revisionId}`);
    }
    throw err;
  }
  return loadSavedWorkflowRevision(JSON.parse(raw), { workflowId, revisionId });
}

export async function loadCurrentSavedWorkflow(
  dataDir: string,
  workflowId: string,
  opts: { revision?: 'latest' | 'published'; requireActive?: boolean } = {},
): Promise<{ metadata: SavedWorkflowMetadata; revision: LoadedSavedWorkflowRevision }> {
  const metadata = await readSavedWorkflowMetadata(dataDir, workflowId);
  const usePublished = (opts.revision ?? 'published') === 'published';
  if (opts.requireActive !== false && (metadata.status !== 'active' || !metadata.publishedRevision)) {
    throw new SavedWorkflowConflictError(`Saved workflow '${workflowId}' is not active`);
  }
  const revisionId = usePublished ? metadata.publishedRevision : metadata.latestRevision;
  if (!revisionId) throw new SavedWorkflowConflictError(`Saved workflow '${workflowId}' has no published revision`);
  return { metadata, revision: await readSavedWorkflowRevision(dataDir, workflowId, revisionId) };
}

export async function appendSavedWorkflowRevision(
  dataDir: string,
  workflowId: string,
  input: AppendSavedWorkflowRevisionInput,
): Promise<SavedWorkflowWriteResult> {
  return withExistingSavedWorkflowMutationLock(dataDir, workflowId, async () => {
    const metadata = await readSavedWorkflowMetadata(dataDir, workflowId);
    assertOwner(metadata, input.actor);
    if (metadata.status === 'archived') {
      throw new SavedWorkflowConflictError(`Saved workflow '${workflowId}' is archived`);
    }
    if (input.expectedLatestRevision && metadata.latestRevision !== input.expectedLatestRevision) {
      throw new SavedWorkflowConflictError(
        `Saved workflow '${workflowId}' changed: expected latest ${input.expectedLatestRevision}, got ${metadata.latestRevision}`,
      );
    }
    const previous = await readSavedWorkflowRevision(dataDir, workflowId, metadata.latestRevision);
    const now = (input.now ?? new Date()).toISOString();
    const stored = buildSavedWorkflowRevision(
      buildRevisionPayload(
        workflowId,
        previous.payload.humanVersion + 1,
        now,
        input.actor,
        input.revision,
      ),
    );
    await writeImmutableRevision(dataDir, workflowId, stored);
    const publish = input.publish === true;
    const next = validateSavedWorkflowMetadata({
      ...metadata,
      latestRevision: stored.revisionId,
      ...(publish ? { publishedRevision: stored.revisionId } : {}),
      status: publish || metadata.publishedRevision ? 'active' : 'draft',
      updatedAt: now,
    });
    await writeMetadata(dataDir, next);
    return { metadata: next, revision: loadedFromStored(stored) };
  });
}

/** Publish an already-saved latest draft without creating a new revision. */
export async function publishLatestSavedWorkflow(
  dataDir: string,
  workflowId: string,
  input: { actor: SavedWorkflowOwner; expectedLatestRevision?: string; now?: Date },
): Promise<SavedWorkflowMetadata> {
  return withExistingSavedWorkflowMutationLock(dataDir, workflowId, async () => {
    const metadata = await readSavedWorkflowMetadata(dataDir, workflowId);
    assertOwner(metadata, input.actor);
    if (metadata.status === 'archived') throw new SavedWorkflowConflictError(`Saved workflow '${workflowId}' is archived`);
    if (input.expectedLatestRevision && input.expectedLatestRevision !== metadata.latestRevision) {
      throw new SavedWorkflowConflictError(
        `Saved workflow '${workflowId}' changed: expected latest ${input.expectedLatestRevision}, got ${metadata.latestRevision}`,
      );
    }
    // Validate the target before exposing it as runnable.
    await readSavedWorkflowRevision(dataDir, workflowId, metadata.latestRevision);
    const next = validateSavedWorkflowMetadata({
      ...metadata,
      status: 'active',
      publishedRevision: metadata.latestRevision,
      updatedAt: (input.now ?? new Date()).toISOString(),
    });
    await writeMetadata(dataDir, next);
    return next;
  });
}

export async function archiveSavedWorkflow(
  dataDir: string,
  workflowId: string,
  input: { actor: SavedWorkflowOwner; now?: Date },
): Promise<SavedWorkflowMetadata> {
  return withExistingSavedWorkflowMutationLock(dataDir, workflowId, async () => {
    const metadata = await readSavedWorkflowMetadata(dataDir, workflowId);
    assertOwner(metadata, input.actor);
    const next = validateSavedWorkflowMetadata({
      ...metadata,
      status: 'archived',
      updatedAt: (input.now ?? new Date()).toISOString(),
    });
    await writeMetadata(dataDir, next);
    return next;
  });
}

export async function listSavedWorkflows(
  dataDir: string,
  opts: ListSavedWorkflowOptions = {},
): Promise<SavedWorkflowListResult> {
  const root = workflowLibraryRoot(dataDir);
  let names: string[];
  try {
    names = await fs.readdir(root);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { entries: [], invalid: [] };
    throw err;
  }
  const entries: SavedWorkflowMetadata[] = [];
  const invalid: Array<{ workflowId: string; error: string }> = [];
  for (const workflowId of names.sort()) {
    if (!SAVED_WORKFLOW_ID_RE.test(workflowId)) continue;
    try {
      const metadata = await readSavedWorkflowMetadata(dataDir, workflowId);
      if (!isVisible(metadata, opts)) continue;
      entries.push(metadata);
    } catch (err) {
      invalid.push({ workflowId, error: err instanceof Error ? err.message : String(err) });
    }
  }
  entries.sort((a, b) => a.displayName.localeCompare(b.displayName) || a.workflowId.localeCompare(b.workflowId));
  return { entries, invalid };
}

function isVisible(metadata: SavedWorkflowMetadata, opts: ListSavedWorkflowOptions): boolean {
  // Every saved workflow is namespaced by the app that created it. `global`
  // means global to that bot/app, not global to every bot sharing dataDir.
  if (!opts.actor || metadata.owner.larkAppId !== opts.actor.larkAppId) return false;
  if (metadata.status === 'archived' && opts.includeArchived !== true) return false;
  if (metadata.scope.kind === 'chat' && metadata.scope.chatId !== opts.chatId) return false;
  if (metadata.status === 'draft') {
    if (opts.includeDrafts === false) return false;
    if (!sameOwner(opts.actor, metadata.owner)) return false;
  }
  return true;
}

export async function resolveSavedWorkflowRef(
  dataDir: string,
  ref: string,
  opts: ListSavedWorkflowOptions = {},
): Promise<SavedWorkflowResolution> {
  const normalized = normalizeSavedWorkflowLookupKey(ref);
  const { entries } = await listSavedWorkflows(dataDir, opts);
  const matches = entries.filter((metadata) =>
    metadata.workflowId === ref ||
    normalizeSavedWorkflowLookupKey(metadata.displayName) === normalized ||
    metadata.aliases.some((alias) => normalizeSavedWorkflowLookupKey(alias) === normalized));
  if (matches.length === 0) return { kind: 'not_found' };
  if (matches.length > 1) return { kind: 'ambiguous', matches };
  return { kind: 'resolved', metadata: matches[0]! };
}

async function writeMetadata(dataDir: string, metadata: SavedWorkflowMetadata): Promise<void> {
  const normalized = validateSavedWorkflowMetadata(metadata);
  await atomicWriteFile(
    savedWorkflowMetadataPath(dataDir, normalized.workflowId),
    `${canonicalJsonStringify(normalized)}\n`,
    { mode: 0o600 },
  );
  const path = savedWorkflowMetadataPath(dataDir, normalized.workflowId);
  fsyncRegularFileSync(path);
  fsyncDirectorySyncPortable(savedWorkflowDir(dataDir, normalized.workflowId));
}

/**
 * Install a completed sibling temp file via hard-link. `link` is atomic and
 * refuses replacement, unlike rename(2). The workflow mutation lock
 * serializes normal writers; EEXIST comparison keeps retries idempotent and
 * detects tamper.
 */
async function writeImmutableRevision(
  dataDir: string,
  workflowId: string,
  revision: StoredSavedWorkflowRevision,
): Promise<void> {
  const target = savedWorkflowRevisionPath(dataDir, workflowId, revision.revisionId);
  const tmp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  const encoded = `${canonicalJsonStringify(revision)}\n`;
  try {
    await fs.writeFile(tmp, encoded, { flag: 'wx', mode: 0o600 });
    await fs.chmod(tmp, 0o600);
    fsyncRegularFileSync(tmp);
    try {
      await fs.link(tmp, target);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const existing = await fs.readFile(target, 'utf-8');
      if (existing !== encoded) {
        throw new SavedWorkflowConflictError(
          `Immutable revision ${revision.revisionId} already exists with different content`,
        );
      }
    }
  } finally {
    try { await fs.unlink(tmp); } catch { /* best effort */ }
  }

  // Defense-in-depth: ensure the installed target is readable before a
  // metadata pointer can expose it. access() also catches a failed link on odd
  // filesystems before the pointer update.
  await fs.access(target, fsConstants.R_OK);
  fsyncRegularFileSync(target);
  fsyncDirectorySyncPortable(join(savedWorkflowDir(dataDir, workflowId), REVISIONS_DIR));
}
