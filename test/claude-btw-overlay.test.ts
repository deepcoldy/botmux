import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ClaudeBtwCaptureGuard,
  claudeBtwOverlayVisible,
  claudeBtwQuestion,
  extractOsc52Text,
  parseClaudeBtwOverlay,
} from '../src/utils/claude-btw-overlay.js';
import { TerminalRenderer } from '../src/utils/terminal-renderer.js';

// Screens captured from Claude Code v2.1.300.
const ANSWERING_SCREEN = [
  '✻ Cogitated for 7s · done 1:06 PM · 1 shell still running',
  '▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔',
  '    /btw what is 1+1?',
  '      ✽ Answering…',
  '    Esc to close',
].join('\n');

const DONE_SCREEN = [
  '✻ Cogitated for 7s · done 1:06 PM · 1 shell still running',
  '▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔',
  '    /btw what is 1+1? answer in two short sentences',
  '    /btw list three months, one per line',
  '      January: named after Janus.',
  '      February: the shortest month.',
  '        - nested detail',
  '      March: first month of the old Roman year.',
  '    ⇧←/→ to browse · c to copy · f to fork · x to clear history · Esc to close',
].join('\n');

function screen(question: string, body: string[], footer: string): string {
  return ['▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔', `    /btw ${question}`, ...body.map(l => `      ${l}`), `    ${footer}`].join('\n');
}
const DONE_FOOTER = '↑/↓ to scroll · c to copy · f to fork · Esc to close';

function osc52(text: string, terminator = '\x07'): string {
  return `\x1b]52;c;${Buffer.from(text, 'utf8').toString('base64')}${terminator}`;
}

/** Arm a guard and walk it through answering → done → copy request. */
function copyingGuard(question: string): ClaudeBtwCaptureGuard {
  const guard = new ClaudeBtwCaptureGuard();
  guard.arm(question);
  guard.inspectScreen(screen(question, ['✽ Answering…'], 'Esc to close'));
  expect(guard.inspectScreen(screen(question, ['answer'], DONE_FOOTER))).toEqual({ kind: 'copy' });
  guard.markCopyRequested();
  return guard;
}

describe('claudeBtwQuestion', () => {
  it('returns the question of a /btw line', () => {
    expect(claudeBtwQuestion('/btw what is 1+1?')).toBe('what is 1+1?');
    expect(claudeBtwQuestion('  /btw  多行\n问题  ')).toBe('多行\n问题');
  });

  it('ignores bare /btw and other commands', () => {
    expect(claudeBtwQuestion('/btw')).toBeUndefined();
    expect(claudeBtwQuestion('/btw   ')).toBeUndefined();
    expect(claudeBtwQuestion('/btwx hi')).toBeUndefined();
    expect(claudeBtwQuestion('please /btw hi')).toBeUndefined();
    expect(claudeBtwQuestion('/compact')).toBeUndefined();
  });
});

describe('extractOsc52Text', () => {
  it('decodes BEL- and ST-terminated payloads, keeping the last one', () => {
    expect(extractOsc52Text(`noise${osc52('first')}more${osc52('第二个答案', '\x1b\\')}`)).toBe('第二个答案');
  });

  it('decodes a tmux DCS-wrapped payload', () => {
    const b64 = Buffer.from('wrapped', 'utf8').toString('base64');
    expect(extractOsc52Text(`\x1bPtmux;\x1b\x1b]52;c;${b64}\x07\x1b\\`)).toBe('wrapped');
  });

  it('waits for the terminator', () => {
    expect(extractOsc52Text(osc52('answer').slice(0, -1))).toBeUndefined();
  });
});

