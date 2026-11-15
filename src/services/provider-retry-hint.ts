/**
 * When a failed provider request says it can be retried: an absolute
 * "available at <ISO time>" from a gateway, an HTTP `Retry-After`, or a
 * relative "try again in 30s". Read from the provider's own error text so a
 * recovery does not keep knocking before that moment.
 *
 * Seen in the wild (an inference gateway in front of Claude, 2026-11-13):
 *
 *   API Error: 503 no eligible upstream account is currently available; the
 *   earliest account is expected to be available at 2026-11-13T11:10:16Z.
 *
 * Fail-closed on ambiguity: an absolute time without an explicit zone, a
 * phrase without a number ("try again in a moment"), or a time absurdly far
 * out yields nothing, and the caller falls back to its own backoff.
 */

/** A hint further out than this is ignored: no gateway promises hours ahead
 *  for a transient outage, and a misparsed year must not park a recovery. */
export const PROVIDER_RETRY_HINT_MAX_AHEAD_MS = 6 * 60 * 60 * 1000;

/** A hint older than this (relative to when the error was observed) is not a
 *  hint any more — likely another field's timestamp. */
const PROVIDER_RETRY_HINT_MAX_BEHIND_MS = 60 * 60 * 1000;

/** Bound on how much text is scanned: provider errors are short, and the
 *  scanned prefix is where the message lives. */
const SCAN_MAX_CHARS = 8 * 1024;

const ISO_WITH_ZONE = String.raw`(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?\s?(?:Z|UTC|GMT|[+-]\d{2}:?\d{2}))`;

/** "available at …", "retry after …", "resets at …" followed by an ISO time
 *  that names its zone. */
const ABSOLUTE_PHRASE_RE = new RegExp(
  String.raw`\b(?:available|availability|retry(?:ing)?|try\s+again|resets?|recover(?:s|y)?|back|reopens?)\b[^.;\n]{0,40}?\b(?:at|after|by|from|until)\s+`
    + ISO_WITH_ZONE,
  'gi',
);

/** `Retry-After: <seconds>` / `"retry_after": <seconds>` (header or JSON form). */
const RETRY_AFTER_SECONDS_RE = /\bretry[-_ ]after["']?\s*[:=]\s*["']?(\d{1,6}(?:\.\d+)?)(?!\d|[-:])\s*(ms|milliseconds?|s|secs?|seconds?|m|mins?|minutes?)?\b/gi;

/** `Retry-After: Wed, 21 Oct 2026 07:28:00 GMT` (HTTP-date form). */
const RETRY_AFTER_HTTP_DATE_RE = /\bretry[-_ ]after["']?\s*[:=]\s*["']?((?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT)/gi;

/** "try again in 30 seconds", "retry in 2m", "retry after 45s". A bare number
 *  is never taken: "try again in a moment" names no time. */
const RELATIVE_RE = /\b(?:try\s+again|retry(?:ing)?)\s+(?:in|after)\s+(\d{1,6}(?:\.\d+)?)\s*(ms|milliseconds?|s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?)\b/gi;

function unitMs(unit: string | undefined): number {
  const u = (unit ?? 's').toLowerCase();
  if (u === 'ms' || u.startsWith('millisecond')) return 1;
  if (u === 'm' || u.startsWith('min')) return 60_000;
  if (u === 'h' || u.startsWith('hr') || u.startsWith('hour')) return 3_600_000;
  return 1_000;
}

function parseZonedIso(text: string): number | undefined {
  const normalized = text.trim()
    .replace(/^(\d{4}-\d{2}-\d{2}) /, '$1T')
    .replace(/\s?(?:UTC|GMT)$/i, 'Z')
    .replace(/\s+(?=[Z+-])/, '')
    .replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? ms : undefined;
}

/**
 * The epoch ms at which the provider says the failed request may be retried,
 * or undefined when its text names no usable time. `observedAtMs` anchors
 * relative hints ("in 30s") — pass the failure record's own timestamp when
 * known, so a late reader does not push the hint later.
 *
 * When several hints appear the latest one wins: retrying before any of them
 * is what this exists to avoid.
 */
export function parseProviderRetryAtMs(text: unknown, observedAtMs: number): number | undefined {
  if (typeof text !== 'string' || !text || !Number.isFinite(observedAtMs)) return undefined;
  const scanned = text.length > SCAN_MAX_CHARS ? text.slice(0, SCAN_MAX_CHARS) : text;
  const candidates: number[] = [];
  for (const match of scanned.matchAll(ABSOLUTE_PHRASE_RE)) {
    const at = parseZonedIso(match[1]!);
    if (at !== undefined) candidates.push(at);
  }
  for (const match of scanned.matchAll(RETRY_AFTER_HTTP_DATE_RE)) {
    const at = Date.parse(match[1]!);
    if (Number.isFinite(at)) candidates.push(at);
  }
  for (const re of [RETRY_AFTER_SECONDS_RE, RELATIVE_RE]) {
    for (const match of scanned.matchAll(re)) {
      const amount = Number(match[1]);
      if (Number.isFinite(amount)) candidates.push(observedAtMs + Math.round(amount * unitMs(match[2])));
    }
  }
  const usable = candidates.filter(at => at <= observedAtMs + PROVIDER_RETRY_HINT_MAX_AHEAD_MS
    && at >= observedAtMs - PROVIDER_RETRY_HINT_MAX_BEHIND_MS);
  return usable.length > 0 ? Math.max(...usable) : undefined;
}
