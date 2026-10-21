import type { LinkRefLedger } from './link-ref-ledger.js';
import { LinkRefError, type LinkRefTurnKey } from './link-ref-types.js';

const LINK_REF_SOURCE = String.raw`\{\{botmux_link:(lr_[0-9a-f]{32})\}\}`;
const LINK_REF_PATTERN = new RegExp(LINK_REF_SOURCE, 'g');
const FENCE_PATTERN = /^( {0,3})(`{3,}|~{3,})(.*)$/u;

interface RefSpan {
  start: number;
  end: number;
  refId: string;
  escaped: boolean;
}

export interface ExecutableLinkRefs {
  refIds: string[];
  expand(resolved: ReadonlyMap<string, string>): string;
}

export interface OutboundLinkRefPayload {
  text?: string;
  preparedText?: string;
  card?: Record<string, unknown>;
  completionProposal?: Record<string, unknown>;
  expectedLinks?: string[];
}

export interface ResolvedOutboundLinkRefs extends OutboundLinkRefPayload {
  refCount: number;
}

function countRun(text: string, index: number, char: '`'): number {
  let end = index;
  while (text[end] === char) end += 1;
  return end - index;
}

function lineEnd(text: string, index: number): number {
  const newline = text.indexOf('\n', index);
  return newline < 0 ? text.length : newline;
}

interface LiteralRange {
  start: number;
  end: number;
}

interface FenceLine {
  start: number;
  end: number;
  char: '`' | '~';
  runLength: number;
  canClose: boolean;
}

function fencedLiteralRanges(text: string): LiteralRange[] {
  const fences: FenceLine[] = [];
  for (let offset = 0; offset < text.length;) {
    const end = lineEnd(text, offset);
    const contentEnd = end > offset && text[end - 1] === '\r' ? end - 1 : end;
    const fence = FENCE_PATTERN.exec(text.slice(offset, contentEnd));
    if (fence) {
      const run = fence[2]!;
      fences.push({
        start: offset,
        end,
        char: run[0] as '`' | '~',
        runLength: run.length,
        canClose: fence[3]!.trim() === '',
      });
    }
    offset = end < text.length ? end + 1 : end;
  }

  const closerByFence = new Array<number | undefined>(fences.length);
  const nearestCloser = {
    '`': [] as Array<number | undefined>,
    '~': [] as Array<number | undefined>,
  };
  for (let index = fences.length - 1; index >= 0; index -= 1) {
    const fence = fences[index]!;
    const nearestForChar = nearestCloser[fence.char];
    closerByFence[index] = nearestForChar[fence.runLength];
    if (fence.canClose) {
      for (let runLength = 3; runLength <= fence.runLength; runLength += 1) {
        nearestForChar[runLength] = index;
      }
    }
  }

  const ranges: LiteralRange[] = [];
  for (let index = 0; index < fences.length;) {
    const closeIndex = closerByFence[index];
    if (closeIndex === undefined) {
      // An unmatched opener is ordinary model output, not a license to hide
      // every LinkRef that follows it.
      index += 1;
      continue;
    }
    ranges.push({ start: fences[index]!.start, end: fences[closeIndex]!.end });
    index = closeIndex + 1;
  }
  return ranges;
}

function inlineLiteralRanges(text: string, fenced: readonly LiteralRange[]): LiteralRange[] {
  const ranges: LiteralRange[] = [];
  let fenceIndex = 0;
  for (let offset = 0; offset < text.length;) {
    const end = lineEnd(text, offset);
    while (fenceIndex < fenced.length && fenced[fenceIndex]!.end < offset) fenceIndex += 1;
    if (fenced[fenceIndex]?.start === offset) {
      offset = fenced[fenceIndex]!.end < text.length ? fenced[fenceIndex]!.end + 1 : text.length;
      fenceIndex += 1;
      continue;
    }
    for (let index = offset; index < end;) {
      if (text[index] !== '`') {
        index += 1;
        continue;
      }
      const run = countRun(text, index, '`');
      let close = index + run;
      while (close < end) {
        if (text[close] !== '`') {
          close += 1;
          continue;
        }
        const closeRun = countRun(text, close, '`');
        if (closeRun === run) break;
        close += closeRun;
      }
      if (close >= end) {
        // CommonMark code spans do not cross a line. Leave an unmatched run
        // unprotected so a later LinkRef is still executable.
        index += run;
        continue;
      }
      ranges.push({ start: index, end: close + run });
      index = close + run;
    }
    offset = end < text.length ? end + 1 : end;
  }
  return ranges;
}

