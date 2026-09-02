import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';

import { canonicalJson } from '../utils/canonical-input-hash.js';
import {
  CODEX_REASONING_EFFORTS,
  cliModelSupportsReasoningEffort,
  type CodexReasoningEffort,
} from '../services/codex-reasoning-effort.js';

/**
 * Data-only contract for a future target-daemon-authoritative dispatch launch.
 * Nothing in this module is connected to a command, route, or worker launch.
 */
export const DISPATCH_LAUNCH_PROTOCOL = 'v1' as const;
export const DISPATCH_LAUNCH_SCHEMA_VERSION = 1 as const;
export const DISPATCH_LAUNCH_POLICY_SCHEMA_VERSION = 1 as const;
export const DISPATCH_LAUNCH_OPERATION_SCHEMA_VERSION = 1 as const;
export const DISPATCH_LAUNCH_ADMISSION_SCHEMA_VERSION = 1 as const;
export const DISPATCH_LAUNCH_OVERRIDE_SCHEMA_VERSION = 1 as const;

export const DISPATCH_LAUNCH_ID_RE = /^dl_[0-9a-f]{32}$/;
export const DISPATCH_LAUNCH_DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

export const DISPATCH_LAUNCH_KICKOFF_LIMITS = {
  titleBytes: 512,
  briefBytes: 64 * 1024,
  roleBytes: 256,
  sourceDisplayBytes: 512,
  totalBytes: 72 * 1024,
} as const;

export const DISPATCH_LAUNCH_ERROR_CODES = [
  'BAD_REQUEST',
  'PROTOCOL_UNSUPPORTED',
  'UNAUTHORIZED_SOURCE',
  'POLICY_DENIED',
  'TARGET_NOT_IN_CHAT',
  'TARGET_CHAT_UNSUPPORTED',
  'UNSUPPORTED_HARNESS',
  'MODEL_REQUIRED_FOR_OVERRIDE',
  'MODEL_UNSUPPORTED',
  'REASONING_EFFORT_UNSUPPORTED',
  'INVALID_MODEL_EFFORT_COMBINATION',
  'WORKDIR_REQUIRED',
  'CAPACITY_UNAVAILABLE',
  'POLICY_CHANGED',
  'LAUNCH_IDENTITY_CHANGED',
  'ROOT_CONFLICT',
  'OPERATION_NOT_FOUND',
  'OPERATION_CONFLICT',
  'OPERATION_EXPIRED',
  'DELIVERY_UNKNOWN',
  'INPUT_COMMIT_TIMEOUT',
  'RUNTIME_NOT_PROVABLE',
  'RUNTIME_MISMATCH',
  'CANCELLED',
  'INTERNAL_ERROR',
] as const;

export type DispatchLaunchErrorCode = typeof DISPATCH_LAUNCH_ERROR_CODES[number];

export interface DispatchLaunchFailure {
  ok: false;
  errorCode: DispatchLaunchErrorCode;
  message: string;
}

export interface DispatchLaunchRequestedOverride {
  model?: string;
  reasoningEffort?: CodexReasoningEffort;
}

export interface DispatchLaunchEffectiveOverride {
  model: string;
  /** Missing means no explicit effort is passed; Botmux never guesses the CLI default. */
  reasoningEffort?: CodexReasoningEffort;
}

export interface DispatchLaunchKickoffPayloadV1 {
  schemaVersion: typeof DISPATCH_LAUNCH_SCHEMA_VERSION;
  protocol: typeof DISPATCH_LAUNCH_PROTOCOL;
  title: string;
  brief: string;
  role?: string;
  sourceDisplay: string;
  targetLarkAppId: string;
}

export interface CanonicalDispatchLaunchKickoff {
  payload: DispatchLaunchKickoffPayloadV1;
  canonicalJson: string;
  byteLength: number;
  digest: string;
}

export interface DispatchLaunchPolicyV1 {
  schemaVersion: typeof DISPATCH_LAUNCH_POLICY_SCHEMA_VERSION;
  enabled: boolean;
  allowedSourceAppIds: string[];
  allowedModels: string[];
  allowedReasoningEfforts: CodexReasoningEffort[];
}

