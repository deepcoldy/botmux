import { existsSync, statSync } from 'node:fs';
import { basename, isAbsolute, relative } from 'node:path';
import { resolveSessionTranscriptPath } from '../transcript-resolver.js';
import { isReadPhase, isWritePhase } from './classify.js';
import { parseAntigravityInsight } from './antigravity-span-reader.js';
import { parseClaudeInsight } from './claude-span-reader.js';
import { parseCodexInsight } from './codex-span-reader.js';
import { safeErrorMessage, toSafeSpan } from './redact.js';
import type {
  AgentSay,
  InsightDetail,
  InsightDiagnosticKind,
  InsightConversationMessage,
  InsightConversationRole,
  InsightParseResult,
  InsightPhase,
  InsightOverviewSessionInput,
  InsightReportQuery,
  InsightSeverity,
  RawInsightSpan,
  DiagnosticRecommendation,
  SafeInsightConversation,
  SafeInsightAggregate,
  SafeInsightDiagnostic,
  SafeInsightOverview,
  SafeInsightOverviewSession,
  SafeInsightOverviewSuggestion,
  SafeInsightReport,
  SafeInsightSuggestion,
  SafeInsightTurnDetail,
  SafeInsightWorkSummary,
  SafeSpan,
  SafeSpanTag,
  TurnContextPoint,
  TurnEfficiencyDiagnostic,
  TurnTimelineEventKind,
  TurnTimelineTurn,
  TurnPromptPreview,
} from './types.js';
import { INSIGHT_PHASES } from './types.js';

export interface BuildInsightReportOptions {
  detail?: InsightDetail;
  maxSpans?: number;
  slowThresholdMs?: number;
  now?: () => Date;
}

export interface BuildInsightOverviewOptions extends BuildInsightReportOptions {
  limit?: number;
}

export interface BuildInsightTurnPromptOptions {
  offset?: number;
  limit?: number;
  q?: string;
  role?: InsightConversationRole;
  severity?: InsightSeverity;
  tag?: SafeSpanTag;
  turnIndexes?: number[];
}

const DEFAULT_MAX_SPANS = 500;
const DEFAULT_OVERVIEW_LIMIT = 200;
const MAX_OVERVIEW_LIMIT = 500;
const DEFAULT_SLOW_THRESHOLD_MS = 60_000;
const DIAGNOSTIC_TARGET_CAP = 100;
const SEVERITY_ORDER: Record<InsightSeverity, number> = { bad: 0, warn: 1, info: 2 };
const SUPPORTED_CLI_IDS = new Set(['claude-code', 'seed', 'relay', 'aiden', 'codex', 'traex', 'antigravity']);
// Sized above MAX_OVERVIEW_LIMIT so a single overview pass doesn't evict its own
// earlier sessions (FIFO thrash), defeating the parse-cache amortization.
const PARSE_CACHE_MAX = 600;
const parseCache = new Map<string, InsightParseResult>();

export function __resetInsightReportCacheForTest(): void {
  parseCache.clear();
}

function emptyPhase(): Record<InsightPhase, { count: number; ms: number }> {
  return {
    research: { count: 0, ms: 0 },
    edit: { count: 0, ms: 0 },
    run: { count: 0, ms: 0 },
    delegate: { count: 0, ms: 0 },
    discuss: { count: 0, ms: 0 },
  };
}

function emptyAgg(): SafeInsightAggregate {
  return {
    totalSpans: 0,
    failedSpans: 0,
    slowSpans: 0,
    failByTool: {},
    phase: emptyPhase(),
    readWriteRatio: null,
    compactions: 0,
    subagentCostShare: null,
  };
}

function baseReport(q: InsightReportQuery, detail: InsightDetail, parsedAt: string): SafeInsightReport {
  return {
    sessionId: q.sessionId,
    cliId: q.cliId ?? 'unknown',
    status: 'ok',
    meta: { parsedAt, partial: false, detail },
    agg: emptyAgg(),
    suggestions: [],
    diagnostics: [],
    recommendations: [],
    turnDiagnostics: [],
    turnTimeline: [],
  };
}

function unsupported(q: InsightReportQuery, detail: InsightDetail, parsedAt: string, code: 'unsupported_cli' | 'transcript_missing' | 'parse_error'): SafeInsightReport {
  return {
    ...baseReport(q, detail, parsedAt),
    status: code,
    error: { code, message: safeErrorMessage(code) },
  };
}

function promptUnavailable(
  q: InsightReportQuery,
  turnIndex: number,
  offset: number,
  limit: number,
  code: 'unsupported_cli' | 'transcript_missing' | 'parse_error',
): SafeInsightTurnDetail {
  return {
    sessionId: q.sessionId,
    cliId: q.cliId ?? 'unknown',
    status: code,
    turnIndex,
    offset,
    limit,
    total: 0,
    hasMore: false,
    error: { code, message: safeErrorMessage(code) },
  };
}

function conversationUnavailable(
  q: InsightReportQuery,
  offset: number,
  limit: number,
  code: 'unsupported_cli' | 'transcript_missing' | 'parse_error',
): SafeInsightConversation {
  return {
    sessionId: q.sessionId,
    cliId: q.cliId ?? 'unknown',
    status: code,
    offset,
    limit,
    total: 0,
    hasMore: false,
    messages: [],
    error: { code, message: safeErrorMessage(code) },
  };
}

function parseForKind(kind: string, path: string, opts: { promptMax?: number } = {}): InsightParseResult | null {
  if (kind === 'claude') return parseClaudeInsight(path, opts);
  if (kind === 'codex' || kind === 'traex') return parseCodexInsight(path, opts);
  if (kind === 'antigravity') return parseAntigravityInsight(path, opts);
  return null;
}

function isSupportedTranscriptKind(kind: string): boolean {
  return kind === 'claude' || kind === 'codex' || kind === 'traex' || kind === 'antigravity';
}

function cachedParseForKind(kind: string, path: string): InsightParseResult | null {
  let key: string;
  try {
    const st = statSync(path);
    key = `${kind}:${path}:${st.mtimeMs}:${st.size}`;
  } catch {
    key = `${kind}:${path}:missing`;
  }
  const hit = parseCache.get(key);
  if (hit) return hit;
  const parsed = parseForKind(kind, path);
  if (!parsed) return null;
  if (parseCache.size >= PARSE_CACHE_MAX && !parseCache.has(key)) {
    const oldest = parseCache.keys().next().value;
    if (oldest !== undefined) parseCache.delete(oldest);
  }
  parseCache.set(key, parsed);
  return parsed;
}

