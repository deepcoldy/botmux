import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  deriveTaskReleaseId,
  openLedger,
  TASK_RELEASE_AUTO_RETRY_WINDOW_MS,
  type LedgerHandle,
} from '../src/verified-delivery/ledger.js';
import type { LedgerEventDraft, TaskDispatchIntentPayload, TaskPlannedPayload } from '../src/verified-delivery/types.js';

const TS = 1_700_000_000_000;
function draft(p: Partial<LedgerEventDraft> & Pick<LedgerEventDraft, 'type' | 'taskId' | 'idempotencyKey' | 'payload'>): LedgerEventDraft {
  return { actor: 'orchestrator', ts: TS, ...p } as LedgerEventDraft;
}

function acceptDependency(ledger: LedgerHandle, taskId: string, chatId = 'oc_goal'): string {
  ledger.append(draft({
    type: 'TaskDispatched', taskId, chatId, idempotencyKey: `dispatched:${taskId}`,
    payload: { taskId, title: taskId },
  }));
  ledger.append(draft({
    type: 'TaskReported', actor: 'worker', taskId, chatId, idempotencyKey: `reported:${taskId}:r1`,
    payload: { taskId, reportId: `${taskId}-r1`, summary: 'done', evidence: [{ kind: 'path', path: `/tmp/${taskId}` }] },
  }));
  const accepted = ledger.append(draft({
    type: 'TaskAccepted', taskId, chatId, idempotencyKey: `accepted:${taskId}:r1`,
    payload: { taskId, reportId: `${taskId}-r1`, checkedBy: 'supervisor' },
  }));
  return accepted.event.eventId;
}

function planPayload(input: {
  taskId?: string;
  dependsOnTaskIds?: string[];
  generation?: number;
  reopenOfCancelEventId?: string;
  brief?: string;
} = {}): TaskPlannedPayload {
  const taskId = input.taskId ?? 'downstream';
  return {
    taskId,
    chatId: 'oc_goal',
    title: 'downstream work',
    dependsOnTaskIds: input.dependsOnTaskIds ?? ['upstream'],
    planGeneration: input.generation ?? 1,
    reopenOfCancelEventId: input.reopenOfCancelEventId,
    dispatchSpec: {
      title: 'downstream work',
      briefBase: input.brief ?? 'consume upstream output',
      workers: [{ openId: 'ou_worker', name: 'Worker', role: 'coder', larkAppId: 'cli_worker', cliId: 'codex', unionId: 'on_worker' }],
      senderLarkAppId: 'cli_supervisor',
      requiredRepo: 'github.com/acme/project',
      acceptanceHint: 'check output',
    },
    plannedBy: 'ou_supervisor',
  };
}

function releaseIntent(input: {
  taskId?: string;
  planEventId: string;
  acceptedEventId: string;
  attempt?: number;
  releasedBy?: string;
}): TaskDispatchIntentPayload {
  const taskId = input.taskId ?? 'downstream';
  const attempt = input.attempt ?? 0;
  const releaseId = deriveTaskReleaseId(input.planEventId, [input.acceptedEventId], attempt);
  const workers = [{ openId: 'ou_worker', name: 'Worker', role: 'coder', larkAppId: 'cli_worker', cliId: 'codex', unionId: 'on_worker' }];
  return {
    taskId,
    releaseId,
    attempt,
    planEventId: input.planEventId,
    planGeneration: 1,
    satisfiedBy: [{ taskId: 'upstream', acceptedEventId: input.acceptedEventId }],
    senderLarkAppId: 'cli_supervisor',
    goalChatId: 'oc_goal',
    frozenKickoffText: '<at user_id="ou_worker"></at>\nconsume upstream output',
    frozenWorkerSpecs: workers,
    frozenDispatchedPayload: {
      taskId,
      title: 'downstream work',
      workerOpenIds: ['ou_worker'],
      workerNames: ['Worker'],
      workerLarkAppIds: ['cli_worker'],
      workerCliIds: ['codex'],
      workerBotUnionIds: ['on_worker'],
      requiredRepo: 'github.com/acme/project',
      acceptanceHint: 'check output',
      brief: 'consume upstream output',
      releaseId,
    },
    releasedBy: input.releasedBy ?? 'daemon:cli_supervisor',
  };
}

