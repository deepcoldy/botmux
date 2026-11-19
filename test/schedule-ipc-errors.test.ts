import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { scheduleIpcErrorMessage } from '../src/core/schedule-ipc-errors.js';

describe('schedule IPC error text for sandboxed sessions', () => {
  it.each([
    'schedule_working_dir_forbidden',
    'schedule_mutation_scope_forbidden',
    'schedule_direct_task_limit',
    'schedule_run_as_invalid',
    'schedule_run_as_unresolved',
    'schedule_run_as_not_allowed',
    'schedule_child_one_shot_disabled',
    'schedule_child_one_shot_parent_ineligible',
    'schedule_child_one_shot_descendant_denied',
    'schedule_child_one_shot_scope_invalid',
    'schedule_child_one_shot_requires_once',
    'schedule_child_one_shot_in_past',
    'schedule_child_one_shot_horizon_exceeded',
    'schedule_child_one_shot_identity_isolation_required',
    'schedule_child_one_shot_authority_changed',
    'schedule_child_one_shot_task_limit',
  ])('maps %s to an actionable Chinese message', code => {
    const text = scheduleIpcErrorMessage(code);
    expect(text).toMatch(/[一-鿿]/);
    expect(text).not.toContain(code);
  });

  it('leaves unknown codes to the caller', () => {
    expect(scheduleIpcErrorMessage('schedule_delegation_origin_unproven')).toBeUndefined();
    expect(scheduleIpcErrorMessage(undefined)).toBeUndefined();
  });

  // 源码结构护栏(K4)：机器可校验的跨文件一致性——映射表里的错误码必须恰好是 daemon
  // 实际发出的码，否则 daemon 改名后 CLI 会静默退回裸码；daemon handler 没有可导出的
  // 码表 seam，只能读源码比对。CLI 两处响应点的接线由 schedule-cli-update.test.ts 的
  // 行为用例覆盖。
  it('names exactly the codes the daemon emits', () => {
    const daemon = readFileSync('src/daemon.ts', 'utf8');
    const childPolicy = readFileSync('src/core/schedule-child-one-shot.ts', 'utf8');
    for (const code of ['schedule_working_dir_forbidden', 'schedule_mutation_scope_forbidden',
      'schedule_direct_task_limit', 'schedule_run_as_invalid', 'schedule_run_as_unresolved',
      'schedule_run_as_not_allowed', 'schedule_child_one_shot_disabled',
      'schedule_child_one_shot_parent_ineligible', 'schedule_child_one_shot_descendant_denied',
      'schedule_child_one_shot_scope_invalid', 'schedule_child_one_shot_requires_once',
      'schedule_child_one_shot_in_past', 'schedule_child_one_shot_horizon_exceeded',
      'schedule_child_one_shot_identity_isolation_required', 'schedule_child_one_shot_authority_changed',
      'schedule_child_one_shot_task_limit']) {
      expect(`${daemon}\n${childPolicy}`).toContain(`'${code}'`);
    }
  });
});