function aggregate(spans: RawInsightSpan[], compactions: number, slowThresholdMs: number): SafeInsightAggregate {
  const agg = emptyAgg();
  agg.totalSpans = spans.length;
  agg.compactions = compactions;
  let reads = 0;
  let writes = 0;
  for (const s of spans) {
    const phase = INSIGHT_PHASES.includes(s.phase) ? s.phase : 'discuss';
    agg.phase[phase].count++;
    if (s.durationMs !== undefined) agg.phase[phase].ms += Math.max(0, Math.round(s.durationMs));
    if (s.status === 'error') {
      agg.failedSpans++;
      agg.failByTool[s.tool] = (agg.failByTool[s.tool] ?? 0) + 1;
    }
    if ((s.durationMs ?? 0) >= slowThresholdMs) agg.slowSpans++;
    if (isReadPhase(phase)) reads++;
    if (isWritePhase(phase)) writes++;
  }
  agg.readWriteRatio = writes > 0 ? Math.round((reads / writes) * 100) / 100 : null;
  return agg;
}

function topEntry(input: Record<string, number>): [string, number] | undefined {
  return Object.entries(input).sort((a, b) => b[1] - a[1])[0];
}

function suggestionsFor(agg: SafeInsightAggregate, spans: RawInsightSpan[], slowThresholdMs: number): SafeInsightSuggestion[] {
  const out: SafeInsightSuggestion[] = [];
  const topFail = topEntry(agg.failByTool);
  if (agg.failedSpans >= 3) {
    out.push({
      id: 'high_tool_failure',
      title: 'Tool failures are concentrated',
      severity: 'bad',
      evidence: [
        `${agg.failedSpans} failed spans`,
        topFail ? `${topFail[0]} failed ${topFail[1]} times` : 'multiple tools failed',
      ],
      action: 'Check the repeated failing tool first, then add preflight checks or clearer execution constraints.',
    });
  } else if (agg.failedSpans > 0) {
    out.push({
      id: 'tool_failure_present',
      title: 'Some tool calls failed',
      severity: 'warn',
      evidence: [`${agg.failedSpans} failed spans`],
      action: 'Review the failed spans before repeating the workflow.',
    });
  }

  const slowest = spans
    .filter(s => s.durationMs !== undefined)
    .sort((a, b) => (b.durationMs ?? 0) - (a.durationMs ?? 0))[0];
  if (slowest && (slowest.durationMs ?? 0) >= slowThresholdMs) {
    out.push({
      id: 'slow_span',
      title: 'A slow span dominates the session',
      severity: (slowest.durationMs ?? 0) >= 180_000 ? 'bad' : 'warn',
      evidence: [`${slowest.tool} ran for ${Math.round((slowest.durationMs ?? 0) / 1000)}s`],
      action: 'Split or bound the slow operation, and surface timeout or progress feedback earlier.',
    });
  }

  if (agg.readWriteRatio !== null && agg.readWriteRatio < 1) {
    out.push({
      id: 'low_read_write_ratio',
      title: 'Edits outpaced reads',
      severity: 'warn',
      evidence: [`read/write ratio ${agg.readWriteRatio}`],
      action: 'Add a read/search pass before edits when changing unfamiliar files.',
    });
  }

  if (agg.compactions > 0) {
    out.push({
      id: 'context_compaction',
      title: 'Context compaction happened',
      severity: 'info',
      evidence: [`compactions ${agg.compactions}`],
      action: 'For long tasks, preserve decisions and checkpoints in durable notes or smaller subtasks.',
    });
  }

  if (out.length === 0) {
    out.push({
      id: 'no_major_friction',
      title: 'No major trace friction detected',
      severity: 'info',
      evidence: [`${agg.totalSpans} spans analyzed`],
      action: 'Use the span timeline for spot checks or compare against slower sessions.',
    });
  }

  return out.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}

function uniqueNumbers(values: number[], cap = DIAGNOSTIC_TARGET_CAP): number[] {
  return [...new Set(values)].slice(0, cap);
}

function diagnosticForSuggestion(
  s: SafeInsightSuggestion,
  agg: SafeInsightAggregate,
  spans: RawInsightSpan[],
  visibleSpans: RawInsightSpan[] | undefined,
  slowThresholdMs: number,
): SafeInsightDiagnostic {
  const detail = visibleSpans !== undefined;
  const visibleRaw = visibleSpans ?? [];
  const target = (predicate: (span: RawInsightSpan) => boolean): {
    spanIndexes?: number[];
    turnIndexes?: number[];
    matchedSpans: number;
    returnedSpans: number;
  } => {
    const allMatches = spans
      .map((span, index) => ({ span, index }))
      .filter(x => predicate(x.span));
    const visibleMatches = visibleRaw
      .map((span, index) => ({ span, index }))
      .filter(x => predicate(x.span))
      .slice(0, DIAGNOSTIC_TARGET_CAP);
    return {
      spanIndexes: detail ? visibleMatches.map(x => x.index) : undefined,
      turnIndexes: detail ? uniqueNumbers(visibleMatches.map(x => x.span.turnIndex)) : undefined,
      matchedSpans: allMatches.length,
      returnedSpans: visibleMatches.length,
    };
  };
  const targetTools = (matches: RawInsightSpan[], cap = 5): string[] =>
    [...new Set(matches.map(x => x.tool))].slice(0, cap);
  const base = (kind: InsightDiagnosticKind, reason: string, targets: SafeInsightDiagnostic['targets'], stats?: SafeInsightDiagnostic['stats']): SafeInsightDiagnostic => ({
    id: s.id,
    suggestionId: s.id,
    kind,
    severity: s.severity,
    title: s.title,
    reason,
    targets,
    stats,
  });

  if (s.id === 'high_tool_failure' || s.id === 'tool_failure_present') {
    const allErrorSpans = spans.filter(span => span.status === 'error');
    const t = target(span => span.status === 'error');
    const topFail = topEntry(agg.failByTool);
    const tools = targetTools(allErrorSpans);
    return base(
      'tool_failure',
      topFail ? `${agg.failedSpans} failed spans; ${topFail[0]} failed ${topFail[1]} times.` : `${agg.failedSpans} failed spans.`,
      { spanIndexes: t.spanIndexes, turnIndexes: t.turnIndexes, tools },
      {
        failedSpans: agg.failedSpans,
        matchedSpans: t.matchedSpans,
        returnedSpans: t.returnedSpans,
        topTool: topFail?.[0] ?? '',
        topToolFailures: topFail?.[1] ?? 0,
      },
    );
  }

  if (s.id === 'slow_span') {
    const slowSpans = spans
      .filter(span => (span.durationMs ?? 0) >= slowThresholdMs)
      .sort((a, b) => (b.durationMs ?? 0) - (a.durationMs ?? 0));
    const slowSet = new Set(slowSpans);
    const t = target(span => slowSet.has(span));
    const slowest = slowSpans[0];
    const tools = targetTools(slowSpans);
    return base(
      'slow_span',
      slowest ? `${slowSpans.length} slow spans; slowest ${slowest.tool} ran ${Math.round((slowest.durationMs ?? 0) / 1000)}s.` : 'No slow spans matched.',
      { spanIndexes: t.spanIndexes, turnIndexes: t.turnIndexes, tools },
      {
        slowSpansTotal: slowSpans.length,
        matchedSpans: t.matchedSpans,
        returnedSpans: t.returnedSpans,
        slowThresholdMs,
        slowestTool: slowest?.tool ?? '',
        slowestDurationMs: slowest?.durationMs ?? 0,
      },
    );
  }

  if (s.id === 'low_read_write_ratio') {
    const reads = spans.filter(span => isReadPhase(span.phase));
    const writes = spans.filter(span => isWritePhase(span.phase));
    const t = target(span => isWritePhase(span.phase) || span.phase === 'run');
    const targetSpans = spans.filter(span => isWritePhase(span.phase) || span.phase === 'run');
    return base(
      'read_write_imbalance',
      `Read/write ratio ${agg.readWriteRatio}; ${reads.length} read spans and ${writes.length} write spans.`,
      { spanIndexes: t.spanIndexes, turnIndexes: t.turnIndexes, tools: targetTools(targetSpans) },
      {
        readWriteRatio: agg.readWriteRatio ?? '',
        readSpans: reads.length,
        writeSpans: writes.length,
        matchedSpans: t.matchedSpans,
        returnedSpans: t.returnedSpans,
      },
    );
  }

  if (s.id === 'context_compaction') {
    return base(
      'compaction',
      `${agg.compactions} context compactions happened in this session.`,
      {},
      { compactions: agg.compactions },
    );
  }

  return base(
    'none',
    `${agg.totalSpans} spans analyzed; no major trace friction detected.`,
    {},
    { totalSpans: agg.totalSpans },
  );
}

