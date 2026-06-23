/** Shared secret scrubbing for insight previews (command / output / prompt /
 *  conversation owner-only relaxed path).
 *
 *  ReDoS note: the earlier per-file copies used an UNBOUNDED prefix/suffix around
 *  the keyword — `[A-Za-z0-9_-]*(?:token|secret|key|…)[A-Za-z0-9_-]*` — which
 *  backtracked quadratically on keyword-dense input lacking a `=`/`:` separator
 *  (measured ~2.4s on 80KB). Because insight parse runs synchronously inside the
 *  daemon IPC handler, that stalled the single event loop (all Lark dispatch + PTY
 *  IO). Here the quantifiers around the keyword are BOUNDED ({0,48}) so per-start
 *  cost is constant → the scan is linear in input length, and callers additionally
 *  cap the bytes scrubbed via safeScrubAndTruncate. */

const KEY = '(?:token|secret|key|password|passwd|pwd)';

/** Whole-token secret shapes that can be redacted wholesale (no key=value). */
const DIRECT_SECRET_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{6,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, // GitHub PAT / OAuth / refresh / server tokens
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{4,}\b/g, // JWT (header.payload.sig)
];

/** key=value / --flag value / url?query shapes. Separator allows surrounding
 *  whitespace ("KEY = value"). The KEYWORD prefix/suffix is bounded ({0,48}) —
 *  that overlap was the ReDoS source — but the VALUE/query capture stays
 *  unbounded greedy: it sits at the tail (nothing required after it), so it can't
 *  backtrack quadratically, and it MUST consume the whole secret to its delimiter
 *  — a bound there would redact only the first N chars and leak the tail. */
const KEY_VALUE_SECRET_PATTERNS: RegExp[] = [
  new RegExp(`\\b([A-Za-z0-9_-]{0,48}${KEY}[A-Za-z0-9_-]{0,48})\\s*(=|:)\\s*([^\\s&]+)`, 'gi'),
  /\b(BOTMUX_[A-Z0-9_]{0,64}|LARK_APP_SECRET|OPENAI_API_KEY|ANTHROPIC_API_KEY)\s*(=|:)\s*([^\s&]+)/g,
  new RegExp(`(--?[A-Za-z0-9_-]{0,48}${KEY}[A-Za-z0-9_-]{0,48})\\s+([^\\s]+)`, 'gi'),
  /(https?:\/\/[^\s?]+)\?([^\s]+)/gi,
];

/** Scrub known secret shapes. Linear in input length (bounded quantifiers).
 *  Callers should bound input length first (see safeScrubAndTruncate). */
export function scrubSecrets(text: string): string {
  let out = text;
  for (const re of DIRECT_SECRET_PATTERNS) out = out.replace(re, '<redacted>');
  for (const re of KEY_VALUE_SECRET_PATTERNS) {
    out = out.replace(re, (_m, a: string, sepOrValue: string) => {
      if (typeof a === 'string' && a.startsWith('http')) return `${a}?<redacted>`;
      if (typeof a === 'string' && a.startsWith('-')) return `${a} <redacted>`;
      return `${a}${sepOrValue}<redacted>`;
    });
  }
  return out;
}

/** Extra bytes scrubbed beyond `max` so a secret straddling the display cut is
 *  still redacted before the tail is dropped. */
const SCRUB_OVERSCAN = 256;
/** Absolute backstop on bytes ever scanned, independent of `max` (some callers
 *  pass an effectively unbounded `max` for the full-prompt modal). */
const MAX_SCRUB_INPUT = 256 * 1024;

/** Bound the bytes scrubbed AND displayed to `max` (+overscan), with an absolute
 *  backstop. The discarded tail is never shown, so leaving it unscrubbed is safe;
 *  this keeps redaction work O(displayed length) regardless of raw size. */
export function safeScrubAndTruncate(raw: string, max: number): { text: string; truncated: boolean } {
  const cap = Math.min(Math.max(max, 0) + SCRUB_OVERSCAN, MAX_SCRUB_INPUT);
  const capped = raw.length > cap ? raw.slice(0, cap) : raw;
  const scrubbed = scrubSecrets(capped);
  const truncated = scrubbed.length > max || capped.length < raw.length;
  return {
    text: truncated ? `${scrubbed.slice(0, Math.max(0, max - 1))}…` : scrubbed,
    truncated,
  };
}