export interface DispatchLaunchIdentityV1 {
  cliId: string;
  cliRuntimeDigest: string;
  executable: string;
  wrapperCli?: string;
  backendType: string;
  codexRpcInput: boolean;
  existingAppServer: boolean;
  botConfigDigest: string;
  policyDigest: string;
}

export interface DispatchLaunchPrepareRequestV1 {
  schemaVersion: typeof DISPATCH_LAUNCH_SCHEMA_VERSION;
  protocol: typeof DISPATCH_LAUNCH_PROTOCOL;
  dispatchId: string;
  source: {
    larkAppId: string;
    sessionId: string;
    turnId: string;
    callerOpenId?: string;
  };
  targetLarkAppId: string;
  chatId: string;
  kickoff: CanonicalDispatchLaunchKickoff;
  requestedOverride: DispatchLaunchRequestedOverride;
  expiresAt: string;
}

export interface DispatchLaunchStartRequestV1 {
  schemaVersion: typeof DISPATCH_LAUNCH_SCHEMA_VERSION;
  protocol: typeof DISPATCH_LAUNCH_PROTOCOL;
  dispatchId: string;
  kickoffDigest: string;
  policyDigest: string;
  launchIdentityDigest: string;
}

export interface DispatchLaunchCancelRequestV1 {
  schemaVersion: typeof DISPATCH_LAUNCH_SCHEMA_VERSION;
  protocol: typeof DISPATCH_LAUNCH_PROTOCOL;
  dispatchId: string;
  reason: string;
}

export interface DispatchLaunchTurnFactV1 {
  sessionId: string;
  kickoffTurnId: string;
  workerGeneration: number;
  observedAt: string;
}

export interface DispatchLaunchProofV1 {
  inputCommitted: DispatchLaunchTurnFactV1;
  runtimeObserved: DispatchLaunchTurnFactV1 & {
    model: string;
    reasoningEffort?: CodexReasoningEffort;
    /** Set only after the adapter's explicit alias/equivalence rules pass. */
    equivalentToEffectiveOverride: true;
  };
}

export const DISPATCH_LAUNCH_OPERATION_STATES = [
  'created',
  'preparing',
  'prepared',
  'starting',
  'awaiting_proof',
  'succeeded',
  'failed',
  'cancelled',
  'delivery_unknown',
] as const;

export type DispatchLaunchOperationState = typeof DISPATCH_LAUNCH_OPERATION_STATES[number];

export interface DispatchLaunchOperationV1 {
  schemaVersion: typeof DISPATCH_LAUNCH_OPERATION_SCHEMA_VERSION;
  dispatchId: string;
  owner: 'source' | 'target';
  state: DispatchLaunchOperationState;
  sourceLarkAppId: string;
  sourceSessionId: string;
  sourceTurnId: string;
  targetLarkAppId: string;
  chatId: string;
  kickoff: CanonicalDispatchLaunchKickoff;
  requestedOverride: DispatchLaunchRequestedOverride;
  effectiveOverride?: DispatchLaunchEffectiveOverride;
  launchIdentity?: DispatchLaunchIdentityV1;
  rootMessageId?: string;
  targetSessionId?: string;
  kickoffTurnId?: string;
  workerGeneration?: number;
  proof?: DispatchLaunchProofV1;
  errorCode?: DispatchLaunchErrorCode;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}

export interface DispatchLaunchAdmissionReceiptV1 {
  schemaVersion: typeof DISPATCH_LAUNCH_ADMISSION_SCHEMA_VERSION;
  dispatchId: string;
  state: 'authorized' | 'committed' | 'released';
  sourceLarkAppId: string;
  sourceSessionId: string;
  sourceTurnId: string;
  callerOpenId?: string;
  chatId: string;
  targetLarkAppId: string;
  policyDigest: string;
  talkAuthorizationReceiptId: string;
  quotaReceiptId: string;
  workingDir: string;
  capacityReservationId: string;
  createdAt: string;
  committedAt?: string;
  releasedAt?: string;
}

