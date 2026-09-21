import { describe, expect, it } from 'vitest';

import { isStatuslineWatchdogTimingOnly, isWorkerExitAfterAllFilesPassed } from '../scripts/run-unit-shard.mjs';

describe('isWorkerExitAfterAllFilesPassed', () => {
  it('retries the measured CI signature: all files green, worker died in teardown', () => {
    const out = [
      ' \x1b[32m✓\x1b[39m  unit  test/cli-session-selection-prompt.test.ts',
      'Vitest caught 1 unhandled error during the test run.',
      'Error: [vitest-pool]: Worker forks emitted error.',
      'Caused by: Error: Worker exited unexpectedly',
      ' Test Files  \x1b[1m\x1b[32m416 passed\x1b[39m\x1b[22m | \x1b[33m1 skipped\x1b[39m (418)',
      '      Tests  7374 passed | 6 skipped (7380)',
      '     Errors  1 error',
    ].join('\n');
    expect(isWorkerExitAfterAllFilesPassed(out)).toBe(true);
  });

  it('does not retry when a test file actually failed', () => {
    const out = [
      'Error: Worker exited unexpectedly',
      ' Test Files  2 failed | 414 passed (416)',
    ].join('\n');
    expect(isWorkerExitAfterAllFilesPassed(out)).toBe(false);
  });

  it('does not retry a clean pass or a worker-exit without a summary', () => {
    expect(isWorkerExitAfterAllFilesPassed(' Test Files  10 passed (10)\n')).toBe(false);
    expect(isWorkerExitAfterAllFilesPassed('Worker exited unexpectedly\nno summary\n')).toBe(false);
  });

  // `passed` is load-bearing. Dropping it makes these two summaries flip
  // false → true (measured): a shard that ran zero cases would be retried.
  it('does not retry worker-exit when the shard ran no passing files', () => {
    expect(isWorkerExitAfterAllFilesPassed([
      'Error: Worker exited unexpectedly',
      ' Test Files  no tests',
    ].join('\n'))).toBe(false);
    expect(isWorkerExitAfterAllFilesPassed([
      'Error: Worker exited unexpectedly',
      ' Test Files  3 skipped (3)',
    ].join('\n'))).toBe(false);
  });
});

describe('isStatuslineWatchdogTimingOnly', () => {
  it('accepts the measured CI statusline watchdog jitter and nothing broader', () => {
    const out = [
      ' FAIL  unit  test/statusline-cli.test.ts > botmux statusline > ⑤ chain 挂死（sleep 30）：看门狗 ≤ 12s 内 exit 0',
      'AssertionError: expected 12167 to be less than or equal to 12000',
      ' ❯ test/statusline-cli.test.ts:133:25',
      '    expect(r.elapsedMs).toBeLessThanOrEqual(12_000);',
      ' Test Files  1 failed | 464 passed (465)',
      '      Tests  1 failed | 8620 passed | 5 skipped (8626)',
    ].join('\n');
    expect(isStatuslineWatchdogTimingOnly(out)).toBe(true);
  });

  it('does not accept unrelated failures or wider timing overruns', () => {
    expect(isStatuslineWatchdogTimingOnly([
      ' FAIL  unit  test/other.test.ts',
      'AssertionError: expected 12167 to be less than or equal to 12000',
      ' Test Files  1 failed | 464 passed (465)',
      '      Tests  1 failed | 8620 passed | 5 skipped (8626)',
    ].join('\n'))).toBe(false);
    expect(isStatuslineWatchdogTimingOnly([
      ' FAIL  unit  test/statusline-cli.test.ts > botmux statusline > ⑤ chain 挂死（sleep 30）：看门狗 ≤ 12s 内 exit 0',
      'AssertionError: expected 17000 to be less than or equal to 12000',
      '    expect(r.elapsedMs).toBeLessThanOrEqual(12_000);',
      ' Test Files  1 failed | 464 passed (465)',
      '      Tests  1 failed | 8620 passed | 5 skipped (8626)',
    ].join('\n'))).toBe(false);
    expect(isStatuslineWatchdogTimingOnly([
      ' FAIL  unit  test/statusline-cli.test.ts > botmux statusline > ⑤ chain 挂死（sleep 30）：看门狗 ≤ 12s 内 exit 0',
      'AssertionError: expected 12167 to be less than or equal to 12000',
      '    expect(r.elapsedMs).toBeLessThanOrEqual(12_000);',
      ' Test Files  2 failed | 463 passed (465)',
      '      Tests  2 failed | 8619 passed | 5 skipped (8626)',
    ].join('\n'))).toBe(false);
  });
});
