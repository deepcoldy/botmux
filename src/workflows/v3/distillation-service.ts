/**
 * Host-owned application service for Workflow v3 parameter distillation.
 *
 * The model is only a suggestion provider.  Source authentication, baseline
 * construction, compilation, approval, and library publication all stay in
 * this host process and are revalidated at every mutation boundary.
 */

import { createHash } from 'node:crypto';
import { join } from 'node:path';

import { canonicalJsonStringify } from '../../utils/canonical-json.js';
import {
  buildV3DistillationBaseline,
  compileV3DistillationProposal,
  computeV3DistillationBaselineSha256,
  containsUnsafeV3DistillationReusableText,
  enumerateV3DistillationModelFields,
  recompileV3DistillationProposal,
  assertV3DistillationBaselineSafe,
  type V3DistillationModelFieldV1,
} from './distillation-compiler.js';
import {
  V3_DISTILLATION_COMPILER_VERSION,
  type V3DistillationCompiledBodyV1,
} from './distillation-schema.js';
import {
  acceptProposal,
  beginCommit,
  loadProposal,
  markCommitted,
  prepareProposal,
  publishProposal,
  rejectProposal,
  type LoadedV3DistillationProposal,
  type V3DistillationReplyTargetV1,
  V3DistillationStoreError,
  type V3DistillationSourceIdentityV1,
} from './distillation-store.js';
import {
  loadV3DistillationSource,
  resolveV3DistillationSourceRunDir,
  type V3DistillationActorContext,
} from './distillation-source.js';
import {
  createOrRecoverExactSavedWorkflow,
  SavedWorkflowConflictError,
  SavedWorkflowNotFoundError,
  verifyExactSavedWorkflowOrigin,
} from './library-store.js';
import {
  SAVED_WORKFLOW_METADATA_SCHEMA_VERSION,
  buildSavedWorkflowRevision,
  validateSavedWorkflowMetadata,
  type SavedWorkflowMetadata,
  type SavedWorkflowRevisionDraft,
  type StoredSavedWorkflowRevision,
} from './library-schema.js';

const NONCE_DOMAIN = 'workflow-v3-distillation-card/v1';
const WORKFLOW_ID_DOMAIN = 'workflow-v3-distillation-definition/v1';
const SHA256_RE = /^sha256:[0-9a-f]{64}$/;

export type V3DistillationServiceErrorCode =
  | 'invalid_request'
  | 'unsafe_display_name'
  | 'source_changed'
  | 'proposal_not_ready'
  | 'approval_denied'
  | 'commit_conflict';

/** Fixed messages only: never reflect source literals, paths, or model output. */
const SAFE_MESSAGES: Record<V3DistillationServiceErrorCode, string> = {
  invalid_request: '参数蒸馏请求无效。',
  unsafe_display_name: '模板名称可能包含身份、凭据或机器本地信息，请换一个名称。',
  source_changed: '源 Workflow 已变化或不再满足蒸馏条件，请重新发起。',
  proposal_not_ready: '参数蒸馏提案尚未生成或已经失效。',
  approval_denied: '只有源 Workflow 的发起人可以在原群和原 Bot 下确认该提案。',
  commit_conflict: '提案提交与现有 Saved Workflow 不一致，已停止写入。',
};

export class V3DistillationServiceError extends Error {
  constructor(public readonly code: V3DistillationServiceErrorCode) {
    super(SAFE_MESSAGES[code]);
    this.name = 'V3DistillationServiceError';
  }
}

export interface PreparedV3WorkflowDistillation {
  proposalId: string;
  sourceRunDir: string;
  fields: V3DistillationModelFieldV1[];
  state: LoadedV3DistillationProposal['state']['state'];
}

export interface ProposedV3WorkflowDistillation {
  proposalId: string;
  proposalHash: string;
  nonce: string;
  displayName: string;
  sourceRunId: string;
  compiled: V3DistillationCompiledBodyV1;
}

export interface CommittedV3WorkflowDistillation {
  workflowId: string;
  revisionId: string;
  contentHash: string;
  displayName: string;
  created: boolean;
}

export type V3DistillationSuggestionProvider = (
  fields: readonly V3DistillationModelFieldV1[],
) => Promise<unknown>;

function sameCanonical(left: unknown, right: unknown): boolean {
  return canonicalJsonStringify(left) === canonicalJsonStringify(right);
}