export interface DispatchLaunchOverrideSnapshotV1 {
  schemaVersion: typeof DISPATCH_LAUNCH_OVERRIDE_SCHEMA_VERSION;
  provenanceId: string;
  dispatchId?: string;
  inheritedFromDispatchId?: string;
  effective: DispatchLaunchEffectiveOverride;
  launchIdentity: DispatchLaunchIdentityV1;
  createdAt: string;
}

const nonEmptyString = z.string().trim().min(1);
const larkAppIdSchema = nonEmptyString.regex(/^cli_[A-Za-z0-9]+$/);
const dispatchIdSchema = z.string().regex(DISPATCH_LAUNCH_ID_RE);
const digestSchema = z.string().regex(DISPATCH_LAUNCH_DIGEST_RE);
const timestampSchema = z.string().datetime({ offset: true });
const reasoningEffortSchema = z.enum(CODEX_REASONING_EFFORTS);

const requestedOverrideSchema = z.object({
  model: nonEmptyString.optional(),
  reasoningEffort: reasoningEffortSchema.optional(),
}).strict();

const effectiveOverrideSchema = z.object({
  model: nonEmptyString,
  reasoningEffort: reasoningEffortSchema.optional(),
}).strict();

const kickoffPayloadSchema = z.object({
  schemaVersion: z.literal(DISPATCH_LAUNCH_SCHEMA_VERSION),
  protocol: z.literal(DISPATCH_LAUNCH_PROTOCOL),
  title: z.string(),
  brief: z.string(),
  role: z.string().optional(),
  sourceDisplay: z.string(),
  targetLarkAppId: larkAppIdSchema,
}).strict();

const canonicalKickoffSchema = z.object({
  payload: kickoffPayloadSchema,
  canonicalJson: z.string(),
  byteLength: z.number().int().nonnegative().max(DISPATCH_LAUNCH_KICKOFF_LIMITS.totalBytes),
  digest: digestSchema,
}).strict();

const launchIdentitySchema = z.object({
  cliId: nonEmptyString,
  cliRuntimeDigest: digestSchema,
  executable: nonEmptyString,
  wrapperCli: nonEmptyString.optional(),
  backendType: nonEmptyString,
  codexRpcInput: z.boolean(),
  existingAppServer: z.boolean(),
  botConfigDigest: digestSchema,
  policyDigest: digestSchema,
}).strict();

const turnFactSchema = z.object({
  sessionId: nonEmptyString,
  kickoffTurnId: nonEmptyString,
  workerGeneration: z.number().int().nonnegative(),
  observedAt: timestampSchema,
}).strict();

const proofSchema = z.object({
  inputCommitted: turnFactSchema,
  runtimeObserved: turnFactSchema.extend({
    model: nonEmptyString,
    reasoningEffort: reasoningEffortSchema.optional(),
    equivalentToEffectiveOverride: z.literal(true),
  }).strict(),
}).strict().superRefine((value, context) => {
  const left = value.inputCommitted;
  const right = value.runtimeObserved;
  if (left.sessionId !== right.sessionId
      || left.kickoffTurnId !== right.kickoffTurnId
      || left.workerGeneration !== right.workerGeneration) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'input and runtime proof must identify the same session, kickoff turn and worker generation',
    });
  }
});

export const DispatchLaunchPrepareRequestSchema = z.object({
  schemaVersion: z.literal(DISPATCH_LAUNCH_SCHEMA_VERSION),
  protocol: z.literal(DISPATCH_LAUNCH_PROTOCOL),
  dispatchId: dispatchIdSchema,
  source: z.object({
    larkAppId: larkAppIdSchema,
    sessionId: nonEmptyString,
    turnId: nonEmptyString,
    callerOpenId: nonEmptyString.optional(),
  }).strict(),
  targetLarkAppId: larkAppIdSchema,
  chatId: nonEmptyString,
  kickoff: canonicalKickoffSchema,
  requestedOverride: requestedOverrideSchema,
  expiresAt: timestampSchema,
}).strict();

export const DispatchLaunchStartRequestSchema = z.object({
  schemaVersion: z.literal(DISPATCH_LAUNCH_SCHEMA_VERSION),
  protocol: z.literal(DISPATCH_LAUNCH_PROTOCOL),
  dispatchId: dispatchIdSchema,
  kickoffDigest: digestSchema,
  policyDigest: digestSchema,
  launchIdentityDigest: digestSchema,
}).strict();

