import { describe, expect, it } from 'vitest';

import { isWorkerExitAfterAllFilesPassed } from '../scripts/run-unit-shard.mjs';

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
