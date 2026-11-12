import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { AskResult } from '../src/core/ask-types.js';
import { TerminalRenderer } from '../src/utils/terminal-renderer.js';
import { classifyStuckPage } from '../src/utils/stuck-detector.js';
import {
  isTraexQuestionConfirmPage,
  nextTraexQuestionStep,
  parseTraexQuestionPage,
  sanitizeTraexQuestionNote,
  traexQuestionAnswerFromAsk,
  traexQuestionAskQuestion,
  traexQuestionFlowVisible,
  traexQuestionSignature,
  traexQuestionState,
  traexQuestionStepAllowed,
  type TraexQuestionPage,
} from '../src/utils/traex-question-page.js';

// Screens captured from a real traecli 0.214.1 (tmux capture-pane, plain and
// -e) driven into its AskUserQuestion page; see the fixture directory README.
const DIR = new URL('./fixtures/traex-question/', import.meta.url);
const fixture = (name: string) => readFileSync(new URL(name, DIR), 'utf8');
const page = (name: string): TraexQuestionPage => {
  const parsed = parseTraexQuestionPage(fixture(name));
  if (!parsed) throw new Error(`${name} did not parse`);
  return parsed;
};

const answered = (answers: string[], extra: Partial<Extract<AskResult, { kind: 'answered' }>> = {}): AskResult => ({
  kind: 'answered', answers: [answers], by: 'ou_x', comment: null, timedOut: false, ...extra,
});

