/**
 * Durable private store for Workflow v3 parameter-distillation proposals.
 *
 * The model-authored suggestion never reaches this module.  `proposal.json`
 * contains only the host-compiled, parsed proposal body.  Immutable proposal
 * material and mutable lifecycle state are deliberately separate so a state
 * transition can never rewrite the object the user reviewed.
 *
 * Lock order is always identity-index -> proposal state.  The durable
 * `replacing` index entry makes supersession recoverable without ever leaving
 * two proposals eligible for approval.
 */

import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  type Dirent,
} from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { basename, dirname, join } from 'node:path';

import { canonicalJsonStringify } from '../../utils/canonical-json.js';
import {
  fsyncDirectorySyncPortable,
  fsyncRegularFileSync,
} from '../../utils/fs-durability.js';
import { withFileLockSync } from '../../utils/file-lock.js';
import {
  SAVED_WORKFLOW_CONTENT_HASH_RE,
  SAVED_WORKFLOW_ID_RE,
  SAVED_WORKFLOW_REVISION_ID_RE,
} from './library-schema.js';
import {
  V3_DISTILLATION_COMPILER_VERSION,
  parseV3DistillationCompiledBody,
  type V3DistillationCompiledBodyV1,
} from './distillation-schema.js';

const STORE_DIR = 'workflow-distillations';
const PROPOSALS_DIR = 'proposals';
const IDENTITY_INDEX_FILE = 'identity-index.json';
const PREPARED_FILE = 'prepared.json';
const PROPOSAL_FILE = 'proposal.json';
const STATE_FILE = 'state.json';

const STORE_SCHEMA_VERSION = 1 as const;
const PREPARED_SCHEMA_VERSION = 1 as const;
const PROPOSAL_SCHEMA_VERSION = 1 as const;
const STATE_SCHEMA_VERSION = 1 as const;
const INDEX_SCHEMA_VERSION = 1 as const;

const SHA256_RE = /^sha256:[0-9a-f]{64}$/;
export const V3_DISTILLATION_PROPOSAL_ID_RE = /^dp_[0-9a-f]{32}$/;
const SAFE_RUN_ID_RE = /^(?!\.\.?$)[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;
const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/;
const MAX_PRIVATE_JSON_BYTES = 16 * 1024 * 1024;
const MAX_INDEX_BYTES = 4 * 1024 * 1024;

export type V3DistillationStoreErrorCode =
  | 'INVALID_ARGUMENT'
  | 'PROPOSAL_NOT_FOUND'
  | 'STORE_CORRUPT'
  | 'CONTENT_CONFLICT'
  | 'STATE_CONFLICT'
  | 'IDENTITY_BUSY'
  | 'STALE_PROPOSAL';

const SAFE_ERROR_MESSAGES: Record<V3DistillationStoreErrorCode, string> = {
  INVALID_ARGUMENT: 'The distillation request is invalid.',
  PROPOSAL_NOT_FOUND: 'The distillation proposal was not found.',
  STORE_CORRUPT: 'The private distillation store failed integrity validation.',
  CONTENT_CONFLICT: 'The distillation proposal content does not match its durable allocation.',
  STATE_CONFLICT: 'The distillation proposal is not in a state that permits this operation.',
  IDENTITY_BUSY: 'Another distillation request for this source is still in progress.',
  STALE_PROPOSAL: 'This distillation proposal is no longer the active proposal for its source.',
};

/** Fixed-message error: private paths, values, and parser output are never reflected. */
export class V3DistillationStoreError extends Error {
  constructor(public readonly code: V3DistillationStoreErrorCode) {
    super(SAFE_ERROR_MESSAGES[code]);
    this.name = 'V3DistillationStoreError';
  }
}

export interface V3DistillationSourceIdentityV1 {
  runId: string;
  runEnvelopeSha256: string;
  dagSha256: string;
  specSha256: string;
  botSnapshotsSha256: string;
  baselineRevisionSha256: string;
  ownerOpenId: string;
  larkAppId: string;
  chatId: string;
}

export interface V3DistillationPreparedBodyV1 {
  schemaVersion: typeof PREPARED_SCHEMA_VERSION;
  proposalId: string;
  requestKey: string;
  liveKey: string;
  compilerVersion: typeof V3_DISTILLATION_COMPILER_VERSION;
  sourceIdentity: V3DistillationSourceIdentityV1;
  replyTarget: V3DistillationReplyTargetV1;
  displayName: string;
}

export type V3DistillationReplyTargetV1 =
  | { kind: 'chat'; chatId: string }
  | { kind: 'thread'; rootMessageId: string };

export interface V3DistillationProposalBodyV1 {
  schemaVersion: typeof PROPOSAL_SCHEMA_VERSION;
  proposalId: string;
  proposalHash: string;
  liveKey: string;
  compilerVersion: typeof V3_DISTILLATION_COMPILER_VERSION;
  sourceIdentity: V3DistillationSourceIdentityV1;
  displayName: string;
  createdAt: string;
  compiled: V3DistillationCompiledBodyV1;
}

export interface V3DistillationApprovalV1 {
  operatorOpenId: string;
  larkAppId: string;
  chatId: string;
  acceptedAt: string;
}

export interface V3DistillationRejectionV1 {
  operatorOpenId: string;
  larkAppId: string;
  chatId: string;
  rejectedAt: string;
}

export interface V3DistillationCommitAllocationV1 {
  workflowId: string;
  createdAt: string;
  startedAt: string;
}

export interface V3DistillationCommitResultV1 {
  workflowId: string;
  revisionId: string;
  revisionContentHash?: string;
  committedAt: string;
}

interface StateBase {
  schemaVersion: typeof STATE_SCHEMA_VERSION;
  proposalId: string;
  liveKey: string;
  preparedAt: string;
  updatedAt: string;
}

export type V3DistillationProposalStateV1 =
  | (StateBase & { state: 'prepared' })
  | (StateBase & {
    state: 'proposed';
    proposalHash: string;
    proposedAt: string;
  })
  | (StateBase & {
    state: 'accepted';
    proposalHash: string;
    proposedAt: string;
    approval: V3DistillationApprovalV1;
  })
  | (StateBase & {
    state: 'committing';
    proposalHash: string;
    proposedAt: string;
    approval: V3DistillationApprovalV1;
    commit: V3DistillationCommitAllocationV1;
  })
  | (StateBase & {
    state: 'committed';
    proposalHash: string;
    proposedAt: string;
    approval: V3DistillationApprovalV1;
    commit: V3DistillationCommitAllocationV1;
    result: V3DistillationCommitResultV1;
  })
  | (StateBase & {
    state: 'rejected';
    proposalHash: string;
    proposedAt: string;
    rejection: V3DistillationRejectionV1;
  })
  | (StateBase & {
    state: 'superseded';
    proposalHash: string;
    proposedAt: string;
    supersededByProposalId: string;
    supersededAt: string;
  });

export interface LoadedV3DistillationProposal {
  prepared: V3DistillationPreparedBodyV1;
  proposal?: V3DistillationProposalBodyV1;
  state: V3DistillationProposalStateV1;
}

export interface PrepareV3DistillationProposalInput {
  /** Stable per inbound Lark event/message; duplicate delivery reuses the allocation. */
  requestKey: string;
  sourceIdentity: V3DistillationSourceIdentityV1;
  replyTarget: V3DistillationReplyTargetV1;
  displayName: string;
  compilerVersion: typeof V3_DISTILLATION_COMPILER_VERSION;
  now?: Date;
}

export interface PublishV3DistillationProposalInput {
  compiled: V3DistillationCompiledBodyV1;
  now?: Date;
}

export interface ActOnV3DistillationProposalInput {
  proposalHash: string;
  operatorOpenId: string;
  larkAppId: string;
  chatId: string;
  now?: Date;
}

export interface BeginV3DistillationCommitInput {
  proposalHash: string;
  workflowId: string;
  /** Timestamp frozen into the final Saved Workflow revision allocation. */
  createdAt: string;
  now?: Date;
}

export interface MarkV3DistillationCommittedInput {
  proposalHash: string;
  workflowId: string;
  revisionId: string;
  revisionContentHash?: string;
  now?: Date;
}

interface ActiveIdentityIndexEntry {
  state: 'active';
  proposalId: string;
}

interface ReplacingIdentityIndexEntry {
  state: 'replacing';
  proposalId: string;
  /** Exact immutable allocation needed to recover before prepared.json exists. */
  prepared: V3DistillationPreparedBodyV1;
  /** Timestamp frozen before the replacing intent becomes durable. */
  preparedAt: string;
  previousProposalId?: string;
}

type IdentityIndexEntry = ActiveIdentityIndexEntry | ReplacingIdentityIndexEntry;

interface IdentityIndexV1 {
  schemaVersion: typeof INDEX_SCHEMA_VERSION;
  entries: Record<string, IdentityIndexEntry>;
}

function fail(code: V3DistillationStoreErrorCode): never {
  throw new V3DistillationStoreError(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, i) => key === expected[i]);
}