describe('ClaudeBtwCaptureGuard.inspectScreen', () => {
  it('does nothing until armed', () => {
    const guard = new ClaudeBtwCaptureGuard();
    expect(guard.inspectScreen(screen('q', ['a'], DONE_FOOTER))).toEqual({ kind: 'pass' });
    expect(guard.isArmed()).toBe(false);
  });

  it('copies only after seeing our overlay answer and then finish', () => {
    const guard = new ClaudeBtwCaptureGuard();
    guard.arm('what is 1+1?');
    expect(guard.inspectScreen(ANSWERING_SCREEN)).toEqual({ kind: 'pass' });
    expect(guard.inspectScreen(screen('what is 1+1?', ['2'], DONE_FOOTER))).toEqual({ kind: 'copy' });
  });

  it('never copies a finished overlay it did not see answering (stale or foreign overlay)', () => {
    const guard = new ClaudeBtwCaptureGuard();
    guard.arm('what is 1+1?');
    expect(guard.inspectScreen(screen('what is 1+1?', ['2'], DONE_FOOTER))).toEqual({ kind: 'pass' });
  });

  it('ignores an overlay for a different question', () => {
    const guard = new ClaudeBtwCaptureGuard();
    guard.arm('second question');
    guard.inspectScreen(screen('first question', ['✽ Answering…'], 'Esc to close'));
    expect(guard.inspectScreen(screen('first question', ['a'], DONE_FOOTER))).toEqual({ kind: 'pass' });
  });

  it('matches a truncated on-screen question but not a longer one it is a prefix of', () => {
    const guard = new ClaudeBtwCaptureGuard();
    guard.arm('a long question that wraps');
    guard.inspectScreen(screen('a long question', ['✽ Answering…'], 'Esc to close'));
    expect(guard.inspectScreen(screen('a long question', ['x'], DONE_FOOTER))).toEqual({ kind: 'copy' });

    const short = new ClaudeBtwCaptureGuard();
    short.arm('a');
    short.inspectScreen(screen('ab', ['✽ Answering…'], 'Esc to close'));
    expect(short.inspectScreen(screen('ab', ['x'], DONE_FOOTER))).toEqual({ kind: 'pass' });
  });

  it('is not triggered by an answer that talks about the shortcuts', () => {
    const q = 'how do I copy your answer?';
    const guard = new ClaudeBtwCaptureGuard();
    guard.arm(q);
    guard.inspectScreen(screen(q, ['✽ Answering…'], 'Esc to close'));
    // Streaming, footer still the answering one; body mentions the footer words.
    const streaming = screen(q, ['Sure: press c to copy · f to fork · Esc to close', 'and then…'], 'Esc to close');
    expect(guard.inspectScreen(streaming)).toEqual({ kind: 'pass' });
  });

  it('is not triggered by a question that echoes the shortcuts', () => {
    const q = 'how do I press c to copy · f to fork · Esc to close?';
    const guard = new ClaudeBtwCaptureGuard();
    guard.arm(q);
    expect(guard.inspectScreen(screen(q, ['✽ Answering…'], 'Esc to close'))).toEqual({ kind: 'pass' });
    expect(guard.inspectScreen(screen(q, ['use the footer keys'], DONE_FOOTER))).toEqual({ kind: 'copy' });
  });

  it('never copies when no overlay renders (old CLI, command error)', () => {
    const guard = new ClaudeBtwCaptureGuard();
    guard.arm('how do I press c to copy and Esc to close?');
    const noOverlay = [
      '❯ /btw how do I press c to copy and Esc to close?',
      '  ⎿  Unknown command: /btw how do I press c to copy · f to fork · Esc to close',
      '───────────',
      '❯ ',
    ].join('\n');
    expect(guard.inspectScreen(noOverlay)).toEqual({ kind: 'pass' });
    expect(guard.inspectScreen(noOverlay)).toEqual({ kind: 'pass' });
  });

  it('can go back to waiting after a premature copy request', () => {
    const guard = copyingGuard('q');
    guard.revertToAnswering();
    expect(guard.isCopying()).toBe(false);
    expect(guard.inspectScreen(screen('q', ['final answer'], DONE_FOOTER))).toEqual({ kind: 'copy' });
  });
});

describe('ClaudeBtwCaptureGuard.inspectData', () => {
  it('returns the clipboard answer with its question and disarms', () => {
    const guard = copyingGuard('what is 1+1?');
    const payload = osc52('1 + 1 equals 2.\n\n- **bold** item');
    expect(guard.inspectData(payload.slice(0, 10))).toEqual({ kind: 'pass' });
    expect(guard.inspectData(payload.slice(10))).toEqual({
      kind: 'answer',
      text: '1 + 1 equals 2.\n\n- **bold** item',
      question: 'what is 1+1?',
    });
    expect(guard.isArmed()).toBe(false);
    expect(guard.question).toBe('');
  });

  it('finds a start marker split across chunks', () => {
    const guard = copyingGuard('q');
    const payload = `noise${osc52('split')}`;
    const cut = payload.indexOf('\x1b]52;') + 3;
    expect(guard.inspectData(payload.slice(0, cut))).toEqual({ kind: 'pass' });
    expect(guard.inspectData(payload.slice(cut))).toEqual({ kind: 'answer', text: 'split', question: 'q' });
  });

  it('ignores clipboard sequences before the copy request', () => {
    const guard = new ClaudeBtwCaptureGuard();
    guard.arm('q');
    expect(guard.inspectData(osc52('stale'))).toEqual({ kind: 'pass' });
    expect(guard.isArmed()).toBe(true);
  });
});

