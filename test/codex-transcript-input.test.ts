import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCodexAdapter } from '../src/adapters/cli/codex.js';
import type { PtyHandle } from '../src/adapters/cli/types.js';
import { flushFakeTimers } from './helpers/flush-fake-timers.js';

const SID = '019dd80d-d922-7a11-8339-0208d8c5b4ee';
const MESSAGE = 'Inspect the pending change\nand run its tests.';
const OVERLAY = '/ T R A N S C R I P T / / / / / / / / / /\nPrevious conversation\n──────────────────── 100% ─\n↑/↓ to scroll   PgUp/PgDn to page   Home/End to jump\nq to quit   esc to edit prev\n';
const PREVIEW = OVERLAY.replace('esc to edit prev', 'esc/← to edit prev   → to edit next   enter to edit message');
const OVERLAY_MODERN = OVERLAY.replace('q to quit   esc to edit prev', 'q close · f3 find · esc browse prompts');
let home: string;

beforeEach(() => {
  vi.useFakeTimers();
  home = mkdtempSync(join(tmpdir(), 'codex-transcript-submit-'));
  vi.stubEnv('CODEX_HOME', home);
  vi.stubEnv('BOTMUX_TIME_SCALE', '1');
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

/** Stateful terminal: the pager drops Paste and ignores Enter (or rewinds in
 * preview); only the composer accepts new input. Receipts are independently
 * delayed, so multiple Enter presses cannot hide behind a mocked success. */
function terminal(initial = OVERLAY, options: {
  closeDelay?: number; receiptDelay?: number; hiddenDraft?: string; close?: boolean;
  closeResult?: 'false' | 'throw'; enterResult?: 'false' | 'throw';
  redrawFrames?: number; startupFrames?: number;
} = {}) {
  let overlay: string | undefined = initial || undefined;
  let draft = options.hiddenDraft ?? '';
  let redrawLeft = options.redrawFrames ?? 0;
  let startupLeft = options.startupFrames ?? 0;
  const executed: string[] = [];
  let rewinds = 0;
  const receipt = (text: string) => appendFileSync(join(home, 'history.jsonl'), `${JSON.stringify({ session_id: SID, text })}\n`);
  const enter = () => {
    if (overlay) { if (overlay.includes('to edit message')) rewinds++; return; }
    if (draft) {
      const text = draft;
      draft = '';
      executed.push(text);
      setTimeout(() => receipt(text), options.receiptDelay ?? 0);
    }
    if (options.enterResult === 'throw') throw new Error('transport acknowledgement lost');
    return options.enterResult === 'false' ? false : undefined;
  };
  const paste = (text: string) => { if (!overlay) draft += text; };
  const target: PtyHandle = {
    cliPid: 12345, expectedCodexSessionId: SID,
    write: vi.fn((data: string) => {
      if (data === 'q') {
        if (options.close !== false) setTimeout(() => { if (overlay) overlay = undefined; else draft += 'q'; }, options.closeDelay ?? 0);
        if (options.closeResult === 'throw') throw new Error('close acknowledgement lost');
        return options.closeResult === 'false' ? false : undefined;
      }
      if (data === '\r') return enter();
      if (data.startsWith('\x1b[200~') && data.endsWith('\x1b[201~')) { paste(data.slice(6, -6)); return; }
      paste(data);
    }),
    pasteText: vi.fn(paste),
    submitBracketedPaste: vi.fn(text => { paste(text); return enter(); }),
    sendSpecialKeys: vi.fn(() => enter()),
    captureInputState: vi.fn(() => {
      if (overlay) return { viewport: overlay, cursor: { x: 0, y: 0 } };
      if (startupLeft > 0) {
        startupLeft--;
        // Codex 0.166 startup: the composer is painted before its footer.
        return { viewport: '  >_ OpenAI Codex (v0.166.0)\n     /tmp/work\n\n\n› Ask Codex to do anything\n', cursor: { x: 2, y: 4 } };
      }
      if (redrawLeft > 0) {
        redrawLeft--;
        return { viewport: 'Previous conversation\n› mid-redraw residual glyphs\n\n  model · /tmp · Ready\n', cursor: { x: 27, y: 1 } };
      }
      const lines = draft.split('\n');
      return { viewport: `Previous conversation\n› ${(draft || 'Ask Codex to do anything').replace(/\n/g, '\n  ')}\n  model · /tmp · Ready\n  ? for shortcuts\n`, cursor: { x: 2 + lines.at(-1)!.length, y: lines.length } };
    }),
  };
  return { target, executed, rewinds: () => rewinds, receipt,
    draft: () => draft, setDraft: (text: string) => { draft = text; },
    redraw: (frames: number) => { redrawLeft = frames; },
    setOverlay: (text: string) => { overlay = text; } };
}
async function submit(target: PtyHandle) {
  const pending = createCodexAdapter().writeInput(target, MESSAGE);
  await flushFakeTimers();
  return pending;
}

describe('Codex transcript submission boundary', () => {
  it.each([OVERLAY, PREVIEW, OVERLAY_MODERN])('closes the native viewer before paste and executes once', async screen => {
    const t = terminal(screen);
    expect(await submit(t.target)).toMatchObject({ submitted: true, cliSessionId: SID, ownershipProven: true });
    expect(t.executed).toEqual([MESSAGE]);
    expect(t.rewinds()).toBe(0);
    expect(t.target.write).toHaveBeenCalledExactlyOnceWith('q');
    expect(t.target.submitBracketedPaste).toHaveBeenCalledExactlyOnceWith(MESSAGE);
    expect(t.target.sendSpecialKeys).not.toHaveBeenCalled();
  });

  it('writes the raw bracketed PTY frame and then Enter as a separate write', async () => {
    const t = terminal();
    delete t.target.submitBracketedPaste;
    delete t.target.pasteText;
    delete t.target.sendSpecialKeys;
    expect(await submit(t.target)).toMatchObject({ submitted: true });
    expect(t.executed).toEqual([MESSAGE]);
    expect(vi.mocked(t.target.write).mock.calls.map(([data]) => data))
      .toEqual(['q', `\x1b[200~${MESSAGE}\x1b[201~`, '\r']);
  });

  it.each(['false', 'throw'] as const)('observes an ambiguous %s close without repeating it', async closeResult => {
    const t = terminal(OVERLAY, { closeResult, closeDelay: 350 });
    expect(await submit(t.target)).toMatchObject({ submitted: true });
    expect(t.target.write).toHaveBeenCalledTimes(1);
    expect(t.executed).toEqual([MESSAGE]);
  });

  it.each([OVERLAY, OVERLAY_MODERN])('preserves a draft hidden behind the viewer without submitting or appending', async screen => {
    const t = terminal(screen, { hiddenDraft: 'human draft' });
    expect(await submit(t.target)).toMatchObject({ submitted: false, failureReason: expect.any(String) });
    expect(t.draft()).toBe('human draft');
    expect(t.executed).toEqual([]);
    expect(t.target.pasteText).not.toHaveBeenCalled();
    expect(t.target.submitBracketedPaste).not.toHaveBeenCalled();
    expect(t.target.sendSpecialKeys).not.toHaveBeenCalled();
  });

  it('stops after a bounded close wait and never pastes into a stuck viewer', async () => {
    const t = terminal(OVERLAY, { close: false });
    expect(await submit(t.target)).toMatchObject({ submitted: false, failureReason: expect.any(String) });
    expect(t.target.write).toHaveBeenCalledTimes(1);
    expect(t.target.pasteText).not.toHaveBeenCalled();
    expect(t.target.submitBracketedPaste).not.toHaveBeenCalled();
    expect(t.target.sendSpecialKeys).not.toHaveBeenCalled();
  });

  it.each([OVERLAY, OVERLAY_MODERN])('waits through transient draft frames during close and submits once', async screen => {
    const t = terminal(screen, { redrawFrames: 2 });
    expect(await submit(t.target)).toMatchObject({ submitted: true, ownershipProven: true });
    expect(t.executed).toEqual([MESSAGE]);
    expect(t.target.write).toHaveBeenCalledExactlyOnceWith('q');
    expect(t.target.submitBracketedPaste).toHaveBeenCalledExactlyOnceWith(MESSAGE);
    expect(t.target.sendSpecialKeys).not.toHaveBeenCalled();
  });

  it('only observes a persistent draft until close settles and leaves it intact', async () => {
    const t = terminal(OVERLAY_MODERN, { hiddenDraft: 'human draft' });
    let settled = false;
    const pending = createCodexAdapter().writeInput(t.target, MESSAGE).then(result => { settled = true; return result; });
    await flushFakeTimers(200);
    expect(settled).toBe(false);
    expect(t.target.submitBracketedPaste).not.toHaveBeenCalled();
    await flushFakeTimers();
    expect(await pending).toMatchObject({ submitted: false, failureReason: expect.any(String) });
    expect(t.draft()).toBe('human draft');
    expect(t.executed).toEqual([]);
    expect(t.target.write).toHaveBeenCalledExactlyOnceWith('q');
    expect(t.target.submitBracketedPaste).not.toHaveBeenCalled();
    expect(t.target.sendSpecialKeys).not.toHaveBeenCalled();
  });

  it('rejects an ordinary draft immediately without waiting for it to clear', async () => {
    const t = terminal('', { hiddenDraft: 'human draft' });
    let result: unknown;
    const pending = createCodexAdapter().writeInput(t.target, MESSAGE).then(value => { result = value; });
    setTimeout(() => t.setDraft(''), 500);
    await flushFakeTimers(200);
    expect(result).toMatchObject({ submitted: false, failureReason: expect.any(String) });
    await pending;
    await flushFakeTimers();
    expect(t.target.write).not.toHaveBeenCalled();
    expect(t.target.submitBracketedPaste).not.toHaveBeenCalled();
    expect(t.executed).toEqual([]);
  });

  it('waits while startup paints the composer without its footer, then submits once', async () => {
    const t = terminal('', { startupFrames: 20 });
    expect(await submit(t.target)).toMatchObject({ submitted: true, ownershipProven: true });
    expect(t.executed).toEqual([MESSAGE]);
    expect(t.target.write).not.toHaveBeenCalled();
    expect(t.target.submitBracketedPaste).toHaveBeenCalledExactlyOnceWith(MESSAGE);
  });

  it('does not take a draft-looking frame inside a redraw for a draft', async () => {
    const t = terminal('', { startupFrames: 5, redrawFrames: 3 });
    expect(await submit(t.target)).toMatchObject({ submitted: true });
    expect(t.executed).toEqual([MESSAGE]);
    expect(t.target.submitBracketedPaste).toHaveBeenCalledExactlyOnceWith(MESSAGE);
  });

  it('refuses a draft that persists after a redraw and leaves it intact', async () => {
    const t = terminal('', { startupFrames: 3, hiddenDraft: 'human draft' });
    let result: unknown;
    const pending = createCodexAdapter().writeInput(t.target, MESSAGE).then(value => { result = value; });
    await flushFakeTimers(400);
    expect(result).toBeUndefined();
    await flushFakeTimers(1000);
    expect(result).toMatchObject({ submitted: false, failureReason: expect.stringContaining('existing draft') });
    await pending;
    expect(t.draft()).toBe('human draft');
    expect(t.target.write).not.toHaveBeenCalled();
    expect(t.target.submitBracketedPaste).not.toHaveBeenCalled();
    expect(t.executed).toEqual([]);
  });

  it('refuses an input box that never settles only after a bounded wait', async () => {
    const t = terminal('', { startupFrames: Number.POSITIVE_INFINITY });
    let result: unknown;
    const pending = createCodexAdapter().writeInput(t.target, MESSAGE).then(value => { result = value; });
    await flushFakeTimers(1000);
    expect(result).toBeUndefined();
    await flushFakeTimers(6000);
    expect(result).toMatchObject({ submitted: false, failureReason: expect.stringContaining('not at an empty input box') });
    await pending;
    expect(t.target.write).not.toHaveBeenCalled();
    expect(t.target.submitBracketedPaste).not.toHaveBeenCalled();
    expect(t.executed).toEqual([]);
  });

  it('aborts if the process is replaced while the input box settles', async () => {
    const t = terminal('', { startupFrames: Number.POSITIVE_INFINITY });
    setTimeout(() => { t.target.cliPid = 67890; }, 100);
    let result: unknown;
    const pending = createCodexAdapter().writeInput(t.target, MESSAGE).then(value => { result = value; });
    await flushFakeTimers(300);
    expect(result).toMatchObject({ submitted: false, failureReason: expect.stringContaining('process changed') });
    await pending;
    expect(t.target.submitBracketedPaste).not.toHaveBeenCalled();
    expect(t.executed).toEqual([]);
  });

  it('lets the write after the opening check wait out a draft-looking redraw frame', async () => {
    const t = terminal('');
    const adapter = createCodexAdapter();
    expect(await adapter.settleInputBox!(t.target)).toBeUndefined();
    t.redraw(3);
    expect(await submit(t.target)).toMatchObject({ submitted: true });
    expect(t.executed).toEqual([MESSAGE]);
    expect(t.target.submitBracketedPaste).toHaveBeenCalledExactlyOnceWith(MESSAGE);
  });

  it('still takes a draft-looking first frame as final without a fresh opening check', async () => {
    const t = terminal('');
    const adapter = createCodexAdapter();
    expect(await adapter.settleInputBox!(t.target)).toBeUndefined();
    await flushFakeTimers(1500);
    t.redraw(3);
    expect(await submit(t.target)).toMatchObject({ submitted: false, failureReason: expect.stringContaining('existing draft') });
    expect(t.target.submitBracketedPaste).not.toHaveBeenCalled();
    expect(t.executed).toEqual([]);
  });

  it('refuses a draft typed right after the opening check and leaves it intact', async () => {
    const t = terminal('');
    const adapter = createCodexAdapter();
    expect(await adapter.settleInputBox!(t.target)).toBeUndefined();
    t.setDraft('human draft');
    let result: unknown;
    const pending = adapter.writeInput(t.target, MESSAGE).then(value => { result = value; });
    await flushFakeTimers(1000);
    expect(result).toMatchObject({ submitted: false, failureReason: expect.stringContaining('existing draft') });
    await pending;
    expect(t.draft()).toBe('human draft');
    expect(t.target.submitBracketedPaste).not.toHaveBeenCalled();
    expect(t.executed).toEqual([]);
  });

  it('does not carry the opening check over to a replaced process', async () => {
    const t = terminal('');
    const adapter = createCodexAdapter();
    expect(await adapter.settleInputBox!(t.target)).toBeUndefined();
    t.target.cliPid = 67890;
    t.redraw(3);
    expect(await submit(t.target)).toMatchObject({ submitted: false, failureReason: expect.stringContaining('existing draft') });
    expect(t.target.submitBracketedPaste).not.toHaveBeenCalled();
    expect(t.executed).toEqual([]);
  });

  it('restarts the draft wait when a redraw frame interrupts a draft-looking one', async () => {
    const t = terminal('');
    const settledBox = t.target.captureInputState!;
    const startup = { viewport: '  >_ OpenAI Codex (v0.166.0)\n     /tmp/work\n\n\n› Ask Codex to do anything\n', cursor: { x: 2, y: 4 } };
    const residual = { viewport: 'Previous conversation\n› mid-redraw residual glyphs\n\n  model · /tmp · Ready\n', cursor: { x: 27, y: 1 } };
    // One capture per 50ms: each draft-looking stretch stays under the draft
    // wait, the two together do not.
    const frames = [startup, ...Array(8).fill(residual), startup, ...Array(8).fill(residual)];
    t.target.captureInputState = vi.fn(() => frames.shift() ?? settledBox());
    expect(await submit(t.target)).toMatchObject({ submitted: true });
    expect(t.executed).toEqual([MESSAGE]);
    expect(t.target.submitBracketedPaste).toHaveBeenCalledExactlyOnceWith(MESSAGE);
  });

  it('judges the box ready only at an initialized empty composer or a viewer it can close', () => {
    const ready = createCodexAdapter().inputBoxReady!;
    const composer = (text: string, x: number) => ({ viewport: `Previous conversation\n› ${text}\n  model · /tmp · Ready\n  ? for shortcuts\n`, cursor: { x, y: 1 } });
    expect(ready(composer('Ask Codex to do anything', 2))).toBe(true);
    expect(ready(composer('human draft', 13))).toBe(false);
    expect(ready({ viewport: '  >_ OpenAI Codex (v0.166.0)\n     /tmp/work\n\n\n› Ask Codex to do anything\n', cursor: { x: 2, y: 4 } })).toBe(false);
    expect(ready({ viewport: OVERLAY, cursor: { x: 0, y: 0 } })).toBe(true);
    expect(ready({ viewport: OVERLAY_MODERN, cursor: { x: 0, y: 0 } })).toBe(true);
    expect(ready({ viewport: OVERLAY.replace('q to quit', 'x to quit'), cursor: { x: 0, y: 0 } })).toBe(false);
  });

  it('does not guess a remapped close key', async () => {
    const t = terminal(OVERLAY.replace('q to quit', 'x to quit'));
    expect(await submit(t.target)).toMatchObject({ submitted: false, failureReason: expect.any(String) });
    expect(t.target.write).not.toHaveBeenCalled();
    expect(t.target.pasteText).not.toHaveBeenCalled();
    expect(t.target.submitBracketedPaste).not.toHaveBeenCalled();
  });

  it.each([
    OVERLAY_MODERN.replace(' · esc browse prompts', ''),
    OVERLAY_MODERN.replace('to scroll', 'unknown navigation'),
    OVERLAY_MODERN.replace('/ T R A N S C R I P T', '/ ANOTHER VIEW'),
    OVERLAY_MODERN.replace('q close', 'x close'),
  ])('rejects an incomplete or unsupported modern viewer without writing', async screen => {
    const t = terminal(screen);
    expect(await submit(t.target)).toMatchObject({ submitted: false, failureReason: expect.any(String) });
    expect(t.target.write).not.toHaveBeenCalled();
    expect(t.target.submitBracketedPaste).not.toHaveBeenCalled();
    expect(t.target.sendSpecialKeys).not.toHaveBeenCalled();
    expect(t.executed).toEqual([]);
  });

  it('aborts if the process is replaced while the close is settling', async () => {
    const t = terminal(OVERLAY, { closeDelay: 500 });
    setTimeout(() => { t.target.cliPid = 67890; }, 100);
    expect(await submit(t.target)).toMatchObject({ submitted: false });
    expect(t.target.pasteText).not.toHaveBeenCalled();
    expect(t.target.submitBracketedPaste).not.toHaveBeenCalled();
    expect(t.executed).toEqual([]);
  });

  it('never treats a viewer quoted in conversation as the current surface', async () => {
    const t = terminal('');
    const capture = t.target.captureInputState!;
    t.target.captureInputState = () => {
      const state = capture()!;
      const prefix = `Discuss this screenshot:\n${OVERLAY}\n`;
      return { viewport: prefix + state.viewport, cursor: { x: state.cursor.x, y: state.cursor.y + prefix.split('\n').length - 1 } };
    };
    expect(await submit(t.target)).toMatchObject({ submitted: true });
    expect(t.target.write).not.toHaveBeenCalled();
    expect(t.executed).toEqual([MESSAGE]);
  });

  it('waits for a delayed receipt without submitting a newer human draft', async () => {
    const t = terminal('', { receiptDelay: 2100 });
    setTimeout(() => t.setDraft('new human draft'), 500);
    expect(await submit(t.target)).toMatchObject({ submitted: true });
    expect(t.executed).toEqual([MESSAGE]);
    expect(t.draft()).toBe('new human draft');
    expect(t.target.submitBracketedPaste).toHaveBeenCalledTimes(1);
  });

  it.each(['false', 'throw'] as const)('keeps the exact receipt after Enter returns %s', async enterResult => {
    const t = terminal('', { enterResult, receiptDelay: 1000 });
    expect(await submit(t.target)).toMatchObject({ submitted: true });
    expect(t.target.submitBracketedPaste).toHaveBeenCalledTimes(1);
    expect(t.executed).toEqual([MESSAGE]);
  });

  it('deferred rechecks only read receipts; neither timeout nor recheck can execute again', async () => {
    const t = terminal('', { receiptDelay: 10_000 });
    const pending = createCodexAdapter().writeInput(t.target, MESSAGE);
    await flushFakeTimers(4000);
    const result = await pending;
    expect(result).toMatchObject({ submitted: false });
    expect(await result?.recheck?.()).toBe(false);
    t.setDraft('next draft');
    await flushFakeTimers(10_000);
    expect(await result?.recheck?.()).toMatchObject({ submitted: true, cliSessionId: SID });
    expect(await result?.recheck?.()).toMatchObject({ submitted: true });
    expect(t.executed).toEqual([MESSAGE]);
    expect(t.target.submitBracketedPaste).toHaveBeenCalledTimes(1);
    expect(t.draft()).toBe('next draft');
  });

  it('does not confirm a backtrack opened after the single submit', async () => {
    const t = terminal('', { receiptDelay: 1500 });
    setTimeout(() => t.setOverlay(PREVIEW), 500);
    expect(await submit(t.target)).toMatchObject({ submitted: true });
    expect(t.rewinds()).toBe(0);
    expect(t.executed).toEqual([MESSAGE]);
  });
  it('submits small, multiline Markdown and long pastes as one frame plus a separate Enter, without screen-text inference', async () => {
    for (const message of ['First line  \nSecond line', 'a'.repeat(2000), '中文😀'.repeat(600)]) {
      const t = terminal('');
      delete t.target.submitBracketedPaste;
      const pending = createCodexAdapter().writeInput(t.target, message);
      await flushFakeTimers();
      expect(await pending).toMatchObject({ submitted: true });
      expect(t.executed).toEqual([message]);
      expect(vi.mocked(t.target.write).mock.calls.map(([data]) => data)).toEqual([`\x1b[200~${message}\x1b[201~`, '\r']);
      expect(t.target.sendSpecialKeys).not.toHaveBeenCalled();
    }
  });

  it('does not append the next input to a partially delivered paste', async () => {
    const t = terminal('');
    const submitFrame = t.target.submitBracketedPaste!;
    t.target.submitBracketedPaste = vi.fn(text => { t.setDraft(text.slice(0, 15)); throw new Error('partial delivery'); });
    expect(await submit(t.target)).toMatchObject({ submitted: false });
    t.target.submitBracketedPaste = vi.fn(text => submitFrame(text));
    expect(await submit(t.target)).toMatchObject({ submitted: false, failureReason: expect.any(String) });
    expect(t.draft()).toBe(MESSAGE.slice(0, 15));
    expect(t.target.submitBracketedPaste).not.toHaveBeenCalled();
    expect(t.executed).toEqual([]);
  });

  it('does not repeat a delayed close across failed submissions', async () => {
    const t = terminal(OVERLAY, { closeResult: 'false', closeDelay: 2100 });
    const adapter = createCodexAdapter();
    const first = adapter.writeInput(t.target, MESSAGE);
    await flushFakeTimers(2000);
    expect(await first).toMatchObject({ submitted: false });
    const second = adapter.writeInput(t.target, MESSAGE);
    await flushFakeTimers();
    expect(await second).toMatchObject({ submitted: true });
    expect(t.target.write).toHaveBeenCalledExactlyOnceWith('q');
    expect(t.draft()).toBe('');
    expect(t.executed).toEqual([MESSAGE]);
  });

  it.each(['unavailable', 'throws'] as const)('does not write when snapshot %s', async mode => {
    const t = terminal();
    t.target.captureInputState = () => { if (mode === 'throws') throw new Error('closed pane'); return null; };
    expect(await submit(t.target)).toMatchObject({ submitted: false });
    expect(t.target.write).not.toHaveBeenCalled();
    expect(t.target.pasteText).not.toHaveBeenCalled();
    expect(t.target.submitBracketedPaste).not.toHaveBeenCalled();
  });

  it('recovers a newly opened viewer for the next distinct dispatch', async () => {
    const t = terminal();
    expect(await submit(t.target)).toMatchObject({ submitted: true });
    t.setOverlay(OVERLAY);
    expect(await submit(t.target)).toMatchObject({ submitted: true });
    expect(t.executed).toEqual([MESSAGE, MESSAGE]);
    expect(t.target.write).toHaveBeenCalledTimes(2);
    expect(t.target.submitBracketedPaste).toHaveBeenCalledTimes(2);
  });

});
