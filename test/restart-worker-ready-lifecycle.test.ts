import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workerPoolSource = readFileSync(
  new URL('../src/core/worker-pool.ts', import.meta.url),
  'utf8',
);

describe('in-worker restart lifecycle fence', () => {
  it('releases workerReady only after the current restart succeeds', () => {
    const start = workerPoolSource.indexOf("case 'restart_result':");
    const end = workerPoolSource.indexOf("case 'cli_session_id':", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);

    const branch = workerPoolSource.slice(start, end);
    const staleWorkerGuard = branch.indexOf('if (ds.worker !== worker)');
    const resolve = branch.indexOf('restartCoordinator.resolve(');
    const successGuard = branch.indexOf("restartSettled && msg.status === 'succeeded'");
    const releaseFence = branch.indexOf('ds.workerReady = true;');

    expect(staleWorkerGuard).toBeGreaterThanOrEqual(0);
    expect(resolve).toBeGreaterThan(staleWorkerGuard);
    expect(successGuard).toBeGreaterThan(resolve);
    expect(releaseFence).toBeGreaterThan(successGuard);
  });

  it('keeps failed or stale restart receipts from releasing workerReady', () => {
    const start = workerPoolSource.indexOf("case 'restart_result':");
    const end = workerPoolSource.indexOf("case 'cli_session_id':", start);
    const branch = workerPoolSource.slice(start, end);

    expect(branch.match(/ds\.workerReady = true;/g)).toHaveLength(1);
    expect(branch).toContain("if (restartSettled && msg.status === 'succeeded')");
  });
});
