import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  CodexAppControlProofDeadline,
  codexAppSignedStateReadiness,
} from '../src/utils/codex-app-control.js';

const workerSource = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');

describe('worker app-runner control-channel wiring', () => {
  it('uses the bounded decoder and resets it with worker turn state', () => {
    expect(workerSource).toContain('const appRunnerControlDecoder = new RunnerControlDecoder();');
    expect(workerSource).toContain('return appRunnerControlDecoder.push(');
    expect(workerSource).toContain('appRunnerControlDecoder.reset();');
    expect(workerSource).not.toContain('codexAppOscPending');
  });

  it('reserves Codex App attribution before writes and settles finals only from the worker FIFO', () => {
    const flushStart = workerSource.indexOf('async function flushPending');
    const flushEnd = workerSource.indexOf('function sendToPty', flushStart);
    const flush = workerSource.slice(flushStart, flushEnd);
    const reserveIdx = flush.indexOf('codexAppTurnDispatchQueue.reserve(');
    const writeIdx = flush.indexOf('await writeAdapter.writeStructuredInput(');
    expect(reserveIdx).toBeGreaterThan(-1);
    expect(writeIdx).toBeGreaterThan(reserveIdx);
    expect(flush).toContain("result.submissionDisposition === 'untouched'");
    expect(flush).toContain("result.submissionDisposition === 'flushed_invalid'");
    expect(flush).toContain('input buffer is not provably clean');
    expect(flush).toContain('if (backend && dispatchStillPending) scheduleSubmitFailureNotify(');
    expect(flush).toContain('if (backend && dispatchStillPending) {');
    const safeRetryStart = flush.indexOf('const retryQueuedActivation =');
    const retryTransition = flush.indexOf("retryQueuedActivation ? 'retry' : 'cancel'", safeRetryStart);
    const requeue = flush.indexOf('requeueUnsubmittedQueuedActivation(item);', retryTransition);
    const submittedAck = flush.indexOf("type: 'queued_activation_submitted'", retryTransition);
    expect(safeRetryStart).toBeGreaterThan(writeIdx);
    expect(retryTransition).toBeGreaterThan(safeRetryStart);
    expect(requeue).toBeGreaterThan(retryTransition);
    expect(submittedAck).toBeGreaterThan(requeue);
    expect(flush.slice(safeRetryStart, submittedAck)).toContain('codexAppSafeNonSubmission');
    expect(flush.slice(safeRetryStart, submittedAck)).not.toContain("type: 'queued_activation_submitted'");

    const markerStart = workerSource.indexOf('function handleTrustedCodexAppMarker(');
    const markerEnd = workerSource.indexOf('function handleAppRunnerOscMarker(', markerStart);
    const marker = workerSource.slice(markerStart, markerEnd);
    expect(marker).toContain('const settlement = codexAppTurnDispatchQueue.settleFinal(payload, false);');
    expect(marker).toContain('codexAppTurnDispatchQueue.commitExactHead(codexAppDispatchHandle)');
    expect(workerSource).toContain('codexAppControlRecordApplicationGate.run(');
    expect(workerSource).toContain('codexAppControlReplayWindow.commit(identity.generation, record.seq);');
    expect(workerSource.indexOf('codexAppControlRecordApplicationGate.run('))
      .toBeLessThan(workerSource.indexOf('codexAppControlReplayWindow.commit(identity.generation, record.seq);'));
    const codexSettlementStart = marker.indexOf('const settlement = codexAppTurnDispatchQueue.settleFinal(payload, false);');
    const miraFallbackStart = marker.indexOf('} else {\n      // Mira/Mir', codexSettlementStart);
    expect(marker.slice(codexSettlementStart, miraFallbackStart)).not.toContain('currentBotmuxTurnId');
    expect(marker.slice(codexSettlementStart, miraFallbackStart)).not.toContain('currentBotmuxDispatchAttempt');
    expect(marker).not.toContain('const dispatchAttempt = payload.dispatchAttempt');
    expect(marker).toContain('empty final settled for botmux turn');
    expect(workerSource).not.toContain('settleLegacyCodexAppEmptyFinal');
    expect(marker).toContain('published idle before the required final transaction');
    expect(marker).toContain('submitted the next turn before the required final transaction');
  });

  it('ACKs a fresh RPC queued activation only after confirmed turn/start acceptance', () => {
    const engageStart = workerSource.indexOf('async function engageCodexRpc(');
    const engageEnd = workerSource.indexOf('/** RPC panes have NO terminal input path', engageStart);
    const engage = workerSource.slice(engageStart, engageEnd);
    const firstTurn = engage.indexOf('await engine.sendFirstTurn(');
    const accepted = engage.indexOf("if (first.outcome === 'accepted' && cfg.queuedActivationToken)", firstTurn);
    const ack = engage.indexOf("type: 'queued_activation_submitted'", accepted);
    expect(firstTurn).toBeGreaterThan(-1);
    expect(accepted).toBeGreaterThan(firstTurn);
    expect(ack).toBeGreaterThan(accepted);
    expect(engage.slice(firstTurn, accepted)).toContain("if (first.outcome === 'not-sent')");
  });

  it('restores the durable FIFO but never treats warm signed idle as proof that prepared input was unwritten', () => {
    const activateStart = workerSource.indexOf('function activateCodexAppControlConnection(');
    const activateEnd = workerSource.indexOf('function handleCodexAppControlLine(', activateStart);
    const activate = workerSource.slice(activateStart, activateEnd);
    expect(activate).not.toContain('markPromptReady()');
    expect(workerSource).toContain('codexAppTurnDispatchQueue.restore(');
    expect(workerSource).not.toContain('requeueUnwrittenRecoveredCodexAppPrefix');
    expect(workerSource).not.toContain("requestCodexAppDispatchTransition('reset'");

    const markerStart = workerSource.indexOf('async function handleTrustedCodexAppMarker(');
    const markerEnd = workerSource.indexOf('function handleAppRunnerOscMarker(', markerStart);
    const marker = workerSource.slice(markerStart, markerEnd);
    expect(marker).toContain('codexAppTurnDispatchQueue.recoveredPrefix().length > 0');
    expect(marker).toContain('Codex App signed idle cannot prove the recovered prepared frame was never buffered');

    const stopStart = workerSource.indexOf('function stopCodexAppControlChannel(');
    const stopEnd = workerSource.indexOf('function failCodexAppControlGeneration(', stopStart);
    const stop = workerSource.slice(stopStart, stopEnd);
    expect(stop).toContain('if (!opts.preserveDispatchRecovery) {');
    expect(stop.indexOf('codexAppTurnDispatchQueue.clear();'))
      .toBeGreaterThan(stop.indexOf('if (!opts.preserveDispatchRecovery) {'));

    const prepareStart = workerSource.indexOf('async function prepareCodexAppControlGeneration(');
    const prepareEnd = workerSource.indexOf('async function rotateCodexAppControlEndpoint(', prepareStart);
    expect(workerSource.slice(prepareStart, prepareEnd))
      .toContain('stopCodexAppControlChannel({ preserveDispatchRecovery: true });');
  });

  it('keeps auth-to-state proof armed and permits type-ahead only after signed runner readiness', () => {
    const activateStart = workerSource.indexOf('function activateCodexAppControlConnection(');
    const activateEnd = workerSource.indexOf('function handleCodexAppControlLine(', activateStart);
    const activate = workerSource.slice(activateStart, activateEnd);
    expect(activate).not.toContain('codexAppProofDeadline.clear();');
    expect(activate).toContain('Authenticated Codex App runner did not publish signed state');

    const markerStart = workerSource.indexOf('async function handleTrustedCodexAppMarker(');
    const markerEnd = workerSource.indexOf('function handleAppRunnerOscMarker(', markerStart);
    const marker = workerSource.slice(markerStart, markerEnd);
    expect(marker.indexOf('codexAppSignedStateObserved = true;')).toBeGreaterThan(
      marker.indexOf('if (!state.accepted)'),
    );
    expect(marker).toContain('codexAppProofDeadline.clear();');
    expect(marker).toContain("if (readiness === 'invalid')");
    expect(marker).toContain("if (readiness === 'waiting')");
    expect(marker).toContain('codexAppInputReady = true;');
    const invalidStart = marker.indexOf("if (readiness === 'invalid')");
    const waitingStart = marker.indexOf("if (readiness === 'waiting')");
    const applyStart = marker.indexOf('const state = applyTrustedCodexAppStateMarker(', waitingStart);
    expect(marker.slice(invalidStart, waitingStart)).toContain('failCodexAppControlGeneration(');
    expect(marker.slice(waitingStart, applyStart)).toContain('codexAppProofDeadline.armed');
    expect(marker.slice(waitingStart, applyStart)).not.toContain('codexAppProofDeadline.clear();');
    expect(marker.indexOf('codexAppProofDeadline.clear();')).toBeGreaterThan(applyStart);

    const runtimeGateStart = workerSource.indexOf('function codexAppRuntimeTypeAheadReady()');
    const runtimeGateEnd = workerSource.indexOf('async function flushPending()', runtimeGateStart);
    const runtimeGate = workerSource.slice(runtimeGateStart, runtimeGateEnd);
    expect(runtimeGate).toContain('codexAppControlProven');
    expect(runtimeGate).toContain('codexAppSignedStateObserved');
    expect(runtimeGate).toContain('codexAppInputReady');
    expect(workerSource).toContain('projectCodexAppControlReadinessStatus(base, {');
    const firstPromptTimeout = workerSource.slice(
      workerSource.indexOf('const releaseFirstPromptTimeout'),
      workerSource.indexOf('// Riff (and other remote HTTP backends)'),
    );
    expect(firstPromptTimeout).toContain(
      "if (decideHardTimeoutAction(cliAdapter?.supportsTypeAhead === true) === 'flush')",
    );
    expect(firstPromptTimeout).not.toContain('codexAppRuntimeTypeAheadReady()');
  });

  it('keeps the proof timer armed for acceptingInput:false and clears it only for true', async () => {
    vi.useFakeTimers();
    const deadline = new CodexAppControlProofDeadline();
    try {
      const falseTimedOut = vi.fn();
      deadline.arm(falseTimedOut, 100);
      expect(codexAppSignedStateReadiness({ busy: false, acceptingInput: false })).toBe('waiting');
      await vi.advanceTimersByTimeAsync(100);
      expect(falseTimedOut).toHaveBeenCalledTimes(1);

      const missingTimedOut = vi.fn();
      deadline.arm(missingTimedOut, 100);
      expect(codexAppSignedStateReadiness({ busy: false })).toBe('invalid');
      await vi.advanceTimersByTimeAsync(100);
      expect(missingTimedOut).toHaveBeenCalledTimes(1);

      const readyTimedOut = vi.fn();
      deadline.arm(readyTimedOut, 100);
      expect(codexAppSignedStateReadiness({ busy: false, acceptingInput: true })).toBe('ready');
      deadline.clear();
      await vi.advanceTimersByTimeAsync(100);
      expect(readyTimedOut).not.toHaveBeenCalled();
    } finally {
      deadline.clear();
      vi.useRealTimers();
    }
  });

  it('rejects fresh authentication with recovered prepared ownership before activation or publication', () => {
    const activateStart = workerSource.indexOf('function activateCodexAppControlConnection(');
    const activateEnd = workerSource.indexOf('async function handleCodexAppControlLine(', activateStart);
    const activate = workerSource.slice(activateStart, activateEnd);
    const recoveredGuard = activate.indexOf("proofKind === 'fresh runner'");
    const fail = activate.indexOf('failCodexAppControlGeneration(', recoveredGuard);
    const persist = activate.indexOf('persistCodexAppControlState(', recoveredGuard);
    const accepted = activate.indexOf('encodeCodexAppControlAccepted(', recoveredGuard);
    const published = activate.indexOf("type: 'codex_app_generation_active'", recoveredGuard);

    expect(recoveredGuard).toBeGreaterThan(-1);
    expect(fail).toBeGreaterThan(recoveredGuard);
    expect(persist).toBeGreaterThan(fail);
    expect(accepted).toBeGreaterThan(fail);
    expect(published).toBeGreaterThan(fail);
  });

  it('fails the worker generation before publishing terminal or exit signals when the real runner exits with prepared ownership', () => {
    const callbackStart = workerSource.lastIndexOf('backend.onExit((code, signal) => {');
    const callbackEnd = workerSource.indexOf('backend.onError(', callbackStart);
    const callback = workerSource.slice(callbackStart, callbackEnd);
    const fatalIdx = callback.indexOf("lastInitConfig?.cliId === 'codex-app' && codexAppControlFatal");
    const fatalReturnIdx = callback.indexOf('return;', fatalIdx);
    const preparedIdx = callback.indexOf('const codexAppPreparedAtExit');
    const failIdx = callback.indexOf('failCodexAppControlGeneration(', preparedIdx);
    const terminalIdx = callback.indexOf('emitTurnTerminal(', preparedIdx);
    const exitIdx = callback.indexOf("send({ type: 'claude_exit'", preparedIdx);

    expect(fatalIdx).toBeGreaterThan(-1);
    expect(fatalReturnIdx).toBeGreaterThan(fatalIdx);
    expect(preparedIdx).toBeGreaterThan(fatalReturnIdx);
    expect(preparedIdx).toBeGreaterThan(-1);
    expect(failIdx).toBeGreaterThan(preparedIdx);
    expect(terminalIdx).toBeGreaterThan(failIdx);
    expect(exitIdx).toBeGreaterThan(failIdx);
  });

  it('destroys incomplete final transactions before cumulative commit or ACK', () => {
    const handlerStart = workerSource.indexOf('function handleCodexAppControlLine(');
    const handlerEnd = workerSource.indexOf('function acceptCodexAppControlSocket(', handlerStart);
    const handler = workerSource.slice(handlerStart, handlerEnd);
    const assembleIdx = handler.indexOf('const finalResult = connection.finalAssembler.accept(');
    const rejectIdx = handler.indexOf("if (finalResult.status === 'reject')", assembleIdx);
    const destroyIdx = handler.indexOf('connection.socket.destroy();', rejectIdx);
    const applicationIdx = handler.indexOf('codexAppControlRecordApplicationGate.run(', assembleIdx);
    const commitIdx = handler.indexOf('codexAppControlReplayWindow.commit(', assembleIdx);
    const ackIdx = handler.indexOf('encodeCodexAppControlAck(', commitIdx);
    const semanticRejectIdx = handler.indexOf('if (!applied)', assembleIdx);

    expect(assembleIdx).toBeGreaterThan(-1);
    expect(rejectIdx).toBeGreaterThan(assembleIdx);
    expect(destroyIdx).toBeGreaterThan(rejectIdx);
    expect(semanticRejectIdx).toBeGreaterThan(destroyIdx);
    expect(applicationIdx).toBeGreaterThan(assembleIdx);
    expect(commitIdx).toBeGreaterThan(semanticRejectIdx);
    expect(commitIdx).toBeGreaterThan(destroyIdx);
    expect(ackIdx).toBeGreaterThan(commitIdx);
    expect(handler).toContain("if (finalResult.status === 'accepted') return;");
  });
});
