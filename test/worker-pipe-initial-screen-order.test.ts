import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('worker pipe initial screen ordering', () => {
  it('captures pipe initial screen after idle detector is registered', () => {
    const source = readFileSync(join(process.cwd(), 'src/worker.ts'), 'utf8');
    // The inline `const initial = backend.captureCurrentScreen()` was refactored
    // into the shared seedBackendScreen() helper; the pipe-reattach seed is the
    // call with the `${effectiveBackendType} reattach` label (distinct from the
    // adopt-branch seeds, which run in earlier early-return paths). It must still
    // come after idle detector registration.
    const captureIdx = source.indexOf('seedBackendScreen(`${effectiveBackendType} reattach`, backend);');
    const idleIdx = source.indexOf('// Set up idle detection');
    expect(captureIdx).toBeGreaterThan(idleIdx);
  });

  it('starts Codex App warm liveness only after old-key challenge proof, not from a backend flag', () => {
    const source = readFileSync(join(process.cwd(), 'src/worker.ts'), 'utf8');
    const activationIdx = source.indexOf('function activateCodexAppControlConnection(');
    const proofKindIdx = source.indexOf("const proofKind = identity.generation === codexAppFreshCandidateGeneration", activationIdx);
    const beginIdx = source.indexOf('codexAppTurnLiveness.beginReattachObservation();', proofKindIdx);
    const pipeGateIdx = source.indexOf('if (isPipeMode && backend && isPersistentBackendReattach)');
    const seedIdx = source.indexOf('seedBackendScreen(`${effectiveBackendType} reattach`, backend);', pipeGateIdx);

    expect(activationIdx).toBeGreaterThan(-1);
    expect(proofKindIdx).toBeGreaterThan(activationIdx);
    expect(beginIdx).toBeGreaterThan(proofKindIdx);
    expect(seedIdx).toBeGreaterThan(pipeGateIdx);
    expect(source).not.toContain('shouldBeginCodexAppReattachObservation({');
  });

  it('runs a busy-pattern idle probe after each submitted input', () => {
    const source = readFileSync(join(process.cwd(), 'src/worker.ts'), 'utf8');
    // After hybrid RPC merge, structured write may go through writeAdapter path.
    let writeIdx = source.indexOf('result = item.codexAppInput && writeAdapter.writeStructuredInput');
    if (writeIdx < 0) {
      writeIdx = source.indexOf('await writeAdapter.writeStructuredInput(writeBackend, msg, item.codexAppInput)');
    }
    if (writeIdx < 0) {
      writeIdx = source.indexOf('result = await cliAdapter.writeStructuredInput(backend, msg, item.codexAppInput);');
    }
    const probeIdx = source.indexOf('scheduleBusyPatternIdleProbe(`${cliName()} post-submit`);');
    const helperIdx = source.indexOf('function scheduleBusyPatternIdleProbe(source: string): void');

    expect(helperIdx).toBeGreaterThan(-1);
    expect(writeIdx).toBeGreaterThan(-1);
    expect(probeIdx).toBeGreaterThan(writeIdx);
  });

  it('rechecks busy-pattern adapters when a Lark message is queued while busy', () => {
    const source = readFileSync(join(process.cwd(), 'src/worker.ts'), 'utf8');
    const queueLogIdx = source.indexOf('Queued message (${pendingMessages.length} pending)');
    const queuedProbeIdx = source.indexOf('scheduleBusyPatternIdleProbe(`${cliName()} queued-message`);');
    const helperIdx = source.indexOf('function scheduleBusyPatternIdleProbe(source: string): void');

    expect(helperIdx).toBeGreaterThan(-1);
    expect(queueLogIdx).toBeGreaterThan(-1);
    expect(queuedProbeIdx).toBeGreaterThan(queueLogIdx);
  });

  it('rechecks busy-pattern adapters after first prompt timeout fallback unlocks startup', () => {
    const source = readFileSync(join(process.cwd(), 'src/worker.ts'), 'utf8');
    const fallbackStart = source.indexOf('const releaseFirstPromptTimeout =');
    const releaseIdx = source.indexOf('awaitingFirstPrompt = false;', fallbackStart);
    const probeIdx = source.indexOf('probeBusyPatternIdle(`${cliName()} first-prompt-timeout`, backend)', releaseIdx);

    expect(fallbackStart).toBeGreaterThan(-1);
    expect(releaseIdx).toBeGreaterThan(fallbackStart);
    expect(probeIdx).toBeGreaterThan(-1);
    expect(probeIdx).toBeGreaterThan(releaseIdx);
  });

  it('gates the first-prompt soft timeout through shouldReleaseFirstPromptTimeout with a hard cap', () => {
    // Pin the defer-then-hard-cap structure, not just the probe ordering. Without
    // this, reverting the closure to an unconditional 15s force-flush (the exact
    // bug this fix closes) would keep the ordering guard above green.
    const source = readFileSync(join(process.cwd(), 'src/worker.ts'), 'utf8');
    const fallbackStart = source.indexOf('const releaseFirstPromptTimeout =');
    const releaseIdx = source.indexOf('awaitingFirstPrompt = false;', fallbackStart);
    const gateIdx = source.indexOf('shouldReleaseFirstPromptTimeout(', fallbackStart);
    const hardCapIdx = source.indexOf('FIRST_PROMPT_HARD_TIMEOUT_MS', fallbackStart);
    const hardTimerIdx = source.indexOf('releaseFirstPromptTimeout(FIRST_PROMPT_HARD_TIMEOUT_MS, true)', fallbackStart);

    expect(fallbackStart).toBeGreaterThan(-1);
    // The defer gate must be consulted BEFORE the queue is released.
    expect(gateIdx).toBeGreaterThan(fallbackStart);
    expect(gateIdx).toBeLessThan(releaseIdx);
    // A hard cap + hard-timer reschedule must exist so a deferred CLI cannot
    // trap the first queued prompt forever.
    expect(hardCapIdx).toBeGreaterThan(fallbackStart);
    expect(hardTimerIdx).toBeGreaterThan(fallbackStart);
  });

  it('treats Claude SessionStart as a boundary and waits for fresh prompt evidence', () => {
    const source = readFileSync(join(process.cwd(), 'src/worker.ts'), 'utf8');
    const settleStart = source.indexOf('function settleThenFlush');
    const markIdx = source.indexOf('markPromptReady();', settleStart);
    const flushIdx = source.indexOf('void flushPending();', settleStart);
    const sessionReadyCase = source.indexOf("case 'session_ready'");
    const waitDecisionIdx = source.indexOf(
      'const waitForPostHookPrompt = shouldWaitForPostSessionStartPromptEvidence({',
      sessionReadyCase,
    );
    const resetEvidenceIdx = source.indexOf('idleDetector?.resetReadyEvidence();', waitDecisionIdx);
    const ptyReadyIdx = source.indexOf('markPromptReadyFromPty();');
    const screenEvidenceGuardIdx = source.indexOf("if (evidenceSource === 'screen')");
    const signalReleaseIdx = source.indexOf(
      "releaseReadyGate('SessionStart hook', { promptReadyAfterSettle: !waitForPostHookPrompt });",
      sessionReadyCase,
    );
    const timeoutReleaseIdx = source.indexOf("releaseReadyGate('signal timeout fallback');");
    const flushStart = source.indexOf('async function flushPending');
    const postHookFlushGuardIdx = source.indexOf(
      'if (awaitingPostSessionStartPromptEvidence)',
      flushStart,
    );
    const ackIdx = source.indexOf(
      "send({ type: 'session_ready_ack', requestId: msg.requestId });",
      sessionReadyCase,
    );

    expect(settleStart).toBeGreaterThan(-1);
    expect(markIdx).toBeGreaterThan(settleStart);
    expect(flushIdx).toBeGreaterThan(markIdx);
    expect(sessionReadyCase).toBeGreaterThan(-1);
    expect(waitDecisionIdx).toBeGreaterThan(sessionReadyCase);
    expect(resetEvidenceIdx).toBeGreaterThan(waitDecisionIdx);
    expect(ptyReadyIdx).toBeGreaterThan(-1);
    expect(screenEvidenceGuardIdx).toBeGreaterThan(-1);
    expect(ptyReadyIdx).toBeGreaterThan(screenEvidenceGuardIdx);
    expect(signalReleaseIdx).toBeGreaterThan(sessionReadyCase);
    expect(postHookFlushGuardIdx).toBeGreaterThan(flushStart);
    expect(postHookFlushGuardIdx).toBeLessThan(source.indexOf('isFlushing = true;', flushStart));
    expect(ackIdx).toBeGreaterThan(signalReleaseIdx);
    // Timeout fallback must stay conservative: it opens the gate but does not
    // force prompt-ready for a CLI whose true ready signal never arrived.
    expect(timeoutReleaseIdx).toBeGreaterThan(-1);
  });

  it('defers idle detected during ready-gate settle so the first prompt still flushes', () => {
    const source = readFileSync(join(process.cwd(), 'src/worker.ts'), 'utf8');
    const markStart = source.indexOf('function markPromptReady');
    const markEnd = source.indexOf('function persistCliSessionId', markStart);
    const mark = source.slice(markStart, markEnd);
    const settleStart = source.indexOf('function settleThenFlush');
    const settleEnd = source.indexOf('/** Release the ready-gate', settleStart);
    const settle = source.slice(settleStart, settleEnd);

    const settleGuardIdx = mark.indexOf('if (isSettlingFirstFlush)');
    const deferredFlagIdx = mark.indexOf('promptReadyDetectedDuringSettle = true;', settleGuardIdx);
    const readySetIdx = mark.indexOf('isPromptReady = true;');
    expect(settleGuardIdx).toBeGreaterThan(-1);
    expect(deferredFlagIdx).toBeGreaterThan(settleGuardIdx);
    expect(deferredFlagIdx).toBeLessThan(readySetIdx);

    // THE HERMES FIX (gate fallback path): when markPromptReady fires while the
    // ready-gate is still holding (a readyPattern like ❯ appeared before the
    // SessionStart signal), it must record readyPatternSeenDuringHold so the
    // gate's timeout-fallback settle marks the prompt ready — otherwise a
    // non-type-ahead adapter's held first message is dropped by flushPending()
    // on !isPromptReady && !typeAheadAllowed.
    const holdGuardIdx = mark.indexOf('if (readyGate.shouldHold())');
    const holdFlagIdx = mark.indexOf('readyPatternSeenDuringHold = true;', holdGuardIdx);
    expect(holdGuardIdx).toBeGreaterThan(-1);
    expect(holdFlagIdx).toBeGreaterThan(holdGuardIdx);
    expect(holdFlagIdx).toBeLessThan(readySetIdx);

    const decideIdx = settle.indexOf('const shouldMarkPromptReady = decideSettleMarkReady({');
    expect(decideIdx).toBeGreaterThan(-1);
    // readyPatternSeenDuringHold must be wired into the settle decision.
    expect(settle.indexOf('readyPatternSeenDuringHold,', decideIdx)).toBeGreaterThan(decideIdx);
    // Both deferred flags are reset after the decision (so the next spawn is clean).
    expect(settle.indexOf('promptReadyDetectedDuringSettle = false;', decideIdx)).toBeGreaterThan(decideIdx);
    expect(settle.indexOf('readyPatternSeenDuringHold = false;', decideIdx)).toBeGreaterThan(decideIdx);
    expect(settle.indexOf('markPromptReady();', decideIdx)).toBeGreaterThan(decideIdx);
  });

  it('forces the first prompt for non-type-ahead adapters at the hard timeout', () => {
    // THE HERMES FIX (hard-timeout path): previously the hard cap only logged
    // "forcing queued message flush" and flushed for type-ahead adapters only;
    // non-type-ahead adapters (Hermes) never delivered. The release must now
    // route non-type-ahead adapters to markPromptReady() (which then flushes).
    const source = readFileSync(join(process.cwd(), 'src/worker.ts'), 'utf8');
    const fallbackStart = source.indexOf('const releaseFirstPromptTimeout =');
    const decideIdx = source.indexOf("decideHardTimeoutAction(cliAdapter?.supportsTypeAhead === true)", fallbackStart);
    const markReadyIdx = source.indexOf('markPromptReady();', decideIdx);
    const flushIdx = source.indexOf("if (decideHardTimeoutAction(cliAdapter?.supportsTypeAhead === true) === 'flush')", fallbackStart);

    expect(fallbackStart).toBeGreaterThan(-1);
    expect(decideIdx).toBeGreaterThan(fallbackStart);
    // The type-ahead flush branch and the non-type-ahead mark-ready path both
    // exist, in the right order.
    expect(flushIdx).toBeGreaterThan(fallbackStart);
    expect(markReadyIdx).toBeGreaterThan(flushIdx);
  });

  it('rejects Codex App prompts before proof and while the explicit queue is active', () => {
    const source = readFileSync(join(process.cwd(), 'src/worker.ts'), 'utf8');
    const markStart = source.indexOf('function markPromptReady');
    const markEnd = source.indexOf('function persistCliSessionId', markStart);
    const mark = source.slice(markStart, markEnd);

    const livenessGuardIdx = mark.indexOf(
      "if (lastInitConfig?.cliId === 'codex-app' && !codexAppTurnLiveness.notePrompt())",
    );
    const proofGuardIdx = mark.indexOf(
      "if (lastInitConfig?.cliId === 'codex-app' && !codexAppControlProven)",
    );
    const signedIdleGuardIdx = mark.indexOf(
      "if (lastInitConfig?.cliId === 'codex-app' && !codexAppReadyAuthority.canPublishPromptReady())",
    );
    const readySetIdx = mark.indexOf('isPromptReady = true;');
    const promptReadySendIdx = mark.indexOf("send({ type: 'prompt_ready' });");
    const idleUpdateIdx = mark.indexOf(
      'usageLimitTracker.classify(content, projectedRuntimeScreenStatus())',
    );

    expect(proofGuardIdx).toBeGreaterThan(-1);
    expect(proofGuardIdx).toBeLessThan(livenessGuardIdx);
    expect(livenessGuardIdx).toBeGreaterThan(-1);
    expect(signedIdleGuardIdx).toBeGreaterThan(livenessGuardIdx);
    // The explicit runner queue wins before any immediate daemon/card status
    // projection; returning from the guard therefore suppresses both paths.
    // The shared projector composes the structured lifecycle gate with signed
    // Codex App liveness instead of hard-coding an idle card update here.
    expect(livenessGuardIdx).toBeLessThan(readySetIdx);
    expect(signedIdleGuardIdx).toBeLessThan(readySetIdx);
    expect(readySetIdx).toBeLessThan(promptReadySendIdx);
    expect(promptReadySendIdx).toBeLessThan(idleUpdateIdx);
  });

  it('lets explicit Codex App activity override a stale idle screen heuristic', () => {
    const source = readFileSync(join(process.cwd(), 'src/worker.ts'), 'utf8');
    const helperStart = source.indexOf('function codexAppLivenessStatus');
    const helperEnd = source.indexOf('// Per-turn usage-limit state machine', helperStart);
    const helper = source.slice(helperStart, helperEnd);
    const activityStart = source.indexOf("if (kind === 'activity' && lastInitConfig?.cliId === 'codex-app')");
    const activityEnd = source.indexOf("if (kind === 'final'", activityStart);
    const activity = source.slice(activityStart, activityEnd);

    expect(helper).toContain("liveness.active && base === 'idle' ? 'working' : base");
    expect(activity).toContain('applyTrustedCodexAppActivityMarker(');
    expect(activity).toContain('if (!activity.accepted)');
    expect(activity).toContain('isPromptReady = false;');
  });

  it('re-drives a deferred Codex App prompt after a queued submit cancellation', () => {
    const source = readFileSync(join(process.cwd(), 'src/worker.ts'), 'utf8');
    const flushStart = source.indexOf('async function flushPending');
    const flushEnd = source.indexOf('function sendToPty', flushStart);
    const flush = source.slice(flushStart, flushEnd);

    expect(flush.match(/codexAppPromptReplay\.cancelSubmission\(\s*codexAppTurnLiveness,\s*codexAppReadyAuthority,\s*codexAppLivenessHandle,?\s*\)/g)).toHaveLength(2);
    expect(flush).toContain('codexAppPromptReplay.consumeAfterFlush(codexAppTurnLiveness)');
    expect(flush.lastIndexOf('markPromptReady();')).toBeGreaterThan(flush.lastIndexOf('isFlushing = false;'));
  });

  it('persists a late-created public candidate before spawn and never trusts Codex App OSC', () => {
    const source = readFileSync(join(process.cwd(), 'src/worker.ts'), 'utf8');
    const prepareIdx = source.indexOf('await prepareCodexAppControlGeneration(cfg, willReattachPersistent, !!persistentSessionName);');
    const candidateIdx = source.indexOf('prepareFreshCodexAppControlBootstrap(cfg, !!persistentSessionName);');
    const injectIdx = source.indexOf('childEnv[CODEX_APP_CONTROL_BOOTSTRAP_ENV] = codexAppControlBootstrapPathForSpawn;');
    const spawnIdx = source.indexOf('backend.spawn(spawnBin, spawnArgs');
    const finalizeIdx = source.indexOf('finalizeCodexAppControlGeneration(', spawnIdx);
    const onDataIdx = source.indexOf('backend.onData(onPtyData);', spawnIdx);
    const finalizeStart = source.indexOf('function finalizeCodexAppControlGeneration(');
    const finalizeEnd = source.indexOf('function rejectCodexAppControlMarker', finalizeStart);
    const finalize = source.slice(finalizeStart, finalizeEnd);

    expect(prepareIdx).toBeGreaterThan(-1);
    expect(candidateIdx).toBeGreaterThan(prepareIdx);
    expect(injectIdx).toBeGreaterThan(candidateIdx);
    expect(spawnIdx).toBeGreaterThan(injectIdx);
    expect(finalizeIdx).toBeGreaterThan(spawnIdx);
    expect(onDataIdx).toBeGreaterThan(finalizeIdx);
    expect(finalize).toContain("codexAppControlProven && codexAppControlStateValue?.status === 'active'");
    expect(source).toContain("const APP_RUNNER_OSC_CLI_IDS = new Set(['mira', 'mir']);");
    expect(source).not.toContain('CODEX_APP_CONTROL_NONCE_ENV');
    expect(source).not.toContain('codexAppControlNonceForSpawn');
  });

  it('awaits bind and locator publication before every backend spawn path', () => {
    const source = readFileSync(join(process.cwd(), 'src/worker.ts'), 'utf8');
    const spawnStart = source.indexOf('async function spawnCli(');
    const prepareIdx = source.indexOf('await prepareCodexAppControlGeneration(', spawnStart);
    const pluginPrepareIdx = source.indexOf('await prepareCliPluginGenerationAndGateway(cfg, cliAdapter)', prepareIdx);
    const backendSpawnIdx = source.indexOf('backend.spawn(spawnBin, spawnArgs', prepareIdx);

    expect(spawnStart).toBeGreaterThan(-1);
    expect(prepareIdx).toBeGreaterThan(spawnStart);
    expect(backendSpawnIdx).toBeGreaterThan(prepareIdx);
    expect(source.match(/await spawnCli\(/g)).toHaveLength(3);
    expect(source.slice(spawnStart, prepareIdx)).toContain('const spawnGeneration = ++cliSpawnGeneration;');
    expect(source.slice(prepareIdx, backendSpawnIdx))
      .toContain('if (spawnGeneration !== cliSpawnGeneration) throw new CliSpawnSupersededError();');
    expect(source.slice(pluginPrepareIdx, backendSpawnIdx)
      .match(/if \(spawnGeneration !== cliSpawnGeneration\) throw new CliSpawnSupersededError\(\);/g))
      .toHaveLength(2);
    expect(source).toContain('function killCli(opts: { preservePending?: boolean } = {}): void {\n  cliSpawnGeneration++;');
    expect(source.match(/err instanceof CliSpawnSupersededError/g)).toHaveLength(3);
  });

  it('uses hardened locators, random endpoints, and process-lifetime publisher leases', () => {
    const source = readFileSync(join(process.cwd(), 'src/worker.ts'), 'utf8');
    const prepareStart = source.indexOf('async function prepareCodexAppControlGeneration(');
    const prepareEnd = source.indexOf('/** Late-create the only secret-bearing file', prepareStart);
    const prepare = source.slice(prepareStart, prepareEnd);
    const bootstrapStart = prepareEnd;
    const bootstrapEnd = source.indexOf('function finalizeCodexAppControlGeneration(', bootstrapStart);
    const bootstrap = source.slice(bootstrapStart, bootstrapEnd);
    const acceptStart = source.indexOf('function acceptCodexAppControlSocket(');
    const acceptEnd = source.indexOf('function removeStaleCodexAppSocket', acceptStart);
    const accept = source.slice(acceptStart, acceptEnd);
    const stopStart = source.indexOf('function stopCodexAppControlChannel(');
    const stopEnd = source.indexOf('function failCodexAppControlGeneration', stopStart);
    const stop = source.slice(stopStart, stopEnd);

    expect(prepare).toContain("process.platform === 'win32' ? codexAppWindowsControlRoot()");
    const leaseIdx = prepare.indexOf('await ensureCodexAppWindowsOwnerLease(cfg.sessionId)');
    const locatorIdx = prepare.indexOf('codexAppControlLocatorPath(controlRoot, cfg.sessionId)');
    expect(leaseIdx).toBeGreaterThan(-1);
    expect(locatorIdx).toBeGreaterThan(leaseIdx);
    expect(prepare).toContain('else await ensureCodexAppPosixOwnerLease(controlRoot, cfg.sessionId);');
    expect(prepare).toContain('codexAppControlLocatorPath(controlRoot, cfg.sessionId)');
    expect(prepare).toContain('const started = await startCodexAppControlEndpoint(cfg, channelId);');
    expect(source).toContain('await bindThenPublishCodexAppControlLocator({');
    expect(source).toContain('generateCodexAppWindowsPipeEndpoint()');
    expect(source).toContain('generateCodexAppPosixSocketEndpoint(codexAppControlSocketDirectory)');
    expect(bootstrap).toContain("{ kind: 'locator', locatorPath: codexAppControlLocatorPathValue }");
    expect(accept).toContain("rotateCodexAppControlEndpoint('active socket closed')");
    expect(accept).toContain('if (wasActive');
    expect(stop).toContain("if (socketPath && process.platform !== 'win32')");
    expect(stop).not.toContain('unlinkSync(codexAppControlLocatorPathValue)');
    expect(prepare).toContain('Deleting first would');
    const killStart = source.indexOf('function killCli(');
    const killEnd = source.indexOf('function cleanup()', killStart);
    const cleanupStart = source.indexOf('function cleanup()');
    const cleanupEnd = source.indexOf("process.on('SIGTERM'", cleanupStart);
    expect(source.slice(killStart, killEnd)).not.toContain('releaseCodexAppPosixOwnerLease()');
    expect(source.slice(cleanupStart, cleanupEnd)).toContain('releaseCodexAppPosixOwnerLease();');
  });

  it('prevents retired async endpoints from publishing or failing a newer channel', () => {
    const source = readFileSync(join(process.cwd(), 'src/worker.ts'), 'utf8');
    const start = source.slice(
      source.indexOf('async function startCodexAppControlEndpoint('),
      source.indexOf('function installCodexAppControlEndpoint('),
    );
    const rotateStart = source.indexOf('function rotateCodexAppControlEndpoint(');
    const rotate = source.slice(
      rotateStart,
      source.indexOf('async function prepareCodexAppControlGeneration(', rotateStart),
    );

    expect(start.indexOf('channelId !== codexAppControlChannelId')).toBeLessThan(
      start.indexOf('writeCodexAppControlLocator(locatorPath, locator);'),
    );
    expect(start).toContain('if (codexAppControlServer === server)');
    expect(rotate).toContain('if (shouldFailCodexAppControlChannel({');
    expect(rotate).toContain('if (codexAppControlRotation === rotation) codexAppControlRotation = undefined;');
  });

  it('keeps an unproved endpoint bound until the shared 90-second fail-close deadline', () => {
    const source = readFileSync(join(process.cwd(), 'src/worker.ts'), 'utf8');
    const acceptStart = source.indexOf('function acceptCodexAppControlSocket(');
    const acceptEnd = source.indexOf('function removeStaleCodexAppSocket', acceptStart);
    const accept = source.slice(acceptStart, acceptEnd);
    const finalizeStart = source.indexOf('function finalizeCodexAppControlGeneration(');
    const finalizeEnd = source.indexOf('function rejectCodexAppControlMarker', finalizeStart);
    const finalize = source.slice(finalizeStart, finalizeEnd);

    expect(accept).toContain('Rotate only after the authenticated runner closes.');
    expect(accept).toContain('if (wasActive');
    expect(accept).toContain('codexAppProofDeadline.arm(() => {');
    expect(accept).toContain('did not re-authenticate within');
    expect(accept).not.toContain('pre-auth socket closed');
    expect(finalize).toContain('codexAppProofDeadline.arm(() => {');
  });

  it('shares the 90-second first-prompt cap with bootstrap cleanup and runner proof', () => {
    const source = readFileSync(join(process.cwd(), 'src/worker.ts'), 'utf8');
    const bootstrapStart = source.indexOf('function prepareFreshCodexAppControlBootstrap(');
    const bootstrapEnd = source.indexOf('function finalizeCodexAppControlGeneration(', bootstrapStart);
    const bootstrap = source.slice(bootstrapStart, bootstrapEnd);
    const proofStart = bootstrapEnd;
    const proofEnd = source.indexOf('function rejectCodexAppControlMarker', proofStart);
    const proof = source.slice(proofStart, proofEnd);

    expect(source).toContain('const FIRST_PROMPT_HARD_TIMEOUT_MS = CODEX_APP_CONTROL_STARTUP_TIMEOUT_MS;');
    expect(bootstrap).toContain('armCodexAppControlStartupTimeout(cleanupCodexAppControlBootstrap)');
    expect(proof).toContain('codexAppProofDeadline.arm(() => {');
    expect(bootstrap).not.toContain('30_000');
    expect(proof).not.toContain('30_000');
  });

  it('kills legacy/no-public-key reattach and fail-closes candidate setup before PTY listeners attach', () => {
    const source = readFileSync(join(process.cwd(), 'src/worker.ts'), 'utf8');
    const preflightIdx = source.indexOf('shouldColdStartCodexAppReattach({');
    const preflightKillIdx = source.indexOf('killPersistentSession(', preflightIdx);
    const prepareIdx = source.indexOf('prepareCodexAppControlGeneration(', preflightIdx);
    const finalizeIdx = source.indexOf('finalizeCodexAppControlGeneration(', prepareIdx);
    const failureKillIdx = source.indexOf('killPersistentSession(', finalizeIdx);
    const onDataIdx = source.indexOf('backend.onData(onPtyData);', finalizeIdx);

    expect(preflightIdx).toBeGreaterThan(-1);
    expect(preflightKillIdx).toBeGreaterThan(preflightIdx);
    expect(preflightKillIdx).toBeLessThan(prepareIdx);
    expect(finalizeIdx).toBeGreaterThan(prepareIdx);
    expect(failureKillIdx).toBeGreaterThan(finalizeIdx);
    expect(failureKillIdx).toBeLessThan(onDataIdx);
  });

  it('honors a true ready signal that arrives AFTER the timeout fallback (slow cold start)', () => {
    // ReadyGate.receive() is one-shot: once the 45s fallback fires, a later
    // releaseReadyGate from the real signal is skipped entirely. A CLI whose
    // cold start exceeds READY_SIGNAL_TIMEOUT_MS (Hermes: 2-3 min) would then
    // never take the authoritative markPromptReady path. The session_ready case
    // must detect the late arrival (gate armed + already received) and mark
    // prompt-ready directly for authoritative non-Claude signals. Claude waits
    // for post-hook prompt evidence instead. Both paths are limited to the
    // first-prompt phase, so clear/compact SessionStart stays a no-op.
    const source = readFileSync(join(process.cwd(), 'src/worker.ts'), 'utf8');
    const sessionReadyCase = source.indexOf("case 'session_ready'");
    const lateCheckIdx = source.indexOf('readyGate.isArmed && readyGate.isReceived', sessionReadyCase);
    const lateGuardIdx = source.indexOf('awaitingFirstPrompt && !isPromptReady', sessionReadyCase);
    const claudeGuardIdx = source.indexOf('&& !waitForPostHookPrompt', lateGuardIdx);
    const lateMarkIdx = source.indexOf('markPromptReady();', lateGuardIdx);
    const caseEnd = source.indexOf('case ', sessionReadyCase + 1);

    expect(sessionReadyCase).toBeGreaterThan(-1);
    expect(lateCheckIdx).toBeGreaterThan(sessionReadyCase);
    expect(lateCheckIdx).toBeLessThan(caseEnd);
    expect(lateGuardIdx).toBeGreaterThan(lateCheckIdx);
    expect(claudeGuardIdx).toBeGreaterThan(lateGuardIdx);
    expect(claudeGuardIdx).toBeLessThan(lateMarkIdx);
    expect(lateMarkIdx).toBeGreaterThan(lateGuardIdx);
    expect(lateMarkIdx).toBeLessThan(caseEnd);
  });

  it('limits busy-pattern idle probes to the active status region', () => {
    const source = readFileSync(join(process.cwd(), 'src/worker.ts'), 'utf8');
    const helperStart = source.indexOf('function busyProbeRegion(content: string): string');
    const probeStart = source.indexOf('function probeBusyPatternIdle');
    const probeEnd = source.indexOf('function scheduleReattachIdleProbe');
    const helper = source.slice(helperStart, probeEnd);
    const probe = source.slice(probeStart, probeEnd);

    expect(helperStart).toBeGreaterThan(-1);
    expect(helper).toContain('const tailLineCount = Math.max(12, Math.ceil(lines.length / 3));');
    expect(probe).toContain('cliAdapter.busyPattern.test(busyProbeRegion(content))');
    expect(probe).not.toContain('cliAdapter.busyPattern.test(content)');
  });

  it('limits the reattach idle probe to adapters with a busy marker', () => {
    const source = readFileSync(join(process.cwd(), 'src/worker.ts'), 'utf8');
    const helperStart = source.indexOf('function scheduleReattachIdleProbe');
    const helperEnd = source.indexOf('function stopReattachIdleProbe');
    const helper = source.slice(helperStart, helperEnd);

    expect(helperStart).toBeGreaterThan(-1);
    expect(helper).toContain('if (!cliAdapter?.busyPattern || (!be.captureCurrentScreen && !be.captureViewport)) return;');
    expect(helper).toContain('if (backend !== be || !awaitingFirstPrompt || isPromptReady) return;');
    expect(helper).not.toContain('pendingMessages.length > 0');
  });

  it('hard-gates an unavailable persistent backend instead of silently falling back to pty', () => {
    const source = readFileSync(join(process.cwd(), 'src/worker.ts'), 'utf8');
    const guardStart = source.indexOf('let effectiveBackend = cfg.backendType;');
    const guardEnd = source.indexOf('effectiveBackendType = effectiveBackend;', guardStart);
    const guard = source.slice(guardStart, guardEnd);

    expect(guardStart).toBeGreaterThan(-1);
    expect(guardEnd).toBeGreaterThan(guardStart);
    // A live tmux session is checked before probing so it can reattach (PR#249).
    expect(guard).toContain('TmuxBackend.hasSession(TmuxBackend.sessionName(cfg.sessionId))');
    expect(guard.indexOf('TmuxBackend.hasSession')).toBeLessThan(guard.indexOf('probeTmuxFunctional'));
    // The decision is made by the pure gate helper, and a gate posts an
    // actionable error IPC + throws — it must NOT silently downgrade to pty.
    // The daemon renders WorkerToDaemon.error to Lark, avoiding the old
    // user_notify + error duplicate.
    expect(guard).toContain('decideBackendGate(');
    expect(guard).toContain('throw new Error(backendGateUserMessage(');
    expect(guard).not.toContain("effectiveBackend = 'pty'");
    expect(source).toContain('await sendAndFlush({');
    // The crash-loop relaunch carries the message's own durable attempt so a
    // meeting delivery relaunch failure is attributed to the right receipt
    // (not the stale currentBotmux* from a prior IM turn).
    expect(source).toContain('await sendFatalWorkerErrorAndExit(err, msg.turnId, msg.dispatchAttempt)');
    expect(source).toContain('await sendFatalWorkerErrorAndExit(err);');
  });

  it('wires adoptCliPid/cliCwd on herdr adopt (parity with tmux/zellij for grok writeInput)', () => {
    const source = readFileSync(join(process.cwd(), 'src/worker.ts'), 'utf8');
    // Herdr early-return adopt block must surface adoptCliPid + adoptCwd so
    // grok's preferSessionId (findGrokSessionByPid) works under herdr adopt.
    const herdrStart = source.indexOf("cfg.adoptSource === 'herdr'");
    const herdrEnd = source.indexOf("log(`Adopt mode (herdr):", herdrStart);
    expect(herdrStart).toBeGreaterThan(-1);
    expect(herdrEnd).toBeGreaterThan(herdrStart);
    const herdrBlock = source.slice(herdrStart, herdrEnd);
    expect(herdrBlock).toContain('herdrBe.cliPid = cfg.adoptCliPid');
    expect(herdrBlock).toContain('cfg.adoptCwd ?? cfg.workingDir');
    expect(herdrBlock).toContain('herdrBe.cliCwd');
  });

  it('wires Herdr adopt snapshots before seeding the initial screen', () => {
    const source = readFileSync(join(process.cwd(), 'src/worker.ts'), 'utf8');
    const herdrStart = source.indexOf("cfg.adoptSource === 'herdr'");
    const herdrEnd = source.indexOf("log(`Adopt mode (herdr):", herdrStart);
    const herdrBlock = source.slice(herdrStart, herdrEnd);

    const relayIdx = herdrBlock.indexOf('wireHerdrWebTerminalRelays(herdrBe);');
    const seedIdx = herdrBlock.indexOf("seedBackendScreen('herdr adopt', herdrBe);");
    expect(relayIdx).toBeGreaterThan(-1);
    expect(seedIdx).toBeGreaterThan(relayIdx);
  });
});