function diagnosticsFor(
  suggestions: SafeInsightSuggestion[],
  agg: SafeInsightAggregate,
  spans: RawInsightSpan[],
  visibleSpans: RawInsightSpan[] | undefined,
  slowThresholdMs: number,
): SafeInsightDiagnostic[] {
  return suggestions.map(s => diagnosticForSuggestion(s, agg, spans, visibleSpans, slowThresholdMs));
}

function selectVisibleSpans(spans: RawInsightSpan[], maxSpans: number, slowThresholdMs: number): RawInsightSpan[] {
  const limit = Math.max(0, Math.floor(maxSpans));
  if (spans.length <= limit) return spans;
  if (limit <= 0) return [];
  const selected = new Set<number>();
  const addWhere = (predicate: (span: RawInsightSpan) => boolean): void => {
    for (let i = 0; i < spans.length && selected.size < limit; i++) {
      if (predicate(spans[i]!)) selected.add(i);
    }
  };
  addWhere(span => span.status === 'error');
  addWhere(span => (span.durationMs ?? 0) >= slowThresholdMs);
  addWhere(() => true);
  return [...selected].sort((a, b) => a - b).map(i => spans[i]!);
}

function safeFilePathLabel(path: string, cwd: string | undefined): string {
  const raw = path.trim();
  if (!raw) return 'unknown';
  let label = raw;
  if (cwd && isAbsolute(raw)) {
    const rel = relative(cwd, raw);
    if (rel && !rel.startsWith('..') && !isAbsolute(rel)) label = rel;
  }
  if (isAbsolute(label)) label = basename(label) || 'file';
  label = label.replace(/\\/g, '/').replace(/\s+/g, ' ').trim();
  if (!label || label === '.' || label === '..') return 'file';
  return label.length > 120 ? `.../${basename(label) || label.slice(-80)}` : label;
}

function patchLineCounts(patch: string | undefined): { added: number; removed: number } | undefined {
  if (!patch) return undefined;
  let added = 0;
  let removed = 0;
  for (const line of patch.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) added++;
    else if (line.startsWith('-')) removed++;
  }
  return added > 0 || removed > 0 ? { added, removed } : undefined;
}

function uniqueSortedNumbers(values: number[], cap = DIAGNOSTIC_TARGET_CAP): number[] {
  return [...new Set(values)].sort((a, b) => a - b).slice(0, cap);
}

function buildWorkSummary(spans: RawInsightSpan[], safeSpans: SafeSpan[] | undefined, cwd: string | undefined): SafeInsightWorkSummary {
  const fileMap = new Map<string, {
    path: string;
    reads: number;
    edits: number;
    added: number;
    removed: number;
    hasLineCounts: boolean;
    turnIndexes: number[];
    spanIndexes: number[];
  }>();
  for (let i = 0; i < spans.length; i++) {
    const span = spans[i]!;
    for (const rawPath of span.filePaths ?? []) {
      const label = safeFilePathLabel(rawPath, cwd);
      const cur = fileMap.get(label) ?? {
        path: label,
        reads: 0,
        edits: 0,
        added: 0,
        removed: 0,
        hasLineCounts: false,
        turnIndexes: [],
        spanIndexes: [],
      };
      if (isReadPhase(span.phase)) cur.reads++;
      if (isWritePhase(span.phase)) cur.edits++;
      const counts = isWritePhase(span.phase) ? (span.lineCounts ?? patchLineCounts(span.patchText)) : undefined;
      if (counts) {
        cur.added += counts.added;
        cur.removed += counts.removed;
        cur.hasLineCounts = true;
      }
      cur.turnIndexes.push(span.turnIndex);
      cur.spanIndexes.push(i);
      fileMap.set(label, cur);
    }
  }
  const fileChanges = [...fileMap.values()]
    .map(row => ({
      path: row.path,
      reads: row.reads,
      edits: row.edits,
      ...(row.hasLineCounts ? { added: row.added, removed: row.removed } : {}),
      turnIndexes: uniqueSortedNumbers(row.turnIndexes),
      spanIndexes: uniqueSortedNumbers(row.spanIndexes),
    }))
    .sort((a, b) =>
      ((b.added ?? 0) + (b.removed ?? 0)) - ((a.added ?? 0) + (a.removed ?? 0))
      || b.edits - a.edits
      || b.reads - a.reads
      || a.path.localeCompare(b.path))
    .slice(0, 100);

  const commandMap = new Map<string, {
    command: NonNullable<SafeSpan['evidence']>['command'];
    count: number;
    failures: number;
    totalDurationMs: number;
    maxDurationMs: number | undefined;
    lastStatus: SafeSpan['status'];
    turnIndexes: number[];
    spanIndexes: number[];
  }>();
  for (let i = 0; i < (safeSpans?.length ?? 0); i++) {
    const span = safeSpans![i]!;
    const command = span.evidence?.command;
    if (!command) continue;
    const key = command.text;
    const cur = commandMap.get(key) ?? {
      command,
      count: 0,
      failures: 0,
      totalDurationMs: 0,
      maxDurationMs: undefined,
      lastStatus: span.status,
      turnIndexes: [],
      spanIndexes: [],
    };
    cur.count++;
    if (span.status === 'error') cur.failures++;
    if (span.durationMs !== undefined) {
      cur.totalDurationMs += span.durationMs;
      cur.maxDurationMs = cur.maxDurationMs === undefined ? span.durationMs : Math.max(cur.maxDurationMs, span.durationMs);
    }
    cur.lastStatus = span.status;
    cur.turnIndexes.push(span.turnIndex);
    cur.spanIndexes.push(i);
    commandMap.set(key, cur);
  }
  const commandsRun = [...commandMap.values()]
    .map(row => ({
      command: row.command!,
      count: row.count,
      failures: row.failures,
      totalDurationMs: row.totalDurationMs,
      ...(row.maxDurationMs !== undefined ? { maxDurationMs: row.maxDurationMs } : {}),
      lastStatus: row.lastStatus,
      turnIndexes: uniqueSortedNumbers(row.turnIndexes),
      spanIndexes: uniqueSortedNumbers(row.spanIndexes),
    }))
    .sort((a, b) =>
      b.failures - a.failures
      || b.count - a.count
      || b.totalDurationMs - a.totalDurationMs
      || a.command.text.localeCompare(b.command.text))
    .slice(0, 100);
  return { fileChanges, commandsRun };
}

