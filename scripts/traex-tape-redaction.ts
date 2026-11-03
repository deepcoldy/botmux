/**
 * Redaction and screen-activity rules for TraeX terminal tapes
 * (scripts/record-traex-tape.ts, replayed by test/helpers/traex-tape-player.mjs).
 *
 * A tape is committed to a public repository, so everything that identifies
 * the recording machine or account must be removed: the banner greeting's
 * display name, a personal OS login, home/work paths and provider model
 * names. Kept separate from the recorder so the rules are unit-testable
 * (test/traex-tape-redaction.test.ts).
 *
 * Design, after boundary-based variants each leaked a different shape (CJK
 * prose, `Alice_Smith`, `Alice-Smith@…`) and plain substring replacement
 * corrupted control sequences (`Mac` matching `\x1b[32mAccess`):
 *  - Strings are TOKENIZED into terminal control sequences and text. Control
 *    sequences are preserved byte-for-byte; only text (and OSC payloads such
 *    as window titles) is redacted. The PTY stream is tokenized as ONE stream
 *    and cut back at the original chunk boundaries, so a sequence or a name
 *    split across node-pty callbacks is still handled.
 *  - Within text, identifying tokens are replaced as case-insensitive
 *    substrings — no word boundaries. ASCII tokens shorter than 3 are refused.
 *  - Only known free-text fields are rewritten (FREE_TEXT_FIELDS). Ids,
 *    types, phases, other enums and property names never are; a secret found
 *    there fails the final check, so a collision (`Fin` in `final_answer`)
 *    refuses the recording instead of silently changing replay behaviour.
 *  - Replacement widths are measured with the same headless xterm the worker
 *    renders through, so cursor-addressed repaints replay at identical columns.
 *  - The final check removes control sequences, then scans every value and
 *    property name, with the PTY chunks joined into one stream — so a name
 *    split by style codes ("Ali\x1b[0mce") refuses the recording.
 *  - Shared service accounts (root, runner, …) identify nobody and are not
 *    treated as secrets; a personal OS login is treated like a name.
 */
import xterm from '@xterm/headless';

const { Terminal } = xterm;

/** CSI, OSC (params group 1, payload group 2, terminator group 3), charset
 *  designation and other two-byte ESC sequences. The two-byte fallback
 *  excludes "[" and "]": those only introduce CSI/OSC, so an unfinished
 *  "\x1b[" is NOT a complete sequence. */
// eslint-disable-next-line no-control-regex
const CONTROL = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\](\d*;?)([^\x07\x1b]*)(\x07|\x1b\\)|\x1b[()][0-9A-Za-z]|\x1b[ -/]*[0-Z\\^-~]/g;

export function stripAnsi(data: string): string {
  return data.replace(CONTROL, '');
}

/**
 * A chunk that leaves the screen structure alone while TraeX sits idle: the
 * banner logo's eyes (◆/─, at most a couple of glyphs), cursor moves, cursor
 * shape/visibility, synchronized-update brackets and title updates. Anything
 * that erases, scrolls, inserts/deletes or feeds lines is real activity — the
 * post-turn redraw starts with "\x1b[23;1H\x1b[J" (erase below). Independent
 * of how node-pty splits a repaint across callbacks.
 * The tape player applies the same rule (kept in sync there, plain JS).
 */