function safeString(value: unknown, max = 512): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !value.includes('\0');
}

function validIso(value: unknown): value is string {
  return safeString(value, 128) && ISO_TIMESTAMP_RE.test(value) && Number.isFinite(Date.parse(value));
}

function withStoreLock<T>(targetPath: string, fn: () => T): T {
  try {
    return withFileLockSync(targetPath, fn);
  } catch (error) {
    if (error instanceof V3DistillationStoreError) throw error;
    fail('STORE_CORRUPT');
  }
}

function sha256Canonical(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJsonStringify(value)).digest('hex')}`;
}

function sameCanonical(left: unknown, right: unknown): boolean {
  return canonicalJsonStringify(left) === canonicalJsonStringify(right);
}

function normalizeSourceIdentity(raw: unknown): V3DistillationSourceIdentityV1 {
  const keys = [
    'runId',
    'runEnvelopeSha256',
    'dagSha256',
    'specSha256',
    'botSnapshotsSha256',
    'baselineRevisionSha256',
    'ownerOpenId',
    'larkAppId',
    'chatId',
  ] as const;
  if (!isRecord(raw) || !hasExactKeys(raw, keys)) fail('INVALID_ARGUMENT');
  if (typeof raw.runId !== 'string' || !SAFE_RUN_ID_RE.test(raw.runId)) fail('INVALID_ARGUMENT');
  for (const key of [
    'runEnvelopeSha256',
    'dagSha256',
    'specSha256',
    'botSnapshotsSha256',
    'baselineRevisionSha256',
  ] as const) {
    if (typeof raw[key] !== 'string' || !SHA256_RE.test(raw[key])) fail('INVALID_ARGUMENT');
  }
  for (const key of ['ownerOpenId', 'larkAppId', 'chatId'] as const) {
    if (!safeString(raw[key])) fail('INVALID_ARGUMENT');
  }
  return {
    runId: raw.runId,
    runEnvelopeSha256: raw.runEnvelopeSha256 as string,
    dagSha256: raw.dagSha256 as string,
    specSha256: raw.specSha256 as string,
    botSnapshotsSha256: raw.botSnapshotsSha256 as string,
    baselineRevisionSha256: raw.baselineRevisionSha256 as string,
    ownerOpenId: raw.ownerOpenId as string,
    larkAppId: raw.larkAppId as string,
    chatId: raw.chatId as string,
  };
}

function normalizeReplyTarget(
  raw: unknown,
  sourceIdentity: V3DistillationSourceIdentityV1,
): V3DistillationReplyTargetV1 {
  if (!isRecord(raw) || typeof raw.kind !== 'string') fail('INVALID_ARGUMENT');
  if (raw.kind === 'chat') {
    if (!hasExactKeys(raw, ['kind', 'chatId']) || !safeString(raw.chatId) ||
        raw.chatId !== sourceIdentity.chatId) fail('INVALID_ARGUMENT');
    return { kind: 'chat', chatId: raw.chatId as string };
  }
  if (raw.kind === 'thread') {
    if (!hasExactKeys(raw, ['kind', 'rootMessageId']) || !safeString(raw.rootMessageId)) {
      fail('INVALID_ARGUMENT');
    }
    return { kind: 'thread', rootMessageId: raw.rootMessageId as string };
  }
  fail('INVALID_ARGUMENT');
}

export function computeV3DistillationLiveKey(
  sourceIdentity: V3DistillationSourceIdentityV1,
  compilerVersion: typeof V3_DISTILLATION_COMPILER_VERSION,
): string {
  const normalized = normalizeSourceIdentity(sourceIdentity);
  if (compilerVersion !== V3_DISTILLATION_COMPILER_VERSION) fail('INVALID_ARGUMENT');
  return sha256Canonical({ compilerVersion, sourceIdentity: normalized });
}

function proposalIdForPreparedContent(
  content: Omit<V3DistillationPreparedBodyV1, 'proposalId'>,
): string {
  return `dp_${createHash('sha256').update(canonicalJsonStringify(content)).digest('hex').slice(0, 32)}`;
}

function parsePrepared(raw: unknown): V3DistillationPreparedBodyV1 {
  const keys = [
    'schemaVersion', 'proposalId', 'requestKey', 'liveKey', 'compilerVersion',
    'sourceIdentity', 'replyTarget', 'displayName',
  ];
  if (!isRecord(raw) || !hasExactKeys(raw, keys)) fail('STORE_CORRUPT');
  if (
    raw.schemaVersion !== PREPARED_SCHEMA_VERSION ||
    typeof raw.proposalId !== 'string' || !V3_DISTILLATION_PROPOSAL_ID_RE.test(raw.proposalId) ||
    !safeString(raw.requestKey) ||
    typeof raw.liveKey !== 'string' || !SHA256_RE.test(raw.liveKey) ||
    raw.compilerVersion !== V3_DISTILLATION_COMPILER_VERSION ||
    !safeString(raw.displayName, 128)
  ) fail('STORE_CORRUPT');
  let sourceIdentity: V3DistillationSourceIdentityV1;
  try {
    sourceIdentity = normalizeSourceIdentity(raw.sourceIdentity);
  } catch {
    fail('STORE_CORRUPT');
  }
  let replyTarget: V3DistillationReplyTargetV1;
  try {
    replyTarget = normalizeReplyTarget(raw.replyTarget, sourceIdentity);
  } catch {
    fail('STORE_CORRUPT');
  }
  const content = {
    schemaVersion: PREPARED_SCHEMA_VERSION,
    requestKey: raw.requestKey,
    liveKey: raw.liveKey,
    compilerVersion: raw.compilerVersion,
    sourceIdentity,
    replyTarget,
    displayName: raw.displayName.normalize('NFC'),
  } as const;
  if (
    raw.displayName !== content.displayName ||
    computeV3DistillationLiveKey(sourceIdentity, raw.compilerVersion) !== raw.liveKey ||
    proposalIdForPreparedContent(content) !== raw.proposalId
  ) fail('STORE_CORRUPT');
  return { ...content, proposalId: raw.proposalId };
}

function proposalHashMaterial(
  value: Omit<V3DistillationProposalBodyV1, 'proposalHash'>,
): Omit<V3DistillationProposalBodyV1, 'proposalHash'> {
  return value;
}

function parseProposal(raw: unknown, prepared: V3DistillationPreparedBodyV1): V3DistillationProposalBodyV1 {
  const keys = [
    'schemaVersion', 'proposalId', 'proposalHash', 'liveKey', 'compilerVersion',
    'sourceIdentity', 'displayName', 'createdAt', 'compiled',
  ];
  if (!isRecord(raw) || !hasExactKeys(raw, keys)) fail('STORE_CORRUPT');
  if (
    raw.schemaVersion !== PROPOSAL_SCHEMA_VERSION ||
    raw.proposalId !== prepared.proposalId ||
    typeof raw.proposalHash !== 'string' || !SHA256_RE.test(raw.proposalHash) ||
    raw.liveKey !== prepared.liveKey ||
    raw.compilerVersion !== prepared.compilerVersion ||
    raw.displayName !== prepared.displayName ||
    !validIso(raw.createdAt)
  ) fail('STORE_CORRUPT');
  let sourceIdentity: V3DistillationSourceIdentityV1;
  let compiled: V3DistillationCompiledBodyV1;
  try {
    sourceIdentity = normalizeSourceIdentity(raw.sourceIdentity);
    compiled = parseV3DistillationCompiledBody(raw.compiled);
  } catch {
    fail('STORE_CORRUPT');
  }
  if (
    !sameCanonical(sourceIdentity, prepared.sourceIdentity) ||
    compiled.compilerVersion !== prepared.compilerVersion ||
    compiled.baselineRevisionSha256 !== sourceIdentity.baselineRevisionSha256
  ) fail('STORE_CORRUPT');
  const material = proposalHashMaterial({
    schemaVersion: PROPOSAL_SCHEMA_VERSION,
    proposalId: prepared.proposalId,
    liveKey: prepared.liveKey,
    compilerVersion: prepared.compilerVersion,
    sourceIdentity,
    displayName: prepared.displayName,
    createdAt: raw.createdAt,
    compiled,
  });
  if (sha256Canonical(material) !== raw.proposalHash) fail('STORE_CORRUPT');
  return { ...material, proposalHash: raw.proposalHash };
}

function parseActor(raw: unknown, kind: 'approval' | 'rejection'): V3DistillationApprovalV1 | V3DistillationRejectionV1 {
  const timestampKey = kind === 'approval' ? 'acceptedAt' : 'rejectedAt';
  const keys = ['operatorOpenId', 'larkAppId', 'chatId', timestampKey];
  if (!isRecord(raw) || !hasExactKeys(raw, keys)) fail('STORE_CORRUPT');
  if (
    !safeString(raw.operatorOpenId) || !safeString(raw.larkAppId) || !safeString(raw.chatId) ||
    !validIso(raw[timestampKey])
  ) fail('STORE_CORRUPT');
  return {
    operatorOpenId: raw.operatorOpenId,
    larkAppId: raw.larkAppId,
    chatId: raw.chatId,
    [timestampKey]: raw[timestampKey],
  } as unknown as V3DistillationApprovalV1 | V3DistillationRejectionV1;
}

function parseCommitAllocation(raw: unknown): V3DistillationCommitAllocationV1 {
  if (!isRecord(raw) || !hasExactKeys(raw, ['workflowId', 'createdAt', 'startedAt'])) fail('STORE_CORRUPT');
  if (
    typeof raw.workflowId !== 'string' || !SAVED_WORKFLOW_ID_RE.test(raw.workflowId) ||
    !validIso(raw.createdAt) || !validIso(raw.startedAt)
  ) fail('STORE_CORRUPT');
  return { workflowId: raw.workflowId, createdAt: raw.createdAt, startedAt: raw.startedAt };
}

function parseCommitResult(raw: unknown): V3DistillationCommitResultV1 {
  if (!isRecord(raw)) fail('STORE_CORRUPT');
  const keys = raw.revisionContentHash === undefined
    ? ['workflowId', 'revisionId', 'committedAt']
    : ['workflowId', 'revisionId', 'revisionContentHash', 'committedAt'];
  if (!hasExactKeys(raw, keys)) fail('STORE_CORRUPT');
  if (
    typeof raw.workflowId !== 'string' || !SAVED_WORKFLOW_ID_RE.test(raw.workflowId) ||
    typeof raw.revisionId !== 'string' || !SAVED_WORKFLOW_REVISION_ID_RE.test(raw.revisionId) ||
    (raw.revisionContentHash !== undefined &&
      (typeof raw.revisionContentHash !== 'string' || !SAVED_WORKFLOW_CONTENT_HASH_RE.test(raw.revisionContentHash))) ||
    !validIso(raw.committedAt)
  ) fail('STORE_CORRUPT');
  return {
    workflowId: raw.workflowId,
    revisionId: raw.revisionId,
    ...(typeof raw.revisionContentHash === 'string' ? { revisionContentHash: raw.revisionContentHash } : {}),
    committedAt: raw.committedAt,
  };
}

function parseState(raw: unknown, prepared: V3DistillationPreparedBodyV1): V3DistillationProposalStateV1 {
  if (!isRecord(raw)) fail('STORE_CORRUPT');
  const state = raw.state;
  if (!['prepared', 'proposed', 'accepted', 'committing', 'committed', 'rejected', 'superseded'].includes(String(state))) {
    fail('STORE_CORRUPT');
  }
  const common = ['schemaVersion', 'proposalId', 'liveKey', 'state', 'preparedAt', 'updatedAt'];
  const extraByState: Record<string, string[]> = {
    prepared: [],
    proposed: ['proposalHash', 'proposedAt'],
    accepted: ['proposalHash', 'proposedAt', 'approval'],
    committing: ['proposalHash', 'proposedAt', 'approval', 'commit'],
    committed: ['proposalHash', 'proposedAt', 'approval', 'commit', 'result'],
    rejected: ['proposalHash', 'proposedAt', 'rejection'],
    superseded: ['proposalHash', 'proposedAt', 'supersededByProposalId', 'supersededAt'],
  };
  if (!hasExactKeys(raw, [...common, ...extraByState[String(state)]!])) fail('STORE_CORRUPT');
  if (
    raw.schemaVersion !== STATE_SCHEMA_VERSION ||
    raw.proposalId !== prepared.proposalId || raw.liveKey !== prepared.liveKey ||
    !validIso(raw.preparedAt) || !validIso(raw.updatedAt)
  ) fail('STORE_CORRUPT');
  const base: StateBase = {
    schemaVersion: STATE_SCHEMA_VERSION,
    proposalId: prepared.proposalId,
    liveKey: prepared.liveKey,
    preparedAt: raw.preparedAt,
    updatedAt: raw.updatedAt,
  };
  if (state === 'prepared') return { ...base, state };
  if (
    typeof raw.proposalHash !== 'string' || !SHA256_RE.test(raw.proposalHash) ||
    !validIso(raw.proposedAt)
  ) fail('STORE_CORRUPT');
  const proposalFields = { proposalHash: raw.proposalHash, proposedAt: raw.proposedAt };
  if (state === 'proposed') return { ...base, state, ...proposalFields };
  if (state === 'accepted') {
    return { ...base, state, ...proposalFields, approval: parseActor(raw.approval, 'approval') as V3DistillationApprovalV1 };
  }
  if (state === 'rejected') {
    return { ...base, state, ...proposalFields, rejection: parseActor(raw.rejection, 'rejection') as V3DistillationRejectionV1 };
  }
  if (state === 'superseded') {
    if (
      typeof raw.supersededByProposalId !== 'string' ||
      !V3_DISTILLATION_PROPOSAL_ID_RE.test(raw.supersededByProposalId) ||
      !validIso(raw.supersededAt)
    ) fail('STORE_CORRUPT');
    return {
      ...base,
      state,
      ...proposalFields,
      supersededByProposalId: raw.supersededByProposalId,
      supersededAt: raw.supersededAt,
    };
  }
  const approval = parseActor(raw.approval, 'approval') as V3DistillationApprovalV1;
  const commit = parseCommitAllocation(raw.commit);
  if (state === 'committing') return { ...base, state, ...proposalFields, approval, commit };
  const result = parseCommitResult(raw.result);
  if (result.workflowId !== commit.workflowId) fail('STORE_CORRUPT');
  return { ...base, state: 'committed', ...proposalFields, approval, commit, result };
}

function emptyIndex(): IdentityIndexV1 {
  return { schemaVersion: INDEX_SCHEMA_VERSION, entries: Object.create(null) as Record<string, IdentityIndexEntry> };
}

function parseIndex(raw: unknown): IdentityIndexV1 {
  if (!isRecord(raw) || !hasExactKeys(raw, ['schemaVersion', 'entries']) || raw.schemaVersion !== INDEX_SCHEMA_VERSION || !isRecord(raw.entries)) {
    fail('STORE_CORRUPT');
  }
  const entries = Object.create(null) as Record<string, IdentityIndexEntry>;
  for (const [key, value] of Object.entries(raw.entries)) {
    if (!SHA256_RE.test(key) || !isRecord(value)) fail('STORE_CORRUPT');
    if (value.state === 'active') {
      if (!hasExactKeys(value, ['state', 'proposalId']) || typeof value.proposalId !== 'string' || !V3_DISTILLATION_PROPOSAL_ID_RE.test(value.proposalId)) {
        fail('STORE_CORRUPT');
      }
      entries[key] = { state: 'active', proposalId: value.proposalId };
    } else if (value.state === 'replacing') {
      const keys = value.previousProposalId === undefined
        ? ['state', 'proposalId', 'prepared', 'preparedAt']
        : ['state', 'proposalId', 'prepared', 'preparedAt', 'previousProposalId'];
      let prepared: V3DistillationPreparedBodyV1;
      try {
        prepared = parsePrepared(value.prepared);
      } catch {
        fail('STORE_CORRUPT');
      }
      if (
        !hasExactKeys(value, keys) || typeof value.proposalId !== 'string' ||
        !V3_DISTILLATION_PROPOSAL_ID_RE.test(value.proposalId) ||
        value.proposalId !== prepared.proposalId || prepared.liveKey !== key ||
        !validIso(value.preparedAt) ||
        (value.previousProposalId !== undefined &&
          (typeof value.previousProposalId !== 'string' ||
            !V3_DISTILLATION_PROPOSAL_ID_RE.test(value.previousProposalId) ||
            value.previousProposalId === value.proposalId))
      ) fail('STORE_CORRUPT');
      entries[key] = {
        state: 'replacing',
        proposalId: value.proposalId,
        prepared,
        preparedAt: value.preparedAt,
        ...(typeof value.previousProposalId === 'string' ? { previousProposalId: value.previousProposalId } : {}),
      };
    } else {
      fail('STORE_CORRUPT');
    }
  }
  return { schemaVersion: INDEX_SCHEMA_VERSION, entries };
}

export function v3DistillationStoreRoot(dataDir: string): string {
  if (!safeString(dataDir, 4096)) fail('INVALID_ARGUMENT');
  return join(dataDir, STORE_DIR);
}

export function v3DistillationProposalDir(dataDir: string, proposalId: string): string {
  if (!V3_DISTILLATION_PROPOSAL_ID_RE.test(proposalId)) fail('INVALID_ARGUMENT');
  return join(v3DistillationStoreRoot(dataDir), PROPOSALS_DIR, proposalId);
}

function preparedPath(dataDir: string, proposalId: string): string {
  return join(v3DistillationProposalDir(dataDir, proposalId), PREPARED_FILE);
}

function proposalPath(dataDir: string, proposalId: string): string {
  return join(v3DistillationProposalDir(dataDir, proposalId), PROPOSAL_FILE);
}

function statePath(dataDir: string, proposalId: string): string {
  return join(v3DistillationProposalDir(dataDir, proposalId), STATE_FILE);
}

function indexPath(dataDir: string): string {
  return join(v3DistillationStoreRoot(dataDir), IDENTITY_INDEX_FILE);
}

function assertPrivateDirectory(path: string): void {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    fail('STORE_CORRUPT');
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('STORE_CORRUPT');
  if (process.platform !== 'win32' && (stat.mode & 0o777) !== 0o700) fail('STORE_CORRUPT');
}

function ensurePrivateDirectory(path: string, recursive = false): void {
  if (existsSync(path)) {
    assertPrivateDirectory(path);
    return;
  }
  try {
    mkdirSync(path, { recursive, mode: 0o700 });
    if (process.platform !== 'win32') chmodSync(path, 0o700);
  } catch {
    fail('STORE_CORRUPT');
  }
  assertPrivateDirectory(path);
  try {
    fsyncDirectorySyncPortable(dirname(path));
  } catch {
    fail('STORE_CORRUPT');
  }
}

function ensureStore(dataDir: string): void {
  const root = v3DistillationStoreRoot(dataDir);
  ensurePrivateDirectory(root, true);
  ensurePrivateDirectory(join(root, PROPOSALS_DIR));
}

function assertPrivateRegularFile(path: string): void {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
    if (
      stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 2 &&
      (basename(path) === PREPARED_FILE || basename(path) === PROPOSAL_FILE)
    ) {
      // Immutable publication is link(temp,target) -> unlink(temp). A process
      // crash between those syscalls leaves two names for the same already-
      // fsynced inode. Recover only the writer-owned, exact temp-name shape in
      // the same private directory; any other hard link remains corruption.
      const parent = dirname(path);
      const escaped = basename(path).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const tempName = new RegExp(`^\\.${escaped}\\.[0-9]+\\.[0-9a-f]{16}\\.tmp$`);
      const targetDev = stat.dev;
      const targetIno = stat.ino;
      const aliases = readdirSync(parent).filter((name) => {
        if (!tempName.test(name)) return false;
        try {
          const alias = lstatSync(join(parent, name));
          return alias.isFile() && !alias.isSymbolicLink() &&
            alias.dev === targetDev && alias.ino === targetIno && alias.nlink === 2;
        } catch {
          return false;
        }
      });
      if (aliases.length !== 1) fail('STORE_CORRUPT');
      unlinkSync(join(parent, aliases[0]!));
      fsyncDirectorySyncPortable(parent);
      stat = lstatSync(path);
    }
  } catch {
    fail('STORE_CORRUPT');
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) fail('STORE_CORRUPT');
  if (process.platform !== 'win32' && (stat.mode & 0o777) !== 0o600) fail('STORE_CORRUPT');
}

function readPrivateJson(path: string, maxBytes = MAX_PRIVATE_JSON_BYTES): unknown {
  assertPrivateRegularFile(path);
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const before = lstatSync(path);
    const opened = fstatSync(fd);
    if (
      !opened.isFile() || before.dev !== opened.dev || before.ino !== opened.ino ||
      opened.nlink !== 1 || opened.size > maxBytes
    ) fail('STORE_CORRUPT');
    const bytes = readFileSync(fd);
    const after = fstatSync(fd);
    if (
      after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs
    ) fail('STORE_CORRUPT');
    try {
      return JSON.parse(bytes.toString('utf-8')) as unknown;
    } catch {
      fail('STORE_CORRUPT');
    }
  } catch (error) {
    if (error instanceof V3DistillationStoreError) throw error;
    fail('STORE_CORRUPT');
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* best effort */ }
    }
  }
}

function writePrivateTemp(path: string, bytes: string): { temp: string; fd: number } {
  const parent = dirname(path);
  const temp = join(parent, `.${basename(path)}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(
      temp,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    fchmodSync(fd, 0o600);
    writeFileSync(fd, bytes, 'utf-8');
    fsyncSync(fd);
    return { temp, fd };
  } catch {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* best effort */ }
    }
    try { unlinkSync(temp); } catch { /* best effort */ }
    fail('STORE_CORRUPT');
  }
}

