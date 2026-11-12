/**
 * TRAE CLI (traex / traecli) native question page — the `AskUserQuestion`
 * tool's "Questions" panel that replaces the composer while the agent waits
 * for the user to pick an option.
 *
 * Every anchor below was captured from a real traecli 0.214.1 TUI
 * (test/fixtures/traex-question/, tmux 160x50 / 120x40 / 80x24, plain and
 * `capture-pane -e`):
 *
 *   Question 1/3 (3 unanswered)              header; the count is omitted once
 *   Which database should the new service use?     nothing is left unanswered
 *   ❯ 1. PostgreSQL (Recommended)  Mature, strong consistency
 *     2. MySQL                     Widely deployed
 *     3. None of the above         Optionally, add details in notes (tab).
 *   tab add notes  |  enter submit answer  |  ←/→ navigate questions  |  esc interrupt
 *
 *  - The last option is always the one TRAE adds itself: "None of the above"
 *    (single choice) or "Other" (multiSelect, rows drawn as `[ ]` / `[✓]`),
 *    described as "Optionally, add details in notes (tab)."
 *  - Tab opens a notes field under the options (rule, `❯ <text>` or the dim
 *    placeholder `❯ Add notes`, rule) and the footer becomes
 *    `tab or esc clear notes  |  enter submit answer`. Text typed or PASTED
 *    while the options have focus goes into that field — which is how a Lark
 *    message pasted by the worker became a note, and its Enter submitted the
 *    highlighted (recommended) option as the answer.
 *  - A digit picks that option: on a single-choice question it is selected and
 *    submitted at once (moving to the next question, or submitting the batch
 *    on the last one, whose footer says `enter submit all`); on a multiSelect
 *    question it toggles the box and moves the pointer there. Up/Down wrap.
 *  - The footer wraps onto a second row on a narrow pane; on a short one the
 *    notes row can be squeezed out between its two rules (reported as
 *    `notesText: undefined`).
 *  - Submitting the batch with questions left unanswered (Enter on the last
 *    question, e.g. a multiSelect one with nothing ticked) opens
 *    "Submit with unanswered questions?" (Proceed / Go back,
 *    `enter confirm  |  esc go back`) — recognised separately so input is
 *    held there too; it is never answered automatically.
 *
 * Matching is strict and bottom-anchored: the footer must be the last visible
 * row(s) and consist only of the observed hints, the header and the options
 * must sit right above it, and the options must end with TRAE's own
 * "None of the above"/"Other" row. A layout that differs simply does not
 * match (the old behaviour) — never a guess.
 */
import type { AskQuestion, AskResult } from '../core/ask-types.js';
import { stripAnsiScreenText } from './idle-detector.js';

const VIEWPORT_LINES = 60;
/** Header row → footer distance cap: question text + 5 options with wrapped
 *  descriptions + the notes field fit well inside. */
const MAX_PAGE_ROWS = 50;

const FOOTER_HINTS = new Set([
  'space toggle',
  'tab add notes',
  'tab or esc clear notes',
  'enter submit answer',
  'enter submit all',
  '←/→ navigate questions',
  'pgup/pgdn change question',
  'esc interrupt',
]);
const HEADER = /^ {2}Question ([1-9]\d?)\/([1-9]\d?)(?: \((\d+) unanswered\))?$/;
const OPTION = /^ {2}([❯ ]) (?:\[([ ✓])\] )?([1-9])\. (\S.*)$/;
const RULE = /^ +─{3,}$/;
const DESCRIPTION_CONTINUATION = /^ {9,}\S/;
const NOTES_ROW = /^ {2}❯ ?(.*)$/;
const OTHER_DESCRIPTION = /^Optionally, add details in notes \(tab\)\.?$/;
const NOTES_PLACEHOLDER = 'Add notes';

export interface TraexQuestionOption {
  /** 1-based, the digit that picks it. */
  number: number;
  label: string;
  description: string;
  /** TRAE's own "None of the above" / "Other" row. */
  other: boolean;
  /** multiSelect only. */
  checked?: boolean;
}

