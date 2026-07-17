import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openLedger, TASK_RELEASE_AUTO_RETRY_WINDOW_MS, type LedgerHandle } from '../src/verified-delivery/ledger.js';
import {
  buildTaskReleaseClaim,
  classifyReleaseSendFailure,
  confirmTaskRelease,
  retryTaskRelease,
  runGoalReleaseCheck,
  type ReleaseEngineDeps,
} from '../src/verified-delivery/release-engine.js';
import type { LedgerEventDraft, TaskPlannedPayload } from '../src/verified-delivery/types.js';
import { buildGoalAttentionContext } from '../src/core/goal-attention.js';

const TS = 1_700_000_000_000;

function draft(input: Partial<LedgerEventDraft> & Pick<LedgerEventDraft, 'type' | 'taskId' | 'idempotencyKey' | 'payload'>): LedgerEventDraft {
  return { actor: 'orchestrator', ts: TS, ...input } as LedgerEventDraft;
}

function seedReadyPlan(ledger: LedgerHandle): void {
  ledger.append(draft({
    type: 'TaskDispatched', taskId: 'upstream', chatId: 'oc_goal', idempotencyKey: 'dispatched:upstream',
    payload: { taskId: 'upstream', title: 'Produce API contract' },
  }));
  ledger.append(draft({
    type: 'TaskReported', actor: 'worker', taskId: 'upstream', chatId: 'oc_goal', idempotencyKey: 'reported:upstream:r1',
    payload: {
      taskId: 'upstream', reportId: 'upstream-r1', summary: 'contract ready',
      evidence: [
        { kind: 'url', url: 'https://ci.example.test/run/42' },
        { kind: 'inline', ref: 'sha256:abc', name: 'contract-summary', bytes: 123, preview: 'SECRET CONTENT' },
        { kind: 'path', path: '/remote/work/api.json' },
      ],
    },
  }));
  ledger.append(draft({
    type: 'TaskAccepted', taskId: 'upstream', chatId: 'oc_goal', idempotencyKey: 'accepted:upstream:r1',
    payload: { taskId: 'upstream', reportId: 'upstream-r1', checkedBy: 'ou_supervisor' },
  }));
  const payload: TaskPlannedPayload = {
    taskId: 'downstream',
    chatId: 'oc_goal',
    title: 'Consume API contract',
    dependsOnTaskIds: ['upstream'],
    planGeneration: 1,
    dispatchSpec: {
      title: 'Consume API contract',
      briefBase: 'Implement the client.',
      workers: [{
        openId: 'ou_worker', name: 'Worker', role: 'coder',
        larkAppId: 'cli_worker', cliId: 'codex', unionId: 'on_worker',
      }],
      senderLarkAppId: 'cli_supervisor',
      requiredRepo: 'github.com/acme/project',
      acceptanceHint: 'tests pass',
    },
    plannedBy: 'ou_supervisor',
  };
  ledger.append(draft({
    type: 'TaskPlanned', taskId: 'downstream', chatId: 'oc_goal', idempotencyKey: 'planned:downstream', payload,
  }));
}

