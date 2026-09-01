/**
 * Source-level guard for the raw_input + follow-up ATOMIC delivery contract
 * (PR #157 review blocker, round 2).
 *
 * The executable queue/composer ordering contract lives in
 * test/async-serial-queue.test.ts via runAdoptRawInputSequence. This file keeps
 * only the worker/daemon wiring assertions because worker.ts is a process
 * script with no exports. The race it guards against:
 * `process.on('message', async ...)` handlers do NOT serialize — the
 * raw_input branch awaits 200ms between sendText and Enter, and a separate
 * `message` IPC handled in that window writes into the PTY first (type-ahead
 * adapters flush immediately), interleaving the follow-up into the slash
 * command. The fix makes the follow-up ride on the raw_input IPC itself and
 * the worker write it strictly after the Enter while retaining the same adopt
 * queue until the complete adapter lifecycle settles.
 *
 * Daemon-side single-IPC behavior is covered in
 * test/worker-ready-display-mode.test.ts; this file pins the worker-side
 * ordering and the daemon-side "never a second IPC" structure in source.
 *
 * Run: pnpm vitest run test/raw-input-followup-atomicity.test.ts
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  finalizeRawCommandDelivery,
  writeRawCommandLine,
} from '../src/core/raw-command-writer.js';

const workerSrc = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf-8');
const poolSrc = readFileSync(new URL('../src/core/worker-pool.ts', import.meta.url), 'utf-8');
const rawWriterSrc = readFileSync(new URL('../src/core/raw-command-writer.ts', import.meta.url), 'utf-8');

function caseRegion(src: string, marker: string, span = 3000): string {
  const start = src.indexOf(marker);
  expect(start, `${marker} not found`).toBeGreaterThanOrEqual(0);
  return src.slice(start, start + span);
}

describe('worker raw_input handler', () => {
  const region = caseRegion(workerSrc, "case 'raw_input':");

  it('queues through an owned restart until the replacement prompt, while preserving normal busy delivery', () => {
    const gateIdx = region.indexOf(
      'if (cliRestartInProgress || rawInputRestartGate || sessionRenameInFlight',
    );
    const queueIdx = region.indexOf('freshnessInputQueue.enqueueRaw(msg)');
    const deliverIdx = region.indexOf('await deliverRawInput(msg)');

    expect(gateIdx).toBeGreaterThanOrEqual(0);
    expect(queueIdx).toBeGreaterThan(gateIdx);
    expect(deliverIdx).toBeGreaterThan(queueIdx);
    // isPromptReady is false while an active CLI is busy, so gating on it would
    // break /btw-style passthrough. The restart-only latch preserves that path.
    expect(region).not.toContain('isPromptReady');
    expect(region).not.toContain('sendRawCommandLine(');
  });

  it('also defers behind the TUI injection fence: mid-injection (injectionFlushing) and queued cwd barrier (shouldDeferUserFlush) both queue instead of busy-delivering', () => {
    // PR #441 二审阻塞项：raw_input 曾绕过注入 barrier——/cd 注入的 quiescence
    // 等待期间（Serially 只互斥 text→Enter 短窗口）或 barrier 尚未开始时，
    // passthrough 会直送、执行在旧 cwd 的 CLI 里。两个围栏必须与 restart/rename
    // 同在入队条件里。
    const gate = region.slice(
      region.indexOf('if (cliRestartInProgress'),
      region.indexOf('freshnessInputQueue.enqueueRaw(msg)'),
    );
    expect(gate).toContain('injectionFlushing');
    expect(gate).toContain('shouldDeferUserFlush(pendingInjections)');
  });

});

describe('worker adopt/native-rename coordination', () => {
  const messageRegion = caseRegion(workerSrc, "case 'message':", 6500);
  const flushRegion = caseRegion(workerSrc, 'async function flushPending()', 16000);

  it('parks ordinary adopt messages for the full native-rename settle window', () => {
    expect(messageRegion).toContain('pendingAdoptMessages.push(item)');
    expect(messageRegion).toContain('turnId: msg.turnId');
    expect(messageRegion).toContain('dispatchAttempt: msg.dispatchAttempt');
    expect(messageRegion).toContain('cliRestartInProgress || rawInputRestartGate || !backend || sessionRenameInFlight()');
    expect(messageRegion).toContain('await runAdoptMessageForCapturedGeneration(item, () =>');
    expect(flushRegion).toContain('const adoptInputReady = isPromptReady');
    expect(flushRegion).toContain('if (adoptInputReady && pendingAdoptMessages.length > 0)');
  });

  it('serializes adopt rename and rechecks readiness after older composer writes', () => {
    expect(flushRegion).toContain('await runAdoptSessionRenameSequence({');
    expect(flushRegion).toContain('queue: adoptWriteQueue');
    expect(flushRegion).toContain('cliSpawnGeneration === renameGeneration');
    expect(flushRegion).toContain('!rawInputRestartGate');
    expect(flushRegion).toContain('if (!sent)');
    expect(flushRegion).toContain('pendingSessionRename = title');
    expect(flushRegion).toContain('if (!rawInputReady && !supportedSessionRenameReady && !adoptInputReady)');
    expect(flushRegion).toContain("sessionRenamePhase = 'reserved'");
    const beginIdx = flushRegion.indexOf('beginCliWriteCycle();', flushRegion.indexOf('const writeRename'));
    const writingIdx = flushRegion.indexOf("sessionRenamePhase = 'writing'", beginIdx);
    const commandIdx = flushRegion.indexOf('await sendRawCommandLineWithRecoveryFence(renameBackend', writingIdx);
    const sentIdx = flushRegion.indexOf("sessionRenamePhase = 'sent'", commandIdx);
    expect(beginIdx).toBeGreaterThanOrEqual(0);
    expect(writingIdx).toBeGreaterThan(beginIdx);
    expect(commandIdx).toBeGreaterThan(writingIdx);
    expect(sentIdx).toBeGreaterThan(commandIdx);
    expect(workerSrc).toContain("if (sessionRenamePhase === 'sent') forceClearSessionRenameInFlight()");
  });

  it('keeps upstream drain priority: raw input, latest rename, then adopt message', () => {
    const rawIdx = flushRegion.indexOf('if (rawInputReady && pendingRawInputs.length > 0');
    const renameIdx = flushRegion.indexOf('if (supportedSessionRenameReady && pendingSessionRename !== null');
    const adoptIdx = flushRegion.indexOf('const item = pendingAdoptMessages.shift()!');
    expect(rawIdx).toBeGreaterThanOrEqual(0);
    expect(renameIdx).toBeGreaterThan(rawIdx);
    expect(adoptIdx).toBeGreaterThan(renameIdx);
  });

  it('fences process-lifetime adopt tasks before transcript mark or replacement-backend write', () => {
    // Bound the region to the writeAdoptMessage function body (up to the next
    // function) rather than a fixed char span, so restoring the composer guard +
    // submission transaction (which lengthen the body) can't push the later
    // staleness returns out of a hardcoded window.
    const writeRegion = workerSrc.slice(
      workerSrc.indexOf('async function writeAdoptMessage'),
      workerSrc.indexOf('async function runAdoptMessageForCapturedGeneration'),
    );
    const runnerRegion = caseRegion(workerSrc, 'async function runAdoptMessageForCapturedGeneration', 1800);
    const fenceIdx = writeRegion.indexOf('if (!executionFence || !adoptWriteFenceIsCurrent(executionFence))');
    const rendererIdx = writeRegion.indexOf('renderer?.markNewTurn()');
    const markIdx = writeRegion.indexOf('codexBridgeMarkPendingTurn(');
    expect(fenceIdx).toBeGreaterThanOrEqual(0);
    expect(rendererIdx).toBeGreaterThan(fenceIdx);
    expect(markIdx).toBeGreaterThan(fenceIdx);
    expect(writeRegion).toContain("return settleStaleAfterWrite('adopt_generation_changed')");
    expect(writeRegion).toContain("return settleStaleAfterWrite('adopt_generation_changed_before_enter')");
    expect(runnerRegion).toContain('runAdoptQueuedWriteSequence({');
    expect(runnerRegion).toContain('isCurrent: () => adoptWriteFenceIsCurrent(fence)');
    expect(runnerRegion).toContain('onStale: requeueOnce');
    expect(workerSrc).toContain('&& !rawInputRestartGate;');
  });
});

describe('worker raw_input delivery', () => {
  // The span only has to cover deliverRawInput's body; it is not itself an
  // assertion. Kept comfortably ahead of the last anchor below (the previous
  // 7000 left ~2 chars of slack, so any added line broke these tests for
  // reasons that had nothing to do with what they check).
  const region = caseRegion(workerSrc, 'async function deliverRawInput', 7600);

  it('enqueues followUpContent strictly AFTER the awaited command send (incl. Enter)', () => {
    const sendIdx = region.indexOf('await sendRawCommandLineWithRecoveryFence(');
    const followIdx = region.indexOf('msg.followUpContent');
    expect(sendIdx).toBeGreaterThanOrEqual(0);
    expect(followIdx).toBeGreaterThanOrEqual(0);
    expect(followIdx).toBeGreaterThan(sendIdx);
  });

  it('keeps the exact follow-up identity on sendToPty only in the non-adopt path', () => {
    const adoptIdx = region.indexOf('await runAdoptRawInputSequence({');
    const nonAdoptIdx = region.indexOf('const targetBackend = backend;', adoptIdx);
    const sendToPtyIdx = region.indexOf(
      'sendToPty(msg.followUpContent!, msg.followUpTurnId, {',
    );
    expect(adoptIdx).toBeGreaterThanOrEqual(0);
    expect(nonAdoptIdx).toBeGreaterThan(adoptIdx);
    expect(sendToPtyIdx).toBeGreaterThan(nonAdoptIdx);
  });

  it('routes the follow-up through sendToPty (normal busy-queue semantics)', () => {
    expect(region).toContain('sendToPty(msg.followUpContent!, msg.followUpTurnId, {');
    expect(region).toContain('codexAppInput: msg.followUpCodexAppInput');
  });

  it('rotates or revokes the marker immediately before writing the raw command', () => {
    const sendIdx = region.indexOf('await sendRawCommandLineWithRecoveryFence(');
    const callbackIdx = region.indexOf('() => {', sendIdx);
    const bindIdx = region.indexOf('currentBotmuxTurnId = msg.turnId');
    const markerIdx = region.indexOf('writeCliPidMarker()');
    const capabilityIdx = region.indexOf('publishSandboxRelayCapability()');
    expect(sendIdx).toBeGreaterThanOrEqual(0);
    expect(callbackIdx).toBeGreaterThan(sendIdx);
    expect(bindIdx).toBeGreaterThan(callbackIdx);
    expect(markerIdx).toBeGreaterThan(bindIdx);
    expect(capabilityIdx).toBeGreaterThan(markerIdx);
  });

  it('awaits the full adopt follow-up adapter lifecycle in the raw queue transaction', () => {
    expect(region).toContain('const writeRawInput = async (');
    expect(region).toContain('targetBackend: SessionBackend,');
    expect(region).toContain('await runAdoptRawInputSequence({');
    expect(region).toContain('queue: adoptWriteQueue');
    expect(region).toContain('isCurrent: () => adoptWriteFenceIsCurrent(fence)');
    expect(region).toContain('onStaleBeforeWrite: () =>');
    expect(region).toContain('onStaleBeforeFollowUp: () =>');
    const staleFollowUp = region.slice(
      region.indexOf('onStaleBeforeFollowUp: () =>'),
      region.indexOf('writeRawInput:', region.indexOf('onStaleBeforeFollowUp: () =>')),
    );
    expect(staleFollowUp).toContain('follow-up was withheld');
    expect(staleFollowUp).not.toContain('pendingAdoptMessages.push');
    expect(region).toContain('const result = await writeAdoptMessage(');
    const postRawWriteFollowUp = region.slice(
      region.indexOf("if (result === 'stale-before-write')"),
      region.indexOf("} else if (result === 'completed')"),
    );
    expect(postRawWriteFollowUp).toContain('follow-up was withheld');
    expect(postRawWriteFollowUp).not.toContain('pendingAdoptMessages.push');
    expect(region).toContain('fence,');
  });

  it('holds ordinary prompt flushes only for the text-to-Enter critical window', () => {
    const flush = caseRegion(workerSrc, 'async function flushPending()', 9000);
    expect(flush).toContain('if (commandLineWritesPending > 0) return');
    expect(region).not.toContain('if (!isPromptReady)');
    expect(region).not.toContain('if (isPromptReady)');
  });

  it('surfaces an ambiguous terminal and user notice when the literal command write fails', () => {
    const transactionIdx = region.indexOf(
      'await sendRawCommandLineWithRecoveryFence(',
    );
    const catchIdx = region.indexOf('catch (err');
    const recoveryIdx = region.indexOf('err instanceof SubmissionWriteError', catchIdx);
    const terminalIdx = region.indexOf(
      "emitTurnTerminal(failedTurnId, 'ambiguous', 'raw_input_write_failed')",
      catchIdx,
    );
    const notifyIdx = region.indexOf("type: 'user_notify'", catchIdx);

    expect(transactionIdx).toBeGreaterThanOrEqual(0);
    expect(catchIdx).toBeGreaterThan(transactionIdx);
    expect(recoveryIdx).toBeGreaterThan(catchIdx);
    expect(terminalIdx).toBeGreaterThan(catchIdx);
    expect(notifyIdx).toBeGreaterThan(terminalIdx);
  });

  it('only claims follow-up text was skipped when that IPC actually carried one', () => {
    const catchIdx = region.indexOf('catch (err');
    const conditionIdx = region.indexOf('msg.followUpContent', catchIdx);
    const followUpKeyIdx = region.indexOf("'worker.raw_input_failed'", conditionIdx);
    const commandOnlyKeyIdx = region.indexOf("'worker.raw_input_failed_command_only'", conditionIdx);
    const recoveryFollowUpKeyIdx = region.indexOf(
      "'worker.raw_input_failed_recovery'",
      conditionIdx,
    );
    const recoveryCommandOnlyKeyIdx = region.indexOf(
      "'worker.raw_input_failed_command_only_recovery'",
      conditionIdx,
    );
    const notifyIdx = region.indexOf("type: 'user_notify'", catchIdx);

    expect(conditionIdx).toBeGreaterThan(catchIdx);
    expect(followUpKeyIdx).toBeGreaterThan(conditionIdx);
    expect(commandOnlyKeyIdx).toBeGreaterThan(followUpKeyIdx);
    expect(recoveryFollowUpKeyIdx).toBeGreaterThan(conditionIdx);
    expect(recoveryCommandOnlyKeyIdx).toBeGreaterThan(recoveryFollowUpKeyIdx);
    expect(notifyIdx).toBeGreaterThan(catchIdx);
  });
});

describe('worker command-line write mutex', () => {
  const serialized = caseRegion(
    workerSrc,
    'async function sendRawCommandLineWithRecoveryFence',
    1400,
  );

  it('serializes the whole raw recovery transaction without waiting for turn idle', () => {
    expect(serialized).toContain('const previous = commandLineWriteTail');
    expect(serialized).toContain('commandLineWritesPending += 1');
    expect(serialized).toContain('await previous');
    expect(serialized).toContain('runAmbiguousSubmissionTransaction(');
    expect(serialized).toContain('() => sendRawCommandLine(be, content)');
    expect(serialized).toContain('beforeWrite');
    expect(serialized).toContain('release()');
  });
});

describe('worker sendRawCommandLine helper', () => {
  const helper = caseRegion(rawWriterSrc, 'export async function writeRawCommandLine', 2200);

  it('generic CLIs: literal text → 200ms beat → Enter in order (slash-picker safe)', () => {
    const textIdx = helper.indexOf('sendText(content)');
    expect(textIdx).toBeGreaterThanOrEqual(0);
    // Anchor the beat/Enter lookups AFTER the text write so the CoCo branch's own
    // 200ms beat (which precedes the generic path) can't be mistaken for this one.
    const beatIdx = helper.indexOf('delay(beatMs)', textIdx);
    const enterIdx = helper.indexOf("sendSpecialKeys('Enter')", beatIdx);
    expect(beatIdx).toBeGreaterThan(textIdx);
    expect(enterIdx).toBeGreaterThan(beatIdx);
  });

  it('CoCo: types char-by-char (throttled) before a single Enter (paste-coalescing safe)', () => {
    const cocoIdx = helper.indexOf('opts.coco');
    expect(cocoIdx, 'CoCo branch present').toBeGreaterThanOrEqual(0);
    const genericTextIdx = helper.indexOf('sendText(content)');
    // The CoCo branch fully precedes the generic one-shot path.
    expect(cocoIdx).toBeLessThan(genericTextIdx);
    // Per-char keystrokes spaced by the throttle — a one-shot write coalesces into
    // a paste on CoCo, which skips command mode + the slash picker.
    const charIdx = helper.indexOf('sendText(ch)', cocoIdx);
    const throttleIdx = helper.indexOf('opts.cocoThrottleMs', cocoIdx);
    expect(charIdx).toBeGreaterThan(cocoIdx);
    expect(charIdx).toBeLessThan(genericTextIdx);
    expect(throttleIdx).toBeGreaterThan(cocoIdx);
    // Exactly one Enter, after the beat (a stray 2nd Enter would confirm a /model
    // selector pick); the branch returns immediately after.
    const cocoEnterIdx = helper.indexOf("sendSpecialKeys('Enter')", throttleIdx);
    const returnIdx = helper.indexOf("return sendSpecialKeys('Enter') !== false", throttleIdx);
    expect(cocoEnterIdx).toBeGreaterThan(throttleIdx);
    expect(cocoEnterIdx).toBeLessThan(genericTextIdx);
    expect(returnIdx).toBeGreaterThan(throttleIdx);
    expect(cocoEnterIdx).toBeGreaterThan(returnIdx);
    expect(returnIdx).toBeLessThan(genericTextIdx);
  });

  it('fails before Enter when a backend explicitly rejects the generic text write', () => {
    const textIdx = helper.indexOf('sendText(content)');
    const rejectionIdx = helper.indexOf('=== false) return false', textIdx);
    const beatIdx = helper.indexOf('delay(beatMs)', textIdx);
    const enterIdx = helper.indexOf("sendSpecialKeys('Enter')", textIdx);

    expect(helper.slice(textIdx - 30, rejectionIdx + 30)).toContain('=== false');
    expect(rejectionIdx).toBeGreaterThan(textIdx);
    expect(rejectionIdx).toBeLessThan(beatIdx);
    expect(rejectionIdx).toBeLessThan(enterIdx);
  });

  it('stops CoCo typing immediately on rejection and also checks the submit key', () => {
    const cocoIdx = helper.indexOf('opts.coco');
    const charIdx = helper.indexOf('sendText(ch)', cocoIdx);
    const charRejectionIdx = helper.indexOf('=== false) return false', charIdx);
    const throttleIdx = helper.indexOf('opts.cocoThrottleMs', charIdx);
    const enterIdx = helper.indexOf("sendSpecialKeys('Enter')", throttleIdx);

    expect(helper.slice(charIdx - 30, charRejectionIdx + 30)).toContain('=== false');
    expect(charRejectionIdx).toBeGreaterThan(charIdx);
    expect(charRejectionIdx).toBeLessThan(throttleIdx);
    expect(enterIdx).toBeGreaterThan(throttleIdx);
  });
});

describe('raw command backend acceptance', () => {
  const immediateDelay = vi.fn(async () => {});

  it('uses pasteText before Enter when pasteLine is enabled', async () => {
    const calls: string[] = [];
    const write = vi.fn(() => true);
    const sendText = vi.fn((text: string) => {
      calls.push(`sendText:${text}`);
      return true;
    });
    const pasteText = vi.fn((text: string) => {
      calls.push(`pasteText:${text}`);
      return true;
    });
    const sendSpecialKeys = vi.fn((key: string) => {
      calls.push(`sendSpecialKeys:${key}`);
      return true;
    });
    const delay = vi.fn(async (ms: number) => {
      calls.push(`delay:${ms}`);
    });
    const fake = { supportsRawCommandPasteLine: true, write, sendText, sendSpecialKeys, pasteText };
    const pasteLineOptions = { pasteLine: true, pasteSettleMs: 300, delay };

    await expect(writeRawCommandLine(
      fake,
      '/mr-review-team 127',
      pasteLineOptions,
    )).resolves.toBe(true);

    expect(pasteText).toHaveBeenCalledOnce();
    expect(pasteText).toHaveBeenCalledWith('/mr-review-team 127');
    expect(sendText).not.toHaveBeenCalled();
    expect(sendSpecialKeys).toHaveBeenCalledWith('Enter');
    expect(delay).toHaveBeenCalledWith(300);
    expect(calls).toEqual([
      'pasteText:/mr-review-team 127',
      'delay:300',
      'sendSpecialKeys:Enter',
    ]);
  });

  it('falls back to sendText when pasteLine is enabled but the backend has no paste-line contract', async () => {
    const calls: string[] = [];
    const write = vi.fn(() => true);
    const sendText = vi.fn((text: string) => {
      calls.push(`sendText:${text}`);
      return true;
    });
    const pasteText = vi.fn((text: string) => {
      calls.push(`pasteText:${text}`);
      return true;
    });
    const sendSpecialKeys = vi.fn((key: string) => {
      calls.push(`sendSpecialKeys:${key}`);
      return true;
    });
    const delay = vi.fn(async (ms: number) => {
      calls.push(`delay:${ms}`);
    });
    const fake = { write, sendText, sendSpecialKeys, pasteText };

    await expect(writeRawCommandLine(
      fake,
      '/mr-review-team 127',
      { pasteLine: true, pasteSettleMs: 300, delay },
    )).resolves.toBe(true);

    expect(pasteText).not.toHaveBeenCalled();
    expect(sendText).toHaveBeenCalledWith('/mr-review-team 127');
    expect(sendSpecialKeys).toHaveBeenCalledWith('Enter');
    expect(calls).toEqual([
      'sendText:/mr-review-team 127',
      'delay:200',
      'sendSpecialKeys:Enter',
    ]);
  });

  it('falls back to sendText plus Enter when pasteLine is enabled without pasteText', async () => {
    const calls: string[] = [];
    const write = vi.fn(() => true);
    const sendText = vi.fn((text: string) => {
      calls.push(`sendText:${text}`);
      return true;
    });
    const sendSpecialKeys = vi.fn((key: string) => {
      calls.push(`sendSpecialKeys:${key}`);
      return true;
    });
    const delay = vi.fn(async (ms: number) => {
      calls.push(`delay:${ms}`);
    });
    const fake = { write, sendText, sendSpecialKeys };
    const pasteLineOptions = { pasteLine: true, pasteSettleMs: 300, delay };

    await expect(writeRawCommandLine(
      fake,
      '/mr-review-team 127',
      pasteLineOptions,
    )).resolves.toBe(true);

    expect(sendText).toHaveBeenCalledWith('/mr-review-team 127');
    expect(sendSpecialKeys).toHaveBeenCalledWith('Enter');
    expect(calls).toEqual([
      'sendText:/mr-review-team 127',
      'delay:200',
      'sendSpecialKeys:Enter',
    ]);
  });

  it('uses pasteText with Enter when pasteLine is enabled even without sendText', async () => {
    const calls: string[] = [];
    const write = vi.fn(() => {
      calls.push('write');
      return true;
    });
    const pasteText = vi.fn((text: string) => {
      calls.push(`pasteText:${text}`);
      return true;
    });
    const sendSpecialKeys = vi.fn((key: string) => {
      calls.push(`sendSpecialKeys:${key}`);
      return true;
    });
    const delay = vi.fn(async (ms: number) => {
      calls.push(`delay:${ms}`);
    });
    const fake = { supportsRawCommandPasteLine: true, write, sendSpecialKeys, pasteText };

    await expect(writeRawCommandLine(
      fake,
      '/mr-review-team 127',
      { pasteLine: true, delay },
    )).resolves.toBe(true);

    expect(pasteText).toHaveBeenCalledWith('/mr-review-team 127');
    expect(sendSpecialKeys).toHaveBeenCalledWith('Enter');
    expect(write).not.toHaveBeenCalled();
    expect(calls).toEqual([
      'pasteText:/mr-review-team 127',
      'delay:200',
      'sendSpecialKeys:Enter',
    ]);
  });

  it('keeps CoCo char-by-char sendText precedence when pasteLine is enabled', async () => {
    const calls: string[] = [];
    const write = vi.fn(() => true);
    const sendText = vi.fn((text: string) => {
      calls.push(`sendText:${text}`);
      return true;
    });
    const pasteText = vi.fn((text: string) => {
      calls.push(`pasteText:${text}`);
      return true;
    });
    const sendSpecialKeys = vi.fn((key: string) => {
      calls.push(`sendSpecialKeys:${key}`);
      return true;
    });
    const delay = vi.fn(async (ms: number) => {
      calls.push(`delay:${ms}`);
    });
    const fake = { supportsRawCommandPasteLine: true, write, sendText, sendSpecialKeys, pasteText };
    const pasteLineOptions = {
      coco: true,
      cocoThrottleMs: 7,
      pasteLine: true,
      pasteSettleMs: 300,
      delay,
    };

    await expect(writeRawCommandLine(
      fake,
      '/mr-review-team 127',
      pasteLineOptions,
    )).resolves.toBe(true);

    expect(pasteText).not.toHaveBeenCalled();
    expect(sendText).toHaveBeenCalledTimes('/mr-review-team 127'.length);
    expect(sendText).toHaveBeenNthCalledWith(1, '/');
    expect(sendSpecialKeys).toHaveBeenCalledWith('Enter');
    expect(delay).toHaveBeenCalledWith(7);
    expect(calls.at(-1)).toBe('sendSpecialKeys:Enter');
  });

  it('fails closed when the text write is rejected', async () => {
    const sendText = vi.fn(() => false);
    const sendSpecialKeys = vi.fn(() => true);
    await expect(writeRawCommandLine({
      write: vi.fn(), sendText, sendSpecialKeys,
    }, '/goal x', { delay: immediateDelay })).resolves.toBe(false);
    expect(sendSpecialKeys).not.toHaveBeenCalled();
  });

  it('fails closed when Enter is rejected after accepted text', async () => {
    const sendText = vi.fn(() => true);
    const sendSpecialKeys = vi.fn(() => false);
    await expect(writeRawCommandLine({
      write: vi.fn(), sendText, sendSpecialKeys,
    }, '/goal x', { delay: immediateDelay })).resolves.toBe(false);
    expect(sendSpecialKeys).toHaveBeenCalledWith('Enter');
  });

  it('fails closed when a PTY-style backend disappears before either write', async () => {
    const write = vi.fn(() => false);
    await expect(writeRawCommandLine({ write }, '/goal x', {
      delay: immediateDelay,
    })).resolves.toBe(false);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('does not ACK or enqueue a follower after rejected Enter and retires the durable generation', async () => {
    const accepted = await writeRawCommandLine({
      write: vi.fn(),
      sendText: vi.fn(() => true),
      sendSpecialKeys: vi.fn(() => false),
    }, '/goal x', { delay: immediateDelay });
    const onActivationAck = vi.fn();
    const onFollowUp = vi.fn();
    const onDurableFailure = vi.fn();

    expect(finalizeRawCommandDelivery({
      accepted,
      durableActivation: true,
      acknowledgeActivation: true,
      hasFollowUp: true,
      onAccepted: vi.fn(),
      onFollowUp,
      onActivationAck,
      onDurableFailure,
    })).toBe(false);
    expect(onActivationAck).not.toHaveBeenCalled();
    expect(onFollowUp).not.toHaveBeenCalled();
    expect(onDurableFailure).toHaveBeenCalledOnce();
  });
});

describe('daemon prompt_ready dispatch', () => {
  // Anchored on the raw_input send itself, NOT a fixed character window from
  // `case 'prompt_ready':`. The old 2000-char span silently stopped covering the
  // assertion below as soon as comments were added above it, so this failed
  // without the wiring having changed at all.
  const sendIdx = poolSrc.indexOf("case 'prompt_ready':");
  const rawIdx = poolSrc.indexOf("type: 'raw_input',", sendIdx);
  const region = poolSrc.slice(sendIdx, poolSrc.indexOf('});', rawIdx));

  it('bundles the follow-up onto the raw_input IPC instead of a second message IPC', () => {
    expect(rawIdx, 'raw_input send not found after prompt_ready').toBeGreaterThan(sendIdx);
    expect(region).toContain('followUpContent: followUp?.cliInput');
    // A separate `message` IPC here would reopen the race — must not exist.
    expect(region).not.toContain("type: 'message'");
  });
});

describe('post-settle restart fence', () => {
  // PR #570 三审阻塞项:detectBareShellLaunch() 的 settle await 会让出事件循环
  // 最长 2s;tmux restart 的 250–1999ms jitter 期间 cliRestartInProgress 已 true
  // 而旧 backend 仍存活。两条持锁 flush(message / injection)在 await 返回后只
  // 复查 backend(jitter 内非 null),不复查 restart fence,会把输入写进即将销毁的
  // 旧 CLI。改前 detector 同步、入口 restart check 与写入间无让出,故是本次
  // async 化扩出的第二个窗口。三处 source-level 顺序断言钉死修复。

  it('flushPending re-checks cliRestartInProgress AFTER the awaited detector, BEFORE any write', () => {
    // RPC lifecycle/replay wiring expands the front half of flushPending; keep
    // the slice large enough to include both structured adapter write paths.
    const flush = caseRegion(workerSrc, 'async function flushPending()', 35000);
    const detector = flush.indexOf('if (await detectBareShellLaunch())');
    const fence = flush.indexOf('if (cliRestartInProgress) return;', detector);
    const startup = flush.indexOf('await runStartupCommands()', detector);
    const rawShift = flush.indexOf('freshnessInputQueue.takeRaw()', detector);
    const writeStructuredInput = flush.indexOf('writeAdapter.writeStructuredInput!(', detector);
    const writeInput = flush.indexOf('writeAdapter.writeInput(', detector);
    expect(detector).toBeGreaterThanOrEqual(0);
    expect(fence).toBeGreaterThan(detector);
    // Fence must precede every downstream write/shift the settle await exposed.
    expect(startup).toBeGreaterThan(fence);
    expect(rawShift).toBeGreaterThan(fence);
    expect(writeStructuredInput).toBeGreaterThan(fence);
    expect(writeInput).toBeGreaterThan(fence);
  });

  it('flushPendingInjections re-checks cliRestartInProgress AFTER the awaited detector, BEFORE the shift', () => {
    const inj = caseRegion(workerSrc, 'async function flushPendingInjections()', 3000);
    const detector = inj.indexOf('if (await detectBareShellLaunch()) return');
    const fence = inj.indexOf('if (cliRestartInProgress) return;', detector);
    const shift = inj.indexOf('pendingInjections.shift()', detector);
    expect(detector).toBeGreaterThanOrEqual(0);
    expect(fence).toBeGreaterThan(detector);
    expect(shift).toBeGreaterThan(fence);
  });

  it('detectBareShellLaunch skips bare-shell classification when a restart began during settle', () => {
    const detect = caseRegion(workerSrc, 'async function detectBareShellLaunch()', 2400);
    const settle = detect.indexOf('await settleLaunchComm(');
    const restartCheck = detect.indexOf('if (cliRestartInProgress) return false;', settle);
    const classify = detect.indexOf('isBareShellComm(comm)', restartCheck);
    const block = detect.indexOf('bareShellLaunchBlocked = true', restartCheck);
    expect(settle).toBeGreaterThanOrEqual(0);
    // The restart short-circuit must sit after the await and before the
    // bare-shell verdict / persistent block, so a torn-down pane isn't
    // misdiagnosed as a failed launch.
    expect(restartCheck).toBeGreaterThan(settle);
    expect(classify).toBeGreaterThan(restartCheck);
    expect(block).toBeGreaterThan(restartCheck);
  });
});

describe('late bare-shell launch recovery', () => {
  it('releases the launch block only after PTY readiness and a non-shell pane leaf', () => {
    const helper = caseRegion(workerSrc, 'function recoverBareShellLaunchFromPty(observedBackend:', 1600);
    const generationFence = helper.indexOf('if (backend !== observedBackend)');
    const read = helper.indexOf('readPaneLeafComm(observedBackend)');
    const rejectBare = helper.indexOf('if (!comm || isBareShellComm(comm))', read);
    const release = helper.indexOf('bareShellLaunchBlocked = false', rejectBare);

    expect(generationFence).toBeGreaterThanOrEqual(0);
    expect(read).toBeGreaterThan(generationFence);
    expect(rejectBare).toBeGreaterThan(read);
    expect(release).toBeGreaterThan(rejectBare);

    const ptyReady = caseRegion(workerSrc, 'function markPromptReadyFromPty(observedBackend:', 600);
    const recover = ptyReady.indexOf('if (!recoverBareShellLaunchFromPty(observedBackend)) return;');
    const mark = ptyReady.indexOf('markPromptReady()', recover);
    expect(recover).toBeGreaterThanOrEqual(0);
    expect(mark).toBeGreaterThan(recover);
  });

  it('turns an injection-first shell verdict back into a non-ready state', () => {
    const detect = caseRegion(workerSrc, 'async function detectBareShellLaunch()', 4300);
    const block = detect.indexOf('bareShellLaunchBlocked = true');
    const clearReady = detect.indexOf('isPromptReady = false', block);
    const resetIdle = detect.indexOf('idleDetector?.reset()', clearReady);
    const notify = detect.indexOf("type: 'user_notify'", resetIdle);

    expect(block).toBeGreaterThanOrEqual(0);
    expect(clearReady).toBeGreaterThan(block);
    expect(resetIdle).toBeGreaterThan(clearReady);
    expect(notify).toBeGreaterThan(resetIdle);
  });

  it('generation-fences PTY data before it can feed the active idle detector', () => {
    const wiring = caseRegion(workerSrc, 'const observedBackend = backend;', 3400);
    const onData = wiring.indexOf('observedBackend.onData((data) =>');
    const fence = wiring.indexOf('if (backend !== observedBackend) return;', onData);
    const feed = wiring.indexOf('onPtyData(data)', fence);
    const ptyReady = wiring.indexOf('markPromptReadyFromPty(observedBackend)');

    expect(onData).toBeGreaterThanOrEqual(0);
    expect(fence).toBeGreaterThan(onData);
    expect(feed).toBeGreaterThan(fence);
    expect(ptyReady).toBeGreaterThanOrEqual(0);
  });

  it('keeps non-PTY ready sources from stranding a blocked launch', () => {
    const markReady = caseRegion(workerSrc, 'function markPromptReady(): void', 900);
    const block = markReady.indexOf('if (bareShellLaunchBlocked)');
    const duplicateReadyGuard = markReady.indexOf('if (isPromptReady) {', block);
    expect(block).toBeGreaterThanOrEqual(0);
    expect(duplicateReadyGuard).toBeGreaterThan(block);
  });

  it('reports an unresolved same-shell launch as delayed instead of naming stale causes', () => {
    const detect = caseRegion(workerSrc, 'async function detectBareShellLaunch()', 5200);
    expect(detect).toContain('启动时间较长');
    expect(detect).toContain('检测到真实输入框后会自动继续投递');
    expect(detect).toContain('仅凭进程仍是');
    expect(detect).not.toContain('Oh My Zsh 升级提示');
    expect(detect).not.toContain('GIT_TERMINAL_PROMPT');
    expect(detect).not.toContain('可执行文件不在 PATH');
    expect(detect).toContain('turnId: pendingTurn?.turnId ?? currentBotmuxTurnId');
    expect(detect).toContain('dispatchAttempt: pendingTurn?.dispatchAttempt ?? currentBotmuxDispatchAttempt');
  });
});
