import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workerSource = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');
const workerPoolSource = readFileSync(new URL('../src/core/worker-pool.ts', import.meta.url), 'utf8');

describe('worker Riff retirement protocol', () => {
  it('refuses Riff generation restart before the local restart helper can run', () => {
    const start = workerSource.indexOf("case 'restart':");
    const end = workerSource.indexOf("case 'expire_durable_turn':", start);
    const restart = workerSource.slice(start, end);

    const riffGuard = restart.indexOf("if (effectiveBackendType === 'riff')");
    const refusal = restart.indexOf('Refused Riff generation restart', riffGuard);
    const guardBreak = restart.indexOf('break;', refusal);
    const replacement = restart.indexOf('await restartCliProcess(', guardBreak);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(riffGuard).toBeGreaterThanOrEqual(0);
    expect(refusal).toBeGreaterThan(riffGuard);
    expect(guardBreak).toBeGreaterThan(refusal);
    expect(replacement).toBeGreaterThan(guardBreak);
  });

  it('refuses request-less Riff close before destroy or process exit', () => {
    const start = workerSource.indexOf("case 'close':");
    const end = workerSource.indexOf("case 'close_commit':", start);
    const close = workerSource.slice(start, end);

    const riffBranch = close.indexOf("if (effectiveBackendType === 'riff')");
    const requestlessGuard = close.indexOf('if (!msg.requestId)', riffBranch);
    const refusal = close.indexOf('Refused unsafe request-less Riff close', requestlessGuard);
    const guardBreak = close.indexOf('break;', refusal);
    const localDestroy = close.lastIndexOf('backend?.destroySession?.()');
    const localExit = close.lastIndexOf('process.exit(0)');

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(riffBranch).toBeGreaterThanOrEqual(0);
    expect(requestlessGuard).toBeGreaterThan(riffBranch);
    expect(refusal).toBeGreaterThan(requestlessGuard);
    expect(guardBreak).toBeGreaterThan(refusal);
    expect(localDestroy).toBeGreaterThan(guardBreak);
    expect(localExit).toBeGreaterThan(localDestroy);
  });

  it('refuses request-less Riff suspend before teardown or process exit', () => {
    const start = workerSource.indexOf("case 'suspend':");
    const end = workerSource.indexOf('\n  }\n});', start);
    const suspend = workerSource.slice(start, end);

    const riffGuard = suspend.indexOf("if (effectiveBackendType === 'riff')");
    const refusal = suspend.indexOf('Refused unsafe Riff suspend', riffGuard);
    const guardBreak = suspend.indexOf('break;', refusal);
    const localDestroy = suspend.indexOf('(backend?.destroySession ?? backend?.kill)', guardBreak);
    const localExit = suspend.indexOf('process.exit(0)', localDestroy);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(riffGuard).toBeGreaterThanOrEqual(0);
    expect(refusal).toBeGreaterThan(riffGuard);
    expect(guardBreak).toBeGreaterThan(refusal);
    expect(localDestroy).toBeGreaterThan(guardBreak);
    expect(localExit).toBeGreaterThan(localDestroy);
  });

  it('checks every unsent input buffer before fencing the backend or allowing commit', () => {
    const prepareStart = workerSource.indexOf("case 'riff_shutdown_prepare':");
    const prepareEnd = workerSource.indexOf("case 'riff_shutdown_commit':", prepareStart);
    const prepare = workerSource.slice(prepareStart, prepareEnd);
    const readiness = prepare.indexOf('riffWorkerShutdownInputBlocker({');
    const queueCount = prepare.indexOf('pendingMessages: pendingMessages.length', readiness);
    const rawCount = prepare.indexOf('pendingRawInputs: pendingRawInputs.length', readiness);
    const initFence = prepare.indexOf('initPromptMaterialized', readiness);
    const refusal = prepare.indexOf('worker_inputs_not_drained:', readiness);
    const backendPrepare = prepare.indexOf('backend?.prepareShutdownDetach?.()', refusal);

    expect(readiness).toBeGreaterThanOrEqual(0);
    expect(initFence).toBeGreaterThan(readiness);
    expect(queueCount).toBeGreaterThan(readiness);
    expect(rawCount).toBeGreaterThan(queueCount);
    expect(refusal).toBeGreaterThan(rawCount);
    expect(backendPrepare).toBeGreaterThan(refusal);

    const commitStart = workerSource.indexOf("case 'riff_shutdown_commit':", prepareEnd);
    const commitEnd = workerSource.indexOf("case 'riff_shutdown_abort':", commitStart);
    const commit = workerSource.slice(commitStart, commitEnd);
    expect(commit).toContain("shutdownDetachPhase !== 'prepared'");
    expect(commit.indexOf("shutdownDetachPhase !== 'prepared'"))
      .toBeLessThan(commit.indexOf('process.exit(0)'));
  });

  it('has no shutdown cancellation command that can discard accepted Riff work', () => {
    expect(workerSource).not.toContain("case 'riff_shutdown_cancel':");
    expect(workerSource).not.toContain('cancelShutdownDetach');
  });

  it('ACKs shutdown and explicit-close abort only after backend admission restoration', () => {
    const shutdownStart = workerSource.indexOf("case 'riff_shutdown_abort':");
    const shutdownEnd = workerSource.indexOf("case 'close_commit':", shutdownStart);
    const shutdown = workerSource.slice(shutdownStart, shutdownEnd);
    const shutdownRestore = shutdown.indexOf('await backend?.abortShutdownDetach?.()');
    expect(shutdownRestore).toBeGreaterThanOrEqual(0);
    expect(shutdown.indexOf("phase: 'abort'", shutdownRestore))
      .toBeGreaterThan(shutdownRestore);

    const closeStart = workerSource.indexOf("case 'close_abort':");
    const closeEnd = workerSource.indexOf("case 'suspend':", closeStart);
    const close = workerSource.slice(closeStart, closeEnd);
    const closeRestore = close.indexOf('await backend?.abortDestroySession?.()');
    expect(closeRestore).toBeGreaterThanOrEqual(0);
    expect(close.indexOf("type: 'close_abort_result'", closeRestore))
      .toBeGreaterThan(closeRestore);
  });

  it('retains close and shutdown generations across worker error and preserves close fence on exit', () => {
    const errorStart = workerPoolSource.indexOf("worker.on('error', (err) => {");
    const errorEnd = workerPoolSource.indexOf("worker.stdout?.on('data'", errorStart);
    const errorHandler = workerPoolSource.slice(errorStart, errorEnd);
    expect(errorStart).toBeGreaterThanOrEqual(0);
    expect(errorHandler).toContain('ds.riffShutdownState !== undefined');
    expect(errorHandler).toContain('|| ds.riffCloseState !== undefined');
    expect(errorHandler.indexOf('if (!retainExactRetirementGeneration)'))
      .toBeLessThan(errorHandler.indexOf('ds.riffCloseState = undefined'));

    const exitStart = workerPoolSource.indexOf("worker.on('exit', (code, signal) => {");
    const exitEnd = workerPoolSource.indexOf('\n  return worker;', exitStart);
    const exitHandler = workerPoolSource.slice(exitStart, exitEnd);
    expect(exitStart).toBeGreaterThanOrEqual(0);
    expect(exitHandler).toContain("phase: 'uncertain'");
    expect(exitHandler).not.toContain('ds.riffCloseState = undefined');
  });
});
