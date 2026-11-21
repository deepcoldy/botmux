import MarkdownIt from 'markdown-it';
import type { RuleInline } from 'markdown-it/lib/parser_inline.mjs';
// @ts-expect-error markdown-it does not publish a declaration for this inline rule
import markdownLink from 'markdown-it/lib/rules_inline/link.mjs';
// @ts-expect-error markdown-it does not publish a declaration for this inline rule
import markdownImage from 'markdown-it/lib/rules_inline/image.mjs';
import type {
  LinkRefCandidate,
  LinkRefExtractionResult,
  LinkRefExtractionStats,
  LinkRefSourceInput,
  LinkRefSourceType,
} from './link-ref-types.js';

export interface HttpUrlSpan {
  start: number;
  end: number;
  originalUrl: string;
}

const URL_SCHEME_RE = /https?:\/\//giu;
const HARD_URL_TERMINATOR_RE = /[\s\u0000-\u001f\u007f<>"'`，。、；：！？【】《》〈〉「」『』“”‘’]/u;
const TRAILING_EXTERNAL_PUNCTUATION_RE = /[.,;!。，、；：！？）】》〉」』”’]/u;
const CLOSING_TO_OPENING = new Map([
  [')', '('],
  [']', '['],
  ['}', '{'],
]);

function occurrences(value: string, needle: string): number {
  let count = 0;
  for (const char of value) {
    if (char === needle) count += 1;
  }
  return count;
}

function trimExternalUrlSuffix(candidate: string): string {
  let value = candidate;
  while (value) {
    const last = value.at(-1)!;
    const opening = CLOSING_TO_OPENING.get(last);
    if (opening && occurrences(value, last) > occurrences(value, opening)) {
      value = value.slice(0, -1);
      continue;
    }
    if (TRAILING_EXTERNAL_PUNCTUATION_RE.test(last)) {
      value = value.slice(0, -1);
      continue;
    }
    break;
  }
  return value;
}

function isValidHttpUrl(originalUrl: string): boolean {
  const authority = /^https?:\/\/([^/?#]*)/iu.exec(originalUrl)?.[1];
  if (!authority) return false;
  try {
    const parsed = new URL(originalUrl);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:')
      && parsed.hostname.length > 0
      && parsed.username.length === 0
      && parsed.password.length === 0;
  } catch {
    return false;
  }
}

const MARKDOWN = new MarkdownIt();
interface MarkdownDestination {
  start: number;
  end: number;
  labelEnd: number;
}
interface DestinationEnv {
  sourceText?: string;
  destinations?: MarkdownDestination[];
}

function trackInlineDestinations(rule: RuleInline, bracketOffset: number): RuleInline {
  return (state, silent) => {
    const env = state.env as DestinationEnv;
    // Image alt text is tokenized again in a substring with the same env.
    // Only ranges in this block's root inline source have matching offsets.
    if (silent || state.src !== env.sourceText || !env.destinations
      || state.src[state.pos + bracketOffset] !== '[') return rule(state, silent);
    const labelEnd = state.md.helpers.parseLinkLabel(state, state.pos + bracketOffset, bracketOffset === 0);
    const handled = rule(state, silent);
    if (!handled || labelEnd < 0 || state.src[labelEnd + 1] !== '('
      || state.pos <= labelEnd + 2 || state.src[state.pos - 1] !== ')') return handled;

    let start = labelEnd + 2;
    while (/[ \t\n]/u.test(state.src[start] ?? '')) start += 1;
    const destination = state.md.helpers.parseLinkDestination(state.src, start, state.posMax);
    if (destination.ok) {
      const angle = state.src[start] === '<';
      env.destinations.push({
        start: start + (angle ? 1 : 0),
        end: destination.pos - (angle ? 1 : 0),
        labelEnd,
      });
    }
    return handled;
  };
}
MARKDOWN.inline.ruler.at('link', trackInlineDestinations(markdownLink, 0));
MARKDOWN.inline.ruler.at('image', trackInlineDestinations(markdownImage, 1));

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '\n') starts.push(index + 1);
  }
  return starts;
}

function lineAt(starts: readonly number[], offset: number): number {
  let low = 0;
  let high = starts.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (starts[middle]! <= offset) low = middle + 1;
    else high = middle;
  }
  return low - 1;
}

