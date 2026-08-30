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
    const write = flush.indexOf('writeAdapter.writeInput(', verification);
    expect(verification).toBeGreaterThanOrEqual(0);
    expect(write).toBeGreaterThan(verification);
    expect(flush).toContain('result?.submitted === true && bridgeTurnId');
    expect(flush).toContain('codexBridgeQueue.confirmPendingTurn(bridgeTurnId, undefined, item.dispatchAttempt)');
    expect(flush).toContain('codexBridgeQueue.finishSubmitVerification(bridgeTurnId, undefined, item.dispatchAttempt)');

    const adopt = functionSlice('writeAdoptMessage', 'isWorkflowWorker');
    // beginCliWriteCycle re-arms readiness inside prepareAdoptWrite, which the
    // submission transaction runs as its beforeWrite hook — textually before the
    // wrapped writeInput. The write stays the literal cliAdapter.writeInput call.
    const adoptCycle = adopt.indexOf('beginCliWriteCycle()');
    const adoptWrite = adopt.indexOf('cliAdapter!.writeInput(adapterInputHandle(submissionBackend), content)');
    expect(adoptCycle).toBeGreaterThanOrEqual(0);
    expect(adoptWrite).toBeGreaterThan(adoptCycle);
    expect(adopt).toContain('result?.submitted === true && adoptStructuredBridgeTurnId');
    expect(adopt).toContain('codexBridgeQueue.confirmPendingTurn(adoptStructuredBridgeTurnId, undefined, dispatchAttempt)');
  });

  it('re-arms readiness for every fresh type-ahead item and never resets adopt readiness after await', () => {
    const flush = functionSlice('flushPending', 'sendToPty');
    const loop = flush.indexOf('while (pendingMessages.length > 0 && backend && cliAdapter)');
    const perItemCycle = flush.indexOf('beginCliWriteCycle()', loop);
    const itemWrite = flush.indexOf('writeAdapter.writeInput(', loop);
    expect(perItemCycle).toBeGreaterThan(loop);
    expect(itemWrite).toBeGreaterThan(perItemCycle);

    const adopt = functionSlice('writeAdoptMessage', 'isWorkflowWorker');
    const adoptWrite = adopt.indexOf('cliAdapter!.writeInput(adapterInputHandle(submissionBackend), content)');
    expect(adoptWrite).toBeGreaterThanOrEqual(0);
    // Re-arm (setPromptReady(false)/idleDetector.reset via beginCliWriteCycle)
    // happens in prepareAdoptWrite BEFORE the write, never after it.
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
    const awaitingGate = gate.indexOf('rpcTurnsAwaitingActivation.size > 0');
    const rpcGate = gate.indexOf('turn.rpcActive === true');
    const transcriptAllowlist = gate.indexOf('isStructuredBridgeLifecycleBlockingCli(lastInitConfig?.cliId)');
    expect(awaitingGate).toBeGreaterThanOrEqual(0);
    expect(awaitingGate).toBeLessThan(rpcGate);
    expect(rpcGate).toBeGreaterThanOrEqual(0);
    expect(transcriptAllowlist).toBeGreaterThan(rpcGate);
    expect(gate).toContain('isStructuredBridgeLifecycleBlockingCli(lastInitConfig?.cliId)');
    expect(gate).toContain('codexBridgeQueue.hasBlockingTurn()');

    const projector = functionSlice('projectedRuntimeScreenStatus', 'beginCliWriteCycle');
    expect(projector).toContain('structuredTurnBlocking: hasStructuredLifecycleBlock()');
  });

  it('re-drives idle for both normal-final and interrupted terminal events', () => {
    const ingest = functionSlice('codexBridgeIngest', 'codexBridgeMarkPendingTurn');
    expect(ingest).toContain("result.events.some(event => event.kind === 'assistant_final')");
    expect(ingest).toContain('idleDetector?.fireIdle()');

    const attach = functionSlice('codexBridgeAttach', 'cursorLateAttachMode');
    expect(attach).toContain("live.some(event => event.kind === 'assistant_final')");
    expect(attach).toContain('idleDetector?.fireIdle()');
  });

  it('settles terminals after optional output and preserves the empty-completed fallback', () => {
    const emit = functionSlice('emitReadyCodexTurns', 'stopCodexBridge');
    // The empty-completed fallback is still wired before the output guard —
    // now via the extracted structuredFallbackKind decision, whose
    // 'empty_completed' branch posts emptyCompletedBridgeFallbackContent().
    const fallbackKind = emit.indexOf('structuredFallbackKind');
    const emptyFallback = emit.indexOf('emptyCompletedBridgeFallbackContent()', fallbackKind);
    const outputGuard = emit.indexOf('if (!content) continue;', emptyFallback);
    const terminalLoop = emit.indexOf('for (const turn of ready)', outputGuard);
    expect(fallbackKind).toBeGreaterThanOrEqual(0);
    expect(emptyFallback).toBeGreaterThanOrEqual(0);
    expect(outputGuard).toBeGreaterThan(emptyFallback);
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
    expect(schedule.indexOf('emitDurableTerminal(', staleGuard)).toBeGreaterThan(staleGuard);

    const restart = functionSlice('restartCliProcess', 'startWebServer');
    expect(restart.indexOf('cliSpawnGeneration += 1'))
      .toBeLessThan(restart.indexOf('cliRestartInProgress = true'));
  });

  it('generation-fences the normal flush continuation immediately after writeInput settles', () => {
    const flush = functionSlice('flushPending', 'sendToPty');
    const capture = flush.indexOf('const writeGeneration = cliSpawnGeneration');
    const write = flush.indexOf('writeAdapter.writeInput(', capture);
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

  it('generation-fences an RPC ack before creating or activating bridge state', () => {
    const flush = functionSlice('flushPending', 'sendToPty');
    const rpcBranch = flush.slice(flush.indexOf('if (writeRpcEngine) {'));
    const sendAck = rpcBranch.indexOf('await writeRpcEngine.sendTurn(msg, rpcTurnIdentity!)');
    const generationFence = rpcBranch.indexOf('if (!writeContinuationIsCurrent())', sendAck);
    const assignBridge = rpcBranch.indexOf('bridgeTurnId = rpcTurnIdentity.turnId', generationFence);
    const activate = rpcBranch.indexOf('activateRpcTurnLifecycle(', assignBridge);
    expect(sendAck).toBeGreaterThanOrEqual(0);
    expect(generationFence).toBeGreaterThan(sendAck);
    expect(assignBridge).toBeGreaterThan(generationFence);
    expect(activate).toBeGreaterThan(assignBridge);
    expect(flush).toContain('codexBridgeActive && !writeRpcEngine');
    expect(rpcBranch.slice(0, sendAck)).not.toContain('codexBridgeMarkPendingTurn(');

    const ingest = functionSlice('codexBridgeIngest', 'codexBridgeMarkPendingTurn');
    expect(ingest).toContain('rpcTranscriptIngestBlockedByAwaitingActivation(');
    expect(ingest).toContain('rpcTurnsAwaitingActivation.keys()');
    expect(ingest).toContain('opts.hydrationOwnerKey');
  });

  it('anchors delayed RPC replay to the exact owner send-start time instead of ACK time', () => {
    const install = functionSlice('installAwaitingRpcActivation', 'clearRpcLifecycleFailClosedOwner');
    expect(install).toContain('rpcTurnsAwaitingActivationReplayAnchors.set(ownerKey, Date.now())');
    expect(install).toContain('awaitingRpcActivationReplayAnchorMs(');
    expect(install).toContain('sameRpcGeneration(rpcTurnsAwaitingActivation.get(ownerKey), generation)');

    const activate = functionSlice('activateRpcTurnLifecycle', 'releaseRpcTurnTerminalDeferral');
    const readAnchor = activate.indexOf('const replayAnchorMs = awaitingRpcActivationReplayAnchorMs(');
    const mark = activate.indexOf('codexBridgeMarkPendingTurn(', readAnchor);
    expect(readAnchor).toBeGreaterThanOrEqual(0);
    expect(mark).toBeGreaterThan(readAnchor);
    expect(activate.slice(mark, activate.indexOf(');', mark) + 2)).toContain('replayAnchorMs');

    const flush = functionSlice('flushPending', 'sendToPty');
    const rpcCatch = flush.indexOf('if (rpcTurnIdentity && rpcTurnGeneration && writeRpcEngine)');
    const catchAnchor = flush.indexOf('const replayAnchorMs = awaitingRpcActivationReplayAnchorMs(', rpcCatch);
    const clear = flush.indexOf('clearAwaitingRpcActivation(', catchAnchor);
    const catchMark = flush.indexOf('codexBridgeMarkPendingTurn(', clear);
    expect(catchAnchor).toBeGreaterThan(rpcCatch);
    expect(clear).toBeGreaterThan(catchAnchor);
    expect(catchMark).toBeGreaterThan(clear);
    expect(flush.slice(catchMark, flush.indexOf(');', catchMark) + 2)).toContain('replayAnchorMs');
  });

  it('fails closed on an ambiguous follow-up RPC response before generic submit-failure cleanup', () => {
    const flush = source.slice(
      source.indexOf('async function flushPending'),
      source.indexOf('function sendToPty'),
    );
    const rpcCatch = flush.indexOf('if (rpcTurnIdentity && rpcTurnGeneration && writeRpcEngine)');
    const install = flush.indexOf('installRpcLifecycleFailClosedOwner(rpcTurnIdentity, rpcTurnGeneration)', rpcCatch);
    const genericCleanup = flush.indexOf('codexAppPromptReplay.cancelSubmission(', rpcCatch);
    expect(rpcCatch).toBeGreaterThanOrEqual(0);
    expect(install).toBeGreaterThan(rpcCatch);
    expect(install).toBeLessThan(genericCleanup);
    expect(flush.slice(rpcCatch, genericCleanup)).toContain('codexBridgeMarkPendingTurn(');
    expect(flush.slice(rpcCatch, genericCleanup)).toContain('break;');
  });

  it('registers fresh accepted RPC turns by exact id+attempt and fails closed on lifecycle registration loss', () => {
    const engage = source.slice(
      source.indexOf('async function engageCodexRpc'),
      source.indexOf('function armRpcStartupDialogDismiss'),
    );
    expect(engage).toContain('turnId: cfg.turnId ??');
    expect(engage).toContain('dispatchAttempt: cfg.dispatchAttempt');
    expect(engage).toContain('installAwaitingRpcActivation(');
    expect(engage).toContain('if (!first.nativeTurnId)');
    expect(engage).toContain('installRpcLifecycleFailClosedOwner(firstIdentity, firstGeneration)');
    expect(engage).toContain('activateRpcTurnLifecycle(');
    expect(engage).toContain('firstGeneration,');
    expect(engage).toContain('deferredFreshRpcTurn = {');
    expect(engage).toContain('A dispatched-but-unconfirmed first turn is never re-sent');
    const notSent = engage.indexOf("if (first.outcome === 'not-sent')");
    const durableClaim = engage.indexOf('durableTurnInFlight = true', notSent);
    expect(durableClaim).toBeGreaterThan(notSent);
    expect(engage.slice(notSent, durableClaim)).toContain("return 'not-engaged'");
    expect(engage.match(/installRpcLifecycleFailClosedOwner\(firstIdentity, firstGeneration\)/g))
      .toHaveLength(2);
    expect(engage.match(/awaitingRpcActivationReplayAnchorMs\(firstIdentity, firstGeneration\)/g))
      .toHaveLength(2);
    expect(engage).toContain('codexBridgeMarkPendingTurn(');
  });

  it('generation-fences every awaited RPC engagement stage and never paste-falls back after supersession', () => {
    const engage = source.slice(
      source.indexOf('async function engageCodexRpc'),
      source.indexOf('function armRpcStartupDialogDismiss'),
    );
    const start = engage.indexOf('await engine.start()');
    const startFence = engage.indexOf('assertRpcEngagementCurrent()', start);
    const thread = engage.indexOf('await engine.resumeThread', startFence);
    const threadFence = engage.indexOf('assertRpcEngagementCurrent()', thread);
    const first = engage.indexOf('await engine.sendFirstTurn', threadFence);
    const firstFence = engage.indexOf('assertRpcEngagementCurrent()', first);
    const durable = engage.indexOf('durableTurnInFlight = true', firstFence);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(startFence).toBeGreaterThan(start);
    expect(thread).toBeGreaterThan(startFence);
    expect(threadFence).toBeGreaterThan(thread);
    expect(first).toBeGreaterThan(threadFence);
    expect(firstFence).toBeGreaterThan(first);
    expect(firstFence).toBeLessThan(durable);
    expect(engage).toContain('!rpcEngagementFence.isCurrent(engagementLease)');
    expect(engage).toContain('throw err instanceof CliSpawnSupersededError');
    expect(engage).toContain('clearRpcEnginePidMarker(enginePidMarker)');

    const stop = functionSlice('stopCodexRpcEngine', 'persistentPaneInfo');
    expect(stop).toContain('rpcEngagementFence.invalidate()');
  });

  it('keeps stale RPC write ownership until exact teardown instead of ordinary carryover replay', () => {
    const flush = source.slice(
      source.indexOf('async function flushPending'),
      source.indexOf('function sendToPty'),
    );
    const ackStale = flush.indexOf('if (!writeContinuationIsCurrent())', flush.indexOf('await writeRpcEngine.sendTurn'));
    const ackBreak = flush.indexOf('break;', ackStale);
    const rpcCatch = flush.indexOf('} catch (err: any) {', ackBreak);
    const errorStale = flush.indexOf('if (!writeContinuationIsCurrent())', rpcCatch);
    const errorBreak = flush.indexOf('break;', errorStale);
    expect(flush.slice(ackStale, ackBreak)).toContain('Deferred stale Codex RPC continuation to engine teardown');
    expect(flush.slice(ackStale, ackBreak)).not.toContain('clearAwaitingRpcActivation(');
    expect(flush.slice(ackStale, ackBreak)).not.toContain('handleStaleWriteContinuation(');
    expect(flush.slice(errorStale, errorBreak)).toContain('Deferred stale failed Codex RPC continuation to engine teardown');
    expect(flush.slice(errorStale, errorBreak)).not.toContain('clearAwaitingRpcActivation(');
  });

  it('retires a no-native RPC fail-closed owner when its bounded pre-start attribution lease expires', () => {
    const prune = functionSlice('pruneExpiredStructuredHeadsAndEmit', 'codexBridgeDrainAndMaybeEmit');
    const lookup = prune.indexOf('rpcLifecycleFailClosedOwners.get(ownerKey)');
    const clear = prune.indexOf('clearRpcLifecycleFailClosedOwner(identity, failedClosedGeneration)', lookup);
    const terminal = prune.indexOf('emitTurnTerminal(', clear);
    const restart = prune.indexOf('void restartCliProcess(', clear);
    const pruneReturn = prune.indexOf('if (dropped.length === 0) return false');
    const redrive = prune.indexOf('redriveRejectedStructuredReady()', terminal);
    expect(lookup).toBeGreaterThanOrEqual(0);
    expect(clear).toBeGreaterThan(lookup);
    expect(terminal).toBeGreaterThan(clear);
    expect(restart).toBeGreaterThan(clear);
    expect(terminal).toBeLessThan(restart);
    expect(restart).toBeLessThan(pruneReturn);
    expect(redrive).toBeGreaterThan(terminal);
    expect(prune).toContain('clearAwaitingRpcActivation(identity, failedClosedGeneration)');
    expect(prune).toContain('deferredFreshRpcTurn = undefined');
    expect(prune.indexOf('if (turn.dispatchAttempt === undefined) continue')).toBe(-1);
    expect(prune).toContain("'rpc_delivery_ambiguous_timeout'");
  });

  it('buffers a fast native terminal until exact activation and hydrates output before terminal retirement', () => {
    const handle = functionSlice('handleRpcTurnTerminal', 'activateRpcTurnLifecycle');
    expect(handle).toContain('rpcTurnsAwaitingActivation.get(ownerKey)');
    expect(handle).toContain('pendingRpcTurnTerminals.set(ownerKey, { terminal, generation })');
    expect(handle).toContain('sameRpcGeneration(awaiting, generation)');

    const activate = functionSlice('activateRpcTurnLifecycle', 'releaseRpcTurnTerminalDeferral');
    expect(activate).toContain('codexBridgeQueue.markRpcActive(');
    expect(activate).toContain('identity.turnId,');
    expect(activate).toContain('identity.dispatchAttempt,');
    expect(activate).toContain('codexBridgeQueue.hasTerminalTurn(identity.turnId, identity.dispatchAttempt)');
    expect(activate).toContain('if (transcriptTerminalObserved) emitReadyCodexTurns()');
    expect(activate).toContain('settleRpcTurnTerminal(pendingTerminal.terminal, generation)');

    const hydrate = functionSlice('hydrateCompletedRpcTurn', 'settleRpcTurnTerminal');
    expect(hydrate).toContain('hydrationOwnerKey: ownerKey');
    const hydrationDrain = hydrate.indexOf('codexBridgeDrainAndMaybeEmit({');
    const finalize = hydrate.indexOf('finalizeRpcTurnTerminal(', hydrationDrain);
    expect(hydrationDrain).toBeGreaterThanOrEqual(0);
    expect(finalize).toBeGreaterThan(hydrationDrain);
    expect(hydrate).toContain('CODEX_RPC_TERMINAL_HYDRATION_DELAYS_MS');

    const init = source.slice(source.indexOf('await spawnCli(msg'), source.indexOf('// Queue the initial prompt'));
    expect(init.indexOf('await spawnCli(msg')).toBeLessThan(init.indexOf('releaseRpcTurnTerminalDeferral('));
  });

  it('attaches fresh Codex-family RPC rollouts from offset zero so a fast first terminal remains hydratable', () => {
    const spawn = source.slice(
      source.indexOf('async function spawnCli'),
      source.indexOf('async function restartCliProcess'),
    );
    const codexBranch = spawn.slice(
      spawn.indexOf("} else if (cfg.cliId === 'codex')"),
      spawn.indexOf("} else if (cfg.cliId === 'traex')"),
    );
    const traexBranch = spawn.slice(
      spawn.indexOf("} else if (cfg.cliId === 'traex')"),
      spawn.indexOf("} else if (cfg.cliId === 'coco')"),
    );
    for (const branch of [codexBranch, traexBranch]) {
      expect(branch).toContain("effectiveResume ? 'baseline-existing' : 'fresh-empty'");
      expect(branch).not.toContain("codexBridgeAttach(rolloutPath, 'baseline-existing')");
    }
  });

  it('holds every successor behind an unresolved fail-closed RPC owner even when Codex type-ahead is enabled', () => {
    const flush = source.slice(
      source.indexOf('async function flushPending'),
      source.indexOf('function sendToPty'),
    );
    const preflightGate = flush.indexOf('if (rpcLifecycleFailClosedOwners.size > 0)');
    const typeAheadDecision = flush.indexOf('const typeAheadAllowed = pendingInputAllowsTypeAhead');
    const loopStart = flush.indexOf('while (pendingMessages.length > 0');
    const postWriteBreak = flush.indexOf('if (rpcLifecycleFailClosedOwners.size > 0) break', loopStart);
    expect(preflightGate).toBeGreaterThanOrEqual(0);
    expect(preflightGate).toBeLessThan(typeAheadDecision);
    expect(postWriteBreak).toBeGreaterThan(loopStart);
  });

  it('makes native terminal settlement idempotent and generation-owned across abort/death/stop cleanup', () => {
    const settle = functionSlice('settleRpcTurnTerminal', 'handleRpcTurnTerminal');
    expect(settle).toContain('const existingSettlement = settlingRpcTerminalOwners.get(ownerKey)');
    expect(settle).toContain('sameRpcGeneration(existingSettlement, generation)');
    expect(settle).toContain('codexBridgeQueue.stopRpcActive(');

    const finalize = functionSlice('finalizeRpcTurnTerminal', 'hydrateCompletedRpcTurn');
    expect(finalize).toContain('settlingRpcTerminalOwners.get(ownerKey)');
    expect(finalize).toContain('codexBridgeQueue.dropPendingTurn(identity.turnId, identity.dispatchAttempt, true)');
    // RPC `aborted` must NOT be lumped with `failed`: aborted turns may have
    // already executed side effects, so they map to `ambiguous` (no auto-retry),
    // matching the transcript path. Only a genuine `failed` stays retryable.
    expect(finalize).toContain("terminal.status === 'failed' ? 'failed'");
    expect(finalize).not.toContain("terminal.status === 'failed' || terminal.status === 'aborted'");
    expect(finalize).toContain("terminal.status === 'engine-dead'");
    expect(finalize).toContain("terminal.status === 'stopped'");

    const stop = functionSlice('stopCodexRpcEngine', 'persistentPaneInfo');
    expect(stop.indexOf('engine?.stop()')).toBeLessThan(stop.indexOf('codexRpcEngine = undefined'));
    expect(stop.indexOf('for (const [ownerKey, pending] of [...pendingRpcTurnTerminals])'))
      .toBeLessThan(stop.indexOf('pendingRpcTurnTerminals.clear()'));
    expect(stop).toContain('settleRpcTurnTerminal(pending.terminal, pending.generation)');
    const pendingLoop = stop.slice(
      stop.indexOf('for (const [ownerKey, pending] of [...pendingRpcTurnTerminals])'),
      stop.indexOf('for (const [ownerKey, identity] of [...rpcTurnsAwaitingActivationIdentities])'),
    );
    expect(pendingLoop).toContain('notifyRpcTeardownBeforeActivation(identity, pending.terminal.status)');
    expect(stop).toContain('for (const [ownerKey, identity] of [...rpcTurnsAwaitingActivationIdentities])');
    expect(stop).toContain("'rpc_engine_teardown_before_turn_start_ack'");
    const notify = functionSlice('notifyRpcTeardownBeforeActivation', 'stopCodexRpcEngine');
    expect(notify).toContain('为避免重复执行未自动重发');
    expect(notify).toContain('兜底输出可能未被捕获');
    expect(stop).toContain('turn.finalText === undefined');
    expect(stop).toContain('turn.rpcActive');
    expect(stop).toContain('ownedRpcTurns.has(rpcTurnOwnerKey({');
    expect(stop).toContain('codexBridgeQueue.dropPendingTurn(turn.turnId, turn.dispatchAttempt, true)');
  });

  it('never publishes a dead pre-publication RPC engine or pastes an already-dispatched fresh turn', () => {
    const engage = functionSlice('engageCodexRpc', 'armRpcStartupDialogDismiss');
    const onDead = engage.indexOf('rpcEngagementFence.markDead(engagementLease)');
    const publish = engage.indexOf('codexRpcEngine = engine;');
    expect(onDead).toBeGreaterThanOrEqual(0);
    expect(onDead).toBeLessThan(publish);
    expect(engage).toContain('if (!rpcEngagementFence.isLive(engagementLease))');

    const send = engage.indexOf('await engine.sendFirstTurn(');
    const ownership = engage.indexOf("freshDeliveryOwned = first.outcome !== 'not-sent';", send);
    const postSendFence = engage.indexOf('assertRpcEngagementCurrent();', ownership);
    expect(ownership).toBeGreaterThan(send);
    expect(postSendFence).toBeGreaterThan(ownership);
    expect(postSendFence).toBeLessThan(publish);

    const abort = engage.indexOf(
      'if (err instanceof CodexRpcEngineDiedDuringEngagementError && freshDeliveryOwned)',
    );
    const pasteFallback = engage.indexOf('falling back to paste mode', abort);
    expect(abort).toBeGreaterThan(publish);
    expect(engage.slice(abort, pasteFallback)).toContain('throw err;');
    expect(engage.slice(abort, pasteFallback)).not.toContain("return 'not-engaged'");
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
    expect(prune).toContain('if (retiredRpcOwner || turn.dispatchAttempt !== undefined)');
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

  it('routes Pi and OMP external idle through the busy-viewport guard; ZMX stays fail-open', () => {
    const callback = source.slice(
      source.indexOf('idleDetector.onIdle(async (evidenceSource)'),
      source.indexOf('drainBridgesThenMarkReady(evidenceSource);'),
    );
    // Pi's assistant_final is persisted asynchronously from the TUI clearing
    // Working... — an external idle landing while the authoritative viewport
    // still shows busy must defer exactly like a screen idle.
    expect(callback).toContain("evidenceSource === 'screen'");
    expect(callback).toContain('structuredBridgeIsPi() || structuredBridgeIsOmp()');
    expect(callback).toContain('deferPromptReadyWhileBusy(`${cliName()} ${evidenceSource}-idle`, idleBackend)');

    // The guard fail-opens on non-authoritative screens (ZMX) BEFORE testing
    // the busy pattern, so a stale Working... in ZMX history can never block
    // a structured terminal; on a busy authoritative viewport it re-arms the
    // detector and reuses the busy-pattern probe until the marker clears.
    // Non-visual session busy checks (isSessionBusy) run ahead of screen gates.
    const defer = functionSlice('deferPromptReadyWhileBusy', 'probeBusyPatternIdle');
    const dbGate = defer.indexOf('cliAdapter?.isSessionBusy');
    const authoritativeGate = defer.indexOf('!backendScreenEvidenceIsAuthoritativeForMutation()');
    const busyTest = defer.indexOf('cliAdapter.busyPattern.test(');
    expect(dbGate).toBeGreaterThanOrEqual(0);
    expect(authoritativeGate).toBeGreaterThan(dbGate);
    expect(busyTest).toBeGreaterThan(authoritativeGate);
    expect(defer.indexOf('idleDetector?.reset()', busyTest)).toBeGreaterThan(busyTest);
    expect(defer.indexOf('scheduleBusyPatternIdleProbe(source)', busyTest)).toBeGreaterThan(busyTest);

    // The re-armed probe itself refuses to arm on non-authoritative backends,
    // so a deferred ZMX turn can never be pinned by the probe loop.
    const probe = functionSlice('scheduleBusyPatternIdleProbe', 'spawnCli');
    expect(probe).toContain('if (!backendScreenEvidenceIsAuthoritativeForMutation()) return;');
  });

  it('flushes an OMP trailing candidate only after a complete quiet tick and non-busy viewport', () => {
    const quiet = functionSlice('maybeFlushOmpTrailingFinalOnQuietTick', 'maybeEmitCodexStructuredRateLimit');
    const arm = quiet.indexOf('ompQuietCandidateCompleteOffset = codexBridgeOffset');
    const tailGate = quiet.indexOf('codexBridgePendingTail', arm);
    const lifecycleGate = quiet.indexOf('hasStructuredLifecycleBlock()', arm);
    const authoritativeGate = quiet.indexOf('backendScreenEvidenceIsAuthoritativeForMutation()', arm);
    const capture = quiet.indexOf('captureBackendScreen(backend)', authoritativeGate);
    const busy = quiet.indexOf('cliAdapter.busyPattern.test(busyProbeRegion(screen))', capture);
    const flush = quiet.indexOf('codexBridgeIngest({ flushOmpTrailingFinal: true })', busy);
    expect(arm).toBeGreaterThanOrEqual(0);
    expect(tailGate).toBeGreaterThan(arm);
    expect(lifecycleGate).toBeGreaterThan(arm);
    expect(authoritativeGate).toBeGreaterThan(arm);
    expect(capture).toBeGreaterThan(authoritativeGate);
    expect(busy).toBeGreaterThan(capture);
    expect(flush).toBeGreaterThan(busy);

    const ticker = functionSlice('codexBridgeStartTimer', 'hermesBridgeAttach');
    expect(ticker.indexOf('codexBridgeIngest()'))
      .toBeLessThan(ticker.indexOf('maybeFlushOmpTrailingFinalOnQuietTick()'));
  });

  it('publishes first-turn working from the projected status for argv-baked prompts, as a pure publisher', () => {
    const startScreen = functionSlice('startScreenUpdates', 'stopScreenUpdates');
    const gate = startScreen.indexOf('if (awaitingFirstPrompt) {');
    const gateEnd = startScreen.indexOf('void (async () => {', gate);
    expect(gate).toBeGreaterThanOrEqual(0);
    expect(gateEnd).toBeGreaterThan(gate);
    const channel = startScreen.slice(gate, gateEnd);

    // Gated on spawnArgvNeedsWorkingSeed (argv-baked first prompt), NOT on
    // busyPattern: a non-argv first turn (Claude/Codex/type-ahead) is still booting,
    // so the publisher must be a no-op there and let the queued prompt flush after
    // the ready edge.
    expect(channel).toContain('spawnArgvNeedsWorkingSeed');
    // It publishes the PROJECTED status ('working' during turn one because
    // isPromptReady is still false) rather than scraping the screen for a busy
    // marker — this is the general "sent to the CLI ⇒ working" model.
    expect(channel).toContain('projectedRuntimeScreenStatus()');
    expect(channel).toContain("projected === 'working'");
    expect(channel).toContain("status: 'working'");
    // No screen-scraping: the old busyPattern/capture path is gone from this gate.
    expect(channel).not.toContain('cliAdapter?.busyPattern');
    expect(channel).not.toContain('busyProbeRegion(content)');
    expect(channel).not.toContain('captureBackendScreen(');
    // The channel still ends in the original bare `return;` so the async sampler
    // stays gated during turn one exactly as before.
    expect(/return;\s*}\s*$/.test(channel.trimEnd())).toBe(true);

    // Pure publisher: dedup via the local lastSentStatus only; it must NOT touch
    // isPromptReady, the idle detector, or the argv seed flags — otherwise it
    // would perturb the first-prompt evidence machinery / end-of-turn seed.
    expect(channel).toContain("lastSentStatus !== 'working'");
    expect(channel).toContain("lastSentStatus = 'working'");
    expect(channel).not.toContain('isPromptReady =');
    expect(channel).not.toContain('idleDetector');
    expect(channel).not.toContain('spawnArgvInitialPromptBusy =');
    expect(channel).not.toContain('spawnArgvNeedsWorkingSeed =');
  });

  it('suppresses the markPromptReady generic idle snapshot while the Grok-class busy arm is pending', () => {
    const body = functionSlice('markPromptReady', 'persistCliSessionId');
    // The "immediate idle snapshot" fires before the seed consumes
    // spawnArgvInitialPromptBusy. For a Grok-class pre-execution ready edge that
    // generic snapshot projects idle (isPromptReady just went true) and would reach
    // the daemon BEFORE the busy arm re-publishes working — combined with the
    // first-turn publisher's working, that working→idle fires a premature DONE. The
    // snapshot must be gated on !spawnArgvInitialPromptBusy so no idle escapes.
    const idleSnapshot = body.indexOf('Send immediate idle snapshot');
    const guardedSend = body.indexOf('renderer && !spawnArgvInitialPromptBusy && pendingMessages.length === 0', idleSnapshot);
    expect(idleSnapshot).toBeGreaterThanOrEqual(0);
    expect(guardedSend).toBeGreaterThan(idleSnapshot);
    // The busy arm below still owns the working publish for this path.
    const busyArm = body.indexOf('if (spawnArgvInitialPromptBusy) {', guardedSend);
    const armWorking = body.indexOf("publishScreenStatus('working', { force: true })", busyArm);
    expect(busyArm).toBeGreaterThan(guardedSend);
    expect(armWorking).toBeGreaterThan(busyArm);
  });


  it('scopes the argv turn-start evidence machinery and its flush side effect to Pi', () => {
    // The transcript-evidence latch lives on the GENERIC codexBridgeIngest
    // path, which also serves Grok (argv-baked + structured bridge +
    // type-ahead). Its flush side effect must be Pi-gated, or Grok would gain
    // a new startup-window write whose first ready is owned by the
    // SessionStart busy arm instead.
    const note = functionSlice('noteSpawnArgvTurnStartTranscriptEvidence', 'stopSpawnArgvTurnStartFailOpen');
    const piGuard = note.indexOf('if (!structuredBridgeIsPi()) return;');
    const latch = note.indexOf('spawnArgvTurnStartEvidenceSeen = true');
    const flush = note.indexOf('flushQueuedInputAfterTurnStartEvidence()');
    expect(piGuard).toBeGreaterThanOrEqual(0);
    expect(latch).toBeGreaterThan(piGuard);
    expect(flush).toBeGreaterThan(latch);

    const gate = functionSlice('spawnArgvTurnStartGateHolds', 'noteSpawnArgvTurnStartTranscriptEvidence');
    expect(gate).toContain('structuredBridgeIsPi()');

    // markPromptReady branch boundary: the no-evidence gate must NOT re-kick
    // (startup input protection — the TUI may not accept input yet); the
    // lifecycle-block branch must re-kick (turn-start evidence exists there).
    // functionSlice('markPromptReady', …) starts at markPromptReadyFromPty
    // (prefix match) and also spans the helper definitions, so anchor on the
    // literal markPromptReady body before locating the two gate branches.
    const body = functionSlice('markPromptReady', 'persistCliSessionId');
    const markStart = body.indexOf('function markPromptReady(): void');
    expect(markStart).toBeGreaterThanOrEqual(0);
    const evidenceGate = body.indexOf('if (spawnArgvTurnStartGateHolds()) {', markStart);
    const lifecycleGate = body.indexOf('if (hasStructuredLifecycleBlock() && !spawnArgvInitialPromptBusy) {', markStart);
    expect(evidenceGate).toBeGreaterThanOrEqual(0);
    expect(lifecycleGate).toBeGreaterThan(evidenceGate);
    expect(body.slice(evidenceGate, lifecycleGate)).not.toContain('flushQueuedInputAfterTurnStartEvidence');
    expect(body.slice(lifecycleGate)).toContain('flushQueuedInputAfterTurnStartEvidence()');
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
