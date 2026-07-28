import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const workerSource = readFileSync(join(process.cwd(), 'src/worker.ts'), 'utf8');

describe('worker ZMX logical submission recovery', () => {
  it('fences normal adapter writes and recovers both thrown and explicit failures', () => {
    const start = workerSource.indexOf('async function flushPending(): Promise<void>');
    const end = workerSource.indexOf('function sendToPty(', start);
    const flush = workerSource.slice(start, end);
    const capture = flush.indexOf('captureAmbiguousSubmissionFence(backend)');
    const write = flush.indexOf('result = await cliAdapter.writeInput(');
    const caughtRecovery = flush.indexOf(
      'cancelAmbiguousSubmissionAfterFailure(submissionBackend, submissionFence);',
      write,
    );
    const explicitFailure = flush.indexOf('result.submitted === false', write);
    const explicitRecovery = flush.indexOf(
      'cancelAmbiguousSubmissionAfterFailure(submissionBackend, submissionFence);',
      caughtRecovery + 1,
    );

    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(capture).toBeGreaterThan(-1);
    expect(capture).toBeLessThan(write);
    expect(caughtRecovery).toBeGreaterThan(write);
    expect(explicitFailure).toBeGreaterThan(caughtRecovery);
    expect(explicitRecovery).toBeGreaterThan(explicitFailure);
  });

  it('applies the same recovery fence to structured adopt writes', () => {
    const start = workerSource.indexOf('// Adopt mode write:');
    const end = workerSource.indexOf('case \'close\':', start);
    const adopt = workerSource.slice(start, end);
    const capture = adopt.indexOf('captureAmbiguousSubmissionFence(backend)');
    const write = adopt.indexOf('await cliAdapter.writeInput(');
    const explicitFailure = adopt.indexOf('result.submitted === false', write);
    const explicitRecovery = adopt.indexOf(
      'cancelAmbiguousSubmissionAfterFailure(submissionBackend, submissionFence);',
      explicitFailure,
    );
    const caughtRecovery = adopt.indexOf(
      'cancelAmbiguousSubmissionAfterFailure(submissionBackend, submissionFence);',
      explicitRecovery + 1,
    );

    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(capture).toBeGreaterThan(-1);
    expect(capture).toBeLessThan(write);
    expect(explicitRecovery).toBeGreaterThan(explicitFailure);
    expect(caughtRecovery).toBeGreaterThan(explicitRecovery);
  });
});
