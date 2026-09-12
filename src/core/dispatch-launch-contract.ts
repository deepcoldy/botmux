import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';

import { canonicalJson } from '../utils/canonical-input-hash.js';
import {
  CODEX_REASONING_EFFORTS,
  cliModelSupportsReasoningEffort,
  type CodexReasoningEffort,
} from '../services/codex-reasoning-effort.js';

/** Versioned contract for the internal target-daemon-authoritative dispatch launch path. */
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

export const DISPATCH_LAUNCH_CONTROL_LIMITS = {
  larkAppIdChars: 256,
  identifierChars: 512,
  callerUnionIdChars: 256,
  modelChars: 512,
  executableChars: 4096,
  wrapperChars: 4096,
  workingDirChars: 16 * 1024,
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
  byteLength: number;
  digest: string;
}

export interface DispatchLaunchPolicyV1 {
  schemaVersion: typeof DISPATCH_LAUNCH_POLICY_SCHEMA_VERSION;
  enabled: boolean;
  /**
   * Same-host source daemons trusted to request launches and attest the optional
   * human caller union_id. The target accepts that testimony only through the
   * authenticated dispatch-launch IPC transport; it is not a bot-trust claim.
   */
  allowedSourceAppIds: string[];
  allowedModels: string[];
  allowedReasoningEfforts: CodexReasoningEffort[];
}

