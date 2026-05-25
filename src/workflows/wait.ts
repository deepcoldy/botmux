/**
 * Wait / human-gate host API (events doc v0.1.2 §2.4, Step 8 of 10).
 *
 * Three operations:
 *   - `createWait`  — declares a wait activity; writes `waitCreated`.
 *   - `resolveWait` — closes a wait by external decision; writes
 *                     `waitResolved` + activity terminal.
 *   - `expireWait`  — closes a wait by deadline; writes
 *                     `waitDeadlineExceeded` + activity terminal.
 *
 * Spec contract (§2.4):
 *   - `waitResolved` is NOT a terminal event; activity terminal follows.
 *   - `approved` resolution → `activitySucceeded`.
 *   - `rejected` resolution → `activityFailed { WaitDeadlineExceeded?, userFault }`.
 *     Per spec the errorCode for rejection isn't explicitly enumerated;
 *     v0 picks `userFault` class with a reusable code so dashboards can
 *     filter.  We use `InputValidationFailed` — closest fit from the
 *     existing enum (rejection is "input not accepted").
 *   - `external` resolution → `activitySucceeded` with the resolution
 *     reflected in `externalRefs.resolution = 'external'`.
 *   - `waitDeadlineExceeded` → either `activityFailed` ({WaitDeadlineExceeded,
 *     userFault}) when `onTimeout='fail'` (default), or
 *     `activitySucceeded { externalRefs.defaultedToTimeout=true }` when
 *     `onTimeout='success'` (spec §6 open Q7 resolved at Step 8).
 *
 * Step 8 does NOT:
 *   - schedule deadline timers (caller wires them up; we just write the
 *     event when the timer fires);
 *   - implement cancel propagation (Step 9).
 */

import type { EventLog } from './events/append.js';
import type { OutputRef } from './events/payloads.js';
import type {
  ActivityFailedEvent,
  ActivitySucceededEvent,
  WaitCreatedEvent,
  WaitDeadlineExceededEvent,
  WaitResolvedEvent,
} from './events/types.js';
import type { WorkflowDefinition } from './definition.js';
import { parseActivityId } from './orchestrator.js';
import { writeJsonBlob } from './blob.js';

// ─── Public types ───────────────────────────────────────────────────────────

export type WaitKind = 'human-gate' | 'time' | 'condition';
export type WaitResolution = 'approved' | 'rejected' | 'external';
export type WaitOnTimeout = 'fail' | 'success';

export type CreateWaitInput = {
  activityId: string;
  attemptId: string;
  nodeId: string;
  waitKind: WaitKind;
  /** Wall-clock ms epoch.  Required for `time` kind, optional otherwise. */
  deadlineAt?: number;
  /** Human-readable prompt (rendered to approvers / dashboards).  Small
   *  prompts go here inline; large ones spill to `promptRef` per
   *  `checkWaitCreatedPromptInvariant` (mutually exclusive). */
  prompt?: string;
  /** Blob spill for prompts that don't fit in the inline envelope.
   *  Consumers (card-builder / dashboard) read the blob on demand;
   *  replay never touches it. */
  promptRef?: OutputRef;
  /** Required short preview when `promptRef` is set so cards / dashboards
   *  can render without reading the blob.  Up to 500 chars (schema cap);
   *  producer is responsible for keeping bytes reasonable for UTF-8. */
  promptPreview?: string;
  /** Optional open_id allow list for human-gate card actions. */
  approvers?: string[];
  /** What to write as the activity terminal when the deadline fires
   *  without resolution.  Default `fail` (spec default). */
  onTimeout?: WaitOnTimeout;
};

export type ResolveWaitInput = {
  activityId: string;
  attemptId: string;
  resolution: WaitResolution;
  /** Identifier of the resolver — open_id / system actor name. */
  by: string;
  comment?: string;
  /**
   * Extra business output to record in the resulting
   * `activitySucceeded.externalRefs` (only used when the resolution
   * leads to success — approved / external).  Ignored for rejected.
   */
  output?: Record<string, unknown>;
};

export type ExpireWaitInput = {
  activityId: string;
  attemptId: string;
  /** Wall-clock ms at which the deadline was scheduled. */
  deadlineAt: number;
  /** Wall-clock ms when the timer actually fired (may be slightly later
   *  due to scheduler latency). */
  exceededAtMs: number;
  /** Policy for the resulting activity terminal.  Default `fail`. */
  onTimeout?: WaitOnTimeout;
};