function spanKey(span: RawInsightSpan): string {
  const intent = span.intent;
  return `${intent?.kind ?? 'unknown'}:${intent?.subject ?? ''}:${intent?.detail ?? ''}`;
}

function tagsForVisibleSpans(spans: RawInsightSpan[], slowThresholdMs: number): SafeSpanTag[][] {
  const counts = new Map<string, number>();
  for (const span of spans) {
    const key = spanKey(span);
    if (!key.startsWith('unknown:')) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const turnCounts = new Map<number, { reads: number; writes: number; runs: number }>();
  for (const span of spans) {
    const cur = turnCounts.get(span.turnIndex) ?? { reads: 0, writes: 0, runs: 0 };
    if (isReadPhase(span.phase)) cur.reads++;
    if (isWritePhase(span.phase)) cur.writes++;
    if (span.phase === 'run') cur.runs++;
    turnCounts.set(span.turnIndex, cur);
  }
  return spans.map(span => {
    const tags = new Set<SafeSpanTag>();
    if (span.status === 'error') tags.add('failure');
    if ((span.durationMs ?? 0) >= slowThresholdMs) tags.add('slow');
    const key = spanKey(span);
    if (!key.startsWith('unknown:') && (counts.get(key) ?? 0) > 1) tags.add('retry');
    const tc = turnCounts.get(span.turnIndex);
    if (tc && tc.reads === 0 && (tc.writes > 0 || tc.runs > 0)) tags.add('read_write_imbalance');
    if (tags.size > 0) tags.add('diagnostic');
    else tags.add('normal');
    return [...tags];
  });
}

function buildTurnDiagnostics(visibleSpans: RawInsightSpan[] | undefined, slowThresholdMs: number): TurnEfficiencyDiagnostic[] {
  if (!visibleSpans) return [];
  type Acc = {
    reads: number;
    edits: number;
    runs: number;
    failures: number;
    durationMs: number;
    spanIndexes: number[];
    tags: Set<SafeSpanTag>;
  };
  const spanTags = tagsForVisibleSpans(visibleSpans, slowThresholdMs);
  const byTurn = new Map<number, Acc>();
  for (let i = 0; i < visibleSpans.length; i++) {
    const span = visibleSpans[i]!;
    const acc = byTurn.get(span.turnIndex) ?? {
      reads: 0,
      edits: 0,
      runs: 0,
      failures: 0,
      durationMs: 0,
      spanIndexes: [],
      tags: new Set<SafeSpanTag>(),
    };
    if (isReadPhase(span.phase)) acc.reads++;
    if (isWritePhase(span.phase)) acc.edits++;
    if (span.phase === 'run') acc.runs++;
    if (span.status === 'error') acc.failures++;
    if (span.durationMs !== undefined) acc.durationMs += Math.max(0, Math.round(span.durationMs));
    acc.spanIndexes.push(i);
    for (const tag of spanTags[i] ?? []) {
      if (tag !== 'normal') acc.tags.add(tag);
    }
    byTurn.set(span.turnIndex, acc);
  }
  return [...byTurn.entries()]
    .map(([turnIndex, acc]) => {
      let severity: InsightSeverity = 'info';
      let id = 'turn_normal';
      const params: Record<string, string | number> = {
        reads: acc.reads,
        edits: acc.edits,
        runs: acc.runs,
        failures: acc.failures,
        durationMs: acc.durationMs,
      };
      if (acc.failures > 0) {
        severity = 'bad';
        id = 'turn_has_failures';
      } else if (acc.tags.has('slow') || acc.durationMs >= slowThresholdMs) {
        severity = 'warn';
        id = 'turn_has_slow_spans';
      } else if (acc.tags.has('retry')) {
        severity = 'warn';
        id = 'turn_has_retries';
      }
      return {
        turnIndex,
        severity,
        headline: { id, params },
        metrics: {
          reads: acc.reads,
          edits: acc.edits,
          runs: acc.runs,
          failures: acc.failures,
          durationMs: acc.durationMs,
        },
        spanIndexes: acc.spanIndexes.slice(0, DIAGNOSTIC_TARGET_CAP),
        tags: acc.tags.size ? [...acc.tags] : (['normal'] as SafeSpanTag[]),
      };
    })
    .filter(d => d.severity !== 'info')
    .sort((a, b) => a.turnIndex - b.turnIndex);
}

function recordFromStats(stats: SafeInsightDiagnostic['stats'] | undefined): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(stats ?? {})) {
    out[key] = value;
  }
  return out;
}

function recommendationsForDiagnostics(diagnostics: SafeInsightDiagnostic[]): DiagnosticRecommendation[] {
  return diagnostics
    .filter(d => d.kind !== 'none')
    .map(d => {
      const stats = recordFromStats(d.stats);
      const base = (id: string, impactId: string, whyId: string, actionIds: string[]): DiagnosticRecommendation => ({
        id,
        diagnosticId: d.id,
        severity: d.severity,
        impact: { id: impactId, params: stats },
        why: { id: whyId, params: stats },
        nextActions: actionIds.map(actionId => ({ id: actionId, params: stats })),
        evidence: {
          spanIndexes: d.targets.spanIndexes,
          turnIndexes: d.targets.turnIndexes,
          counts: stats,
        },
      });
      if (d.kind === 'tool_failure') {
        return base(
          'fix_repeated_tool_failures',
          'impact_failed_spans',
          'why_tool_failure_concentrated',
          ['inspect_failed_span_details', 'add_preflight_or_timeout'],
        );
      }
      if (d.kind === 'slow_span') {
        return base(
          'split_slow_operation',
          'impact_slow_spans',
          'why_slow_span_dominates',
          ['narrow_or_split_slow_operation', 'surface_timeout_or_progress'],
        );
      }
      if (d.kind === 'read_write_imbalance') {
        return base(
          'add_read_pass_before_edit',
          'impact_low_read_write_ratio',
          'why_edits_outpaced_reads',
          ['read_or_search_before_editing', 'verify_assumptions_before_running'],
        );
      }
      return base(
        'preserve_context_checkpoints',
        'impact_context_compaction',
        'why_context_compaction_happened',
        ['write_checkpoints_for_long_tasks'],
      );
    });
}