function assertSafeDisplayName(displayName: string, context: V3DistillationActorContext): void {
  if (!displayName || displayName !== displayName.trim() || displayName !== displayName.normalize('NFC')) {
    throw new V3DistillationServiceError('invalid_request');
  }
  try {
    validateSavedWorkflowMetadata({
      schemaVersion: SAVED_WORKFLOW_METADATA_SCHEMA_VERSION,
      workflowId: 'wf_00000000000000000000000000000000',
      displayName,
      aliases: [],
      owner: { openId: context.ownerOpenId, larkAppId: context.larkAppId },
      scope: { kind: 'chat', chatId: context.chatId },
      status: 'active',
      latestRevision: `rev_${'0'.repeat(64)}`,
      publishedRevision: `rev_${'0'.repeat(64)}`,
      createdAt: '1970-01-01T00:00:00.000Z',
      updatedAt: '1970-01-01T00:00:00.000Z',
    });
  } catch {
    throw new V3DistillationServiceError('unsafe_display_name');
  }
  if (
    containsUnsafeV3DistillationReusableText(displayName) ||
    /(?:^|\W)(?:ou|on|oc|om|cli)_[A-Za-z0-9_-]{8,}(?:$|\W)/.test(displayName) ||
    /[^\s@]+@[^\s@]+\.[^\s@]+/.test(displayName) ||
    /(?:api[_-]?key|access[_-]?token|password|secret)\s*[:=]/i.test(displayName) ||
    /(?:^|[\s"'])(?:\/(?:Users|home|root|tmp|etc|var)\/[^\s"']+|[A-Za-z]:\\[^\s"']+)/.test(displayName)
  ) {
    throw new V3DistillationServiceError('unsafe_display_name');
  }
}

function sourceIdentityWithBaseline(
  identity: Omit<V3DistillationSourceIdentityV1, 'baselineRevisionSha256'>,
  baselineRevisionSha256: string,
): V3DistillationSourceIdentityV1 {
  if (!SHA256_RE.test(baselineRevisionSha256)) {
    throw new V3DistillationServiceError('source_changed');
  }
  return { ...identity, baselineRevisionSha256 };
}

function assertExactIdentity(
  actual: V3DistillationSourceIdentityV1,
  expected: V3DistillationSourceIdentityV1,
): void {
  if (!sameCanonical(actual, expected)) throw new V3DistillationServiceError('source_changed');
}

function proposalNonce(proposalId: string, proposalHash: string, identity: V3DistillationSourceIdentityV1): string {
  return createHash('sha256').update([
    NONCE_DOMAIN,
    proposalId,
    proposalHash,
    identity.ownerOpenId,
    identity.larkAppId,
    identity.chatId,
  ].join('\0')).digest('hex');
}

export function v3DistillationProposalNonce(loaded: LoadedV3DistillationProposal): string {
  if (!loaded.proposal) throw new V3DistillationServiceError('proposal_not_ready');
  return proposalNonce(
    loaded.prepared.proposalId,
    loaded.proposal.proposalHash,
    loaded.prepared.sourceIdentity,
  );
}

export async function prepareV3WorkflowDistillation(input: {
  dataDir: string;
  baseDir: string;
  source: 'last' | string;
  displayName: string;
  requestKey: string;
  context: V3DistillationActorContext;
  replyTarget?: V3DistillationReplyTargetV1;
  now?: Date;
}): Promise<PreparedV3WorkflowDistillation> {
  assertSafeDisplayName(input.displayName, input.context);
  if (!input.requestKey || input.requestKey.length > 512 || input.requestKey.includes('\0')) {
    throw new V3DistillationServiceError('invalid_request');
  }
  const sourceRunDir = await resolveV3DistillationSourceRunDir({
    baseDir: input.baseDir,
    source: input.source,
    context: input.context,
  });
  const source = loadV3DistillationSource(sourceRunDir, input.context);
  const baseline = buildV3DistillationBaseline(source.loaded);
  assertV3DistillationBaselineSafe(baseline);
  const baselineRevisionSha256 = computeV3DistillationBaselineSha256(baseline);
  const prepared = prepareProposal(input.dataDir, {
    requestKey: input.requestKey,
    sourceIdentity: sourceIdentityWithBaseline(source.identity, baselineRevisionSha256),
    replyTarget: input.replyTarget ?? { kind: 'chat', chatId: input.context.chatId },
    displayName: input.displayName,
    compilerVersion: V3_DISTILLATION_COMPILER_VERSION,
    now: input.now,
  });
  if (prepared.prepared.displayName !== input.displayName) {
    throw new V3DistillationServiceError('invalid_request');
  }
  return {
    proposalId: prepared.prepared.proposalId,
    sourceRunDir,
    fields: enumerateV3DistillationModelFields(baseline),
    state: prepared.state.state,
  };
}

