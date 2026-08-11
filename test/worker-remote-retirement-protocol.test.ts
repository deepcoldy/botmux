import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workerSource = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');
const workerPoolSource = readFileSync(new URL('../src/core/worker-pool.ts', import.meta.url), 'utf8');
const commandHandlerSource = readFileSync(new URL('../src/core/command-handler.ts', import.meta.url), 'utf8');
const dashboardIpcSource = readFileSync(new URL('../src/core/dashboard-ipc-server.ts', import.meta.url), 'utf8');

describe('worker remote retirement protocol', () => {
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

  it('routes explicit Mojo close through prepare/commit while retaining request-less lifecycle teardown', () => {
    const start = workerSource.indexOf("case 'close':");
    const end = workerSource.indexOf("case 'close_commit':", start);
    const close = workerSource.slice(start, end);

    const remoteBranch = close.indexOf("if (effectiveBackendType === 'riff'\n          || (effectiveBackendType === 'mojo' && msg.requestId))");
    const requestlessGuard = close.indexOf('if (!msg.requestId)', remoteBranch);
    const refusal = close.indexOf('Refused unsafe request-less ${effectiveBackendType} close', requestlessGuard);
    const guardBreak = close.indexOf('break;', refusal);
    const unsupported = close.indexOf("error: 'remote_close_unsupported'", guardBreak);
    const preparedSuccess = close.indexOf(': { ok: true };', unsupported);
    const localDestroy = close.lastIndexOf('backend?.destroySession?.()');
    const localExit = close.lastIndexOf('process.exit(0)');

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(remoteBranch).toBeGreaterThanOrEqual(0);
    expect(requestlessGuard).toBeGreaterThan(remoteBranch);
    expect(refusal).toBeGreaterThan(requestlessGuard);
    expect(guardBreak).toBeGreaterThan(refusal);
    expect(unsupported).toBeGreaterThan(guardBreak);
    expect(preparedSuccess).toBeGreaterThan(unsupported);
    expect(localDestroy).toBeGreaterThan(guardBreak);
    expect(localExit).toBeGreaterThan(localDestroy);
  });

  it('refuses a replacement fork before materializing input while remote close owns the generation', () => {
    const start = workerPoolSource.indexOf('export function forkWorker(');
    const end = workerPoolSource.indexOf('\n  const transferGate = transferInputGates.get(ds);', start);
    const forkAdmission = workerPoolSource.slice(start, end);

    const fence = forkAdmission.indexOf('remoteRetirementAdmissionPhase(ds)');
    const warning = forkAdmission.indexOf('sendWorkerInput(ds, promptInput', fence);
    const refusal = forkAdmission.indexOf('Refused worker fork while remote retirement fence', warning);
    const handled = forkAdmission.indexOf('return true;', refusal);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(fence).toBeGreaterThanOrEqual(0);
    expect(warning).toBeGreaterThan(fence);
    expect(refusal).toBeGreaterThan(warning);
    expect(handled).toBeGreaterThan(refusal);
  });

  it('waits out Mojo system/init plus CLI cancellation instead of applying the shorter Riff deadline', () => {
    const start = workerPoolSource.indexOf('async function prepareLiveRemoteWorkerClose(');
    const end = workerPoolSource.indexOf('\n/** Await remote cancellation for any Riff owner', start);
    const prepare = workerPoolSource.slice(start, end);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(workerPoolSource).toContain('MOJO_EXPLICIT_CLOSE_RESULT_TIMEOUT_MS');
    expect(prepare).toContain("backendType === 'mojo'\n      ? MOJO_EXPLICIT_CLOSE_RESULT_TIMEOUT_MS\n      : 23_000");
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
    const prepareStart = workerSource.indexOf("case 'remote_shutdown_prepare':");
    const prepareEnd = workerSource.indexOf("case 'remote_shutdown_commit':", prepareStart);
    const prepare = workerSource.slice(prepareStart, prepareEnd);
    const readiness = prepare.indexOf('remoteWorkerShutdownInputBlocker({');
    const queueCount = prepare.indexOf('pendingMessages: pendingMessages.length', readiness);
    const rawCount = prepare.indexOf('pendingRawInputs: pendingRawInputs.length', readiness);
    const initFence = prepare.indexOf('initPromptMaterialized', readiness);
    const refusal = prepare.indexOf('worker_inputs_not_drained:', readiness);
    const backendPrepare = prepare.indexOf('backend?.prepareShutdownDetach?.()', refusal);
    const remotePrepareGate = prepare.indexOf('if (!isRemoteBackendType(effectiveBackendType))');

    expect(readiness).toBeGreaterThanOrEqual(0);
    expect(remotePrepareGate).toBeGreaterThanOrEqual(0);
    expect(initFence).toBeGreaterThan(readiness);
    expect(queueCount).toBeGreaterThan(readiness);
    expect(rawCount).toBeGreaterThan(queueCount);
    expect(refusal).toBeGreaterThan(rawCount);
    expect(backendPrepare).toBeGreaterThan(refusal);

    const commitStart = workerSource.indexOf("case 'remote_shutdown_commit':", prepareEnd);
    const commitEnd = workerSource.indexOf("case 'remote_shutdown_abort':", commitStart);
    const commit = workerSource.slice(commitStart, commitEnd);
    expect(commit).toContain('!isRemoteBackendType(effectiveBackendType)');
    expect(commit).toContain("shutdownDetachPhase !== 'prepared'");
    expect(commit.indexOf("shutdownDetachPhase !== 'prepared'"))
      .toBeLessThan(commit.indexOf('process.exit(0)'));
  });

  it('has no shutdown cancellation command that can discard accepted Riff work', () => {
    expect(workerSource).not.toContain("case 'remote_shutdown_cancel':");
    expect(workerSource).not.toContain('cancelShutdownDetach');
  });

  it('ACKs shutdown and explicit-close abort only after backend admission restoration', () => {
    const shutdownStart = workerSource.indexOf("case 'remote_shutdown_abort':");
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
    expect(errorHandler).toContain('ds.remoteShutdownState !== undefined');
    expect(errorHandler).toContain('|| ds.remoteCloseState !== undefined');
    expect(errorHandler.indexOf('if (!retainExactRetirementGeneration)'))
      .toBeLessThan(errorHandler.indexOf('ds.remoteCloseState = undefined'));

    const exitStart = workerPoolSource.indexOf("worker.on('exit', (code, signal) => {");
    const exitEnd = workerPoolSource.indexOf('\n  return worker;', exitStart);
    const exitHandler = workerPoolSource.slice(exitStart, exitEnd);
    expect(exitStart).toBeGreaterThanOrEqual(0);
    expect(exitHandler).toContain("phase: 'uncertain'");
    expect(exitHandler).not.toContain('ds.remoteCloseState = undefined');
  });

  it('rejects Riff cwd and role switches before mutating persisted workingDir', () => {
    const commandStart = commandHandlerSource.indexOf("case '/cd':");
    const commandEnd = commandHandlerSource.indexOf("case '/repo':", commandStart);
    const command = commandHandlerSource.slice(commandStart, commandEnd);
    const commandGuard = command.indexOf('if (isRiffBackendSession(ds))');
    expect(commandGuard).toBeGreaterThanOrEqual(0);
    expect(command.indexOf('validateWorkingDir(', commandGuard)).toBeGreaterThan(commandGuard);
    expect(command.indexOf('repinSessionWorkingDir(', commandGuard)).toBeGreaterThan(commandGuard);

    const routeStart = dashboardIpcSource.indexOf("ipcRoute('POST', '/api/sessions/:sessionId/cd'");
    const routeEnd = dashboardIpcSource.indexOf('function findSessionRecord(', routeStart);
    const route = dashboardIpcSource.slice(routeStart, routeEnd);
    const routeGuard = route.indexOf('if (isRiffBackendSession(ds))');
    expect(routeGuard).toBeGreaterThanOrEqual(0);
    expect(route.indexOf('validateRoleLibraryPath(', routeGuard)).toBeGreaterThan(routeGuard);
    expect(route.indexOf('repinSessionWorkingDir(', routeGuard)).toBeGreaterThan(routeGuard);
    expect(route).toContain("error: 'riff_cd_unsupported'");
  });
});
