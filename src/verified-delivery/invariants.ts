import { parseAcceptanceCriteria } from './acceptance.js';
import {
  REJECT_REASON,
  type Evidence,
  type HelpKind,
  type LedgerActor,
  type LedgerEventDraft,
  type LedgerEventType,
} from './types.js';

export interface LedgerInvariantResult {
  errors: string[];
  warnings: string[];
}

const EVENT_TYPES = new Set<LedgerEventType>([
  'TaskPlanned',
  'TaskDispatchIntent',
  'TaskDispatchFailed',
  'TaskDispatched',
  'TaskReported',
  'TaskAccepted',
  'TaskRejected',
  'TaskHelpRequested',
  'TaskEscalated',
  'TaskCancelled',
]);
const ACTORS = new Set<LedgerActor>(['orchestrator', 'worker']);
const HELP_KINDS = new Set<HelpKind>(['access', 'ambiguous', 'impossible', 'repeated_failure', 'other']);
const REJECT_REASONS = new Set<string>(Object.values(REJECT_REASON));

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function validateStringArray(value: unknown, field: string, errors: string[], opts: { allowEmptyItems?: boolean } = {}): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    errors.push(`${field} must be an array`);
    return undefined;
  }
  for (const [idx, item] of value.entries()) {
    if (typeof item !== 'string' || (!opts.allowEmptyItems && item.trim().length === 0)) {
      errors.push(`${field}[${idx}] must be a${opts.allowEmptyItems ? '' : ' non-empty'} string`);
    }
  }
  return value as string[];
}

function validateEvidenceItem(raw: unknown, field: string, errors: string[]): void {
  if (!isObject(raw)) {
    errors.push(`${field} must be an object`);
    return;
  }
  const evidence = raw as Evidence;
  if (evidence.kind === 'path') {
    if (!nonEmpty(evidence.path)) errors.push(`${field}.path must be non-empty`);
    return;
  }
  if (evidence.kind === 'inline') {
    if (!nonEmpty(evidence.ref)) errors.push(`${field}.ref must be non-empty`);
    if (typeof evidence.bytes !== 'number' || !Number.isFinite(evidence.bytes) || evidence.bytes < 0) {
      errors.push(`${field}.bytes must be a finite non-negative number`);
    }
    return;
  }
  if (evidence.kind === 'url') {
    if (!nonEmpty(evidence.url)) {
      errors.push(`${field}.url must be non-empty`);
      return;
    }
    try {
      const u = new URL(evidence.url);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') {
        errors.push(`${field}.url must use http or https`);
      }
    } catch {
      errors.push(`${field}.url must be a valid URL`);
    }
    return;
  }
  errors.push(`${field}.kind is unknown`);
}

function validateAcceptanceCriteriaShape(value: unknown, field: string, errors: string[]): void {
  if (value === undefined) return;
  const serialized = JSON.stringify(value);
  if (!serialized) {
    errors.push(`${field} must be JSON-serializable`);
    return;
  }
  const parsed = parseAcceptanceCriteria(serialized);
  if (parsed.error || !parsed.criteria) {
    errors.push(`${field} invalid: ${parsed.error ?? 'missing criteria'}`);
  }
}

function validateWorkerArrays(payload: Record<string, unknown>, errors: string[]): void {
  const workerOpenIds = validateStringArray(payload.workerOpenIds, 'workerOpenIds', errors);
  const alignedFields = ['workerNames', 'workerLarkAppIds', 'workerCliIds', 'workerBotUnionIds'] as const;
  for (const field of alignedFields) {
    const arr = validateStringArray(payload[field], field, errors, { allowEmptyItems: true });
    if (arr === undefined) continue;
    if (!workerOpenIds) {
      errors.push(`${field} requires workerOpenIds`);
    } else if (arr.length !== workerOpenIds.length) {
      errors.push(`${field} must be index-aligned with workerOpenIds`);
    }
  }
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function validateDispatchWorkerSpecs(value: unknown, field: string, errors: string[]): void {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push(`${field} must be a non-empty array`);
    return;
  }
  value.forEach((raw, index) => {
    const itemField = `${field}[${index}]`;
    if (!isObject(raw)) {
      errors.push(`${itemField} must be an object`);
      return;
    }
    if (!nonEmpty(raw.openId)) errors.push(`${itemField}.openId must be non-empty`);
    for (const optional of ['name', 'role', 'larkAppId', 'cliId', 'unionId'] as const) {
      if (raw[optional] !== undefined && !nonEmpty(raw[optional])) {
        errors.push(`${itemField}.${optional} must be non-empty when provided`);
      }
    }
  });
}