export async function generateV3WorkflowDistillationProposal(input: {
  dataDir: string;
  baseDir: string;
  proposalId: string;
  suggest: V3DistillationSuggestionProvider;
  now?: Date;
}): Promise<ProposedV3WorkflowDistillation> {
  let stored = loadProposal(input.dataDir, input.proposalId);
  if (stored.proposal) {
    // Recover the publication crash window where immutable proposal.json was
    // linked but state.json still says prepared. publishProposal revalidates
    // the exact body and advances the durable state without invoking the model.
    if (stored.state.state === 'prepared') {
      stored = publishProposal(input.dataDir, input.proposalId, {
        compiled: stored.proposal.compiled,
        now: input.now,
      });
    }
    return proposedResult(stored);
  }
  if (stored.state.state !== 'prepared') throw new V3DistillationServiceError('proposal_not_ready');

  const identity = stored.prepared.sourceIdentity;
  const context = {
    ownerOpenId: identity.ownerOpenId,
    larkAppId: identity.larkAppId,
    chatId: identity.chatId,
  };
  const source = loadV3DistillationSource(join(input.baseDir, identity.runId), context);
  const baseline = buildV3DistillationBaseline(source.loaded);
  assertV3DistillationBaselineSafe(baseline);
  assertExactIdentity(
    sourceIdentityWithBaseline(source.identity, computeV3DistillationBaselineSha256(baseline)),
    identity,
  );
  const fields = enumerateV3DistillationModelFields(baseline);
  const suggestion = await input.suggest(fields);
  const compiled = compileV3DistillationProposal({ baselineRevision: baseline, suggestion });
  stored = publishProposal(input.dataDir, input.proposalId, { compiled, now: input.now });
  return proposedResult(stored);
}

function proposedResult(stored: LoadedV3DistillationProposal): ProposedV3WorkflowDistillation {
  if (!stored.proposal) throw new V3DistillationServiceError('proposal_not_ready');
  return {
    proposalId: stored.prepared.proposalId,
    proposalHash: stored.proposal.proposalHash,
    nonce: v3DistillationProposalNonce(stored),
    displayName: stored.prepared.displayName,
    sourceRunId: stored.prepared.sourceIdentity.runId,
    compiled: stored.proposal.compiled,
  };
}

function assertApprovalContext(input: {
  loaded: LoadedV3DistillationProposal;
  proposalHash: string;
  nonce: string;
  operatorOpenId: string;
  larkAppId: string;
  chatId: string;
}): void {
  const identity = input.loaded.prepared.sourceIdentity;
  if (
    !input.loaded.proposal || input.loaded.proposal.proposalHash !== input.proposalHash ||
    input.operatorOpenId !== identity.ownerOpenId || input.larkAppId !== identity.larkAppId ||
    input.chatId !== identity.chatId || input.nonce !== v3DistillationProposalNonce(input.loaded)
  ) {
    throw new V3DistillationServiceError('approval_denied');
  }
}

function workflowIdForProposal(proposalId: string, proposalHash: string): string {
  return `wf_${createHash('sha256').update([WORKFLOW_ID_DOMAIN, proposalId, proposalHash].join('\0'))
    .digest('hex').slice(0, 32)}`;
}

function expectedCommittedWorkflow(input: {
  workflowId: string;
  displayName: string;
  identity: V3DistillationSourceIdentityV1;
  revision: SavedWorkflowRevisionDraft;
  createdAt: string;
}): { metadata: SavedWorkflowMetadata; revision: StoredSavedWorkflowRevision } {
  const revision = buildSavedWorkflowRevision({
    ...input.revision,
    workflowId: input.workflowId,
    humanVersion: 1,
    createdAt: input.createdAt,
    createdBy: {
      openId: input.identity.ownerOpenId,
      larkAppId: input.identity.larkAppId,
    },
  });
  const metadata = validateSavedWorkflowMetadata({
    schemaVersion: SAVED_WORKFLOW_METADATA_SCHEMA_VERSION,
    workflowId: input.workflowId,
    displayName: input.displayName,
    aliases: [],
    owner: {
      openId: input.identity.ownerOpenId,
      larkAppId: input.identity.larkAppId,
    },
    scope: { kind: 'chat', chatId: input.identity.chatId },
    status: 'active',
    latestRevision: revision.revisionId,
    publishedRevision: revision.revisionId,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  });
  return { metadata, revision };
}

