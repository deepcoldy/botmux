import { logger } from '../../utils/logger.js';
import { type Locale } from '../../i18n/index.js';
import { loadFrozenCards, saveFrozenCards } from '../../services/frozen-card-store.js';
import { EventLog } from '../../workflows/events/append.js';
import { replay } from '../../workflows/events/replay.js';
import type { WorkflowEvent } from '../../workflows/events/schema.js';
import type { WaitCreatedEvent } from '../../workflows/events/types.js';
import { getRunsDir } from '../../workflows/runs-dir.js';
import { readWorkflowDefinitionFromRunDir } from '../../workflows/loader.js';
import { join } from 'node:path';
import {
  resolveWait,
  type ResolveWaitInput,
  type ResolveWaitResult,
  type ResolveWaitContext,
} from '../../workflows/wait.js';
import {
  requestCancel,
  type RequestCancelInput,
} from '../../workflows/cancel.js';
import type { CancelRequestedEvent } from '../../workflows/events/types.js';
import type { FrozenCard } from '../../core/types.js';
import {
  buildWorkflowApprovalCard,
  WORKFLOW_APPROVE_ACTION,
  WORKFLOW_CANCEL_ACTION,
  WORKFLOW_COMMENT_FIELD,
  WORKFLOW_REJECT_ACTION,
  type WorkflowApprovalResolutionKind,
} from './workflow-cards.js';

export type WorkflowCardActionData = {
  operator?: { open_id?: string };
  action?: {
    value?: Record<string, string>;
    form_value?: Record<string, string>;
  };
  context?: { open_message_id?: string };
  open_message_id?: string;
};

export type WorkflowApprovalHandlerDeps = {
  runsDir?: string;
  makeEventLog?: (runId: string, runsDir: string) => EventLog;
  resolveWaitFn?: (
    log: EventLog,
    input: ResolveWaitInput,
    ctx?: ResolveWaitContext,
  ) => Promise<ResolveWaitResult>;
  requestCancelFn?: (
    log: EventLog,
    input: RequestCancelInput,
    actor: 'human',
  ) => Promise<CancelRequestedEvent>;
  loadFrozenCardsFn?: (storeId: string) => Map<string, FrozenCard>;
  saveFrozenCardsFn?: (storeId: string, cards: Map<string, FrozenCard>) => void;
};

export type WorkflowApprovalHandlerResult =
  | { ok: true; duplicate: true; cardNonce: string }
  | {
      ok: true;
      duplicate: false;
      cardNonce: string;
      result: ResolveWaitResult | CancelRequestedEvent;
      /** Frozen card body (no buttons) for the dispatcher to in-place patch the
       *  clicked card.  Undefined if rebuild failed — caller falls back to no
       *  patch and the card stays interactive (handler is idempotent via
       *  frozenCards). */
      resolvedCardJson?: string;
    }
  | { ok: false; error: 'not_approver'; cardNonce: string };

export function isWorkflowApprovalAction(action?: string): boolean {
  return (
    action === WORKFLOW_APPROVE_ACTION ||
    action === WORKFLOW_REJECT_ACTION ||
    action === WORKFLOW_CANCEL_ACTION
  );
}

export function workflowRunsDir(): string {
  return getRunsDir();
}