function validateSatisfiedBy(value: unknown, field: string, errors: string[]): void {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push(`${field} must be a non-empty array`);
    return;
  }
  const taskIds = new Set<string>();
  value.forEach((raw, index) => {
    const itemField = `${field}[${index}]`;
    if (!isObject(raw)) {
      errors.push(`${itemField} must be an object`);
      return;
    }
    if (!nonEmpty(raw.taskId)) errors.push(`${itemField}.taskId must be non-empty`);
    else if (taskIds.has(raw.taskId)) errors.push(`${field} must not contain duplicate taskIds`);
    else taskIds.add(raw.taskId);
    if (!nonEmpty(raw.acceptedEventId)) errors.push(`${itemField}.acceptedEventId must be non-empty`);
  });
}

function validateReleaseCoordinates(payload: Record<string, unknown>, field: string, errors: string[]): void {
  if (!nonEmpty(payload.releaseId)) errors.push(`${field}.releaseId must be non-empty`);
  else if (payload.releaseId.length > 50) errors.push(`${field}.releaseId must be at most 50 characters`);
  if (!nonEmpty(payload.planEventId)) errors.push(`${field}.planEventId must be non-empty`);
  if (!positiveInteger(payload.planGeneration)) errors.push(`${field}.planGeneration must be a positive integer`);
  if (!nonNegativeInteger(payload.attempt)) errors.push(`${field}.attempt must be a non-negative integer`);
}

/** Validate stateless ledger invariants before an event crosses the append seam.
 *  Warnings are intentionally non-blocking: they record P3b candidates that need
 *  compatibility/audit work before we can safely upgrade them to hard rejects. */
