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

  it('holds post-submit startup grace against premature +1s idle until transcript grows, screen interrupts, or grace expires', async () => {
    resetHistory();
    const convId = '11111111-2222-3333-4444-555555555555';
    const logsDir = join(home, '.gemini', 'antigravity-cli', 'brain', convId, '.system_generated', 'logs');
    mkdirSync(logsDir, { recursive: true });
    const transcriptPath = join(logsDir, 'transcript_full.jsonl');
    writeFileSync(transcriptPath, '{"type":"USER_INPUT","status":"DONE"}\n{"type":"PLANNER_RESPONSE","status":"DONE","content":"ready"}\n');

    const selected = adapterForVersion('1.5.4');
    const content = 'run long deployment task';
    const fake = makePty();
    fake.pty.submitBracketedPaste = text => {
      mkdirSync(join(home, '.gemini', 'antigravity-cli'), { recursive: true });
      appendFileSync(
        HISTORY_PATH,
        `{"display":${encodeDisplay(text)},"timestamp":${Date.now()},"workspace":"/x","conversationId":"${convId}"}\n`,
      );
      return true;
    };
    await selected.writeInput(fake.pty, content);

    const idleComposerScreen = [
      '────────────────────────',
      '>',
      '────────────────────────',
      '? for shortcuts                                          accept-edits · Gemini 3.8 Flash · high',
    ].join('\n');

    // Immediately after submit (simulating the worker's +1.0s post-submit probe before agy flushes
    // USER_INPUT to transcript_full.jsonl or before cliSessionId is bound), session must stay busy.
    expect(selected.isSessionBusy!({ cliSessionId: undefined, getCurrentScreen: () => idleComposerScreen })).toBe(true);
    expect(selected.isSessionBusy!({ cliSessionId: convId, getCurrentScreen: () => idleComposerScreen })).toBe(true);

    // Once transcript_full.jsonl grows with a completed turn and the composer is idle, grace clears immediately.
    appendFileSync(transcriptPath, '{"type":"USER_INPUT","status":"DONE"}\n{"type":"PLANNER_RESPONSE","status":"DONE","content":"done"}\n');
    expect(selected.isSessionBusy!({ cliSessionId: convId, getCurrentScreen: () => idleComposerScreen })).toBe(false);

    // Re-submit and verify an explicit native error / interrupted screen releases grace immediately.
    await selected.writeInput(fake.pty, 'second submit hitting immediate error');
    const errorScreen = '⚠ Request failed. Please try again.\nError ID: err-grace\n────────────────────────\n>\n────────────────────────\n';
    expect(selected.isSessionBusy!({ cliSessionId: undefined, getCurrentScreen: () => errorScreen })).toBe(false);

    // Re-submit and verify grace expires cleanly after scaled 10s (10_000 * 0.05 = 500ms).
    await selected.writeInput(fake.pty, 'third submit timing out grace');
    expect(selected.isSessionBusy!({ cliSessionId: undefined, getCurrentScreen: () => idleComposerScreen })).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 560));
    expect(selected.isSessionBusy!({ cliSessionId: undefined, getCurrentScreen: () => idleComposerScreen })).toBe(false);
  });

  describe('post-submit busy grace baselines', () => {
    const idleScreen = [
      '● previous reply',
      '────────────────────────',
      '>',
      '────────────────────────',
      '? for shortcuts                                          accept-edits · Gemini 3.8 Flash · high',
    ].join('\n');
    const finishedTurn = '{"type":"USER_INPUT","status":"DONE"}\n{"type":"PLANNER_RESPONSE","status":"DONE","content":"done"}\n';

    function transcriptOf(convId: string): string {
      const dir = join(home, '.gemini', 'antigravity-cli', 'brain', convId, '.system_generated', 'logs');
      mkdirSync(dir, { recursive: true });
      return join(dir, 'transcript_full.jsonl');
    }

    function nativeLogOf(sessionId: string): string {
      return join(home, '.gemini', 'antigravity-cli', 'botmux', `${encodeURIComponent(sessionId)}.log`);
    }

    /** Fresh launch: agy is writing its --log-file but has streamed no conversation yet. */
    function freshLaunch(sessionId: string, convId: string) {
      const selected = createAntigravityAdapter('/usr/local/bin/agy');
      selected.buildArgs({ sessionId, resume: false, reattach: false, cliVersion: '1.5.4' });
      const log = nativeLogOf(sessionId);
      writeFileSync(log, 'agy starting\n');
      const fake = makePty();
      fake.pty.submitBracketedPaste = text => {
        appendHistory(text);
        appendFileSync(log, `Streaming conversation ${convId}\n`);
        return true;
      };
      return { selected, fake };
    }

    it('releases a fresh conversation whose first turn already finished before the first probe', async () => {
      resetHistory();
      const convId = 'aaaaaaaa-0000-4000-8000-000000000001';
      const { selected, fake } = freshLaunch('agy-grace-fresh-finished', convId);
      expect(await selected.writeInput(fake.pty, 'quick question')).toEqual({ submitted: true, cliSessionId: convId });

      // Before agy creates the transcript, the grace still holds the turn busy.
      expect(selected.isSessionBusy!({ cliSessionId: convId, getCurrentScreen: () => idleScreen })).toBe(true);
      // agy creates the transcript and finishes the whole turn before the worker probes again.
      writeFileSync(transcriptOf(convId), finishedTurn);
      expect(selected.isSessionBusy!({ cliSessionId: convId, getCurrentScreen: () => idleScreen })).toBe(false);
    });

    it('releases a conversation started by /new in a resumed session whose first turn already finished before the first probe', async () => {
      resetHistory();
      const oldId = 'aaaaaaaa-0000-4000-8000-000000000006';
      const newId = 'aaaaaaaa-0000-4000-8000-000000000007';
      writeFileSync(transcriptOf(oldId), finishedTurn);
      const selected = createAntigravityAdapter('/usr/local/bin/agy');
      selected.buildArgs({ sessionId: 'agy-grace-new', resume: true, resumeSessionId: oldId, reattach: false, cliVersion: '1.5.4' });
      // agy streamed the resumed conversation, then /new switched to one with no transcript yet.
      writeFileSync(nativeLogOf('agy-grace-new'), `Streaming conversation ${oldId}\nStreaming conversation ${newId}\n`);
      const fake = makePty();
      fake.pty.submitBracketedPaste = text => { appendHistory(text); return true; };
      expect(await selected.writeInput(fake.pty, 'first turn after new')).toEqual({ submitted: true, cliSessionId: newId });
      writeFileSync(transcriptOf(newId), finishedTurn);
      expect(selected.isSessionBusy!({ cliSessionId: newId, getCurrentScreen: () => idleScreen })).toBe(false);
    });

    it('keeps a fresh conversation busy until its new transcript records the USER_INPUT', async () => {
      resetHistory();
      const convId = 'aaaaaaaa-0000-4000-8000-000000000002';
      const { selected, fake } = freshLaunch('agy-grace-fresh-pending', convId);
      await selected.writeInput(fake.pty, 'pending question');
      const transcript = transcriptOf(convId);
      writeFileSync(transcript, '{"type":"CHECKPOINT","status":"DONE"}\n');
      expect(selected.isSessionBusy!({ cliSessionId: convId, getCurrentScreen: () => idleScreen })).toBe(true);
      // More non-input records are not the submit being taken either, even when
      // their text mentions one.
      appendFileSync(transcript, '{"type":"CHECKPOINT","status":"DONE","content":"waiting for USER_INPUT"}\n');
      expect(selected.isSessionBusy!({ cliSessionId: convId, getCurrentScreen: () => idleScreen })).toBe(true);
      appendFileSync(transcript, finishedTurn);
      expect(selected.isSessionBusy!({ cliSessionId: convId, getCurrentScreen: () => idleScreen })).toBe(false);
    });

    it('takes the pre-submit baseline from an id learned on an earlier probe', async () => {
      resetHistory();
      const convId = 'aaaaaaaa-0000-4000-8000-000000000003';
      const transcript = transcriptOf(convId);
      writeFileSync(transcript, finishedTurn);
      const selected = adapterForVersion('1.5.4');
      // The adapter itself cannot resolve the conversation (no native log, no pid);
      // the worker's probe tells it.
      expect(selected.isSessionBusy!({ cliSessionId: convId, getCurrentScreen: () => idleScreen })).toBe(false);
      const fake = makePty();
      fake.pty.submitBracketedPaste = text => { appendHistory(text); return true; };
      await selected.writeInput(fake.pty, 'second turn answered at once');
      appendFileSync(transcript, finishedTurn);
      expect(selected.isSessionBusy!({ cliSessionId: convId, getCurrentScreen: () => idleScreen })).toBe(false);
    });

    it('takes the pre-submit baseline from the resumed conversation id', async () => {
      resetHistory();
      const convId = 'aaaaaaaa-0000-4000-8000-000000000004';
      const transcript = transcriptOf(convId);
      writeFileSync(transcript, finishedTurn);
      const selected = createAntigravityAdapter('/usr/local/bin/agy');
      selected.buildArgs({ sessionId: 'agy-grace-resume', resume: true, resumeSessionId: convId, reattach: false, cliVersion: '1.5.4' });
      const fake = makePty();
      fake.pty.submitBracketedPaste = text => { appendHistory(text); return true; };
      await selected.writeInput(fake.pty, 'resumed turn answered at once');
      appendFileSync(transcript, finishedTurn);
      expect(selected.isSessionBusy!({ cliSessionId: convId, getCurrentScreen: () => idleScreen })).toBe(false);
    });

    it('hands back to the regular verdict when the transcript already shows the turn running', async () => {
      resetHistory();
      const convId = 'aaaaaaaa-0000-4000-8000-000000000005';
      const transcript = transcriptOf(convId);
      writeFileSync(transcript, finishedTurn);
      const selected = adapterForVersion('1.5.4');
      const fake = makePty();
      fake.pty.submitBracketedPaste = text => { appendHistory(text); return true; };
      await selected.writeInput(fake.pty, 'turn with unknown id at submit');
      appendFileSync(transcript, '{"type":"USER_INPUT","status":"DONE"}\n');
      // Regular verdict: a running transcript yields to an empty composer on screen
      // (cancelled turn), which the grace must not override.
      expect(selected.isSessionBusy!({ cliSessionId: convId, getCurrentScreen: () => idleScreen })).toBe(false);
    });

    it('stays busy during the grace when no viewport can be read', async () => {
      resetHistory();
      const selected = adapterForVersion('1.5.4');
      const fake = makePty();
      fake.pty.submitBracketedPaste = text => { appendHistory(text); return true; };
      await selected.writeInput(fake.pty, 'no viewport');
      expect(selected.isSessionBusy!({ cliSessionId: undefined })).toBe(true);
      expect(selected.isSessionBusy!({ cliSessionId: undefined, getCurrentScreen: () => { throw new Error('pane gone'); } })).toBe(true);
    });
  });
});
