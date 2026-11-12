import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTraexAdapter } from '../src/adapters/cli/traex.js';
import type { PtyHandle } from '../src/adapters/cli/types.js';

// Every Enter TraeX's writeInput sends after a paste lands on whatever the
// TUI shows at that moment. When TRAE's question page has come up meanwhile
// (an agent asking mid-turn), that Enter submits the page's highlighted
// option. So: no blind retry Enter once the submit receipt (history.jsonl) is
// on disk, and no Enter at all once the worker reports the input surface taken.

const SID = '00000000-0000-7000-8000-0000000000aa';
let traeHome: string;
let historyPath: string;
let previousTraeHome: string | undefined;
let previousScale: string | undefined;

/** A PTY whose first Enter writes TRAE's submit receipt `lagMs` later — after
 *  the adapter's first look, as TRAE does on a busy host. */
function ptyWithLaggingReceipt(lagMs: number): PtyHandle & { enters: () => number } {
  let pasted = '';
  let enters = 0;
  return {
    write: vi.fn(),
    pasteText: vi.fn((text: string) => { pasted = text; }),
    sendSpecialKeys: vi.fn((key: string) => {
      if (key !== 'Enter') return;
      enters += 1;
      if (enters > 1) return;
      setTimeout(() => {
        mkdirSync(join(traeHome, 'cli'), { recursive: true });
        appendFileSync(historyPath, `${JSON.stringify({ session_id: SID, ts: 1785900000, text: pasted })}\n`);
      }, lagMs);
    }),
    enters: () => enters,
  };
}

describe.sequential('TraeX submit Enter guard', () => {
  beforeEach(() => {
    previousTraeHome = process.env.TRAE_HOME;
    previousScale = process.env.BOTMUX_TIME_SCALE;
    traeHome = mkdtempSync(join(tmpdir(), 'traex-enter-guard-'));
    historyPath = join(traeHome, 'cli', 'history.jsonl');
    process.env.TRAE_HOME = traeHome;
    // The adapter's 200ms / 800ms waits become 2ms / 8ms.
    process.env.BOTMUX_TIME_SCALE = '0.01';
  });

  afterEach(() => {
    if (previousTraeHome === undefined) delete process.env.TRAE_HOME;
    else process.env.TRAE_HOME = previousTraeHome;
    if (previousScale === undefined) delete process.env.BOTMUX_TIME_SCALE;
    else process.env.BOTMUX_TIME_SCALE = previousScale;
    rmSync(traeHome, { recursive: true, force: true });
  });

  it('a receipt that lands during the wait is read before any further Enter', async () => {
    const pty = ptyWithLaggingReceipt(1);
    const result = await createTraexAdapter('/bin/traex').writeInput(pty, 'hello');
    expect(result).toEqual({ submitted: true });
    expect(pty.enters()).toBe(1);
  });

  const guard = (answers: Array<string | undefined>, opts: { maxWaitMs?: number; current?: () => boolean } = {}) => {
    const phases: string[] = [];
    return {
      phases,
      guard: {
        maxWaitMs: opts.maxWaitMs ?? 5_000,
        pollMs: 500,
        current: opts.current ?? (() => true),
        blocked: async (phase: 'draft' | 'retry') => {
          phases.push(phase);
          return answers.length > 1 ? answers.shift() : answers[0];
        },
      },
    };
  };

  it('a page up before the first Enter: waits for it to go, then submits the pasted draft once', async () => {
    const pty = ptyWithLaggingReceipt(1);
    const g = guard(['question page is up', 'question page is up', undefined]);
    const result = await createTraexAdapter('/bin/traex').writeInput(pty, 'hello', { submitGuard: g.guard });
    expect(result).toEqual({ submitted: true });
    expect(pty.pasteText).toHaveBeenCalledTimes(1);
    expect(pty.enters()).toBe(1);
    expect(g.phases).toEqual(['draft', 'draft', 'draft']);
  });

  it('gives up after the wait with the reason, pressing nothing', async () => {
    const pty = ptyWithLaggingReceipt(1);
    const g = guard(['question page is up'], { maxWaitMs: 2_000 });
    const result = await createTraexAdapter('/bin/traex').writeInput(pty, 'hello', { submitGuard: g.guard });
    expect(result).toEqual({ submitted: false, failureReason: 'question page is up' });
    expect(pty.enters()).toBe(0);
  });

  it('stops waiting, pressing nothing, once the CLI it pasted into is gone', async () => {
    const pty = ptyWithLaggingReceipt(1);
    let alive = true;
    const g = guard(['question page is up'], { current: () => alive });
    const pending = createTraexAdapter('/bin/traex').writeInput(pty, 'hello', { submitGuard: g.guard });
    setTimeout(() => { alive = false; }, 12);
    expect(await pending).toEqual({ submitted: false });
    expect(pty.enters()).toBe(0);
  });

  it('a page up before a retry Enter: no further Enter, and no failure claimed for the first one', async () => {
    // No receipt yet after the first Enter; by the retry the page is up.
    const pty: PtyHandle & { sendSpecialKeys: ReturnType<typeof vi.fn> } = {
      write: vi.fn(), pasteText: vi.fn(), sendSpecialKeys: vi.fn(),
    };
    const g = guard([undefined, 'question page is up']);
    const result = await createTraexAdapter('/bin/traex').writeInput(pty, 'hello', { submitGuard: g.guard });
    expect(result).toMatchObject({ submitted: false });
    expect(result).not.toHaveProperty('failureReason');
    expect(pty.sendSpecialKeys.mock.calls.filter(([key]) => key === 'Enter')).toHaveLength(1);
    expect(g.phases[0]).toBe('draft');
    expect(g.phases.slice(1).every(phase => phase === 'retry')).toBe(true);
  });

  it('without a blocker the retry still happens when no receipt ever comes', async () => {
    const pty: PtyHandle & { sendSpecialKeys: ReturnType<typeof vi.fn> } = {
      write: vi.fn(), pasteText: vi.fn(), sendSpecialKeys: vi.fn(),
    };
    const result = await createTraexAdapter('/bin/traex').writeInput(pty, 'hello');
    expect(result).toMatchObject({ submitted: false });
    expect(pty.sendSpecialKeys.mock.calls.filter(([key]) => key === 'Enter')).toHaveLength(4);
  });
});