function inlineLinkDestinations(text: string): { ends: Map<number, number>; boundaries: number[] } {
  const ends = new Map<number, number>();
  const boundaries = new Set<number>();
  if (!text.includes('](')) return { ends, boundaries: [] };
  const rawStarts = lineStarts(text);
  const env = {};
  let row: { text: string; offsets: number[]; cursor: number } | undefined;
  // Use actual block-inline regions: links cannot cross paragraphs or execute
  // inside code blocks. Map normalized inline offsets back to untouched bytes.
  for (const token of MARKDOWN.parse(text, env)) {
    if (token.type === 'tr_open' && token.map) {
      const start = rawStarts[token.map[0]]!;
      const raw = text.slice(start, rawStarts[token.map[0] + 1] ?? text.length).replace(/\r?\n$/, '');
      row = { text: '', offsets: [], cursor: 0 };
      for (let index = 0; index < raw.length; index += 1) {
        // The table block rule removes the backslash from escaped pipes in cells.
        if (raw[index] === '\\' && raw[index + 1] === '|') continue;
        row.text += raw[index];
        row.offsets.push(start + index);
      }
    } else if (token.type === 'tr_close') row = undefined;
    if (token.type !== 'inline') continue;
    let cellStart: number | undefined;
    if (!token.map) {
      if (!row) continue;
      const match = row.text.indexOf(token.content, row.cursor);
      if (match < 0) continue;
      cellStart = match;
      row.cursor = match + token.content.length;
    }
    const destinations: MarkdownDestination[] = [];
    MARKDOWN.inline.parse(token.content, MARKDOWN, { ...env, sourceText: token.content, destinations }, []);
    if (destinations.length === 0) continue;
    const inlineStarts = lineStarts(token.content);
    const lineBases = new Map<number, number | undefined>();
    const mapOffset = (offset: number): number | undefined => {
      if (cellStart !== undefined) return row?.offsets[cellStart + offset];
      const line = lineAt(inlineStarts, offset);
      if (lineBases.has(line)) {
        const base = lineBases.get(line);
        return base === undefined ? undefined : base + offset;
      }
      const rawStart = rawStarts[token.map![0] + line];
      if (rawStart === undefined) return undefined;
      const rawLine = text.slice(rawStart, rawStarts[token.map![0] + line + 1] ?? text.length).replace(/\r?\n$/, '');
      const inlineStart = inlineStarts[line]!;
      const inlineLine = token.content.slice(inlineStart, inlineStarts[line + 1] ?? token.content.length).replace(/\n$/, '');
      const trimmed = inlineLine.trimStart();
      const leading = inlineLine.length - trimmed.length;
      const match = rawLine.indexOf(trimmed);
      const base = match < 0 ? undefined : rawStart + match - inlineStart - leading;
      lineBases.set(line, base);
      return base === undefined ? undefined : base + offset;
    };
    for (const destination of destinations) {
      const start = mapOffset(destination.start);
      const end = mapOffset(destination.end);
      const labelEnd = mapOffset(destination.labelEnd);
      if (start === undefined || end === undefined || labelEnd === undefined) continue;
      const rawDestination = text.slice(start, end);
      const inlineDestination = cellStart === undefined
        ? rawDestination : rawDestination.replace(/\\\|/gu, '|');
      if (inlineDestination !== token.content.slice(destination.start, destination.end)
        || text[labelEnd] !== ']') continue;
      ends.set(start, end);
      boundaries.add(start);
      boundaries.add(labelEnd);
    }
  }
  return { ends, boundaries: [...boundaries].sort((left, right) => left - right) };
}

export function extractHttpUrlSpans(text: string): HttpUrlSpan[] {
  // A complete URL string is an opaque value, including any Markdown-looking
  // characters in its path/query. Do not reinterpret structured URL fields.
  if (/^https?:\/\//iu.test(text) && !HARD_URL_TERMINATOR_RE.test(text) && isValidHttpUrl(text)) {
    return [{ start: 0, end: text.length, originalUrl: text }];
  }
  const spans: HttpUrlSpan[] = [];
  const { ends: destinationEnds, boundaries } = inlineLinkDestinations(text);
  let boundaryIndex = 0;
  URL_SCHEME_RE.lastIndex = 0;
  for (let match = URL_SCHEME_RE.exec(text); match; match = URL_SCHEME_RE.exec(text)) {
    const start = match.index;
    const destinationEnd = destinationEnds.get(start);
    while (boundaryIndex < boundaries.length && boundaries[boundaryIndex]! <= start) boundaryIndex += 1;
    const limit = boundaries[boundaryIndex] ?? text.length;
    let scanEnd = destinationEnd ?? URL_SCHEME_RE.lastIndex;
    if (destinationEnd === undefined) {
      while (scanEnd < limit && !HARD_URL_TERMINATOR_RE.test(text[scanEnd]!)) scanEnd += 1;
    }
    // A closed inline link provides an exact boundary. Its closing parenthesis,
    // emphasis markers and following text are not part of the destination URL.
    const end = destinationEnd ?? scanEnd;
    const originalUrl = destinationEnd === undefined
      ? trimExternalUrlSuffix(text.slice(start, end))
      : text.slice(start, end);
    if (originalUrl && isValidHttpUrl(originalUrl)) {
      spans.push({ start, end: start + originalUrl.length, originalUrl });
    }
    URL_SCHEME_RE.lastIndex = Math.max(end, URL_SCHEME_RE.lastIndex);
  }
  return spans;
}