// ─── Result types ───────────────────────────────────────────────────────────

export type ResolveWaitResult = {
  resolutionEvent: WaitResolvedEvent;
  terminalEvent: ActivitySucceededEvent | ActivityFailedEvent;
  /** Convenience surface of the resolution event's eventId — useful as
   *  the loop runtime's `waitResolvedEventId` audit anchor without
   *  reaching into `.resolutionEvent.eventId`. */
  waitResolvedEventId: string;
};

/**
 * Optional context for resolveWait.  When `def` is supplied, resolveWait
 * recognises `decision` nodes (v0.2 loop terminators) and writes their
 * terminal as `activitySucceeded` with a fixed `{resolution, by, comment?}`
 * output blob — including the `rejected` case, which for plain nodes
 * still maps to `activityFailed`.  See /tmp/wf-loop-v02.md §4.3 N2.
 */
export type ResolveWaitContext = {
  def?: WorkflowDefinition;
};

export type ExpireWaitResult = {
  deadlineEvent: WaitDeadlineExceededEvent;
  terminalEvent: ActivitySucceededEvent | ActivityFailedEvent;
};

// ─── createWait ────────────────────────────────────────────────────────────

/**
 * Declare a wait activity.  Writes `waitCreated`.  The caller is
 * responsible for advancing the parent node into `waiting` via
 * `nodeWaiting` (scheduling concern, not host-API).
 */
export async function createWait(
  log: EventLog,
  input: CreateWaitInput,
): Promise<WaitCreatedEvent> {
  if (input.waitKind === 'time' && input.deadlineAt === undefined) {
    throw new Error(
      `createWait(${input.activityId}): waitKind='time' requires deadlineAt`,
    );
  }
  return (await log.append({
    runId: log.runId,
    type: 'waitCreated',
    actor: 'scheduler',
    payload: {
      activityId: input.activityId,
      nodeId: input.nodeId,
      waitKind: input.waitKind,
      deadlineAt: input.deadlineAt,
      prompt: input.prompt,
      promptRef: input.promptRef,
      promptPreview: input.promptPreview,
      approvers: input.approvers,
      onTimeout: input.onTimeout,
    },
  })) as WaitCreatedEvent;
}

// ─── resolveWait ───────────────────────────────────────────────────────────

/**
 * Close a wait via external decision.  Writes `waitResolved` followed
 * by the activity terminal.  The terminal mapping is fixed by spec
 * §2.4 for plain nodes:
 *   - approved → activitySucceeded
 *   - rejected → activityFailed { InputValidationFailed, userFault }
 *   - external → activitySucceeded { externalRefs.resolution='external' }
 *
 * For v0.2 `decision` nodes (loop terminators), the mapping is different:
 * BOTH approve and reject resolve to `activitySucceeded` with a fixed
 * `{resolution, by, comment?}` output blob — rejection is a legal
 * decision output, not a failure.  Pass `ctx.def` so resolveWait can
 * look up the node type via `parseActivityId(activityId).nodeId`.
 */
export async function resolveWait(
  log: EventLog,
  input: ResolveWaitInput,
  ctx?: ResolveWaitContext,
): Promise<ResolveWaitResult> {
  const resolutionEvent = (await log.append({
    runId: log.runId,
    type: 'waitResolved',
    actor: input.resolution === 'external' ? 'system' : 'human',
    payload: {
      activityId: input.activityId,
      resolution: input.resolution,
      by: input.by,
      comment: input.comment,
    },
  })) as WaitResolvedEvent;

  // v0.2: detect decision node so reject doesn't go through activityFailed.
  const isDecisionNode = (() => {
    if (!ctx?.def) return false;
    const parsed = parseActivityId(input.activityId);
    if (!parsed) return false;
    return ctx.def.nodes[parsed.nodeId]?.type === 'decision';
  })();

  const terminalEvent = await writeWaitTerminal(log, {
    activityId: input.activityId,
    attemptId: input.attemptId,
    kind:
      input.resolution === 'rejected' && !isDecisionNode
        ? {
            tag: 'failed',
            errorCode: 'InputValidationFailed',
            errorClass: 'userFault',
            errorMessage: `Wait resolved with rejected by ${input.by}${
              input.comment ? `: ${input.comment}` : ''
            }`,
          }
        : {
            tag: 'succeeded',
            externalRefs: {
              resolution: input.resolution,
              by: input.by,
              // Always materialize `comment` (empty string when missing) so
              // downstream `${node.output.comment}` / `${node.previous.comment}`
              // bindings don't hit BindingError on the natural "approve/reject
              // without note" interaction. input.output may override.
              comment: input.comment ?? '',
              ...(input.output ?? {}),
            },
          },
  });

  return {
    resolutionEvent,
    terminalEvent,
    waitResolvedEventId: resolutionEvent.eventId,
  };
}