function writeMutablePrivateJson(
  path: string,
  value: unknown,
  maxBytes = MAX_PRIVATE_JSON_BYTES,
): void {
  const bytes = `${canonicalJsonStringify(value)}\n`;
  if (Buffer.byteLength(bytes) > maxBytes) fail('INVALID_ARGUMENT');
  if (existsSync(path)) assertPrivateRegularFile(path);
  const { temp, fd } = writePrivateTemp(path, bytes);
  let renamed = false;
  try {
    closeSync(fd);
    renameSync(temp, path);
    renamed = true;
    assertPrivateRegularFile(path);
    fsyncDirectorySyncPortable(dirname(path));
  } catch (error) {
    if (error instanceof V3DistillationStoreError) throw error;
    fail('STORE_CORRUPT');
  } finally {
    if (!renamed) {
      try { closeSync(fd); } catch { /* already closed */ }
      try { unlinkSync(temp); } catch { /* best effort */ }
    }
  }
}

function writeImmutablePrivateJson(path: string, value: unknown): void {
  const bytes = `${canonicalJsonStringify(value)}\n`;
  if (Buffer.byteLength(bytes) > MAX_PRIVATE_JSON_BYTES) fail('INVALID_ARGUMENT');
  if (existsSync(path)) {
    const existing = readPrivateJson(path);
    if (!sameCanonical(existing, value)) fail('CONTENT_CONFLICT');
    fsyncRegularFileSync(path);
    fsyncDirectorySyncPortable(dirname(path));
    return;
  }
  const { temp, fd } = writePrivateTemp(path, bytes);
  let linked = false;
  try {
    closeSync(fd);
    try {
      linkSync(temp, path);
      linked = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const existing = readPrivateJson(path);
      if (!sameCanonical(existing, value)) fail('CONTENT_CONFLICT');
    }
    // Persist the new target name before removing the already-fsynced temp
    // name. A crash before unlink is recoverable as the recognized nlink=2
    // writer-temp shape; unlink-before-fsync could instead lose both evidence
    // of the target publication on power loss.
    fsyncDirectorySyncPortable(dirname(path));
    unlinkSync(temp);
    assertPrivateRegularFile(path);
    fsyncRegularFileSync(path);
    fsyncDirectorySyncPortable(dirname(path));
  } catch (error) {
    if (error instanceof V3DistillationStoreError) throw error;
    fail('STORE_CORRUPT');
  } finally {
    if (linked && existsSync(temp)) {
      try { unlinkSync(temp); } catch { /* best effort */ }
    } else {
      try { closeSync(fd); } catch { /* already closed */ }
      try { unlinkSync(temp); } catch { /* best effort */ }
    }
  }
}

