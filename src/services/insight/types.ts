import type { CliId } from '../../adapters/cli/types.js';

export type InsightDetail = 'summary' | 'spans';
export type InsightStatus = 'ok' | 'unsupported_cli' | 'transcript_missing' | 'parse_error';
export type InsightPhase = 'research' | 'edit' | 'run' | 'delegate' | 'discuss';
export type InsightSpanStatus = 'ok' | 'error' | 'running';
export type InsightSeverity = 'info' | 'warn' | 'bad';
export type InsightDiagnosticKind =
  | 'tool_failure'
  | 'slow_span'
  | 'read_write_imbalance'
  | 'compaction'
  | 'none';
export type SafeSpanIntentKind =
  | 'run_script'
  | 'test'
  | 'typecheck'
  | 'lint'
  | 'git'
  | 'search'
  | 'read_file'
  | 'edit_file'
  | 'write_file'
  | 'delegate'
  | 'unknown';
export type SafeSpanResultCategory =
  | 'ok'
  | 'tool_error'
  | 'test_failed'
  | 'typecheck_failed'
  | 'lint_failed'
  | 'command_failed'
  | 'timeout'
  | 'no_output'
  | 'unknown';
export type SafeSpanTag =
  | 'failure'
  | 'slow'
  | 'retry'
  | 'read_write_imbalance'
  | 'diagnostic'
  | 'normal';
export type TurnTimelineEventKind = 'read' | 'edit' | 'run' | 'delegate' | 'discuss' | 'result';

export interface SafeInsightReport {
  sessionId: string;
  cliId: string;
  status: InsightStatus;
  meta: {
    parsedAt: string;
    asOf?: string;
    partial: boolean;
    detail: InsightDetail;
    spansReturned?: number;
    spansTotal?: number;
    capped?: boolean;
  };
  agg: SafeInsightAggregate;
  suggestions: SafeInsightSuggestion[];
  diagnostics: SafeInsightDiagnostic[];
  recommendations: DiagnosticRecommendation[];
  turnDiagnostics: TurnEfficiencyDiagnostic[];
  turnTimeline: TurnTimelineTurn[];
  workSummary?: SafeInsightWorkSummary;
  spans?: SafeSpan[];
  error?: { code: InsightStatus; message: string };
}

export interface SafeInsightTurnDetail {
  sessionId: string;
  cliId: string;
  status: InsightStatus;
  turnIndex: number;
  offset: number;
  limit: number;
  total: number;
  nextOffset?: number;
  hasMore: boolean;
  prompt?: TurnPromptPreview;
  messages?: InsightConversationMessage[];
  error?: { code: InsightStatus; message: string };
}

export interface SafeInsightConversation {
  sessionId: string;
  cliId: string;
  status: InsightStatus;
  offset: number;
  limit: number;
  total: number;
  nextOffset?: number;
  hasMore: boolean;
  messages: InsightConversationMessage[];
  error?: { code: InsightStatus; message: string };
}

export interface SafeInsightOverviewSession {
  sessionId: string;
  cliId: string;
  cliSessionId?: string;
  title?: string;
  botName?: string;
  larkAppId?: string;
  workingDir?: string;
  status?: string;
  lastMessageAt?: number;
  report: SafeInsightReport;
}

export interface SafeInsightOverviewSuggestion {
  id: string;
  title: string;
  severity: InsightSeverity;
  count: number;
  evidence: string[];
  action: string;
}

export interface SafeInsightOverview {
  generatedAt: string;
  meta: {
    totalSessions: number;
    returnedSessions: number;
    analyzedSessions: number;
    unsupportedSessions: number;
    missingTranscriptSessions: number;
    parseErrorSessions: number;
    capped: boolean;
    limit: number;
  };
  agg: SafeInsightAggregate;
  suggestions: SafeInsightOverviewSuggestion[];
  topFailedTools: Array<{ tool: string; count: number }>;
  topSlowSessions: Array<{ sessionId: string; title?: string; cliId: string; slowSpans: number; totalSpans: number }>;
  sessions: SafeInsightOverviewSession[];
}

export interface InsightOverviewSessionInput extends InsightReportQuery {
  title?: string;
  botName?: string;
  larkAppId?: string;
  workingDir?: string;
  status?: string;
  lastMessageAt?: number;
}

