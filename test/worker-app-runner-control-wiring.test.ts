import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'bun:test';
import {
  CodexAppControlProofDeadline,
  codexAppSignedStateReadiness,
} from '../src/utils/codex-app-control.js';
import {
  CodexRunnerFreshnessInputQueue,
  type CodexRunnerFreshnessState,
} from '../src/services/codex-runner-freshness.js';
import { RunnerControlDecoder, RUNNER_CONTROL_PREFIX, RUNNER_CONTROL_END } from '../src/adapters/cli/runner-control-channel.js';

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
    // The master recovery wrapper keeps the structured write in a thunk; the
    // captured adapter prevents an async continuation from crossing generation.
    const writeIdx = flush.indexOf('() => writeAdapter.writeStructuredInput!(');
    expect(reserveIdx).toBeGreaterThan(-1);
    expect(writeIdx).toBeGreaterThan(reserveIdx);
    expect(flush).toContain("result.submissionDisposition === 'untouched'");
    expect(flush).toContain("result.submissionDisposition === 'flushed_invalid'");
    expect(flush).toContain('input buffer is not provably clean');
    // Submit-failure notify is now a guarded block (recoveryFailureReason branch +
    // scheduleSubmitFailureNotify) rather than a single-line call after the merge.
    expect(flush).toContain('if (backend && dispatchStillPending) {');
    expect(flush).toContain('scheduleSubmitFailureNotify(');
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

  it('holds stale-busy normal and raw input across old idle and releases only at fresh prompt-ready', () => {
    let state: CodexRunnerFreshnessState = 'stale_waiting_idle';
    const queue = new CodexRunnerFreshnessInputQueue<string, string>(
      () => state,
      next => { state = next; },
    );
    const oldRunnerWrites: string[] = [];
    const replacementWrites: string[] = [];
    // Model freshness queue hold/release semantics; production flushPending
    // delivers at most one raw input per invocation before normal inputs.
    const flush = (writes: string[]): void => {
      const raw = queue.takeRaw();
      if (raw) writes.push(`raw:${raw}`);
      let normal: string | undefined;
      while ((normal = queue.takeNormal()) !== undefined) writes.push(`normal:${normal}`);
    };

    queue.enqueueNormal('normal-one');
    queue.enqueueRaw('/raw-one');
    flush(oldRunnerWrites);
    expect(oldRunnerWrites).toEqual([]);
    expect(queue.normal).toEqual(['normal-one']);
    expect(queue.raw).toEqual(['/raw-one']);

    // The old busy runner's first idle is consumed as the reload boundary.
    expect(queue.onPromptReady()).toBe('reload');
    expect(state).toBe('restarting_fresh');
    queue.enqueueNormal('normal-during-replacement');
    queue.enqueueRaw('/raw-during-replacement');
    flush(oldRunnerWrites);
    expect(oldRunnerWrites).toEqual([]);
    expect(queue.normal).toEqual(['normal-one', 'normal-during-replacement']);
    expect(queue.raw).toEqual(['/raw-one', '/raw-during-replacement']);

    // Only the replacement's prompt-ready makes dequeue possible.
    expect(queue.onPromptReady()).toBe('publish_ready');
    expect(state).toBe('current');
    flush(replacementWrites);
    expect(replacementWrites).toEqual([
      'raw:/raw-one',
      'normal:normal-one',
      'normal:normal-during-replacement',
    ]);
    expect(queue.raw).toEqual(['/raw-during-replacement']);
    flush(replacementWrites);
    expect(replacementWrites).toEqual([
      'raw:/raw-one',
      'normal:normal-one',
      'normal:normal-during-replacement',
      'raw:/raw-during-replacement',
    ]);
    expect(queue.normal).toEqual([]);
    expect(queue.raw).toEqual([]);

    // The worker's actual queue transitions must stay wired to this tested
    // seam; source loading is intentionally avoided because worker.ts starts
    // process-wide IPC and runtime services at module evaluation time.
    expect(workerSource).toContain('freshnessInputQueue.enqueueNormal(next)');
    expect(workerSource).toContain('freshnessInputQueue.enqueueRaw(msg)');
    expect(workerSource).toContain('freshnessInputQueue.takeNormal()');
    expect(workerSource).toContain('freshnessInputQueue.takeRaw()');
    expect(workerSource).toContain('freshnessInputQueue.onPromptReady()');
    expect(workerSource).toContain(
      "restartCliProcess('stale runner reached idle', { immediate: true, preservePending: true })",
    );
  });

  it('keeps both input kinds held after replacement failure', () => {
    let state: CodexRunnerFreshnessState = 'restarting_fresh';
    const queue = new CodexRunnerFreshnessInputQueue<string, string>(
      () => state,
      next => { state = next; },
    );
    queue.enqueueNormal('normal-held');
    queue.enqueueRaw('/raw-held');

    queue.onReplacementFailed();
    expect(queue.onPromptReady()).toBe('ignore');
    expect(state).toBe('failed');
    expect(queue.takeNormal()).toBeUndefined();
    expect(queue.takeRaw()).toBeUndefined();
    expect(queue.normal).toEqual(['normal-held']);
    expect(queue.raw).toEqual(['/raw-held']);
    expect(workerSource).toContain('freshnessInputQueue.onReplacementFailed()');
  });

  it('notifies preview observers when the signed Codex App final suppresses on explicit botmux send', () => {
    // Regression guard for F3: PR #597 moved codex-app finals OFF the master
    // `if (marker.appTurnId)` OSC branch onto the signed-socket handler
    // (handleTrustedCodexAppMarker, kind==='final'). That signed suppress path
    // forwards final_output with suppressDelivery:true, which the daemon
    // short-circuits WITHOUT calling deliverFinalOutput — the only site that
    // otherwise marks a run-preview replied. So the signed suppress branch must
    // itself call notifyExplicitReplyObserved, symmetric with the bridge-fallback
    // branches — otherwise a run-preview session shows "running" forever after
    // the model's explicit botmux send.
    const markerStart = workerSource.indexOf('async function handleTrustedCodexAppMarker(');
    const markerEnd = workerSource.indexOf('function handleAppRunnerOscMarker(', markerStart);
    const marker = workerSource.slice(markerStart, markerEnd);
    const suppressIdx = marker.indexOf('final_output suppressed');
    expect(suppressIdx).toBeGreaterThan(-1);
    // Within the signed suppress block, the observer notification must fire
    // against the FIFO-attributed turnId (before the final_output IPC).
    const suppressBlock = marker.slice(suppressIdx, suppressIdx + 900);
    expect(suppressBlock).toMatch(/notifyExplicitReplyObserved\(\s*turnId/);
    expect(suppressBlock).toContain('explicitReplyMarkerForTurnWindow(gateInput');
    // The notify precedes the suppressed final_output forward (suppressDelivery).
    const notifyIdx = marker.indexOf('notifyExplicitReplyObserved(', suppressIdx);
    const suppressedFinalIdx = marker.indexOf('suppressDelivery: true', suppressIdx);
    expect(notifyIdx).toBeGreaterThan(-1);
    expect(suppressedFinalIdx).toBeGreaterThan(notifyIdx);
    // Both the signed final and the bridge-fallback paths notify — never just one.
    expect((workerSource.match(/notifyExplicitReplyObserved\(/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it('passes RAW finalContent (not the pre-stripped deliverable) to the suppress gate', () => {
    // Regression guard for the narration-leak fix (#804): shouldSuppressBridgeEmit
    // gained a branch "trailing sentinel + a send marker in-window → suppress" so
    // that a model which already `botmux send`-ed and then wrote longer narration
    // ending in the sentinel does NOT get that narration re-posted. That branch
    // can only fire if the gate SEES the trailing sentinel — so the codex-app
    // call site must hand it the RAW finalContent, not deliverableContent (which
    // has already had the sentinel stripped). The actual send still uses
    // deliverableContent; the gate strips internally for its length comparison.
    const markerStart = workerSource.indexOf('async function handleTrustedCodexAppMarker(');
    const markerEnd = workerSource.indexOf('function handleAppRunnerOscMarker(', markerStart);
    const marker = workerSource.slice(markerStart, markerEnd);
    // The deliverable is derived by stripping; the gate input must be the raw text.
    expect(marker).toContain('const deliverableContent = bridgePostText(finalContent, false);');
    const gateInputIdx = marker.indexOf('finalText: finalContent };');
    expect(gateInputIdx).toBeGreaterThan(-1);
    // Guard against reintroducing the bug: the gateInput must NOT be built from
    // the already-stripped deliverableContent.
    expect(marker).not.toContain('finalText: deliverableContent');
    // The send payload still posts the stripped deliverable, not the raw final.
    expect(marker).toContain('content: (suppressDelivery || isSuperseded) ? \'\' : deliverableContent,');
  });

  it('enables OSC decoding for dsh and routes final frames to the generic path', () => {
    // The worker only decodes runner OSC frames for cliIds in this set.
    expect(workerSource).toContain("const APP_RUNNER_OSC_CLI_IDS = new Set(['mira', 'mir', 'dsh']);");
    // dsh finals go through the generic (non-codex-app) settlement path.
    const markerStart = workerSource.indexOf('if (kind === \'final\' && typeof payload.content === \'string\')');
    expect(markerStart).toBeGreaterThan(-1);
    const genericPath = workerSource.indexOf('// Mira/Mir retain their terminal OSC control path', markerStart);
    expect(genericPath).toBeGreaterThan(markerStart);
  });

  it('decodes a dsh final OSC frame without leaking control bytes to display', () => {
    // Behavioral mirror of the worker's splitCodexAppControl: when the cliId
    // is in the decode set, a `final` frame is stripped from the display
    // stream and handed to the marker callback.
    const decoder = new RunnerControlDecoder();
    const markers: Array<{ kind: string; payload: unknown }> = [];
    const content = '你好，我是 dsh。';
    const frame = `${RUNNER_CONTROL_PREFIX}final:${Buffer.from(JSON.stringify({ content })).toString('base64')}${RUNNER_CONTROL_END}`;
    const display = decoder.push(frame, true, body => {
      const colon = body.indexOf(':');
      markers.push({ kind: body.slice(0, colon), payload: JSON.parse(Buffer.from(body.slice(colon + 1), 'base64').toString('utf8')) });
    });
    expect(display).toBe('');
    expect(markers).toHaveLength(1);
    expect(markers[0].kind).toBe('final');
    expect((markers[0].payload as { content: string }).content).toBe(content);
  });
});
