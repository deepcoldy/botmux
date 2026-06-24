import { describe, expect, it } from 'vitest';
import {
  appendVerifiedDeliveryInstructions,
  buildDeliveryListRows,
  buildRejectRetryContent,
  buildVerifiedDeliveryInstructions,
  generateTaskId,
  parseDeliveryDuration,
} from '../src/core/verified-delivery.js';
import { REJECT_REASON, type LedgerEvent, type TaskView } from '../src/verified-delivery/types.js';

describe('verified-delivery core helpers', () => {
  it('generates stable-shaped task ids with a collision-resistant suffix', () => {
    expect(generateTaskId({ title: 'Build Report API', brief: 'x', nonce: 'n1' })).toBe('task-build-report-api-85e34568');
    expect(generateTaskId({ title: '生成中文报告', brief: 'x', nonce: 'n1' })).toBe('task-task-06f0dba2');
  });

  it('injects task id and acceptance hint into worker-facing instructions', () => {
    const text = buildVerifiedDeliveryInstructions({
      taskId: 'task-api-1234abcd',
      acceptanceHint: 'run npm test',
    });
    expect(text).toContain('任务号: task-api-1234abcd');
    expect(text).toContain('botmux report --task task-api-1234abcd');
    expect(text).toContain('botmux help --task task-api-1234abcd'); // 卡住时的求助指引
    expect(text).toContain('验收提示: run npm test');
  });

  it('appends verified delivery instructions after the original brief', () => {
    const out = appendVerifiedDeliveryInstructions({
      brief: '先完成实现',
      taskId: 'task-x-11111111',
    });
    expect(out).toContain('先完成实现\n\n— 可信交付协议 —');
  });

  it('builds a reject retry message that can be sent back into the worker topic', () => {
    const task: TaskView = {
      taskId: 'task-x-11111111',
      status: 'rejected',
      workerOpenIds: ['ou_worker'],
      reports: [],
    };
    const paras = buildRejectRetryContent({
      task,
      reportId: 'r1',
      reason: REJECT_REASON.EVIDENCE_UNREACHABLE,
      retryBrief: '把文件内容 inline 交回来',
      expectedEvidence: 'report.md 内容',
    });
    expect(paras[0][0]).toEqual({ tag: 'at', user_id: 'ou_worker' });
    const text = paras.flat().filter(n => n.tag === 'text').map(n => n.text).join('\n');
    expect(text).toContain('evidence_unreachable');
    expect(text).toContain('把文件内容 inline 交回来');
    expect(text).toContain('botmux report --task task-x-11111111');
  });

  it('parses delivery list duration filters', () => {
    expect(parseDeliveryDuration('500')).toBe(500);
    expect(parseDeliveryDuration('2s')).toBe(2_000);
    expect(parseDeliveryDuration('3m')).toBe(180_000);
    expect(parseDeliveryDuration('1.5h')).toBe(5_400_000);
    expect(parseDeliveryDuration('1d')).toBe(86_400_000);
    expect(() => parseDeliveryDuration('soon')).toThrow(/invalid duration/);
  });

  it('builds delivery list rows scoped by status and stale age', () => {
    const events: LedgerEvent[] = [
      {
        eventId: '1', seq: 1, ts: 1_000, type: 'TaskDispatched', actor: 'orchestrator',
        taskId: 'task-stale', chatId: 'oc_goal', idempotencyKey: 'd:stale',
        payload: { taskId: 'task-stale', title: 'stale task' },
      },
      {
        eventId: '2', seq: 2, ts: 2_500, type: 'TaskDispatched', actor: 'orchestrator',
        taskId: 'task-fresh', chatId: 'oc_goal', idempotencyKey: 'd:fresh',
        payload: { taskId: 'task-fresh', title: 'fresh task' },
      },
      {
        eventId: '3', seq: 3, ts: 2_900, type: 'TaskReported', actor: 'worker',
        taskId: 'task-reported', chatId: 'oc_goal', idempotencyKey: 'r:reported',
        payload: { taskId: 'task-reported', reportId: 'r1', summary: 'done', evidence: [{ kind: 'path', path: '/tmp/out' }] },
      },
    ];
    const tasks: TaskView[] = [
      { taskId: 'task-stale', chatId: 'oc_goal', status: 'dispatched', title: 'stale task', reports: [] },
      { taskId: 'task-fresh', chatId: 'oc_goal', status: 'dispatched', title: 'fresh task', reports: [] },
      { taskId: 'task-reported', chatId: 'oc_goal', status: 'reported', latestReportId: 'r1', reports: [{ reportId: 'r1', summary: 'done', evidence: [{ kind: 'path', path: '/tmp/out' }] }] },
    ];

    const rows = buildDeliveryListRows({
      events,
      tasks,
      status: 'dispatched',
      olderThanMs: 1_000,
      now: 3_000,
    });
    expect(rows.map((r) => r.taskId)).toEqual(['task-stale']);
    expect(rows[0]).toMatchObject({
      chatId: 'oc_goal',
      status: 'dispatched',
      title: 'stale task',
      createdAt: 1_000,
      updatedAt: 1_000,
      ageMs: 2_000,
      reportCount: 0,
    });
  });
});