export const DispatchLaunchCancelRequestSchema = z.object({
  schemaVersion: z.literal(DISPATCH_LAUNCH_SCHEMA_VERSION),
  protocol: z.literal(DISPATCH_LAUNCH_PROTOCOL),
  dispatchId: dispatchIdSchema,
  reason: nonEmptyString.max(1024),
}).strict();

export const DispatchLaunchPolicySchema = z.object({
  schemaVersion: z.literal(DISPATCH_LAUNCH_POLICY_SCHEMA_VERSION),
  enabled: z.boolean(),
  allowedSourceAppIds: z.array(larkAppIdSchema).max(256),
  allowedModels: z.array(nonEmptyString).max(256),
  allowedReasoningEfforts: z.array(reasoningEffortSchema).max(CODEX_REASONING_EFFORTS.length),
}).strict();

export const DispatchLaunchOperationSchema = z.object({
  schemaVersion: z.literal(DISPATCH_LAUNCH_OPERATION_SCHEMA_VERSION),
  dispatchId: dispatchIdSchema,
  owner: z.enum(['source', 'target']),
  state: z.enum(DISPATCH_LAUNCH_OPERATION_STATES),
  sourceLarkAppId: larkAppIdSchema,
  sourceSessionId: nonEmptyString,
  sourceTurnId: nonEmptyString,
  targetLarkAppId: larkAppIdSchema,
  chatId: nonEmptyString,
  kickoff: canonicalKickoffSchema,
  requestedOverride: requestedOverrideSchema,
  effectiveOverride: effectiveOverrideSchema.optional(),
  launchIdentity: launchIdentitySchema.optional(),
  rootMessageId: nonEmptyString.optional(),
  targetSessionId: nonEmptyString.optional(),
  kickoffTurnId: nonEmptyString.optional(),
  workerGeneration: z.number().int().nonnegative().optional(),
  proof: proofSchema.optional(),
  errorCode: z.enum(DISPATCH_LAUNCH_ERROR_CODES).optional(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  expiresAt: timestampSchema,
}).strict();

export const DispatchLaunchAdmissionReceiptSchema = z.object({
  schemaVersion: z.literal(DISPATCH_LAUNCH_ADMISSION_SCHEMA_VERSION),
  dispatchId: dispatchIdSchema,
  state: z.enum(['authorized', 'committed', 'released']),
  sourceLarkAppId: larkAppIdSchema,
  sourceSessionId: nonEmptyString,
  sourceTurnId: nonEmptyString,
  callerOpenId: nonEmptyString.optional(),
  chatId: nonEmptyString,
  targetLarkAppId: larkAppIdSchema,
  policyDigest: digestSchema,
  talkAuthorizationReceiptId: nonEmptyString,
  quotaReceiptId: nonEmptyString,
  workingDir: nonEmptyString,
  capacityReservationId: nonEmptyString,
  createdAt: timestampSchema,
  committedAt: timestampSchema.optional(),
  releasedAt: timestampSchema.optional(),
}).strict();

export const DispatchLaunchOverrideSnapshotSchema = z.object({
  schemaVersion: z.literal(DISPATCH_LAUNCH_OVERRIDE_SCHEMA_VERSION),
  provenanceId: nonEmptyString,
  dispatchId: dispatchIdSchema.optional(),
  inheritedFromDispatchId: dispatchIdSchema.optional(),
  effective: effectiveOverrideSchema,
  launchIdentity: launchIdentitySchema,
  createdAt: timestampSchema,
}).strict().superRefine((value, context) => {
  if ((value.dispatchId === undefined) === (value.inheritedFromDispatchId === undefined)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'exactly one of dispatchId or inheritedFromDispatchId is required',
    });
  }
});

