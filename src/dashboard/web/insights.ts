// Insight dashboard model/helpers. This file intentionally contains no page
// controller code; React owns rendering and interactions in insights-page.tsx.
import MarkdownIt from 'markdown-it';
import type {
  DiagnosticRecommendation,
  InsightConversationMessage,
  InsightPhase,
  InsightSeverity,
  SafeInsightAggregate,
  SafeInsightOverview,
  SafeInsightOverviewSession,
  SafeInsightOverviewSuggestion,
  SafeInsightReport,
  SafeInsightSuggestion,
  SafeSpanIntent,
  SafeSpanTag,
  TurnPromptPreview,
  TurnTimelineTurn,
} from '../../services/insight/types.js';
import { botDisplayName, escapeHtml, relTime, t } from './ui.js';

export type InsightFilter = 'all' | 'review' | 'failed' | 'slow';

export type InsightRecord = {
  session: Record<string, any>;
  report: SafeInsightReport | null;
  error?: string;
};

export type ScopeOpts = { project?: string; sinceMs?: number; analyzableOnly?: boolean };
export type InsightTab = 'overview' | 'sessions' | 'flow' | 'dist' | 'hot';
export type SessSort = 'recent' | 'review' | 'spans' | 'fails' | 'slow' | 'agent';
export type DetailTab = 'spans' | 'ledger' | 'convo';
export type LedgerSender = 'all' | 'user' | 'a2a_agent' | 'system';

export type ConvoState = {
  messages: InsightConversationMessage[];
  total: number;
  hasMore: boolean;
  nextOffset: number;
  loading: boolean;
  q: string;
  role: string;
  tag: string;
  openOps: Set<string>;
};

export type DetailView = {
  activeId: string | null;
  tab: DetailTab;
  spanFilter: string;
  openSpans: Set<number>;
  openTurns: Set<number>;
  ledgerSort: 'normal' | 'grouped';
  openPrompts: Set<number>;
  rawPrompts: Set<number>;
  ledgerSender: LedgerSender;
  convo: ConvoState;
};

export type DerivedOverview = {
  totalCount: number;
  analyzedCount: number;
  agg: SafeInsightAggregate;
  topFailedTools: Array<{ tool: string; count: number }>;
  suggestions: SafeInsightOverviewSuggestion[];
};

export type HotAgg = {
  key: string;
  label: string;
  sessions: Array<{ id: string; title: string }>;
  reads: number;
  edits: number;
  runs: number;
  fails: number;
  count: number;
};

export type ConvoUnit =
  | { kind: 'prompt'; msg: InsightConversationMessage }
  | { kind: 'ops'; turnIndex: number; msgs: InsightConversationMessage[] };

export const SEVERITY_RANK: Record<InsightSeverity, number> = { bad: 0, warn: 1, info: 2 };
export const INSIGHT_PHASES: InsightPhase[] = ['research', 'edit', 'run', 'delegate', 'discuss'];
export const FLOW_PHASES = ['research', 'edit', 'run', 'delegate', 'discuss'] as const;
export const INSIGHT_TABS: Array<{ key: InsightTab; label: string }> = [
  { key: 'overview', label: 'insights.tabOverview' },
  { key: 'sessions', label: 'insights.tabSessions' },
  { key: 'flow', label: 'insights.tabFlow' },
  { key: 'dist', label: 'insights.tabDist' },
  { key: 'hot', label: 'insights.tabHot' },
];
export const TIME_WINDOWS: Array<{ key: string; label: string; days: number }> = [
  { key: 'all', label: 'insights.timeAll', days: 0 },
  { key: '1d', label: 'insights.time1d', days: 1 },
  { key: '7d', label: 'insights.time7d', days: 7 },
  { key: '30d', label: 'insights.time30d', days: 30 },
];
export const INSIGHT_FILTERS: InsightFilter[] = ['all', 'review', 'failed', 'slow'];
export const INSIGHT_TAB_KEYS: InsightTab[] = ['overview', 'sessions', 'flow', 'dist', 'hot'];
export const SESS_SORTS: Array<{ key: SessSort; label: string }> = [
  { key: 'recent', label: 'insights.sortRecent' },
  { key: 'review', label: 'insights.sortReview' },
  { key: 'spans', label: 'insights.sortSpans' },
  { key: 'fails', label: 'insights.sortFails' },
  { key: 'slow', label: 'insights.sortSlow' },
  { key: 'agent', label: 'insights.sortAgent' },
];
export const SESS_SORT_KEYS: SessSort[] = ['recent', 'review', 'spans', 'fails', 'slow', 'agent'];
export const SPAN_TAGS: SafeSpanTag[] = ['failure', 'slow', 'retry', 'read_write_imbalance'];
export const CONVO_ROLES: Array<{ key: string; label: string }> = [
  { key: 'all', label: 'spanAll' },
  { key: 'user', label: 'senderHuman' },
  { key: 'a2a_agent', label: 'senderA2A' },
  { key: 'system', label: 'senderSystem' },
];
export const CONVO_TAGS: Array<{ key: string; label: string }> = [
  { key: 'all', label: 'spanAll' },
  { key: 'failure', label: 'tag.failure' },
  { key: 'slow', label: 'tag.slow' },
];

