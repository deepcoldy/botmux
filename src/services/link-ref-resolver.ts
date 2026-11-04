import type { LinkRefLedger } from './link-ref-ledger.js';
import { enforceFinalLinkIntegrity, type LinkIntegrityResponseKind } from './final-link-integrity.js';
import { markdownLiteralRanges } from './markdown-literal-ranges.js';
import { LinkRefError, type LinkRefTurnKey } from './link-ref-types.js';

const LINK_REF_SOURCE = String.raw`\{\{botmux_link:(lr_[0-9a-f]{32})\}\}`;
const LINK_REF_PATTERN = new RegExp(LINK_REF_SOURCE, 'g');

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

function tokenize(text: string): RefSpan[] {
  const spans: RefSpan[] = [];
  const literals = markdownLiteralRanges(text);
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
  responseKind?: LinkIntegrityResponseKind,
): ResolvedOutboundLinkRefs {
  const refIds = findOutboundExecutableLinkRefs(payload);
  const resolved = refIds.length === 0 ? new Map<string, string>() : ledger.resolveBatch(key, refIds);
  const expanded = expandOutboundLinkRefs(payload, resolved);
  enforceFinalLinkIntegrity({
    payload: expanded,
    responseKind,
    registeredUrls: () => {
      try {
        return ledger.listRegistered(key).map(entry => entry.originalUrl);
      } catch (error) {
        // Registration is deliberately fail-open. Missing and expired rows
        // mean there are no usable registered source URLs to compare, while a
        // genuinely unavailable ledger still fails closed.
        if (error instanceof LinkRefError
          && (error.code === 'link_ref_turn_missing' || error.code === 'link_ref_expired')) return [];
        throw error;
      }
    },
  });
  return expanded;
}