export interface TraexQuestionPage {
  /** 1-based position in the batch (`Question 2/3`). */
  index: number;
  total: number;
  /** Omitted by TRAE when nothing is left unanswered. */
  unanswered?: number;
  prompt: string;
  multiSelect: boolean;
  options: TraexQuestionOption[];
  /** Option number under the `❯` pointer. */
  highlighted: number;
  /** The notes field has focus (footer `tab or esc clear notes`). */
  notesOpen: boolean;
  /** notesOpen only: '' for the empty placeholder, undefined when the row is
   *  not visible (squeezed out on a short pane). */
  notesText?: string;
  /** Enter submits the whole batch (`enter submit all`). */
  submitAll: boolean;
}

/** Visible rows, ANSI and `\r` removed, trailing blank rows dropped, bottom
 *  VIEWPORT_LINES only. */
function visibleRows(screen: string): string[] {
  const rows = stripAnsiScreenText(screen ?? '').replace(/\r/g, '').split('\n').map(row => row.trimEnd());
  let end = rows.length;
  while (end > 0 && rows[end - 1] === '') end--;
  return rows.slice(Math.max(0, end - VIEWPORT_LINES), end);
}

/** A footer row's hints, or undefined when the row is not made of known
 *  hints only (`  |  ` separated, as TRAE draws them). */
function footerHints(row: string): string[] | undefined {
  if (!row.startsWith('  ') || row.startsWith('   ')) return undefined;
  const hints = row.trim().split(/ {2}\| {2}/);
  return hints.every(hint => FOOTER_HINTS.has(hint)) ? hints : undefined;
}

/** The trailing footer rows (one, or two when the pane is narrow). */
function readFooter(rows: string[]): { start: number; hints: Set<string> } | undefined {
  let start = rows.length;
  const hints: string[] = [];
  while (start > 0 && rows.length - start < 2) {
    const row = footerHints(rows[start - 1]!);
    if (!row) break;
    hints.unshift(...row);
    start--;
  }
  if (start === rows.length) return undefined;
  const set = new Set(hints);
  if (set.size !== hints.length) return undefined;
  return { start, hints: set };
}

/** Parse the question page at the bottom of `screen`; undefined when the
 *  screen does not end with one. */
export function parseTraexQuestionPage(screen: string): TraexQuestionPage | undefined {
  if (!screen) return undefined;
  const rows = visibleRows(screen);
  const footer = readFooter(rows);
  if (!footer) return undefined;
  const { hints } = footer;
  const submitAll = hints.has('enter submit all');
  if (submitAll === hints.has('enter submit answer')) return undefined;
  const notesOpen = hints.has('tab or esc clear notes');
  if (notesOpen === hints.has('tab add notes')) return undefined;

  let headerAt = -1;
  for (let i = footer.start - 1; i >= 0 && footer.start - i <= MAX_PAGE_ROWS; i--) {
    if (HEADER.test(rows[i]!)) { headerAt = i; break; }
  }
  if (headerAt < 0) return undefined;
  const header = HEADER.exec(rows[headerAt]!)!;
  const index = Number(header[1]);
  const total = Number(header[2]);
  if (index > total) return undefined;

  const promptLines: string[] = [];
  const options: TraexQuestionOption[] = [];
  let highlighted = 0;
  let checkboxes: boolean | undefined;
  let i = headerAt + 1;
  // Question text: everything up to the first option row.
  for (; i < footer.start; i++) {
    const row = rows[i]!;
    if (OPTION.test(row)) break;
    if (row === '') continue;
    if (!/^ {2}\S/.test(row)) return undefined;
    promptLines.push(row.trim());
  }
  // Options, each optionally followed by wrapped description rows.
  for (; i < footer.start; i++) {
    const row = rows[i]!;
    const option = OPTION.exec(row);
    if (option) {
      const [, pointer, box, digit, rest] = option;
      const number = Number(digit);
      if (number !== options.length + 1) return undefined;
      const hasBox = box !== undefined;
      if (checkboxes === undefined) checkboxes = hasBox;
      else if (checkboxes !== hasBox) return undefined;
      const split = /^(.*?\S)(?: {2,}(\S.*))?$/.exec(rest!);
      if (!split) return undefined;
      const label = split[1]!;
      const description = split[2] ?? '';
      if (pointer === '❯') {
        if (highlighted) return undefined;
        highlighted = number;
      }
      options.push({
        number, label, description, other: false,
        ...(hasBox ? { checked: box === '✓' } : {}),
      });
      continue;
    }
    if (row === '') continue;
    // A wrapped description row sits in the description column, right of the
    // labels (which start at column 7, or 11 behind a checkbox). Measured in
    // leading spaces only, so wide (CJK) labels need no cell-width table.
    if (options.length && DESCRIPTION_CONTINUATION.test(row) && options[options.length - 1]!.description) {
      const last = options[options.length - 1]!;
      last.description = `${last.description} ${row.trim()}`;
      continue;
    }
    break;
  }
  if (options.length < 2 || !highlighted || promptLines.length === 0) return undefined;
  const other = options[options.length - 1]!;
  const multiSelect = checkboxes === true;
  if (other.label !== (multiSelect ? 'Other' : 'None of the above') || !OTHER_DESCRIPTION.test(other.description)) {
    return undefined;
  }
  other.other = true;
  // The notes footer drops `space toggle`; with the options focused it is
  // there exactly when the rows carry checkboxes.
  if (notesOpen ? hints.has('space toggle') : multiSelect !== hints.has('space toggle')) return undefined;

  // Below the options: nothing (notes closed) or the notes field.
  const tail = rows.slice(i, footer.start).filter(row => row !== '');
  let notesText: string | undefined;
  if (!notesOpen) {
    if (tail.length) return undefined;
  } else {
    if (tail.length < 2 || !RULE.test(tail[0]!) || !RULE.test(tail[tail.length - 1]!)) return undefined;
    const inner = tail.slice(1, -1);
    if (inner.length) {
      const first = NOTES_ROW.exec(inner[0]!);
      if (!first || inner.slice(1).some(row => !/^ {2}\S|^ {4}/.test(row) || RULE.test(row))) return undefined;
      const text = [first[1]!, ...inner.slice(1).map(row => row.trim())].join('\n').trim();
      notesText = text === NOTES_PLACEHOLDER ? '' : text;
    }
  }

  return {
    index,
    total,
    ...(header[3] !== undefined ? { unanswered: Number(header[3]) } : {}),
    prompt: promptLines.join(' '),
    multiSelect,
    options,
    highlighted,
    notesOpen,
    ...(notesOpen && notesText !== undefined ? { notesText } : {}),
    submitAll,
  };
}

