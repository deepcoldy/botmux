import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'bun:test';

const workerSource = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');
const workerPoolSource = readFileSync(new URL('../src/core/worker-pool.ts', import.meta.url), 'utf8');
const commandHandlerSource = readFileSync(new URL('../src/core/command-handler.ts', import.meta.url), 'utf8');
const dashboardIpcSource = readFileSync(new URL('../src/core/dashboard-ipc-server.ts', import.meta.url), 'utf8');
const cardHandlerSource = readFileSync(new URL('../src/im/lark/card-handler.ts', import.meta.url), 'utf8');
const cardBuilderSource = readFileSync(new URL('../src/im/lark/card-builder.ts', import.meta.url), 'utf8');
const daemonSource = readFileSync(new URL('../src/daemon.ts', import.meta.url), 'utf8');
const webSessionsSource = readFileSync(new URL('../src/dashboard/web/sessions.ts', import.meta.url), 'utf8');

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

  it('routes every remote close through prepare/commit and refuses request-less remote teardown', () => {
    // P0-2: request-less lifecycle teardown is NOT retained for remote backends
    // any more. The old branch let a request-less Mojo close fall through to the
    // legacy destroySession() path — `mojo session cancel` — so every generic
    // retirement silently and irreversibly cancelled the remote session. The
    // fence now covers isRemoteBackendType wholesale: with a requestId the close
    // is prepare/commit, without one it is refused outright, and the legacy
    // destroy-and-exit tail below stays reachable for LOCAL backends only.
    const start = workerSource.indexOf("case 'close':");
    const end = workerSource.indexOf("case 'close_commit':", start);
    const close = workerSource.slice(start, end);

    const remoteBranch = close.indexOf('if (isRemoteBackendType(effectiveBackendType))');
    const requestlessGuard = close.indexOf('if (!msg.requestId)', remoteBranch);
    const refusal = close.indexOf('Refused unsafe request-less ${effectiveBackendType} close', requestlessGuard);
    const guardBreak = close.indexOf('break;', refusal);
    const unsupported = close.indexOf("error: 'remote_close_unsupported'", guardBreak);
    // The `: { ok: true };` literal this used to pin now lives in
    // adapters/backend/destroy-result.ts (normalizeDestroyResult), because a
    // missing result must stay success for local muxes but become a failure for
    // remote backends. What matters here is unchanged: the prepare path still
    // normalizes the backend's answer after the unsupported branch.
    const preparedSuccess = close.indexOf('normalizeDestroyResult(', unsupported);
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

  it('keeps known riff-only retirement guards at zero across the scanned entry-point files', () => {
    // Round-4/5 exhaustive close-out. Honest scope of this pin (fifth-round
    // review): it is a string count over the SCANNED FILES below — it does not
    // parse the AST, does not cover `=== 'riff'` literals used for non-guard
    // purposes, and a file outside this list is not protected. What it does
    // guarantee: the entry-point files where four review rounds found riff-only
    // retirement guards one at a time (/cd → /restart+/repo → cards → crash
    // loop → web dashboard) can never regrow one silently — a copied riff-only
    // guard in any of them goes red here instead of waiting for a reviewer.
    for (const [name, source] of [
      ['worker-pool', workerPoolSource],
      ['command-handler', commandHandlerSource],
      ['dashboard-ipc-server', dashboardIpcSource],
      ['card-handler', cardHandlerSource],
      ['daemon', daemonSource],
      ['worker', workerSource],
      ['dashboard-web-sessions', webSessionsSource],
    ] as const) {
      const uses = source.split('isRiffBackendSession(').length - 1;
      expect(uses, `${name} still calls isRiffBackendSession`).toBe(0);
    }
    // RENDER surfaces must agree with their click/route handlers: no restart
    // affordance for any remote CLI (a riff worker refuses the IPC; a mojo
    // worker EXECUTES it and cancels the remote session). Both the Feishu card
    // and the web dashboard — the web one was the round-5 miss.
    expect(cardBuilderSource).toContain('!isRemoteCliId(effectiveCliId)');
    expect(cardBuilderSource).not.toContain("effectiveCliId !== 'riff'");
    expect(webSessionsSource).toContain('!isRemoteCliId(s.cliId)');
    expect(webSessionsSource).not.toContain("s.cliId !== 'riff'");
    // Card click + takeover guards on the generalized predicate.
    expect(cardHandlerSource.split('isRemoteBackendSession(').length - 1).toBeGreaterThanOrEqual(3);
    expect(commandHandlerSource).toContain('if (!isRemoteBackendSession(ds)) return false;'); // blockRiffTakeover body
  });

  it('wires the VC receiver teardown to the remote-aware retirement in production', () => {
    // The fence-module tests inject their own killWorker, so reverting the
    // PRODUCTION wiring kept them green (fourth-round review). Structural pin:
    // ordering/wiring properties the injected harness cannot observe.
    expect(daemonSource).toContain('killWorker: teardownVcReceiverWorker,');
    // Both boot-recovery sites use the same split teardown.
    expect(daemonSource.split('teardownVcReceiverWorker(ds)').length - 1).toBeGreaterThanOrEqual(2);
    // The split itself: remote-frozen receivers go process-only, locals keep killWorker.
    const body = daemonSource.slice(daemonSource.indexOf('function teardownVcReceiverWorker'));
    const remoteBranch = body.indexOf('retireWorkerProcessOnly(ds');
    const localBranch = body.indexOf('killWorker(ds)');
    expect(body.indexOf('isRemoteBackendSession(ds)')).toBeGreaterThanOrEqual(0);
    expect(remoteBranch).toBeGreaterThanOrEqual(0);
    expect(localBranch).toBeGreaterThan(remoteBranch);
  });

  it('rejects REMOTE cwd and role switches before mutating persisted workingDir', () => {
    // P1-a: killWorker refuses unprepared live retirement for every remote
    // backend, so a /cd that repins first and retires after would report
    // success while the live generation stays on the old cwd. The guard must
    // therefore cover every remote backend (mojo included), and it must sit
    // BEFORE validation/repin in both entrypoints.
    //
    // WHY a structural (source-order) assertion rather than a behavioral one:
    // the property under test is ORDERING — guard precedes mutation. The
    // behavioral tests (command-handler / ipc-cd-route) prove the rejection
    // fires and nothing mutates on the tested inputs, but only the source
    // order proves no input can reach the mutation first. Keep both.
    const commandStart = commandHandlerSource.indexOf("case '/cd':");
    const commandEnd = commandHandlerSource.indexOf("case '/repo':", commandStart);
    const command = commandHandlerSource.slice(commandStart, commandEnd);
    const commandGuard = command.indexOf('if (isRemoteBackendSession(ds))');
    expect(commandGuard).toBeGreaterThanOrEqual(0);
    expect(command.indexOf('validateWorkingDir(', commandGuard)).toBeGreaterThan(commandGuard);
    expect(command.indexOf('repinSessionWorkingDir(', commandGuard)).toBeGreaterThan(commandGuard);

    const routeStart = dashboardIpcSource.indexOf("ipcRoute('POST', '/api/sessions/:sessionId/cd'");
    const routeEnd = dashboardIpcSource.indexOf('function findSessionRecord(', routeStart);
    const route = dashboardIpcSource.slice(routeStart, routeEnd);
    const routeGuard = route.indexOf('if (isRemoteBackendSession(ds))');
    expect(routeGuard).toBeGreaterThanOrEqual(0);
    expect(route.indexOf('validateRoleLibraryPath(', routeGuard)).toBeGreaterThan(routeGuard);
    expect(route.indexOf('repinSessionWorkingDir(', routeGuard)).toBeGreaterThan(routeGuard);
    expect(route).toContain("error: 'remote_cd_unsupported'");
  });
});
