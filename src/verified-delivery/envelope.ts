/**
 * verified-delivery/envelope.ts — the goal-group "delivery envelope" parser.
 *
 * P0 of cross-device / external-worker support (see proj memory + design thread):
 * instead of networking daemons, the goal group itself is the delivery bus. ANY
 * worker — a remote botmux bot on another host, a non-botmux agent, or a human —
 * delivers / raises help by posting a machine-parseable text envelope INTO the
 * goal group. The L2 supervisor's daemon (which already sees every goal-group
 * message) parses it here and materializes a TaskReported / TaskHelpRequested on
 * ITS ledger — so the ledger stays single-master on the L2 side, no remote writes.
 *
 * Format is deliberately a plain text block (no JSON ceremony) so a human or a
 * non-botmux agent can hand-write it:
 *
 *   [botmux-report v1]
 *   taskId: task-xxx
 *   reportId: rpt-xxx          # optional; ingestion derives one from messageId if absent
 *   summary: 一句话说清交付了什么
 *   evidence:
 *   - inline: name=test-output 15/15 passed
 *   - path: /shared/repo/out.txt
 *   - url: https://example.com/run/123/log
 *
 *   [botmux-help v1]
 *   taskId: task-xxx
 *   kind: ambiguous            # access|ambiguous|impossible|repeated_failure|other
 *   blocker: 说清卡在哪、需要监管者做什么
 *
 * Evidence kinds map to verified-delivery `Evidence`: `inline` (self-contained —
 * the only kind a remote worker whose files the L2 can't read should rely on),
 * `path` (only verifiable if shared/reachable by the L2), `url` (L2 fetches it).
 * Big binary artifacts are out of P0 scope — P1 adds an upload path.
 *
 * This module is PURE parsing — no ledger writes, no auth. The ingestion seam
 * (daemon side) authorizes the sender (must be the task's assigned worker or an
 * L2-marked external worker) and assigns idempotency before appending.
 */
import type { HelpKind } from './types.js';

export const REPORT_ENVELOPE_HEADER = '[botmux-report v1]';
export const HELP_ENVELOPE_HEADER = '[botmux-help v1]';

/** A parsed evidence line. Kept loose (strings) — the ingestion seam converts it
 *  into the ledger `Evidence` shape (spilling inline content to a blob). */
export type EnvelopeEvidence =
  | { kind: 'inline'; name?: string; text: string }
  | { kind: 'path'; path: string }
  | { kind: 'url'; url: string };

export interface ParsedReportEnvelope {
  kind: 'report';
  taskId: string;
  reportId?: string;
  summary: string;
  evidence: EnvelopeEvidence[];
}

export interface ParsedHelpEnvelope {
  kind: 'help';
  taskId: string;
  blocker: string;
  helpKind?: HelpKind;
}

export type ParsedEnvelope = ParsedReportEnvelope | ParsedHelpEnvelope;

export interface UnsupportedDeliveryEnvelope {
  kind: 'report' | 'help';
  version: string;
  supportedVersion: 'v1';
}

const HELP_KINDS: ReadonlySet<string> = new Set<HelpKind>([
  'access', 'ambiguous', 'impossible', 'repeated_failure', 'other',
]);

function oneLine(value: string): string {
  return value.replace(/\r?\n/g, ' ').trim();
}

export function formatReportEnvelope(input: {
  taskId: string;
  summary: string;
  reportId?: string;
  evidence: EnvelopeEvidence[];
}): string {
  const lines = [
    REPORT_ENVELOPE_HEADER,
    `taskId: ${oneLine(input.taskId)}`,
    input.reportId ? `reportId: ${oneLine(input.reportId)}` : undefined,
    `summary: ${oneLine(input.summary)}`,
  ].filter(Boolean) as string[];
  if (input.evidence.length > 0) {
    lines.push('evidence:');
    for (const ev of input.evidence) {
      if (ev.kind === 'path') lines.push(`- path: ${oneLine(ev.path)}`);
      else if (ev.kind === 'url') lines.push(`- url: ${oneLine(ev.url)}`);
      else {
        const name = ev.name ? `name=${oneLine(ev.name)} ` : '';
        lines.push(`- inline: ${name}${oneLine(ev.text)}`);
      }
    }
  }
  return lines.join('\n');
}

export function formatHelpEnvelope(input: {
  taskId: string;
  blocker: string;
  helpKind?: HelpKind;
}): string {
  return [
    HELP_ENVELOPE_HEADER,
    `taskId: ${oneLine(input.taskId)}`,
    input.helpKind ? `kind: ${input.helpKind}` : undefined,
    `blocker: ${oneLine(input.blocker)}`,
  ].filter(Boolean).join('\n');
}

/** Strip leading "@xxx " mention tokens that Lark prepends so the header can be
 *  matched on the first meaningful line (mirrors narration.stripLeadingMentions). */