/** A screen row as the worker's display snapshots render it: box-drawing
 *  characters blanked, runs of spaces collapsed (TerminalRenderer's default
 *  cleanup), trimmed. Exact captures normalize to the same text. */
function normalizedRow(row: string): string {
  return row.replace(/[─━│┌┐└┘├┤┬┴┼╭╮╯╰]/g, ' ').replace(/ {2,}/g, ' ').trim();
}

/** Visible non-empty rows, normalized (see normalizedRow). */
function normalizedRows(screen: string): string[] {
  return visibleRows(screen).map(normalizedRow).filter(Boolean);
}

const LOOSE_HEADER = /^Question [1-9]\d?\/[1-9]\d?(?: \(\d+ unanswered\))?$/;
const LOOSE_OPTION = /^(?:❯ )?(?:\[[ ✓]\] )?([1-9])\. (\S.*)$/;

/** The question page by its fixed chrome only, on an exact capture or a
 *  normalized display snapshot (where the label / description columns are
 *  gone): the footer as the last row(s), a `Question N/M` header above it and
 *  numbered options ending with TRAE's own "None of the above" / "Other" row.
 *  Decides whether input is held — never what a card offers. */
function looseQuestionPageVisible(rows: string[]): boolean {
  let footerAt = rows.length;
  const hints: string[] = [];
  while (footerAt > 0 && rows.length - footerAt < 2) {
    const row = rows[footerAt - 1]!.split(' | ');
    if (!row.every(hint => FOOTER_HINTS.has(hint))) break;
    hints.unshift(...row);
    footerAt--;
  }
  if (footerAt === rows.length) return false;
  const set = new Set(hints);
  if (set.size !== hints.length) return false;
  if (set.has('enter submit all') === set.has('enter submit answer')) return false;
  if (set.has('tab or esc clear notes') === set.has('tab add notes')) return false;
  let headerAt = -1;
  for (let i = footerAt - 1; i >= 0 && footerAt - i <= MAX_PAGE_ROWS; i--) {
    if (LOOSE_HEADER.test(rows[i]!)) { headerAt = i; break; }
  }
  if (headerAt < 0) return false;
  const body = rows.slice(headerAt + 1, footerAt);
  const numbers: number[] = [];
  let lastOption = -1;
  body.forEach((row, index) => {
    const option = LOOSE_OPTION.exec(row);
    if (option) {
      numbers.push(Number(option[1]));
      lastOption = index;
    }
  });
  if (numbers.length < 2 || numbers.some((number, index) => number !== index + 1)) return false;
  const other = LOOSE_OPTION.exec(body[lastOption]!)![2]!;
  const tail = [other, ...body.slice(lastOption + 1)].join(' ');
  return /^(?:None of the above|Other) Optionally, add details in notes/.test(tail);
}