const CREDENTIAL_LEAF_FIELDS = new Set([
  'password',
  'passwd',
  'secret',
  'clientsecret',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'sessiontoken',
  'apikey',
  'privatekey',
]);

const HEADER_CREDENTIAL_FIELDS = new Set([
  'authorization',
  'proxyauthorization',
  'cookie',
  'setcookie',
]);

const HEADER_CONTAINER_FIELDS = new Set(['headers', 'requestheaders']);
const AUTH_HEADER_VALUE_RE = /^\s*(?:bearer|basic|digest|negotiate|ntlm|token|aws4-hmac-sha256)\s+\S/iu;

function normalizeField(field: string): string {
  return field.toLowerCase().replace(/[-_]/g, '');
}

function excludedByMetadata(value: Record<string, unknown>): boolean {
  const metadata = value._meta;
  return Boolean(
    metadata
    && typeof metadata === 'object'
    && !Array.isArray(metadata)
    && (metadata as Record<string, unknown>)['botmux/linkRefPolicy'] === 'exclude',
  );
}

function emptyStats(): LinkRefExtractionStats {
  return {
    scannedBytes: 0,
    found: 0,
    candidateCount: 0,
    filteredCredential: 0,
    filteredMetadata: 0,
    filteredInvalid: 0,
  };
}

function pushTextCandidates(input: {
  text: string;
  sourceType: LinkRefSourceType;
  sourceId?: string;
  candidates: LinkRefCandidate[];
  seen: Set<string>;
  stats: LinkRefExtractionStats;
}): void {
  input.stats.scannedBytes += Buffer.byteLength(input.text);
  const spans = extractHttpUrlSpans(input.text);
  input.stats.found += spans.length;
  for (const span of spans) {
    if (input.seen.has(span.originalUrl)) continue;
    input.seen.add(span.originalUrl);
    input.candidates.push({
      originalUrl: span.originalUrl,
      sourceType: input.sourceType,
      ...(input.sourceId === undefined ? {} : { sourceId: input.sourceId }),
    });
  }
}

function collectStructured(input: {
  value: unknown;
  sourceType: LinkRefSourceType;
  sourceId?: string;
  field?: string;
  parentField?: string;
  parentType?: string;
  candidates: LinkRefCandidate[];
  seen: Set<string>;
  stats: LinkRefExtractionStats;
}): void {
  const { value } = input;
  if (typeof value === 'string') {
    const field = input.field === undefined ? undefined : normalizeField(input.field);
    const parentField = input.parentField === undefined ? undefined : normalizeField(input.parentField);
    const underHeaders = parentField !== undefined && HEADER_CONTAINER_FIELDS.has(parentField);
    const binaryPayload = field === 'blob'
      || (field === 'data' && (input.parentType === 'image' || input.parentType === 'audio'));
    const credential = (field !== undefined && CREDENTIAL_LEAF_FIELDS.has(field))
      || (underHeaders && field !== undefined && HEADER_CREDENTIAL_FIELDS.has(field))
      || AUTH_HEADER_VALUE_RE.test(value);
    if (binaryPayload) return;
    if (credential) {
      input.stats.filteredCredential += 1;
      return;
    }
    pushTextCandidates({ ...input, text: value });
    return;
  }
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) collectStructured({ ...input, value: item });
    return;
  }

  const record = value as Record<string, unknown>;
  if (excludedByMetadata(record)) {
    input.stats.filteredMetadata += 1;
    return;
  }
  const parentType = typeof record.type === 'string' ? record.type.toLowerCase() : undefined;
  for (const [field, child] of Object.entries(record)) {
    collectStructured({
      ...input,
      value: child,
      field,
      parentField: input.field,
      parentType,
    });
  }
}

export function collectLinkRefCandidates(
  sources: readonly LinkRefSourceInput[],
): LinkRefExtractionResult {
  const candidates: LinkRefCandidate[] = [];
  const seen = new Set<string>();
  const stats = emptyStats();

  for (const source of sources) {
    if (source.kind === 'attachment_text') continue;
    const shared = {
      sourceType: source.sourceType,
      sourceId: source.sourceId,
      candidates,
      seen,
      stats,
    };
    if (source.kind === 'text') {
      pushTextCandidates({ ...shared, text: source.text });
    } else {
      collectStructured({ ...shared, value: source.value });
    }
  }
  stats.candidateCount = candidates.length;
  return { candidates, stats };
}
