import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');

function functionSlice(name: string, nextName: string): string {
  const start = source.indexOf(`function ${name}`);
  const end = source.indexOf(`function ${nextName}`, start + 1);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('worker structured-turn status wiring', () => {
  it('rejects a prompt heuristic before publishing ready or clearing in-flight input', () => {
    const body = functionSlice('markPromptReady', 'persistCliSessionId');
    const lifecycleGate = body.indexOf('hasStructuredLifecycleBlock()');
    expect(lifecycleGate).toBeGreaterThanOrEqual(0);
    expect(body.indexOf('idleDetector?.reset()', lifecycleGate)).toBeGreaterThan(lifecycleGate);
    expect(body.indexOf('isPromptReady = true')).toBeGreaterThan(lifecycleGate);
    expect(body.indexOf("send({ type: 'prompt_ready' })")).toBeGreaterThan(lifecycleGate);
    expect(body).toContain('projectedRuntimeScreenStatus()');
  });

  it('re-drives a rejected confirmed-start lease after its bounded grace expires', () => {
    const scheduler = functionSlice('redriveRejectedStructuredReady', 'markPromptReady');
    expect(scheduler.indexOf("pruneExpiredStructuredHeadsAndEmit('structured pre-start gate')"))
      .toBeLessThan(scheduler.indexOf('hasStructuredLifecycleBlock()'));
    expect(scheduler).toContain('hasStructuredLifecycleBlock()');
    expect(scheduler).toContain('idleDetector?.fireIdle()');
    expect(scheduler).toContain('captureBackendScreen(backend)');
    const grace = functionSlice('scheduleStructuredStartGraceRecheck', 'markPromptReady');
    const fence = grace.indexOf('isCliBackendGenerationCurrent(');
    const redrive = grace.indexOf('redriveRejectedStructuredReady()');
    expect(grace).toContain('const cliGenerationAtSchedule = cliSpawnGeneration');
    expect(grace).toContain('{ generation: cliGenerationAtSchedule, backend: backendAtSchedule }');
    expect(grace).toContain('restartInProgress: cliRestartInProgress');
    expect(fence).toBeGreaterThanOrEqual(0);
    expect(redrive).toBeGreaterThan(fence);
    expect(scheduler).toContain('ptyOutputGeneration.isCurrent(readyEvidenceGeneration)');

    const body = functionSlice('markPromptReady', 'persistCliSessionId');
    expect(body).toContain('codexBridgeQueue.preStartLeaseRemainingMs()');
    expect(body).toContain('scheduleStructuredStartGraceRecheck(remainingMs)');
    expect(body).toContain('ptyOutputGeneration.snapshot()');
  });

  it('records authoritative submit confirmation in fresh and adopt write paths', () => {
    const flush = functionSlice('flushPending', 'sendToPty');
    const verification = flush.indexOf('codexBridgeQueue.beginSubmitVerification(bridgeTurnId, undefined, item.dispatchAttempt)');
    const write = flush.indexOf('await writeAdapter.writeInput(writeBackend, msg)');
    expect(verification).toBeGreaterThanOrEqual(0);
    expect(write).toBeGreaterThan(verification);
    expect(flush).toContain('result?.submitted === true && bridgeTurnId');
    expect(flush).toContain('codexBridgeQueue.confirmPendingTurn(bridgeTurnId, undefined, item.dispatchAttempt)');
    expect(flush).toContain('codexBridgeQueue.finishSubmitVerification(bridgeTurnId, undefined, item.dispatchAttempt)');

    const adopt = functionSlice('writeAdoptMessage', 'isWorkflowWorker');
    const adoptCycle = adopt.indexOf('beginCliWriteCycle()');
    const adoptWrite = adopt.indexOf('await cliAdapter.writeInput(adoptBackend as unknown as PtyHandle, content)');
    expect(adoptCycle).toBeGreaterThanOrEqual(0);
    expect(adoptWrite).toBeGreaterThan(adoptCycle);
    expect(adopt).toContain('result?.submitted === true && adoptStructuredBridgeTurnId');
    expect(adopt).toContain('codexBridgeQueue.confirmPendingTurn(adoptStructuredBridgeTurnId, undefined, dispatchAttempt)');
  });

  it('re-arms readiness for every fresh type-ahead item and never resets adopt readiness after await', () => {
    const flush = functionSlice('flushPending', 'sendToPty');
    const loop = flush.indexOf('while (pendingMessages.length > 0 && backend && cliAdapter)');
    const perItemCycle = flush.indexOf('beginCliWriteCycle()', loop);
    const itemWrite = flush.indexOf('await writeAdapter.writeInput(writeBackend, msg)', loop);
    expect(perItemCycle).toBeGreaterThan(loop);
    expect(itemWrite).toBeGreaterThan(perItemCycle);

    const adopt = functionSlice('writeAdoptMessage', 'isWorkflowWorker');
    const adoptWrite = adopt.indexOf('await cliAdapter.writeInput(adoptBackend as unknown as PtyHandle, content)');
    expect(adoptWrite).toBeGreaterThanOrEqual(0);
    expect(adopt.slice(adoptWrite)).not.toContain('isPromptReady = false;');
    expect(adopt.slice(adoptWrite)).not.toContain('idleDetector?.reset();');
  });

  it('uses the same lifecycle-aware projection for periodic and screenshot updates', () => {
    const screenshot = functionSlice('captureAndUpload', 'applyDisplayMode');
    const periodic = functionSlice('startScreenUpdates', 'stopScreenUpdates');
    expect(screenshot).toContain('const status = projectedRuntimeScreenStatus()');
    expect(periodic).toContain('snapshotWithLatestRuntimeStatus(async () =>');
    expect(periodic).toContain('}, projectedRuntimeScreenStatus)');
    expect(periodic.indexOf('usageLimitTracker.classify(snapshot.content, status)'))
      .toBeGreaterThan(periodic.indexOf('}, projectedRuntimeScreenStatus)'));
  });

  it('limits the strong ready gate to drivers with a complete terminal contract', () => {
    const gate = functionSlice('hasStructuredLifecycleBlock', 'structuredBridgeIsCodex');
    expect(gate).toContain('isStructuredBridgeLifecycleBlockingCli(lastInitConfig?.cliId)');
    expect(gate).toContain('codexBridgeQueue.hasBlockingTurn()');

    const projector = functionSlice('projectedRuntimeScreenStatus', 'beginCliWriteCycle');
    expect(projector).toContain('structuredTurnBlocking: hasStructuredLifecycleBlock()');
  });

  it('re-drives idle for both normal-final and interrupted terminal events', () => {
    const ingest = functionSlice('codexBridgeIngest', 'codexBridgeMarkPendingTurn');
    expect(ingest).toContain('result.events.some(isStructuredTerminalEvent)');
    expect(ingest).toContain('idleDetector?.fireIdle()');

    const attach = functionSlice('codexBridgeAttach', 'cursorLateAttachMode');
    expect(attach).toContain('live.some(isStructuredTerminalEvent)');
    expect(attach).toContain('idleDetector?.fireIdle()');
  });

  it('settles empty normal/abort terminals without publishing a fake final response', () => {
    const emit = functionSlice('emitReadyCodexTurns', 'stopCodexBridge');
    const outputGuard = emit.indexOf('if (!turn.finalText) continue;');
    const terminalLoop = emit.indexOf('for (const turn of ready)', outputGuard + 1);
    expect(outputGuard).toBeGreaterThanOrEqual(0);
    expect(terminalLoop).toBeGreaterThan(outputGuard);
    expect(emit.slice(terminalLoop)).toContain("turn.terminalStatus ?? 'completed'");
    expect(emit.slice(terminalLoop)).toContain('turn.dispatchAttempt');
  });

  it('fences stale deferred-attempt effects before persistence, redrive, reschedule, or terminal', () => {
    const schedule = functionSlice('scheduleSubmitFailureNotify', 'detectBareShellLaunch');
    expect(schedule).toContain('const cliGenerationAtSchedule = cliSpawnGeneration');
    expect(schedule).toContain('backend === backendAtSchedule');
    expect(schedule).toContain('dispatchAttempt: turnIdentity?.dispatchAttempt');
    expect(schedule).toContain('structuredTarget,');
    expect(schedule).toContain('isCurrent: deferredAttemptIsCurrent');
    const staleGuard = schedule.indexOf('if (settlement.stale)');
    expect(staleGuard).toBeGreaterThanOrEqual(0);
    expect(schedule.indexOf('persistCliSessionId(cliSessionId)', staleGuard)).toBeGreaterThan(staleGuard);
    expect(schedule.indexOf('redriveRejectedStructuredReady()', staleGuard)).toBeGreaterThan(staleGuard);
    expect(schedule.indexOf('scheduleSubmitFailureNotify(', staleGuard)).toBeGreaterThan(staleGuard);
    expect(schedule.indexOf('emitDurableFailure(', staleGuard)).toBeGreaterThan(staleGuard);

    const restart = functionSlice('restartCliProcess', 'startWebServer');
    expect(restart.indexOf('cliSpawnGeneration += 1'))
      .toBeLessThan(restart.indexOf('cliRestartInProgress = true'));
  });

  it('generation-fences the normal flush continuation immediately after writeInput settles', () => {
    const flush = functionSlice('flushPending', 'sendToPty');
    const capture = flush.indexOf('const writeGeneration = cliSpawnGeneration');
    const write = flush.indexOf('await writeAdapter.writeInput(writeBackend, msg)', capture);
    const resolvedGuard = flush.indexOf('if (!writeContinuationIsCurrent())', write);
    const busyProbe = flush.indexOf('scheduleBusyPatternIdleProbe(', write);
    const catchStart = flush.indexOf('} catch (err: any) {', resolvedGuard);
    const rejectedGuard = flush.indexOf('if (!writeContinuationIsCurrent())', catchStart);
    const catchLog = flush.indexOf('log(`writeInput threw:', catchStart);
    const persistence = flush.indexOf('persistCliSessionId(result.cliSessionId)', catchStart);
    const redrive = flush.indexOf('redriveRejectedStructuredReady()', catchStart);
    const deferredTimer = flush.indexOf('scheduleSubmitFailureNotify(', catchStart);

    expect(capture).toBeGreaterThanOrEqual(0);
    expect(write).toBeGreaterThan(capture);
    expect(resolvedGuard).toBeGreaterThan(write);
    expect(busyProbe).toBeGreaterThan(resolvedGuard);
    expect(rejectedGuard).toBeGreaterThan(catchStart);
    expect(catchLog).toBeGreaterThan(rejectedGuard);
    expect(persistence).toBeGreaterThan(rejectedGuard);
    expect(redrive).toBeGreaterThan(rejectedGuard);
    expect(deferredTimer).toBeGreaterThan(rejectedGuard);
    const staleSettlement = flush.slice(
      flush.indexOf('const handleStaleWriteContinuation ='),
      flush.indexOf('let result:', flush.indexOf('const handleStaleWriteContinuation =')),
    );
    expect(staleSettlement).toContain('settleStaleWriteContinuation(');
    expect(staleSettlement).toContain("emitTurnTerminal(turnId, 'ambiguous', code, dispatchAttempt)");
    expect(staleSettlement).not.toContain('dropPendingTurn(');
    expect(staleSettlement).not.toContain('send({');
  });

  it('does not synthesize prompt-ready after a conclusively failed unstarted submit', () => {
    const cleanup = functionSlice('dropFailedBridgeMark', 'scheduleSubmitFailureNotify');
    expect(cleanup).toContain('codexBridgeQueue.dropPendingTurn(bridgeTurnId, dispatchAttempt)');
    expect(cleanup).toContain('emitReadyCodexTurns()');
    expect(cleanup).not.toContain('idleDetector?.fireIdle()');
  });

  it('drains completions in every explicit expired-head mutation path', () => {
    const prune = functionSlice('pruneExpiredStructuredHeadsAndEmit', 'codexBridgeDrainAndMaybeEmit');
    expect(prune).toContain('pruneExpiredPreStartHeadsAndEmit(');
    expect(prune).toContain('emitReadyCodexTurns,');
    expect(prune).toContain('if (turn.dispatchAttempt === undefined) continue;');
    expect(prune).toContain("'ambiguous',");
    expect(prune).toContain("'structured_start_timeout',");
    expect(prune).toContain('turn.dispatchAttempt,');
    // Hermes, MTR attach+ingest, generic split-live+ingest, the 1s bridge tick,
    // and the rejected-ready lease timer all funnel through the helper.
    expect(source.match(/pruneExpiredStructuredHeadsAndEmit\('/g)).toHaveLength(7);

    const ticker = functionSlice('codexBridgeStartTimer', 'hermesBridgeAttach');
    const ingest = ticker.indexOf('codexBridgeIngest()');
    const finallyBlock = ticker.indexOf('} finally {');
    const tickPrune = ticker.indexOf("pruneExpiredStructuredHeadsAndEmit('structured bridge tick')");
    expect(ingest).toBeGreaterThanOrEqual(0);
    expect(finallyBlock).toBeGreaterThan(ingest);
    expect(tickPrune).toBeGreaterThan(finallyBlock);
  });

  it('carries the structured mark through adopt submit confirmation and exception cleanup', () => {
    const adopt = functionSlice('writeAdoptMessage', 'isWorkflowWorker');
    const handler = source.slice(source.indexOf("case 'message':"), source.indexOf("case 'raw_input':"));
    expect(handler).toContain('await runAdoptMessageForCapturedGeneration(item, () =>');
    expect(handler).toContain('msg.dispatchAttempt');
    expect(adopt).toContain('adoptStructuredBridgeTurnId = codexBridgeMarkPendingTurn(content, turnId, dispatchAttempt)');
    expect(adopt).toContain('scheduleSubmitFailureNotify(');
    expect(adopt).toContain("'submit history'");
    expect(adopt).toContain('dropFailedBridgeMark(adoptStructuredBridgeTurnId, dispatchAttempt)');
  });
});
