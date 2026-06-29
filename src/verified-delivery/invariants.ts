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
  'TaskDispatched',
  'TaskReported',
  'TaskAccepted',
  'TaskRejected',
  'TaskHelpRequested',
  'TaskEscalated',
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
  if (draft.type !== 'TaskReported' && draft.type !== 'TaskHelpRequested' && draft.actor !== 'orchestrator') {
    warnings.push(`${draft.type} is usually written by actor=orchestrator`);
  }

  switch (draft.type) {
    case 'TaskDispatched':
      validateWorkerArrays(payload, errors);
      validateAcceptanceCriteriaShape(payload.acceptanceCriteria, 'acceptanceCriteria', errors);
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
  }

  return { errors, warnings };
}