describe('parseTraexQuestionPage on real traecli 0.214.1 screens', () => {
  it('reads a single-choice question, its options and TRAE\'s own "None of the above"', () => {
    for (const name of ['traex-0.214.1-single-160x50.txt', 'traex-0.214.1-single-160x50.ansi.txt']) {
      expect(page(name), name).toEqual({
        index: 1, total: 1, unanswered: 1,
        prompt: 'Which database should the new service use?',
        multiSelect: false,
        options: [
          { number: 1, label: 'PostgreSQL (Recommended)', description: 'Mature, strong consistency', other: false },
          { number: 2, label: 'MySQL', description: 'Widely deployed', other: false },
          { number: 3, label: 'SQLite', description: 'Embedded, zero ops', other: false },
          { number: 4, label: 'None of the above', description: 'Optionally, add details in notes (tab).', other: true },
        ],
        highlighted: 1,
        notesOpen: false,
        submitAll: false,
      });
    }
  });

  it('follows the pointer and the notes field', () => {
    expect(page('traex-0.214.1-single-highlight3-160x50.txt')).toMatchObject({ highlighted: 3, notesOpen: false });
    expect(page('traex-0.214.1-single-notes-empty-160x50.txt')).toMatchObject({ highlighted: 3, notesOpen: true, notesText: '' });
    // The reported bug's screen: a pasted Lark message sitting in the notes.
    for (const name of ['traex-0.214.1-single-notes-typed-160x50.txt', 'traex-0.214.1-single-notes-typed-160x50.ansi.txt']) {
      expect(page(name), name).toMatchObject({ notesOpen: true, notesText: '用第二个方案吧，另外帮我看下日志' });
    }
    // A short pane squeezes the notes row out between its rules.
    const hidden = page('traex-0.214.1-long-notes-hidden-80x24.txt');
    expect(hidden.notesOpen).toBe(true);
    expect(hidden).not.toHaveProperty('notesText');
  });

  it('reads multi-question batches, multiSelect ticks and the last question', () => {
    expect(page('traex-0.214.1-multi-q1-160x50.txt')).toMatchObject({ index: 1, total: 3, unanswered: 3, multiSelect: false, submitAll: false });
    for (const name of ['traex-0.214.1-multi-q2-multiselect-160x50.txt', 'traex-0.214.1-multi-q2-multiselect-160x50.ansi.txt']) {
      const q2 = page(name);
      expect(q2, name).toMatchObject({ index: 2, total: 3, multiSelect: true, highlighted: 3, prompt: 'Which features do you want to enable?' });
      expect(q2.options.map(o => [o.label, o.checked, o.other])).toEqual([
        ['Caching', true, false], ['Metrics', false, false], ['Tracing', true, false], ['Other', false, true],
      ]);
    }
    expect(page('traex-0.214.1-multi-q3-submit-all-160x50.txt')).toMatchObject({ index: 3, total: 3, submitAll: true });
    expect(page('traex-0.214.1-multiselect-other-notes-160x50.txt')).toMatchObject({
      multiSelect: true, highlighted: 4, notesOpen: true, notesText: '再加个审计日志',
    });
  });

  it('joins wrapped question text and descriptions and a wrapped footer (80x24)', () => {
    const narrow = page('traex-0.214.1-long-wrapped-80x24.txt');
    expect(narrow.prompt).toBe('The legacy billing tables still hold about 40 million rows and the new schema splits invoices from payments; how should we migrate the existing data before the cutover next week?');
    expect(narrow.options[0]).toEqual({
      number: 1, label: 'Online dual-write backfill (Recommended)', other: false,
      description: 'Write to both schemas, backfill history in batches, then switch reads once checksums match',
    });
    expect(narrow.options[3]).toMatchObject({ label: 'None of the above', other: true });
    expect(narrow).toMatchObject({ index: 1, total: 2, multiSelect: false });
  });

  it('holds on the worker\'s display snapshots too, but reads cards only from exact screens', async () => {
    // TerminalRenderer.rawSnapshot() collapses column spacing for display;
    // that is what the worker's cached screens hold.
    for (const name of ['traex-0.214.1-single-160x50.ansi.txt', 'traex-0.214.1-single-notes-typed-160x50.ansi.txt', 'traex-0.214.1-multi-q2-multiselect-160x50.ansi.txt']) {
      const renderer = new TerminalRenderer(160, 50);
      try {
        const rows = fixture(name).replace(/\n+$/, '').split('\n');
        await renderer.writeAndFlush('\x1b[2J\x1b[H' + rows.map((row, i) => `\x1b[${i + 1};1H${row}`).join(''));
        const display = renderer.rawSnapshot();
        expect(traexQuestionFlowVisible(display), name).toBe(true);
        // Labels and descriptions are no longer separable there...
        expect(parseTraexQuestionPage(display), name).toBeUndefined();
        // ...while the exact read keeps them (the bridge's PTY capture).
        expect(parseTraexQuestionPage(renderer.rawSnapshot({ preserveFormatting: true })), name)
          .toEqual(parseTraexQuestionPage(fixture(name.replace('.ansi.txt', '.txt'))));
      } finally {
        renderer.dispose();
      }
    }
    const confirm = new TerminalRenderer(160, 50);
    try {
      await confirm.writeAndFlush(fixture('traex-0.214.1-submit-confirm-160x50.txt').replace(/\n/g, '\r\n'));
      expect(traexQuestionFlowVisible(confirm.rawSnapshot())).toBe(true);
    } finally {
      confirm.dispose();
    }
  });

  it('recognises the "Submit with unanswered questions?" confirmation separately', () => {
    const confirm = fixture('traex-0.214.1-submit-confirm-160x50.txt');
    expect(parseTraexQuestionPage(confirm)).toBeUndefined();
    expect(isTraexQuestionConfirmPage(confirm)).toBe(true);
    expect(traexQuestionFlowVisible(confirm)).toBe(true);
  });

  it('does not take other screens for the question page', () => {
    // The answered summary in history above a normal composer, an interrupted turn.
    for (const name of ['traex-0.214.1-answered-composer-160x50.txt', 'traex-0.214.1-interrupted-composer-160x50.txt']) {
      expect(traexQuestionFlowVisible(fixture(name)), name).toBe(false);
    }
    // Every recorded blocking page of the Codex family (hook review, migration, session lock).
    const stuckDir = new URL('./fixtures/stuck-pages/', import.meta.url);
    const stuckPages = readdirSync(stuckDir).filter(name => name.endsWith('.txt'));
    expect(stuckPages.length).toBeGreaterThan(0);
    for (const name of stuckPages) {
      expect(traexQuestionFlowVisible(readFileSync(new URL(name, stuckDir), 'utf8')), name).toBe(false);
    }
    // ...and the question page is none of those pages either.
    expect(classifyStuckPage(fixture('traex-0.214.1-single-160x50.txt'))).toBeUndefined();
  });

  it('needs the page at the bottom of the screen: quoted or scrolled-up copies do not count', () => {
    const screen = fixture('traex-0.214.1-single-160x50.txt').trimEnd();
    expect(parseTraexQuestionPage(`${screen}\n\n❯ \n  gpt · /tmp/repo · Context 99% left`)).toBeUndefined();
    // The same rows quoted inside an answer (indented one level deeper).
    const quoted = screen.split('\n').map(row => `  ${row}`).join('\n');
    expect(parseTraexQuestionPage(quoted)).toBeUndefined();
    // A footer TRAE never draws (an unknown hint) fails closed to "no page".
    expect(parseTraexQuestionPage(screen.replace('esc interrupt', 'esc cancel'))).toBeUndefined();
    // The options must end with TRAE's own row — for holding input too.
    expect(parseTraexQuestionPage(screen.replace('None of the above', 'None of these'))).toBeUndefined();
    expect(traexQuestionFlowVisible(screen.replace('None of the above', 'None of these'))).toBe(false);
    expect(traexQuestionFlowVisible(screen.replace('Question 1/1 (1 unanswered)', 'Questions'))).toBe(false);
    expect(traexQuestionFlowVisible(screen.replace('esc interrupt', 'esc cancel'))).toBe(false);
  });

  it('fails closed on a page one detail away from what TRAE draws', () => {
    // Each look-alike is a real capture with a single edit TRAE never makes.
    // The card reads its options and the answer's keys from this parse, so
    // anything off in the layout must read as "no page", never as a guess.
    const single = fixture('traex-0.214.1-single-160x50.txt');
    const notes = fixture('traex-0.214.1-single-notes-typed-160x50.txt');
    const multi = fixture('traex-0.214.1-multi-q2-multiselect-160x50.txt');
    expect(parseTraexQuestionPage(single)).toBeDefined();
    expect(parseTraexQuestionPage(notes)).toBeDefined();
    expect(parseTraexQuestionPage(multi)).toBeDefined();
    const lookAlikes: Array<[string, string]> = [
      ['two pointers', single.replace('    2. MySQL', '  ❯ 2. MySQL')],
      ['options out of sequence', single.replace('    2. MySQL ', '    5. MySQL ')],
      ['a row between the options and the footer', single.replace('\n\n  tab add notes', '\n  see the notes below\n\n  tab add notes')],
      ['an open notes field without its upper rule', notes.replace(/\n {2}─+\n {2}❯ 用第二个方案吧/, '\n  ❯ 用第二个方案吧')],
      ['a question number past the batch size', single.replace('Question 1/1 (1 unanswered)', 'Question 3/1 (1 unanswered)')],
      ['a footer offering both submits', single.replace('enter submit answer', 'enter submit answer  |  enter submit all')],
      ['checkboxes without the toggle hint', multi.replace('space toggle  |  ', '')],
      ['the toggle hint without checkboxes', single.replace('  tab add notes', '  space toggle  |  tab add notes')],
    ];
    for (const [what, screen] of lookAlikes) {
      expect(screen, what).not.toBe(single);
      expect(parseTraexQuestionPage(screen), what).toBeUndefined();
    }
    // Holding input keys on the chrome only, but that chrome still has to be
    // TRAE's: numbered in sequence, ending with its own described row.
    expect(traexQuestionFlowVisible(single.replace('    2. MySQL ', '    5. MySQL '))).toBe(false);
    expect(traexQuestionFlowVisible(single.replace('Optionally, add details in notes (tab).', 'Pick this one if unsure.'))).toBe(false);
  });

  it('keeps the question identity across pointer, ticks and notes, and changes it per question', () => {
    const base = traexQuestionSignature(page('traex-0.214.1-single-160x50.txt'));
    for (const name of ['traex-0.214.1-single-highlight3-160x50.txt', 'traex-0.214.1-single-notes-empty-160x50.txt', 'traex-0.214.1-single-notes-typed-160x50.txt']) {
      expect(traexQuestionSignature(page(name)), name).toBe(base);
    }
    expect(traexQuestionState(page('traex-0.214.1-single-highlight3-160x50.txt'))).not.toBe(traexQuestionState(page('traex-0.214.1-single-160x50.txt')));
    expect(traexQuestionSignature(page('traex-0.214.1-multi-q1-160x50.txt'))).not.toBe(base);
  });
});

