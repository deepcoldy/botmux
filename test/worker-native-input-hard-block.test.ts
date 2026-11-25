import { afterEach, describe, expect, it, vi } from 'vitest';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCodexAdapter } from '../src/adapters/cli/codex.js';
import { createTraexAdapter } from '../src/adapters/cli/traex.js';
import type { DaemonToWorker } from '../src/types.js';
import { codexEmptyComposerFooter, codexNativeComposerState, codexNativeFooterRows } from '../src/services/codex-terminal-session.js';
import { detectCodexChoiceModal } from '../src/utils/codex-choice-modal.js';
import { promptCacheKeepaliveRefusal } from '../src/core/prompt-cache-keepalive-gate.js';
import { inputForcesSerialTurn, pendingInputAllowsTypeAhead } from '../src/utils/pending-input-queue.js';
import { programStatusBlockHoldsTypeAhead } from '../src/core/program-status-gate.js';
import { workerSubmitHarness } from './helpers/worker-submit-harness.js';
import { loadWorkerFunction, loadWorkerMessageHandler } from './helpers/worker-function-harness.js';

const TITLE = '[BotMux·Lark] 修复登录页报错';
const COMMAND = `/rename ${TITLE}`;
const SID = '01a20c74-121d-76b2-bc30-939e1dc3d71c';
const fixture = (name: string) => readFileSync(new URL(`./fixtures/session-rename/${name}`, import.meta.url), 'utf8');
const choiceModal = readFileSync(new URL('./fixtures/codex-choice-modal/tmux-pane-tool-approval-160x30.txt', import.meta.url), 'utf8');
const codexDialog = (title: string) => [
  '>_ OpenAI Codex', '', '  Rename thread', '', `› ${title}`, '', 'enter submit  |  esc back',
].join('\n');
const empty146 = {
  viewport: 'Previous conversation\n› Implement {feature}\n\n  gpt-5.6-sol default · ~/data',
  cursor: { x: 2, y: 1 },
};
function codexCursor(viewport: string): { x: number; y: number } {
  const rows = viewport.split(/\r?\n/);
  for (let y = rows.length - 1; y >= 0; y--) {
    if (/^\s*[›»](?!\s*\d+\.)(?:\s|$)/.test(rows[y]!)) return { x: 2, y };
  }
  return { x: 2, y: 0 };
}