function readIndex(dataDir: string): IdentityIndexV1 {
  const path = indexPath(dataDir);
  if (!existsSync(path)) return emptyIndex();
  return parseIndex(readPrivateJson(path, MAX_INDEX_BYTES));
}

function writeIndex(dataDir: string, index: IdentityIndexV1): void {
  writeMutablePrivateJson(indexPath(dataDir), parseIndex(index), MAX_INDEX_BYTES);
}

function loadProposalUnlocked(dataDir: string, proposalId: string): LoadedV3DistillationProposal {
  const dir = v3DistillationProposalDir(dataDir, proposalId);
  if (!existsSync(dir)) fail('PROPOSAL_NOT_FOUND');
  assertPrivateDirectory(dir);
  const prepared = parsePrepared(readPrivateJson(preparedPath(dataDir, proposalId)));
  const state = parseState(readPrivateJson(statePath(dataDir, proposalId)), prepared);
  let proposal: V3DistillationProposalBodyV1 | undefined;
  if (existsSync(proposalPath(dataDir, proposalId))) {
    proposal = parseProposal(readPrivateJson(proposalPath(dataDir, proposalId)), prepared);
  }
  // Publishing spans two durable files. A crash may leave the immutable body
  // installed while state is still `prepared`; publishProposal recognizes and
  // completes that one safe forward-recovery shape. Missing body after any
  // later state remains an integrity failure.
  if (state.state !== 'prepared' && (
    !proposal || proposal.proposalHash !== state.proposalHash ||
    proposal.createdAt !== state.preparedAt
  )) {
    fail('STORE_CORRUPT');
  }
  if (state.state === 'prepared' && proposal && proposal.createdAt !== state.preparedAt) {
    fail('STORE_CORRUPT');
  }
  return { prepared, ...(proposal ? { proposal } : {}), state };
}

