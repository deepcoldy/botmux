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

export function extractHttpUrlSpans(text: string): HttpUrlSpan[] {
  const spans: HttpUrlSpan[] = [];
  URL_SCHEME_RE.lastIndex = 0;
  for (let match = URL_SCHEME_RE.exec(text); match; match = URL_SCHEME_RE.exec(text)) {
    const start = match.index;
    let scanEnd = URL_SCHEME_RE.lastIndex;
    while (scanEnd < text.length && !HARD_URL_TERMINATOR_RE.test(text[scanEnd]!)) {
      scanEnd += 1;
    }
    const originalUrl = trimExternalUrlSuffix(text.slice(start, scanEnd));
    if (originalUrl && isValidHttpUrl(originalUrl)) {
      spans.push({ start, end: start + originalUrl.length, originalUrl });
    }
    URL_SCHEME_RE.lastIndex = Math.max(scanEnd, URL_SCHEME_RE.lastIndex);
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