export interface DispatchLaunchIdentityV1 {
  cliId: 'codex';
  cliRuntimeDigest: string;
  executable: string;
  wrapperCli?: string;
  backendType: 'pty' | 'tmux' | 'herdr' | 'zellij' | 'zmx';
  codexRpcInput: false;
  existingAppServer: false;
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
    /**
     * Source-daemon testimony about the human behind this bot-triggered turn.
     * The target may accept it only after same-host IPC authentication and an
     * allowedSourceAppIds policy match. It MUST NOT be used as the source bot's
     * union_id for bot-talk/team trust; source-app open_id is not transported.
     */
    callerUnionId?: string;
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

interface DispatchLaunchOperationBaseV1 {
  schemaVersion: typeof DISPATCH_LAUNCH_OPERATION_SCHEMA_VERSION;
  dispatchId: string;
  owner: 'source' | 'target';
  sourceLarkAppId: string;
  sourceSessionId: string;
  sourceTurnId: string;
  /** Frozen source testimony; never a target-verified bot identity. */
  callerUnionId?: string;
  targetLarkAppId: string;
  chatId: string;
  kickoff: CanonicalDispatchLaunchKickoff;
  requestedOverride: DispatchLaunchRequestedOverride;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}

type DispatchLaunchPreAdmissionOperationV1 = DispatchLaunchOperationBaseV1 & {
  state: 'created' | 'preparing';
};

type DispatchLaunchPreparedOperationV1 = DispatchLaunchOperationBaseV1 & {
  state: 'prepared';
  effectiveOverride: DispatchLaunchEffectiveOverride;
  launchIdentity: DispatchLaunchIdentityV1;
};

type DispatchLaunchStartingOperationV1 = DispatchLaunchOperationBaseV1 & {
  state: 'starting';
  effectiveOverride: DispatchLaunchEffectiveOverride;
  launchIdentity: DispatchLaunchIdentityV1;
  rootMessageId?: string;
  targetSessionId?: string;
  kickoffTurnId?: string;
  workerGeneration?: number;
};

type DispatchLaunchLaunchedOperationV1 = DispatchLaunchOperationBaseV1 & {
  effectiveOverride: DispatchLaunchEffectiveOverride;
  launchIdentity: DispatchLaunchIdentityV1;
  rootMessageId: string;
  targetSessionId: string;
  kickoffTurnId: string;
  workerGeneration: number;
};

type DispatchLaunchAwaitingProofOperationV1 = DispatchLaunchLaunchedOperationV1 & {
  state: 'awaiting_proof';
};

type DispatchLaunchSucceededOperationV1 = DispatchLaunchLaunchedOperationV1 & {
  state: 'succeeded';
  proof: DispatchLaunchProofV1;
};

type DispatchLaunchUnsuccessfulOperationV1 = DispatchLaunchOperationBaseV1 & {
  state: 'failed' | 'cancelled' | 'delivery_unknown';
  errorCode: DispatchLaunchErrorCode;
  effectiveOverride?: DispatchLaunchEffectiveOverride;
  launchIdentity?: DispatchLaunchIdentityV1;
  rootMessageId?: string;
  targetSessionId?: string;
  kickoffTurnId?: string;
  workerGeneration?: number;
};

export type DispatchLaunchOperationV1 =
  | DispatchLaunchPreAdmissionOperationV1
  | DispatchLaunchPreparedOperationV1
  | DispatchLaunchStartingOperationV1
  | DispatchLaunchAwaitingProofOperationV1
  | DispatchLaunchSucceededOperationV1
  | DispatchLaunchUnsuccessfulOperationV1;

export interface DispatchLaunchAdmissionReceiptV1 {
  schemaVersion: typeof DISPATCH_LAUNCH_ADMISSION_SCHEMA_VERSION;
  dispatchId: string;
  state: 'authorized' | 'committed' | 'released';
  sourceLarkAppId: string;
  sourceSessionId: string;
  sourceTurnId: string;
  /** Frozen source testimony accepted through the allowed source app trust anchor. */
  callerUnionId?: string;
  /** Target-app-scoped identity resolved from live chat membership. */
  sourceOpenId?: string;
  chatType?: 'group' | 'p2p';
  /** Frozen authorization facts; optional for receipts written by older builds. */
  talkReason?: string;
  quotaKey?: string;
  grantChatId?: string;
  chatId: string;
  targetLarkAppId: string;
  policyDigest: string;
  effectiveOverride?: DispatchLaunchEffectiveOverride;
  launchIdentity?: DispatchLaunchIdentityV1;
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
const identifierSchema = nonEmptyString
  .max(DISPATCH_LAUNCH_CONTROL_LIMITS.identifierChars)
  .regex(/^[A-Za-z0-9_.:-]+$/, 'must be a protocol-safe identifier');
const controlledString = (max: number) => nonEmptyString.max(max)
  .refine(value => !/[\u0000-\u001f\u007f]/.test(value), 'must not contain control characters');
const larkAppIdSchema = nonEmptyString
  .max(DISPATCH_LAUNCH_CONTROL_LIMITS.larkAppIdChars)
  .regex(/^cli_[A-Za-z0-9]+$/);
const dispatchIdSchema = z.string().regex(DISPATCH_LAUNCH_ID_RE);
const digestSchema = z.string().regex(DISPATCH_LAUNCH_DIGEST_RE);
const timestampSchema = z.string().datetime({ offset: true });
const reasoningEffortSchema = z.enum(CODEX_REASONING_EFFORTS);
const modelSchema = controlledString(DISPATCH_LAUNCH_CONTROL_LIMITS.modelChars);

const requestedOverrideSchema = z.object({
  model: modelSchema.optional(),
  reasoningEffort: reasoningEffortSchema.optional(),
}).strict().refine(
  value => value.model !== undefined || value.reasoningEffort !== undefined,
  'at least one launch override is required',
);

const effectiveOverrideSchema = z.object({
  model: modelSchema,
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
  byteLength: z.number().int().nonnegative().max(DISPATCH_LAUNCH_KICKOFF_LIMITS.totalBytes),
  digest: digestSchema,
}).strict();

const launchIdentitySchema = z.object({
  cliId: z.literal('codex'),
  cliRuntimeDigest: digestSchema,
  executable: controlledString(DISPATCH_LAUNCH_CONTROL_LIMITS.executableChars),
  wrapperCli: controlledString(DISPATCH_LAUNCH_CONTROL_LIMITS.wrapperChars).optional(),
  backendType: z.enum(['pty', 'tmux', 'herdr', 'zellij', 'zmx']),
  codexRpcInput: z.literal(false),
  existingAppServer: z.literal(false),
  botConfigDigest: digestSchema,
  policyDigest: digestSchema,
}).strict();

const turnFactSchema = z.object({
  sessionId: identifierSchema,
  kickoffTurnId: identifierSchema,
  workerGeneration: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  observedAt: timestampSchema,
}).strict();

const proofSchema = z.object({
  inputCommitted: turnFactSchema,
  runtimeObserved: turnFactSchema.extend({
    model: modelSchema,
    reasoningEffort: reasoningEffortSchema.optional(),
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
    sessionId: identifierSchema,
    turnId: identifierSchema,
    callerUnionId: nonEmptyString
      .max(DISPATCH_LAUNCH_CONTROL_LIMITS.callerUnionIdChars)
      .regex(/^on_[A-Za-z0-9]+$/, 'must be a Lark union_id')
      .optional(),
  }).strict(),
  targetLarkAppId: larkAppIdSchema,
  chatId: identifierSchema,
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

const dispatchLaunchOperationBaseShape = {
  schemaVersion: z.literal(DISPATCH_LAUNCH_OPERATION_SCHEMA_VERSION),
  dispatchId: dispatchIdSchema,
  owner: z.enum(['source', 'target']),
  sourceLarkAppId: larkAppIdSchema,
  sourceSessionId: identifierSchema,
  sourceTurnId: identifierSchema,
  callerUnionId: nonEmptyString
    .max(DISPATCH_LAUNCH_CONTROL_LIMITS.callerUnionIdChars)
    .regex(/^on_[A-Za-z0-9]+$/, 'must be a Lark union_id')
    .optional(),
  targetLarkAppId: larkAppIdSchema,
  chatId: identifierSchema,
  kickoff: canonicalKickoffSchema,
  requestedOverride: requestedOverrideSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  expiresAt: timestampSchema,
} as const;

const dispatchLaunchFieldsShape = {
  effectiveOverride: effectiveOverrideSchema,
  launchIdentity: launchIdentitySchema,
} as const;

const dispatchLaunchRuntimeFieldsShape = {
  rootMessageId: identifierSchema,
  targetSessionId: identifierSchema,
  kickoffTurnId: identifierSchema,
  workerGeneration: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
} as const;

const dispatchLaunchOptionalTerminalFieldsShape = {
  effectiveOverride: effectiveOverrideSchema.optional(),
  launchIdentity: launchIdentitySchema.optional(),
  rootMessageId: identifierSchema.optional(),
  targetSessionId: identifierSchema.optional(),
  kickoffTurnId: identifierSchema.optional(),
  workerGeneration: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
} as const;

const dispatchLaunchCreatedSchema = z.object({
  ...dispatchLaunchOperationBaseShape,
  state: z.literal('created'),
}).strict();

const dispatchLaunchPreparingSchema = z.object({
  ...dispatchLaunchOperationBaseShape,
  state: z.literal('preparing'),
}).strict();

const dispatchLaunchPreparedSchema = z.object({
  ...dispatchLaunchOperationBaseShape,
  state: z.literal('prepared'),
  ...dispatchLaunchFieldsShape,
}).strict();

const dispatchLaunchStartingSchema = z.object({
  ...dispatchLaunchOperationBaseShape,
  state: z.literal('starting'),
  ...dispatchLaunchFieldsShape,
  rootMessageId: identifierSchema.optional(),
  targetSessionId: identifierSchema.optional(),
  kickoffTurnId: identifierSchema.optional(),
  workerGeneration: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
}).strict();

const dispatchLaunchAwaitingProofSchema = z.object({
  ...dispatchLaunchOperationBaseShape,
  state: z.literal('awaiting_proof'),
  ...dispatchLaunchFieldsShape,
  ...dispatchLaunchRuntimeFieldsShape,
}).strict();

const dispatchLaunchSucceededSchema = z.object({
  ...dispatchLaunchOperationBaseShape,
  state: z.literal('succeeded'),
  ...dispatchLaunchFieldsShape,
  ...dispatchLaunchRuntimeFieldsShape,
  proof: proofSchema,
}).strict();

const dispatchLaunchFailedSchema = z.object({
  ...dispatchLaunchOperationBaseShape,
  state: z.literal('failed'),
  errorCode: z.enum(DISPATCH_LAUNCH_ERROR_CODES),
  ...dispatchLaunchOptionalTerminalFieldsShape,
}).strict();

const dispatchLaunchCancelledSchema = z.object({
  ...dispatchLaunchOperationBaseShape,
  state: z.literal('cancelled'),
  errorCode: z.literal('CANCELLED'),
  ...dispatchLaunchOptionalTerminalFieldsShape,
}).strict();

const dispatchLaunchDeliveryUnknownSchema = z.object({
  ...dispatchLaunchOperationBaseShape,
  state: z.literal('delivery_unknown'),
  errorCode: z.literal('DELIVERY_UNKNOWN'),
  ...dispatchLaunchOptionalTerminalFieldsShape,
}).strict();

export const DispatchLaunchOperationSchema = z.discriminatedUnion('state', [
  dispatchLaunchCreatedSchema,
  dispatchLaunchPreparingSchema,
  dispatchLaunchPreparedSchema,
  dispatchLaunchStartingSchema,
  dispatchLaunchAwaitingProofSchema,
  dispatchLaunchSucceededSchema,
  dispatchLaunchFailedSchema,
  dispatchLaunchCancelledSchema,
  dispatchLaunchDeliveryUnknownSchema,
]).superRefine((value, context) => {
  const effectiveOverride = 'effectiveOverride' in value ? value.effectiveOverride : undefined;
  const launchIdentity = 'launchIdentity' in value ? value.launchIdentity : undefined;
  if ((effectiveOverride === undefined) !== (launchIdentity === undefined)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'effectiveOverride and launchIdentity must be present or absent together',
    });
  }
  if ('targetSessionId' in value && value.targetSessionId !== undefined
      && (!('rootMessageId' in value) || value.rootMessageId === undefined)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['rootMessageId'], message: 'rootMessageId is required before targetSessionId' });
  }
  if ('kickoffTurnId' in value && value.kickoffTurnId !== undefined
      && (!('targetSessionId' in value) || value.targetSessionId === undefined)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['targetSessionId'], message: 'targetSessionId is required before kickoffTurnId' });
  }
  if ('workerGeneration' in value && value.workerGeneration !== undefined
      && (!('kickoffTurnId' in value) || value.kickoffTurnId === undefined)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['kickoffTurnId'], message: 'kickoffTurnId is required before workerGeneration' });
  }
  if (value.state === 'failed'
      && (value.errorCode === 'CANCELLED' || value.errorCode === 'DELIVERY_UNKNOWN')) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['errorCode'], message: 'failed has a contradictory terminal error code' });
  }
});