function tokenize(text: string): RefSpan[] {
  const spans: RefSpan[] = [];
  const fenced = fencedLiteralRanges(text);
  const literals = [...fenced, ...inlineLiteralRanges(text, fenced)]
    .sort((left, right) => left.start - right.start);
  let literalIndex = 0;
  LINK_REF_PATTERN.lastIndex = 0;
  for (let match = LINK_REF_PATTERN.exec(text); match; match = LINK_REF_PATTERN.exec(text)) {
    while (literalIndex < literals.length && literals[literalIndex]!.end <= match.index) literalIndex += 1;
    const literal = literals[literalIndex];
    if (literal && literal.start <= match.index && match.index < literal.end) continue;
    let slashCount = 0;
    for (let cursor = match.index - 1; cursor >= 0 && text[cursor] === '\\'; cursor -= 1) slashCount += 1;
    const escaped = slashCount % 2 === 1;
    spans.push({
      start: escaped ? match.index - 1 : match.index,
      end: LINK_REF_PATTERN.lastIndex,
      refId: match[1]!,
      escaped,
    });
  }
  return spans;
}

export function findExecutableLinkRefs(text: string): ExecutableLinkRefs {
  const spans = tokenize(text);
  const refIds = [...new Set(spans.filter((span) => !span.escaped).map((span) => span.refId))];
  return {
    refIds,
    expand(resolved) {
      if (spans.length === 0) return text;
      let output = '';
      let cursor = 0;
      for (const span of spans) {
        output += text.slice(cursor, span.start);
        if (span.escaped) {
          output += text.slice(span.start + 1, span.end);
        } else {
          const value = resolved.get(span.refId);
          if (value === undefined) throw new LinkRefError('link_ref_unknown');
          output += value;
        }
        cursor = span.end;
      }
      return output + text.slice(cursor);
    },
  };
}

function walkStrings(value: unknown, replace: (text: string) => string): unknown {
  if (typeof value === 'string') return replace(value);
  if (Array.isArray(value)) return value.map((entry) => walkStrings(entry, replace));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, walkStrings(entry, replace)]));
}

function validExpectedLink(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function tokenizeOutboundPayload(payload: OutboundLinkRefPayload): Map<string, ExecutableLinkRefs> {
  const tokenized = new Map<string, ExecutableLinkRefs>();
  const getTokenized = (text: string): ExecutableLinkRefs => {
    const existing = tokenized.get(text);
    if (existing) return existing;
    const found = findExecutableLinkRefs(text);
    tokenized.set(text, found);
    return found;
  };
  if (payload.text !== undefined) getTokenized(payload.text);
  if (payload.preparedText !== undefined) getTokenized(payload.preparedText);
  if (payload.expectedLinks) for (const expectedLink of payload.expectedLinks) getTokenized(expectedLink);
  if (payload.card) walkStrings(payload.card, (text) => { getTokenized(text); return text; });
  if (payload.completionProposal) {
    walkStrings(payload.completionProposal, (text) => { getTokenized(text); return text; });
  }
  return tokenized;
}

export function findOutboundExecutableLinkRefs(payload: OutboundLinkRefPayload): string[] {
  return [...new Set(
    [...tokenizeOutboundPayload(payload).values()].flatMap((entry) => entry.refIds),
  )];
}

export function expandOutboundLinkRefs(
  payload: OutboundLinkRefPayload,
  resolved: ReadonlyMap<string, string>,
): ResolvedOutboundLinkRefs {
  const tokenized = tokenizeOutboundPayload(payload);
  const getTokenized = (text: string): ExecutableLinkRefs => tokenized.get(text)
    ?? findExecutableLinkRefs(text);
  const replace = (text: string): string => getTokenized(text).expand(resolved);
  const expectedLinks = payload.expectedLinks?.map(replace);
  if (expectedLinks?.some((value) => !validExpectedLink(value))) {
    throw new LinkRefError('expected_link_invalid_after_link_ref');
  }
  return {
    ...(payload.text === undefined ? {} : { text: replace(payload.text) }),
    ...(payload.preparedText === undefined ? {} : { preparedText: replace(payload.preparedText) }),
    ...(payload.card === undefined ? {} : { card: walkStrings(payload.card, replace) as Record<string, unknown> }),
    ...(payload.completionProposal === undefined
      ? {}
      : { completionProposal: walkStrings(payload.completionProposal, replace) as Record<string, unknown> }),
    ...(expectedLinks === undefined ? {} : { expectedLinks }),
    refCount: findOutboundExecutableLinkRefs(payload).length,
  };
}

export function resolveOutboundLinkRefs(
  ledger: LinkRefLedger,
  key: LinkRefTurnKey,
  payload: OutboundLinkRefPayload,
): ResolvedOutboundLinkRefs {
  const refIds = findOutboundExecutableLinkRefs(payload);
  const resolved = refIds.length === 0 ? new Map<string, string>() : ledger.resolveBatch(key, refIds);
  return expandOutboundLinkRefs(payload, resolved);
}