function writeState(dataDir: string, state: V3DistillationProposalStateV1): void {
  const prepared = parsePrepared(readPrivateJson(preparedPath(dataDir, state.proposalId)));
  writeMutablePrivateJson(statePath(dataDir, state.proposalId), parseState(state, prepared));
}

function createOrRecoverPrepared(
  dataDir: string,
  prepared: V3DistillationPreparedBodyV1,
  preparedAt: string,
): LoadedV3DistillationProposal {
  const dir = v3DistillationProposalDir(dataDir, prepared.proposalId);
  if (!existsSync(dir)) {
    try {
      mkdirSync(dir, { mode: 0o700 });
      if (process.platform !== 'win32') chmodSync(dir, 0o700);
      fsyncDirectorySyncPortable(dirname(dir));
    } catch {
      fail('STORE_CORRUPT');
    }
  }
  assertPrivateDirectory(dir);
  writeImmutablePrivateJson(preparedPath(dataDir, prepared.proposalId), prepared);
  const path = statePath(dataDir, prepared.proposalId);
  if (!existsSync(path)) {
    writeMutablePrivateJson(path, {
      schemaVersion: STATE_SCHEMA_VERSION,
      proposalId: prepared.proposalId,
      liveKey: prepared.liveKey,
      state: 'prepared',
      preparedAt,
      updatedAt: preparedAt,
    } satisfies V3DistillationProposalStateV1);
  }
  const loaded = loadProposalUnlocked(dataDir, prepared.proposalId);
  if (!sameCanonical(loaded.prepared, prepared)) fail('CONTENT_CONFLICT');
  return loaded;
}

