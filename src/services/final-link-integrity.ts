import { extractHttpUrlSpans } from './link-ref-extractor.js';
import type { OutboundLinkRefPayload } from './link-ref-resolver.js';
import { markdownLiteralRanges } from './markdown-literal-ranges.js';
import { LinkRefError } from './link-ref-types.js';

export type LinkIntegrityResponseKind = 'progress' | 'final' | 'auxiliary';

interface RegisteredEndpoint {
  origin: string;
  pathname: string;
  originalUrl: string;
}

function walkStrings(value: unknown, visit: (text: string) => void): void {
  if (typeof value === 'string') {
    visit(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) walkStrings(entry, visit);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const entry of Object.values(value)) walkStrings(entry, visit);
}

function payloadStrings(payload: OutboundLinkRefPayload): string[] {
  const values: string[] = [];
  if (payload.card !== undefined) walkStrings(payload.card, value => values.push(value));
  else if (payload.preparedText !== undefined) values.push(payload.preparedText);
  else if (payload.text !== undefined) values.push(payload.text);
  if (payload.completionProposal !== undefined) {
    walkStrings(payload.completionProposal, value => values.push(value));
  }
  return values;
}

function registeredEndpoints(urls: readonly string[]): RegisteredEndpoint[] {
  return urls.flatMap((originalUrl) => {
    try {
      const parsed = new URL(originalUrl);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return [];
      return [{ origin: parsed.origin, pathname: parsed.pathname, originalUrl }];
    } catch {
      throw new LinkRefError('link_ref_ledger_unavailable');
    }
  });
}

function hasUnclosedInlineLinkDestination(text: string): boolean {
  const literals = markdownLiteralRanges(text);
  let literalIndex = 0;
  for (let offset = 0; offset < text.length;) {
    const marker = text.indexOf('](', offset);
    if (marker < 0) return false;
    while (literalIndex < literals.length && literals[literalIndex]!.end <= marker) literalIndex += 1;
    const literal = literals[literalIndex];
    if (literal && literal.start <= marker && marker < literal.end) {
      offset = literal.end;
      continue;
    }
    const destinationStart = marker + 2;
    const firstNonSpace = text.slice(destinationStart).search(/\S/u);
    if (firstNonSpace < 0) return true;
    const start = destinationStart + firstNonSpace;
    let nested = 0;
    let escaped = false;
    let closedAt: number | undefined;
    for (let index = start; index < text.length; index += 1) {
      const char = text[index]!;
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (char === '(') nested += 1;
      if (char === ')') {
        if (nested === 0) {
          closedAt = index;
          break;
        }
        nested -= 1;
      }
      if (char === '\n' && nested === 0) break;
    }
    if (closedAt !== undefined) {
      offset = closedAt + 1;
      continue;
    }
    return true;
  }
  return false;
}

export function enforceFinalLinkIntegrity(input: {
  payload: OutboundLinkRefPayload;
  responseKind?: LinkIntegrityResponseKind;
  registeredUrls: readonly string[] | (() => readonly string[]);
}): void {
  if (input.responseKind !== 'final') return;
  const strings = payloadStrings(input.payload);
  if (strings.some(hasUnclosedInlineLinkDestination)) {
    throw new LinkRefError('link_ref_malformed_markdown');
  }
  const urls = typeof input.registeredUrls === 'function'
    ? input.registeredUrls()
    : input.registeredUrls;
  const endpoints = registeredEndpoints(urls);
  if (endpoints.length === 0) return;
  for (const value of strings) {
    for (const candidate of extractHttpUrlSpans(value)) {
      const parsed = new URL(candidate.originalUrl);
      const sameEndpoint = endpoints.filter(endpoint => (
        endpoint.origin === parsed.origin && endpoint.pathname === parsed.pathname
      ));
      if (sameEndpoint.length > 0
        && !sameEndpoint.some(endpoint => endpoint.originalUrl === candidate.originalUrl)) {
        throw new LinkRefError('link_ref_final_url_mismatch');
      }
    }
  }
}