export function validateLedgerEventDraft(draft: LedgerEventDraft): LedgerInvariantResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!EVENT_TYPES.has(draft.type)) errors.push(`unknown event type: ${String(draft.type)}`);
  if (!ACTORS.has(draft.actor)) errors.push(`unknown actor: ${String(draft.actor)}`);
  if (!nonEmpty(draft.taskId)) errors.push('taskId must be non-empty');
  if (!nonEmpty(draft.idempotencyKey)) errors.push('idempotencyKey must be non-empty');
  if (typeof draft.ts !== 'number' || !Number.isFinite(draft.ts)) errors.push('ts must be a finite number');
  if (!isObject(draft.payload)) {
    errors.push('payload must be an object');
    return { errors, warnings };
  }

  const payload = draft.payload as Record<string, unknown>;
  if (!nonEmpty(payload.taskId)) errors.push('payload.taskId must be non-empty');
  if (nonEmpty(draft.taskId) && nonEmpty(payload.taskId) && payload.taskId !== draft.taskId) {
    errors.push('payload.taskId must match top-level taskId');
  }

  if ((draft.type === 'TaskReported' || draft.type === 'TaskHelpRequested') && draft.actor !== 'worker') {
    warnings.push(`${draft.type} is usually written by actor=worker`);
  }
  if (
    (draft.type === 'TaskPlanned' || draft.type === 'TaskDispatchIntent' || draft.type === 'TaskDispatchFailed') &&
    draft.actor !== 'orchestrator'
  ) {
    errors.push(`${draft.type} requires actor=orchestrator`);
  }
  if (draft.type !== 'TaskReported' && draft.type !== 'TaskHelpRequested' && draft.actor !== 'orchestrator') {
    warnings.push(`${draft.type} is usually written by actor=orchestrator`);
  }

  switch (draft.type) {
    case 'TaskPlanned': {
      if (!nonEmpty(draft.chatId)) errors.push('TaskPlanned top-level chatId must be non-empty');
      if (!nonEmpty(payload.chatId)) errors.push('TaskPlanned.chatId must be non-empty');
      if (draft.chatId !== undefined && nonEmpty(payload.chatId) && draft.chatId !== payload.chatId) {
        errors.push('TaskPlanned.chatId must match top-level chatId');
      }
      if (!nonEmpty(payload.title)) errors.push('TaskPlanned.title must be non-empty');
      const dependencies = validateStringArray(payload.dependsOnTaskIds, 'TaskPlanned.dependsOnTaskIds', errors);
      if (dependencies && dependencies.length === 0) errors.push('TaskPlanned.dependsOnTaskIds must be non-empty');
      if (dependencies && new Set(dependencies).size !== dependencies.length) {
        errors.push('TaskPlanned.dependsOnTaskIds must not contain duplicates');
      }
      if (dependencies?.includes(draft.taskId)) errors.push('TaskPlanned cannot depend on itself');
      if (!positiveInteger(payload.planGeneration)) errors.push('TaskPlanned.planGeneration must be a positive integer');
      if (payload.planGeneration === 1 && payload.reopenOfCancelEventId !== undefined) {
        errors.push('TaskPlanned.reopenOfCancelEventId is only valid for generation 2+');
      }
      if (typeof payload.planGeneration === 'number' && payload.planGeneration >= 2 && !nonEmpty(payload.reopenOfCancelEventId)) {
        errors.push('TaskPlanned.reopenOfCancelEventId is required for generation 2+');
      }
      if (!nonEmpty(payload.plannedBy)) errors.push('TaskPlanned.plannedBy must be non-empty');
      if (!isObject(payload.dispatchSpec)) {
        errors.push('TaskPlanned.dispatchSpec must be an object');
        break;
      }
      const spec = payload.dispatchSpec;
      if (!nonEmpty(spec.title)) errors.push('TaskPlanned.dispatchSpec.title must be non-empty');
      if (nonEmpty(payload.title) && nonEmpty(spec.title) && payload.title !== spec.title) {
        errors.push('TaskPlanned.dispatchSpec.title must match title');
      }
      if (!nonEmpty(spec.briefBase)) errors.push('TaskPlanned.dispatchSpec.briefBase must be non-empty');
      if (!nonEmpty(spec.senderLarkAppId)) errors.push('TaskPlanned.dispatchSpec.senderLarkAppId must be non-empty');
      if (spec.requiredRepo !== undefined && !nonEmpty(spec.requiredRepo)) {
        errors.push('TaskPlanned.dispatchSpec.requiredRepo must be non-empty when provided');
      }
      if (spec.acceptanceHint !== undefined && !nonEmpty(spec.acceptanceHint)) {
        errors.push('TaskPlanned.dispatchSpec.acceptanceHint must be non-empty when provided');
      }
      validateDispatchWorkerSpecs(spec.workers, 'TaskPlanned.dispatchSpec.workers', errors);
      validateAcceptanceCriteriaShape(spec.acceptanceCriteria, 'TaskPlanned.dispatchSpec.acceptanceCriteria', errors);
      const expectedKey = payload.planGeneration === 1
        ? `planned:${draft.taskId}`
        : `planned:${draft.taskId}:${String(payload.reopenOfCancelEventId)}`;
      if (draft.idempotencyKey !== expectedKey) errors.push(`TaskPlanned.idempotencyKey must be ${expectedKey}`);
      break;
    }
    case 'TaskDispatchIntent': {
      if (!nonEmpty(draft.chatId)) errors.push('TaskDispatchIntent top-level chatId must be non-empty');
      validateReleaseCoordinates(payload, 'TaskDispatchIntent', errors);
      validateSatisfiedBy(payload.satisfiedBy, 'TaskDispatchIntent.satisfiedBy', errors);
      if (!nonEmpty(payload.senderLarkAppId)) errors.push('TaskDispatchIntent.senderLarkAppId must be non-empty');
      if (!nonEmpty(payload.goalChatId)) errors.push('TaskDispatchIntent.goalChatId must be non-empty');
      if (draft.chatId !== undefined && nonEmpty(payload.goalChatId) && draft.chatId !== payload.goalChatId) {
        errors.push('TaskDispatchIntent.goalChatId must match top-level chatId');
      }
      if (!nonEmpty(payload.frozenKickoffText)) errors.push('TaskDispatchIntent.frozenKickoffText must be non-empty');
      if (!nonEmpty(payload.releasedBy)) errors.push('TaskDispatchIntent.releasedBy must be non-empty');
      if (nonEmpty(payload.releaseId) && draft.idempotencyKey !== `intent:${payload.releaseId}`) {
        errors.push(`TaskDispatchIntent.idempotencyKey must be intent:${payload.releaseId}`);
      }
      validateDispatchWorkerSpecs(payload.frozenWorkerSpecs, 'TaskDispatchIntent.frozenWorkerSpecs', errors);
      if (!isObject(payload.frozenDispatchedPayload)) {
        errors.push('TaskDispatchIntent.frozenDispatchedPayload must be an object');
      } else {
        if (payload.frozenDispatchedPayload.taskId !== draft.taskId) {
          errors.push('TaskDispatchIntent.frozenDispatchedPayload.taskId must match top-level taskId');
        }
        if (payload.frozenDispatchedPayload.releaseId !== payload.releaseId) {
          errors.push('TaskDispatchIntent.frozenDispatchedPayload.releaseId must match releaseId');
        }
        if (payload.frozenDispatchedPayload.dispatchMessageId !== undefined) {
          errors.push('TaskDispatchIntent.frozenDispatchedPayload.dispatchMessageId must be absent before send');
        }
        if (payload.frozenDispatchedPayload.confirmedBy !== undefined) {
          errors.push('TaskDispatchIntent.frozenDispatchedPayload.confirmedBy must be absent before send');
        }
        if (payload.frozenDispatchedPayload.workerTopicRoot !== undefined) {
          errors.push('TaskDispatchIntent.frozenDispatchedPayload.workerTopicRoot must be absent for chat-scope release');
        }
        if (!nonEmpty(payload.frozenDispatchedPayload.title)) {
          errors.push('TaskDispatchIntent.frozenDispatchedPayload.title must be non-empty');
        }
        if (!nonEmpty(payload.frozenDispatchedPayload.brief)) {
          errors.push('TaskDispatchIntent.frozenDispatchedPayload.brief must be non-empty');
        }
        validateWorkerArrays(payload.frozenDispatchedPayload, errors);
        validateAcceptanceCriteriaShape(
          payload.frozenDispatchedPayload.acceptanceCriteria,
          'TaskDispatchIntent.frozenDispatchedPayload.acceptanceCriteria',
          errors,
        );
      }
      break;
    }
    case 'TaskDispatchFailed':
      if (!nonEmpty(draft.chatId)) errors.push('TaskDispatchFailed top-level chatId must be non-empty');
      validateReleaseCoordinates(payload, 'TaskDispatchFailed', errors);
      if (payload.failureClass !== 'definite' && payload.failureClass !== 'ambiguous') {
        errors.push('TaskDispatchFailed.failureClass must be definite or ambiguous');
      }
      if (!nonEmpty(payload.code)) errors.push('TaskDispatchFailed.code must be non-empty');
      if (!nonEmpty(payload.detail)) errors.push('TaskDispatchFailed.detail must be non-empty');
      if (!nonEmpty(payload.failedBy)) errors.push('TaskDispatchFailed.failedBy must be non-empty');
      if (
        nonEmpty(payload.releaseId) &&
        (payload.failureClass === 'definite' || payload.failureClass === 'ambiguous') &&
        draft.idempotencyKey !== `dispatch-failed:${payload.releaseId}:${payload.failureClass}`
      ) {
        errors.push(`TaskDispatchFailed.idempotencyKey must be dispatch-failed:${payload.releaseId}:${payload.failureClass}`);
      }
      break;
    case 'TaskDispatched':
      validateWorkerArrays(payload, errors);
      if (payload.requiredRepo !== undefined && !nonEmpty(payload.requiredRepo)) {
        errors.push('requiredRepo must be non-empty when provided');
      }
      validateAcceptanceCriteriaShape(payload.acceptanceCriteria, 'acceptanceCriteria', errors);
      if (payload.releaseId !== undefined && !nonEmpty(payload.releaseId)) {
        errors.push('TaskDispatched.releaseId must be non-empty when provided');
      }
      if (nonEmpty(payload.releaseId) && payload.releaseId.length > 50) {
        errors.push('TaskDispatched.releaseId must be at most 50 characters');
      }
      if (payload.dispatchMessageId !== undefined && !nonEmpty(payload.dispatchMessageId)) {
        errors.push('TaskDispatched.dispatchMessageId must be non-empty when provided');
      }
      if (payload.confirmedBy !== undefined && !nonEmpty(payload.confirmedBy)) {
        errors.push('TaskDispatched.confirmedBy must be non-empty when provided');
      }
      if (payload.releaseId !== undefined && payload.dispatchMessageId === undefined && payload.confirmedBy === undefined) {
        errors.push('TaskDispatched release requires dispatchMessageId or confirmedBy');
      }
      if (nonEmpty(payload.releaseId) && draft.idempotencyKey !== `dispatched:release:${payload.releaseId}`) {
        errors.push(`TaskDispatched.idempotencyKey must be dispatched:release:${payload.releaseId}`);
      }
      break;
    case 'TaskReported': {
      if (!nonEmpty(payload.reportId)) errors.push('TaskReported.reportId must be non-empty');
      if (!nonEmpty(payload.summary)) errors.push('TaskReported.summary must be non-empty');
      if (!Array.isArray(payload.evidence) || payload.evidence.length === 0) {
        errors.push('TaskReported requires at least one evidence item');
      } else {
        payload.evidence.forEach((item, idx) => validateEvidenceItem(item, `TaskReported.evidence[${idx}]`, errors));
      }
      break;
    }
    case 'TaskAccepted':
      if (!nonEmpty(payload.reportId)) errors.push('TaskAccepted.reportId must be non-empty');
      if (!nonEmpty(payload.checkedBy)) warnings.push('TaskAccepted.checkedBy is recommended');
      if (!Array.isArray(payload.evidenceChecked) && !Array.isArray(payload.ranCommands)) {
        warnings.push('TaskAccepted should record evidenceChecked or ranCommands');
      }
      break;
    case 'TaskRejected':
      if (!nonEmpty(payload.reportId)) errors.push('TaskRejected.reportId must be non-empty');
      if (!nonEmpty(payload.reason)) errors.push('TaskRejected.reason must be non-empty');
      else if (!REJECT_REASONS.has(payload.reason)) warnings.push('TaskRejected.reason should use REJECT_REASON');
      break;
    case 'TaskHelpRequested':
      if (!nonEmpty(payload.blocker)) errors.push('TaskHelpRequested.blocker must be non-empty');
      if (payload.kind !== undefined && (typeof payload.kind !== 'string' || !HELP_KINDS.has(payload.kind as HelpKind))) {
        errors.push('TaskHelpRequested.kind is invalid');
      }
      break;
    case 'TaskEscalated':
      if (!nonEmpty(payload.reason)) errors.push('TaskEscalated.reason must be non-empty');
      break;
    case 'TaskCancelled':
      if (!nonEmpty(payload.reason)) errors.push('TaskCancelled.reason must be non-empty');
      break;
  }

  return { errors, warnings };
}
