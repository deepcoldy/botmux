import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { EventLog, type EventDraft } from '../src/workflows/events/append.js';
import { replay } from '../src/workflows/events/replay.js';
import type { WaitCreatedEvent } from '../src/workflows/events/types.js';
import type { FrozenCard } from '../src/core/types.js';
import { createWait } from '../src/workflows/wait.js';
import {
  buildWorkflowApprovalCard,
  WORKFLOW_APPROVE_ACTION,
  WORKFLOW_CANCEL_ACTION,
  WORKFLOW_COMMENT_FIELD,
  WORKFLOW_REJECT_ACTION,
  workflowApprovalCardNonce,
} from '../src/im/lark/workflow-cards.js';
import {
  handleWorkflowApprovalAction,
  workflowFrozenStoreId,
} from '../src/im/lark/workflow-card-handler.js';
import { parseWorkflowDefinition } from '../src/workflows/definition.js';
import { snapshotWorkflowDefinition } from '../src/workflows/loader.js';
import { loopGateActivityId } from '../src/workflows/orchestrator.js';

const RUN_ID = 'run-approval-card-01';
const ACTIVITY_ID = 'act-approval';
const ATTEMPT_ID = 'attempt-approval-1';
const NODE_ID = 'book_plan';
const SHA = `sha256:${'a'.repeat(64)}`;
const sampleOutputRef = {
  outputHash: SHA,
  outputBytes: 12,
  outputSchemaVersion: 1,
};

let baseDir: string;
let log: EventLog;

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), 'wf-approval-card-'));
  log = new EventLog(RUN_ID, baseDir);
});

afterEach(() => {
  rmSync(baseDir, { recursive: true, force: true });
});

const runCreated: EventDraft = {
  runId: RUN_ID,
  type: 'runCreated',
  actor: 'scheduler',
  payload: {
    workflowId: 'trip-planner',
    revisionId: 'rev-approval-001',
    inputRef: sampleOutputRef,
    initiator: 'ou_user',
    botSnapshots: {
      'codex-loopy': {
        larkAppId: 'cli_codex',
        cliId: 'codex',
        displayName: 'Codex Loopy',
      },
    },
  },
};

const attemptCreated: EventDraft = {
  runId: RUN_ID,
  type: 'attemptCreated',
  actor: 'scheduler',
  payload: {
    nodeId: NODE_ID,
    activityId: ACTIVITY_ID,
    attemptId: ATTEMPT_ID,
    attemptNumber: 1,
    inputRef: sampleOutputRef,
  },
};

async function bootstrapWait(
  prompt = '请确认订票计划',
  approvers?: string[],
): Promise<WaitCreatedEvent> {
  await log.append(runCreated);
  await log.append(attemptCreated);
  return createWait(log, {
    activityId: ACTIVITY_ID,
    attemptId: ATTEMPT_ID,
    nodeId: NODE_ID,
    waitKind: 'human-gate',
    deadlineAt: 2_000_000_000_000,
    prompt,
    approvers,
  });
}

async function bootstrapWaitWithPromptRef(promptPreview: string): Promise<WaitCreatedEvent> {
  // Intentionally point outputPath at a non-existent file: cards MUST NOT
  // read the blob, so test fails if anyone wires fs.readFile into the
  // card-builder later.
  await log.append(runCreated);
  await log.append(attemptCreated);
  return createWait(log, {
    activityId: ACTIVITY_ID,
    attemptId: ATTEMPT_ID,
    nodeId: NODE_ID,
    waitKind: 'human-gate',
    deadlineAt: 2_000_000_000_000,
    promptRef: {
      outputHash: 'sha256:' + 'd'.repeat(64),
      outputPath: '/tmp/__promptref_blob_should_not_be_read__',
      outputBytes: 5000,
      outputSchemaVersion: 1,
      contentType: 'text/plain',
    },
    promptPreview,
  });
}

function cardText(card: unknown): string {
  return JSON.stringify(card);
}