export const BAD_RESULTS = new Set<string>(['tool_error', 'test_failed', 'typecheck_failed', 'lint_failed', 'command_failed', 'timeout', 'no_output']);

export function newConvoState(): ConvoState {
  return { messages: [], total: 0, hasMore: false, nextOffset: 0, loading: false, q: '', role: 'all', tag: 'all', openOps: new Set<string>() };
}

export function fmtInt(n: number): string {
  return Number.isFinite(n) ? Math.round(n).toLocaleString('en-US') : '-';
}

export function fmtMs(ms?: number): string {
  if (ms === undefined || ms === null || !Number.isFinite(ms)) return '-';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 60_000)}m`;
}

export function statusIcon(status?: string): string {
  if (status === 'error') return '!';
  if (status === 'running') return '~';
  return 'OK';
}

export function safeStatus(report: SafeInsightReport | null, error?: string): string {
  if (error) return error;
  if (!report) return '-';
  if (report.status === 'unsupported_cli') return t('insights.unsupported');
  if (report.status === 'transcript_missing') return t('insights.noTranscript');
  if (report.status === 'parse_error') return t('insights.parseError');
  return report.status;
}

export function sessionTitle(s: Record<string, any>): string {
  const stripped = String(s.title ?? '').replace(/^(?:@\S+\s*)+/, '').trim();
  return stripped || String(s.sessionId ?? '');
}

export function severityLabel(sev: InsightSeverity): string {
  return sev === 'bad' ? t('insights.sevBad') : sev === 'warn' ? t('insights.sevWarn') : t('insights.sevInfo');
}

export function translatedOrFallback(key: string, fallback: string): string {
  const out = t(key);
  return out === key ? fallback : out;
}

export function suggestionTitle(s: Pick<SafeInsightSuggestion, 'id' | 'title'> | Pick<SafeInsightOverviewSuggestion, 'id' | 'title'>): string {
  return translatedOrFallback(`insights.suggestion.${s.id}.title`, s.title);
}

export function suggestionAction(s: Pick<SafeInsightSuggestion, 'id' | 'action'> | Pick<SafeInsightOverviewSuggestion, 'id' | 'action'>): string {
  return translatedOrFallback(`insights.suggestion.${s.id}.action`, s.action);
}

export function localizeEvidence(text: string): string {
  let m = text.match(/^(\d+) failed spans$/);
  if (m) return t('insights.evidence.failedSpans', { count: m[1] });
  m = text.match(/^(.+) failed (\d+) times$/);
  if (m) return t('insights.evidence.toolFailedTimes', { tool: m[1], count: m[2] });
  if (text === 'multiple tools failed') return t('insights.evidence.multipleToolsFailed');
  m = text.match(/^(.+) ran for (\d+)s$/);
  if (m) return t('insights.evidence.toolRanSeconds', { tool: m[1], seconds: m[2] });
  m = text.match(/^read\/write ratio ([\d.]+)$/);
  if (m) return t('insights.evidence.readWriteRatio', { ratio: m[1] });
  m = text.match(/^compactions (\d+)$/);
  if (m) return t('insights.evidence.compactions', { count: m[1] });
  m = text.match(/^(\d+) spans analyzed$/);
  if (m) return t('insights.evidence.spansAnalyzed', { count: m[1] });
  return text;
}

export function localizeReason(reason: string): string {
  return reason
    .split(/\s*[;；]\s*/)
    .map(c => c.trim().replace(/[.。]\s*$/, ''))
    .filter(Boolean)
    .map(localizeEvidence)
    .join('；');
}

export function phaseLabel(phase: string): string {
  const key = `insights.phase.${phase}`;
  const out = t(key);
  return out === key ? phase : out;
}

export function phaseSlug(phase: string): string {
  return String(phase || 'unknown').replace(/[^a-z0-9_-]/gi, '-');
}

export function phaseClass(phase: string): string {
  return `phase-${phaseSlug(phase)}`;
}

export function reportNeedsReview(report: SafeInsightReport | null): boolean {
  if (!report || report.status !== 'ok') return false;
  return report.agg.failedSpans > 0 || report.agg.slowSpans > 0 || report.suggestions.some(x => x.severity !== 'info');
}

export function toRecord(s: SafeInsightOverviewSession): InsightRecord {
  return {
    session: {
      sessionId: s.sessionId,
      cliId: s.cliId,
      cliSessionId: s.cliSessionId,
      title: s.title,
      botName: s.botName,
      larkAppId: s.larkAppId,
      workingDir: s.workingDir,
      status: s.status,
      lastMessageAt: s.lastMessageAt,
    },
    report: s.report,
  };
}

export function cliIdOf(rec: InsightRecord): string {
  return String(rec.session.cliId ?? 'unknown');
}

const CLI_FILTER_ORDER = ['claude-code', 'seed', 'relay', 'aiden', 'codex', 'traex', 'antigravity'];
export function cliCounts(records: InsightRecord[]): Array<{ id: string; count: number }> {
  const m = new Map<string, number>();
  for (const rec of records) {
    const id = cliIdOf(rec);
    m.set(id, (m.get(id) ?? 0) + 1);
  }
  return [...m.entries()].map(([id, count]) => ({ id, count })).sort((a, b) => {
    const ai = CLI_FILTER_ORDER.indexOf(a.id);
    const bi = CLI_FILTER_ORDER.indexOf(b.id);
    return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi) || a.id.localeCompare(b.id);
  });
}

export function projectOf(rec: InsightRecord): string {
  const wd = String(rec.session.workingDir ?? '').replace(/\/+$/, '');
  if (!wd) return '';
  return wd.split('/').pop() || wd;
}

export function projectOptions(records: InsightRecord[]): Array<{ id: string; count: number }> {
  const m = new Map<string, number>();
  for (const rec of records) {
    const p = projectOf(rec);
    if (p) m.set(p, (m.get(p) ?? 0) + 1);
  }
  return [...m.entries()].map(([id, count]) => ({ id, count })).sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));
}

export function filterRecords(records: InsightRecord[], filter: InsightFilter, q: string, cliSel: Set<string> = new Set(), scope: ScopeOpts = {}): InsightRecord[] {
  const query = q.trim().toLowerCase();
  return records.filter(rec => {
    const s = rec.session;
    const r = rec.report;
    if (scope.analyzableOnly && r?.status !== 'ok') return false;
    if (scope.project && projectOf(rec) !== scope.project) return false;
    if (scope.sinceMs && Number(s.lastMessageAt ?? s.spawnedAt ?? 0) < scope.sinceMs) return false;
    if (cliSel.size && !cliSel.has(cliIdOf(rec))) return false;
    if (filter === 'review' && !reportNeedsReview(r)) return false;
    if (filter === 'failed' && !(r?.status === 'ok' && r.agg.failedSpans > 0)) return false;
    if (filter === 'slow' && !(r?.status === 'ok' && r.agg.slowSpans > 0)) return false;
    if (!query) return true;
    return `${sessionTitle(s)} ${botDisplayName(s)} ${s.cliId ?? ''} ${s.workingDir ?? ''} ${s.sessionId ?? ''}`.toLowerCase().includes(query);
  });
}

export function aggregateRecords(records: InsightRecord[]): DerivedOverview {
  const agg: SafeInsightAggregate = {
    totalSpans: 0,
    failedSpans: 0,
    slowSpans: 0,
    failByTool: {},
    phase: {
      research: { count: 0, ms: 0 },
      edit: { count: 0, ms: 0 },
      run: { count: 0, ms: 0 },
      delegate: { count: 0, ms: 0 },
      discuss: { count: 0, ms: 0 },
    },
    readWriteRatio: null,
    compactions: 0,
    subagentCostShare: null,
  };
  let analyzed = 0;
  const suggMap = new Map<string, SafeInsightOverviewSuggestion>();
  for (const rec of records) {
    const r = rec.report;
    if (!r || r.status !== 'ok') continue;
    analyzed += 1;
    const a = r.agg;
    agg.totalSpans += a.totalSpans;
    agg.failedSpans += a.failedSpans;
    agg.slowSpans += a.slowSpans;
    agg.compactions += a.compactions;
    for (const [tool, n] of Object.entries(a.failByTool ?? {})) {
      agg.failByTool[tool] = (agg.failByTool[tool] ?? 0) + n;
    }
    for (const ph of INSIGHT_PHASES) {
      const pv = a.phase?.[ph];
      if (pv) {
        agg.phase[ph].count += pv.count;
        agg.phase[ph].ms += pv.ms;
      }
    }
    for (const s of r.suggestions ?? []) {
      const e = suggMap.get(s.id);
      if (e) e.count += 1;
      else suggMap.set(s.id, { id: s.id, title: s.title, severity: s.severity, count: 1, evidence: s.evidence ?? [], action: s.action });
    }
  }
  agg.readWriteRatio = agg.phase.edit.count > 0
    ? Number((agg.phase.research.count / agg.phase.edit.count).toFixed(2))
    : null;
  const topFailedTools = Object.entries(agg.failByTool)
    .map(([tool, count]) => ({ tool, count }))
    .sort((x, y) => y.count - x.count)
    .slice(0, 5);
  return { totalCount: records.length, analyzedCount: analyzed, agg, topFailedTools, suggestions: [...suggMap.values()] };
}

export function agentMsOf(r: SafeInsightReport): number {
  return INSIGHT_PHASES.reduce((sum, ph) => sum + (r.agg.phase?.[ph]?.ms ?? 0), 0);
}

export function okReports(records: InsightRecord[]): SafeInsightReport[] {
  return records.map(r => r.report).filter((r): r is SafeInsightReport => !!r && r.status === 'ok');
}

export function median(values: number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

export function reviewScore(r: SafeInsightReport | null): number {
  return r?.status === 'ok' ? r.agg.failedSpans * 6 + r.agg.slowSpans * 3 + r.suggestions.filter(s => s.severity === 'bad').length * 5 : 0;
}

export function sortRecordsBy(records: InsightRecord[], key: SessSort): InsightRecord[] {
  const recency = (rec: InsightRecord) => Number(rec.session.lastMessageAt ?? 0);
  const val = (rec: InsightRecord): number => {
    const r = rec.report;
    const a = r?.status === 'ok' ? r.agg : null;
    switch (key) {
      case 'spans': return a?.totalSpans ?? -1;
      case 'fails': return a?.failedSpans ?? -1;
      case 'slow': return a?.slowSpans ?? -1;
      case 'agent': return r?.status === 'ok' ? agentMsOf(r) : -1;
      case 'review': return reviewScore(r);
      default: return 0;
    }
  };
  return [...records].sort((a, b) => key === 'recent' ? recency(b) - recency(a) : (val(b) - val(a)) || recency(b) - recency(a));
}

export function intentLabel(kind: string): string {
  const k = `insights.intent.${kind}`;
  const o = t(k);
  return o === k ? kind : o;
}

export function resultLabel(category: string): string {
  const k = `insights.result.${category}`;
  const o = t(k);
  return o === k ? category : o;
}

export function tagLabel(tag: string): string {
  const k = `insights.tag.${tag}`;
  const o = t(k);
  return o === k ? tag : o;
}

export function idText(ns: string, h: { id: string; params: Record<string, string | number> }): string {
  const k = `insights.${ns}.${h.id}`;
  const o = t(k, h.params);
  return o === k ? h.id : o;
}

export function turnHeadline(h: { id: string; params: Record<string, string | number> }): string {
  return idText('turnHeadline', h);
}

const STRUCT_KEYS: Record<string, string> = {
  'shell command': 'insights.struct.shell',
  'file edit': 'insights.struct.fileEdit',
  'read/search': 'insights.struct.readSearch',
  'agent task': 'insights.struct.agentTask',
  'tool input': 'insights.struct.toolInput',
  'tool result': 'insights.struct.toolResult',
  'tool error': 'insights.struct.toolError',
  'patch failed': 'insights.struct.patchFailed',
  'patch applied': 'insights.struct.patchApplied',
};

export function structLabel(v?: string): string {
  if (!v) return '';
  const m = v.match(/^exit (-?\d+)$/);
  if (m) return t('insights.struct.exit', { code: m[1] });
  return STRUCT_KEYS[v] ? translatedOrFallback(STRUCT_KEYS[v]!, v) : v;
}

export function spanFailed(s: { status: string; result?: { category: string } }): boolean {
  return s.status === 'error' || (!!s.result && BAD_RESULTS.has(s.result.category));
}

export function intentTextOf(intent: SafeSpanIntent | undefined, fallback: string): string {
  return intent && intent.kind !== 'unknown' ? intentLabel(intent.kind) : fallback;
}

export function intentText(s: { tool: string; intent?: SafeSpanIntent }): string {
  return intentTextOf(s.intent, s.tool);
}

export function intentPhrase(intent?: SafeSpanIntent): string {
  if (!intent) return '';
  return [intent.kind !== 'unknown' ? intentLabel(intent.kind) : '', intent.subject, intent.detail].filter(Boolean).join(' · ');
}

const ADVICE_TAGS: SafeSpanTag[] = ['failure', 'retry', 'read_write_imbalance', 'slow'];
export function turnAdvice(tags: SafeSpanTag[]): string {
  for (const tag of ADVICE_TAGS) {
    if (tags.includes(tag)) {
      const o = t(`insights.advice.${tag}`);
      if (o !== `insights.advice.${tag}`) return o;
    }
  }
  return '';
}

export function focusSets(report: SafeInsightReport, activeId: string | null): { rec: DiagnosticRecommendation | null; spanIdx: Set<number>; turnIdx: Set<number> } {
  const spans = report.spans ?? [];
  const rec = activeId ? (report.recommendations ?? []).find(r => r.id === activeId) ?? null : null;
  if (!rec) return { rec: null, spanIdx: new Set(), turnIdx: new Set() };
  const span = (rec.evidence?.spanIndexes ?? []).filter(i => Number.isInteger(i) && i >= 0 && i < spans.length);
  return { rec, spanIdx: new Set(span), turnIdx: new Set(rec.evidence?.turnIndexes ?? []) };
}

export function cleanPromptText(raw: string): string {
  let s = raw
    .replace(/<(mentions|attachments|available_bots|system-reminder|quoted_messages|sender)\b[\s\S]*?<\/\1>/g, ' ')
    .replace(/<botmux_reminder>[\s\S]*?<\/botmux_reminder>/g, ' ')
    .replace(/<\/?(user_message|local-command-[a-z]+)>/g, ' ')
    .replace(/<sender\b[^>]*\/?>/g, ' ')
    .replace(/<mention\b[^>]*\/?>/g, ' ')
    .replace(/\[用户引用了消息[\s\S]*?\]/g, ' ')
    .replace(/\[来自[^\]]*@mention\]/g, ' ')
    .replace(/\[(图片|文件)\s*\d+[^\]\n]*\][^\n]*/g, ' ');
  return s
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const promptMd = new MarkdownIt({ html: false, linkify: true, breaks: true });
promptMd.validateLink = (url: string) => /^(https?:|mailto:)/i.test(url.trim());
const linkOpen = promptMd.renderer.rules.link_open;
promptMd.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  tokens[idx]!.attrSet('target', '_blank');
  tokens[idx]!.attrSet('rel', 'noopener noreferrer nofollow');
  return linkOpen ? linkOpen(tokens, idx, options, env, self) : self.renderToken(tokens, idx, options);
};

export function promptMarkdownHtml(text: string): string {
  try {
    const html = promptMd.render(text).trim();
    return html || `<p>${escapeHtml(text)}</p>`;
  } catch {
    return `<p>${escapeHtml(text)}</p>`;
  }
}

export function turnSenderKind(tn: TurnTimelineTurn): Exclude<LedgerSender, 'all'> {
  return tn.prompt?.source?.kind ?? 'user';
}

export function groupConvo(messages: InsightConversationMessage[]): ConvoUnit[] {
  const units: ConvoUnit[] = [];
  for (const m of messages) {
    if (m.role === 'agent') {
      const last = units[units.length - 1];
      if (last && last.kind === 'ops' && last.turnIndex === m.turnIndex) last.msgs.push(m);
      else units.push({ kind: 'ops', turnIndex: m.turnIndex, msgs: [m] });
    } else {
      units.push({ kind: 'prompt', msg: m });
    }
  }
  return units;
}

export function turnMainPhase(tn: TurnTimelineTurn): string {
  const w = new Map<string, number>();
  for (const e of tn.events ?? []) {
    if (!e.phase) continue;
    w.set(e.phase, (w.get(e.phase) ?? 0) + (e.durationMs ?? 0) + 1);
  }
  let best = 'discuss';
  let max = -1;
  for (const [p, d] of w) {
    if (d > max) {
      max = d;
      best = p;
    }
  }
  return best;
}

export function buildInsightScope(timeWin: string, project: string, showNoise: boolean): ScopeOpts {
  const w = TIME_WINDOWS.find(x => x.key === timeWin);
  const sinceMs = w && w.days > 0 ? Date.now() - w.days * 86400000 : undefined;
  return { project: project || undefined, sinceMs, analyzableOnly: !showNoise };
}

export function parseInsightsHash(): Record<string, string> {
  const h = typeof location !== 'undefined' ? (location.hash || '') : '';
  const qi = h.indexOf('?');
  if (qi < 0) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(h.slice(qi + 1))) out[k] = v;
  return out;
}

export function buildInsightsHash(p: Record<string, string>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(p)) if (v) sp.set(k, v);
  const q = sp.toString();
  return '#/insights' + (q ? `?${q}` : '');
}

export function initialInsightTab(): InsightTab {
  const hp = parseInsightsHash();
  return INSIGHT_TAB_KEYS.includes(hp.tab as InsightTab) ? hp.tab as InsightTab : 'overview';
}

export async function fetchInsightsSummary(): Promise<SafeInsightOverview> {
  const r = await fetch('/api/insights/summary?limit=200', { cache: 'no-store' });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || d?.ok === false || !d.overview) throw new Error(String(d?.error ?? r.status));
  return d.overview as SafeInsightOverview;
}

export async function fetchInsightDetail(sessionId: string): Promise<SafeInsightReport | null> {
  const r = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/insight?detail=spans`, { cache: 'no-store' });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || d?.ok === false) throw new Error(String(d?.error ?? r.status));
  return d.report as SafeInsightReport;
}

