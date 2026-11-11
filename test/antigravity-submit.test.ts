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
import { delay } from '../src/utils/timing.js';

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

function makePty(opts: { enterThrows?: boolean; onEnter?: () => void } = {}): FakePty {
  const specialKeys: string[][] = [];
  const texts: string[] = [];
  const pty = {
    write: () => true,
    sendText: (t: string) => {
      texts.push(t);
      return true;
    },
    sendSpecialKeys: (...keys: string[]) => {
      if (opts.enterThrows && keys[0] === 'Enter') {
        throw new Error('tmux session gone');
      }
      specialKeys.push(keys);
      // agy appends history in response to Enter, after writeInput's baseByte
      // snapshot. Drive the fake the same way — a wall-clock setTimeout from
      // test start races the scaled poll budget (bun-test: the 80ms "slow"
      // timer slipped past ~160ms and writeInput returned submitted:false).
      if (keys[0] === 'Enter') opts.onEnter?.();
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
    const content = '<user_message>\n慢写入验证\n</user_message>';
    // After Enter, wait past the old per-attempt retry on the adapter's own
    // clock (`delay(800)`), then append. That is still well inside the
    // 32×delay(100) in-band budget, so a revert to "retry Enter every 800ms"
    // would double-submit while this path still confirms with one Enter.
    const fake = makePty({
      onEnter: () => { void delay(800).then(() => appendHistory(content)); },
    });
    const result = await adapter.writeInput(fake.pty, content);
    expect(result).toBeUndefined();
    expect(fake.enterCount()).toBe(1);
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
    const content = '<user_message>\n快速确认\n</user_message>';
    const fake = makePty({ onEnter: () => appendHistory(content) });
    const result = await adapter.writeInput(fake.pty, content);
    expect(result).toBeUndefined();
    expect(fake.enterCount()).toBe(1);
  });

  it('multi-line content uses M-Enter between lines and exactly one trailing Enter', async () => {
    resetHistory();
    const content = 'line1\nline2';
    const fake = makePty({ onEnter: () => appendHistory(content) });
    const result = await adapter.writeInput(fake.pty, content);
    expect(result).toBeUndefined();
    expect(fake.specialKeys).toContainEqual(['M-Enter']);
    expect(fake.enterCount()).toBe(1);
  });

  it('Enter send failure bails with submitted:false and no recheck', async () => {
    resetHistory();
    const fake = makePty({ enterThrows: true });
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

  /** Build through the actual launch contract so capability is tied to this adapter instance. */
  function adapterForVersion(cliVersion?: string) {
    const selected = createAntigravityAdapter('/usr/local/bin/agy');
    selected.buildArgs({ sessionId: 'agy-paste-test', resume: false, reattach: false, cliVersion });
    return selected;
  }

  it('submits long modern input as one framed PTY write with one trailing Enter', async () => {
    resetHistory();
    const selected = adapterForVersion('1.5.4');
    const content = '<user_message>\n中文🙂 input\n\n' + 'padding\n'.repeat(1000) + '</user_message>';
    const writes: string[] = [];
    const fake = makePty();
    fake.pty.write = data => { writes.push(data); appendHistory(content); return true; };
    await selected.writeInput(fake.pty, content);
    expect(writes).toEqual(['\x1b[200~' + content + '\x1b[201~\r']);
    expect(fake.texts).toEqual([]);
    expect(fake.specialKeys).toEqual([]);
  });

  it('uses an atomic backend paste+submit capability without sending another Enter', async () => {
    resetHistory();
    const content = 'atomic\n中文\n';
    const calls: string[] = [];
    const fake = makePty();
    fake.pty.submitBracketedPaste = text => { calls.push(text); appendHistory(text); return true; };
    fake.pty.write = () => { throw new Error('unexpected raw write'); };
    await adapterForVersion('1.5.4').writeInput(fake.pty, content);
    expect(calls).toEqual([content]);
    expect(fake.specialKeys).toEqual([]);
    expect(fake.texts).toEqual([]);
  });

  for (const version of [undefined, 'unknown', '1.5.3', '1.5.4-beta.1']) {
    it(`retains the legacy soft-newline path for version ${version}`, async () => {
      resetHistory();
      const content = 'legacy\n中文';
      const fake = makePty({ onEnter: () => appendHistory(content) });
      let atomicCalls = 0;
      fake.pty.submitBracketedPaste = () => { atomicCalls++; return true; };
      await adapterForVersion(version).writeInput(fake.pty, content);
      expect(fake.texts).toEqual(['legacy', '中文']);
      expect(fake.specialKeys).toEqual([['M-Enter'], ['Enter']]);
      expect(atomicCalls).toBe(0);
    });
  }

  for (const failure of ['false', 'throw'] as const) {
    it(`does not replay or switch input methods after an ambiguous modern write: ${failure}`, async () => {
      resetHistory();
      const content = 'ambiguous\nmessage';
      const fake = makePty();
      let calls = 0;
      fake.pty.submitBracketedPaste = () => {
        calls++;
        if (failure === 'throw') throw new Error('acknowledgement lost');
        return false;
      };
      const result = await adapterForVersion('1.5.4').writeInput(fake.pty, content);
      expect(result?.submitted).toBe(false);
      expect(calls).toBe(1);
      expect(fake.texts).toEqual([]);
      expect(fake.specialKeys).toEqual([]);
      appendHistory(content);
      expect(result?.recheck?.()).toBe(true);
    });
  }

  it('accepts a late receipt after a modern write returned false, without retrying', async () => {
    resetHistory();
    const content = 'late paste receipt';
    let calls = 0;
    const fake = makePty();
    fake.pty.submitBracketedPaste = () => { calls++; void delay(800).then(() => appendHistory(content)); return false; };
    expect(await adapterForVersion('1.5.4').writeInput(fake.pty, content)).toBeUndefined();
    expect(calls).toBe(1);
    expect(fake.specialKeys).toEqual([]);
  });

  it('normalizes pasted CRLF and refuses ESC before any terminal write', async () => {
    resetHistory();
    const selected = adapterForVersion('1.5.4');
    const writes: string[] = [];
    const fake = makePty();
    fake.pty.submitBracketedPaste = text => { writes.push(text); appendHistory(text); return true; };
    await selected.writeInput(fake.pty, 'one\r\ntwo\rthree');
    expect(writes).toEqual(['one\ntwo\nthree']);
    const blocked = await selected.writeInput(fake.pty, 'payload\x1b[201~\r/clear');
    expect(blocked?.submitted).toBe(false);
    expect(writes).toHaveLength(1);
  });

  it('keeps version selection local to each launch and resets it on unknown launches', async () => {
    resetHistory();
    const content = 'one\ntwo';
    const selected = adapterForVersion('1.5.4');
    selected.buildArgs({ sessionId: 'agy-new-generation', resume: true, cliVersion: 'unknown' });
    const fake = makePty({ onEnter: () => appendHistory(content) });
    await selected.writeInput(fake.pty, content);
    expect(fake.specialKeys).toEqual([['M-Enter'], ['Enter']]);
  });

  it('does not apply an upgraded installation version to a surviving older pane', async () => {
    resetHistory();
    const selected = adapterForVersion('1.5.4');
    selected.buildArgs({ sessionId: 'agy-existing-pane', resume: true, reattach: true, cliVersion: '1.5.4' });
    const content = 'surviving\nolder CLI';
    const fake = makePty({ onEnter: () => appendHistory(content) });
    await selected.writeInput(fake.pty, content);
    expect(fake.specialKeys).toEqual([['M-Enter'], ['Enter']]);
  });
});