/**
 * Complete the transaction whose intent is already durable in the identity
 * index. The entry carries the exact immutable allocation so recovery never
 * depends on another delivery of the original Lark event.
 *
 * Caller owns the identity-index lock. Lock order remains index -> state.
 */
function recoverReplacingEntryUnlocked(
  dataDir: string,
  index: IdentityIndexV1,
  liveKey: string,
  entry: ReplacingIdentityIndexEntry,
): LoadedV3DistillationProposal {
  if (
    entry.prepared.liveKey !== liveKey ||
    entry.prepared.proposalId !== entry.proposalId
  ) fail('STORE_CORRUPT');

  const loaded = createOrRecoverPrepared(dataDir, entry.prepared, entry.preparedAt);
  if (entry.previousProposalId) {
    withStoreLock(statePath(dataDir, entry.previousProposalId), () => {
      const previous = loadProposalUnlocked(dataDir, entry.previousProposalId!);
      if (previous.prepared.liveKey !== liveKey) fail('STORE_CORRUPT');
      if (previous.state.state === 'proposed') {
        writeState(dataDir, {
          ...previous.state,
          state: 'superseded',
          supersededByProposalId: entry.proposalId,
          supersededAt: entry.preparedAt,
          updatedAt: entry.preparedAt,
        });
      } else if (
        previous.state.state !== 'superseded' ||
        previous.state.supersededByProposalId !== entry.proposalId
      ) {
        fail('STATE_CONFLICT');
      }
    });
  }
  index.entries[liveKey] = { state: 'active', proposalId: entry.proposalId };
  writeIndex(dataDir, index);
  return loaded;
}

function withCurrentProposalLock<T>(
  dataDir: string,
  proposalId: string,
  fn: (loaded: LoadedV3DistillationProposal) => T,
): T {
  ensureStore(dataDir);
  const identityTarget = indexPath(dataDir);
  return withStoreLock(identityTarget, () => {
    const prepared = parsePrepared(readPrivateJson(preparedPath(dataDir, proposalId)));
    const index = readIndex(dataDir);
    const entry = index.entries[prepared.liveKey];
    return withStoreLock(statePath(dataDir, proposalId), () => {
      const loaded = loadProposalUnlocked(dataDir, proposalId);
      if (!entry || entry.state !== 'active' || entry.proposalId !== proposalId) {
        return fnStaleIdempotentGuard(loaded, fn);
      }
      const result = fn(loaded);
      const after = loadProposalUnlocked(dataDir, proposalId);
      if (after.state.state === 'committed' || after.state.state === 'rejected') {
        const current = index.entries[prepared.liveKey];
        if (current?.state === 'active' && current.proposalId === proposalId) {
          delete index.entries[prepared.liveKey];
          writeIndex(dataDir, index);
        }
      }
      return result;
    });
  });
}

/**
 * A stale proposal may only acknowledge an already-approved commit recovery or
 * a duplicate terminal transition. The callback decides this by returning
 * normally; all non-idempotent stale attempts must throw from inside it.
 */
function fnStaleIdempotentGuard<T>(
  loaded: LoadedV3DistillationProposal,
  fn: (loaded: LoadedV3DistillationProposal) => T,
): T {
  if (!['accepted', 'committing', 'rejected', 'superseded', 'committed'].includes(loaded.state.state)) {
    fail('STALE_PROPOSAL');
  }
  return fn(loaded);
}

