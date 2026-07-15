import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workerSource = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');
const workerPoolSource = readFileSync(new URL('../src/core/worker-pool.ts', import.meta.url), 'utf8');

function caseRegion(name: string): string {
  const start = workerSource.indexOf(`case '${name}':`);
  const next = workerSource.indexOf("\n    case '", start + 1);
  return workerSource.slice(start, next);
}

describe('worker native session rename queue', () => {
  it('restores the persisted desired title on both spawned and adopted worker init', () => {
    const region = caseRegion('init');
    expect(region).toContain('if (msg.cliSessionId) nativeSessionRename.observeCliSessionId(msg.cliSessionId)');
    expect(region).toContain('nativeSessionRename.restoreDesired(msg.desiredNativeSessionTitle)');
    expect(workerPoolSource.match(/desiredNativeSessionTitle: ds\.session\.desiredNativeSessionTitle/g)).toHaveLength(2);
    expect(workerSource).toContain('nativeSessionRename.queueDesiredForSpawn()');
  });

  it('queues rename IPC without opening a renderer or usage turn', () => {
    const region = caseRegion('rename_session');
    expect(region).toContain('nativeSessionRename.request(msg.title)');
    expect(region).toContain('void flushPending()');
    expect(region).not.toContain('renderer?.markNewTurn()');
    expect(region).not.toContain('usageLimitTracker.beginTurn');
  });

  it('waits for prompt readiness, uses the adapter command, and runs before user prompts', () => {
    const start = workerSource.indexOf('async function flushPending()');
    const end = workerSource.indexOf('\nfunction sendToPty(', start);
    const region = workerSource.slice(start, end);
    const renameIdx = region.indexOf('buildSessionRenameCommand');
    const promptLoopIdx = region.indexOf('while (pendingMessages.length > 0');

    expect(region).toContain('const nativeAdminPromptReady = hasCurrentNativeAdminPromptProof()');
    expect(region).toContain('const sessionRenameReady = nativeAdminPromptReady && nativeSessionRename.hasPending');
    expect(region).toContain('if (nativeSessionRename.isInFlight) return');
    expect(region).toContain('if (nativeSessionRename.blocksInput) return');
    expect(region).toContain('if (commandLineWritesPending > 0) return');
    expect(region).toContain('const rawInputReady = !!nextRawInput');
    expect(region).toContain('!rawInputNeedsNativePrompt(nextRawInput) || nativeAdminPromptReady');
    expect(region).toContain('await sendRawCommandLineSerially(flushBackend, renameCommand, {');
    expect(region).toContain('onBeforeSubmit: () => observeNativeCommandDraftBeforeSubmit(flushBackend, flushBackendEpoch)');
    expect(region).toContain('armSessionRenameIdleTimeout()');
    expect(region).toContain("effectiveBackendType === 'riff'");
    expect(renameIdx).toBeGreaterThanOrEqual(0);
    expect(renameIdx).toBeLessThan(promptLoopIdx);
  });

  it('blocks type-ahead messages until the rename command returns to prompt', () => {
    const sendToPtyStart = workerSource.indexOf('function sendToPty(');
    const sendToPtyEnd = workerSource.indexOf('// ─── Screen Update Timer', sendToPtyStart);
    const sendToPtyRegion = workerSource.slice(sendToPtyStart, sendToPtyEnd);
    const readyStart = workerSource.indexOf('function markPromptReady()');
    const readyEnd = workerSource.indexOf('\nfunction persistCliSessionId', readyStart);
    const readyRegion = workerSource.slice(readyStart, readyEnd);

    expect(sendToPtyRegion).toContain('!nativeSessionRename.isInFlight && !nativeSessionRename.blocksInput && commandLineWritesPending === 0 && shouldWriteNow');
    expect(readyRegion).toContain('clearSessionRenameInFlight()');
    expect(workerSource).toContain('Native session administration still lacks empty-prompt proof');
  });

  it('keeps deferred input blocked on timeout until an empty prompt is proven', () => {
    const timeoutStart = workerSource.indexOf('function armSessionRenameIdleTimeout()');
    const timeoutEnd = workerSource.indexOf('\n/** Deliver passthrough', timeoutStart);
    const timeoutRegion = workerSource.slice(timeoutStart, timeoutEnd);
    const killStart = workerSource.indexOf('function killCli()');
    const killEnd = workerSource.indexOf('// ─── HTTP + WebSocket Server', killStart);
    const killRegion = workerSource.slice(killStart, killEnd);
    const flushStart = workerSource.indexOf('async function flushPending()');
    const flushEnd = workerSource.indexOf('\nfunction sendToPty(', flushStart);
    const flushRegion = workerSource.slice(flushStart, flushEnd);

    expect(timeoutRegion).toContain('if (!rawCommandFailurePromptIsSafe() || !nativeSessionAdminPromptIsSafe())');
    expect(timeoutRegion).toContain('keeping queued input blocked');
    expect(timeoutRegion).toContain('markPromptReady()');
    expect(timeoutRegion).not.toContain('isPromptReady = true');
    expect(timeoutRegion).not.toContain('void flushPending()');
    expect(flushRegion).toContain('command failed');
    expect(flushRegion).toContain('armSessionRenameIdleTimeout()');
    expect(killRegion).not.toContain('pendingRawInputs.length = 0');

    expect(workerSource).not.toContain('Native administrative prompt timeout');
  });

  it('serializes passthrough writes without changing their busy-delivery semantics', () => {
    const rawRegion = caseRegion('raw_input');
    expect(rawRegion).toContain('const isNativeRotation = isNativeSessionRotationInput(msg)');
    expect(rawRegion).toContain('const rotationNeedsPrompt = rawInputNeedsNativePrompt(msg) && !nativeAdminPromptReady');
    expect(rawRegion).toContain('commandLineWritesPending > 0');
    expect(rawRegion).toContain('|| adoptInputWriteInProgress');
    expect(rawRegion).toContain('pendingRawInputs.push(msg)');
    expect(rawRegion).toContain('await deliverRawInput(msg)');

    const flushStart = workerSource.indexOf('async function flushPending()');
    const flushEnd = workerSource.indexOf('\nfunction sendToPty(', flushStart);
    const flushRegion = workerSource.slice(flushStart, flushEnd);
    expect(flushRegion).toContain('pendingRawInputs.shift()');
    expect(flushRegion).toContain('await deliverRawInput(raw, flushBackend, flushBackendEpoch)');
    expect(workerSource).toContain('await sendRawCommandLineSerially(targetBackend, msg.content, {');
    expect(flushRegion.indexOf('await deliverRawInput(raw, flushBackend, flushBackendEpoch)'))
      .toBeLessThan(flushRegion.indexOf('await sendRawCommandLineSerially(flushBackend, renameCommand, {'));
  });

  it('re-queues the durable desired title on rotation command or cliSessionId change', () => {
    const rawStart = workerSource.indexOf('async function deliverRawInput');
    const rawEnd = workerSource.indexOf('/** Inputs written to the CLI', rawStart);
    const rawRegion = workerSource.slice(rawStart, rawEnd);
    const rotationHelperStart = workerSource.indexOf('function isNativeSessionRotationInput');
    const rotationHelperEnd = workerSource.indexOf('\nasync function deliverRawInput', rotationHelperStart);
    const rotationHelperRegion = workerSource.slice(rotationHelperStart, rotationHelperEnd);
    const persistStart = workerSource.indexOf('function persistCliSessionId');
    const persistEnd = workerSource.indexOf('\nfunction observeCursorCliSessionId', persistStart);
    const persistRegion = workerSource.slice(persistStart, persistEnd);

    expect(rotationHelperRegion).toContain('nativeSessionRename.isRotationCommand(');
    expect(rotationHelperRegion).toContain('cliAdapter?.nativeSessionRotationCommands');
    expect(rawRegion).toContain('nativeSessionRename.beginRotationCommandWrite()');
    expect(rawRegion).toContain('nativeSessionRename.commitRotationCommand()');
    expect(persistRegion).toContain('nativeSessionRename.observeCliSessionId(cliSessionId)');
    expect(persistRegion).toContain('const adapterRotationAlreadyWaitingForPrompt = nativeSessionRename.requiresFreshPrompt');
    expect(persistRegion).toContain('&& !sessionIdRotationAwaitingIdleSignal');
    expect(persistRegion).toContain("observation.kind === 'baseline'");
    expect(persistRegion).toContain("opts.currentPromptProof?.kind === 'active-screen'");
    expect(persistRegion).toContain("opts.currentPromptProof?.kind === 'after-generation'");
    expect(persistRegion).toContain('opts.expectedObservationVersion !== cliSessionIdObservationVersion');
    expect(persistRegion).toContain('if (adapterRotationAlreadyWaitingForPrompt)');
    expect(persistRegion).toContain('sessionIdRotationAwaitingIdleSignal = true');
    expect(persistRegion).toContain('sessionIdRotationObservedOutputGeneration = ptyOutputGeneration');
    expect(persistRegion).toContain('idleDetector?.reset()');
    expect(persistRegion).not.toContain('notBeforeMs');
    expect(persistRegion).toContain('isPromptReady = false');
  });

  it('binds deferred session-id rechecks to the backend, observer version, and later prompt generation', () => {
    const start = workerSource.indexOf('function scheduleSubmitFailureNotify');
    const end = workerSource.indexOf('\n/**\n * Launch-failure guard', start);
    const region = workerSource.slice(start, end);

    expect(region).toContain('const recheckBackend = backend;');
    expect(region).toContain('const recheckBackendEpoch = backendEpoch;');
    expect(region).toContain('const recheckObservationVersion = cliSessionIdObservationVersion;');
    expect(region).toContain('const recheckOutputGeneration = ptyOutputGeneration;');
    expect(region).toContain('backendEpochIsCurrent(recheckBackend, recheckBackendEpoch)');
    expect(region).toContain('expectedObservationVersion: recheckObservationVersion');
    expect(region).toContain("kind: 'after-generation'");
    expect(region).toContain('outputGeneration: recheckOutputGeneration');
    expect(region).toContain('if (accepted && codexBridgeFallbackActive())');
  });

  it('rejects stale in-band writeInput session ids from both managed and adopted delivery', () => {
    const adoptStart = workerSource.indexOf('async function deliverAdoptMessage');
    const adoptEnd = workerSource.indexOf('/** Inputs written to the CLI', adoptStart);
    const adopt = workerSource.slice(adoptStart, adoptEnd);
    const flushStart = workerSource.indexOf('async function flushPending()');
    const flushEnd = workerSource.indexOf('\nfunction sendToPty(', flushStart);
    const flush = workerSource.slice(flushStart, flushEnd);

    expect(adopt).toContain('const writeObservationVersion = cliSessionIdObservationVersion;');
    expect(adopt).toContain('expectedObservationVersion: writeObservationVersion');
    expect(adopt).toContain('expectedBackend: targetBackend');
    expect(adopt).toContain('if (accepted) codexBridgeNotifyCliSessionId');
    expect(flush).toContain('const writeObservationVersion = cliSessionIdObservationVersion;');
    expect(flush).toContain('expectedObservationVersion: writeObservationVersion');
    expect(flush).toContain('expectedBackend: flushBackend');
    expect(flush).toContain('if (accepted && codexBridgeActive)');
  });

  it('installs adopt capabilities without treating captured history as readiness', () => {
    const adapterStart = workerSource.indexOf('function setupAdoptInputAdapter');
    const adapterEnd = workerSource.indexOf('\nfunction setupAdoptIdleDetection', adapterStart);
    const adapterRegion = workerSource.slice(adapterStart, adapterEnd);
    expect(adapterRegion).toContain('cliAdapter = createCliAdapterSync');

    const herdrStart = workerSource.indexOf("if (cfg.adoptMode && cfg.adoptSource === 'herdr'");
    const herdrEnd = workerSource.indexOf('// ── Adopt mode: pipe-pane', herdrStart);
    const herdrRegion = workerSource.slice(herdrStart, herdrEnd);
    expect(herdrRegion.indexOf("seedBackendScreen('herdr adopt'"))
      .toBeLessThan(herdrRegion.indexOf("setupAdoptIdleDetection(cfg, 'herdr')"));

    const pipeStart = workerSource.indexOf("if (cfg.adoptMode && (cfg.adoptTmuxTarget || cfg.adoptZellijPaneId))");
    const pipeEnd = workerSource.indexOf('\n  cliAdapter = createCliAdapterSync', pipeStart);
    const pipeRegion = workerSource.slice(pipeStart, pipeEnd);
    expect(pipeRegion.indexOf('seedBackendScreen(`${effectiveBackendType} adopt`'))
      .toBeLessThan(pipeRegion.indexOf("setupAdoptIdleDetection(cfg, 'pipe')"));
  });

  it('drains deferred adopt messages only through the adopt delivery path', () => {
    const flushStart = workerSource.indexOf('async function flushPending()');
    const flushEnd = workerSource.indexOf('\nfunction sendToPty(', flushStart);
    const flushRegion = workerSource.slice(flushStart, flushEnd);
    const messageRegion = caseRegion('message');

    expect(messageRegion).toContain('pendingAdoptMessages.push(input)');
    expect(messageRegion).toContain('commandLineWritesPending > 0');
    expect(messageRegion).toContain('pendingRawInputs.length > 0');
    expect(messageRegion).toContain('|| isFlushing');
    expect(flushRegion).toContain('pendingAdoptMessages.shift()');
    expect(flushRegion).toContain('await deliverAdoptMessage(input, flushBackend, flushBackendEpoch)');
    expect(workerSource).toContain('isPromptReady = false;\n  idleDetector?.reset();\n  adoptInputWriteInProgress = true;');

    const rawStart = workerSource.indexOf('async function deliverRawInput');
    const rawEnd = workerSource.indexOf('/** Deliver one Lark message into an adopted pane', rawStart);
    const rawRegion = workerSource.slice(rawStart, rawEnd);
    expect(rawRegion).toContain('pendingAdoptMessages.push({ content: msg.followUpContent })');

    const ptyStart = workerSource.indexOf('function onPtyData(data: string)');
    const ptyEnd = workerSource.indexOf('\nfunction markPromptReady()', ptyStart);
    const ptyRegion = workerSource.slice(ptyStart, ptyEnd);
    expect(ptyRegion).toContain('if (lastInitConfig?.adoptMode)');
    expect(ptyRegion).toContain('adoptStaticPromptProofEligible = false');
    expect(workerSource).toContain('maybeMarkAdoptPromptReadyFromTranscript(\'rename request\')');
  });

  it('discards unsupported native sync before any inherited prompt gate can block riff', () => {
    const start = workerSource.indexOf('async function flushPending()');
    const end = workerSource.indexOf('\nfunction sendToPty(', start);
    const region = workerSource.slice(start, end);
    const discardIdx = region.indexOf('nativeSessionRename.discardUnsupported()');
    expect(discardIdx).toBeGreaterThanOrEqual(0);
    expect(discardIdx).toBeLessThan(region.indexOf('if (nativeSessionRename.isInFlight) return'));
    expect(discardIdx).toBeLessThan(region.indexOf('if (nativeSessionRename.blocksInput) return'));
  });

  it('never reuses pre-startup prompt readiness for an automatic rename', () => {
    const start = workerSource.indexOf('async function flushPending()');
    const end = workerSource.indexOf('\nfunction sendToPty(', start);
    const region = workerSource.slice(start, end);
    const startupIdx = region.indexOf('const startupCommandsRan = await runStartupCommands');
    const returnIdx = region.indexOf('if (startupCommandsRan) return;', startupIdx);
    const renameIdx = region.indexOf('nativeSessionRename.takeForSend()', startupIdx);
    expect(startupIdx).toBeGreaterThanOrEqual(0);
    expect(returnIdx).toBeGreaterThan(startupIdx);
    expect(renameIdx).toBeGreaterThan(returnIdx);
  });

  it('uses an exact draft-to-empty capture proof when Zellij live attach freezes onData', () => {
    expect(workerSource).toContain('targetBackend instanceof ZellijObserveBackend');
    expect(workerSource).toContain('new NativeSessionCommandProof(command)');
    expect(workerSource).toContain('beginNativeCommandCaptureProof(flushBackend, flushBackendEpoch, renameCommand)');
    expect(workerSource).toContain('capturedNativeCommandCompletionIsProven()');
    expect(workerSource).toContain('const delayMs = nativeCommandCaptureProof');
    expect(workerSource).toContain("acceptSessionIdRotationIdleSignal('Zellij live-attach debounce')");
    expect(workerSource).not.toContain('nativeSessionIdCaptureProof');
  });

  it('requires a real idle signal and newer output after an independent session-id rotation', () => {
    const acceptStart = workerSource.indexOf('function acceptSessionIdRotationIdleSignal');
    const acceptEnd = workerSource.indexOf('\n/** ObserveBackend polling', acceptStart);
    const acceptRegion = workerSource.slice(acceptStart, acceptEnd);
    const adminStart = workerSource.indexOf('function nativeSessionAdminPromptIsSafe');
    const adminEnd = workerSource.indexOf('\n/** A changed native id', adminStart);
    const adminRegion = workerSource.slice(adminStart, adminEnd);

    expect(adminRegion).toContain('if (sessionIdRotationAwaitingIdleSignal) return false');
    expect(acceptRegion).toContain('ptyOutputGeneration <= sessionIdRotationObservedOutputGeneration');
    expect(acceptRegion).toContain('backendEpochIsCurrent(sessionIdRotationProofBackend, sessionIdRotationProofBackendEpoch)');
    expect(acceptRegion).toContain('!nativePromptScreenIsSafe()');
    expect(acceptRegion).toContain('nativeSessionRename.noteFreshPrompt()');
    expect(workerSource).toContain("acceptSessionIdRotationIdleSignal('IdleDetector')");
    expect(workerSource).toContain('acceptSessionIdRotationIdleSignal(`${label} adopt IdleDetector`)');
  });

  it('binds late active-screen proof to identity-time output and renderer drain', () => {
    const scheduleStart = workerSource.indexOf('function scheduleStableActiveSessionIdPromptProof');
    const scheduleEnd = workerSource.indexOf('\nfunction clearSessionAdminPromptWait', scheduleStart);
    const schedule = workerSource.slice(scheduleStart, scheduleEnd);
    const persistStart = workerSource.indexOf('function persistCliSessionId');
    const persistEnd = workerSource.indexOf('\nfunction observeCursorCliSessionId', persistStart);
    const persist = workerSource.slice(persistStart, persistEnd);

    expect(workerSource).toContain('function activeSessionIdentityEvidenceAtMs(path: string)');
    expect(workerSource).toContain("{ kind: 'active-screen'; identityEvidenceAtMs: number }");
    expect(schedule).toContain('renderer?.hasPendingWrites');
    expect(schedule).toContain('expectedRenderer.whenWritesParsed()');
    expect(schedule).toContain('lastBackendPtyOutputAtMs < identityEvidenceAtMs');
    expect(schedule).toContain('nativePromptScreenIsSafe()');
    const seedStart = workerSource.indexOf('function seedBackendScreen');
    const seedEnd = workerSource.indexOf('\nfunction captureBackendScreen', seedStart);
    const seed = workerSource.slice(seedStart, seedEnd);
    expect(seed).toContain('const priorLiveOutputAtMs = lastBackendPtyOutputAtMs;');
    expect(seed).toContain('lastBackendPtyOutputAtMs = priorLiveOutputAtMs;');
    expect(persist).toContain('activeScreenIdentityEvidenceAtMs');
    expect(persist).toContain('scheduleStableActiveSessionIdPromptProof(');
  });

  it('limits static adopt readiness to a completed transcript plus empty composer before live output', () => {
    const start = workerSource.indexOf('function maybeMarkAdoptPromptReadyFromTranscript');
    const end = workerSource.indexOf('\nfunction seedBackendScreen', start);
    const region = workerSource.slice(start, end);

    expect(region).toContain('!adoptStaticPromptProofEligible');
    expect(region).toContain('hasNativeSessionBusyMarker(screen)');
    expect(region).toContain('hasNativeSessionIdleComposer(screen, cliId)');
    expect(region).toContain('adoptStaticPromptProofEligible = false');
    expect(workerSource).toContain("maybeMarkAdoptPromptReadyFromTranscript('Codex bridge attach')");
  });
});
