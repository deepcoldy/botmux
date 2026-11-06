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
} = {}) {
  let overlay: string | undefined = initial || undefined;
  let draft = options.hiddenDraft ?? '';
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
      if (data.startsWith('\x1b[200~') && data.endsWith('\x1b[201~\r')) {
        paste(data.slice(6, -7)); return enter();
      }
      paste(data);
    }),
    pasteText: vi.fn(paste),
    submitBracketedPaste: vi.fn(text => { paste(text); return enter(); }),
    sendSpecialKeys: vi.fn(() => enter()),
    captureInputState: vi.fn(() => {
      if (overlay) return { viewport: overlay, cursor: { x: 0, y: 0 } };
      const lines = draft.split('\n');
      return { viewport: `Previous conversation\n› ${(draft || 'Ask Codex to do anything').replace(/\n/g, '\n  ')}\n  model · /tmp · Ready\n  ? for shortcuts\n`, cursor: { x: 2 + lines.at(-1)!.length, y: lines.length } };
    }),
  };
  return { target, executed, rewinds: () => rewinds, receipt,
    draft: () => draft, setDraft: (text: string) => { draft = text; },
    setOverlay: (text: string) => { overlay = text; } };
}
async function submit(target: PtyHandle) {
  const pending = createCodexAdapter().writeInput(target, MESSAGE);
  await flushFakeTimers();
  return pending;
}

describe('Codex transcript submission boundary', () => {
  it.each([OVERLAY, PREVIEW])('closes the native viewer before paste and executes once', async screen => {
    const t = terminal(screen);
    expect(await submit(t.target)).toMatchObject({ submitted: true, cliSessionId: SID, ownershipProven: true });
    expect(t.executed).toEqual([MESSAGE]);
    expect(t.rewinds()).toBe(0);
    expect(t.target.write).toHaveBeenCalledExactlyOnceWith('q');
    expect(t.target.submitBracketedPaste).toHaveBeenCalledExactlyOnceWith(MESSAGE);
    expect(t.target.sendSpecialKeys).not.toHaveBeenCalled();
  });

  it('uses the same one-shot behavior for raw bracketed PTY writes', async () => {
    const t = terminal();
    delete t.target.submitBracketedPaste;
    delete t.target.pasteText;
    delete t.target.sendSpecialKeys;
    expect(await submit(t.target)).toMatchObject({ submitted: true });
    expect(t.executed).toEqual([MESSAGE]);
    expect(vi.mocked(t.target.write).mock.calls.map(([data]) => data))
      .toEqual(['q', `\x1b[200~${MESSAGE}\x1b[201~\r`]);
  });

  it.each(['false', 'throw'] as const)('observes an ambiguous %s close without repeating it', async closeResult => {
    const t = terminal(OVERLAY, { closeResult, closeDelay: 350 });
    expect(await submit(t.target)).toMatchObject({ submitted: true });
    expect(t.target.write).toHaveBeenCalledTimes(1);
    expect(t.executed).toEqual([MESSAGE]);
  });

  it('preserves a draft hidden behind the viewer without submitting or appending', async () => {
    const t = terminal(OVERLAY, { hiddenDraft: 'human draft' });
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

  it('does not guess a remapped close key', async () => {
    const t = terminal(OVERLAY.replace('q to quit', 'x to quit'));
    expect(await submit(t.target)).toMatchObject({ submitted: false, failureReason: expect.any(String) });
    expect(t.target.write).not.toHaveBeenCalled();
    expect(t.target.pasteText).not.toHaveBeenCalled();
    expect(t.target.submitBracketedPaste).not.toHaveBeenCalled();
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
  it('submits small, multiline Markdown and long pastes as one frame without screen-text inference', async () => {
    for (const message of ['First line  \nSecond line', 'a'.repeat(2000), '中文😀'.repeat(600)]) {
      const t = terminal('');
      delete t.target.submitBracketedPaste;
      const pending = createCodexAdapter().writeInput(t.target, message);
      await flushFakeTimers();
      expect(await pending).toMatchObject({ submitted: true });
      expect(t.executed).toEqual([message]);
      expect(t.target.write).toHaveBeenCalledExactlyOnceWith(`\x1b[200~${message}\x1b[201~\r`);
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