export async function fetchInsightConversation(sessionId: string, opts: { offset: number; limit: number; q?: string; role?: string; tag?: string }): Promise<{
  messages: InsightConversationMessage[];
  total: number;
  hasMore: boolean;
  nextOffset: number;
}> {
  const params = new URLSearchParams({ detail: 'conversation', offset: String(opts.offset), limit: String(opts.limit) });
  if (opts.q) params.set('q', opts.q);
  if (opts.role && opts.role !== 'all') params.set('role', opts.role);
  if (opts.tag && opts.tag !== 'all') params.set('tag', opts.tag);
  const r = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/insight?${params.toString()}`, { cache: 'no-store' });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || d?.ok === false) throw new Error(String(d?.error ?? r.status));
  const c = d?.conversation;
  return {
    messages: c?.messages ?? [],
    total: c?.total ?? 0,
    hasMore: !!c?.hasMore,
    nextOffset: c?.nextOffset ?? opts.offset + (c?.messages?.length ?? 0),
  };
}

export async function fetchTurnPrompt(sessionId: string, turnIndex: number): Promise<TurnPromptPreview> {
  const r = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/insight/turn/${turnIndex}?offset=0&limit=40000`, { cache: 'no-store' });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || d?.ok === false) throw new Error(String(d?.error ?? r.status));
  return (d?.turn?.prompt as TurnPromptPreview) ?? { text: '', truncated: false };
}

export function sessionMetaLine(rec: InsightRecord): string {
  const s = rec.session;
  return `${botDisplayName(s)} · ${String(s.cliId ?? '-')}${s.workingDir ? ` · ${projectOf(rec)}` : ''} · ${relTime(s.lastMessageAt ?? s.spawnedAt ?? 0)}`;
}
