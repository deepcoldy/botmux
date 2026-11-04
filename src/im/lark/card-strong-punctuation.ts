import MarkdownIt from 'markdown-it';
import type Token from 'markdown-it/lib/token.mjs';
import { markdownLiteralRanges, type MarkdownLiteralRange } from '../../services/markdown-literal-ranges.js';

/**
 * Display-only repair for `**粗体**` that CommonMark refuses to pair because
 * punctuation sits just inside a delimiter whose outer side is a letter/CJK
 * character — the very common Chinese label shape `**空数据边界：**当前…`.
 *
 * A closing `**` preceded by punctuation and followed by a non-space,
 * non-punctuation character is not right-flanking, so it can only open; the
 * pair falls apart and Feishu's markdown component shows both `**` literally.
 * The mirror case (`说明**（重要）**`) breaks the opener the same way.
 *
 * The repair moves the punctuation run across the delimiter
 * (`**空数据边界**：当前`, `说明（**重要**）后面`). The text length and every
 * other byte stay the same. Each rewrite is accepted only when markdown-it,
 * parsing the whole document, then reports exactly one more same-line strong
 * span outside links with its asterisks no longer literal (see
 * {@link improvedBy}) — so code, escapes, link text, nesting and pairs that
 * already render are left byte-for-byte unchanged.
 */

const md = new MarkdownIt({ html: false, linkify: false });
const { isWhiteSpace, isPunctChar, isMdAsciiPunct } = md.utils;

/** Punctuation that may never be moved: Markdown/Feishu syntax characters
 * whose meaning depends on their position (escapes, emphasis, code, links,
 * `<font>`/`<at>` tags, strikethrough, table pipes, entities). */
const UNMOVABLE = new Set(['\\', '*', '_', '`', '[', ']', '<', '>', '|', '~', '&']);
/** How many rewrites are verified per probe parse in the fallback path. A
 * candidate that cannot pair as predicted (bold inside link text, a stray
 * trailing run) makes the whole-document gate fail; verifying in chunks keeps
 * the cost proportional to the number of bad candidates instead of to the
 * reply length, and — unlike a per-candidate budget — does not abandon the
 * candidates in the tail of a long reply. */
const FALLBACK_CHUNK = 32;

type CharClass = 'space' | 'punct' | 'other';

function classify(char: string | undefined): CharClass {
  // Line boundaries count as whitespace, as in markdown-it's scanDelims.
  if (char === undefined) return 'space';
  const code = char.codePointAt(0)!;
  if (isWhiteSpace(code)) return 'space';
  if (isMdAsciiPunct(code) || isPunctChar(char)) return 'punct';
  return 'other';
}

/** Split into code points so astral punctuation/emoji move as one unit. */
function chars(text: string): string[] {
  return Array.from(text);
}

function movable(char: string): boolean {
  return classify(char) === 'punct' && !UNMOVABLE.has(char);
}

interface Candidate {
  /** Offset of the opening `**` in the document. */
  start: number;
  /** Original source from the opener through the closer, inclusive. */
  before: string;
  after: string;
}

interface Metrics {
  /** Strong spans outside links that open and close on the same source line. */
  strong: number;
  /** Strong spans that swallow a line break — in this module's input these
   * are mis-pairings: a broken closer on one line opening a span that a
   * broken opener on a later line of the same paragraph then closes. */
  strongAcrossLines: number;
  strongInLink: number;
  links: number;
  em: number;
  literalStars: number;
}

function metrics(text: string): Metrics {
  const result: Metrics = { strong: 0, strongAcrossLines: 0, strongInLink: 0, links: 0, em: 0, literalStars: 0 };
  for (const token of md.parse(text, {})) {
    if (token.type !== 'inline' || !token.children) continue;
    let linkDepth = 0;
    const open: { inLink: boolean; acrossLines: boolean }[] = [];
    for (const child of token.children as Token[]) {
      if (child.type === 'link_open') { result.links++; linkDepth++; }
      else if (child.type === 'link_close') linkDepth = Math.max(0, linkDepth - 1);
      else if (child.type === 'strong_open') open.push({ inLink: linkDepth > 0, acrossLines: false });
      else if (child.type === 'strong_close') {
        const span = open.pop();
        if (span?.inLink) result.strongInLink++;
        else if (span?.acrossLines) result.strongAcrossLines++;
        else if (span) result.strong++;
      } else if (child.type === 'softbreak' || child.type === 'hardbreak') {
        for (const span of open) span.acrossLines = true;
      } else if (child.type === 'em_open') result.em++;
      else if (child.type === 'text') result.literalStars += child.content.split('*').length - 1;
    }
  }
  return result;
}

