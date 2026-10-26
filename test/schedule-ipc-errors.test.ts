import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { scheduleIpcErrorMessage } from '../src/core/schedule-ipc-errors.js';

describe('schedule IPC error text for sandboxed sessions', () => {
  it.each([
    'schedule_working_dir_forbidden',
    'schedule_mutation_scope_forbidden',
    'schedule_direct_task_limit',
  ])('maps %s to an actionable Chinese message', code => {
    const text = scheduleIpcErrorMessage(code);
    expect(text).toMatch(/[一-鿿]/);
    expect(text).not.toContain(code);
  });

  it('leaves unknown codes to the caller', () => {
    expect(scheduleIpcErrorMessage('schedule_delegation_origin_unproven')).toBeUndefined();
    expect(scheduleIpcErrorMessage(undefined)).toBeUndefined();
  });

  it('is applied on the CLI add and mutate response paths', () => {
    const cli = readFileSync('src/cli.ts', 'utf8');
    expect(cli.match(/scheduleIpcErrorMessage\(body\.error\)/g)?.length).toBe(3);
  });

  it('names exactly the codes the daemon emits', () => {
    const daemon = readFileSync('src/daemon.ts', 'utf8');
    for (const code of ['schedule_working_dir_forbidden', 'schedule_mutation_scope_forbidden', 'schedule_direct_task_limit']) {
      expect(daemon).toContain(`'${code}'`);
    }
  });
});
