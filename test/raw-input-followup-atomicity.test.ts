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

  it('queues through an owned restart until the replacement prompt, while preserving normal busy delivery', () => {
    const gateIdx = region.indexOf(
      'if (cliRestartInProgress || rawInputRestartGate || sessionRenameInFlight)',
    );
    const queueIdx = region.indexOf('pendingRawInputs.push(msg)');
    const deliverIdx = region.indexOf('await deliverRawInput(msg)');

    expect(gateIdx).toBeGreaterThanOrEqual(0);
    expect(queueIdx).toBeGreaterThan(gateIdx);
    expect(deliverIdx).toBeGreaterThan(queueIdx);
    // isPromptReady is false while an active CLI is busy, so gating on it would
    // break /btw-style passthrough. The restart-only latch preserves that path.
    expect(region).not.toContain('isPromptReady');
    expect(region).not.toContain('sendRawCommandLine(');
  });
});

describe('worker raw_input delivery', () => {
  const region = caseRegion(workerSrc, 'async function deliverRawInput', 2600);

  it('enqueues followUpContent strictly AFTER the awaited command send (incl. Enter)', () => {
    const sendIdx = region.indexOf('await sendRawCommandLineSerially(targetBackend, msg.content)');
    const followIdx = region.indexOf('msg.followUpContent');
    expect(sendIdx).toBeGreaterThanOrEqual(0);
    expect(followIdx).toBeGreaterThanOrEqual(0);
    expect(followIdx).toBeGreaterThan(sendIdx);
  });

  it('routes the follow-up through sendToPty (normal busy-queue semantics)', () => {
    expect(region).toContain('sendToPty(msg.followUpContent, undefined, {');
    expect(region).toContain('codexAppInput: msg.followUpCodexAppInput');
  });

  it('holds ordinary prompt flushes only for the text-to-Enter critical window', () => {
    const flush = caseRegion(workerSrc, 'async function flushPending()', 9000);
    expect(flush).toContain('if (commandLineWritesPending > 0) return');
    expect(region).not.toContain('if (!isPromptReady)');
    expect(region).not.toContain('if (isPromptReady)');
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
  const helper = caseRegion(workerSrc, 'async function sendRawCommandLine', 2200);

  it('generic CLIs: literal text → 200ms beat → Enter in order (slash-picker safe)', () => {
    const textIdx = helper.indexOf('sendText(content)');
    expect(textIdx).toBeGreaterThanOrEqual(0);
    // Anchor the beat/Enter lookups AFTER the text write so the CoCo branch's own
    // 200ms beat (which precedes the generic path) can't be mistaken for this one.
    const beatIdx = helper.indexOf('setTimeout(r, 200)', textIdx);
    const enterIdx = helper.indexOf("sendSpecialKeys('Enter')", beatIdx);
    expect(beatIdx).toBeGreaterThan(textIdx);
    expect(enterIdx).toBeGreaterThan(beatIdx);
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