function looseConfirmPageVisible(rows: string[]): boolean {
  const tail = rows.slice(-5);
  return tail.length === 5
    && tail[0] === 'Submit with unanswered questions?'
    && /^\d+ unanswered questions?$/.test(tail[1]!)
    && /^(?:❯ )?1\. Proceed Submit with \d+ unanswered questions?\.$/.test(tail[2]!)
    && /^(?:❯ )?2\. Go back Return to the first unanswered question\.$/.test(tail[3]!)
    && tail[4] === 'enter confirm | esc go back';
}

/** "Submit with unanswered questions?" — the confirmation a multiSelect
 *  Enter with nothing ticked opens. Enter there submits the batch. */
export function isTraexQuestionConfirmPage(screen: string): boolean {
  return !!screen && looseConfirmPageVisible(normalizedRows(screen));
}

/** Any page of TRAE's question flow, on an exact capture or a normalized
 *  display snapshot: typed or pasted text must not reach it. */
export function traexQuestionFlowVisible(screen: string): boolean {
  if (!screen) return false;
  const rows = normalizedRows(screen);
  return looseQuestionPageVisible(rows) || looseConfirmPageVisible(rows);
}

/** Identity of a question (not of its pointer / ticks / notes): a card
 *  belongs to exactly this question of this batch. */
export function traexQuestionSignature(page: TraexQuestionPage): string {
  return JSON.stringify([
    page.index, page.total, page.multiSelect, page.prompt,
    page.options.map(option => [option.label, option.description]),
  ]);
}

/** Pointer, ticks and notes: what one key changes on the same question. */
export function traexQuestionState(page: TraexQuestionPage): string {
  return JSON.stringify([
    page.highlighted, page.notesOpen, page.notesText ?? null,
    page.options.map(option => option.checked ?? null),
  ]);
}

/** The card question for one page. Option keys are the digits TRAE shows;
 *  its own "None of the above"/"Other" row becomes the card's custom answer. */
export function traexQuestionAskQuestion(page: TraexQuestionPage): AskQuestion {
  const prompt = page.total > 1 ? `(${page.index}/${page.total}) ${page.prompt}` : page.prompt;
  return {
    prompt,
    multiSelect: page.multiSelect,
    options: page.options.filter(option => !option.other).map(option => ({
      key: String(option.number),
      label: option.label,
      ...(option.description ? { description: option.description } : {}),
    })),
  };
}

export type TraexQuestionAnswer =
  | { kind: 'options'; numbers: number[] }
  | { kind: 'custom'; text: string };

/** Longest custom answer typed into the notes field (the card itself caps a
 *  custom answer at 1000 characters). */
export const TRAEX_QUESTION_CUSTOM_MAX_LENGTH = 1000;

/** Text that may be pasted into the notes field: no control characters (an
 *  ESC could end the bracketed paste early and turn the rest into keys), line
 *  breaks folded into spaces (the field is one logical line), trimmed. */
export function sanitizeTraexQuestionNote(text: string): string {
  return text
    .replace(/\r\n?|\n/g, ' ')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f-\x9f]/g, '')
    .replace(/ {2,}/g, ' ')
    .trim()
    .slice(0, TRAEX_QUESTION_CUSTOM_MAX_LENGTH);
}

/** Map a card result for `page` to what to enter; a string is the reason it
 *  cannot be entered. */