function spanDetailHeadline(span: SafeSpan): { id: string; params: Record<string, string | number> } {
  return {
    id: span.status === 'error'
      ? 'span_failed'
      : span.tags?.includes('slow')
        ? 'span_slow'
        : 'span_completed',
    params: {
      tool: span.tool,
      intentKind: span.intent?.kind ?? 'unknown',
      subject: span.intent?.subject ?? '',
      resultCategory: span.result?.category ?? 'unknown',
      durationMs: span.durationMs ?? 0,
    },
  };
}

function attachSpanDetails(spans: SafeSpan[] | undefined): SafeSpan[] | undefined {
  if (!spans) return undefined;
  return spans.map((span, index) => ({
    ...span,
    detail: {
      headline: spanDetailHeadline(span),
      phase: span.phase,
      status: span.status,
      ...(span.durationMs !== undefined ? { durationMs: span.durationMs } : {}),
      turnIndex: span.turnIndex,
      tags: span.tags ?? ['normal'],
      ...(span.intent ? { intent: span.intent } : {}),
      ...(span.result ? { result: span.result } : {}),
      ...(span.evidence ? { evidence: span.evidence } : {}),
      context: {
        ...(spans[index - 1]?.intent ? { previousIntent: spans[index - 1]!.intent } : {}),
        ...(spans[index + 1]?.intent ? { nextIntent: spans[index + 1]!.intent } : {}),
      },
    },
  }));
}

function timelineKindForSpan(span: SafeSpan): TurnTimelineEventKind {
  if (span.phase === 'research') return 'read';
  if (span.phase === 'edit') return 'edit';
  if (span.phase === 'run') return span.status === 'error' ? 'result' : 'run';
  if (span.phase === 'delegate') return 'delegate';
  return 'discuss';
}

function timelineLabelForSpan(span: SafeSpan): { id: string; params: Record<string, string | number> } {
  return {
    id: span.status === 'error' ? 'timeline_span_failed' : 'timeline_span_completed',
    params: {
      tool: span.tool,
      intentKind: span.intent?.kind ?? 'unknown',
      subject: span.intent?.subject ?? '',
      resultCategory: span.result?.category ?? 'unknown',
      durationMs: span.durationMs ?? 0,
    },
  };
}

function metricsForTimeline(spans: SafeSpan[]): TurnEfficiencyDiagnostic['metrics'] {
  return spans.reduce((acc, span) => {
    if (isReadPhase(span.phase)) acc.reads++;
    if (isWritePhase(span.phase)) acc.edits++;
    if (span.phase === 'run') acc.runs++;
    if (span.status === 'error') acc.failures++;
    if (span.durationMs !== undefined) acc.durationMs += span.durationMs;
    return acc;
  }, { reads: 0, edits: 0, runs: 0, failures: 0, durationMs: 0 });
}

function buildTurnTimeline(
  spans: SafeSpan[] | undefined,
  turnDiagnostics: TurnEfficiencyDiagnostic[],
  turnPrompts: TurnPromptPreview[] | undefined,
  turnContext: TurnContextPoint[] | undefined,
  turnAgentSay?: AgentSay[],
  allSpanTurnIndexes?: ReadonlySet<number>,
): TurnTimelineTurn[] {
  if (!spans) return [];
  const diagByTurn = new Map(turnDiagnostics.map(d => [d.turnIndex, d]));
  const grouped = new Map<number, Array<{ span: SafeSpan; index: number }>>();
  spans.forEach((span, index) => {
    const row = grouped.get(span.turnIndex) ?? [];
    row.push({ span, index });
    grouped.set(span.turnIndex, row);
  });
  // A fully tool-less turn (pure Q&A / clarification / text-only reply) has no
  // span, so keying turns off `grouped` alone would drop it from the timeline and
  // the conversation replay. Union in turn indices that carry a prompt / context /
  // narration — but ONLY when the turn is genuinely span-less (absent from
  // `allSpanTurnIndexes`, the full un-capped span set). A turn whose spans exist
  // but were trimmed by the maxSpans cap must NOT be re-added as an events:[] turn:
  // that would misrepresent a capped turn as a 0-op turn and leak its prompt/say
  // preview past the cap. When `allSpanTurnIndexes` is omitted (uncapped paths)
  // every real-span turn is already in `grouped`, so the guard is a no-op.
  // Detail==='summary' passes the prompt/context/say arrays undefined, so summary
  // reports stay span-only.
  const turnIndexes = new Set<number>(grouped.keys());
  const consider = (i: number): void => {
    if (grouped.has(i) || !allSpanTurnIndexes?.has(i)) turnIndexes.add(i);
  };
  turnPrompts?.forEach((p, i) => { if (p) consider(i); });
  turnContext?.forEach((c, i) => { if (c) consider(i); });
  turnAgentSay?.forEach((s, i) => { if (s?.text) consider(i); });
  return [...turnIndexes]
    .sort((a, b) => a - b)
    .map(turnIndex => {
      const rows = grouped.get(turnIndex) ?? [];
      const rowSpans = rows.map(r => r.span);
      const diag = diagByTurn.get(turnIndex);
      const tags = [...new Set(rowSpans.flatMap(s => s.tags ?? ['normal']))] as SafeSpanTag[];
      const metrics = diag?.metrics ?? metricsForTimeline(rowSpans);
      return {
        turnIndex,
        severity: diag?.severity ?? 'info',
        ...(turnPrompts?.[turnIndex] ? { prompt: turnPrompts[turnIndex] } : {}),
        ...(turnAgentSay?.[turnIndex]?.text ? { agentSay: turnAgentSay[turnIndex] } : {}),
        ...(turnContext?.[turnIndex] ? { context: turnContext[turnIndex] } : {}),
        headline: diag?.headline ?? { id: 'turn_normal', params: metrics },
        metrics,
        tags,
        events: rows.map(({ span, index }) => ({
          kind: timelineKindForSpan(span),
          spanIndex: index,
          label: timelineLabelForSpan(span),
          phase: span.phase,
          status: span.status,
          ...(span.durationMs !== undefined ? { durationMs: span.durationMs } : {}),
          ...(span.intent ? { intent: span.intent } : {}),
          ...(span.result ? { result: span.result } : {}),
          ...(span.tags ? { tags: span.tags } : {}),
          ...(span.evidence ? { evidence: span.evidence } : {}),
        })),
      };
    })
    .sort((a, b) => {
      const sev = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
      return sev || a.turnIndex - b.turnIndex;
    });
}