/** `pairs` rewrites must each yield one more same-line strong span. A
 * rewrite may also dissolve an existing cross-line mis-pairing, whose four
 * asterisks then become literal again unless another rewrite pairs them; it
 * must never create a cross-line span or touch links and single emphasis. */
function improvedBy(before: Metrics, after: Metrics, pairs: number): boolean {
  const dissolved = before.strongAcrossLines - after.strongAcrossLines;
  return dissolved >= 0
    && after.strong === before.strong + pairs
    && after.strongInLink === before.strongInLink
    && after.links === before.links
    && after.em === before.em
    && after.literalStars === before.literalStars - 4 * pairs + 4 * dissolved;
}

function insideLiteral(ranges: readonly MarkdownLiteralRange[], start: number, end: number): boolean {
  return ranges.some(range => start < range.end && end > range.start);
}

/** Exact-length `**` delimiter runs on one line, honouring backslash escapes. */
function strongRuns(line: string): number[] {
  const runs: number[] = [];
  for (let index = 0; index < line.length;) {
    if (line[index] === '\\') { index += 2; continue; }
    if (line[index] !== '*') { index++; continue; }
    let end = index;
    while (line[end] === '*') end++;
    if (end - index === 2) runs.push(index);
    index = end;
  }
  return runs;
}

/** Source span of a link label or image alt that markdown-it recognises:
 * `[LABEL](…)` / `![ALT](…)` (resolved reference forms are caught by the
 * strong-in-link gate, since per-line parsing has no reference definitions). */
interface LabelSpan { start: number; end: number }

/** A private parser whose inline link/image rules report the exact label spans
 * they accepted. Anchoring on a successful rule means a bracket that is not a
 * real link (one inside a code span, or one with an invalid destination) never
 * hides a repairable candidate, unlike a hand-rolled bracket scan. */
const labelProbe = new MarkdownIt({ html: false, linkify: false });
let labelSink: LabelSpan[] = [];
/** The exact string currently being parsed at top level. The image rule
 * re-parses its alt with a FRESH StateInline whose `src` is the alt slice, so a
 * link inside an alt reports alt-relative offsets; accepting those would skip a
 * repairable pair elsewhere on the line. Only spans measured against the line
 * itself are meaningful here. */
let labelSource = '';
function recognizedLabelClose(src: string, openBracket: number): number {
  // openBracket is the '[' of a label the link/image rule just validated; find
  // its close by bracket nesting (nested `[ ]` are allowed inside labels).
  let depth = 0;
  for (let index = openBracket; index < src.length; index++) {
    if (src[index] === '\\') { index++; continue; }
    if (src[index] === '[') depth++;
    else if (src[index] === ']') { depth--; if (depth === 0) return index; }
    else if (src[index] === '\n') return -1;
  }
  return -1;
}
for (const ruleName of ['link', 'image'] as const) {
  const rule = (labelProbe.inline.ruler as unknown as { __rules__: { name: string; fn: (state: any, silent: boolean) => boolean }[] })
    .__rules__.find(rule => rule.name === ruleName)!;
  const original = rule.fn;
  rule.fn = function wrapped(state: any, silent: boolean): boolean {
    const start = state.pos;
    const accepted = original.call(this, state, silent);
    if (accepted && !silent && state.src === labelSource) {
      const isImage = state.src.charCodeAt(start) === 0x21 /* ! */;
      if ((ruleName === 'image') === isImage) {
        const openBracket = start + (isImage ? 1 : 0);
        const close = recognizedLabelClose(state.src, openBracket);
        if (close > 0) labelSink.push({ start: openBracket + 1, end: close });
      }
    }
    return accepted;
  };
}

/** Link/image label interiors on this line, exactly as markdown-it parses
 * them. Link structure cannot span a line break, so per-line parsing agrees
 * with the document parse for this question. */
function recognizedLabelSpans(line: string): readonly LabelSpan[] {
  if (!line.includes('[')) return [];
  labelSink = [];
  labelSource = line;
  labelProbe.parseInline(line, {});
  const spans = labelSink;
  labelSink = [];
  labelSource = '';
  return spans;
}