// eslint-disable-next-line no-control-regex
const SCREEN_MUTATION = /\x1b\[[0-9;?]*[JKLMPSTX@]|\x1b[MDEc]|\n/;
export function isIdleRepaintChunk(data: string): boolean {
  return !SCREEN_MUTATION.test(data) && /^[◆─]{0,4}$/.test(stripAnsi(data));
}

/**
 * Display name from a COMPLETE banner greeting row. The salutation varies
 * ("Hello", "Good afternoon", …). Both name endpoints exclude the box edge
 * and whitespace: a cursor-addressed repaint can butt the next row's border
 * against this one ("Alice     ││…"), and a chunk can end mid-name, so only a
 * row whose closing border is present is trusted.
 */
export function parseGreetingName(visible: string): string | undefined {
  return visible.match(/│ [A-Z][a-z]+(?: [a-z]+)?, ([^\s│](?:[^│\n]*[^\s│])?)[ \t]*│/)?.[1];
}

/** Terminal cells per string, as laid out by the worker's headless
 *  TerminalRenderer (same package, default Unicode provider). */
export type CellWidth = (text: string) => number;

const isAscii = (text: string) => /^[\x20-\x7e]*$/.test(text);

export async function measureReplayCells(texts: Iterable<string>): Promise<CellWidth> {
  const term = new Terminal({ cols: 1000, rows: 2, allowProposedApi: true });
  const widths = new Map<string, number>();
  try {
    for (const text of new Set(texts)) {
      if (isAscii(text)) continue;
      await new Promise<void>(resolve => term.write(`\r\x1b[2K${text}`, resolve));
      widths.set(text, term.buffer.active.cursorX);
    }
  } finally {
    term.dispose();
  }
  return (text) => {
    if (isAscii(text)) return text.length;
    const width = widths.get(text);
    if (width === undefined) throw new Error(`no replay width measured for "${text}"`);
    return width;
  };
}

export interface TapeSecrets {
  accountName: string;
  osUser: string;
  homeDir: string;
  workDir: string;
  modelNames: Iterable<string>;
}

const GENERIC_OS_USERS = new Set(['root', 'admin', 'administrator', 'runner', 'ubuntu', 'debian', 'ec2-user', 'node', 'user']);

/** An ASCII token this short cannot be redacted safely and must not be
 *  published either. */
const MIN_ASCII_SECRET = 3;

/** The ONLY fields whose string values are rewritten: free text the tape
 *  carries (PTY bytes, prompts, user/assistant text, cwd, model). Every other
 *  field — ids, types, phases and any enum the worker bridge keys on — is
 *  never rewritten; if one carries a secret, the final check refuses the
 *  recording instead of silently changing replay behaviour. */
const FREE_TEXT_FIELDS = new Set(['data', 'text', 'message', 'last_agent_message', 'cwd', 'model', 'prompts']);

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function placeholder(base: string, width: number): string {
  return base.length >= width ? base.slice(0, width) : base.padEnd(width, '-');
}

/** Text spans of `s` (outside control sequences, plus OSC payloads). */
function textSpans(s: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  let cursor = 0;
  for (const m of s.matchAll(CONTROL)) {
    const start = m.index!;
    if (start > cursor) spans.push([cursor, start]);
    if (m[2] !== undefined && m[2].length > 0) {
      const payloadStart = start + 2 + m[1]!.length;
      spans.push([payloadStart, payloadStart + m[2].length]);
    }
    cursor = start + m[0].length;
  }
  if (cursor < s.length) spans.push([cursor, s.length]);
  return spans;
}

/** Visible text of `s` for checking: control sequences removed, OSC payloads
 *  kept on their own line. */
function checkText(s: string): string {
  return s.replace(CONTROL, (_m, _ps, payload) => (payload ? `\n${payload}\n` : ''));
}

/** Rewrite strings under FREE_TEXT_FIELDS (array items inherit the key). */
function mapFreeText<T>(value: T, fn: (text: string) => string, key?: string): T {
  if (typeof value === 'string') return (key !== undefined && FREE_TEXT_FIELDS.has(key) ? fn(value) : value) as T;
  if (Array.isArray(value)) return value.map(item => mapFreeText(item, fn, key)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, item]) => [k, mapFreeText(item, fn, k)])) as T;
  }
  return value;
}

function collectText(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const item of value) collectText(item, out);
  else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      out.push(key);
      collectText(item, out);
    }
  }
  return out;
}

/** Name/login tokens that must not appear in a tape, longest first. */
export function secretTokens(secrets: Pick<TapeSecrets, 'accountName' | 'osUser'>): string[] {
  const personalUser = !GENERIC_OS_USERS.has(secrets.osUser.toLowerCase());
  const tokens = [
    secrets.accountName,
    ...secrets.accountName.split(/\s+/),
    ...(personalUser ? [secrets.osUser] : []),
  ].filter(Boolean);
  for (const token of tokens) {
    if (isAscii(token) && token.length < MIN_ASCII_SECRET) {
      throw new Error(`"${token}" is too short to redact safely; refusing to record (use an account with a longer display name)`);
    }
  }
  return [...new Set(tokens)].sort((a, b) => b.length - a.length);
}

interface TapeLike { events?: Array<{ kind?: string; data?: unknown }> }