export function workflowFrozenStoreId(runId: string): string {
  return `workflow-${runId.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
}

export async function handleWorkflowApprovalAction(
  data: WorkflowCardActionData,
  deps: WorkflowApprovalHandlerDeps = {},
  locale?: Locale,
): Promise<WorkflowApprovalHandlerResult | undefined> {
  const value = data.action?.value;
  const action = value?.action;
  if (!isWorkflowApprovalAction(action)) return undefined;

  const runId = requiredValue(value, 'run_id');
  const activityId = requiredValue(value, 'activity_id');
  const attemptId = requiredValue(value, 'attempt_id');
  const cardNonce = requiredValue(value, 'card_nonce');
  const by = data.operator?.open_id;
  if (!by) throw new Error('workflow approval action missing operator.open_id');

  const storeId = workflowFrozenStoreId(runId);
  const loadCards = deps.loadFrozenCardsFn ?? loadFrozenCards;
  const saveCards = deps.saveFrozenCardsFn ?? saveFrozenCards;
  const frozenCards = loadCards(storeId);
  if (frozenCards.has(cardNonce)) {
    logger.info(`[workflow:${runId}] duplicate approval card click ignored: ${cardNonce}`);
    return { ok: true, duplicate: true, cardNonce };
  }

  const comment = cleanComment(data.action?.form_value?.[WORKFLOW_COMMENT_FIELD]);
  const runsDir = deps.runsDir ?? workflowRunsDir();
  const makeEventLog = deps.makeEventLog ?? ((rid, base) => new EventLog(rid, base));
  const log = makeEventLog(runId, runsDir);
  const eventsBefore = await log.readAll();
  if (!canApproveFromEvents(eventsBefore, activityId, by)) {
    logger.info(`[workflow:${runId}] approval card action blocked for non-approver ${by}`);
    return { ok: false, error: 'not_approver', cardNonce };
  }
  const result =
    action === WORKFLOW_CANCEL_ACTION
      ? await (deps.requestCancelFn ?? requestCancel)(
          log,
          {
            target: { kind: 'run', runId },
            reason: cancelReason(comment),
            by,
          },
          'human',
        )
      : await (deps.resolveWaitFn ?? resolveWait)(
          log,
          {
            activityId,
            attemptId,
            resolution: action === WORKFLOW_APPROVE_ACTION ? 'approved' : 'rejected',
            by,
            comment,
          },
          // v0.2: resolveWait inspects ctx.def to detect `decision` nodes
          // so reject writes activitySucceeded instead of activityFailed.
          // Loading the per-run workflow snapshot (not the catalog) keeps
          // long-running cards bound to the definition the run was started
          // with even if the catalog has since been edited.
          await (async () => {
            const def = await readWorkflowDefinitionFromRunDir(join(runsDir, runId));
            return def ? { def } : undefined;
          })(),
        );

  const resolutionKind: WorkflowApprovalResolutionKind =
    action === WORKFLOW_APPROVE_ACTION
      ? 'approved'
      : action === WORKFLOW_REJECT_ACTION
        ? 'rejected'
        : 'cancelled';

  frozenCards.set(cardNonce, {
    messageId: data.context?.open_message_id ?? data.open_message_id ?? '',
    title: `workflow approval ${runId}/${activityId}`,
    content: JSON.stringify({
      runId,
      activityId,
      attemptId,
      resolution: resolutionKind,
      by,
      ...(comment ? { comment } : {}),
    }),
  });
  saveCards(storeId, frozenCards);
  if (action === WORKFLOW_CANCEL_ACTION) {
    logger.info(`[workflow:${runId}] run cancel requested from approval card by ${by}`);
  } else {
    logger.info(`[workflow:${runId}] wait ${activityId}/${attemptId} resolved by ${by}`);
  }

  const resolvedCardJson = buildResolvedCardJson(eventsBefore, activityId, {
    kind: resolutionKind,
    by,
    comment,
  }, locale);

  return { ok: true, duplicate: false, cardNonce, result, resolvedCardJson };
}

function buildResolvedCardJson(
  events: WorkflowEvent[],
  activityId: string,
  resolution: { kind: WorkflowApprovalResolutionKind; by: string; comment?: string },
  locale?: Locale,
): string | undefined {
  try {
    const waitEvent = findLatestWaitCreated(events, activityId);
    if (!waitEvent) return undefined;
    const snapshot = replay(events);
    return buildWorkflowApprovalCard(waitEvent, snapshot, { resolution }, locale);
  } catch (err) {
    logger.warn(`failed to build resolved approval card: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

function findLatestWaitCreated(
  events: WorkflowEvent[],
  activityId: string,
): WaitCreatedEvent | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const evt = events[i];
    if (evt.type !== 'waitCreated') continue;
    if (waitCreatedActivityId(evt) !== activityId) continue;
    return evt as WaitCreatedEvent;
  }
  return undefined;
}

function requiredValue(value: Record<string, string> | undefined, key: string): string {
  const v = value?.[key];
  if (!v) throw new Error(`workflow approval action missing ${key}`);
  return v;
}

function cleanComment(s: string | undefined): string | undefined {
  const trimmed = s?.trim();
  return trimmed ? trimmed : undefined;
}

function cancelReason(comment: string | undefined): string {
  return comment ? `cancelled from approval card: ${comment}` : 'cancelled from approval card';
}

function canApproveFromEvents(events: WorkflowEvent[], activityId: string, by: string): boolean {
  const wait = findLatestWaitCreated(events, activityId);
  const approvers = waitCreatedApprovers(wait);
  if (!approvers || approvers.length === 0) return true;
  return approvers.includes(by);
}

function waitCreatedActivityId(event: WorkflowEvent): string | undefined {
  const payload = event.payload;
  if (typeof payload !== 'object' || payload === null || 'ref' in payload) return undefined;
  return (payload as { activityId?: string }).activityId;
}

function waitCreatedApprovers(event: WorkflowEvent | undefined): string[] | undefined {
  if (!event) return undefined;
  const payload = event.payload;
  if (typeof payload !== 'object' || payload === null || 'ref' in payload) return undefined;
  const approvers = (payload as { approvers?: unknown }).approvers;
  return Array.isArray(approvers) ? approvers.filter((x): x is string => typeof x === 'string') : undefined;
}
