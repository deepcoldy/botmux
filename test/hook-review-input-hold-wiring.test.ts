import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'bun:test';

const worker = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');

describe('Hook review input hold wiring', () => {
  it('holds queued input before the literal write and only releases after the menu clears', () => {
    const holdStart = worker.indexOf('function refreshHookReviewInputHold');
    const hold = worker.slice(holdStart, worker.indexOf('\n/** Wait until', holdStart));
    const queueHelperStart = worker.indexOf('function hasPendingInputForFlush(): boolean');
    const queueHelper = worker.slice(queueHelperStart, worker.indexOf('\nlet nativeSessionTitleResumeUpdatedAt', queueHelperStart));
    const flushStart = worker.indexOf('async function flushPending(): Promise<void>');
    const flush = worker.slice(flushStart, worker.indexOf('\n  // Screen-idle', flushStart));

    expect(holdStart).toBeGreaterThanOrEqual(0);
    expect(queueHelperStart).toBeGreaterThanOrEqual(0);
    expect(hold).toContain('queueMicrotask(() => { void flushPending(); })');
    expect(hold).toContain('hasPendingInputForFlush()');
    expect(queueHelper).toContain('pendingMessages.length > 0');
    expect(queueHelper).toContain('pendingAdoptMessages.length > 0');
    expect(queueHelper).toContain('pendingRawInputs.length > 0');
    expect(queueHelper).toContain('pendingSessionRename !== null');
    expect(flush).toContain('if (!hasPendingInputForFlush()) return;');
    expect(flush).toContain("refreshHookReviewInputHold(lastAnalyzerSnapshot || renderer?.rawSnapshot() || '');");
    expect(flush).toContain('notifyHookReviewInputHold();');
    expect(flush).toContain('if (hookReviewInputHold)');
  });

  it('refreshes the hold from live PTY output, gates direct raw input, and clears it on a new CLI spawn', () => {
    const rawStart = worker.indexOf("case 'raw_input': {");
    const raw = worker.slice(rawStart, worker.indexOf("case 'rename_session':", rawStart));

    expect(worker).toContain("refreshHookReviewInputHold(`${renderer?.rawSnapshot() ?? ''}\\n${data}`);");
    expect(worker).toContain('refreshHookReviewInputHold(visibleSnapshot);');
    expect(rawStart).toBeGreaterThanOrEqual(0);
    expect(raw).toContain("refreshHookReviewInputHold(lastAnalyzerSnapshot || renderer?.rawSnapshot() || '');");
    expect(raw).toContain('if (hookReviewInputHold)');
    expect(raw).toContain('freshnessInputQueue.enqueueRaw(msg);');
    expect(raw).toContain('notifyHookReviewInputHold();');
    expect(raw.indexOf('if (hookReviewInputHold)')).toBeLessThan(raw.indexOf('await deliverRawInput(msg);'));
    expect(worker).toContain('hookReviewInputHold = false;');
    expect(worker).toContain('hookReviewInputHoldNotified = false;');
  });
});