function cardActionData(action: string, comment?: string, operatorOpenId = 'ou_approver') {
  return {
    operator: { open_id: operatorOpenId },
    action: {
      value: {
        action,
        run_id: RUN_ID,
        activity_id: ACTIVITY_ID,
        attempt_id: ATTEMPT_ID,
        card_nonce: workflowApprovalCardNonce(RUN_ID, ACTIVITY_ID, ATTEMPT_ID),
      },
      form_value: comment ? { [WORKFLOW_COMMENT_FIELD]: comment } : {},
    },
    context: { open_message_id: 'om_card_1' },
  };
}

describe('buildWorkflowApprovalCard', () => {
  it('renders approve/reject form actions with workflow identifiers', async () => {
    const waitCreated = await bootstrapWait('确认是否执行下一步？');
    const snapshot = replay(await log.readAll());

    const card = JSON.parse(
      buildWorkflowApprovalCard(waitCreated, snapshot, {
        webDetailUrl: 'http://dashboard.local/#workflow/run-approval-card-01',
      }),
    );

    expect(card.header.title.content).toContain('需要审批');
    const text = cardText(card);
    expect(text).toContain(WORKFLOW_APPROVE_ACTION);
    expect(text).toContain(WORKFLOW_REJECT_ACTION);
    expect(text).toContain(WORKFLOW_CANCEL_ACTION);
    expect(text).toContain(RUN_ID);
    expect(text).toContain(ACTIVITY_ID);
    expect(text).toContain(ATTEMPT_ID);
    expect(text).toContain(WORKFLOW_COMMENT_FIELD);
  });

  it('truncates long prompts and points to Web detail for full content', async () => {
    const longPrompt = 'x'.repeat(620);
    const waitCreated = await bootstrapWait(longPrompt);
    const snapshot = replay(await log.readAll());

    const card = JSON.parse(buildWorkflowApprovalCard(waitCreated, snapshot));
    const text = cardText(card);

    expect(text).toContain('已截断');
    expect(text).toContain('Web 查看');
    expect(text).not.toContain('x'.repeat(620));
  });

  it('uses promptPreview (not the blob) when waitCreated carries promptRef', async () => {
    const preview = '出行规划预览：D1 上海雨,D2 多云,D3 晴…(完整内容见 dashboard)';
    const waitCreated = await bootstrapWaitWithPromptRef(preview);
    const snapshot = replay(await log.readAll());

    // Card must render successfully even though the blob file doesn't exist;
    // any disk read attempt would surface as a thrown ENOENT.
    const card = JSON.parse(buildWorkflowApprovalCard(waitCreated, snapshot));
    const text = cardText(card);

    expect(text).toContain('预览');                  // hasFullBehindRef hint
    expect(text).toContain('Web 详情');               // ref → dashboard pointer
    expect(text).toContain('出行规划预览');           // preview body landed
    expect(text).toContain('dashboard');              // preview ellipsis tail
    expect(text).not.toContain('__promptref_blob_should_not_be_read__'); // path never leaks
  });

  it('renders a Web detail button with multi_url', async () => {
    const waitCreated = await bootstrapWait();
    const snapshot = replay(await log.readAll());

    const card = JSON.parse(
      buildWorkflowApprovalCard(waitCreated, snapshot, { webDetailUrl: 'http://example.com/detail' }),
    );
    const text = cardText(card);

    expect(text).toContain('Web 详情');
    expect(text).toContain('multi_url');
    expect(text).toContain('http://example.com/detail');
  });

  it('lays out approve and reject side-by-side via column_set so they do not stack vertically', async () => {
    const waitCreated = await bootstrapWait();
    const snapshot = replay(await log.readAll());

    const card = JSON.parse(buildWorkflowApprovalCard(waitCreated, snapshot));
    const form = card.elements.find((e: any) => e.tag === 'form');
    expect(form).toBeDefined();
    const columnSet = form.elements.find((e: any) => e.tag === 'column_set');
    expect(columnSet).toBeDefined();
    expect(columnSet.columns).toHaveLength(2);
    const buttons = columnSet.columns.map((c: any) => c.elements[0]);
    expect(buttons[0].name).toBe('workflow_approve');
    expect(buttons[1].name).toBe('workflow_reject');
    // Cancel stays below the row at full width — visual grouping separates
    // gate decision from run cancel.
    const cancelButton = form.elements.find(
      (e: any) => e.tag === 'button' && e.name === 'workflow_cancel',
    );
    expect(cancelButton).toBeDefined();
  });

  it('renders frozen card with no form/buttons when resolution is set (approve)', async () => {
    const waitCreated = await bootstrapWait();
    const snapshot = replay(await log.readAll());

    const card = JSON.parse(
      buildWorkflowApprovalCard(waitCreated, snapshot, {
        resolution: { kind: 'approved', by: 'ou_approver', comment: 'looks good' },
      }),
    );
    expect(card.header.template).toBe('green');
    expect(card.header.title.content).toContain('已通过');
    // No form / approve / reject button — buttons must be unclickable
    expect(card.elements.find((e: any) => e.tag === 'form')).toBeUndefined();
    const text = cardText(card);
    expect(text).not.toContain(WORKFLOW_APPROVE_ACTION);
    expect(text).not.toContain(WORKFLOW_REJECT_ACTION);
    expect(text).not.toContain(WORKFLOW_CANCEL_ACTION);
    // But the resolution banner + operator + comment all surface (open_id
    // underscores are markdown-escaped, so check the prefix instead of the
    // raw id).
    expect(text).toContain('已通过');
    expect(text).toContain('ou\\\\_approver');
    expect(text).toContain('looks good');
    // Web detail button still rendered so the operator can hop to dashboard
    expect(text).toContain('Web 详情');
  });

  it('uses red template for rejected and grey template for cancelled', async () => {
    const waitCreated = await bootstrapWait();
    const snapshot = replay(await log.readAll());

    const rejected = JSON.parse(
      buildWorkflowApprovalCard(waitCreated, snapshot, {
        resolution: { kind: 'rejected', by: 'ou_reviewer' },
      }),
    );
    expect(rejected.header.template).toBe('red');
    expect(rejected.header.title.content).toContain('已拒绝');

    const cancelled = JSON.parse(
      buildWorkflowApprovalCard(waitCreated, snapshot, {
        resolution: { kind: 'cancelled', by: 'ou_owner' },
      }),
    );
    expect(cancelled.header.template).toBe('grey');
    expect(cancelled.header.title.content).toContain('已取消');
  });
});

