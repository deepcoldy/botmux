import { safeToolLabel } from './classify.js';
import { scrubSecrets } from './scrub.js';
import type { RawInsightSpan, SafeSpan, SafeSpanTag } from './types.js';

function scrubAllowedText(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const out = value.replace(/\s+/g, ' ').trim();
  if (!out) return undefined;
  // Defense-in-depth only: allowSummary() is fail-closed and never passes raw
  // text here today, but route through the shared (ReDoS-safe) scrubber so this
  // copy can't silently regress if the gate ever loosens.
  return scrubSecrets(out).slice(0, 160);
}

function allowSummary(value: string | undefined): string | undefined {
  if (!value) return undefined;
  // Fail-closed: only reader-produced structural labels or numeric exit codes
  // cross the daemon IPC boundary. Regex scrub is a second layer, not the gate.
  if (/^(shell command|file edit|read\/search|agent task|tool input|tool result|tool error|patch failed|patch applied)$/.test(value)) {
    return value;
  }
  if (/^exit -?\d+$/.test(value)) return value;
  return scrubAllowedText(undefined);
}

export function toSafeSpan(span: RawInsightSpan, firstEventMs: number | undefined, tags: SafeSpanTag[] = []): SafeSpan {
  const relStartMs = span.startMs !== undefined && firstEventMs !== undefined
    ? Math.max(0, span.startMs - firstEventMs)
    : 0;
  const safe: SafeSpan = {
    tool: safeToolLabel(span.tool),
    phase: span.phase,
    turnIndex: Math.max(0, Math.floor(span.turnIndex)),
    relStartMs,
    status: span.status,
  };
  if (span.durationMs !== undefined) safe.durationMs = Math.max(0, Math.round(span.durationMs));
  const inputSummary = allowSummary(span.inputSummary);
  const outputSummary = allowSummary(span.outputSummary);
  if (inputSummary) safe.inputSummary = inputSummary;
  if (outputSummary) safe.outputSummary = outputSummary;
  if (span.intent) safe.intent = span.intent;
  if (span.result) safe.result = span.result;
  if (tags.length > 0) safe.tags = tags;
  if (span.evidence) safe.evidence = span.evidence;
  return safe;
}

export function safeErrorMessage(code: string): string {
  switch (code) {
    case 'unsupported_cli':
      return 'Insight is not available for this CLI yet.';
    case 'transcript_missing':
      return 'Transcript is not available for this session yet.';
    case 'parse_error':
      return 'Transcript could not be parsed safely.';
    default:
      return 'Insight is unavailable.';
  }
}
