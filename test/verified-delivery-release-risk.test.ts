import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  openLedger,
  TASK_RELEASE_AUTO_RETRY_WINDOW_MS,
  type LedgerHandle,
} from '../src/verified-delivery/ledger.js';
import { buildTaskReleaseClaim } from '../src/verified-delivery/release-engine.js';
import {
  DEFAULT_REJECTED_DEPENDENCY_STALL_MS,
  deriveTaskReleaseRisks,
  resolveRejectedDependencyStallMs,
  taskReleaseRiskNotificationId,
} from '../src/verified-delivery/release-risk.js';
import type { LedgerEventDraft, TaskPlannedPayload } from '../src/verified-delivery/types.js';

const TS = 1_700_000_000_000;

function draft(
  input: Partial<LedgerEventDraft> & Pick<LedgerEventDraft, 'type' | 'taskId' | 'idempotencyKey' | 'payload'>,
): LedgerEventDraft {
  return { actor: 'orchestrator', ts: TS, ...input } as LedgerEventDraft;
}

function appendUpstream(ledger: LedgerHandle, status: 'accepted' | 'cancelled' | 'rejected' | 'blocked'): void {
  ledger.append(draft({
    type: 'TaskDispatched', taskId: 'upstream', chatId: 'oc_goal', idempotencyKey: 'dispatch:upstream',
    payload: { taskId: 'upstream', title: 'Prepare contract' },
  }));
  if (status === 'cancelled') {
    ledger.append(draft({
      type: 'TaskCancelled', taskId: 'upstream', chatId: 'oc_goal', idempotencyKey: 'cancel:upstream',
      ts: TS + 10, payload: { taskId: 'upstream', reason: '需求撤回', by: 'ou_supervisor' },
    }));
    return;
  }
  if (status === 'blocked') {
    ledger.append(draft({
      type: 'TaskHelpRequested', actor: 'worker', taskId: 'upstream', chatId: 'oc_goal', idempotencyKey: 'help:upstream',
      ts: TS + 10, payload: { taskId: 'upstream', blocker: '等待权限', kind: 'access' },
    }));
    return;
  }
  ledger.append(draft({
    type: 'TaskReported', actor: 'worker', taskId: 'upstream', chatId: 'oc_goal', idempotencyKey: 'report:upstream:r1',
    ts: TS + 10,
    payload: {
      taskId: 'upstream', reportId: 'upstream-r1', summary: 'contract ready',
      evidence: [{ kind: 'path', path: '/tmp/contract.json' }],
    },
  }));
  if (status === 'accepted') {
    ledger.append(draft({
      type: 'TaskAccepted', taskId: 'upstream', chatId: 'oc_goal', idempotencyKey: 'accept:upstream:r1',
      ts: TS + 20, payload: { taskId: 'upstream', reportId: 'upstream-r1', checkedBy: 'ou_supervisor' },
    }));
  } else {
    ledger.append(draft({
      type: 'TaskRejected', taskId: 'upstream', chatId: 'oc_goal', idempotencyKey: 'reject:upstream:r1',
      ts: TS + 20, payload: { taskId: 'upstream', reportId: 'upstream-r1', reason: '证据不足' },
    }));
  }
}

function appendDownstreamPlan(ledger: LedgerHandle): void {
  const payload: TaskPlannedPayload = {
    taskId: 'downstream',
    chatId: 'oc_goal',
    title: 'Consume contract',
    dependsOnTaskIds: ['upstream'],
    planGeneration: 1,
    dispatchSpec: {
      title: 'Consume contract',
      briefBase: 'Implement the client.',
      workers: [{ openId: 'ou_worker', name: 'Worker', role: 'coder', larkAppId: 'cli_worker' }],
      senderLarkAppId: 'cli_supervisor',
    },
    plannedBy: 'ou_supervisor',
  };
  ledger.append(draft({
    type: 'TaskPlanned', taskId: 'downstream', chatId: 'oc_goal', idempotencyKey: 'planned:downstream',
    ts: TS + 30, payload,
  }));
}

function claimRelease(ledger: LedgerHandle): string {
  const frozen = buildTaskReleaseClaim({
    ledger, taskId: 'downstream', attempt: 0, releasedBy: 'daemon:cli_supervisor',
  });
  if (!frozen) throw new Error('expected a ready release claim');
  const claimed = ledger.claimReadyPlan({
    taskId: 'downstream',
    expectedPlanEventId: frozen.expectedPlanEventId,
    expectedAcceptedEventIds: frozen.expectedAcceptedEventIds,
    ts: TS + 40,
    intent: frozen.intent,
  });
  if (claimed.result !== 'created') throw new Error(`expected created claim, got ${claimed.result}`);
  return frozen.intent.releaseId;
}

