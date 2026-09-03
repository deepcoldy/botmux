import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  appendFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PtyHandle } from '../src/adapters/cli/types.js';

// HISTORY_PATH is computed at module import from os.homedir() (which honors
// $HOME on POSIX), so redirect HOME to a temp dir BEFORE importing the
// adapter. BOTMUX_TIME_SCALE collapses the real-time submit waits (300ms
// settle + 3.2s poll budget) to a few ms without changing which branch the
// code takes — the same trick write-input.test.ts uses for the other
// history-verified adapters.
const SCALE = 0.05;
const home = mkdtempSync(join(tmpdir(), 'agy-home-'));
const previousHome = process.env.HOME;
const previousScale = process.env.BOTMUX_TIME_SCALE;
process.env.HOME = home;
process.env.BOTMUX_TIME_SCALE = String(SCALE);

const { createAntigravityAdapter } = await import(
  '../src/adapters/cli/antigravity.js'
);

// Choreographed real-time events, scaled by the same factor so their
// ordering against the adapter's (equally scaled) settle/budget is stable.
const SETTLE_MS = 300 * SCALE; // pre-Enter settle delay
const BUDGET_MS = 3_200 * SCALE; // in-band history poll budget
// Old code retried Enter after each 800ms poll window; the 2nd Enter would
// fire at ~SETTLE_MS + 800*SCALE. A "slow" append lands AFTER that point
// (so the old code would have double-submitted) but well inside BUDGET_MS
// (so the new code still confirms it in-band).
const OLD_FIRST_RETRY_MS = 800 * SCALE;
const SLOW_APPEND_MS = SETTLE_MS + OLD_FIRST_RETRY_MS + 25;

const HISTORY_PATH = join(home, '.gemini', 'antigravity-cli', 'history.jsonl');

/** Mirror of antigravity.ts's private `historyMarker` (kept in sync with
 *  the copy in antigravity-history.test.ts). */
function jsonEncodedPrefix(content: string): string {
  return JSON.stringify(content.slice(0, 40))
    .slice(1, -1)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
}

/** agy is Go and writes history.jsonl with encoding/json's default
 *  SetEscapeHTML(true), so `<` / `>` / `&` land as `<` / `>` /
 *  `&` on disk. The adapter's marker matches that encoding, so the
 *  fake appender must emit it too. */
function encodeDisplay(content: string): string {
  return JSON.stringify(content)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
}

function appendHistory(content: string): void {
  mkdirSync(join(home, '.gemini', 'antigravity-cli'), { recursive: true });
  appendFileSync(
    HISTORY_PATH,
    `{"display":${encodeDisplay(content)},"timestamp":${Date.now()},"workspace":"/x"}\n`,
  );
}

function resetHistory(): void {
  mkdirSync(join(home, '.gemini', 'antigravity-cli'), { recursive: true });
  writeFileSync(HISTORY_PATH, '');
}

interface FakePty {
  pty: PtyHandle;
  specialKeys: string[][];
  texts: string[];
  enterCount: () => number;
}

function makePty(enterThrows = false): FakePty {
  const specialKeys: string[][] = [];
  const texts: string[] = [];
  const pty = {
    write: () => true,
    sendText: (t: string) => {
      texts.push(t);
      return true;
    },
    sendSpecialKeys: (...keys: string[]) => {
      if (enterThrows && keys[0] === 'Enter') {
        throw new Error('tmux session gone');
      }
      specialKeys.push(keys);
      return true;
    },
  } as unknown as PtyHandle;
  return {
    pty,
    specialKeys,
    texts,
    enterCount: () => specialKeys.filter((k) => k[0] === 'Enter').length,
  };
}

describe('antigravity writeInput — single-Enter submit', () => {
  const adapter = createAntigravityAdapter('/usr/local/bin/agy');

  beforeAll(() => {
    resetHistory();
  });

  afterAll(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousScale === undefined) delete process.env.BOTMUX_TIME_SCALE;
    else process.env.BOTMUX_TIME_SCALE = previousScale;
    rmSync(home, { recursive: true, force: true });
  });

  it('slow history append (past the old 800ms retry window) still confirms with exactly one Enter', async () => {
    resetHistory();
    const fake = makePty();
    const content = '<user_message>\n慢写入验证\n</user_message>';
    // Append lands after the old code's 2nd Enter would have fired, but
    // inside the 3.2s in-band budget.
    const timer = setTimeout(() => appendHistory(content), SLOW_APPEND_MS);
    try {
      const result = await adapter.writeInput(fake.pty, content);
      expect(result).toBeUndefined();
      expect(fake.enterCount()).toBe(1);
    } finally {
      clearTimeout(timer);
    }
  });

  it('never appends within budget → submitted:false + recheck, still exactly one Enter', async () => {
    resetHistory();
    const fake = makePty();
    const content = '<user_message>\n永不确认\n</user_message>';
    const result = await adapter.writeInput(fake.pty, content);
    expect(result).toBeDefined();
    expect(result?.submitted).toBe(false);
    expect(typeof result?.recheck).toBe('function');
    expect(fake.enterCount()).toBe(1);
    // The deferred recheck closure resolves once agy finally appends.
    expect(result!.recheck!()).toBe(false);
    appendHistory(content);
    expect(result!.recheck!()).toBe(true);
  });

  it('fast history append confirms with exactly one Enter', async () => {
    resetHistory();
    const fake = makePty();
    const content = '<user_message>\n快速确认\n</user_message>';
    const timer = setTimeout(() => appendHistory(content), SETTLE_MS + 10);
    try {
      const result = await adapter.writeInput(fake.pty, content);
      expect(result).toBeUndefined();
      expect(fake.enterCount()).toBe(1);
    } finally {
      clearTimeout(timer);
    }
  });

  it('multi-line content uses M-Enter between lines and exactly one trailing Enter', async () => {
    resetHistory();
    const fake = makePty();
    const content = 'line1\nline2';
    const timer = setTimeout(() => appendHistory(content), SETTLE_MS + 10);
    try {
      const result = await adapter.writeInput(fake.pty, content);
      expect(result).toBeUndefined();
      expect(fake.specialKeys).toContainEqual(['M-Enter']);
      expect(fake.enterCount()).toBe(1);
    } finally {
      clearTimeout(timer);
    }
  });

  it('Enter send failure bails with submitted:false and no recheck', async () => {
    resetHistory();
    const fake = makePty(/* enterThrows */ true);
    const result = await adapter.writeInput(fake.pty, 'anything');
    expect(result).toEqual({ submitted: false });
  });

  it('marker present only before the baseByte snapshot does not count as submitted', async () => {
    // A line written before writeInput snapshots baseByte must not satisfy
    // the delta scan — otherwise a stale history line would mask a dropped
    // submit.
    resetHistory();
    const content = '<user_message>\n旧行不算\n</user_message>';
    appendHistory(content);
    const fake = makePty();
    const result = await adapter.writeInput(fake.pty, content);
    expect(result?.submitted).toBe(false);
    expect(typeof result?.recheck).toBe('function');
    expect(fake.enterCount()).toBe(1);
  });
});
