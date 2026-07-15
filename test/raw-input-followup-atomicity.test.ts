/**
 * Source-level guard for the raw_input + follow-up ATOMIC delivery contract
 * (PR #157 review blocker, round 2).
 *
 * Why source-level: worker.ts is a process script with no exports, so its
 * IPC handler can't be unit-tested directly. The race it guards against:
 * `process.on('message', async ...)` handlers do NOT serialize — the
 * raw_input branch awaits 200ms between sendText and Enter, and a separate
 * `message` IPC handled in that window writes into the PTY first (type-ahead
 * adapters flush immediately), interleaving the follow-up into the slash
 * command. The fix makes the follow-up ride on the raw_input IPC itself and
 * the worker enqueue it strictly after the Enter.
 *
 * Daemon-side single-IPC behavior is covered in
 * test/worker-ready-display-mode.test.ts; this file pins the worker-side
 * ordering and the daemon-side "never a second IPC" structure in source.
 *
 * Run: pnpm vitest run test/raw-input-followup-atomicity.test.ts
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workerSrc = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf-8');
const poolSrc = readFileSync(new URL('../src/core/worker-pool.ts', import.meta.url), 'utf-8');

function caseRegion(src: string, marker: string, span = 3000): string {
  const start = src.indexOf(marker);
  expect(start, `${marker} not found`).toBeGreaterThanOrEqual(0);
  return src.slice(start, start + span);
}

describe('worker raw_input handler', () => {
  const region = caseRegion(workerSrc, "case 'raw_input':");

  it('keeps busy delivery but defers commands while native rename owns the TUI', () => {
    expect(region).toContain('const isNativeRotation = isNativeSessionRotationInput(msg)');
    expect(region).toContain('const rotationNeedsPrompt = rawInputNeedsNativePrompt(msg) && !nativeAdminPromptReady');
    expect(region).toContain('commandLineWritesPending > 0');
    expect(region).toContain('pendingRawInputs.length > 0');
    expect(region).toContain('|| adoptInputWriteInProgress');
    expect(region).toContain('pendingRawInputs.push(msg)');
    expect(region).toContain('await deliverRawInput(msg)');
    expect(region).not.toContain('sendRawCommandLine(');
  });

  it('queues raw commands received while the backend is between generations', () => {
    const backendGapIdx = region.indexOf('!backend');
    const enqueueIdx = region.indexOf('pendingRawInputs.push(msg)');
    const directIdx = region.indexOf('await deliverRawInput(msg)');

    expect(backendGapIdx).toBeGreaterThanOrEqual(0);
    expect(region).toContain('|| !cliAdapter');
    expect(backendGapIdx).toBeLessThan(enqueueIdx);
    expect(enqueueIdx).toBeLessThan(directIdx);
  });
});

describe('worker raw_input delivery', () => {
  const region = caseRegion(workerSrc, 'async function deliverRawInput', 5000);

  it('enqueues followUpContent strictly AFTER the awaited command send (incl. Enter)', () => {
    const sendIdx = region.indexOf('await sendRawCommandLineSerially(targetBackend, msg.content, {');
    const followIdx = region.indexOf('msg.followUpContent');
    expect(sendIdx).toBeGreaterThanOrEqual(0);
    expect(followIdx).toBeGreaterThanOrEqual(0);
    expect(followIdx).toBeGreaterThan(sendIdx);
  });

  it('drains the next queued command only after a complete text-to-Enter send', () => {
    expect(region).toContain('if (sent || !rawCommandWriteFailedAwaitingPrompt) void flushPending()');
    expect(region).not.toContain('\n  void flushPending();\n');

    const flush = caseRegion(workerSrc, 'async function flushPending()', 1600);
    const ready = caseRegion(workerSrc, 'function markPromptReady()', 2200);
    const proof = caseRegion(workerSrc, 'function nativePromptScreenIsSafe', 2400);
    const serialized = caseRegion(workerSrc, 'async function sendRawCommandLineSerially', 1800);
    const handler = caseRegion(workerSrc, "case 'raw_input':");
    expect(flush).toContain('if (rawCommandWriteFailedAwaitingPrompt) return');
    expect(handler).toContain('|| rawCommandWriteFailedAwaitingPrompt');
    expect(ready).toContain('rawCommandWriteFailedAwaitingPrompt = false');
    expect(serialized).toContain('rawCommandWriteFailedAwaitingPrompt = true');
    expect(proof).toContain('hasNativeSessionIdleComposer(screen, cliId)');
    expect(proof).toContain('hasNativeSessionBusyMarker(screen)');
    expect(proof).toContain('captureNativePromptProofScreen(backend)');

    const capture = caseRegion(workerSrc, 'function captureNativePromptProofScreen', 1200);
    expect(capture).toContain('if (be.captureViewport || be.captureCurrentScreen) return captureBackendScreen(be)');
    expect(capture).toContain("renderer?.promptProofSnapshot() ?? ''");
  });

  it('rechecks a concurrent raw failure before every later flush write', () => {
    const flush = caseRegion(workerSrc, 'async function flushPending()', 11000);
    const startup = caseRegion(workerSrc, 'async function runStartupCommands(', 3200);
    expect(flush).toContain('await runStartupCommands(flushBackend, flushBackendEpoch)');
    expect(flush).toContain('if (startupCommandsRan) return;');
    expect(flush).toContain('while (pendingMessages.length > 0 && backendEpochIsCurrent(flushBackend, flushBackendEpoch)) {\n      if (rawCommandWriteFailedAwaitingPrompt) break;');
    expect(startup).toContain('for (const cmd of cmds) {\n    if (rawCommandWriteFailedAwaitingPrompt) break;');
    expect(startup).toContain('() => backendEpochIsCurrent(targetBackend, expectedEpoch)');
    expect(startup).toContain('if (rawCommandWriteFailedAwaitingPrompt) break;');
  });

  it('reserves a proven rotation before the async text-to-Enter window', () => {
    const reserveIdx = region.indexOf('nativeSessionRename.beginRotationCommandWrite()');
    const sendIdx = region.indexOf('await sendRawCommandLineSerially(targetBackend, msg.content, {');
    const commitIdx = region.indexOf('nativeSessionRename.commitRotationCommand()');
    expect(reserveIdx).toBeGreaterThanOrEqual(0);
    expect(reserveIdx).toBeLessThan(sendIdx);
    expect(commitIdx).toBeGreaterThan(sendIdx);
    expect(region).toContain('nativeSessionRename.cancelRotationCommandWrite()');
  });

  it('routes the follow-up through the session-type-specific queue', () => {
    expect(region).toContain('pendingAdoptMessages.push({ content: msg.followUpContent })');
    expect(region).toContain('sendToPty(msg.followUpContent)');
  });

  it('holds ordinary prompt flushes only for the text-to-Enter critical window', () => {
    const flush = caseRegion(workerSrc, 'async function flushPending()', 9000);
    expect(flush).toContain('if (commandLineWritesPending > 0) return');
    expect(flush).toContain('!rawInputNeedsNativePrompt(nextRawInput) || nativeAdminPromptReady');
    expect(flush).toContain('!isPromptReady && !typeAheadAllowed && !rawInputReady');
    expect(region).not.toContain('if (!isPromptReady)');
    expect(region).not.toContain('if (isPromptReady)');
  });
});

describe('worker command-line write mutex', () => {
  const serialized = caseRegion(workerSrc, 'async function sendRawCommandLineSerially', 1900);

  it('serializes concurrent raw command keystrokes without waiting for turn idle', () => {
    expect(serialized).toContain('const previous = commandLineWriteTail');
    expect(serialized).toContain('commandLineWritesPending += 1');
    expect(serialized).toContain('await previous');
    expect(serialized).toContain('await sendRawCommandLine(be, content, expectedEpoch, options.onBeforeSubmit)');
    expect(serialized).toContain('release()');
  });

  it('drops stale backend continuations without poisoning the replacement CLI', () => {
    expect(serialized).toContain('assertBackendEpochCurrent(be, expectedEpoch)');
    expect(serialized).toContain('!isStaleBackendEpochError(err) && backendEpochIsCurrent(be, expectedEpoch)');
    expect(serialized.indexOf('assertBackendEpochCurrent(be, expectedEpoch)'))
      .toBeLessThan(serialized.indexOf('options.onWriteStart?.()'));

    const helper = caseRegion(workerSrc, 'async function sendRawCommandLine', 3600);
    expect(helper).toContain('assertBackendEpochCurrent(be, expectedEpoch)');
    expect(helper).toContain('await onBeforeSubmit?.()');
    expect(helper.indexOf('assertBackendEpochCurrent(be, expectedEpoch)', helper.indexOf('setTimeout(r, 200)')))
      .toBeLessThan(helper.indexOf("sendSpecialKeys('Enter')", helper.indexOf('sendText(content)')));
  });
});

describe('worker sendRawCommandLine helper', () => {
  const helper = caseRegion(workerSrc, 'async function sendRawCommandLine', 3600);

  it('generic CLIs: literal text → 200ms beat → Enter in order (slash-picker safe)', () => {
    const textIdx = helper.indexOf('sendText(content)');
    expect(textIdx).toBeGreaterThanOrEqual(0);
    // Anchor the beat/Enter lookups AFTER the text write so the CoCo branch's own
    // 200ms beat (which precedes the generic path) can't be mistaken for this one.
    const beatIdx = helper.indexOf('setTimeout(r, 200)', textIdx);
    const enterIdx = helper.indexOf("sendSpecialKeys('Enter')", beatIdx);
    expect(beatIdx).toBeGreaterThan(textIdx);
    expect(enterIdx).toBeGreaterThan(beatIdx);
    expect(helper).toContain("assertCommandWriteIssued((be as any).sendText(content), 'command text', false)");
    expect(helper).toContain("assertCommandWriteIssued((be as any).sendSpecialKeys('Enter'), 'command Enter', true)");
  });

  it('CoCo: types char-by-char (throttled) before a single Enter (paste-coalescing safe)', () => {
    const cocoIdx = helper.indexOf("cliId === 'coco'");
    expect(cocoIdx, 'CoCo branch present').toBeGreaterThanOrEqual(0);
    const genericTextIdx = helper.indexOf('sendText(content)');
    // The CoCo branch fully precedes the generic one-shot path.
    expect(cocoIdx).toBeLessThan(genericTextIdx);
    // Per-char keystrokes spaced by the throttle — a one-shot write coalesces into
    // a paste on CoCo, which skips command mode + the slash picker.
    const charIdx = helper.indexOf('sendText(ch)', cocoIdx);
    const throttleIdx = helper.indexOf('COCO_SLASH_TYPE_THROTTLE_MS', cocoIdx);
    expect(charIdx).toBeGreaterThan(cocoIdx);
    expect(charIdx).toBeLessThan(genericTextIdx);
    expect(throttleIdx).toBeGreaterThan(cocoIdx);
    // Exactly one Enter, after the beat (a stray 2nd Enter would confirm a /model
    // selector pick); the branch returns immediately after.
    const cocoEnterIdx = helper.indexOf("sendSpecialKeys('Enter')", throttleIdx);
    const returnIdx = helper.indexOf('return;', throttleIdx);
    expect(cocoEnterIdx).toBeGreaterThan(throttleIdx);
    expect(cocoEnterIdx).toBeLessThan(genericTextIdx);
    expect(returnIdx).toBeGreaterThan(cocoEnterIdx);
    expect(returnIdx).toBeLessThan(genericTextIdx);
  });
});

describe('daemon prompt_ready dispatch', () => {
  const region = caseRegion(poolSrc, "case 'prompt_ready':", 2000);

  it('bundles the follow-up onto the raw_input IPC instead of a second message IPC', () => {
    expect(region).toContain('followUpContent: followUp?.cliInput');
    // A separate `message` IPC here would reopen the race — must not exist.
    expect(region).not.toContain("type: 'message'");
  });
});
