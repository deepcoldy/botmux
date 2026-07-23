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
    const retirementIdx = region.indexOf(
      'if (shutdownDetachRequestId || closeRequestInFlightId || preparedCloseRequestId)',
    );
    // Gate is multi-line after PR #441 injection fence merge.
    const gateIdx = region.indexOf('if (cliRestartInProgress || rawInputRestartGate || sessionRenameInFlight()');
    const queueIdx = region.indexOf('pendingRawInputs.push(msg)');
    const deliverIdx = region.indexOf('await deliverRawInput(msg)');

    expect(retirementIdx).toBeGreaterThanOrEqual(0);
    expect(gateIdx).toBeGreaterThan(retirementIdx);
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
      region.indexOf('pendingRawInputs.push(msg)'),
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
    const commandIdx = flushRegion.indexOf('await sendRawCommandLineSerially(renameBackend', writingIdx);
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
    const writeRegion = caseRegion(workerSrc, 'async function writeAdoptMessage', 6200);
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
  const region = caseRegion(workerSrc, 'async function deliverRawInput', 7000);

  it('enqueues followUpContent strictly AFTER the awaited command send (incl. Enter)', () => {
    const sendIdx = region.indexOf('await sendRawCommandLineSerially(targetBackend, msg.content)');
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
    expect(region).toContain('codexAppInput: msg.followUpCodexAppInput');
  });

  it('rotates or revokes the marker immediately before writing the raw command', () => {
    const bindIdx = region.indexOf('currentBotmuxTurnId = msg.turnId');
    const markerIdx = region.indexOf('writeCliPidMarker()');
    const capabilityIdx = region.indexOf('publishSandboxRelayCapability()');
    const sendIdx = region.indexOf('await sendRawCommandLineSerially(targetBackend, msg.content)');
    expect(bindIdx).toBeGreaterThanOrEqual(0);
    expect(markerIdx).toBeGreaterThan(bindIdx);
    expect(capabilityIdx).toBeGreaterThan(markerIdx);
    expect(sendIdx).toBeGreaterThan(capabilityIdx);
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
    expect(flush).toContain(
      'if (shutdownDetachRequestId || closeRequestInFlightId || preparedCloseRequestId) return',
    );
    expect(flush).toContain('if (commandLineWritesPending > 0) return');
    expect(region).not.toContain('if (!isPromptReady)');
    expect(region).not.toContain('if (isPromptReady)');
  });

  it('ACKs a durable generic raw opening only after the awaited Enter succeeds', () => {
    const sentIdx = region.indexOf('sent = await sendRawCommandLineSerially');
    const ackIdx = region.indexOf("type: 'queued_activation_submitted'", sentIdx);
    expect(sentIdx).toBeGreaterThanOrEqual(0);
    expect(ackIdx).toBeGreaterThan(sentIdx);
    expect(region.slice(sentIdx, ackIdx)).toContain(
      "acknowledgeActivation: !!msg.queuedActivationToken && effectiveBackendType !== 'riff'",
    );
  });
});

describe('worker command-line write mutex', () => {
  const serialized = caseRegion(workerSrc, 'async function sendRawCommandLineSerially', 1200);

  it('serializes concurrent raw command keystrokes without waiting for turn idle', () => {
    expect(serialized).toContain('const previous = commandLineWriteTail');
    expect(serialized).toContain('commandLineWritesPending += 1');
    expect(serialized).toContain('await previous');
    expect(serialized).toContain('await sendRawCommandLine(be, content)');
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
});

describe('raw command backend acceptance', () => {
  const immediateDelay = vi.fn(async () => {});

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
  const region = caseRegion(poolSrc, "case 'prompt_ready':", 5000);

  it('bundles the follow-up onto the raw_input IPC instead of a second message IPC', () => {
    expect(region).toContain('followUpContent: followUp?.cliInput');
    // A separate `message` IPC here would reopen the race — must not exist.
    expect(region).not.toContain("type: 'message'");
  });
});