function roleForPromptSource(source: TurnPromptPreview['source'] | undefined): InsightConversationRole {
  if (source?.kind === 'a2a_agent') return 'a2a_agent';
  if (source?.kind === 'system') return 'system';
  return 'user';
}

function authorForPromptSource(source: TurnPromptPreview['source'] | undefined): string | undefined {
  if (source?.kind === 'a2a_agent') return source.agentName ?? source.senderName;
  if (source?.kind === 'system') return source.senderName ?? 'system';
  return source?.senderName;
}

function buildConversationProjection(turns: TurnTimelineTurn[]): InsightConversationMessage[] {
  const messages: InsightConversationMessage[] = [];
  for (const turn of turns.slice().sort((a, b) => a.turnIndex - b.turnIndex)) {
    if (turn.prompt) {
      messages.push({
        id: `turn-${turn.turnIndex}-prompt`,
        turnIndex: turn.turnIndex,
        role: roleForPromptSource(turn.prompt.source),
        severity: turn.severity,
        tags: turn.tags,
        ...(authorForPromptSource(turn.prompt.source) ? { author: authorForPromptSource(turn.prompt.source) } : {}),
        text: turn.prompt.text,
        truncated: turn.prompt.truncated,
        ...(turn.prompt.source ? { source: turn.prompt.source } : {}),
      });
    }
    if (turn.agentSay?.text) {
      // Agent narration as a 'say' message (role 'agent', text but no event) — sits
      // before the turn's operations so the replay reads 你说 → agent 说 → agent 做.
      messages.push({
        id: `turn-${turn.turnIndex}-say`,
        turnIndex: turn.turnIndex,
        role: 'agent',
        severity: turn.severity,
        tags: turn.tags,
        author: 'agent',
        text: turn.agentSay.text,
        truncated: turn.agentSay.truncated,
      });
    }
    for (let i = 0; i < turn.events.length; i++) {
      const event = turn.events[i]!;
      const tags = event.tags ?? ['normal'];
      messages.push({
        id: `turn-${turn.turnIndex}-event-${event.spanIndex}-${i}`,
        turnIndex: turn.turnIndex,
        role: 'agent',
        severity: event.status === 'error' ? 'bad' : tags.includes('slow') ? 'warn' : turn.severity,
        tags,
        author: 'agent',
        event,
      });
    }
  }
  return messages;
}

function conversationSearchText(message: InsightConversationMessage): string {
  const parts = [
    message.author,
    message.text,
    message.role,
    message.severity,
    ...(message.tags ?? []),
    message.source?.senderName,
    message.source?.agentName,
    message.event?.intent?.kind,
    message.event?.intent?.subject,
    message.event?.intent?.detail,
    message.event?.result?.category,
    message.event?.evidence?.command?.text,
    message.event?.evidence?.output?.text,
  ];
  return parts.filter(Boolean).join('\n').toLowerCase();
}

function filterConversationMessages(
  messages: InsightConversationMessage[],
  opts: BuildInsightTurnPromptOptions,
): InsightConversationMessage[] {
  const q = opts.q?.trim().toLowerCase();
  const turns = opts.turnIndexes?.length ? new Set(opts.turnIndexes.map(x => Math.max(0, Math.floor(x)))) : undefined;
  return messages.filter(message => {
    if (turns && !turns.has(message.turnIndex)) return false;
    if (opts.role && message.role !== opts.role) return false;
    if (opts.severity && message.severity !== opts.severity) return false;
    if (opts.tag && !(message.tags ?? []).includes(opts.tag)) return false;
    if (q && !conversationSearchText(message).includes(q)) return false;
    return true;
  });
}

function buildDetailTimelineFromParsed(parsed: InsightParseResult, slowThresholdMs: number): TurnTimelineTurn[] {
  const tags = tagsForVisibleSpans(parsed.spans, slowThresholdMs);
  const safeSpans = attachSpanDetails(parsed.spans.map((span, index) => toSafeSpan(span, parsed.firstEventMs, tags[index]))) ?? [];
  const turnDiagnostics = buildTurnDiagnostics(parsed.spans, slowThresholdMs);
  return buildTurnTimeline(safeSpans, turnDiagnostics, parsed.turnPrompts, parsed.turnContext, parsed.turnAgentSay);
}

function resolveAndParseForPrompt(
  q: InsightReportQuery,
  promptMax: number,
): { parsed: InsightParseResult; kind: string } | { error: 'unsupported_cli' | 'transcript_missing' | 'parse_error' } {
  if (q.cliId && !SUPPORTED_CLI_IDS.has(q.cliId)) return { error: 'unsupported_cli' };
  const resolved = resolveSessionTranscriptPath(q);
  if (!resolved) return { error: 'transcript_missing' };
  if (!isSupportedTranscriptKind(resolved.kind)) return { error: 'unsupported_cli' };
  if (!existsSync(resolved.path)) return { error: 'transcript_missing' };
  try {
    const parsed = parseForKind(resolved.kind, resolved.path, { promptMax });
    if (!parsed) return { error: 'unsupported_cli' };
    return { parsed, kind: resolved.kind };
  } catch {
    return { error: 'parse_error' };
  }
}

export function buildSafeInsightTurnDetail(
  q: InsightReportQuery,
  turnIndexInput: number,
  opts: BuildInsightTurnPromptOptions = {},
): SafeInsightTurnDetail {
  const turnIndex = Math.max(0, Math.floor(turnIndexInput));
  const offset = Math.max(0, Math.floor(opts.offset ?? 0));
  const limit = Math.min(Math.max(Math.floor(opts.limit ?? 4000) || 4000, 1), 20_000);
  const resolved = resolveAndParseForPrompt(q, Number.MAX_SAFE_INTEGER);
  if ('error' in resolved) return promptUnavailable(q, turnIndex, offset, limit, resolved.error);
  const parsed = resolved.parsed;

  const prompt = parsed.turnPrompts?.[turnIndex];
  const total = prompt?.text.length ?? 0;
  const text = prompt ? prompt.text.slice(offset, offset + limit) : '';
  const nextOffset = offset + text.length;
  const hasMore = nextOffset < total;
  const turnTimeline = buildDetailTimelineFromParsed(parsed, DEFAULT_SLOW_THRESHOLD_MS);
  const messages = buildConversationProjection(turnTimeline).filter(m => m.turnIndex === turnIndex && m.role === 'agent');
  return {
    sessionId: q.sessionId,
    cliId: q.cliId ?? 'unknown',
    status: 'ok',
    turnIndex,
    offset,
    limit,
    total,
    ...(hasMore ? { nextOffset } : {}),
    hasMore,
    ...(prompt ? {
      prompt: {
        text,
        truncated: hasMore,
        ...(prompt.source ? { source: prompt.source } : {}),
      },
    } : {}),
    messages,
  };
}