function normalizeLf(value: string): string {
  return value.replace(/\r\n?/g, '\n');
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function requiredText(value: string, field: string, limit: number): string {
  const normalized = normalizeLf(value);
  if (!normalized.trim()) throw new Error(`${field} must not be empty`);
  if (normalized.includes('\0')) throw new Error(`${field} must not contain NUL`);
  if (byteLength(normalized) > limit) throw new Error(`${field} exceeds ${limit} UTF-8 bytes`);
  return normalized;
}

function optionalText(value: string | undefined, field: string, limit: number): string | undefined {
  if (value === undefined) return undefined;
  const normalized = normalizeLf(value);
  if (!normalized.trim()) return undefined;
  if (normalized.includes('\0')) throw new Error(`${field} must not contain NUL`);
  if (byteLength(normalized) > limit) throw new Error(`${field} exceeds ${limit} UTF-8 bytes`);
  return normalized;
}

/** Create a path-safe, globally unique id before any transport side effect. */
export function createDispatchLaunchId(): string {
  return `dl_${randomUUID().replaceAll('-', '')}`;
}

/**
 * Canonicalize protocol-owned semantic input. Lark rendering, mentions and
 * delivery markers deliberately do not participate in this digest.
 */
export function canonicalizeDispatchLaunchKickoff(
  input: Omit<DispatchLaunchKickoffPayloadV1, 'schemaVersion' | 'protocol'>,
): CanonicalDispatchLaunchKickoff {
  const role = optionalText(input.role, 'role', DISPATCH_LAUNCH_KICKOFF_LIMITS.roleBytes);
  const payload: DispatchLaunchKickoffPayloadV1 = {
    schemaVersion: DISPATCH_LAUNCH_SCHEMA_VERSION,
    protocol: DISPATCH_LAUNCH_PROTOCOL,
    title: requiredText(input.title, 'title', DISPATCH_LAUNCH_KICKOFF_LIMITS.titleBytes),
    brief: requiredText(input.brief, 'brief', DISPATCH_LAUNCH_KICKOFF_LIMITS.briefBytes),
    ...(role ? { role } : {}),
    sourceDisplay: requiredText(
      input.sourceDisplay,
      'sourceDisplay',
      DISPATCH_LAUNCH_KICKOFF_LIMITS.sourceDisplayBytes,
    ),
    targetLarkAppId: larkAppIdSchema.parse(input.targetLarkAppId),
  };
  const encoded = canonicalJson(payload);
  const encodedBytes = byteLength(encoded);
  if (encodedBytes > DISPATCH_LAUNCH_KICKOFF_LIMITS.totalBytes) {
    throw new Error(`canonical kickoff exceeds ${DISPATCH_LAUNCH_KICKOFF_LIMITS.totalBytes} UTF-8 bytes`);
  }
  return {
    payload,
    canonicalJson: encoded,
    byteLength: encodedBytes,
    digest: `sha256:${createHash('sha256').update(encoded, 'utf8').digest('hex')}`,
  };
}

export function resolveDispatchLaunchOverride(input: {
  cliId: string;
  requested: DispatchLaunchRequestedOverride;
  targetModel?: string;
  targetReasoningEffort?: CodexReasoningEffort;
}): { ok: true; effective: DispatchLaunchEffectiveOverride } | DispatchLaunchFailure {
  const requestedModel = input.requested.model?.trim();
  if (input.requested.model !== undefined && !requestedModel) {
    return { ok: false, errorCode: 'BAD_REQUEST', message: 'requested model must not be empty' };
  }
  if (!requestedModel && input.requested.reasoningEffort === undefined) {
    return { ok: false, errorCode: 'BAD_REQUEST', message: 'at least one launch override is required' };
  }
  if (input.cliId !== 'codex') {
    return { ok: false, errorCode: 'UNSUPPORTED_HARNESS', message: 'v1 supports only the official Codex TUI' };
  }
  const effectiveModel = requestedModel ?? input.targetModel?.trim();
  if (!effectiveModel) {
    return {
      ok: false,
      errorCode: 'MODEL_REQUIRED_FOR_OVERRIDE',
      message: 'a concrete effective model is required for any launch override',
    };
  }
  const effectiveEffort = input.requested.reasoningEffort ?? input.targetReasoningEffort;
  if (effectiveEffort !== undefined
      && !cliModelSupportsReasoningEffort(input.cliId, effectiveModel, effectiveEffort)) {
    return {
      ok: false,
      errorCode: 'INVALID_MODEL_EFFORT_COMBINATION',
      message: `reasoning effort ${effectiveEffort} is not supported by ${effectiveModel}`,
    };
  }
  return {
    ok: true,
    effective: {
      model: effectiveModel,
      ...(effectiveEffort !== undefined ? { reasoningEffort: effectiveEffort } : {}),
    },
  };
}

function normalizedUnique(values: readonly string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))].sort();
}