describe('parseClaudeBtwOverlay', () => {
  it('reads the last question and its dedented answer', () => {
    expect(parseClaudeBtwOverlay(DONE_SCREEN)).toEqual({
      state: 'done',
      question: 'list three months, one per line',
      answer: [
        'January: named after Janus.',
        'February: the shortest month.',
        '  - nested detail',
        'March: first month of the old Roman year.',
      ].join('\n'),
    });
  });

  it('reports an in-progress answer without text', () => {
    expect(parseClaudeBtwOverlay(ANSWERING_SCREEN)).toEqual({ state: 'answering', question: 'what is 1+1?', answer: '' });
    expect(claudeBtwOverlayVisible(ANSWERING_SCREEN)).toBe(true);
  });

  it('never reads a finished footer as answering', () => {
    for (const footer of [DONE_FOOTER, '⇧←/→ to browse · c to copy · f to fork · x to clear history · Esc to close', 'c to copy · Esc to close']) {
      expect(parseClaudeBtwOverlay(screen('q', ['a'], footer))?.state).toBe('done');
    }
  });

  it('does not take another overlay with an Esc footer for /btw', () => {
    expect(parseClaudeBtwOverlay(screen('- ask a side question', ['help'], '↑/↓ to scroll · Esc to close'))).toBeUndefined();
  });

  it('accepts several hints before the copy shortcut', () => {
    expect(parseClaudeBtwOverlay(screen('q', ['a'], '↑/↓ to scroll · ⇧←/→ to browse · c to copy · f to fork · Esc to close'))?.state).toBe('done');
  });

  it('accepts the transient "Copied to clipboard" footer', () => {
    const copied = screen('q', ['a'], '↑/↓ to scroll · Copied to clipboard · f to fork · Esc to close');
    expect(parseClaudeBtwOverlay(copied)?.state).toBe('done');
  });

  it('is not hijacked by a deeper /btw example inside the answer', () => {
    const s = screen('how do I ask a side question?', ['Type it like this:', '  /btw what does this function do?', 'and press Enter.'], DONE_FOOTER);
    expect(parseClaudeBtwOverlay(s)).toEqual({
      state: 'done',
      question: 'how do I ask a side question?',
      answer: 'Type it like this:\n  /btw what does this function do?\nand press Enter.',
    });
  });

  it('requires a whole-line footer at the question depth', () => {
    const footerInBody = screen('q', ['c to copy · f to fork · Esc to close'], 'still typing');
    expect(parseClaudeBtwOverlay(footerInBody)).toBeUndefined();
    expect(claudeBtwOverlayVisible(footerInBody)).toBe(false);
  });

  it('returns undefined when no overlay is on screen', () => {
    const s = [
      '● ok',
      '───────────',
      '❯ /btw typed but not submitted',
      '───────────',
      '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
    ].join('\n');
    expect(parseClaudeBtwOverlay(s)).toBeUndefined();
    expect(claudeBtwOverlayVisible(s)).toBe(false);
  });
});

