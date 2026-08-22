import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const worker = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');

describe('Hook review input hold wiring', () => {
  it('holds queued input before the literal write and only releases after the menu clears', () => {
    const holdStart = worker.indexOf('function refreshHookReviewInputHold');
    const hold = worker.slice(holdStart, worker.indexOf('\n/** Wait until', holdStart));
    const flushStart = worker.indexOf('async function flushPending(): Promise<void>');
    const flush = worker.slice(flushStart, worker.indexOf('\n  // Screen-idle', flushStart));

    expect(holdStart).toBeGreaterThanOrEqual(0);
    expect(hold).toContain('queueMicrotask(() => { void flushPending(); })');
    expect(flush).toContain("refreshHookReviewInputHold(lastAnalyzerSnapshot || renderer?.rawSnapshot() || '');");
    expect(flush).toContain('notifyHookReviewInputHold();');
    expect(flush).toContain('if (hookReviewInputHold)');
  });

  it('refreshes the hold from live PTY output and clears it on a new CLI spawn', () => {
    expect(worker).toContain("refreshHookReviewInputHold(`${renderer?.rawSnapshot() ?? ''}\\n${data}`);");
    expect(worker).toContain('refreshHookReviewInputHold(visibleSnapshot);');
    expect(worker).toContain('hookReviewInputHold = false;');
    expect(worker).toContain('hookReviewInputHoldNotified = false;');
  });
});
