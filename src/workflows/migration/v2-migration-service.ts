/** Transactional host service for committing one converted v2 definition. */

import type { BotConfig } from '../../bot-registry.js';
import { existsSync, promises as fs, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { canonicalJsonStringify } from '../../utils/canonical-json.js';
import { withFileLock } from '../../utils/file-lock.js';
import { parseWorkflowDefinition, type WorkflowDefinition } from '../definition.js';
import {
  buildSavedWorkflowRevision,
  type LoadedSavedWorkflowRevision,
  type SavedWorkflowMetadata,
  type SavedWorkflowOwner,
  type SavedWorkflowRevisionDraft,
  type SavedWorkflowScope,
} from '../v3/library-schema.js';
import {
  SavedWorkflowConflictError,
  SavedWorkflowNotFoundError,
  appendSavedWorkflowRevision,
  createSavedWorkflow,
  loadCurrentSavedWorkflow,
  publishLatestSavedWorkflow,
  readSavedWorkflowMetadata,
  readSavedWorkflowRevision,
  savedWorkflowDir,
  workflowLibraryRoot,
} from '../v3/library-store.js';
import {
  commitLegacyMigration,
  computeLegacyConversionHash,
  findLegacyMigration,
  legacyDefinitionIdentity,
  legacySourceKey,
  migratedSavedWorkflowId,
  prepareLegacyMigration,
  readLegacyMigrationLedger,
  supersedePendingLegacyMigration,
  type LegacyDefinitionIdentity,
  type LegacyMigrationRevisionRecord,
  type LegacyMigrationSourceRecord,
  type LegacyMigrationTarget,
} from './v2-ledger.js';
import {
  convertLegacyWorkflowDefinition,
  type LegacyConversionTargetContext,
  type LegacyMigrationIssue,
} from './v2-to-v3.js';

export type LegacyMigrationCommitPhase =
  | 'after-pending'
  | 'after-library-write'
  | 'after-publish';

export interface CommitLegacyWorkflowMigrationInput {
  dataDir: string;
  sourcePath: string;
  bots: BotConfig[];
  owner: SavedWorkflowOwner;
  scope: SavedWorkflowScope;
  chatType?: 'group' | 'p2p';
  acknowledgeWarnings?: boolean;
  /** Explicit recovery when an unmaterialized pending allocation lost its library CAS base. */
  supersedePending?: boolean;
  now?: Date;
  /** Crash-injection/test seam. Production callers omit it. */
  onPhase?: (phase: LegacyMigrationCommitPhase) => void | Promise<void>;
}

export interface CommitLegacyWorkflowMigrationResult {
  identity: LegacyDefinitionIdentity;
  source: LegacyMigrationSourceRecord;
  revisionRecord: LegacyMigrationRevisionRecord;
  metadata: SavedWorkflowMetadata;
  revision: LoadedSavedWorkflowRevision;
  createdWorkflow: boolean;
  appendedRevision: boolean;
  issues: LegacyMigrationIssue[];
}

export class LegacyWorkflowConversionError extends Error {
  constructor(public readonly issues: LegacyMigrationIssue[]) {
    super(
      `Legacy workflow cannot be migrated:\n${issues.map((item) =>
        `- [${item.severity}] ${item.code} ${item.path}: ${item.message}`).join('\n')}`,
    );
    this.name = 'LegacyWorkflowConversionError';
  }
}

export class LegacyWorkflowMigrationConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LegacyWorkflowMigrationConflictError';
  }
}

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalJsonStringify(left) === canonicalJsonStringify(right);
}

function sameOwner(left: SavedWorkflowOwner, right: SavedWorkflowOwner): boolean {
  return left.openId === right.openId && left.larkAppId === right.larkAppId;
}

function sameScope(left: SavedWorkflowScope, right: SavedWorkflowScope): boolean {
  return sameJson(left, right);
}