describe('handleWorkflowApprovalAction', () => {
  it('approve click writes waitResolved=approved and activitySucceeded', async () => {
    await bootstrapWait();

    const result = await handleWorkflowApprovalAction(cardActionData(WORKFLOW_APPROVE_ACTION), {
      runsDir: baseDir,
      loadFrozenCardsFn: () => new Map(),
      saveFrozenCardsFn: () => undefined,
    });

    const events = await log.readAll();
    const waitResolved = events.find((e) => e.type === 'waitResolved');
    const terminal = events.find((e) => e.type === 'activitySucceeded');
    expect(waitResolved?.payload).toMatchObject({
      activityId: ACTIVITY_ID,
      resolution: 'approved',
      by: 'ou_approver',
    });
    expect(terminal?.payload).toMatchObject({
      activityId: ACTIVITY_ID,
      attemptId: ATTEMPT_ID,
    });

    // The handler now returns a frozen (no-form) card body so the dispatcher
    // can in-place-patch the clicked card.
    expect(result).toMatchObject({ ok: true, duplicate: false });
    if (result && result.ok && !result.duplicate) {
      expect(result.resolvedCardJson).toBeDefined();
      const frozen = JSON.parse(result.resolvedCardJson!);
      expect(frozen.header.template).toBe('green');
      expect(frozen.elements.find((e: any) => e.tag === 'form')).toBeUndefined();
    }
  });

  it('reject click preserves comment and writes activityFailed', async () => {
    await bootstrapWait();

    await handleWorkflowApprovalAction(cardActionData(WORKFLOW_REJECT_ACTION, '信息不完整'), {
      runsDir: baseDir,
      loadFrozenCardsFn: () => new Map(),
      saveFrozenCardsFn: () => undefined,
    });

    const events = await log.readAll();
    const waitResolved = events.find((e) => e.type === 'waitResolved');
    const terminal = events.find((e) => e.type === 'activityFailed');
    expect(waitResolved?.payload).toMatchObject({
      resolution: 'rejected',
      comment: '信息不完整',
    });
    expect(cardText(terminal)).toContain('信息不完整');
  });

  it('uses frozen-card store to ignore duplicate clicks', async () => {
    let cards = new Map<string, FrozenCard>();
    const resolveWaitFn = vi.fn(async () => ({
      resolutionEvent: { type: 'waitResolved' },
      terminalEvent: { type: 'activitySucceeded' },
    })) as any;
    const deps = {
      runsDir: baseDir,
      resolveWaitFn,
      loadFrozenCardsFn: (storeId: string) => {
        expect(storeId).toBe(workflowFrozenStoreId(RUN_ID));
        return new Map(cards);
      },
      saveFrozenCardsFn: (_storeId: string, nextCards: Map<string, FrozenCard>) => {
        cards = new Map(nextCards);
      },
    };

    const first = await handleWorkflowApprovalAction(cardActionData(WORKFLOW_APPROVE_ACTION), deps);
    const second = await handleWorkflowApprovalAction(cardActionData(WORKFLOW_APPROVE_ACTION), deps);

    expect(first).toMatchObject({ ok: true, duplicate: false });
    expect(second).toMatchObject({ ok: true, duplicate: true });
    expect(resolveWaitFn).toHaveBeenCalledTimes(1);
  });

  it('cancel click writes run-level cancelRequested without resolving the wait', async () => {
    await bootstrapWait();

    await handleWorkflowApprovalAction(cardActionData(WORKFLOW_CANCEL_ACTION, 'stop it'), {
      runsDir: baseDir,
      loadFrozenCardsFn: () => new Map(),
      saveFrozenCardsFn: () => undefined,
    });

    const events = await log.readAll();
    const cancel = events.find((e) => e.type === 'cancelRequested');
    expect(cancel?.payload).toMatchObject({
      target: { kind: 'run', runId: RUN_ID },
      reason: 'cancelled from approval card: stop it',
      by: 'ou_approver',
    });
    expect(events.find((e) => e.type === 'waitResolved')).toBeUndefined();
    expect(replay(events).cancelledRunIntent).toMatchObject({
      requestedBy: 'ou_approver',
      reason: 'cancelled from approval card: stop it',
    });
  });

  it('blocks approve/reject/cancel clicks from users outside humanGate approvers', async () => {
    await bootstrapWait('manager only', ['ou_manager']);
    const saveFrozenCardsFn = vi.fn();

    const result = await handleWorkflowApprovalAction(
      cardActionData(WORKFLOW_CANCEL_ACTION, undefined, 'ou_intruder'),
      {
        runsDir: baseDir,
        loadFrozenCardsFn: () => new Map(),
        saveFrozenCardsFn,
      },
    );

    expect(result).toEqual({
      ok: false,
      error: 'not_approver',
      cardNonce: workflowApprovalCardNonce(RUN_ID, ACTIVITY_ID, ATTEMPT_ID),
    });
    const events = await log.readAll();
    expect(events.find((e) => e.type === 'cancelRequested')).toBeUndefined();
    expect(events.find((e) => e.type === 'waitResolved')).toBeUndefined();
    expect(saveFrozenCardsFn).not.toHaveBeenCalled();
  });

  it('freezes the approval card so approve after cancel is ignored', async () => {
    let cards = new Map<string, FrozenCard>();
    const resolveWaitFn = vi.fn(async () => ({
      resolutionEvent: { type: 'waitResolved' },
      terminalEvent: { type: 'activitySucceeded' },
    })) as any;
    const requestCancelFn = vi.fn(async () => ({
      runId: RUN_ID,
      eventId: `${RUN_ID}-99`,
      schemaVersion: 1,
      type: 'cancelRequested',
      timestamp: 1,
      actor: 'human',
      payload: {
        target: { kind: 'run', runId: RUN_ID },
        reason: 'cancelled from approval card',
        by: 'ou_approver',
      },
    })) as any;
    const deps = {
      runsDir: baseDir,
      resolveWaitFn,
      requestCancelFn,
      loadFrozenCardsFn: () => new Map(cards),
      saveFrozenCardsFn: (_storeId: string, nextCards: Map<string, FrozenCard>) => {
        cards = new Map(nextCards);
      },
    };

    const first = await handleWorkflowApprovalAction(cardActionData(WORKFLOW_CANCEL_ACTION), deps);
    const second = await handleWorkflowApprovalAction(cardActionData(WORKFLOW_APPROVE_ACTION), deps);

    expect(first).toMatchObject({ ok: true, duplicate: false });
    expect(second).toMatchObject({ ok: true, duplicate: true });
    expect(requestCancelFn).toHaveBeenCalledTimes(1);
    expect(resolveWaitFn).not.toHaveBeenCalled();
  });

  // v0.2: reject on a `decision` node must write activitySucceeded so the
  // loop body continues into iteration N+1 (rejection is a legal decision
  // output, not a wait failure).  Regression for the dogfood crash where
  // card-handler.ts called resolveWait WITHOUT ctx.def, so isDecisionNode
  // stayed false → reject wrote activityFailed → orchestrator closed the
  // loop with `body-failed`.  This pins card-handler to load the run's
  // workflow.json snapshot and pass it through.
  it('decision-node reject writes activitySucceeded (loop body proceeds to iter N+1)', async () => {
    const LOOP_ID = 'review-loop';
    const ITER = 1;
    const NODE = 'reviewDecision';
    const decisionActivityId = loopGateActivityId(RUN_ID, LOOP_ID, ITER, NODE);
    const decisionAttemptId = `${decisionActivityId}::att-1`;

    // Snapshot a minimal loop def into the run dir so card-handler can load it.
    const def = parseWorkflowDefinition({
      workflowId: 'trip-planner',
      version: 1,
      nodes: {
        implement: { type: 'subagent', bot: 'cli_a', prompt: 'impl' },
        review: { type: 'subagent', bot: 'cli_b', depends: ['implement'], prompt: 'rev' },
        reviewDecision: {
          type: 'decision',
          depends: ['review'],
          humanGate: { stage: 'before', prompt: 'approve?' },
        },
        [LOOP_ID]: {
          type: 'loop',
          maxIterations: 3,
          body: ['implement', 'review', 'reviewDecision'],
          terminate: { node: 'reviewDecision', via: 'humanGate' },
          output: { from: 'implement' },
        },
      },
    });
    await snapshotWorkflowDefinition(RUN_ID, def, { runsDir: baseDir });

    // Bootstrap a waitCreated on the loop gate activity id.
    await log.append(runCreated);
    await log.append({
      runId: RUN_ID,
      type: 'attemptCreated',
      actor: 'scheduler',
      payload: {
        nodeId: NODE,
        activityId: decisionActivityId,
        attemptId: decisionAttemptId,
        attemptNumber: 1,
        inputRef: sampleOutputRef,
      },
    });
    await createWait(log, {
      activityId: decisionActivityId,
      attemptId: decisionAttemptId,
      nodeId: NODE,
      waitKind: 'human-gate',
      deadlineAt: 2_000_000_000_000,
      prompt: 'approve?',
    });

    const cardNonce = workflowApprovalCardNonce(RUN_ID, decisionActivityId, decisionAttemptId);
    await handleWorkflowApprovalAction(
      {
        operator: { open_id: 'ou_approver' },
        action: {
          value: {
            action: WORKFLOW_REJECT_ACTION,
            run_id: RUN_ID,
            activity_id: decisionActivityId,
            attempt_id: decisionAttemptId,
            card_nonce: cardNonce,
          },
          form_value: { [WORKFLOW_COMMENT_FIELD]: 'add error handling' },
        },
        context: { open_message_id: 'om_card_reject' },
      },
      {
        runsDir: baseDir,
        loadFrozenCardsFn: () => new Map(),
        saveFrozenCardsFn: () => undefined,
      },
    );

    const events = await log.readAll();
    const terminal = events.find(
      (e) =>
        (e.type === 'activitySucceeded' || e.type === 'activityFailed') &&
        (e.payload as any).activityId === decisionActivityId,
    );
    expect(terminal?.type).toBe('activitySucceeded');
    // The reject comment is captured in externalRefs.comment so the next
    // iteration's `${reviewDecision.previous.comment}` binding can read it.
    const externalRefs = (terminal?.payload as any)?.externalRefs;
    expect(externalRefs).toMatchObject({
      resolution: 'rejected',
      by: 'ou_approver',
      comment: 'add error handling',
    });
  });
});