function lineCandidates(
  line: string,
  lineStart: number,
  ranges: readonly MarkdownLiteralRange[],
  labels: readonly LabelSpan[],
): Candidate[] {
  const candidates: Candidate[] = [];
  const runs = strongRuns(line);
  for (let k = 0; k + 1 < runs.length; k++) {
    const open = runs[k]!;
    const close = runs[k + 1]!;
    const inner = line.slice(open + 2, close);
    if (!inner || /[*&<>[\]|~]/.test(inner)) continue;
    // The delimiters themselves must be live syntax; a code span between them
    // is fine (`**用 `bun`：**`), the moved punctuation sits next to them.
    if (insideLiteral(ranges, lineStart + open, lineStart + open + 2)
      || insideLiteral(ranges, lineStart + close, lineStart + close + 2)) continue;
    // A pair inside real link text or image alt can never pass the gate
    // (strong-in-link invariant) or be measured at all (image children); skip
    // it so it cannot spoil the batched verification for the whole reply.
    if (labels.some(label => open >= label.start && close + 2 <= label.end)) continue;
    // Bare URLs may be autolinked by Feishu; their bytes are not prose.
    const word = line.slice(0, close).split(/\s/).at(-1) ?? '';
    if (/:\/\/|www\./i.test(word)) continue;

    const innerChars = chars(inner);
    const prev = chars(line.slice(0, open)).at(-1);
    const next = chars(line.slice(close + 2))[0];
    let lead = 0;
    // Opener fails: letter outside, punctuation inside.
    if (classify(prev) === 'other' && classify(innerChars[0]) === 'punct') {
      while (lead < innerChars.length && movable(innerChars[lead]!)) lead++;
    }
    let trail = 0;
    // Closer fails: punctuation inside, letter outside.
    if (classify(next) === 'other' && classify(innerChars.at(-1)) === 'punct') {
      while (trail < innerChars.length - lead && movable(innerChars[innerChars.length - 1 - trail]!)) trail++;
    }
    if (!lead && !trail) continue;
    const core = innerChars.slice(lead, innerChars.length - trail);
    // Never leave an empty span or a space touching a delimiter.
    if (!core.length || classify(core[0]) === 'space' || classify(core.at(-1)) === 'space') continue;
    // Keep escapes intact: `\:` must not lose the character it escapes.
    if (core.at(-1) === '\\') continue;
    const before = line.slice(open, close + 2);
    const after = innerChars.slice(0, lead).join('') + '**' + core.join('') + '**'
      + innerChars.slice(innerChars.length - trail).join('');
    candidates.push({ start: lineStart + open, before, after });
  }
  return candidates;
}

function apply(text: string, candidates: readonly Candidate[]): string {
  let output = '';
  let cursor = 0;
  for (const candidate of candidates) {
    output += text.slice(cursor, candidate.start) + candidate.after;
    cursor = candidate.start + candidate.before.length;
  }
  return output + text.slice(cursor);
}

export function repairCardStrongPunctuation(input: string): string {
  if (!input.includes('**')) return input;
  const ranges = markdownLiteralRanges(input);
  const candidates: Candidate[] = [];
  let lineStart = 0;
  for (const line of input.split('\n')) {
    if (line.includes('**')) {
      const labels = recognizedLabelSpans(line);
      for (const candidate of lineCandidates(line, lineStart, ranges, labels)) {
        // Consecutive pairs share a run; keep the earlier, non-overlapping one.
        const last = candidates.at(-1);
        if (!last || candidate.start >= last.start + last.before.length) candidates.push(candidate);
      }
    }
    lineStart += line.length + 1;
  }
  if (!candidates.length) return input;

  const baseline = metrics(input);
  const batched = apply(input, candidates);
  if (improvedBy(baseline, metrics(batched), candidates.length)) return batched;

  // Some rewrite did not pair as expected (nesting across lines, link text,
  // unusual delimiter interplay). Fall back to verifying chunks, degrading the
  // offending chunk to one rewrite at a time.
  let output = input;
  let current = baseline;
  for (let index = 0; index < candidates.length; index += FALLBACK_CHUNK) {
    const chunk = candidates.slice(index, index + FALLBACK_CHUNK)
      .filter(candidate => output.slice(candidate.start, candidate.start + candidate.before.length) === candidate.before);
    if (!chunk.length) continue;
    const next = apply(output, chunk);
    const nextMetrics = metrics(next);
    if (improvedBy(current, nextMetrics, chunk.length)) { output = next; current = nextMetrics; continue; }
    for (const candidate of chunk) {
      if (output.slice(candidate.start, candidate.start + candidate.before.length) !== candidate.before) continue;
      const single = apply(output, [candidate]);
      const singleMetrics = metrics(single);
      if (!improvedBy(current, singleMetrics, 1)) continue;
      output = single;
      current = singleMetrics;
    }
  }
  return output;
}