export interface SafeInsightAggregate {
  totalSpans: number;
  failedSpans: number;
  slowSpans: number;
  failByTool: Record<string, number>;
  phase: Record<InsightPhase, { count: number; ms: number }>;
  readWriteRatio: number | null;
  compactions: number;
  subagentCostShare: number | null;
}

export interface SafeInsightWorkSummary {
  fileChanges: SafeInsightFileWork[];
  commandsRun: SafeInsightCommandWork[];
}

export interface SafeInsightFileWork {
  path: string;
  reads: number;
  edits: number;
  added?: number;
  removed?: number;
  turnIndexes: number[];
  spanIndexes: number[];
}

export interface SafeInsightCommandWork {
  command: SafeTextPreview;
  count: number;
  failures: number;
  totalDurationMs: number;
  maxDurationMs?: number;
  lastStatus: InsightSpanStatus;
  turnIndexes: number[];
  spanIndexes: number[];
}

export interface SafeInsightSuggestion {
  id: string;
  title: string;
  severity: InsightSeverity;
  evidence: string[];
  action: string;
}

export interface SafeInsightDiagnostic {
  /** Stable diagnostic key. MVP keeps this 1:1 with suggestionId. */
  id: string;
  suggestionId: string;
  kind: InsightDiagnosticKind;
  severity: InsightSeverity;
  /** Fallback copy only; dashboard should prefer i18n by id. */
  title: string;
  /** Safe projection only: enum labels, tool names and numbers; never raw input/output/path. */
  reason: string;
  targets: {
    /** Indexes into SafeInsightReport.spans when detail=spans. Capped and omitted in summary detail. */
    spanIndexes?: number[];
    /** Turn indexes corresponding to target spans. Capped and omitted when unavailable. */
    turnIndexes?: number[];
    tools?: string[];
  };
  stats?: Record<string, number | string>;
}

export interface SafeSpan {
  tool: string;
  phase: InsightPhase;
  turnIndex: number;
  /** Relative to session start. */
  relStartMs: number;
  /** Missing means unknown/running, not zero-duration. */
  durationMs?: number;
  status: InsightSpanStatus;
  inputSummary?: string;
  outputSummary?: string;
  intent?: SafeSpanIntent;
  result?: SafeSpanResult;
  tags?: SafeSpanTag[];
  evidence?: SafeSpanEvidenceDetail;
  detail?: SafeSpanDetail;
}

export interface SafeSpanIntent {
  kind: SafeSpanIntentKind;
  subject?: string;
  detail?: string;
}

export interface SafeSpanResult {
  category: SafeSpanResultCategory;
  exitCode?: number;
}

export interface SafeTextPreview {
  text: string;
  truncated: boolean;
}

export interface SafeSpanEvidenceDetail {
  command?: SafeTextPreview;
  output?: SafeTextPreview;
}

export interface SafeSpanDetail {
  headline: {
    id: string;
    params: Record<string, string | number>;
  };
  phase: InsightPhase;
  status: InsightSpanStatus;
  durationMs?: number;
  turnIndex: number;
  tags: SafeSpanTag[];
  intent?: SafeSpanIntent;
  result?: SafeSpanResult;
  evidence?: SafeSpanEvidenceDetail;
  context?: {
    previousIntent?: SafeSpanIntent;
    nextIntent?: SafeSpanIntent;
  };
}

export interface DiagnosticRecommendation {
  id: string;
  diagnosticId: string;
  severity: InsightSeverity;
  impact: {
    id: string;
    params: Record<string, string | number>;
  };
  why: {
    id: string;
    params: Record<string, string | number>;
  };
  nextActions: Array<{
    id: string;
    params: Record<string, string | number>;
  }>;
  evidence: {
    spanIndexes?: number[];
    turnIndexes?: number[];
    counts?: Record<string, string | number>;
  };
}

export interface TurnEfficiencyDiagnostic {
  turnIndex: number;
  severity: InsightSeverity;
  headline: {
    id: string;
    params: Record<string, string | number>;
  };
  metrics: {
    reads: number;
    edits: number;
    runs: number;
    failures: number;
    durationMs: number;
  };
  spanIndexes: number[];
  tags: SafeSpanTag[];
}