export function buildSafeInsightConversation(
  q: InsightReportQuery,
  opts: BuildInsightTurnPromptOptions = {},
): SafeInsightConversation {
  const offset = Math.max(0, Math.floor(opts.offset ?? 0));
  const limit = Math.min(Math.max(Math.floor(opts.limit ?? 50) || 50, 1), 200);
  const resolved = resolveAndParseForPrompt(q, 400);
  if ('error' in resolved) return conversationUnavailable(q, offset, limit, resolved.error);
  const turnTimeline = buildDetailTimelineFromParsed(resolved.parsed, DEFAULT_SLOW_THRESHOLD_MS);
  const all = filterConversationMessages(buildConversationProjection(turnTimeline), opts);
  const messages = all.slice(offset, offset + limit);
  const nextOffset = offset + messages.length;
  const hasMore = nextOffset < all.length;
  return {
    sessionId: q.sessionId,
    cliId: q.cliId ?? 'unknown',
    status: 'ok',
    offset,
    limit,
    total: all.length,
    ...(hasMore ? { nextOffset } : {}),
    hasMore,
    messages,
  };
}

export function buildSafeInsightReport(q: InsightReportQuery, opts: BuildInsightReportOptions = {}): SafeInsightReport {
  const detail = opts.detail ?? 'summary';
  const parsedAt = (opts.now?.() ?? new Date()).toISOString();
  if (q.cliId && !SUPPORTED_CLI_IDS.has(q.cliId)) return unsupported(q, detail, parsedAt, 'unsupported_cli');
  const resolved = resolveSessionTranscriptPath(q);
  if (!resolved) return unsupported(q, detail, parsedAt, 'transcript_missing');
  if (!isSupportedTranscriptKind(resolved.kind)) return unsupported(q, detail, parsedAt, 'unsupported_cli');
  if (!existsSync(resolved.path)) return unsupported(q, detail, parsedAt, 'transcript_missing');

  let parsed: InsightParseResult;
  try {
    const maybe = cachedParseForKind(resolved.kind, resolved.path);
    if (!maybe) return unsupported(q, detail, parsedAt, 'unsupported_cli');
    parsed = maybe;
  } catch {
    return unsupported(q, detail, parsedAt, 'parse_error');
  }

  const slowThresholdMs = opts.slowThresholdMs ?? DEFAULT_SLOW_THRESHOLD_MS;
  const maxSpans = opts.maxSpans ?? DEFAULT_MAX_SPANS;
  const agg = aggregate(parsed.spans, parsed.compactions, slowThresholdMs);
  const suggestions = suggestionsFor(agg, parsed.spans, slowThresholdMs);
  const visibleRaw = detail === 'spans'
    ? selectVisibleSpans(parsed.spans, maxSpans, slowThresholdMs)
    : undefined;
  const visibleTags = visibleRaw ? tagsForVisibleSpans(visibleRaw, slowThresholdMs) : undefined;
  const visible = attachSpanDetails(visibleRaw?.map((s, index) => toSafeSpan(s, parsed.firstEventMs, visibleTags?.[index])));
  const diagnostics = diagnosticsFor(suggestions, agg, parsed.spans, visibleRaw, slowThresholdMs);
  const turnDiagnostics = buildTurnDiagnostics(visibleRaw, slowThresholdMs);
  // `visible` is capped to maxSpans; pass the FULL span turn set so a turn whose
  // spans were trimmed by the cap isn't re-synthesized as an events:[] turn (only
  // genuinely tool-less turns get unioned in). See buildTurnTimeline.
  const allSpanTurnIndexes = detail === 'spans' ? new Set(parsed.spans.map(s => s.turnIndex)) : undefined;
  const turnTimeline = buildTurnTimeline(visible, turnDiagnostics, detail === 'spans' ? parsed.turnPrompts : undefined, detail === 'spans' ? parsed.turnContext : undefined, detail === 'spans' ? parsed.turnAgentSay : undefined, allSpanTurnIndexes);
  const report: SafeInsightReport = {
    sessionId: q.sessionId,
    cliId: q.cliId ?? 'unknown',
    status: 'ok',
    meta: {
      parsedAt,
      asOf: parsed.asOf,
      partial: parsed.partial,
      detail,
      spansTotal: parsed.spans.length,
    },
    agg,
    suggestions,
    diagnostics,
    recommendations: recommendationsForDiagnostics(diagnostics),
    turnDiagnostics,
    turnTimeline,
  };

  if (detail === 'spans' && visible) {
    report.spans = visible;
    report.meta.spansReturned = visible.length;
    report.meta.capped = parsed.spans.length > visible.length;
    report.workSummary = buildWorkSummary(visibleRaw ?? [], visible, q.cwd);
  }

  return report;
}

function mergeAgg(into: SafeInsightAggregate, agg: SafeInsightAggregate): void {
  // Defensive: in the cross-daemon merge, `agg` comes from a peer daemon's HTTP
  // response, so don't assume its shape — a malformed chunk must not throw and
  // 500 the whole aggregated overview (it should just contribute nothing).
  if (!agg || typeof agg !== 'object') return;
  into.totalSpans += agg.totalSpans ?? 0;
  into.failedSpans += agg.failedSpans ?? 0;
  into.slowSpans += agg.slowSpans ?? 0;
  into.compactions += agg.compactions ?? 0;
  for (const [tool, count] of Object.entries(agg.failByTool ?? {})) {
    into.failByTool[tool] = (into.failByTool[tool] ?? 0) + (count ?? 0);
  }
  for (const phase of INSIGHT_PHASES) {
    into.phase[phase].count += agg.phase?.[phase]?.count ?? 0;
    into.phase[phase].ms += agg.phase?.[phase]?.ms ?? 0;
  }
}

function overviewSuggestions(reports: SafeInsightReport[]): SafeInsightOverviewSuggestion[] {
  const byId = new Map<string, SafeInsightOverviewSuggestion>();
  for (const report of reports) {
    if (report.status !== 'ok') continue;
    for (const s of report.suggestions) {
      const cur = byId.get(s.id);
      if (cur) {
        cur.count += 1;
        for (const e of s.evidence) {
          if (cur.evidence.length >= 4) break;
          if (!cur.evidence.includes(e)) cur.evidence.push(e);
        }
      } else {
        byId.set(s.id, {
          id: s.id,
          title: s.title,
          severity: s.severity,
          count: 1,
          evidence: s.evidence.slice(0, 4),
          action: s.action,
        });
      }
    }
  }
  return [...byId.values()]
    .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || b.count - a.count || a.id.localeCompare(b.id))
    .slice(0, 12);
}