function inputHarness(cliId: 'codex' | 'traex', viewport: string, persistentReattach = false) {
  const h = workerSubmitHarness();
  const adapter = cliId === 'codex' ? createCodexAdapter() : createTraexAdapter();
  const backend = {
    write: vi.fn(),
    captureInputState: () => ({ viewport, cursor: cliId === 'codex' ? codexCursor(viewport) : undefined }),
  };
  Object.assign(h.scope, {
    backend,
    cliAdapter: {
      ...adapter,
      watchSessionRename: vi.fn(() => () => false),
      writeInput: cliId === 'codex' ? vi.fn(adapter.writeInput) : vi.fn(async () => ({ submitted: true })),
    },
    lastInitConfig: { cliId, nativeSessionTitle: TITLE, promptInjection: 'none' },
    lastSpawnPersistentReattach: persistentReattach,
    backendScreenEvidenceIsAuthoritativeForMutation: () => true,
    openingInputBoxSettled: true,
    inputBoxJudgeable: () => false,
    postTerminalInputIsBlocked: vi.fn(async () => false),
    currentCodexObservedPid: () => 12345,
    deferTurnInputCommitUntilSubmission: () => false,
    maybeQueuePostSubmitNativeSessionTitle: () => false,
    stampMojoTurnMark: vi.fn(),
    sessionRenameReattachRecoveryGeneration: -1,
    sessionRenamePhase: 'idle',
    sessionRenameSentAtMs: Date.now() - 45_000,
    sessionRenameReattachRetryTimer: null,
    sessionRenameResubmitted: false,
    sessionRenameHoldLogged: false,
    sessionRenameHoldNoticeSent: false,
    sessionRenameHoldTimeoutLogged: false,
    sessionRenameHoldTimeoutNoticeSent: false,
    armSessionRenameIdleTimeout: vi.fn(),
    notifySessionRenameInputHeld: vi.fn(),
    notifySessionRenameInputTimeout: vi.fn(),
  });
  h.scope.sessionInputSurfaceNow = loadWorkerFunction('sessionInputSurfaceNow', h.scope);
  h.scope.sessionRenameSurfaceNow = loadWorkerFunction('sessionRenameSurfaceNow', h.scope);
  h.scope.sessionInputBlocksDeliveryNow = loadWorkerFunction('sessionInputBlocksDeliveryNow', h.scope);
  h.scope.holdNativeInputForHardBlock = loadWorkerFunction('holdNativeInputForHardBlock', h.scope);
  h.scope.armNativeInputBlockRecheck = vi.fn();
  h.scope.notifyNativeInputBlocked = vi.fn();
  Object.assign(h.scope, {
    firstWriteLivenessConfirmed: true,
    firstWriteLivenessHeld: false,
    firstWriteHeldNoticeSent: false,
    armFirstWriteLivenessRecheck: vi.fn(),
    currentBotmuxDispatchAttempt: 1,
  });
  h.scope.holdOpeningInput = loadWorkerFunction('holdOpeningInput', h.scope);
  h.scope.notifyHeldInput = loadWorkerFunction('notifyHeldInput', h.scope);
  if (persistentReattach) {
    h.scope.recoverSessionRenameAfterPersistentReattach = loadWorkerFunction('recoverSessionRenameAfterPersistentReattach', h.scope);
  }
  return { ...h, backend, adapter: h.scope.cliAdapter };
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('native hard input-focus blocks across real delivery paths', () => {
  it.each([
    { name: 'TRAE native rename dialog', cliId: 'traex' as const, viewport: fixture('traex-0.216.0-rename-dialog.txt') },
    { name: 'TRAE partial rename', cliId: 'traex' as const, viewport: fixture('traex-0.216.0-rename-left-in-composer.txt').replace(COMMAND, '/rename [BotMux·Lark] 修复') },
    { name: 'TRAE collapsed paste', cliId: 'traex' as const, viewport: fixture('traex-0.216.0-rename-left-in-composer.txt').replace(COMMAND, '[Pasted Content 42 chars]') },
    { name: 'TRAE human draft', cliId: 'traex' as const, viewport: fixture('traex-0.216.0-rename-left-in-composer.txt').replace(COMMAND, 'a human draft') },
    { name: 'Codex empty rename dialog', cliId: 'codex' as const, viewport: codexDialog('') },
    { name: 'Codex titled rename dialog', cliId: 'codex' as const, viewport: codexDialog(TITLE) },
    { name: 'Codex centered confirmation', cliId: 'codex' as const, viewport: choiceModal },
  ])('$name keeps ordinary input queued with zero paste', async ({ cliId, viewport }) => {
    const h = inputHarness(cliId, viewport);
    await h.flush();
    if (cliId === 'codex') expect(h.scope.cliAdapter.writeInput).toHaveBeenCalledOnce();
    else expect(h.scope.cliAdapter.writeInput).not.toHaveBeenCalled();
    expect(h.scope.pendingMessages).toHaveLength(1);
    expect(h.backend.write).not.toHaveBeenCalled();
    expect(h.scope.emitTurnTerminal).not.toHaveBeenCalled();
  });

  it('Codex empty rename dialog on a PTY without input-state capture still blocks ordinary input', async () => {
    const viewport = codexDialog('');
    const h = inputHarness('codex', viewport);
    const backend = { write: vi.fn(), captureViewport: () => viewport };
    Object.assign(h.scope, { backend, captureBackendScreen: () => viewport });
    await h.flush();
    expect(h.scope.cliAdapter.writeInput).not.toHaveBeenCalled();
    expect(h.scope.pendingMessages).toHaveLength(1);
    expect(backend.write).not.toHaveBeenCalled();
  });

  it.each([false, true])('TRAE rename dialog blocks restored input (persistent reattach: %s)', async persistent => {
    const h = inputHarness('traex', fixture('traex-0.216.0-rename-dialog.txt'), persistent);
    await h.flush();
    expect(h.scope.cliAdapter.writeInput).not.toHaveBeenCalled();
    expect(h.scope.pendingMessages).toHaveLength(1);
    expect(h.backend.write).not.toHaveBeenCalled();
    if (persistent) expect(h.scope.sessionRenamePhase).toBe('sent');
  });

  it.each([codexDialog(''), choiceModal])('Codex dialog also blocks raw input and pending injections', async viewport => {
    const h = inputHarness('codex', viewport);
    const enqueueRaw = vi.fn();
    const sendRawCommandLineWithRecoveryFence = vi.fn(async () => {});
    Object.assign(h.scope, {
      sendRawCommandLineWithRecoveryFence,
      awaitPtyQuiescence: vi.fn(async () => {}),
      revokePromptReadiness: vi.fn(),
      finalizeRawCommandDelivery: ({ accepted }: { accepted: boolean }) => accepted,
      flushPending: vi.fn(async () => {}),
      canStartInjectionFlush: () => true,
    });
    h.scope.idleDetector.reset = vi.fn();
    h.scope.freshnessInputQueue.enqueueRaw = enqueueRaw;
    await loadWorkerFunction<(msg: Extract<DaemonToWorker, { type: 'raw_input' }>) => Promise<void>>('deliverRawInput', h.scope)({
      type: 'raw_input', content: '/status', turnId: 'om_raw',
    });
    expect(enqueueRaw).toHaveBeenCalledOnce();
    expect(sendRawCommandLineWithRecoveryFence).not.toHaveBeenCalled();
    expect(h.backend.write).not.toHaveBeenCalled();

    const pendingInjections = [{ command: '/compact', kind: 'keepalive' }];
    Object.assign(h.scope, { pendingInjections, injectionFlushing: false });
    await loadWorkerFunction<() => Promise<void>>('flushPendingInjections', h.scope)();
    expect(pendingInjections).toHaveLength(1);
    expect(sendRawCommandLineWithRecoveryFence).not.toHaveBeenCalled();
    expect(h.backend.write).not.toHaveBeenCalled();
  });

  it('does not re-evaluate a hard block while an adopt rename already owns the input', async () => {
    const h = inputHarness('traex', fixture('traex-0.216.0-rename-dialog.txt'));
    h.scope.lastInitConfig.adoptMode = true;
    h.scope.applyWorkerLaunchModel = vi.fn();
    h.scope.respawnConfigPatchFromMessage = () => ({});
    h.scope.applyRespawnConfigPatch = vi.fn();
    h.scope.sessionRenameInFlight = () => true;
    h.scope.sessionInputBlocksDeliveryNow = vi.fn(() => { throw new Error('must not be called during rename hold'); });
    Object.assign(h.scope, {
      activeTurnAuthority: { snapshot: () => undefined },
      inputForcesSerialTurn,
      runAdoptMessageForCapturedGeneration: vi.fn(),
    });
    h.scope.admitAdoptMessage = loadWorkerFunction('admitAdoptMessage', h.scope);
    await loadWorkerMessageHandler('message', h.scope)({ type: 'message', content: 'adopt queued', turnId: 'om_adopt' });
    expect(h.scope.pendingAdoptMessages).toHaveLength(1);
    expect(h.scope.sessionInputBlocksDeliveryNow).not.toHaveBeenCalled();
  });

  it('queues adopt input behind a native dialog and arms the shared recheck', async () => {
    const h = inputHarness('traex', fixture('traex-0.216.0-rename-dialog.txt'));
    h.scope.lastInitConfig.adoptMode = true;
    const writeDirect = vi.fn();
    Object.assign(h.scope, {
      activeTurnAuthority: { snapshot: () => undefined },
      inputForcesSerialTurn,
      runAdoptMessageForCapturedGeneration: writeDirect,
    });
    const admit = loadWorkerFunction<(item: any) => Promise<void>>('admitAdoptMessage', h.scope);

    await admit({ content: 'adopt blocked', turnId: 'om_adopt_blocked' });

    expect(h.scope.pendingAdoptMessages).toEqual([
      expect.objectContaining({ content: 'adopt blocked', turnId: 'om_adopt_blocked' }),
    ]);
    expect(writeDirect).not.toHaveBeenCalled();
    expect(h.backend.write).not.toHaveBeenCalled();
    expect(h.scope.armNativeInputBlockRecheck).toHaveBeenCalledOnce();
  });

  it('keeps one recheck while blocked, then re-drives ordinary and injection queues once clear', async () => {
    vi.useFakeTimers();
    const h = inputHarness('traex', fixture('traex-0.216.0-rename-dialog.txt'));
    h.scope.armNativeInputBlockRecheck = loadWorkerFunction('armNativeInputBlockRecheck', h.scope);
    h.scope.flushPending = vi.fn(async () => {});
    h.scope.flushPendingInjections = vi.fn(async () => {});
    h.scope.holdNativeInputForHardBlock();
    expect(vi.getTimerCount()).toBe(1);
    for (let i = 0; i < 3; i++) await vi.advanceTimersByTimeAsync(5_000);
    expect(vi.getTimerCount()).toBe(1);
    expect(h.scope.flushPending).not.toHaveBeenCalled();
    h.scope.sessionInputBlocksDeliveryNow = () => false;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(vi.getTimerCount()).toBe(0);
    expect(h.scope.flushPending).toHaveBeenCalledOnce();
    expect(h.scope.flushPendingInjections).toHaveBeenCalledOnce();
  });

  it('rejects dialog footers before they can impersonate an empty Codex composer', () => {
    for (const viewport of [codexDialog(''), choiceModal]) {
      expect(codexEmptyComposerFooter({ viewport, cursor: codexCursor(viewport) })).toBeUndefined();
    }
    expect(codexNativeFooterRows(['enter submit  |  esc back'])).toBeUndefined();
  });

  it('never reads a live backdrop composer as empty while a choice modal owns the screen', () => {
    // A centered overlay can leave a perfectly formed empty composer and a
    // valid native footer behind it. The modal/backdrop guard inside
    // codexEmptyComposerFooter is the only layer that rejects this shape:
    // cursor geometry and the footer band both pass on their own.
    const backdropModal = [
      'Previous conversation lines',
      '',
      '  A command needs permission to run',
      '',
      '› 1. Yes, proceed (y)',
      '  2. No, tell Codex what to do differently',
      '',
      '  Press enter to confirm or esc to cancel',
      '',
      '› ',
      '',
      '  gpt-5.6-sol default · ~/data',
    ].join('\n');
    expect(detectCodexChoiceModal(backdropModal)).toBeTruthy();
    const state = { viewport: backdropModal, cursor: { x: 2, y: 9 } };
    expect(codexEmptyComposerFooter(state, { allowCodex0146Hints: true })).toBeUndefined();
    expect(codexNativeComposerState(state, { allowCodex0146Hints: true })).not.toBe('empty');
  });

  it('keeps OSC-7501 approval blocks authoritative after the rename-only gate', async () => {
    const h = workerSubmitHarness();
    Object.assign(h.scope, {
      isPromptReady: false,
      pendingInputAllowsTypeAhead,
      programStatusBlockHoldsTypeAhead,
    });
    h.scope.cliAdapter.programStatusBlockedHoldsInput = true;
    h.scope.idleDetector.programStatusBlock = () => ({ kind: 'permission' });
    h.scope.programStatusBlockedHoldsTypeAhead = loadWorkerFunction('programStatusBlockedHoldsTypeAhead', h.scope);
    await h.flush();
    expect(h.scope.cliAdapter.writeInput).not.toHaveBeenCalled();
    expect(h.scope.pendingMessages).toHaveLength(1);
  });

  it('accepts a native 0.146.1 hint for unattended keepalive writes', () => {
    expect(promptCacheKeepaliveRefusal({
      hasBackend: true, restarting: false, promptReady: true, tuiPromptOpen: false,
      bareShell: false, inputPending: false, cliId: 'codex', codexInputState: empty146,
    })).toBeUndefined();
  });

  it('lets the TRAE question card own input instead of the generic dialog hold', async () => {
    // A question card can make the surface read as blocked, but it has its own
    // hold/notify/bridge path. The generic hard-block recheck must not preempt it.
    const blocked = fixture('traex-0.216.0-rename-dialog.txt');

    // Question bridge active: the generic hold never arms on the same blocked screen.
    const owned = inputHarness('traex', blocked);
    owned.scope.traexQuestionDeliveryOwnsInput = loadWorkerFunction('traexQuestionDeliveryOwnsInput', owned.scope);
    owned.scope.traexQuestionBridgeActive = () => true;
    await owned.flush();
    expect(owned.scope.armNativeInputBlockRecheck).not.toHaveBeenCalled();
    expect(owned.scope.notifyNativeInputBlocked).not.toHaveBeenCalled();

    // Control: with no question card, the identical blocked screen is held generically.
    const generic = inputHarness('traex', blocked);
    generic.scope.traexQuestionDeliveryOwnsInput = loadWorkerFunction('traexQuestionDeliveryOwnsInput', generic.scope);
    generic.scope.traexQuestionBridgeActive = () => false;
    await generic.flush();
    expect(generic.scope.armNativeInputBlockRecheck).toHaveBeenCalled();
  });

  it('traexQuestionDeliveryOwnsInput is false outside TRAE or without a question surface', () => {
    const h = inputHarness('traex', fixture('traex-0.216.0-rename-dialog.txt'));
    h.scope.traexQuestionBridgeActive = () => false;
    const resolve = loadWorkerFunction<() => boolean>('traexQuestionDeliveryOwnsInput', h.scope);
    expect(resolve()).toBe(false); // no bridge, screen path throws without captureBackendScreen -> caught
    h.scope.traexQuestionBridgeActive = () => true;
    expect(resolve()).toBe(true); // bridge short-circuits before the screen read
    const codex = inputHarness('codex', codexDialog(''));
    codex.scope.traexQuestionBridgeActive = () => true;
    const codexResolve = loadWorkerFunction<() => boolean>('traexQuestionDeliveryOwnsInput', codex.scope);
    expect(codexResolve()).toBe(false); // non-TRAE never owns via this path
  });
});

describe('Codex Turn 2+ untouched refusal recovery', () => {
  it('does not latch a background-only hold or spin an empty injection queue', async () => {
    const h = inputHarness('traex', fixture('traex-0.216.0-rename-dialog.txt'));
    h.scope.pendingMessages.splice(0, 1);
    h.scope.pendingSessionRename = 'background-only';
    h.scope.holdNativeInputForHardBlock();
    expect(h.scope.nativeInputBlockLogged).toBe(false);
    h.scope.pendingMessages.push({ content: 'user turn', turnId: 'turn-user' });
    h.scope.holdNativeInputForHardBlock();
    expect(h.scope.notifyNativeInputBlocked).toHaveBeenCalledOnce();
    expect(h.scope.nativeInputBlockLogged).toBe(true);

    h.scope.pendingInjections = [];
    h.scope.armNativeInputBlockRecheck.mockClear();
    await loadWorkerFunction<() => Promise<void>>('flushPendingInjections', h.scope)();
    expect(h.scope.armNativeInputBlockRecheck).not.toHaveBeenCalled();
  });

  it('re-opens the write cycle after precheck and before actual paste', async () => {
    const home = mkdtempSync(join(tmpdir(), 'botmux-before-submit-cycle-'));
    dirs.push(home);
    vi.stubEnv('CODEX_HOME', home);
    writeFileSync(join(home, 'history.jsonl'), '');
    const h = workerSubmitHarness();
    const readinessAtPaste: boolean[] = [];
    const backend = {
      cliPid: 12345,
      expectedCodexSessionId: SID,
      write: vi.fn(),
      captureInputState: () => {
        // Simulate a prompt-ready edge while the adapter is prechecking.
        h.scope.isPromptReady = true;
        return empty146;
      },
      submitBracketedPaste: vi.fn((text: string) => {
        readinessAtPaste.push(h.scope.isPromptReady);
        appendFileSync(join(home, 'history.jsonl'), `${JSON.stringify({ session_id: SID, text })}\n`);
      }),
    };
    Object.assign(h.scope, {
      backend,
      cliAdapter: createCodexAdapter(),
      lastInitConfig: { cliId: 'codex', nativeSessionTitle: TITLE, promptInjection: 'none' },
      sessionInputBlocksDeliveryNow: () => false,
      holdNativeInputForHardBlock: vi.fn(),
      inputBoxJudgeable: () => false,
      currentCodexObservedPid: () => 12345,
      stampMojoTurnMark: vi.fn(),
      deferTurnInputCommitUntilSubmission: () => false,
      maybeQueuePostSubmitNativeSessionTitle: () => false,
      acknowledgeNativeInputConsumed: vi.fn(),
      codexBridgeFallbackActive: () => false,
    });
    h.scope.beginCliWriteCycle = vi.fn(() => { h.scope.isPromptReady = false; });
    await h.flush();
    expect(readinessAtPaste).toEqual([false]);
    expect(h.scope.beginCliWriteCycle.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('retains the entire FIFO with zero paste/failure, then submits each item after recovery', async () => {
    const home = mkdtempSync(join(tmpdir(), 'botmux-turn2-untouched-'));
    dirs.push(home);
    vi.stubEnv('CODEX_HOME', home);
    const historyPath = join(home, 'history.jsonl');
    writeFileSync(historyPath, '');
    let state = { viewport: codexDialog(''), cursor: { x: 2, y: 4 } };
    const submissions: string[] = [];
    const backend = {
      cliPid: 12345,
      expectedCodexSessionId: SID,
      write: vi.fn(),
      captureInputState: () => state,
      submitBracketedPaste: vi.fn((text: string) => {
        submissions.push(text);
        appendFileSync(historyPath, `${JSON.stringify({ session_id: SID, text })}\n`);
        state = empty146;
      }),
    };
    const h = workerSubmitHarness();
    h.scope.pendingMessages.splice(0, 1,
      { turnId: 'turn-1', content: 'first queued message' },
      { turnId: 'turn-2', content: 'second queued message' },
    );
    Object.assign(h.scope, {
      backend,
      cliAdapter: createCodexAdapter(),
      lastInitConfig: { cliId: 'codex', nativeSessionTitle: TITLE, promptInjection: 'none' },
      openingInputBoxSettled: true,
      inputBoxJudgeable: () => false,
    postTerminalInputIsBlocked: vi.fn(async () => false),
      firstWriteLivenessConfirmed: true,
      firstWriteLivenessHeld: false,
      firstWriteHeldNoticeSent: false,
      armFirstWriteLivenessRecheck: vi.fn(),
      codexBridgeFallbackActive: () => false,
      acknowledgeNativeInputConsumed: vi.fn(),
      currentBotmuxDispatchAttempt: 1,
      currentCodexObservedPid: () => 12345,
      stampMojoTurnMark: vi.fn(),
      deferTurnInputCommitUntilSubmission: () => false,
      maybeQueuePostSubmitNativeSessionTitle: () => false,
      dropFailedBridgeMark: vi.fn(),
      sessionInputBlocksDeliveryNow: () => false,
      holdNativeInputForHardBlock: vi.fn(), // dialog appears after the outer screen check
    });
    h.scope.holdOpeningInput = loadWorkerFunction('holdOpeningInput', h.scope);
    h.scope.notifyHeldInput = loadWorkerFunction('notifyHeldInput', h.scope);

    await h.flush();
    expect(submissions).toEqual([]);
    expect(backend.write).not.toHaveBeenCalled();
    expect(h.scope.pendingMessages.map(item => item.turnId)).toEqual(['turn-1', 'turn-2']);
    expect(h.scope.openingInputBoxSettled).toBe(false);
    expect(h.scope.armFirstWriteLivenessRecheck).not.toHaveBeenCalled();
    expect(h.scope.send.mock.calls.map(([event]) => event.message)).not.toContain('worker.submit_impossible');

    state = empty146;
    await h.flush();
    await h.flush();
    expect(submissions).toEqual(['first queued message', 'second queued message']);
    expect(h.scope.pendingMessages).toHaveLength(0);
    expect(h.scope.send.mock.calls.map(([event]) => event.message)).not.toContain('worker.submit_impossible');
  });

  it('does not commit durable, bridge, type-ahead or activation state before a precheck refusal', async () => {
    const home = mkdtempSync(join(tmpdir(), 'botmux-durable-untouched-'));
    dirs.push(home);
    vi.stubEnv('CODEX_HOME', home);
    writeFileSync(join(home, 'history.jsonl'), '');
    const state = { viewport: codexDialog(''), cursor: { x: 2, y: 4 } };
    const backend = {
      cliPid: 12345,
      expectedCodexSessionId: SID,
      write: vi.fn(),
      captureInputState: () => state,
      submitBracketedPaste: vi.fn(),
    };
    const h = workerSubmitHarness();
    h.scope.pendingMessages.splice(0, 1, {
      turnId: 'turn-durable', dispatchAttempt: 1, queuedActivationToken: 'qa-durable', content: 'blocked',
    });
    Object.assign(h.scope, {
      backend,
      cliAdapter: createCodexAdapter(),
      lastInitConfig: { cliId: 'codex', nativeSessionTitle: TITLE, promptInjection: 'none' },
      durableTurnInFlight: false,
      queuedTypeAheadTurns: [],
      openingInputBoxSettled: true,
      inputBoxJudgeable: () => false,
      firstWriteLivenessConfirmed: true,
      firstWriteLivenessHeld: false,
      firstWriteHeldNoticeSent: false,
      armFirstWriteLivenessRecheck: vi.fn(),
      currentCodexObservedPid: () => 12345,
      stampMojoTurnMark: vi.fn(),
      deferTurnInputCommitUntilSubmission: () => false,
      maybeQueuePostSubmitNativeSessionTitle: () => false,
      acknowledgeQueuedActivation: vi.fn(),
      dropFailedBridgeMark: vi.fn(),
      sessionInputBlocksDeliveryNow: () => false,
      holdNativeInputForHardBlock: vi.fn(),
    });
    h.scope.holdOpeningInput = loadWorkerFunction('holdOpeningInput', h.scope);
    h.scope.notifyHeldInput = loadWorkerFunction('notifyHeldInput', h.scope);
    h.scope.inflightInputs.onWrite = vi.fn();

    await h.flush();
    expect(h.scope.pendingMessages).toHaveLength(1);
    expect(backend.submitBracketedPaste).not.toHaveBeenCalled();
    expect(h.scope.durableTurnInFlight).toBe(false);
    expect(h.scope.inflightInputs.onWrite).not.toHaveBeenCalled();
    expect(h.queue.hasPendingTurn('turn-durable')).toBe(false);
    expect(h.scope.queuedTypeAheadTurns).toEqual([]);
    expect(h.scope.send.mock.calls.map(([event]) => event.type)).not.toContain('type_ahead_queued');
    expect(h.scope.send.mock.calls.map(([event]) => event.type)).not.toContain('queued_activation_submitted');
    expect(h.scope.acknowledgeQueuedActivation).not.toHaveBeenCalled();
  });
});