async function commitProposalToLibrary(input: {
  dataDir: string;
  loaded: LoadedV3DistillationProposal;
  createIfMissing: boolean;
}): Promise<CommittedV3WorkflowDistillation> {
  if (
    !input.loaded.proposal ||
    (input.loaded.state.state !== 'committing' && input.loaded.state.state !== 'committed')
  ) {
    throw new V3DistillationServiceError('proposal_not_ready');
  }
  const { proposal, prepared, state } = input.loaded;
  const workflowId = state.commit.workflowId;
  const createdAt = state.commit.createdAt;
  const expected = expectedCommittedWorkflow({
    workflowId,
    displayName: prepared.displayName,
    identity: prepared.sourceIdentity,
    revision: proposal.compiled.revisionDraft,
    createdAt,
  });
  if (state.state === 'committed') {
    try {
      const { metadata, revision } = await verifyExactSavedWorkflowOrigin(input.dataDir, {
        expectedMetadata: expected.metadata,
        expectedRevision: expected.revision,
        createIfMissing: false,
      });
      if (
        metadata.workflowId !== workflowId || metadata.displayName !== prepared.displayName ||
        metadata.owner.openId !== prepared.sourceIdentity.ownerOpenId ||
        metadata.owner.larkAppId !== prepared.sourceIdentity.larkAppId ||
        metadata.scope.kind !== 'chat' || metadata.scope.chatId !== prepared.sourceIdentity.chatId ||
        revision.contentHash !== state.result.revisionContentHash
      ) {
        throw new V3DistillationServiceError('commit_conflict');
      }
      return {
        workflowId,
        revisionId: revision.revisionId,
        contentHash: revision.contentHash,
        displayName: metadata.displayName,
        created: false,
      };
    } catch (error) {
      if (error instanceof V3DistillationServiceError) throw error;
      if (error instanceof SavedWorkflowConflictError || error instanceof SavedWorkflowNotFoundError) {
        throw new V3DistillationServiceError('commit_conflict');
      }
      throw error;
    }
  }
  try {
    const written = await createOrRecoverExactSavedWorkflow(input.dataDir, {
      expectedMetadata: expected.metadata,
      expectedRevision: expected.revision,
      createIfMissing: input.createIfMissing,
    });
    return {
      workflowId: written.metadata.workflowId,
      revisionId: written.revision.revisionId,
      contentHash: written.revision.contentHash,
      displayName: written.metadata.displayName,
      created: written.created,
    };
  } catch (error) {
    if (!(error instanceof SavedWorkflowConflictError) && !(error instanceof SavedWorkflowNotFoundError)) {
      throw error;
    }
    // Crash window: the exact directory may have been published, then the
    // daemon died before markCommitted. During downtime the owner can append a
    // legitimate later revision. Exact-topology recovery must not wedge that
    // already-approved publication; verify the immutable original revision and
    // stable ownership/scope lineage instead.
    try {
      const { metadata, revision } = await verifyExactSavedWorkflowOrigin(input.dataDir, {
        expectedMetadata: expected.metadata,
        expectedRevision: expected.revision,
        createIfMissing: false,
      });
      if (
        metadata.workflowId !== expected.metadata.workflowId ||
        metadata.displayName !== expected.metadata.displayName ||
        metadata.owner.openId !== expected.metadata.owner.openId ||
        metadata.owner.larkAppId !== expected.metadata.owner.larkAppId ||
        metadata.scope.kind !== 'chat' ||
        expected.metadata.scope.kind !== 'chat' ||
        metadata.scope.chatId !== expected.metadata.scope.chatId ||
        metadata.createdAt !== expected.metadata.createdAt ||
        revision.revisionId !== expected.revision.revisionId ||
        revision.contentHash !== expected.revision.contentHash
      ) {
        throw new V3DistillationServiceError('commit_conflict');
      }
      return {
        workflowId,
        revisionId: revision.revisionId,
        contentHash: revision.contentHash,
        displayName: metadata.displayName,
        created: false,
      };
    } catch (recoveryError) {
      if (recoveryError instanceof V3DistillationServiceError) throw recoveryError;
      if (
        recoveryError instanceof SavedWorkflowConflictError ||
        recoveryError instanceof SavedWorkflowNotFoundError
      ) {
        throw new V3DistillationServiceError('commit_conflict');
      }
      throw recoveryError;
    }
  }
}

function assertCommittedStateMatches(
  loaded: LoadedV3DistillationProposal,
  result: CommittedV3WorkflowDistillation,
): void {
  if (
    loaded.state.state !== 'committed' ||
    loaded.state.result.workflowId !== result.workflowId ||
    loaded.state.result.revisionId !== result.revisionId ||
    loaded.state.result.revisionContentHash !== result.contentHash
  ) {
    throw new V3DistillationServiceError('commit_conflict');
  }
}