describe('question card ↔ page', () => {
  it('offers the real options with their descriptions; TRAE\'s own row becomes the custom answer', () => {
    expect(traexQuestionAskQuestion(page('traex-0.214.1-single-160x50.txt'))).toEqual({
      prompt: 'Which database should the new service use?',
      multiSelect: false,
      options: [
        { key: '1', label: 'PostgreSQL (Recommended)', description: 'Mature, strong consistency' },
        { key: '2', label: 'MySQL', description: 'Widely deployed' },
        { key: '3', label: 'SQLite', description: 'Embedded, zero ops' },
      ],
    });
    expect(traexQuestionAskQuestion(page('traex-0.214.1-multi-q2-multiselect-160x50.txt'))).toMatchObject({
      prompt: '(2/3) Which features do you want to enable?', multiSelect: true,
    });
  });

  it('maps a card result to option numbers or a custom note', () => {
    const single = page('traex-0.214.1-single-160x50.txt');
    expect(traexQuestionAnswerFromAsk(single, answered(['2']))).toEqual({ kind: 'options', numbers: [2] });
    expect(traexQuestionAnswerFromAsk(single, answered([], { customAnswers: ['  用 TiDB  '] }))).toEqual({ kind: 'custom', text: '用 TiDB' });
    // A plain reply in the thread settles the card as `comment`.
    expect(traexQuestionAnswerFromAsk(single, answered([], { comment: '都不要，先别建库' }))).toEqual({ kind: 'custom', text: '都不要，先别建库' });
    // TRAE's own row is never a card option, nor is an unknown key.
    expect(typeof traexQuestionAnswerFromAsk(single, answered(['4']))).toBe('string');
    expect(typeof traexQuestionAnswerFromAsk(single, answered(['1', '2']))).toBe('string');
    expect(typeof traexQuestionAnswerFromAsk(single, { kind: 'timedOut', selected: null, by: null, comment: null, timedOut: true })).toBe('string');
    const multi = page('traex-0.214.1-multi-q2-multiselect-160x50.txt');
    expect(traexQuestionAnswerFromAsk(multi, answered(['3', '1']))).toEqual({ kind: 'options', numbers: [1, 3] });
  });

  it('folds a custom answer into one safe line for the notes field', () => {
    expect(sanitizeTraexQuestionNote('a\r\nb\nc')).toBe('a b c');
    // An ESC would end the bracketed paste early and turn the rest into keys.
    expect(sanitizeTraexQuestionNote('x\x1b[201~\x1b[A\ry')).toBe('x[201~[A y');
    expect(sanitizeTraexQuestionNote('z'.repeat(1500))).toHaveLength(1000);
  });
});

