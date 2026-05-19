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
  WORKFLOW_COMMENT_FIELD,
  WORKFLOW_REJECT_ACTION,
  workflowApprovalCardNonce,
} from '../src/im/lark/workflow-cards.js';
import {
  handleWorkflowApprovalAction,
  workflowFrozenStoreId,
} from '../src/im/lark/workflow-card-handler.js';

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

async function bootstrapWait(prompt = '请确认订票计划'): Promise<WaitCreatedEvent> {
  await log.append(runCreated);
  await log.append(attemptCreated);
  return createWait(log, {
    activityId: ACTIVITY_ID,
    attemptId: ATTEMPT_ID,
    nodeId: NODE_ID,
    waitKind: 'human-gate',
    deadlineAt: 2_000_000_000_000,
    prompt,
  });
}

function cardText(card: unknown): string {
  return JSON.stringify(card);
}

function cardActionData(action: string, comment?: string) {
  return {
    operator: { open_id: 'ou_approver' },
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
});

describe('handleWorkflowApprovalAction', () => {
  it('approve click writes waitResolved=approved and activitySucceeded', async () => {
    await bootstrapWait();

    await handleWorkflowApprovalAction(cardActionData(WORKFLOW_APPROVE_ACTION), {
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
});