export const DispatchLaunchAdmissionReceiptSchema = z.object({
  schemaVersion: z.literal(DISPATCH_LAUNCH_ADMISSION_SCHEMA_VERSION),
  dispatchId: dispatchIdSchema,
  state: z.enum(['authorized', 'committed', 'released']),
  sourceLarkAppId: larkAppIdSchema,
  sourceSessionId: identifierSchema,
  sourceTurnId: identifierSchema,
  callerUnionId: nonEmptyString
    .max(DISPATCH_LAUNCH_CONTROL_LIMITS.callerUnionIdChars)
    .regex(/^on_[A-Za-z0-9]+$/, 'must be a Lark union_id')
    .optional(),
  sourceOpenId: nonEmptyString.max(DISPATCH_LAUNCH_CONTROL_LIMITS.identifierChars).optional(),
  chatType: z.enum(['group', 'p2p']).optional(),
  talkReason: identifierSchema.optional(),
  quotaKey: controlledString(DISPATCH_LAUNCH_CONTROL_LIMITS.identifierChars).optional(),
  grantChatId: identifierSchema.optional(),
  chatId: identifierSchema,
  targetLarkAppId: larkAppIdSchema,
  policyDigest: digestSchema,
  effectiveOverride: effectiveOverrideSchema.optional(),
  launchIdentity: launchIdentitySchema.optional(),
  talkAuthorizationReceiptId: identifierSchema,
  quotaReceiptId: identifierSchema,
  workingDir: controlledString(DISPATCH_LAUNCH_CONTROL_LIMITS.workingDirChars),
  capacityReservationId: identifierSchema,
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
  if (recomputed.byteLength !== parsed.kickoff.byteLength
      || recomputed.digest !== parsed.kickoff.digest) {
    throw new Error('invalid dispatch launch operation: kickoff canonicalization mismatch');
  }
  if (Date.parse(parsed.updatedAt) < Date.parse(parsed.createdAt)) {
    throw new Error('invalid dispatch launch operation: updatedAt precedes createdAt');
  }
  if (Date.parse(parsed.expiresAt) <= Date.parse(parsed.createdAt)) {
    throw new Error('invalid dispatch launch operation: expiresAt must follow createdAt');
  }
  if (parsed.state === 'succeeded') {
    const fact = parsed.proof!.inputCommitted;
    if (fact.sessionId !== parsed.targetSessionId
        || fact.kickoffTurnId !== parsed.kickoffTurnId
        || fact.workerGeneration !== parsed.workerGeneration) {
      throw new Error('invalid dispatch launch operation: proof does not match operation launch identity');
    }
    if (!dispatchLaunchTupleEquivalent(parsed.proof!.runtimeObserved, parsed.effectiveOverride!)) {
      throw new Error('invalid dispatch launch operation: runtime proof does not match effective override');
    }
  }
  const effectiveOverride = 'effectiveOverride' in parsed ? parsed.effectiveOverride : undefined;
  if (effectiveOverride !== undefined
      && !dispatchLaunchRequestedOverrideSatisfied(parsed.requestedOverride, effectiveOverride)) {
    throw new Error('invalid dispatch launch operation: effective override does not satisfy requested override');
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
  if (parsed.state === 'committed' && parsed.releasedAt !== undefined) {
    throw new Error('invalid dispatch launch admission receipt: committed receipt must not be released');
  }
  if (parsed.state === 'released' && parsed.releasedAt === undefined) {
    throw new Error('invalid dispatch launch admission receipt: releasedAt is required');
  }
  if (parsed.state === 'released' && parsed.committedAt !== undefined) {
    throw new Error('invalid dispatch launch admission receipt: released receipt must not be committed');
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

/**
 * v1 recognizes no model aliases: equivalence is deliberately exact after
 * trimming. An adapter may add an explicit canonical alias table in PR 3.
 */
export function dispatchLaunchTupleEquivalent(
  observed: { model: string; reasoningEffort?: CodexReasoningEffort },
  effective: DispatchLaunchEffectiveOverride,
): boolean {
  if (observed.model.trim() !== effective.model.trim()) return false;
  return observed.reasoningEffort === effective.reasoningEffort;
}

export function dispatchLaunchRequestedOverrideSatisfied(
  requested: DispatchLaunchRequestedOverride,
  effective: DispatchLaunchEffectiveOverride,
): boolean {
  if (requested.model !== undefined && requested.model.trim() !== effective.model.trim()) return false;
  if (requested.reasoningEffort !== undefined
      && requested.reasoningEffort !== effective.reasoningEffort) return false;
  return true;
}