export function traexQuestionAnswerFromAsk(page: TraexQuestionPage, result: AskResult): TraexQuestionAnswer | string {
  if (result.kind !== 'answered') return `not answered (${result.kind})`;
  const selected = result.answers?.[0] ?? [];
  const custom = result.customAnswers?.[0]?.trim()
    || (selected.length === 0 ? result.comment?.trim() : '')
    || '';
  if (custom) {
    const text = sanitizeTraexQuestionNote(custom);
    return text ? { kind: 'custom', text } : 'empty custom answer';
  }
  const real = page.options.filter(option => !option.other);
  const numbers: number[] = [];
  for (const key of selected) {
    const option = real.find(candidate => String(candidate.number) === key);
    if (!option || numbers.includes(option.number)) return 'answer does not match the question';
    numbers.push(option.number);
  }
  if (numbers.length === 0) return 'no option selected';
  if (!page.multiSelect && numbers.length !== 1) return 'more than one option for a single-choice question';
  return { kind: 'options', numbers: numbers.sort((a, b) => a - b) };
}

export type TraexQuestionStep =
  | { kind: 'key'; key: string; final: boolean }
  | { kind: 'paste'; text: string }
  | { kind: 'fail'; reason: string };

/** The visible notes hold exactly `text` (the field wraps long text). */
function notesHold(notes: string, text: string): boolean {
  const squash = (value: string) => value.replace(/\s+/g, '');
  return squash(notes) === squash(text);
}

/** Up/Down towards `target` on the shortest way round (the list wraps). */
function moveTowards(page: TraexQuestionPage, target: number): TraexQuestionStep {
  const count = page.options.length;
  const down = (target - page.highlighted + count) % count;
  const up = (page.highlighted - target + count) % count;
  return { kind: 'key', key: down <= up ? 'Down' : 'Up', final: false };
}

/**
 * The next single input that moves `page` towards `answer`, decided from the
 * page as it is on screen now (the caller re-captures before every step).
 * Never touches notes someone else typed, never clears anything.
 */
export function nextTraexQuestionStep(page: TraexQuestionPage, answer: TraexQuestionAnswer): TraexQuestionStep {
  const other = page.options[page.options.length - 1]!.number;
  if (answer.kind === 'options') {
    if (page.notesOpen) return { kind: 'fail', reason: 'the notes field is open' };
    if (!page.multiSelect) {
      const [number] = answer.numbers;
      if (answer.numbers.length !== 1 || !number || number >= other) return { kind: 'fail', reason: 'invalid option' };
      // One digit selects and submits the option.
      return { kind: 'key', key: String(number), final: true };
    }
    const wanted = new Set(answer.numbers);
    if (wanted.has(other) || wanted.size === 0) return { kind: 'fail', reason: 'invalid option' };
    for (const option of page.options) {
      if ((option.checked === true) !== wanted.has(option.number)) {
        return { kind: 'key', key: String(option.number), final: false };
      }
    }
    return { kind: 'key', key: 'Enter', final: true };
  }
  // Custom answer: "None of the above" / "Other" with the text as its note.
  if (page.multiSelect && !page.notesOpen) {
    for (const option of page.options) {
      if (!option.other && option.checked) return { kind: 'key', key: String(option.number), final: false };
    }
    if (!page.options[other - 1]!.checked) return { kind: 'key', key: String(other), final: false };
  }
  if (!page.notesOpen) {
    if (page.highlighted !== other) return moveTowards(page, other);
    return { kind: 'key', key: 'Tab', final: false };
  }
  if (page.highlighted !== other) return { kind: 'fail', reason: 'the notes field belongs to another option' };
  if (page.notesText === undefined) return { kind: 'fail', reason: 'the notes field is not visible' };
  if (page.notesText === '') return { kind: 'paste', text: answer.text };
  if (notesHold(page.notesText, answer.text)) return { kind: 'key', key: 'Enter', final: true };
  return { kind: 'fail', reason: 'the notes field already holds other text' };
}

/** Defence in depth for the writer: the only inputs an answer may send on
 *  this page. Digits pick an existing option and Up/Down/Tab move inside the
 *  page — all only while the options have focus (with the notes field open a
 *  digit would become note text); a paste only into the empty notes field;
 *  Enter submits. */
export function traexQuestionStepAllowed(page: TraexQuestionPage, step: TraexQuestionStep): boolean {
  if (step.kind === 'fail') return false;
  if (step.kind === 'paste') return page.notesOpen && page.notesText === '' && step.text.length > 0
    && step.text === sanitizeTraexQuestionNote(step.text);
  const { key } = step;
  if (key === 'Enter') return true;
  if (page.notesOpen) return false;
  if (key === 'Up' || key === 'Down' || key === 'Tab') return true;
  return /^[1-9]$/.test(key) && Number(key) <= page.options.length;
}