// ─── expireWait ────────────────────────────────────────────────────────────

/**
 * Close a wait via deadline expiry.  Writes `waitDeadlineExceeded`
 * followed by the activity terminal driven by `onTimeout` (default
 * `fail`).
 *
 * The terminal policy:
 *   - fail (default) → activityFailed { WaitDeadlineExceeded, userFault }
 *   - success        → activitySucceeded { externalRefs.defaultedToTimeout=true }
 */
export async function expireWait(
  log: EventLog,
  input: ExpireWaitInput,
): Promise<ExpireWaitResult> {
  const deadlineEvent = (await log.append({
    runId: log.runId,
    type: 'waitDeadlineExceeded',
    actor: 'scheduler',
    payload: {
      activityId: input.activityId,
      deadlineAt: input.deadlineAt,
      exceededAtMs: input.exceededAtMs,
    },
  })) as WaitDeadlineExceededEvent;

  const policy: WaitOnTimeout = input.onTimeout ?? 'fail';
  const terminalEvent = await writeWaitTerminal(log, {
    activityId: input.activityId,
    attemptId: input.attemptId,
    kind:
      policy === 'success'
        ? {
            tag: 'succeeded',
            externalRefs: { defaultedToTimeout: true, deadlineAt: input.deadlineAt },
          }
        : {
            tag: 'failed',
            errorCode: 'WaitDeadlineExceeded',
            errorClass: 'userFault',
            errorMessage: `Wait deadline (${input.deadlineAt}) exceeded at ${input.exceededAtMs}`,
          },
  });

  return { deadlineEvent, terminalEvent };
}

// ─── Internal terminal writer ──────────────────────────────────────────────

type TerminalSpec = {
  activityId: string;
  attemptId: string;
  kind:
    | {
        tag: 'succeeded';
        externalRefs: Record<string, unknown>;
      }
    | {
        tag: 'failed';
        errorCode: 'WaitDeadlineExceeded' | 'InputValidationFailed';
        errorClass: 'userFault';
        errorMessage: string;
      };
};

async function writeWaitTerminal(
  log: EventLog,
  spec: TerminalSpec,
): Promise<ActivitySucceededEvent | ActivityFailedEvent> {
  if (spec.kind.tag === 'succeeded') {
    const externalRefs = spec.kind.externalRefs;
    // Persist externalRefs as a real blob so `${node.output.x}` /
    // `${node.previous.x}` binding can read the resolution payload.
    // Plain wait approve also benefits — downstream nodes can now read
    // `${gate.output.resolution}` without falling back to externalRefs.
    // (Previously we hand-rolled an OutputRef without `outputPath`,
    // which made the binding layer fail-loud on decision `previous`
    // references — codex Step 3 review Blocker 1.)
    const outputRef = await writeJsonBlob(log, externalRefs);
    return (await log.append({
      runId: log.runId,
      type: 'activitySucceeded',
      actor: 'scheduler',
      payload: {
        activityId: spec.activityId,
        attemptId: spec.attemptId,
        outputRef,
        externalRefs,
      },
    })) as ActivitySucceededEvent;
  }
  return (await log.append({
    runId: log.runId,
    type: 'activityFailed',
    actor: 'scheduler',
    payload: {
      activityId: spec.activityId,
      attemptId: spec.attemptId,
      error: {
        errorCode: spec.kind.errorCode,
        errorClass: spec.kind.errorClass,
        errorMessage: spec.kind.errorMessage,
      },
    },
  })) as ActivityFailedEvent;
}