export function normalizeDispatchLaunchPolicy(raw: unknown): DispatchLaunchPolicyV1 {
  const parsed = DispatchLaunchPolicySchema.parse(raw);
  return {
    ...parsed,
    allowedSourceAppIds: normalizedUnique(parsed.allowedSourceAppIds),
    allowedModels: normalizedUnique(parsed.allowedModels),
    allowedReasoningEfforts: [...new Set(parsed.allowedReasoningEfforts)].sort() as CodexReasoningEffort[],
  };
}

export function dispatchLaunchPolicyDigest(policy: DispatchLaunchPolicyV1): string {
  const normalized = normalizeDispatchLaunchPolicy(policy);
  return `sha256:${createHash('sha256').update(canonicalJson(normalized), 'utf8').digest('hex')}`;
}

export function dispatchLaunchIdentityDigest(identity: DispatchLaunchIdentityV1): string {
  const parsed = launchIdentitySchema.parse(identity);
  return `sha256:${createHash('sha256').update(canonicalJson(parsed), 'utf8').digest('hex')}`;
}

/** Missing, disabled and non-matching target policy all fail closed. */
export function evaluateDispatchLaunchPolicy(input: {
  policy?: DispatchLaunchPolicyV1;
  sourceLarkAppId: string;
  effective: DispatchLaunchEffectiveOverride;
}): { ok: true; policyDigest: string } | DispatchLaunchFailure {
  if (input.policy === undefined) {
    return { ok: false, errorCode: 'POLICY_DENIED', message: 'target has no dispatch launch policy' };
  }
  const policy = normalizeDispatchLaunchPolicy(input.policy);
  if (!policy.enabled) {
    return { ok: false, errorCode: 'POLICY_DENIED', message: 'dispatch launch is disabled by target policy' };
  }
  if (!policy.allowedSourceAppIds.includes(input.sourceLarkAppId)) {
    return { ok: false, errorCode: 'UNAUTHORIZED_SOURCE', message: 'source app is not allowed by target policy' };
  }
  if (!policy.allowedModels.includes(input.effective.model)) {
    return { ok: false, errorCode: 'MODEL_UNSUPPORTED', message: 'effective model is not allowed by target policy' };
  }
  if (input.effective.reasoningEffort !== undefined
      && !policy.allowedReasoningEfforts.includes(input.effective.reasoningEffort)) {
    return {
      ok: false,
      errorCode: 'REASONING_EFFORT_UNSUPPORTED',
      message: 'effective reasoning effort is not allowed by target policy',
    };
  }
  return { ok: true, policyDigest: dispatchLaunchPolicyDigest(policy) };
}

function parsedOrThrow<T>(schema: z.ZodType<T>, raw: unknown, label: string): T {
  const result = schema.safeParse(raw);
  if (!result.success) throw new Error(`invalid ${label}: ${result.error.issues.map(issue => issue.message).join('; ')}`);
  return result.data;
}