describe('dependency release engine', () => {
  let baseDir: string;
  let ledger: LedgerHandle;
  let now: number;
  let send: ReturnType<typeof vi.fn<(input: Parameters<ReleaseEngineDeps['send']>[0]) => Promise<string>>>;
  let readiness: ReturnType<typeof vi.fn<ReleaseEngineDeps['checkReadiness']>>;
  let deps: ReleaseEngineDeps;

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), 'vd-release-'));
    ledger = openLedger({ baseDir });
    seedReadyPlan(ledger);
    now = TS + 100;
    send = vi.fn(async () => 'om_release');
    readiness = vi.fn(async () => ({ ok: true, issues: [] }));
    deps = {
      ledger,
      now: () => now,
      releasedBy: 'daemon:cli_supervisor',
      checkReadiness: readiness,
      send,
    };
  });

  afterEach(() => rmSync(baseDir, { recursive: true, force: true }));

  it('freezes upstream metadata, claims once, and dispatches with releaseId as the message uuid', async () => {
    const results = await runGoalReleaseCheck({
      goalChatId: 'oc_goal', ownerLarkAppId: 'cli_supervisor', mode: 'trigger', deps,
    });

    expect(results).toEqual([expect.objectContaining({ taskId: 'downstream', outcome: 'dispatched' })]);
    expect(send).toHaveBeenCalledTimes(1);
    const sent = send.mock.calls[0]![0];
    expect(sent.uuid).toMatch(/^rel1-[a-f0-9]{40}$/);
    expect(sent.recovery).toBe(false);
    expect(sent.text).toContain('https://ci.example.test/run/42');
    expect(sent.text).toContain('内联证据已由监管者验收（内容未自动转发）');
    expect(sent.text).toContain('/remote/work/api.json（不可跨设备访问）');
    expect(sent.text).not.toContain('SECRET CONTENT');
    expect(sent.text).toContain('botmux report --task downstream');
    expect(ledger.task('downstream')).toMatchObject({
      status: 'dispatched',
      latestReleaseId: sent.uuid,
      dispatchMessageId: 'om_release',
    });
  });

  it('leaves an existing claim to the recovery path instead of racing it from a trigger', async () => {
    const frozen = buildTaskReleaseClaim({ ledger, taskId: 'downstream', attempt: 0, releasedBy: deps.releasedBy });
    expect(frozen).toBeDefined();
    ledger.claimReadyPlan({
      taskId: 'downstream',
      expectedPlanEventId: frozen!.expectedPlanEventId,
      expectedAcceptedEventIds: frozen!.expectedAcceptedEventIds,
      ts: now,
      intent: frozen!.intent,
    });

    const result = await runGoalReleaseCheck({
      goalChatId: 'oc_goal', ownerLarkAppId: 'cli_supervisor', mode: 'trigger', deps,
    });
    expect(result[0]?.outcome).toBe('open-intent');
    expect(send).not.toHaveBeenCalled();

    const recovered = await runGoalReleaseCheck({
      goalChatId: 'oc_goal', ownerLarkAppId: 'cli_supervisor', mode: 'recovery', deps,
    });
    expect(recovered[0]?.outcome).toBe('dispatched');
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ uuid: frozen!.intent.releaseId, recovery: true }));
  });

  it('lets two recovery processes race safely on the same provider uuid and ledger key', async () => {
    const frozen = buildTaskReleaseClaim({ ledger, taskId: 'downstream', attempt: 0, releasedBy: deps.releasedBy })!;
    ledger.claimReadyPlan({
      taskId: 'downstream', expectedPlanEventId: frozen.expectedPlanEventId,
      expectedAcceptedEventIds: frozen.expectedAcceptedEventIds, ts: now, intent: frozen.intent,
    });
    send.mockImplementation(async () => {
      await Promise.resolve();
      return 'om_same_uuid';
    });

    const [a, b] = await Promise.all([
      runGoalReleaseCheck({ goalChatId: 'oc_goal', ownerLarkAppId: 'cli_supervisor', mode: 'recovery', deps }),
      runGoalReleaseCheck({ goalChatId: 'oc_goal', ownerLarkAppId: 'cli_supervisor', mode: 'recovery', deps }),
    ]);
    expect(a[0]?.outcome).toBe('dispatched');
    expect(b[0]?.outcome).toBe('dispatched');
    expect(send).toHaveBeenCalledTimes(2);
    expect(new Set(send.mock.calls.map((call) => call[0].uuid))).toEqual(new Set([frozen.intent.releaseId]));
    expect(ledger.read().filter((event) => event.type === 'TaskDispatched' && event.taskId === 'downstream')).toHaveLength(1);
  });

  it('recovers with the same uuid when the process dies after send but before TaskDispatched append', async () => {
    const frozen = buildTaskReleaseClaim({ ledger, taskId: 'downstream', attempt: 0, releasedBy: deps.releasedBy })!;
    ledger.claimReadyPlan({
      taskId: 'downstream', expectedPlanEventId: frozen.expectedPlanEventId,
      expectedAcceptedEventIds: frozen.expectedAcceptedEventIds, ts: now, intent: frozen.intent,
    });
    let crashOnce = true;
    const crashLedger: LedgerHandle = {
      ...ledger,
      append: (event) => {
        if (event.type === 'TaskDispatched' && crashOnce) {
          crashOnce = false;
          throw new Error('simulated crash before append');
        }
        return ledger.append(event);
      },
    };
    await expect(runGoalReleaseCheck({
      goalChatId: 'oc_goal', ownerLarkAppId: 'cli_supervisor', mode: 'recovery',
      deps: { ...deps, ledger: crashLedger },
    })).rejects.toThrow('simulated crash before append');
    expect(ledger.task('downstream')?.status).toBe('planned');

    await runGoalReleaseCheck({ goalChatId: 'oc_goal', ownerLarkAppId: 'cli_supervisor', mode: 'recovery', deps });
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0]![0].uuid).toBe(send.mock.calls[1]![0].uuid);
    expect(ledger.task('downstream')?.status).toBe('dispatched');
  });

  it('replays an ambiguous attempt within 55 minutes using the exact same uuid', async () => {
    send.mockRejectedValueOnce(Object.assign(new Error('request timed out'), { code: 'ETIMEDOUT' }));
    const first = await runGoalReleaseCheck({
      goalChatId: 'oc_goal', ownerLarkAppId: 'cli_supervisor', mode: 'trigger', deps,
    });
    expect(first[0]?.outcome).toBe('failed-ambiguous');
    const firstUuid = send.mock.calls[0]![0].uuid;

    now += 60_000;
    send.mockResolvedValueOnce('om_recovered');
    const recovered = await runGoalReleaseCheck({
      goalChatId: 'oc_goal', ownerLarkAppId: 'cli_supervisor', mode: 'recovery', deps,
    });
    expect(recovered[0]?.outcome).toBe('dispatched');
    expect(send.mock.calls[1]![0]).toMatchObject({ uuid: firstUuid, recovery: true });
    expect(ledger.read().filter((event) => event.type === 'TaskDispatchIntent')).toHaveLength(1);
    expect(ledger.task('downstream')?.dispatchMessageId).toBe('om_recovered');
  });

  it('persists a definite readiness failure and only retries it after explicit human approval', async () => {
    readiness.mockResolvedValueOnce({
      ok: false,
      issues: [{ severity: 'error', code: 'worker_not_in_chat', workerName: 'Worker', detail: '执行者不在目标群' }],
    });
    const failed = await runGoalReleaseCheck({
      goalChatId: 'oc_goal', ownerLarkAppId: 'cli_supervisor', mode: 'trigger', deps,
    });
    expect(failed[0]).toMatchObject({ outcome: 'failed-definite', code: 'readiness:worker_not_in_chat' });
    expect(send).not.toHaveBeenCalled();
    expect(buildGoalAttentionContext({ ledger, now }).releaseRisks?.get('downstream')).toMatchObject({
      bucket: 'systemRisk', reason: 'release:definite',
    });

    now += 5_000;
    const recovery = await runGoalReleaseCheck({
      goalChatId: 'oc_goal', ownerLarkAppId: 'cli_supervisor', mode: 'recovery', deps,
    });
    expect(recovery[0]?.outcome).toBe('waiting-human');

    readiness.mockResolvedValueOnce({ ok: true, issues: [] });
    const retried = await retryTaskRelease({ taskId: 'downstream', approvedBy: 'ou_supervisor', deps });
    expect(retried.outcome).toBe('dispatched');
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0].uuid).not.toBe(failed[0]?.releaseId);
    expect(ledger.read().filter((event) => event.type === 'TaskDispatchIntent')).toHaveLength(2);
  });

  it('persists a thrown readiness probe as retriable uncertainty without sending', async () => {
    readiness.mockRejectedValueOnce(new Error('members API unavailable'));
    const result = await runGoalReleaseCheck({
      goalChatId: 'oc_goal', ownerLarkAppId: 'cli_supervisor', mode: 'trigger', deps,
    });
    expect(result[0]).toMatchObject({
      outcome: 'failed-ambiguous', code: 'readiness:probe_failed', detail: 'members API unavailable',
    });
    expect(send).not.toHaveBeenCalled();
    expect(ledger.task('downstream')?.pendingRelease?.failure?.failureClass).toBe('ambiguous');
  });

  it('turns an expired ambiguous release into a human decision and supports confirm-as-sent', async () => {
    send.mockRejectedValueOnce(Object.assign(new Error('socket reset'), { code: 'ECONNRESET' }));
    const failed = await runGoalReleaseCheck({
      goalChatId: 'oc_goal', ownerLarkAppId: 'cli_supervisor', mode: 'trigger', deps,
    });
    const pending = ledger.task('downstream')!.pendingRelease!;
    expect(confirmTaskRelease({
      ledger, taskId: 'downstream', confirmedBy: 'ou_supervisor',
      now: pending.intentAt + TASK_RELEASE_AUTO_RETRY_WINDOW_MS - 1,
    }).outcome).toBe('waiting-human');

    now = pending.intentAt + TASK_RELEASE_AUTO_RETRY_WINDOW_MS;
    expect(buildGoalAttentionContext({ ledger, now }).releaseRisks?.get('downstream')).toMatchObject({
      bucket: 'systemRisk', reason: 'release:ambiguous_expired',
    });
    const recovery = await runGoalReleaseCheck({
      goalChatId: 'oc_goal', ownerLarkAppId: 'cli_supervisor', mode: 'recovery', deps,
    });
    expect(recovery[0]?.outcome).toBe('waiting-human');
    expect(send).toHaveBeenCalledTimes(1);

    const confirmed = confirmTaskRelease({ ledger, taskId: 'downstream', confirmedBy: 'ou_supervisor', now });
    expect(confirmed).toMatchObject({ outcome: 'dispatched', releaseId: failed[0]?.releaseId });
    expect(ledger.task('downstream')).toMatchObject({ status: 'dispatched', dispatchConfirmedBy: 'ou_supervisor' });
    expect(ledger.task('downstream')?.dispatchMessageId).toBeUndefined();
  });

  it('classifies provider rejection as definite and transport/server uncertainty as ambiguous', () => {
    expect(classifyReleaseSendFailure({ response: { status: 400 }, message: 'bad request' })).toMatchObject({
      failureClass: 'definite', code: 'http:400',
    });
    expect(classifyReleaseSendFailure({ response: { status: 503, data: { code: 999 } }, message: 'gateway' })).toMatchObject({
      failureClass: 'ambiguous', code: 'http:503',
    });
    expect(classifyReleaseSendFailure(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }))).toMatchObject({
      failureClass: 'ambiguous', code: 'net:timeout',
    });
    expect(classifyReleaseSendFailure(new Error('Failed to send message: invalid chat (code: 230001)'))).toMatchObject({
      failureClass: 'definite', code: 'lark:230001',
    });
  });
});