export function createTapeRedactor(secrets: TapeSecrets, cellWidth: CellWidth) {
  const nameTokens = secretTokens(secrets);
  const models = [...secrets.modelNames].filter(Boolean);
  // Longest alternative first so a full name wins over its parts.
  const rules = [
    ...[secrets.workDir, secrets.homeDir].filter(Boolean).map(token => ({ token, replacement: () => (token === secrets.workDir ? '{{CWD}}' : '{{HOME}}') })),
    ...nameTokens.map(token => ({ token, replacement: () => placeholder('tape-user', cellWidth(token)) })),
    ...models.map(token => ({ token, replacement: () => placeholder('tape-model', cellWidth(token)) })),
  ].sort((a, b) => b.token.length - a.token.length);
  // One capture group per rule: the matched group identifies the rule, with
  // the regex's own Unicode case folding (`ſmith` ~ `Smith`) — no second,
  // differently-folding string comparison.
  const matcher = new RegExp(rules.map(rule => `(${escapeRegExp(rule.token)})`).join('|'), 'giu');
  const ruleFor = (m: RegExpMatchArray) => rules[m.findIndex((group, i) => i > 0 && group !== undefined) - 1]!;

  /** Redact one logical stream given as chunks; returns chunks cut at the
   *  original boundaries (a replacement spanning one goes to the earlier). */
  const redactChunks = (chunks: string[]): string[] => {
    const joined = chunks.join('');
    const replacements: Array<{ start: number; end: number; text: string }> = [];
    for (const [from, to] of textSpans(joined)) {
      for (const m of joined.slice(from, to).matchAll(matcher)) {
        replacements.push({ start: from + m.index!, end: from + m.index! + m[0].length, text: ruleFor(m).replacement() });
      }
    }
    const out: string[] = [];
    let chunkStart = 0;
    let r = 0;
    let pos = 0;
    for (const chunk of chunks) {
      const chunkEnd = chunkStart + chunk.length;
      let piece = '';
      while (pos < chunkEnd) {
        const next = replacements[r];
        if (next && next.start === pos) {
          piece += next.text;
          pos = next.end;
          r += 1;
        } else {
          const stop = Math.min(chunkEnd, next ? next.start : chunkEnd);
          piece += joined.slice(pos, stop);
          pos = stop;
        }
      }
      out.push(piece);
      chunkStart = chunkEnd;
    }
    return out;
  };

  const redactString = (text: string): string => redactChunks([text])[0]!;

  const checks = [...nameTokens, secrets.homeDir, secrets.workDir, ...models]
    .filter(Boolean)
    .map(token => ({ token, pattern: new RegExp(escapeRegExp(token), 'iu') }));

  return {
    /** Redact free-text string values independently (see FREE_TEXT_FIELDS). */
    redact<T>(value: T): T {
      return mapFreeText(value, redactString);
    },
    /** Redact a tape: its PTY chunks as one stream, other free text per value. */
    redactTape<T extends TapeLike>(tape: T): T {
      const redacted = mapFreeText(tape, redactString);
      const ptyIndexes = (tape.events ?? []).flatMap((e, i) => (e.kind === 'pty' && typeof e.data === 'string' ? [i] : []));
      const streamed = redactChunks(ptyIndexes.map(i => tape.events![i]!.data as string));
      ptyIndexes.forEach((eventIndex, k) => { redacted.events![eventIndex]!.data = streamed[k]; });
      return redacted;
    },
    /** Throw if any secret survives in the text of values, property names or
     *  the extra texts. Control sequences are removed before matching. */
    assertClean(value: unknown, extraTexts: string[] = []): void {
      const haystacks = [...collectText(value), ...extraTexts].map(checkText);
      for (const { token, pattern } of checks) {
        if (haystacks.some(text => pattern.test(text))) throw new Error(`redaction left "${token}" in the tape`);
      }
    },
    /** assertClean for a tape: PTY chunks are checked as ONE stream (a chunk
     *  may start mid control sequence), everything else per value. */
    assertCleanTape(tape: TapeLike): void {
      const events = tape.events ?? [];
      const stream = events.flatMap(e => (e.kind === 'pty' && typeof e.data === 'string' ? [e.data] : [])).join('');
      const withoutPty = { ...tape, events: events.map(e => (e.kind === 'pty' ? { ...e, data: '' } : e)) };
      this.assertClean(withoutPty, [stream]);
    },
  };
}