export async function acceptV3WorkflowDistillation(input: {
  dataDir: string;
  baseDir: string;
  proposalId: string;
  proposalHash: string;
  nonce: string;
  operatorOpenId: string;
  larkAppId: string;
  chatId: string;
  now?: Date;
}): Promise<CommittedV3WorkflowDistillation> {
  let loaded = loadProposal(input.dataDir, input.proposalId);
  assertApprovalContext({ loaded, ...input });
  const identity = loaded.prepared.sourceIdentity;
  if (loaded.proposal!.compiled.baselineRevisionSha256 !== identity.baselineRevisionSha256) {
    throw new V3DistillationServiceError('source_changed');
  }

  // The source is an approval boundary only while the proposal is still
  // proposed. Once accepted, every recovery input is already durable in the
  // proposal store; requiring source bytes again would make a committed
  // approval unrecoverable after normal run retention.
  if (loaded.state.state === 'proposed') {
    const source = loadV3DistillationSource(join(input.baseDir, identity.runId), {
      ownerOpenId: identity.ownerOpenId,
      larkAppId: identity.larkAppId,
      chatId: identity.chatId,
    });
    const baseline = buildV3DistillationBaseline(source.loaded);
    assertExactIdentity(
      sourceIdentityWithBaseline(source.identity, computeV3DistillationBaselineSha256(baseline)),
      identity,
    );
    try {
      recompileV3DistillationProposal(baseline, loaded.proposal!.compiled);
    } catch {
      // Fixed public error: never reflect stored/model-authored proposal data.
      throw new V3DistillationServiceError('source_changed');
    }
  }

  if (
    loaded.state.state !== 'proposed' && loaded.state.state !== 'accepted' &&
    loaded.state.state !== 'committing' && loaded.state.state !== 'committed'
  ) {
    throw new V3DistillationServiceError('proposal_not_ready');
  }
  // Besides transitioning proposed→accepted, this idempotent CAS validates
  // that a durable later-state approval belongs to the same actor tuple.
  loaded = acceptProposal(input.dataDir, input.proposalId, {
    proposalHash: input.proposalHash,
    operatorOpenId: input.operatorOpenId,
    larkAppId: input.larkAppId,
    chatId: input.chatId,
    now: input.now,
  });

  // A concurrent accept may have advanced through any later state while this
  // caller revalidated the source. Branch on each CAS result, never on the
  // stale state observed before it.
  if (loaded.state.state === 'accepted') {
    loaded = beginCommit(input.dataDir, input.proposalId, {
      proposalHash: input.proposalHash,
      workflowId: workflowIdForProposal(input.proposalId, input.proposalHash),
      createdAt: loaded.state.approval.acceptedAt,
      now: input.now,
    });
  }
  if (loaded.state.state !== 'committing' && loaded.state.state !== 'committed') {
    throw new V3DistillationServiceError('proposal_not_ready');
  }

  const wasCommitted = loaded.state.state === 'committed';
  const result = await commitProposalToLibrary({
    dataDir: input.dataDir,
    loaded,
    createIfMissing: !wasCommitted,
  });
  let committed: LoadedV3DistillationProposal;
  try {
    committed = markCommitted(input.dataDir, input.proposalId, {
      proposalHash: input.proposalHash,
      workflowId: result.workflowId,
      revisionId: result.revisionId,
      revisionContentHash: result.contentHash,
      now: input.now,
    });
  } catch (error) {
    if (error instanceof V3DistillationStoreError) {
      throw new V3DistillationServiceError('commit_conflict');
    }
    throw error;
  }
  assertCommittedStateMatches(committed, result);
  return { ...result, created: wasCommitted ? false : result.created };
}

export function rejectV3WorkflowDistillation(input: {
  dataDir: string;
  proposalId: string;
  proposalHash: string;
  nonce: string;
  operatorOpenId: string;
  larkAppId: string;
  chatId: string;
  now?: Date;
}): LoadedV3DistillationProposal {
  const loaded = loadProposal(input.dataDir, input.proposalId);
  assertApprovalContext({ loaded, ...input });
  return rejectProposal(input.dataDir, input.proposalId, {
    proposalHash: input.proposalHash,
    operatorOpenId: input.operatorOpenId,
    larkAppId: input.larkAppId,
    chatId: input.chatId,
    now: input.now,
  });
}