/** Yield to the event loop so a large overview (up to MAX_OVERVIEW_LIMIT sessions,
 *  each a synchronous transcript read+parse) can't monopolize the single-threaded
 *  daemon — Lark dispatch / PTY IO get a slot between batches. */
const OVERVIEW_YIELD_EVERY = 16;
function yieldToEventLoop(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

export async function buildSafeInsightOverview(
  sessions: InsightOverviewSessionInput[],
  opts: BuildInsightOverviewOptions = {},
): Promise<SafeInsightOverview> {
  const parsedAt = (opts.now?.() ?? new Date()).toISOString();
  const requestedLimit = opts.limit ?? DEFAULT_OVERVIEW_LIMIT;
  const limit = Math.min(Math.max(Math.floor(requestedLimit) || DEFAULT_OVERVIEW_LIMIT, 1), MAX_OVERVIEW_LIMIT);
  const input = sessions
    .slice()
    .sort((a, b) => Number(b.lastMessageAt ?? 0) - Number(a.lastMessageAt ?? 0));
  const selected = input.slice(0, limit);
  const rows: SafeInsightOverview['sessions'] = [];
  for (let i = 0; i < selected.length; i++) {
    const s = selected[i]!;
    rows.push({
      sessionId: s.sessionId,
      cliId: s.cliId ?? 'unknown',
      cliSessionId: s.cliSessionId,
      title: s.title,
      botName: s.botName,
      larkAppId: s.larkAppId,
      workingDir: s.workingDir ?? s.cwd,
      status: s.status,
      lastMessageAt: s.lastMessageAt,
      report: buildSafeInsightReport(s, { ...opts, detail: 'summary', now: () => new Date(parsedAt) }),
    });
    if ((i + 1) % OVERVIEW_YIELD_EVERY === 0 && i + 1 < selected.length) await yieldToEventLoop();
  }
  const reports = rows.map(r => r.report);
  const okReports = reports.filter(r => r.status === 'ok');
  const agg = emptyAgg();
  let rwSum = 0;
  let rwN = 0;
  for (const report of okReports) {
    mergeAgg(agg, report.agg);
    if (report.agg.readWriteRatio !== null) {
      rwSum += report.agg.readWriteRatio;
      rwN++;
    }
  }
  agg.readWriteRatio = rwN > 0 ? Math.round((rwSum / rwN) * 100) / 100 : null;
  return {
    generatedAt: parsedAt,
    meta: {
      totalSessions: input.length,
      returnedSessions: rows.length,
      analyzedSessions: okReports.length,
      unsupportedSessions: reports.filter(r => r.status === 'unsupported_cli').length,
      missingTranscriptSessions: reports.filter(r => r.status === 'transcript_missing').length,
      parseErrorSessions: reports.filter(r => r.status === 'parse_error').length,
      capped: input.length > selected.length,
      limit,
    },
    agg,
    suggestions: overviewSuggestions(reports),
    topFailedTools: Object.entries(agg.failByTool)
      .map(([tool, count]) => ({ tool, count }))
      .sort((a, b) => b.count - a.count || a.tool.localeCompare(b.tool))
      .slice(0, 12),
    topSlowSessions: rows
      .filter(r => r.report.status === 'ok' && r.report.agg.slowSpans > 0)
      .map(r => ({
        sessionId: r.sessionId,
        title: r.title,
        cliId: r.cliId,
        slowSpans: r.report.agg.slowSpans,
        totalSpans: r.report.agg.totalSpans,
      }))
      .sort((a, b) => b.slowSpans - a.slowSpans || b.totalSpans - a.totalSpans)
      .slice(0, 12),
    sessions: rows,
  };
}

export function mergeSafeInsightOverviews(
  overviews: SafeInsightOverview[],
  opts: { generatedAt?: string; limit?: number } = {},
): SafeInsightOverview {
  const generatedAt = opts.generatedAt ?? new Date().toISOString();
  const requestedLimit = opts.limit ?? DEFAULT_OVERVIEW_LIMIT;
  const limit = Math.min(Math.max(Math.floor(requestedLimit) || DEFAULT_OVERVIEW_LIMIT, 1), MAX_OVERVIEW_LIMIT);
  const allRows = overviews
    .flatMap(o => o.sessions)
    .sort((a, b) => Number(b.lastMessageAt ?? 0) - Number(a.lastMessageAt ?? 0));
  const rows = allRows.slice(0, limit);
  const reports = rows.map(r => r.report);
  const okReports = reports.filter(r => r.status === 'ok');
  const agg = emptyAgg();
  let rwSum = 0;
  let rwN = 0;
  for (const report of okReports) {
    mergeAgg(agg, report.agg);
    if (report.agg.readWriteRatio !== null) {
      rwSum += report.agg.readWriteRatio;
      rwN++;
    }
  }
  agg.readWriteRatio = rwN > 0 ? Math.round((rwSum / rwN) * 100) / 100 : null;
  return {
    generatedAt,
    meta: {
      totalSessions: overviews.reduce((sum, o) => sum + o.meta.totalSessions, 0),
      returnedSessions: rows.length,
      analyzedSessions: okReports.length,
      unsupportedSessions: reports.filter(r => r.status === 'unsupported_cli').length,
      missingTranscriptSessions: reports.filter(r => r.status === 'transcript_missing').length,
      parseErrorSessions: reports.filter(r => r.status === 'parse_error').length,
      capped: allRows.length > rows.length || overviews.some(o => o.meta.capped),
      limit,
    },
    agg,
    suggestions: overviewSuggestions(reports),
    topFailedTools: Object.entries(agg.failByTool)
      .map(([tool, count]) => ({ tool, count }))
      .sort((a, b) => b.count - a.count || a.tool.localeCompare(b.tool))
      .slice(0, 12),
    topSlowSessions: rows
      .filter((r): r is SafeInsightOverviewSession & { report: SafeInsightReport & { status: 'ok' } } => r.report.status === 'ok' && r.report.agg.slowSpans > 0)
      .map(r => ({
        sessionId: r.sessionId,
        title: r.title,
        cliId: r.cliId,
        slowSpans: r.report.agg.slowSpans,
        totalSpans: r.report.agg.totalSpans,
      }))
      .sort((a, b) => b.slowSpans - a.slowSpans || b.totalSpans - a.totalSpans)
      .slice(0, 12),
    sessions: rows,
  };
}