export function parseDispatchLaunchOperation(raw: unknown): DispatchLaunchOperationV1 {
  const parsed = parsedOrThrow(DispatchLaunchOperationSchema, raw, 'dispatch launch operation');
  const recomputed = canonicalizeDispatchLaunchKickoff({
    title: parsed.kickoff.payload.title,
    brief: parsed.kickoff.payload.brief,
    role: parsed.kickoff.payload.role,
    sourceDisplay: parsed.kickoff.payload.sourceDisplay,
    targetLarkAppId: parsed.kickoff.payload.targetLarkAppId,
  });
  if (recomputed.canonicalJson !== parsed.kickoff.canonicalJson
      || recomputed.byteLength !== parsed.kickoff.byteLength
      || recomputed.digest !== parsed.kickoff.digest) {
    throw new Error('invalid dispatch launch operation: kickoff canonicalization mismatch');
  }
  if (Date.parse(parsed.updatedAt) < Date.parse(parsed.createdAt)) {
    throw new Error('invalid dispatch launch operation: updatedAt precedes createdAt');
  }
  if (Date.parse(parsed.expiresAt) <= Date.parse(parsed.createdAt)) {
    throw new Error('invalid dispatch launch operation: expiresAt must follow createdAt');
  }
  if (parsed.state === 'succeeded' && parsed.proof === undefined) {
    throw new Error('invalid dispatch launch operation: succeeded operation requires turn-bound proof');
  }
  if (parsed.state === 'succeeded') {
    const fact = parsed.proof!.inputCommitted;
    if (parsed.targetSessionId === undefined
        || parsed.kickoffTurnId === undefined
        || parsed.workerGeneration === undefined
        || parsed.effectiveOverride === undefined) {
      throw new Error('invalid dispatch launch operation: succeeded operation requires launch identity fields');
    }
    if (fact.sessionId !== parsed.targetSessionId
        || fact.kickoffTurnId !== parsed.kickoffTurnId
        || fact.workerGeneration !== parsed.workerGeneration) {
      throw new Error('invalid dispatch launch operation: proof does not match operation launch identity');
    }
  }
  if ((parsed.state === 'failed' || parsed.state === 'delivery_unknown') && parsed.errorCode === undefined) {
    throw new Error('invalid dispatch launch operation: failed operation requires an error code');
  }
  return parsed;
}

export function parseDispatchLaunchPrepareRequest(raw: unknown): DispatchLaunchPrepareRequestV1 {
  const parsed = parsedOrThrow(DispatchLaunchPrepareRequestSchema, raw, 'dispatch launch prepare request');
  const recomputed = canonicalizeDispatchLaunchKickoff({
    title: parsed.kickoff.payload.title,
    brief: parsed.kickoff.payload.brief,
    role: parsed.kickoff.payload.role,
    sourceDisplay: parsed.kickoff.payload.sourceDisplay,
    targetLarkAppId: parsed.kickoff.payload.targetLarkAppId,
  });
  if (recomputed.digest !== parsed.kickoff.digest
      || recomputed.canonicalJson !== parsed.kickoff.canonicalJson
      || recomputed.byteLength !== parsed.kickoff.byteLength) {
    throw new Error('invalid dispatch launch prepare request: kickoff canonicalization mismatch');
  }
  if (parsed.targetLarkAppId !== parsed.kickoff.payload.targetLarkAppId) {
    throw new Error('invalid dispatch launch prepare request: target identity mismatch');
  }
  return parsed;
}

export function parseDispatchLaunchStartRequest(raw: unknown): DispatchLaunchStartRequestV1 {
  return parsedOrThrow(DispatchLaunchStartRequestSchema, raw, 'dispatch launch start request');
}

export function parseDispatchLaunchCancelRequest(raw: unknown): DispatchLaunchCancelRequestV1 {
  return parsedOrThrow(DispatchLaunchCancelRequestSchema, raw, 'dispatch launch cancel request');
}

export function parseDispatchLaunchAdmissionReceipt(raw: unknown): DispatchLaunchAdmissionReceiptV1 {
  const parsed = parsedOrThrow(DispatchLaunchAdmissionReceiptSchema, raw, 'dispatch launch admission receipt');
  if (parsed.state === 'authorized' && (parsed.committedAt !== undefined || parsed.releasedAt !== undefined)) {
    throw new Error('invalid dispatch launch admission receipt: authorized receipt must be unsettled');
  }
  if (parsed.state === 'committed' && parsed.committedAt === undefined) {
    throw new Error('invalid dispatch launch admission receipt: committedAt is required');
  }
  if (parsed.state === 'released' && parsed.releasedAt === undefined) {
    throw new Error('invalid dispatch launch admission receipt: releasedAt is required');
  }
  return parsed;
}

export function parseDispatchLaunchOverrideSnapshot(raw: unknown): DispatchLaunchOverrideSnapshotV1 {
  return parsedOrThrow(
    DispatchLaunchOverrideSnapshotSchema,
    raw,
    'dispatch launch override snapshot',
  );
}
