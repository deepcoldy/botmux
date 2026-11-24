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
import { workerSubmitHarness } from './helpers/worker-submit-harness.js';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';

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

function inputHarness(cliId: 'codex' | 'traex', viewport: string, persistentReattach = false) {
  const h = workerSubmitHarness();
  const adapter = cliId === 'codex' ? createCodexAdapter() : createTraexAdapter();
  const backend = {
    write: vi.fn(),
    captureInputState: () => ({ viewport, cursor: cliId === 'codex' ? { x: 2, y: 0 } : undefined }),
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

  it('rejects dialog footers before they can impersonate an empty Codex composer', () => {
    for (const viewport of [codexDialog(''), choiceModal]) {
      expect(codexEmptyComposerFooter({ viewport, cursor: { x: 2, y: 0 } })).toBeUndefined();
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
      programStatusBlockedHoldsTypeAhead: () => true,
      pendingInputAllowsTypeAhead: (_supports: boolean, _durable: boolean, _item: unknown, blocked: boolean) => !blocked,
    });
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
});

describe('Codex Turn 2+ untouched refusal recovery', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    vi.unstubAllEnvs();
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
      sessionInputBlocksDeliveryNow: () => false, // dialog appears after the outer screen check
    });
    h.scope.holdOpeningInput = loadWorkerFunction('holdOpeningInput', h.scope);
    h.scope.notifyHeldInput = loadWorkerFunction('notifyHeldInput', h.scope);

    await h.flush();
    expect(submissions).toEqual([]);
    expect(backend.write).not.toHaveBeenCalled();
    expect(h.scope.pendingMessages.map(item => item.turnId)).toEqual(['turn-1', 'turn-2']);
    expect(h.scope.openingInputBoxSettled).toBe(false);
    expect(h.scope.firstWriteLivenessConfirmed).toBe(false);
    expect(h.scope.send.mock.calls.map(([event]) => event.message)).not.toContain('worker.submit_impossible');

    state = empty146;
    await h.flush();
    await h.flush();
    expect(submissions).toEqual(['first queued message', 'second queued message']);
    expect(h.scope.pendingMessages).toHaveLength(0);
    expect(h.scope.send.mock.calls.map(([event]) => event.message)).not.toContain('worker.submit_impossible');
  });
});