function comparableDraft(payload: LoadedSavedWorkflowRevision['payload']): SavedWorkflowRevisionDraft {
  return {
    ...(payload.sourceRunId ? { sourceRunId: payload.sourceRunId } : {}),
    inputs: payload.inputs,
    contextRefs: payload.contextRefs,
    specTemplate: payload.specTemplate,
    specStatus: payload.specStatus,
    dagTemplate: payload.dagTemplate,
    safety: payload.safety,
  };
}

function readAndParseSource(path: string): WorkflowDefinition {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (err) {
    throw new LegacyWorkflowMigrationConflictError(
      `Cannot read legacy definition ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  try {
    return parseWorkflowDefinition(JSON.parse(raw));
  } catch (err) {
    throw new LegacyWorkflowMigrationConflictError(
      `Legacy definition ${path} is no longer valid: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function buildAllocatedRevision(input: {
  workflowId: string;
  humanVersion: number;
  createdAt: string;
  owner: SavedWorkflowOwner;
  draft: SavedWorkflowRevisionDraft;
}) {
  return buildSavedWorkflowRevision({
    ...input.draft,
    workflowId: input.workflowId,
    humanVersion: input.humanVersion,
    createdAt: input.createdAt,
    createdBy: input.owner,
  });
}

async function maybeLoadMetadata(
  dataDir: string,
  workflowId: string,
): Promise<SavedWorkflowMetadata | undefined> {
  try {
    return await readSavedWorkflowMetadata(dataDir, workflowId);
  } catch (err) {
    if (err instanceof SavedWorkflowNotFoundError) return undefined;
    throw err;
  }
}

function assertTargetOwnership(
  metadata: SavedWorkflowMetadata,
  target: LegacyMigrationTarget,
): void {
  if (!sameOwner(metadata.owner, target.owner) || !sameScope(metadata.scope, target.scope)) {
    throw new LegacyWorkflowMigrationConflictError(
      `Deterministic target ${metadata.workflowId} exists with a different owner or scope`,
    );
  }
  if (metadata.status === 'archived') {
    throw new LegacyWorkflowMigrationConflictError(
      `Deterministic target ${metadata.workflowId} is archived; migration will not revive it implicitly`,
    );
  }
}

function assertNoForeignPendingRevision(
  source: LegacyMigrationSourceRecord | undefined,
  currentContentHash: string,
): void {
  if (!source) return;
  const pending = Object.values(source.revisions).filter((item) =>
    item.state === 'pending' && item.contentHash !== currentContentHash);
  if (pending.length === 0) return;
  throw new LegacyWorkflowMigrationConflictError(
    `Source ${source.legacy.workflowId} has an older pending migration ` +
    `(${pending.map((item) => item.contentHash).join(', ')}). Restore that source revision and ` +
    're-run migration to recover it before migrating the edited definition.',
  );
}

async function verifyCommittedTarget(input: {
  dataDir: string;
  source: LegacyMigrationSourceRecord;
  record: LegacyMigrationRevisionRecord;
}): Promise<{ metadata: SavedWorkflowMetadata; revision: LoadedSavedWorkflowRevision }> {
  const metadata = await readSavedWorkflowMetadata(input.dataDir, input.source.target.workflowId);
  assertTargetOwnership(metadata, input.source.target);
  const revision = await readSavedWorkflowRevision(
    input.dataDir,
    input.source.target.workflowId,
    input.record.targetRevisionId,
  );
  if (
    revision.payload.humanVersion !== input.record.targetHumanVersion ||
    revision.payload.createdAt !== input.record.targetCreatedAt ||
    computeLegacyConversionHash(comparableDraft(revision.payload)) !== input.record.conversionHash
  ) {
    throw new LegacyWorkflowMigrationConflictError(
      `Target revision ${input.record.targetRevisionId} does not match its migration ledger allocation`,
    );
  }
  if (metadata.status !== 'active' || metadata.publishedRevision !== input.record.targetRevisionId) {
    // A user may have published a newer version after migration. That is valid
    // library evolution; the immutable migrated revision merely has to remain
    // present and verified.
    if (!metadata.publishedRevision) {
      throw new LegacyWorkflowMigrationConflictError(
        `Committed target ${metadata.workflowId} no longer has a published revision`,
      );
    }
  }
  return { metadata, revision };
}

async function savedRevisionExists(
  dataDir: string,
  workflowId: string,
  revisionId: string,
): Promise<boolean> {
  try {
    await readSavedWorkflowRevision(dataDir, workflowId, revisionId);
    return true;
  } catch (err) {
    if (err instanceof SavedWorkflowNotFoundError) return false;
    throw err;
  }
}

function sourceRecordForIdentity(
  dataDir: string,
  identity: LegacyDefinitionIdentity,
): LegacyMigrationSourceRecord | undefined {
  return readLegacyMigrationLedger(dataDir).sources[legacySourceKey(identity)];
}

/** Commit one source revision. Definitions in a batch remain independent. */
export async function commitLegacyWorkflowMigration(
  input: CommitLegacyWorkflowMigrationInput,
): Promise<CommitLegacyWorkflowMigrationResult> {
  const initiallyParsed = readAndParseSource(input.sourcePath);
  const initialIdentity = legacyDefinitionIdentity(input.sourcePath, initiallyParsed);
  const targetWorkflowId = migratedSavedWorkflowId(initialIdentity);
  const target: LegacyMigrationTarget = {
    workflowId: targetWorkflowId,
    owner: input.owner,
    scope: input.scope,
  };
  const root = workflowLibraryRoot(input.dataDir);
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const sourceLock = join(root, `.v2-source-${legacySourceKey(initialIdentity)}`);

  return withFileLock(sourceLock, async () => {
    const definition = readAndParseSource(initialIdentity.path);
    const identity = legacyDefinitionIdentity(initialIdentity.path, definition);
    if (
      identity.path !== initialIdentity.path ||
      identity.workflowId !== initialIdentity.workflowId
    ) {
      throw new LegacyWorkflowMigrationConflictError('Legacy source identity changed while acquiring its migration lock');
    }

    const targetContext: LegacyConversionTargetContext = {
      owner: input.owner,
      scope: input.scope,
      ...(input.chatType ? { chatType: input.chatType } : {}),
    };
    const converted = convertLegacyWorkflowDefinition({
      definition,
      bots: input.bots,
      target: targetContext,
    });
    let lookup = findLegacyMigration(input.dataDir, identity);
    if (lookup.kind === 'exact' && lookup.revision.state === 'committed') {
      if (!sameJson(lookup.source.target, target)) {
        throw new LegacyWorkflowMigrationConflictError(
          `Migration target owner/scope differs from the existing committed source ${lookup.source.sourceKey}`,
        );
      }
      const verified = await verifyCommittedTarget({
        dataDir: input.dataDir,
        source: lookup.source,
        record: lookup.revision,
      });
      const currentConversionHash = converted.ok
        ? computeLegacyConversionHash(converted.revision)
        : undefined;
      const converterChanged = currentConversionHash !== lookup.revision.conversionHash;
      const replayIssues: LegacyMigrationIssue[] = converterChanged
        ? [{
          severity: 'warning',
          code: 'CONVERTER_CHANGED_AFTER_COMMIT',
          path: identity.path,
          message:
            'The current converter no longer reproduces this historical conversion byte-for-byte; ' +
            'the immutable committed target was verified against the ledger and remains valid.',
          hint: 'No recovery is required. Review converter release notes before migrating newer source revisions.',
        }]
        : converted.issues;
      return {
        identity,
        source: lookup.source,
        revisionRecord: lookup.revision,
        metadata: verified.metadata,
        revision: verified.revision,
        createdWorkflow: false,
        appendedRevision: false,
        issues: replayIssues,
      };
    }

    if (!converted.ok) throw new LegacyWorkflowConversionError(converted.issues);
    const warnings = converted.issues.filter((item) => item.severity === 'warning');
    if (warnings.length > 0 && input.acknowledgeWarnings !== true) {
      throw new LegacyWorkflowConversionError(warnings.map((item) => ({
        ...item,
        message: `${item.message} Commit requires --ack-warnings.`,
      })));
    }
    const conversionHash = computeLegacyConversionHash(converted.revision);

    const sourceRecord = sourceRecordForIdentity(input.dataDir, identity);
    if (sourceRecord && !sameJson(sourceRecord.target, target)) {
      throw new LegacyWorkflowMigrationConflictError(
        `Source ${sourceRecord.sourceKey} already belongs to another owner, scope, or target`,
      );
    }
    assertNoForeignPendingRevision(sourceRecord, identity.contentHash);

    let metadata = await maybeLoadMetadata(input.dataDir, targetWorkflowId);
    if (!sourceRecord && metadata) {
      throw new LegacyWorkflowMigrationConflictError(
        `Deterministic target ${targetWorkflowId} exists without a matching migration ledger source`,
      );
    }
    if (metadata) assertTargetOwnership(metadata, target);

    if (
      lookup.kind === 'exact' &&
      lookup.revision.state === 'pending' &&
      metadata &&
      metadata.latestRevision !== lookup.revision.targetRevisionId &&
      metadata.latestRevision !== lookup.revision.expectedLatestRevision
    ) {
      if (!input.supersedePending) {
        throw new LegacyWorkflowMigrationConflictError(
          `Pending allocation ${lookup.revision.migrationKey} expected library base ` +
          `${lookup.revision.expectedLatestRevision ?? '(new workflow)'}, but latest is ` +
          `${metadata.latestRevision}. If the allocated revision was never materialized, ` +
          're-run with --supersede-pending to retain the old allocation as audit and rebase explicitly.',
        );
      }
      if (await savedRevisionExists(
        input.dataDir,
        targetWorkflowId,
        lookup.revision.targetRevisionId,
      )) {
        throw new LegacyWorkflowMigrationConflictError(
          `Pending target ${lookup.revision.targetRevisionId} already exists; it cannot be superseded. ` +
          'Inspect the Saved Workflow history and recover the published revision explicitly.',
        );
      }

      const latest = await readSavedWorkflowRevision(
        input.dataDir,
        targetWorkflowId,
        metadata.latestRevision,
      );
      const latestMatches =
        computeLegacyConversionHash(comparableDraft(latest.payload)) === conversionHash;
      const targetCreatedAt = latestMatches
        ? latest.payload.createdAt
        : (input.now ?? new Date()).toISOString();
      const targetHumanVersion = latestMatches
        ? latest.payload.humanVersion
        : latest.payload.humanVersion + 1;
      const reallocated = buildAllocatedRevision({
        workflowId: targetWorkflowId,
        humanVersion: targetHumanVersion,
        createdAt: targetCreatedAt,
        owner: input.owner,
        draft: converted.revision,
      });
      const superseded = supersedePendingLegacyMigration(input.dataDir, {
        identity,
        target,
        previousTargetRevisionId: lookup.revision.targetRevisionId,
        conversionHash,
        targetRevisionId: reallocated.revisionId,
        targetHumanVersion,
        targetCreatedAt,
        expectedLatestRevision: metadata.latestRevision,
        reason: 'target_latest_changed_before_materialization',
        now: input.now,
      });
      // Recheck the proof after publishing the ledger replacement. A race can
      // only make recovery fail closed; it never permits two active targets.
      if (await savedRevisionExists(
        input.dataDir,
        targetWorkflowId,
        lookup.revision.targetRevisionId,
      )) {
        throw new LegacyWorkflowMigrationConflictError(
          `Superseded target ${lookup.revision.targetRevisionId} appeared concurrently; ` +
          'migration remains pending for manual inspection.',
        );
      }
      lookup = { kind: 'exact', source: superseded.source, revision: superseded.revision };
    }

    let allocated: {
      targetRevisionId: string;
      targetHumanVersion: number;
      targetCreatedAt: string;
      expectedLatestRevision?: string;
    };
    let expectedStored;
    if (lookup.kind === 'exact') {
      allocated = {
        targetRevisionId: lookup.revision.targetRevisionId,
        targetHumanVersion: lookup.revision.targetHumanVersion,
        targetCreatedAt: lookup.revision.targetCreatedAt,
        ...(lookup.revision.expectedLatestRevision
          ? { expectedLatestRevision: lookup.revision.expectedLatestRevision }
          : {}),
      };
      expectedStored = buildAllocatedRevision({
        workflowId: targetWorkflowId,
        humanVersion: allocated.targetHumanVersion,
        createdAt: allocated.targetCreatedAt,
        owner: input.owner,
        draft: converted.revision,
      });
      if (
        expectedStored.revisionId !== allocated.targetRevisionId ||
        lookup.revision.conversionHash !== conversionHash
      ) {
        throw new LegacyWorkflowMigrationConflictError(
          `Pending allocation ${lookup.revision.migrationKey} cannot be reconstructed exactly`,
        );
      }
    } else if (metadata) {
      const latest = await readSavedWorkflowRevision(input.dataDir, targetWorkflowId, metadata.latestRevision);
      if (computeLegacyConversionHash(comparableDraft(latest.payload)) === conversionHash) {
        allocated = {
          targetRevisionId: latest.revisionId,
          targetHumanVersion: latest.payload.humanVersion,
          targetCreatedAt: latest.payload.createdAt,
          expectedLatestRevision: metadata.latestRevision,
        };
        expectedStored = buildAllocatedRevision({
          workflowId: targetWorkflowId,
          humanVersion: latest.payload.humanVersion,
          createdAt: latest.payload.createdAt,
          owner: input.owner,
          draft: converted.revision,
        });
      } else {
        const createdAt = (input.now ?? new Date()).toISOString();
        allocated = {
          targetRevisionId: '',
          targetHumanVersion: latest.payload.humanVersion + 1,
          targetCreatedAt: createdAt,
          expectedLatestRevision: metadata.latestRevision,
        };
        expectedStored = buildAllocatedRevision({
          workflowId: targetWorkflowId,
          humanVersion: allocated.targetHumanVersion,
          createdAt,
          owner: input.owner,
          draft: converted.revision,
        });
        allocated.targetRevisionId = expectedStored.revisionId;
      }
    } else {
      const createdAt = (input.now ?? new Date()).toISOString();
      allocated = {
        targetRevisionId: '',
        targetHumanVersion: 1,
        targetCreatedAt: createdAt,
      };
      expectedStored = buildAllocatedRevision({
        workflowId: targetWorkflowId,
        humanVersion: 1,
        createdAt,
        owner: input.owner,
        draft: converted.revision,
      });
      allocated.targetRevisionId = expectedStored.revisionId;
    }

    const prepared = prepareLegacyMigration(input.dataDir, {
      identity,
      target,
      conversionHash,
      targetRevisionId: allocated.targetRevisionId,
      targetHumanVersion: allocated.targetHumanVersion,
      targetCreatedAt: allocated.targetCreatedAt,
      ...(allocated.expectedLatestRevision
        ? { expectedLatestRevision: allocated.expectedLatestRevision }
        : {}),
      now: input.now,
    });
    await input.onPhase?.('after-pending');

    let createdWorkflow = false;
    let appendedRevision = false;
    metadata = await maybeLoadMetadata(input.dataDir, targetWorkflowId);
    if (!metadata) {
      const targetDir = savedWorkflowDir(input.dataDir, targetWorkflowId);
      const revisionRows = Object.values(prepared.source.revisions);
      const safeFirstCreateRecovery =
        revisionRows.length === 1 &&
        revisionRows[0]!.contentHash === identity.contentHash &&
        revisionRows[0]!.state === 'pending';
      if (!safeFirstCreateRecovery) {
        throw new LegacyWorkflowMigrationConflictError(
          `Target ${targetWorkflowId} metadata is missing but the ledger already contains prior revisions; ` +
          'refusing to rebuild over historical migration evidence',
        );
      }
      if (existsSync(targetDir)) {
        const metadataPath = join(targetDir, 'metadata.json');
        if (existsSync(metadataPath)) {
          throw new LegacyWorkflowMigrationConflictError(
            `Target ${targetWorkflowId} has an unreadable metadata commit marker`,
          );
        }
        // The pending ledger row makes this deterministic uncommitted directory
        // ours. A crash before metadata publication may leave revision debris.
        await fs.rm(targetDir, { recursive: true, force: true });
      }
      const created = await createSavedWorkflow(input.dataDir, {
        workflowId: targetWorkflowId,
        displayName: definition.workflowId,
        aliases: [],
        owner: input.owner,
        scope: input.scope,
        revision: converted.revision,
        publish: false,
        now: new Date(allocated.targetCreatedAt),
      });
      if (created.revision.revisionId !== allocated.targetRevisionId) {
        throw new LegacyWorkflowMigrationConflictError('Created target revision does not match pending allocation');
      }
      metadata = created.metadata;
      createdWorkflow = true;
    } else {
      assertTargetOwnership(metadata, target);
      if (metadata.latestRevision !== allocated.targetRevisionId) {
        if (
          !allocated.expectedLatestRevision ||
          metadata.latestRevision !== allocated.expectedLatestRevision
        ) {
          throw new LegacyWorkflowMigrationConflictError(
            `Target ${targetWorkflowId} changed after allocation: expected latest ` +
            `${allocated.expectedLatestRevision ?? '(new workflow)'}, got ${metadata.latestRevision}`,
          );
        }
        const appended = await appendSavedWorkflowRevision(input.dataDir, targetWorkflowId, {
          actor: input.owner,
          revision: converted.revision,
          publish: false,
          expectedLatestRevision: allocated.expectedLatestRevision,
          now: new Date(allocated.targetCreatedAt),
        });
        if (appended.revision.revisionId !== allocated.targetRevisionId) {
          throw new LegacyWorkflowMigrationConflictError('Appended target revision does not match pending allocation');
        }
        metadata = appended.metadata;
        appendedRevision = true;
      } else {
        const existing = await readSavedWorkflowRevision(
          input.dataDir,
          targetWorkflowId,
          allocated.targetRevisionId,
        );
        if (
          existing.contentHash !== expectedStored.contentHash ||
          computeLegacyConversionHash(comparableDraft(existing.payload)) !== conversionHash
        ) {
          throw new LegacyWorkflowMigrationConflictError(
            `Existing target revision ${existing.revisionId} differs from the pending allocation`,
          );
        }
      }
    }
    await input.onPhase?.('after-library-write');

    const currentDefinition = readAndParseSource(identity.path);
    const currentIdentity = legacyDefinitionIdentity(identity.path, currentDefinition);
    if (
      currentIdentity.workflowId !== identity.workflowId ||
      currentIdentity.contentHash !== identity.contentHash
    ) {
      throw new LegacyWorkflowMigrationConflictError(
        `Legacy definition changed during migration (was ${identity.contentHash}, now ${currentIdentity.contentHash}); ` +
        'the pending target remains non-runnable until the migration is recovered.',
      );
    }

    metadata = await readSavedWorkflowMetadata(input.dataDir, targetWorkflowId);
    if (metadata.latestRevision !== allocated.targetRevisionId) {
      throw new LegacyWorkflowMigrationConflictError(
        `Target latest revision changed before publication: ${metadata.latestRevision}`,
      );
    }
    if (metadata.status !== 'active' || metadata.publishedRevision !== allocated.targetRevisionId) {
      metadata = await publishLatestSavedWorkflow(input.dataDir, targetWorkflowId, {
        actor: input.owner,
        expectedLatestRevision: allocated.targetRevisionId,
        now: input.now,
      });
    }
    await input.onPhase?.('after-publish');

    const committed = commitLegacyMigration(input.dataDir, identity, input.now);
    const revision = await readSavedWorkflowRevision(
      input.dataDir,
      targetWorkflowId,
      allocated.targetRevisionId,
    );
    return {
      identity,
      source: committed.source,
      revisionRecord: committed.revision,
      metadata,
      revision,
      createdWorkflow,
      appendedRevision,
      issues: converted.issues,
    };
  });
}