describe('verified-delivery ledger', () => {
  let baseDir: string;
  beforeEach(() => { baseDir = mkdtempSync(join(tmpdir(), 'vd-ledger-')); });
  afterEach(() => { rmSync(baseDir, { recursive: true, force: true }); });

  it('dispatch → report → accept materializes the full task lifecycle', () => {
    const led = openLedger({ baseDir });
    led.append(draft({
      type: 'TaskDispatched', actor: 'orchestrator', taskId: 'task-1', chatId: 'oc_x', idempotencyKey: 'dispatched:task-1',
      payload: { taskId: 'task-1', title: 'do X', workerTopicRoot: 'om_root', workerOpenIds: ['ou_w'], requiredRepo: 'github.com/acme/project', acceptanceHint: 'run check.py exit 0' },
    }));
    const inline = led.writeInlineEvidence('PASS: all good\n', 'check-output');
    led.append(draft({
      type: 'TaskReported', actor: 'worker', taskId: 'task-1', chatId: 'oc_x', idempotencyKey: 'reported:r1',
      payload: { taskId: 'task-1', reportId: 'r1', workerOpenId: 'ou_w', summary: 'done', evidence: [{ kind: 'path', path: '/tmp/out.json' }, inline] },
    }));
    led.append(draft({
      type: 'TaskAccepted', taskId: 'task-1', idempotencyKey: 'accepted:task-1:r1',
      payload: { taskId: 'task-1', reportId: 'r1', checkedBy: 'ou_orch', ranCommands: ['python check.py'], evidenceChecked: ['/tmp/out.json'] },
    }));

    const t = led.task('task-1')!;
    expect(t.status).toBe('accepted');
    expect(t.acceptedEventId).toBe('3');
    expect(t.acceptanceHint).toBe('run check.py exit 0');
    expect(t.workerTopicRoot).toBe('om_root');
    expect(t.requiredRepo).toBe('github.com/acme/project');
    expect(t.reports).toHaveLength(1);
    expect(t.reports[0]).toMatchObject({ reportId: 'r1', verdict: 'accepted', ranCommands: ['python check.py'] });
    expect(t.reports[0].evidence).toHaveLength(2);
    expect(led.readInlineEvidence(inline.ref)).toBe('PASS: all good\n');
  });

  it('reject then re-report flips status back to reported (same task, new attempt)', () => {
    const led = openLedger({ baseDir });
    led.append(draft({ type: 'TaskDispatched', taskId: 'task-2', idempotencyKey: 'dispatched:task-2', payload: { taskId: 'task-2' } }));
    led.append(draft({ type: 'TaskReported', actor: 'worker', taskId: 'task-2', idempotencyKey: 'reported:r1', payload: { taskId: 'task-2', reportId: 'r1', summary: 'attempt 1', evidence: [{ kind: 'path', path: '/tmp/a' }] } }));
    led.append(draft({ type: 'TaskRejected', taskId: 'task-2', idempotencyKey: 'rejected:task-2:r1', payload: { taskId: 'task-2', reportId: 'r1', reason: 'missing report.md', retryBrief: 'also write report.md' } }));
    expect(led.task('task-2')!.status).toBe('rejected');
    expect(led.task('task-2')!.reports[0]).toMatchObject({ verdict: 'rejected', reason: 'missing report.md' });

    led.append(draft({ type: 'TaskReported', actor: 'worker', taskId: 'task-2', idempotencyKey: 'reported:r2', payload: { taskId: 'task-2', reportId: 'r2', summary: 'attempt 2', evidence: [{ kind: 'path', path: '/tmp/b' }] } }));
    const t = led.task('task-2')!;
    expect(t.status).toBe('reported');
    expect(t.latestReportId).toBe('r2');
    expect(t.reports).toHaveLength(2);
    expect(t.reports[0].verdict).toBe('rejected'); // attempt 1 keeps its verdict
  });

  it('keeps an accepted task terminal when a delayed report arrives', () => {
    const led = openLedger({ baseDir });
    led.append(draft({ type: 'TaskDispatched', taskId: 'task-late', idempotencyKey: 'dispatched:task-late', payload: { taskId: 'task-late' } }));
    led.append(draft({ type: 'TaskReported', actor: 'worker', taskId: 'task-late', idempotencyKey: 'reported:r1', payload: { taskId: 'task-late', reportId: 'r1', summary: 'done', evidence: [{ kind: 'path', path: '/tmp/a' }] } }));
    led.append(draft({ type: 'TaskAccepted', taskId: 'task-late', idempotencyKey: 'accepted:task-late:r1', payload: { taskId: 'task-late', reportId: 'r1', checkedBy: 'sup' } }));
    led.append(draft({ type: 'TaskReported', actor: 'worker', taskId: 'task-late', idempotencyKey: 'reported:r2', payload: { taskId: 'task-late', reportId: 'r2', summary: 'delayed retry', evidence: [{ kind: 'path', path: '/tmp/b' }] } }));

    const t = led.task('task-late')!;
    expect(t.status).toBe('accepted');
    expect(t.latestReportId).toBe('r1');
    expect(t.reports).toHaveLength(2);
    expect(t.reports.find((r) => r.reportId === 'r1')?.verdict).toBe('accepted');
    expect(t.reports.find((r) => r.reportId === 'r2')?.verdict).toBeUndefined();
  });

  it('keeps a cancelled task terminal until an explicit re-dispatch', () => {
    const led = openLedger({ baseDir });
    led.append(draft({ type: 'TaskDispatched', taskId: 'task-cancel', idempotencyKey: 'dispatched:task-cancel', payload: { taskId: 'task-cancel' } }));
    led.append(draft({ type: 'TaskReported', actor: 'worker', taskId: 'task-cancel', idempotencyKey: 'reported:c1', payload: { taskId: 'task-cancel', reportId: 'c1', summary: 'first', evidence: [{ kind: 'path', path: '/tmp/a' }] } }));
    led.append(draft({ type: 'TaskCancelled', taskId: 'task-cancel', idempotencyKey: 'cancelled:task-cancel', payload: { taskId: 'task-cancel', reason: '超出目标范围', by: 'sup' } }));
    led.append(draft({ type: 'TaskReported', actor: 'worker', taskId: 'task-cancel', idempotencyKey: 'reported:c2', payload: { taskId: 'task-cancel', reportId: 'c2', summary: 'late', evidence: [{ kind: 'path', path: '/tmp/b' }] } }));
    led.append(draft({ type: 'TaskAccepted', taskId: 'task-cancel', idempotencyKey: 'accepted:task-cancel:c1', payload: { taskId: 'task-cancel', reportId: 'c1', checkedBy: 'late-sup' } }));
    led.append(draft({ type: 'TaskRejected', taskId: 'task-cancel', idempotencyKey: 'rejected:task-cancel:c2', payload: { taskId: 'task-cancel', reportId: 'c2', reason: 'late-reject' } }));
    led.append(draft({ type: 'TaskHelpRequested', actor: 'worker', taskId: 'task-cancel', idempotencyKey: 'help:task-cancel:late', payload: { taskId: 'task-cancel', blocker: 'late help' } }));

    const cancelled = led.task('task-cancel')!;
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.latestReportId).toBe('c1');
    expect(cancelled.cancellation).toEqual({ reason: '超出目标范围', by: 'sup' });
    expect(cancelled.reports).toHaveLength(2);

    led.append(draft({ type: 'TaskDispatched', taskId: 'task-cancel', idempotencyKey: 'dispatched:task-cancel:redo', payload: { taskId: 'task-cancel', brief: '恢复执行' } }));
    const reopened = led.task('task-cancel')!;
    expect(reopened.status).toBe('dispatched');
    expect(reopened.latestReportId).toBeUndefined();
    expect(reopened.cancellation).toBeUndefined();

    led.append(draft({ type: 'TaskCancelled', taskId: 'task-cancel', idempotencyKey: 'cancelled:task-cancel:redo', payload: { taskId: 'task-cancel', reason: '第二轮也取消', by: 'sup' } }));
    expect(led.task('task-cancel')).toMatchObject({ status: 'cancelled', cancellation: { reason: '第二轮也取消' } });
  });

  it('refuses cancelling an accepted or unknown task', () => {
    const led = openLedger({ baseDir });
    expect(() => led.append(draft({ type: 'TaskCancelled', taskId: 'missing', idempotencyKey: 'cancelled:missing', payload: { taskId: 'missing', reason: 'x' } })))
      .toThrow(/requires an existing task/);

    led.append(draft({ type: 'TaskDispatched', taskId: 'task-accepted', idempotencyKey: 'dispatched:task-accepted', payload: { taskId: 'task-accepted' } }));
    led.append(draft({ type: 'TaskReported', actor: 'worker', taskId: 'task-accepted', idempotencyKey: 'reported:a1', payload: { taskId: 'task-accepted', reportId: 'a1', summary: 'done', evidence: [{ kind: 'path', path: '/tmp/a' }] } }));
    led.append(draft({ type: 'TaskAccepted', taskId: 'task-accepted', idempotencyKey: 'accepted:task-accepted:a1', payload: { taskId: 'task-accepted', reportId: 'a1', checkedBy: 'sup' } }));
    expect(() => led.append(draft({ type: 'TaskCancelled', taskId: 'task-accepted', idempotencyKey: 'cancelled:task-accepted', payload: { taskId: 'task-accepted', reason: 'too late' } })))
      .toThrow(/accepted task cannot be cancelled/);
  });

  it('defensively ignores illegal cancellation events during historical replay', () => {
    const rows = [
      { type: 'TaskDispatched', actor: 'orchestrator', taskId: 'accepted-task', ts: TS, idempotencyKey: 'd:a', payload: { taskId: 'accepted-task' }, eventId: '1', seq: 1 },
      { type: 'TaskReported', actor: 'worker', taskId: 'accepted-task', ts: TS + 1, idempotencyKey: 'r:a', payload: { taskId: 'accepted-task', reportId: 'ra', summary: 'done', evidence: [{ kind: 'path', path: '/tmp/a' }] }, eventId: '2', seq: 2 },
      { type: 'TaskAccepted', actor: 'orchestrator', taskId: 'accepted-task', ts: TS + 2, idempotencyKey: 'a:a', payload: { taskId: 'accepted-task', reportId: 'ra' }, eventId: '3', seq: 3 },
      { type: 'TaskCancelled', actor: 'orchestrator', taskId: 'accepted-task', ts: TS + 3, idempotencyKey: 'c:a', payload: { taskId: 'accepted-task', reason: 'illegal late cancel' }, eventId: '4', seq: 4 },
      { type: 'TaskCancelled', actor: 'orchestrator', taskId: 'ghost-task', ts: TS + 4, idempotencyKey: 'c:ghost', payload: { taskId: 'ghost-task', reason: 'illegal orphan' }, eventId: '5', seq: 5 },
    ];
    writeFileSync(join(baseDir, 'ledger.ndjson'), rows.map((row) => JSON.stringify(row)).join('\n') + '\n');

    const led = openLedger({ baseDir });
    expect(led.task('accepted-task')).toMatchObject({ status: 'accepted' });
    expect(led.task('accepted-task')?.cancellation).toBeUndefined();
    expect(led.task('ghost-task')).toBeUndefined();
  });

  it('a late verdict for a superseded report does not drag the new attempt back', () => {
    const led = openLedger({ baseDir });
    led.append(draft({ type: 'TaskDispatched', taskId: 'task-4', idempotencyKey: 'dispatched:task-4', payload: { taskId: 'task-4' } }));
    led.append(draft({ type: 'TaskReported', actor: 'worker', taskId: 'task-4', idempotencyKey: 'reported:r1', payload: { taskId: 'task-4', reportId: 'r1', summary: 'a1', evidence: [{ kind: 'path', path: '/tmp/a' }] } }));
    led.append(draft({ type: 'TaskRejected', taskId: 'task-4', idempotencyKey: 'rejected:task-4:r1', payload: { taskId: 'task-4', reportId: 'r1', reason: 'insufficient' } }));
    led.append(draft({ type: 'TaskReported', actor: 'worker', taskId: 'task-4', idempotencyKey: 'reported:r2', payload: { taskId: 'task-4', reportId: 'r2', summary: 'a2', evidence: [{ kind: 'path', path: '/tmp/b' }] } }));
    // a stray late accept for the OLD report r1 arrives after r2 is the live attempt
    led.append(draft({ type: 'TaskAccepted', taskId: 'task-4', idempotencyKey: 'accepted:task-4:r1', payload: { taskId: 'task-4', reportId: 'r1' } }));

    const t = led.task('task-4')!;
    expect(t.status).toBe('reported');       // still on r2, NOT dragged to accepted
    expect(t.latestReportId).toBe('r2');
    expect(t.reports.find((r) => r.reportId === 'r1')!.verdict).toBe('accepted'); // r1 still records its (late) verdict
  });

  it('TaskReported with no evidence is refused at the seam', () => {
    const led = openLedger({ baseDir });
    led.append(draft({ type: 'TaskDispatched', taskId: 'task-5', idempotencyKey: 'dispatched:task-5', payload: { taskId: 'task-5' } }));
    expect(() => led.append(draft({
      type: 'TaskReported', actor: 'worker', taskId: 'task-5', idempotencyKey: 'reported:empty',
      payload: { taskId: 'task-5', reportId: 'empty', summary: 'no proof', evidence: [] },
    }))).toThrow(/at least one evidence/);
  });

  it('refuses taskId mismatches and malformed core fields at the append seam', () => {
    const led = openLedger({ baseDir });
    expect(() => led.append(draft({
      type: 'TaskDispatched',
      taskId: 'task-a',
      idempotencyKey: 'dispatched:task-a',
      payload: { taskId: 'task-b' },
    }))).toThrow(/payload\.taskId must match/);
    expect(() => led.append(draft({
      type: 'TaskDispatched',
      taskId: '',
      idempotencyKey: 'dispatched:empty',
      payload: { taskId: '' },
    }))).toThrow(/taskId must be non-empty/);
    expect(() => led.append(draft({
      type: 'TaskCancelled',
      taskId: 'task-cancel-empty',
      idempotencyKey: 'cancelled:task-cancel-empty',
      payload: { taskId: 'task-cancel-empty', reason: '   ' },
    }))).toThrow(/TaskCancelled\.reason/);
  });

  it('refuses misaligned worker metadata and malformed acceptanceCriteria', () => {
    const led = openLedger({ baseDir });
    expect(() => led.append(draft({
      type: 'TaskDispatched',
      taskId: 'task-repo',
      idempotencyKey: 'dispatched:task-repo',
      payload: { taskId: 'task-repo', requiredRepo: '   ' },
    }))).toThrow(/requiredRepo must be non-empty/);
    expect(() => led.append(draft({
      type: 'TaskDispatched',
      taskId: 'task-meta',
      idempotencyKey: 'dispatched:task-meta',
      payload: { taskId: 'task-meta', workerOpenIds: ['ou_a', 'ou_b'], workerLarkAppIds: ['cli_a'] },
    }))).toThrow(/workerLarkAppIds must be index-aligned/);
    expect(() => led.append(draft({
      type: 'TaskDispatched',
      taskId: 'task-criteria',
      idempotencyKey: 'dispatched:task-criteria',
      payload: { taskId: 'task-criteria', acceptanceCriteria: { version: 1, artifacts: [{ path: '', checks: [] }] } },
    }))).toThrow(/acceptanceCriteria invalid/);
  });

  it('refuses malformed evidence, help kind, and empty verdict/escalation fields', () => {
    const led = openLedger({ baseDir });
    expect(() => led.append(draft({
      type: 'TaskReported',
      actor: 'worker',
      taskId: 'task-ev',
      idempotencyKey: 'reported:bad-path',
      payload: { taskId: 'task-ev', reportId: 'r1', summary: 'bad', evidence: [{ kind: 'path', path: '' }] },
    }))).toThrow(/evidence\[0\]\.path/);
    expect(() => led.append(draft({
      type: 'TaskReported',
      actor: 'worker',
      taskId: 'task-ev',
      idempotencyKey: 'reported:bad-url',
      payload: { taskId: 'task-ev', reportId: 'r2', summary: 'bad', evidence: [{ kind: 'url', url: 'ftp://example.test/a' }] },
    }))).toThrow(/http or https/);
    expect(() => led.append(draft({
      type: 'TaskHelpRequested',
      actor: 'worker',
      taskId: 'task-help',
      idempotencyKey: 'help:bad-kind',
      payload: { taskId: 'task-help', blocker: 'blocked', kind: 'mystery' as never },
    }))).toThrow(/kind is invalid/);
    expect(() => led.append(draft({
      type: 'TaskAccepted',
      taskId: 'task-acc',
      idempotencyKey: 'accepted:empty-report',
      payload: { taskId: 'task-acc', reportId: '' },
    }))).toThrow(/TaskAccepted\.reportId/);
    expect(() => led.append(draft({
      type: 'TaskEscalated',
      taskId: 'task-esc',
      idempotencyKey: 'escalated:empty',
      payload: { taskId: 'task-esc', reason: '' },
    }))).toThrow(/TaskEscalated\.reason/);
  });

  it('keeps deferred invariants backward-compatible for now', () => {
    const led = openLedger({ baseDir });
    expect(() => led.append(draft({
      type: 'TaskReported',
      taskId: 'task-legacy-report',
      idempotencyKey: 'reported:legacy-actor',
      payload: { taskId: 'task-legacy-report', reportId: 'r1', summary: 'legacy actor', evidence: [{ kind: 'path', path: '/tmp/a' }] },
    }))).not.toThrow();
    expect(() => led.append(draft({
      type: 'TaskHelpRequested',
      taskId: 'task-legacy-help',
      idempotencyKey: 'help:legacy-actor',
      payload: { taskId: 'task-legacy-help', blocker: 'legacy actor' },
    }))).not.toThrow();
    expect(() => led.append(draft({
      type: 'TaskAccepted',
      taskId: 'task-legacy-accept',
      idempotencyKey: 'accepted:legacy-light',
      payload: { taskId: 'task-legacy-accept', reportId: 'r1' },
    }))).not.toThrow();
    expect(() => led.append(draft({
      type: 'TaskRejected',
      taskId: 'task-legacy-reject',
      idempotencyKey: 'rejected:legacy-free-text',
      payload: { taskId: 'task-legacy-reject', reportId: 'r1', reason: 'missing report.md' },
    }))).not.toThrow();
  });

  it('idempotent append: same key twice is a no-op', () => {
    const led = openLedger({ baseDir });
    const a = led.append(draft({ type: 'TaskDispatched', taskId: 'task-3', idempotencyKey: 'dispatched:task-3', payload: { taskId: 'task-3' } }));
    const b = led.append(draft({ type: 'TaskDispatched', taskId: 'task-3', idempotencyKey: 'dispatched:task-3', payload: { taskId: 'task-3' } }));
    expect(a.deduped).toBe(false);
    expect(b.deduped).toBe(true);
    expect(b.event.seq).toBe(a.event.seq);
    expect(led.read()).toHaveLength(1);
  });

  it('materializes a dependency-gated plan and rejects early lifecycle events', () => {
    const led = openLedger({ baseDir });
    acceptDependency(led, 'upstream');
    const planned = led.append(draft({
      type: 'TaskPlanned', taskId: 'downstream', chatId: 'oc_goal', idempotencyKey: 'planned:downstream',
      payload: planPayload(),
    }));

    expect(led.task('downstream')).toMatchObject({
      status: 'planned',
      activationEventId: planned.event.eventId,
      plan: {
        planEventId: planned.event.eventId,
        planGeneration: 1,
        dependsOnTaskIds: ['upstream'],
      },
      workerNames: ['Worker'],
      requiredRepo: 'github.com/acme/project',
    });
    expect(() => led.append(draft({
      type: 'TaskReported', actor: 'worker', taskId: 'downstream', chatId: 'oc_goal', idempotencyKey: 'reported:too-early',
      payload: { taskId: 'downstream', reportId: 'early', summary: 'not actually dispatched', evidence: [{ kind: 'path', path: '/tmp/early' }] },
    }))).toThrow(/has not been dispatched/);
    expect(() => led.append(draft({
      type: 'TaskHelpRequested', actor: 'worker', taskId: 'downstream', chatId: 'oc_goal', idempotencyKey: 'help:too-early',
      payload: { taskId: 'downstream', blocker: 'too early' },
    }))).toThrow(/has not been dispatched/);
    expect(() => led.append(draft({
      type: 'TaskDispatched', taskId: 'downstream', chatId: 'oc_goal', idempotencyKey: 'dispatched:bypass',
      payload: { taskId: 'downstream', title: 'bypass' },
    }))).toThrow(/current open release/);
    const fakeIntent = releaseIntent({ planEventId: planned.event.eventId, acceptedEventId: led.task('upstream')!.acceptedEventId! });
    expect(() => led.append(draft({
      type: 'TaskDispatchIntent', taskId: 'downstream', chatId: 'oc_goal', idempotencyKey: `intent:${fakeIntent.releaseId}`,
      payload: fakeIntent,
    }))).toThrow(/claimReadyPlan/);
    expect(led.read().filter((event) => event.taskId === 'downstream')).toHaveLength(1);
  });

  it('claims a ready plan once, persists failure classification, then dispatches it', () => {
    const led = openLedger({ baseDir });
    const acceptedEventId = acceptDependency(led, 'upstream');
    const planned = led.append(draft({
      type: 'TaskPlanned', taskId: 'downstream', chatId: 'oc_goal', idempotencyKey: 'planned:downstream',
      payload: planPayload(),
    }));
    const intent = releaseIntent({ planEventId: planned.event.eventId, acceptedEventId });

    expect(led.claimReadyPlan({
      taskId: 'downstream',
      expectedPlanEventId: planned.event.eventId,
      expectedAcceptedEventIds: ['stale-accept'],
      ts: TS + 10,
      intent,
    })).toEqual({ result: 'stale' });

    const first = led.claimReadyPlan({
      taskId: 'downstream',
      expectedPlanEventId: planned.event.eventId,
      expectedAcceptedEventIds: [acceptedEventId],
      ts: TS + 11,
      intent,
    });
    expect(first.result).toBe('created');
    const second = led.claimReadyPlan({
      taskId: 'downstream',
      expectedPlanEventId: planned.event.eventId,
      expectedAcceptedEventIds: [acceptedEventId],
      ts: TS + 12,
      intent,
    });
    expect(second.result).toBe('open-intent');
    expect(led.read().filter((event) => event.type === 'TaskDispatchIntent')).toHaveLength(1);

    led.append(draft({
      type: 'TaskDispatchFailed', taskId: 'downstream', chatId: 'oc_goal',
      idempotencyKey: `dispatch-failed:${intent.releaseId}:ambiguous`, ts: TS + 13,
      payload: {
        taskId: 'downstream', releaseId: intent.releaseId, planEventId: intent.planEventId,
        planGeneration: 1, attempt: 0, failureClass: 'ambiguous', code: 'net:timeout',
        detail: 'request timed out', failedBy: 'daemon:cli_supervisor',
      },
    }));
    expect(led.task('downstream')?.pendingRelease?.failure).toMatchObject({
      failureClass: 'ambiguous', code: 'net:timeout',
    });

    expect(() => led.append(draft({
      type: 'TaskDispatched', taskId: 'downstream', chatId: 'oc_goal',
      idempotencyKey: `dispatched:release:${intent.releaseId}`, ts: TS + 14,
      payload: { ...intent.frozenDispatchedPayload, title: 'mutated after claim', dispatchMessageId: 'om_bad' },
    }))).toThrow(/payload must match the frozen release intent/);

    led.append(draft({
      type: 'TaskDispatched', taskId: 'downstream', chatId: 'oc_goal',
      idempotencyKey: `dispatched:release:${intent.releaseId}`, ts: TS + 15,
      payload: { ...intent.frozenDispatchedPayload, dispatchMessageId: 'om_release' },
    }));
    expect(led.task('downstream')).toMatchObject({
      status: 'dispatched',
      latestReleaseId: intent.releaseId,
      dispatchMessageId: 'om_release',
    });
    expect(led.task('downstream')?.pendingRelease).toBeUndefined();
  });

  it('claims an attempt+1 release only after the previous release is safe for manual retry', () => {
    const led = openLedger({ baseDir });
    const acceptedEventId = acceptDependency(led, 'upstream');
    const planned = led.append(draft({
      type: 'TaskPlanned', taskId: 'downstream', chatId: 'oc_goal', idempotencyKey: 'planned:downstream',
      payload: planPayload(),
    }));
    const firstIntent = releaseIntent({ planEventId: planned.event.eventId, acceptedEventId });
    expect(led.claimReadyPlan({
      taskId: 'downstream', expectedPlanEventId: planned.event.eventId,
      expectedAcceptedEventIds: [acceptedEventId], ts: TS + 10, intent: firstIntent,
    }).result).toBe('created');

    const retryIntent = releaseIntent({
      planEventId: planned.event.eventId,
      acceptedEventId,
      attempt: 1,
      releasedBy: 'ou_supervisor',
    });
    const retryInput = {
      taskId: 'downstream',
      expectedReleaseId: firstIntent.releaseId,
      approvedBy: 'ou_supervisor',
      ts: TS + 10 + TASK_RELEASE_AUTO_RETRY_WINDOW_MS - 1,
      intent: retryIntent,
    };
    expect(led.claimRetryRelease(retryInput)).toEqual({ result: 'not-retryable' });
    expect(led.claimRetryRelease({ ...retryInput, approvedBy: 'ou_other' })).toEqual({ result: 'not-retryable' });

    const created = led.claimRetryRelease({
      ...retryInput,
      ts: TS + 10 + TASK_RELEASE_AUTO_RETRY_WINDOW_MS,
    });
    expect(created.result).toBe('created');
    expect(led.task('downstream')?.pendingRelease).toMatchObject({
      releaseId: retryIntent.releaseId,
      attempt: 1,
      releasedBy: 'ou_supervisor',
    });
    expect(led.claimRetryRelease({
      ...retryInput,
      expectedReleaseId: retryIntent.releaseId,
      ts: TS + 10 + TASK_RELEASE_AUTO_RETRY_WINDOW_MS + 1,
    }).result).toBe('not-retryable');
    expect(led.read().filter((event) => event.type === 'TaskDispatchIntent')).toHaveLength(2);
  });

  it('allows an explicitly approved retry immediately after a definite failure', () => {
    const led = openLedger({ baseDir });
    const acceptedEventId = acceptDependency(led, 'upstream');
    const planned = led.append(draft({
      type: 'TaskPlanned', taskId: 'downstream', chatId: 'oc_goal', idempotencyKey: 'planned:downstream',
      payload: planPayload(),
    }));
    const firstIntent = releaseIntent({ planEventId: planned.event.eventId, acceptedEventId });
    led.claimReadyPlan({
      taskId: 'downstream', expectedPlanEventId: planned.event.eventId,
      expectedAcceptedEventIds: [acceptedEventId], ts: TS + 10, intent: firstIntent,
    });
    led.append(draft({
      type: 'TaskDispatchFailed', taskId: 'downstream', chatId: 'oc_goal',
      idempotencyKey: `dispatch-failed:${firstIntent.releaseId}:definite`, ts: TS + 11,
      payload: {
        taskId: 'downstream', releaseId: firstIntent.releaseId, planEventId: firstIntent.planEventId,
        planGeneration: 1, attempt: 0, failureClass: 'definite', code: 'readiness:worker_not_in_chat',
        detail: 'worker is not in the goal chat', failedBy: 'daemon:cli_supervisor',
      },
    }));
    const retryIntent = releaseIntent({
      planEventId: planned.event.eventId,
      acceptedEventId,
      attempt: 1,
      releasedBy: 'ou_supervisor',
    });
    expect(led.claimRetryRelease({
      taskId: 'downstream', expectedReleaseId: firstIntent.releaseId,
      approvedBy: 'ou_supervisor', ts: TS + 12, intent: retryIntent,
    }).result).toBe('created');
  });

  it('rejects a retry claim when its release id, attempt, or dependency snapshot is stale', () => {
    const led = openLedger({ baseDir });
    const acceptedEventId = acceptDependency(led, 'upstream');
    const planned = led.append(draft({
      type: 'TaskPlanned', taskId: 'downstream', chatId: 'oc_goal', idempotencyKey: 'planned:downstream',
      payload: planPayload(),
    }));
    const firstIntent = releaseIntent({ planEventId: planned.event.eventId, acceptedEventId });
    led.claimReadyPlan({
      taskId: 'downstream', expectedPlanEventId: planned.event.eventId,
      expectedAcceptedEventIds: [acceptedEventId], ts: TS + 10, intent: firstIntent,
    });
    const retryIntent = releaseIntent({
      planEventId: planned.event.eventId,
      acceptedEventId,
      attempt: 1,
      releasedBy: 'ou_supervisor',
    });
    const ts = TS + 10 + TASK_RELEASE_AUTO_RETRY_WINDOW_MS;
    expect(led.claimRetryRelease({
      taskId: 'downstream', expectedReleaseId: 'rel1-stale', approvedBy: 'ou_supervisor', ts, intent: retryIntent,
    })).toEqual({ result: 'stale' });
    expect(led.claimRetryRelease({
      taskId: 'downstream', expectedReleaseId: firstIntent.releaseId, approvedBy: 'ou_supervisor', ts,
      intent: { ...retryIntent, attempt: 2 },
    })).toEqual({ result: 'stale' });
    expect(led.claimRetryRelease({
      taskId: 'downstream', expectedReleaseId: firstIntent.releaseId, approvedBy: 'ou_supervisor', ts,
      intent: {
        ...retryIntent,
        releaseId: 'rel1-forged',
        frozenDispatchedPayload: { ...retryIntent.frozenDispatchedPayload, releaseId: 'rel1-forged' },
      },
    })).toEqual({ result: 'stale' });
  });

  it('returns not-ready until every dependency has a real accepted transition', () => {
    const led = openLedger({ baseDir });
    led.append(draft({
      type: 'TaskDispatched', taskId: 'upstream', chatId: 'oc_goal', idempotencyKey: 'dispatched:upstream',
      payload: { taskId: 'upstream' },
    }));
    const planned = led.append(draft({
      type: 'TaskPlanned', taskId: 'downstream', chatId: 'oc_goal', idempotencyKey: 'planned:downstream',
      payload: planPayload(),
    }));
    const placeholder = releaseIntent({ planEventId: planned.event.eventId, acceptedEventId: 'not-accepted' });
    expect(led.claimReadyPlan({
      taskId: 'downstream', expectedPlanEventId: planned.event.eventId,
      expectedAcceptedEventIds: ['not-accepted'], ts: TS + 1, intent: placeholder,
    })).toEqual({ result: 'not-ready' });
    expect(led.read().some((event) => event.type === 'TaskDispatchIntent')).toBe(false);
  });

  it('reopens a cancelled plan with immutable edges and a new activation id', () => {
    const led = openLedger({ baseDir });
    acceptDependency(led, 'upstream');
    acceptDependency(led, 'other-upstream');
    const gen1 = led.append(draft({
      type: 'TaskPlanned', taskId: 'downstream', chatId: 'oc_goal', idempotencyKey: 'planned:downstream',
      payload: planPayload(),
    }));
    const cancel1 = led.append(draft({
      type: 'TaskCancelled', taskId: 'downstream', chatId: 'oc_goal',
      idempotencyKey: `cancelled:downstream:${gen1.event.eventId}`,
      payload: { taskId: 'downstream', reason: 'pause generation 1' },
    }));
    expect(() => led.append(draft({
      type: 'TaskPlanned', taskId: 'downstream', chatId: 'oc_goal', idempotencyKey: `planned:downstream:${cancel1.event.eventId}`,
      payload: planPayload({ generation: 2, reopenOfCancelEventId: cancel1.event.eventId, dependsOnTaskIds: ['other-upstream'] }),
    }))).toThrow(/dependencies are immutable/);

    const gen2 = led.append(draft({
      type: 'TaskPlanned', taskId: 'downstream', chatId: 'oc_goal', idempotencyKey: `planned:downstream:${cancel1.event.eventId}`,
      payload: planPayload({ generation: 2, reopenOfCancelEventId: cancel1.event.eventId, brief: 'second generation' }),
    }));
    expect(led.task('downstream')).toMatchObject({
      status: 'planned', activationEventId: gen2.event.eventId,
      plan: { planGeneration: 2, dependsOnTaskIds: ['upstream'] },
    });
    const cancel2 = led.append(draft({
      type: 'TaskCancelled', taskId: 'downstream', chatId: 'oc_goal',
      idempotencyKey: `cancelled:downstream:${gen2.event.eventId}`,
      payload: { taskId: 'downstream', reason: 'pause generation 2' },
    }));
    expect(cancel2.deduped).toBe(false);
    expect(cancel2.event.eventId).not.toBe(cancel1.event.eventId);
    expect(led.task('downstream')).toMatchObject({ status: 'cancelled', cancellationEventId: cancel2.event.eventId });
  });

  it('defensively ignores historical attempts to bypass a planned dependency gate', () => {
    const led = openLedger({ baseDir });
    const acceptedEventId = acceptDependency(led, 'upstream');
    const currentRows = led.read();
    const plannedSeq = currentRows.length + 1;
    const plannedEventId = String(plannedSeq);
    const tamperedIntent = releaseIntent({ planEventId: plannedEventId, acceptedEventId });
    tamperedIntent.frozenDispatchedPayload = {
      ...tamperedIntent.frozenDispatchedPayload,
      title: 'tampered historical payload',
    };
    const rows = [
      ...currentRows,
      { ...draft({ type: 'TaskPlanned', taskId: 'downstream', chatId: 'oc_goal', idempotencyKey: 'planned:downstream', payload: planPayload() }), eventId: plannedEventId, seq: plannedSeq },
      { ...draft({ type: 'TaskDispatchIntent', taskId: 'downstream', chatId: 'oc_goal', idempotencyKey: `intent:${tamperedIntent.releaseId}`, payload: tamperedIntent }), eventId: String(plannedSeq + 1), seq: plannedSeq + 1 },
      { ...draft({ type: 'TaskReported', actor: 'worker', taskId: 'downstream', chatId: 'oc_goal', idempotencyKey: 'reported:illegal', payload: { taskId: 'downstream', reportId: 'illegal', summary: 'early', evidence: [{ kind: 'path', path: '/tmp/early' }] } }), eventId: String(plannedSeq + 2), seq: plannedSeq + 2 },
      { ...draft({ type: 'TaskDispatched', taskId: 'downstream', chatId: 'oc_goal', idempotencyKey: 'dispatched:illegal', payload: { taskId: 'downstream', title: 'bypass' } }), eventId: String(plannedSeq + 3), seq: plannedSeq + 3 },
      { type: 'FutureTaskEvent', actor: 'orchestrator', taskId: 'ghost-future', chatId: 'oc_goal', idempotencyKey: 'future:1', ts: TS, payload: { taskId: 'ghost-future' }, eventId: String(plannedSeq + 4), seq: plannedSeq + 4 },
    ];
    writeFileSync(join(baseDir, 'ledger.ndjson'), rows.map((row) => JSON.stringify(row)).join('\n') + '\n');

    const replay = openLedger({ baseDir });
    expect(replay.task('downstream')).toMatchObject({
      status: 'planned', plan: { planEventId: plannedEventId },
    });
    expect(replay.task('downstream')?.pendingRelease).toBeUndefined();
    expect(replay.task('downstream')?.reports).toHaveLength(0);
    expect(replay.task('ghost-future')).toBeUndefined();
    expect(replay.task('upstream')?.acceptedEventId).toBe(acceptedEventId);
  });

  it('keeps acceptedEventId pinned to the event that actually accepted the current report', () => {
    const led = openLedger({ baseDir });
    const acceptedEventId = acceptDependency(led, 'stable-accepted');
    led.append(draft({
      type: 'TaskAccepted', taskId: 'stable-accepted', chatId: 'oc_goal', idempotencyKey: 'accepted:stable-accepted:duplicate-verdict',
      payload: { taskId: 'stable-accepted', reportId: 'stable-accepted-r1', checkedBy: 'late-reviewer' },
    }));
    led.append(draft({
      type: 'TaskRejected', taskId: 'stable-accepted', chatId: 'oc_goal', idempotencyKey: 'rejected:stable-accepted:late',
      payload: { taskId: 'stable-accepted', reportId: 'stable-accepted-r1', reason: 'late-reject' },
    }));
    expect(led.task('stable-accepted')).toMatchObject({
      status: 'accepted', acceptedEventId, reports: [{ reportId: 'stable-accepted-r1', verdict: 'accepted' }],
    });
  });

  it('tasks(chatId) scopes the board to one chat', () => {
    const led = openLedger({ baseDir });
    led.append(draft({ type: 'TaskDispatched', taskId: 't-a', chatId: 'oc_1', idempotencyKey: 'dispatched:t-a', payload: { taskId: 't-a' } }));
    led.append(draft({ type: 'TaskDispatched', taskId: 't-b', chatId: 'oc_2', idempotencyKey: 'dispatched:t-b', payload: { taskId: 't-b' } }));
    expect(led.tasks('oc_1').map((t) => t.taskId)).toEqual(['t-a']);
    expect(led.tasks()).toHaveLength(2);
  });
});
