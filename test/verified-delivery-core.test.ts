import { describe, expect, it } from 'vitest';
import {
  appendVerifiedDeliveryInstructions,
  buildRejectRetryContent,
  buildVerifiedDeliveryInstructions,
  generateTaskId,
} from '../src/core/verified-delivery.js';
import { REJECT_REASON, type TaskView } from '../src/verified-delivery/types.js';

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
});