function stripLeadingMentions(line: string): string {
  let t = line.trim();
  for (;;) {
    const next = t.replace(/^@\S+(?:\s+|$)/, '').trimStart();
    if (next === t) return t;
    t = next;
  }
}

/**
 * Return the first meaningful line after trimming whitespace and Lark's
 * leading @mention chrome. A delivery envelope is a whole-message protocol,
 * not a fenced example embedded in ordinary task prose.
 */
function firstMeaningfulLine(text: string): { index: number; text: string } | undefined {
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = stripLeadingMentions(lines[index]!);
    if (line) return { index, text: line };
  }
  return undefined;
}

/** Split a "key: value" line. Returns undefined when there is no colon. */
function splitKv(line: string): { key: string; value: string } | undefined {
  const idx = line.indexOf(':');
  if (idx < 0) return undefined;
  return { key: line.slice(0, idx).trim().toLowerCase(), value: line.slice(idx + 1).trim() };
}

function parseEvidenceLine(raw: string): EnvelopeEvidence | undefined {
  // "- inline: name=foo some text" | "- path: /x" | "- url: https://x"
  const body = raw.replace(/^-\s*/, '').trim();
  const kv = splitKv(body);
  if (!kv) return undefined;
  if (kv.key === 'path') return kv.value ? { kind: 'path', path: kv.value } : undefined;
  if (kv.key === 'url') return kv.value ? { kind: 'url', url: kv.value } : undefined;
  if (kv.key === 'inline') {
    // optional leading "name=<token>" then the rest is the inline text
    const m = kv.value.match(/^name=(\S+)\s*(.*)$/s);
    if (m) {
      const text = m[2].trim();
      return text ? { kind: 'inline', name: m[1], text } : undefined;
    }
    return kv.value ? { kind: 'inline', text: kv.value } : undefined;
  }
  return undefined;
}

/**
 * Parse a goal-group message into a delivery envelope, or return null when the
 * text is not an envelope (the overwhelmingly common case — keep this cheap and
 * allocation-light on the fast path so it can run on every group message).
 */
export function parseDeliveryEnvelope(text: string | undefined): ParsedEnvelope | null {
  if (!text) return null;
  // Fast reject: the header marker must appear somewhere before we do real work.
  if (!text.includes('[botmux-report v1]') && !text.includes('[botmux-help v1]')) return null;

  const rawLines = text.split(/\r?\n/);
  // The header must be the first meaningful line. Dispatch prompts include
  // report/help examples in their instructions; scanning every line would turn
  // those examples into fake deliveries and prevent the dispatch from running.
  const first = firstMeaningfulLine(text);
  if (!first) return null;
  const isHelp = first.text === HELP_ENVELOPE_HEADER;
  if (!isHelp && first.text !== REPORT_ENVELOPE_HEADER) return null;
  const start = first.index;

  const fields = new Map<string, string>();
  const evidence: EnvelopeEvidence[] = [];
  let inEvidence = false;
  for (let i = start + 1; i < rawLines.length; i++) {
    const line = rawLines[i].trim();
    if (!line) { inEvidence = false; continue; }
    if (line.startsWith('- ')) {
      if (inEvidence) {
        const ev = parseEvidenceLine(line);
        if (ev) evidence.push(ev);
      }
      continue;
    }
    const kv = splitKv(line);
    if (!kv) continue;
    if (kv.key === 'evidence') { inEvidence = true; continue; }
    inEvidence = false;
    if (!fields.has(kv.key)) fields.set(kv.key, kv.value);
  }

  const taskId = fields.get('taskid');
  if (!taskId) return null; // taskId is mandatory — without it nothing can be routed

  if (isHelp) {
    const blocker = fields.get('blocker') ?? fields.get('summary');
    if (!blocker) return null;
    const rawKind = fields.get('kind');
    const helpKind = rawKind && HELP_KINDS.has(rawKind) ? (rawKind as HelpKind) : undefined;
    return { kind: 'help', taskId, blocker, helpKind };
  }

  const summary = fields.get('summary');
  if (!summary) return null; // a report with no summary is not verifiable
  const reportId = fields.get('reportid') || undefined;
  return { kind: 'report', taskId, reportId, summary, evidence };
}

export function detectUnsupportedDeliveryEnvelope(text: string | undefined): UnsupportedDeliveryEnvelope | null {
  if (!text || !text.includes('[botmux-')) return null;
  const first = firstMeaningfulLine(text);
  if (!first) return null;
  const m = first.text.match(/^\[botmux-(report|help)\s+([^\]\s]+)\]$/i);
  if (!m) return null;
  const version = m[2].trim().toLowerCase();
  if (version === 'v1') return null;
  return { kind: m[1].toLowerCase() as 'report' | 'help', version, supportedVersion: 'v1' };
}