describe('dependency release risks', () => {
  let baseDir: string;
  let ledger: LedgerHandle;

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), 'vd-release-risk-'));
    ledger = openLedger({ baseDir });
  });

  afterEach(() => rmSync(baseDir, { recursive: true, force: true }));

  it('derives the same stable definite-failure risk after reopening the ledger', () => {
    appendUpstream(ledger, 'accepted');
    appendDownstreamPlan(ledger);
    const releaseId = claimRelease(ledger);
    ledger.append(draft({
      type: 'TaskDispatchFailed', taskId: 'downstream', chatId: 'oc_goal',
      idempotencyKey: `dispatch-failed:${releaseId}:definite`, ts: TS + 50,
      payload: {
        taskId: 'downstream', releaseId, planEventId: ledger.task('downstream')!.plan!.planEventId,
        planGeneration: 1, attempt: 0, failureClass: 'definite', code: 'worker_not_in_chat',
        detail: '执行者不在目标群', failedBy: 'daemon:cli_supervisor',
      },
    }));

    const beforeRestart = deriveTaskReleaseRisks({ tasks: ledger.tasks(), events: ledger.read(), now: TS + 60 });
    const reopened = openLedger({ baseDir });
    const afterRestart = deriveTaskReleaseRisks({ tasks: reopened.tasks(), events: reopened.read(), now: TS + 60 });

    expect(beforeRestart).toEqual(afterRestart);
    expect(beforeRestart).toEqual([expect.objectContaining({
      taskId: 'downstream', kind: 'release_definite', releaseId,
      stableKey: expect.stringContaining(releaseId),
    })]);
    expect(taskReleaseRiskNotificationId(beforeRestart[0]!)).toBe(taskReleaseRiskNotificationId(afterRestart[0]!));
  });

  it('only raises ambiguous release risk once the provider idempotency window expires', () => {
    appendUpstream(ledger, 'accepted');
    appendDownstreamPlan(ledger);
    const releaseId = claimRelease(ledger);
    ledger.append(draft({
      type: 'TaskDispatchFailed', taskId: 'downstream', chatId: 'oc_goal',
      idempotencyKey: `dispatch-failed:${releaseId}:ambiguous`, ts: TS + 50,
      payload: {
        taskId: 'downstream', releaseId, planEventId: ledger.task('downstream')!.plan!.planEventId,
        planGeneration: 1, attempt: 0, failureClass: 'ambiguous', code: 'net:timeout',
        detail: 'request timed out', failedBy: 'daemon:cli_supervisor',
      },
    }));
    const intentAt = ledger.task('downstream')!.pendingRelease!.intentAt;

    expect(deriveTaskReleaseRisks({
      tasks: ledger.tasks(), events: ledger.read(), now: intentAt + TASK_RELEASE_AUTO_RETRY_WINDOW_MS - 1,
    })).toEqual([]);
    expect(deriveTaskReleaseRisks({
      tasks: ledger.tasks(), events: ledger.read(), now: intentAt + TASK_RELEASE_AUTO_RETRY_WINDOW_MS,
    })).toEqual([expect.objectContaining({
      taskId: 'downstream', kind: 'release_ambiguous_expired', releaseId,
    })]);
  });

  it('raises cancelled immediately, rejected only after the stall threshold, and ignores blocked upstream', () => {
    appendUpstream(ledger, 'cancelled');
    appendDownstreamPlan(ledger);
    expect(deriveTaskReleaseRisks({ tasks: ledger.tasks(), events: ledger.read(), now: TS + 31 })).toEqual([
      expect.objectContaining({ kind: 'dependency_cancelled', upstreamTaskId: 'upstream' }),
    ]);

    rmSync(baseDir, { recursive: true, force: true });
    baseDir = mkdtempSync(join(tmpdir(), 'vd-release-risk-'));
    ledger = openLedger({ baseDir });
    appendUpstream(ledger, 'rejected');
    appendDownstreamPlan(ledger);
    expect(deriveTaskReleaseRisks({
      tasks: ledger.tasks(), events: ledger.read(), now: TS + 20 + DEFAULT_REJECTED_DEPENDENCY_STALL_MS - 1,
    })).toEqual([]);
    expect(deriveTaskReleaseRisks({
      tasks: ledger.tasks(), events: ledger.read(), now: TS + 20 + DEFAULT_REJECTED_DEPENDENCY_STALL_MS,
    })).toEqual([expect.objectContaining({ kind: 'dependency_rejected_stalled', upstreamTaskId: 'upstream' })]);

    rmSync(baseDir, { recursive: true, force: true });
    baseDir = mkdtempSync(join(tmpdir(), 'vd-release-risk-'));
    ledger = openLedger({ baseDir });
    appendUpstream(ledger, 'blocked');
    appendDownstreamPlan(ledger);
    expect(deriveTaskReleaseRisks({ tasks: ledger.tasks(), events: ledger.read(), now: TS + 10_000_000 })).toEqual([]);
  });

  it('uses the default stall threshold for absent/invalid env values and accepts zero', () => {
    expect(resolveRejectedDependencyStallMs(undefined)).toBe(DEFAULT_REJECTED_DEPENDENCY_STALL_MS);
    expect(resolveRejectedDependencyStallMs('not-a-number')).toBe(DEFAULT_REJECTED_DEPENDENCY_STALL_MS);
    expect(resolveRejectedDependencyStallMs('-1')).toBe(DEFAULT_REJECTED_DEPENDENCY_STALL_MS);
    expect(resolveRejectedDependencyStallMs('0')).toBe(0);
  });
});