export interface TurnTimelineTurn {
  turnIndex: number;
  severity: InsightSeverity;
  prompt?: TurnPromptPreview;
  agentSay?: AgentSay;
  context?: TurnContextPoint;
  headline: {
    id: string;
    params: Record<string, string | number>;
  };
  metrics: TurnEfficiencyDiagnostic['metrics'];
  tags: SafeSpanTag[];
  events: TurnTimelineEvent[];
}

export interface TurnTimelineEvent {
  kind: TurnTimelineEventKind;
  spanIndex: number;
  label: {
    id: string;
    params: Record<string, string | number>;
  };
  phase: InsightPhase;
  status: InsightSpanStatus;
  durationMs?: number;
  intent?: SafeSpanIntent;
  result?: SafeSpanResult;
  tags?: SafeSpanTag[];
  evidence?: SafeSpanEvidenceDetail;
}

export type InsightConversationRole = 'user' | 'a2a_agent' | 'system' | 'agent';

export interface InsightConversationMessage {
  id: string;
  turnIndex: number;
  role: InsightConversationRole;
  severity?: InsightSeverity;
  tags?: SafeSpanTag[];
  author?: string;
  text?: string;
  truncated?: boolean;
  source?: TurnPromptSource;
  event?: TurnTimelineEvent;
}

export interface TurnPromptPreview {
  text: string;
  truncated: boolean;
  source?: TurnPromptSource;
}

export interface TurnPromptSource {
  /** UI filter key. Product surface should expose user / A2A / system buckets. */
  kind: 'user' | 'a2a_agent' | 'system';
  /** Present for A2A prompts when the sending agent name is known. */
  agentName?: string;
  senderType?: 'user' | 'bot' | 'system' | 'unknown';
  senderName?: string;
  isBotSender?: boolean;
  isA2A?: boolean;
  mentionedNames?: string[];
}

export interface TurnContextPoint {
  turnIndex: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  /** Context pressure line: input + cache read + cache creation tokens. */
  contextTokens: number;
  /** Total visible usage at this point: context + output. */
  totalTokens: number;
  model?: string;
  compaction?: boolean;
}

export interface InsightReportQuery {
  cliId?: CliId | 'unknown';
  sessionId: string;
  cliSessionId?: string;
  cwd?: string;
}

export interface RawInsightSpan {
  tool: string;
  phase: InsightPhase;
  turnIndex: number;
  startMs?: number;
  durationMs?: number;
  status: InsightSpanStatus;
  /** Internal only. Must pass through fail-closed safe projection before IPC. */
  inputSummary?: string;
  /** Internal only. Must pass through fail-closed safe projection before IPC. */
  outputSummary?: string;
  /** Reader-produced safe projection only. Never raw input/output/path. */
  intent?: SafeSpanIntent;
  /** Reader-produced safe projection only. Never raw output text. */
  result?: SafeSpanResult;
  /** Reader-produced owner-detail projection. Secrets scrubbed and length capped before IPC. */
  evidence?: SafeSpanEvidenceDetail;
  /** Internal only. Paths are projected relative/safely before IPC. */
  filePaths?: string[];
  /** Internal only. Patch-like text used only for line count estimation. */
  patchText?: string;
  /** Internal only. Reader-estimated edit line counts before safe projection. */
  lineCounts?: { added: number; removed: number };
}

export interface InsightParseResult {
  spans: RawInsightSpan[];
  compactions: number;
  partial: boolean;
  asOf?: string;
  firstEventMs?: number;
  turnPrompts?: TurnPromptPreview[];
  turnContext?: TurnContextPoint[];
  /** Per-turn agent narration (assistant text / codex agent_message), scrubbed +
   *  truncated. Fail-closed: only reaches here after safe projection. */
  turnAgentSay?: AgentSay[];
}

/** Scrubbed, length-capped agent narration for one turn (owner-only, secret-scrubbed). */
export interface AgentSay {
  text: string;
  truncated: boolean;
}

export interface InsightReaderOptions {
  promptMax?: number;
}

export const INSIGHT_PHASES: InsightPhase[] = ['research', 'edit', 'run', 'delegate', 'discuss'];