describe('real Claude Code PTY bytes through the headless renderer', () => {
  // Raw tmux pipe-pane output of Claude Code v2.1.300 (159x51 pane): a
  // running turn, `/btw …`, the answering overlay, the finished overlay
  // (painted differentially — the footer is not one contiguous string in the
  // stream), then the `c` press with its OSC 52 copy.
  const raw = readFileSync(resolve(__dirname, 'fixtures/claude-btw-overlay.pty'), 'utf8');
  const question = '用中文列出三个 Markdown 语法要点，每条一行，带一个加粗词';
  const cut = (marker: string, from: number) => raw.indexOf(marker, from) + marker.length;

  it('drives answering → copy → OSC 52 answer, with nested Markdown preserved', async () => {
    const r = new TerminalRenderer(159, 51);
    const guard = new ClaudeBtwCaptureGuard();
    guard.arm(question);
    const view = () => r.rawSnapshot({ preserveFormatting: true });

    const answering = cut('Esc to close\x1b[39m\x1b[K\x1b[51;1H', 0);
    await r.writeAndFlush(raw.slice(0, answering));
    expect(parseClaudeBtwOverlay(view())?.state).toBe('answering');
    expect(guard.inspectScreen(view())).toEqual({ kind: 'pass' });

    const done = cut('to close\x1b[39m\x1b[51;1H', answering);
    await r.writeAndFlush(raw.slice(answering, done));
    const overlay = parseClaudeBtwOverlay(view());
    expect(overlay?.question).toBe(question);
    expect(overlay?.answer.split('\n')).toEqual([
      '- 标题：在行首加 # 号，数量越多层级越低，例如 ## 小节。',
      '- 列表：行首用 - 或 1. 开头，每项占一行。',
      '- 代码：用反引号包住行内代码，用三个反引号包住代码块。',
    ]);
    expect(guard.inspectScreen(view())).toEqual({ kind: 'copy' });
    guard.markCopyRequested();

    // Up to the end of the OSC 52 copy (the fixture continues past the Esc).
    const copied = raw.indexOf('\x07', raw.indexOf('\x1b]52;', done)) + 1;
    const rest = raw.slice(done, copied);
    await r.writeAndFlush(rest);
    const action = guard.inspectData(rest);
    expect(action.kind).toBe('answer');
    expect(action.kind === 'answer' && action.text).toContain('- **标题**：在行首加 `#` 号');
    expect(action.kind === 'answer' && action.question).toBe(question);
    // The overlay is still up after the copy, so Esc would close it…
    expect(claudeBtwOverlayVisible(view())).toBe(true);
    // …and once the fixture's Esc lands, it is gone (no second Esc).
    await r.writeAndFlush(raw.slice(copied));
    expect(claudeBtwOverlayVisible(view())).toBe(false);
  });

  it('a later /btw is seen answering under the browse/clear-history footer', async () => {
    // The fixture's second /btw: earlier questions are in the history, so the
    // answering footer carries the navigation hints. Only this frame gives
    // the answering evidence before the finished footer.
    const second = '用两三句话解释 OSC 52 是什么';
    const r = new TerminalRenderer(159, 51);
    const guard = new ClaudeBtwCaptureGuard();
    guard.arm(second);
    const browse = raw.indexOf('to browse');
    await r.writeAndFlush(raw.slice(0, cut('Esc to close\x1b[39m\x1b[K\x1b[51;1H', browse)));
    const view = r.rawSnapshot({ preserveFormatting: true });
    expect(parseClaudeBtwOverlay(view)).toEqual({ state: 'answering', question: second, answer: '' });
    expect(guard.inspectScreen(view)).toEqual({ kind: 'pass' });
    const done = screen(second, ['OSC 52 lets a program set the clipboard.'], '⇧←/→ to browse · c to copy · f to fork · x to clear history · Esc to close');
    expect(guard.inspectScreen(done)).toEqual({ kind: 'copy' });
  });

  it('the display-cleaned snapshot also recognises the overlay (Esc gate)', async () => {
    const r = new TerminalRenderer(159, 51);
    await r.writeAndFlush(raw.slice(0, cut('to close\x1b[39m\x1b[51;1H', cut('Esc to close\x1b[39m\x1b[K\x1b[51;1H', 0))));
    expect(claudeBtwOverlayVisible(r.rawSnapshot())).toBe(true);
  });
});

describe('ClaudeBtwCaptureGuard.copyFallback', () => {
  const guard = new ClaudeBtwCaptureGuard();
  guard.arm('q');
  const done = { state: 'done', question: 'q', answer: 'a' } as const;
  const answering = { state: 'answering', question: 'q', answer: '' } as const;

  it('delivers our finished overlay with text', () => {
    expect(guard.copyFallback(done, 3, 3)).toEqual({ kind: 'deliver', answer: 'a' });
    expect(guard.copyFallback({ ...done, answer: '' }, 1, 3)).toEqual({ kind: 'give-up' });
  });

  it('waits while answering, until the copy attempts run out', () => {
    expect(guard.copyFallback(answering, 2, 3)).toEqual({ kind: 'wait' });
    expect(guard.copyFallback(answering, 3, 3)).toEqual({ kind: 'give-up' });
  });

  it('gives up without an overlay or on another question', () => {
    expect(guard.copyFallback(undefined, 1, 3)).toEqual({ kind: 'give-up' });
    expect(guard.copyFallback({ ...done, question: 'other' }, 1, 3)).toEqual({ kind: 'give-up' });
  });
});