/** Prepare or idempotently recover a per-request proposal allocation. */
export function prepareProposal(
  dataDir: string,
  input: PrepareV3DistillationProposalInput,
): LoadedV3DistillationProposal {
  ensureStore(dataDir);
  if (
    !safeString(input.requestKey) || !safeString(input.displayName, 128) ||
    input.displayName !== input.displayName.trim() || input.displayName !== input.displayName.normalize('NFC') ||
    input.compilerVersion !== V3_DISTILLATION_COMPILER_VERSION
  ) fail('INVALID_ARGUMENT');
  const sourceIdentity = normalizeSourceIdentity(input.sourceIdentity);
  const replyTarget = normalizeReplyTarget(input.replyTarget, sourceIdentity);
  const liveKey = computeV3DistillationLiveKey(sourceIdentity, input.compilerVersion);
  const content = {
    schemaVersion: PREPARED_SCHEMA_VERSION,
    requestKey: input.requestKey,
    liveKey,
    compilerVersion: input.compilerVersion,
    sourceIdentity,
    replyTarget,
    displayName: input.displayName,
  } as const;
  const proposalId = proposalIdForPreparedContent(content);
  const prepared = parsePrepared({ ...content, proposalId });
  const preparedAt = (input.now ?? new Date()).toISOString();
  if (!validIso(preparedAt)) fail('INVALID_ARGUMENT');

  const target = indexPath(dataDir);
  return withStoreLock(target, () => {
    const index = readIndex(dataDir);
    let existingEntry = index.entries[liveKey];

    if (existingEntry?.state === 'replacing') {
      const recovered = recoverReplacingEntryUnlocked(dataDir, index, liveKey, existingEntry);
      if (existingEntry.proposalId === proposalId) {
        if (!sameCanonical(recovered.prepared, prepared)) fail('CONTENT_CONFLICT');
        return recovered;
      }
      // Finish the older durable transaction before evaluating this new
      // request. From here onward the normal active-entry rules decide whether
      // to resume it, supersede it, or reject a conflicting redelivery.
      existingEntry = index.entries[liveKey];
    }

    if (existingEntry?.proposalId === proposalId) {
      const loaded = loadProposalUnlocked(dataDir, proposalId);
      if (!sameCanonical(loaded.prepared, prepared)) fail('CONTENT_CONFLICT');
      return loaded;
    }

    // A content-addressed allocation that already exists but is no longer the
    // live index target is an old delivery, not a new request.  In particular:
    // A proposed -> B proposed (A superseded) -> delayed redelivery of A must
    // never reactivate A or supersede B.  The only legitimate adoption of an
    // already-created replacement is handled by the `replacing` recovery arm
    // above, where the index already names that exact proposal id.
    if (existsSync(preparedPath(dataDir, proposalId))) {
      withStoreLock(statePath(dataDir, proposalId), () => {
        const stale = loadProposalUnlocked(dataDir, proposalId);
        if (!sameCanonical(stale.prepared, prepared)) fail('CONTENT_CONFLICT');
        fail('STALE_PROPOSAL');
      });
    }

    let previousProposalId: string | undefined;
    if (existingEntry) {
      const previous = loadProposalUnlocked(dataDir, existingEntry.proposalId);
      if (previous.prepared.requestKey === input.requestKey) {
        // The same inbound event must never allocate or supersede a second body.
        fail('CONTENT_CONFLICT');
      }
      // A distinct inbound event always owns a fresh immutable reply target.
      // Reusing an older same-name allocation would let crash recovery post a
      // review card into the previous thread (and its deterministic delivery
      // UUID could suppress the new reply). Exact redelivery is already handled
      // by the content-addressed proposalId arm above; every genuinely new
      // request replaces prepared/proposed work instead of mutating it.
      if (previous.state.state === 'accepted' || previous.state.state === 'committing') {
        fail('IDENTITY_BUSY');
      }
      if (previous.state.state === 'proposed') previousProposalId = previous.prepared.proposalId;
    }

    index.entries[liveKey] = {
      state: 'replacing',
      proposalId,
      prepared,
      preparedAt,
      ...(previousProposalId ? { previousProposalId } : {}),
    };
    writeIndex(dataDir, index);
    const loaded = createOrRecoverPrepared(dataDir, prepared, preparedAt);
    if (previousProposalId) {
      withStoreLock(statePath(dataDir, previousProposalId), () => {
        const previous = loadProposalUnlocked(dataDir, previousProposalId!);
        if (previous.state.state !== 'proposed') fail('STATE_CONFLICT');
        writeState(dataDir, {
          ...previous.state,
          state: 'superseded',
          supersededByProposalId: proposalId,
          supersededAt: preparedAt,
          updatedAt: preparedAt,
        });
      });
    }
    index.entries[liveKey] = { state: 'active', proposalId };
    writeIndex(dataDir, index);
    return loaded;
  });
}

/** Publish the immutable host-compiled proposal and enter `proposed`. */
export function publishProposal(
  dataDir: string,
  proposalId: string,
  input: PublishV3DistillationProposalInput,
): LoadedV3DistillationProposal {
  return withCurrentProposalLock(dataDir, proposalId, (loaded) => {
    const compiled = parseV3DistillationCompiledBody(input.compiled);
    if (
      compiled.compilerVersion !== loaded.prepared.compilerVersion ||
      compiled.baselineRevisionSha256 !== loaded.prepared.sourceIdentity.baselineRevisionSha256
    ) fail('CONTENT_CONFLICT');
    const createdAt = loaded.state.preparedAt;
    const material = proposalHashMaterial({
      schemaVersion: PROPOSAL_SCHEMA_VERSION,
      proposalId,
      liveKey: loaded.prepared.liveKey,
      compilerVersion: loaded.prepared.compilerVersion,
      sourceIdentity: loaded.prepared.sourceIdentity,
      displayName: loaded.prepared.displayName,
      createdAt,
      compiled,
    });
    const body = parseProposal(
      { ...material, proposalHash: sha256Canonical(material) },
      loaded.prepared,
    );
    if (loaded.proposal) {
      if (!sameCanonical(loaded.proposal, body)) fail('CONTENT_CONFLICT');
      writeImmutablePrivateJson(proposalPath(dataDir, proposalId), body);
      if (loaded.state.state === 'prepared') {
        const now = (input.now ?? new Date()).toISOString();
        writeState(dataDir, {
          ...loaded.state,
          state: 'proposed',
          proposalHash: body.proposalHash,
          proposedAt: now,
          updatedAt: now,
        });
        return loadProposalUnlocked(dataDir, proposalId);
      }
      return loaded;
    }
    if (loaded.state.state !== 'prepared') fail('STATE_CONFLICT');
    writeImmutablePrivateJson(proposalPath(dataDir, proposalId), body);
    const now = (input.now ?? new Date()).toISOString();
    writeState(dataDir, {
      ...loaded.state,
      state: 'proposed',
      proposalHash: body.proposalHash,
      proposedAt: now,
      updatedAt: now,
    });
    return loadProposalUnlocked(dataDir, proposalId);
  });
}

function assertProposalHash(loaded: LoadedV3DistillationProposal, proposalHash: string): void {
  if (!SHA256_RE.test(proposalHash) || loaded.proposal?.proposalHash !== proposalHash) fail('CONTENT_CONFLICT');
}

function sameActor(
  actor: V3DistillationApprovalV1 | V3DistillationRejectionV1,
  input: ActOnV3DistillationProposalInput,
): boolean {
  return actor.operatorOpenId === input.operatorOpenId &&
    actor.larkAppId === input.larkAppId && actor.chatId === input.chatId;
}