describe('entering an answer one verified input at a time', () => {
  it('picks a single-choice option with its digit (select + submit)', () => {
    expect(nextTraexQuestionStep(page('traex-0.214.1-single-160x50.txt'), { kind: 'options', numbers: [2] }))
      .toEqual({ kind: 'key', key: '2', final: true });
    // With the notes field focused a digit would become note text: refuse.
    expect(nextTraexQuestionStep(page('traex-0.214.1-single-notes-typed-160x50.txt'), { kind: 'options', numbers: [2] }).kind).toBe('fail');
  });

  it('ticks exactly the chosen boxes, then submits', () => {
    const q2 = page('traex-0.214.1-multi-q2-multiselect-160x50.txt'); // Caching ✓, Tracing ✓
    expect(nextTraexQuestionStep(q2, { kind: 'options', numbers: [1, 3] })).toEqual({ kind: 'key', key: 'Enter', final: true });
    expect(nextTraexQuestionStep(q2, { kind: 'options', numbers: [2] })).toEqual({ kind: 'key', key: '1', final: false });
    expect(nextTraexQuestionStep(q2, { kind: 'options', numbers: [1, 2, 3] })).toEqual({ kind: 'key', key: '2', final: false });
  });

  it('writes a custom answer as a note on TRAE\'s own row: move, Tab, paste, Enter', () => {
    const answer = { kind: 'custom' as const, text: '用第二个方案吧，另外帮我看下日志' };
    // Pointer on 1 of 4: Up wraps to the last row.
    expect(nextTraexQuestionStep(page('traex-0.214.1-single-160x50.txt'), answer)).toEqual({ kind: 'key', key: 'Up', final: false });
    // Pointer on 3: Down.
    expect(nextTraexQuestionStep(page('traex-0.214.1-single-highlight3-160x50.txt'), answer)).toEqual({ kind: 'key', key: 'Down', final: false });
    // Notes open, but on another row (3): someone else's notes — refuse.
    expect(nextTraexQuestionStep(page('traex-0.214.1-single-notes-empty-160x50.txt'), answer).kind).toBe('fail');
    const onOther = page('traex-0.214.1-multiselect-other-notes-160x50.txt'); // multiSelect, Other ✓ with notes
    expect(nextTraexQuestionStep(onOther, { kind: 'custom', text: '再加个审计日志' })).toEqual({ kind: 'key', key: 'Enter', final: true });
    expect(nextTraexQuestionStep(onOther, { kind: 'custom', text: '别的' }).kind).toBe('fail');
    expect(nextTraexQuestionStep({ ...onOther, notesText: '' }, { kind: 'custom', text: '别的' })).toEqual({ kind: 'paste', text: '别的' });
    // A notes row that cannot be seen cannot be verified.
    expect(nextTraexQuestionStep(page('traex-0.214.1-long-notes-hidden-80x24.txt'), answer).kind).toBe('fail');
  });

  it('allows only page-local inputs, and digits/arrows only while the options have focus', () => {
    const single = page('traex-0.214.1-single-160x50.txt');
    const notes = page('traex-0.214.1-single-notes-empty-160x50.txt');
    const key = (k: string) => ({ kind: 'key' as const, key: k, final: false });
    expect(['1', '4', 'Up', 'Down', 'Tab', 'Enter'].every(k => traexQuestionStepAllowed(single, key(k)))).toBe(true);
    expect(['5', '0', 'Escape', 'Left', 'a', '12'].some(k => traexQuestionStepAllowed(single, key(k)))).toBe(false);
    expect(traexQuestionStepAllowed(single, { kind: 'paste', text: 'x' })).toBe(false);
    expect(['1', 'Up', 'Tab'].some(k => traexQuestionStepAllowed(notes, key(k)))).toBe(false);
    expect(traexQuestionStepAllowed(notes, { kind: 'paste', text: 'x' })).toBe(true);
    expect(traexQuestionStepAllowed(notes, { kind: 'paste', text: 'x\x1by' })).toBe(false);
    expect(traexQuestionStepAllowed(page('traex-0.214.1-single-notes-typed-160x50.txt'), { kind: 'paste', text: 'x' })).toBe(false);
  });
});