export function acceptProposal(
  dataDir: string,
  proposalId: string,
  input: ActOnV3DistillationProposalInput,
): LoadedV3DistillationProposal {
  return withCurrentProposalLock(dataDir, proposalId, (loaded) => {
    assertProposalHash(loaded, input.proposalHash);
    if (loaded.state.state === 'accepted' || loaded.state.state === 'committing' || loaded.state.state === 'committed') {
      if (!sameActor(loaded.state.approval, input)) fail('CONTENT_CONFLICT');
      return loaded;
    }
    if (loaded.state.state !== 'proposed') fail('STATE_CONFLICT');
    const now = (input.now ?? new Date()).toISOString();
    writeState(dataDir, {
      ...loaded.state,
      state: 'accepted',
      approval: {
        operatorOpenId: input.operatorOpenId,
        larkAppId: input.larkAppId,
        chatId: input.chatId,
        acceptedAt: now,
      },
      updatedAt: now,
    });
    return loadProposalUnlocked(dataDir, proposalId);
  });
}

export function rejectProposal(
  dataDir: string,
  proposalId: string,
  input: ActOnV3DistillationProposalInput,
): LoadedV3DistillationProposal {
  return withCurrentProposalLock(dataDir, proposalId, (loaded) => {
    assertProposalHash(loaded, input.proposalHash);
    if (loaded.state.state === 'rejected') {
      if (!sameActor(loaded.state.rejection, input)) fail('CONTENT_CONFLICT');
      return loaded;
    }
    if (loaded.state.state !== 'proposed') fail('STATE_CONFLICT');
    const now = (input.now ?? new Date()).toISOString();
    writeState(dataDir, {
      ...loaded.state,
      state: 'rejected',
      rejection: {
        operatorOpenId: input.operatorOpenId,
        larkAppId: input.larkAppId,
        chatId: input.chatId,
        rejectedAt: now,
      },
      updatedAt: now,
    });
    return loadProposalUnlocked(dataDir, proposalId);
  });
}

export function beginCommit(
  dataDir: string,
  proposalId: string,
  input: BeginV3DistillationCommitInput,
): LoadedV3DistillationProposal {
  return withCurrentProposalLock(dataDir, proposalId, (loaded) => {
    assertProposalHash(loaded, input.proposalHash);
    if (!SAVED_WORKFLOW_ID_RE.test(input.workflowId) || !validIso(input.createdAt)) fail('INVALID_ARGUMENT');
    if (loaded.state.state === 'committing' || loaded.state.state === 'committed') {
      if (loaded.state.commit.workflowId !== input.workflowId || loaded.state.commit.createdAt !== input.createdAt) {
        fail('CONTENT_CONFLICT');
      }
      return loaded;
    }
    if (loaded.state.state !== 'accepted') fail('STATE_CONFLICT');
    const now = (input.now ?? new Date()).toISOString();
    writeState(dataDir, {
      ...loaded.state,
      state: 'committing',
      commit: { workflowId: input.workflowId, createdAt: input.createdAt, startedAt: now },
      updatedAt: now,
    });
    return loadProposalUnlocked(dataDir, proposalId);
  });
}

export function markCommitted(
  dataDir: string,
  proposalId: string,
  input: MarkV3DistillationCommittedInput,
): LoadedV3DistillationProposal {
  return withCurrentProposalLock(dataDir, proposalId, (loaded) => {
    assertProposalHash(loaded, input.proposalHash);
    if (
      !SAVED_WORKFLOW_ID_RE.test(input.workflowId) ||
      !SAVED_WORKFLOW_REVISION_ID_RE.test(input.revisionId) ||
      (input.revisionContentHash !== undefined && !SAVED_WORKFLOW_CONTENT_HASH_RE.test(input.revisionContentHash))
    ) fail('INVALID_ARGUMENT');
    if (loaded.state.state === 'committed') {
      if (
        loaded.state.result.workflowId !== input.workflowId ||
        loaded.state.result.revisionId !== input.revisionId ||
        loaded.state.result.revisionContentHash !== input.revisionContentHash
      ) fail('CONTENT_CONFLICT');
      return loaded;
    }
    if (loaded.state.state !== 'committing' || loaded.state.commit.workflowId !== input.workflowId) {
      fail('STATE_CONFLICT');
    }
    const now = (input.now ?? new Date()).toISOString();
    writeState(dataDir, {
      ...loaded.state,
      state: 'committed',
      result: {
        workflowId: input.workflowId,
        revisionId: input.revisionId,
        ...(input.revisionContentHash ? { revisionContentHash: input.revisionContentHash } : {}),
        committedAt: now,
      },
      updatedAt: now,
    });
    return loadProposalUnlocked(dataDir, proposalId);
  });
}

export function loadProposal(dataDir: string, proposalId: string): LoadedV3DistillationProposal {
  ensureStore(dataDir);
  return loadProposalUnlocked(dataDir, proposalId);
}

/** Strict startup inventory for crash recovery. Unknown entries fail closed. */
export function listV3DistillationProposals(dataDir: string): LoadedV3DistillationProposal[] {
  ensureStore(dataDir);
  const root = join(v3DistillationStoreRoot(dataDir), PROPOSALS_DIR);
  let entries: Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true, encoding: 'utf8' });
  } catch {
    fail('STORE_CORRUPT');
  }
  const ids: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !V3_DISTILLATION_PROPOSAL_ID_RE.test(entry.name)) {
      fail('STORE_CORRUPT');
    }
    ids.push(entry.name);
  }
  ids.sort();
  return ids.map((proposalId) => loadProposalUnlocked(dataDir, proposalId));
}

/** Current active allocations only; used by daemon cold recovery. */
export function listActiveV3DistillationProposals(dataDir: string): LoadedV3DistillationProposal[] {
  ensureStore(dataDir);
  return withStoreLock(indexPath(dataDir), () => {
    const index = readIndex(dataDir);
    // A crash may leave only the durable replacing intent. Complete those
    // transactions before building the active inventory so startup recovery
    // never depends on the original message being delivered again.
    for (const liveKey of Object.keys(index.entries).sort()) {
      const entry = index.entries[liveKey];
      if (entry?.state === 'replacing') {
        recoverReplacingEntryUnlocked(dataDir, index, liveKey, entry);
      }
    }
    const ids = Object.values(index.entries)
      .filter((entry): entry is ActiveIdentityIndexEntry => entry.state === 'active')
      .map((entry) => entry.proposalId)
      .sort();
    if (new Set(ids).size !== ids.length) fail('STORE_CORRUPT');
    return ids.map((proposalId) => {
      const loaded = loadProposalUnlocked(dataDir, proposalId);
      if (index.entries[loaded.prepared.liveKey]?.proposalId !== proposalId) fail('STORE_CORRUPT');
      return loaded;
    });
  });
}
