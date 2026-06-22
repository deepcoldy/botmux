// Owner-only Insight workbench: ONE aggregate pass over botmux registry sessions
// (GET /api/insights/summary) drives the overview + session list; per-session
// span detail is fetched on demand (GET /api/sessions/:id/insight?detail=spans).
// All free text is escapeHtml'd; the API only ever returns fail-closed redacted
// summaries/spans — raw transcript content never reaches here.
import type {
  DiagnosticRecommendation,
  InsightPhase,
  InsightSeverity,
  SafeInsightAggregate,
  SafeInsightOverview,
  SafeInsightOverviewSuggestion,
  SafeInsightOverviewSession,
  SafeInsightReport,
  SafeInsightSuggestion,
  SafeSpan,
  SafeSpanIntent,
  SafeSpanTag,
  TurnTimelineEvent,
  TurnTimelineTurn,
  TurnPromptPreview,
  InsightConversationMessage,
} from '../../services/insight/types.js';
import { botDisplayName, escapeHtml, loadNameMaps, relTime, stripMentionPrefix, t } from './ui.js';
import MarkdownIt from 'markdown-it';

type InsightFilter = 'all' | 'review' | 'failed' | 'slow';

type InsightRecord = {
  session: Record<string, any>;
  report: SafeInsightReport | null;
  error?: string;
};

const SEVERITY_RANK: Record<InsightSeverity, number> = { bad: 0, warn: 1, info: 2 };

function fmtInt(n: number): string {
  return Number.isFinite(n) ? Math.round(n).toLocaleString('en-US') : '-';
}

function fmtMs(ms?: number): string {
  if (ms === undefined || ms === null || !Number.isFinite(ms)) return '-';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 60_000)}m`;
}

function statusIcon(status?: string): string {
  if (status === 'error') return '!';
  if (status === 'running') return '~';
  return 'OK';
}

function safeStatus(report: SafeInsightReport | null, error?: string): string {
  if (error) return error;
  if (!report) return '-';
  if (report.status === 'unsupported_cli') return t('insights.unsupported');
  if (report.status === 'transcript_missing') return t('insights.noTranscript');
  if (report.status === 'parse_error') return t('insights.parseError');
  return report.status;
}

function sessionTitle(s: Record<string, any>): string {
  return stripMentionPrefix(s.title ?? s.firstUserMessage ?? s.rootMessageId ?? s.sessionId);
}

function severityLabel(sev: InsightSeverity): string {
  return sev === 'bad' ? t('insights.sevBad') : sev === 'warn' ? t('insights.sevWarn') : t('insights.sevInfo');
}

function translatedOrFallback(key: string, fallback: string): string {
  const out = t(key);
  return out === key ? fallback : out;
}

function suggestionTitle(s: Pick<SafeInsightSuggestion, 'id' | 'title'> | Pick<SafeInsightOverviewSuggestion, 'id' | 'title'>): string {
  return translatedOrFallback(`insights.suggestion.${s.id}.title`, s.title);
}

function suggestionAction(s: Pick<SafeInsightSuggestion, 'id' | 'action'> | Pick<SafeInsightOverviewSuggestion, 'id' | 'action'>): string {
  return translatedOrFallback(`insights.suggestion.${s.id}.action`, s.action);
}

function localizeEvidence(text: string): string {
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

// Diagnostic reason is backend free-text (safe-projected: numbers/tools/enums). Reuse the
// evidence localizer on each ';'-separated clause so the zh UI doesn't surface English here;
// unmatched clauses fall through unchanged.
function localizeReason(reason: string): string {
  return reason
    .split(/\s*[;；]\s*/)
    .map(c => c.trim().replace(/[.。]\s*$/, ''))
    .filter(Boolean)
    .map(localizeEvidence)
    .join('；');
}

function phaseLabel(phase: string): string {
  const key = `insights.phase.${phase}`;
  const out = t(key);
  return out === key ? phase : out;
}

function phaseSlug(phase: string): string {
  return String(phase || 'unknown').replace(/[^a-z0-9_-]/gi, '-');
}

function phaseClass(phase: string): string {
  return `phase-${phaseSlug(phase)}`;
}

function reportNeedsReview(report: SafeInsightReport | null): boolean {
  if (!report || report.status !== 'ok') return false;
  return report.agg.failedSpans > 0 || report.agg.slowSpans > 0 || report.suggestions.some(x => x.severity !== 'info');
}

// Project a server overview-session row into the list's record shape so the
// existing filter/sort/render helpers keep working unchanged.
function toRecord(s: SafeInsightOverviewSession): InsightRecord {
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

type ScopeOpts = { project?: string; sinceMs?: number; analyzableOnly?: boolean };
function filterRecords(records: InsightRecord[], filter: InsightFilter, q: string, cliSel: Set<string> = new Set(), scope: ScopeOpts = {}): InsightRecord[] {
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

function cliIdOf(rec: InsightRecord): string {
  return String(rec.session.cliId ?? 'unknown');
}

// Session-dimension CLI facet. Supported CLIs lead in a fixed order so the chip
// row doesn't reshuffle as sessions come and go; unknown CLIs trail alphabetically.
const CLI_FILTER_ORDER = ['claude-code', 'seed', 'relay', 'aiden', 'codex', 'traex', 'antigravity'];
function cliCounts(records: InsightRecord[]): Array<{ id: string; count: number }> {
  const m = new Map<string, number>();
  for (const rec of records) { const id = cliIdOf(rec); m.set(id, (m.get(id) ?? 0) + 1); }
  return [...m.entries()].map(([id, count]) => ({ id, count })).sort((a, b) => {
    const ai = CLI_FILTER_ORDER.indexOf(a.id); const bi = CLI_FILTER_ORDER.indexOf(b.id);
    return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi) || a.id.localeCompare(b.id);
  });
}

// CLI facet chip row for the session list. Multi-select: an empty selection means
// "all". Counts reflect the severity+search filtered set (the CLI picks are NOT
// applied), so the per-CLI distribution stays visible while you drill in. Hidden
// when only one CLI is present.
function renderCliChips(records: InsightRecord[], active: Set<string>): string {
  const counts = cliCounts(records);
  if (counts.length <= 1) return '';
  const chip = (key: string, label: string, n: number, on: boolean) =>
    `<button type="button" class="spanchip${on ? ' on' : ''}" data-clifilter="${escapeHtml(key)}">${escapeHtml(label)} <b>${n}</b></button>`;
  return [chip('all', t('common.all'), records.length, active.size === 0),
    ...counts.map(c => chip(c.id, c.id, c.count, active.has(c.id)))].join('');
}

function renderMetric(label: string, value: string, sub = ''): string {
  return `<div class="card"><div class="cv">${escapeHtml(value)}</div><div class="cl">${escapeHtml(label)}</div>${sub ? `<div class="cs">${escapeHtml(sub)}</div>` : ''}</div>`;
}

const INSIGHT_PHASES: InsightPhase[] = ['research', 'edit', 'run', 'delegate', 'discuss'];

type DerivedOverview = {
  totalCount: number;
  analyzedCount: number;
  agg: SafeInsightAggregate;
  topFailedTools: Array<{ tool: string; count: number }>;
  suggestions: SafeInsightOverviewSuggestion[];
};

// The overview reflects the CURRENT filter/search: aggregate the visible records
// client-side so the metric cards, top-failed-tools and recommendations all move
// when you filter. Otherwise only the session list narrows while the prominent
// numbers stay frozen, and filtering feels dead (the issue 老滕 hit). Non-ok
// reports contribute nothing, so the unfiltered view ≈ the server aggregate.
function aggregateRecords(records: InsightRecord[]): DerivedOverview {
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
  let rwSum = 0;
  let rwN = 0;
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
    if (a.readWriteRatio !== null && Number.isFinite(a.readWriteRatio)) {
      rwSum += a.readWriteRatio;
      rwN += 1;
    }
    for (const s of r.suggestions ?? []) {
      const e = suggMap.get(s.id);
      if (e) e.count += 1;
      else suggMap.set(s.id, { id: s.id, title: s.title, severity: s.severity, count: 1, evidence: s.evidence ?? [], action: s.action });
    }
  }
  agg.readWriteRatio = rwN ? Number((rwSum / rwN).toFixed(2)) : null;
  const topFailedTools = Object.entries(agg.failByTool)
    .map(([tool, count]) => ({ tool, count }))
    .sort((x, y) => y.count - x.count)
    .slice(0, 5);
  return { totalCount: records.length, analyzedCount: analyzed, agg, topFailedTools, suggestions: [...suggMap.values()] };
}

// Overview metrics + recommendations for the CURRENTLY VISIBLE (filtered) records,
// so the summary tracks the active filter rather than staying global.
function renderOverview(d: DerivedOverview): string {
  const a = d.agg;
  const rw = a.readWriteRatio === null ? '-' : a.readWriteRatio.toFixed(1);
  const topTools = d.topFailedTools.slice(0, 5);
  const topSuggestions = [...d.suggestions]
    .sort((x, y) => SEVERITY_RANK[x.severity] - SEVERITY_RANK[y.severity] || y.count - x.count)
    .slice(0, 6);
  return `
    <div class="cards insights-metrics">
      ${renderMetric(t('insights.metricSessions'), fmtInt(d.totalCount), t('insights.metricAnalyzed', { count: d.analyzedCount }))}
      ${renderMetric(t('insights.metricSpans'), fmtInt(a.totalSpans), t('insights.metricSafe'))}
      ${renderMetric(t('insights.metricFailed'), fmtInt(a.failedSpans), topTools[0] ? `${topTools[0].tool} ×${topTools[0].count}` : '')}
      ${renderMetric(t('insights.metricSlow'), fmtInt(a.slowSpans))}
      ${renderMetric(t('insights.metricRw'), rw, t('insights.metricCompactions', { count: a.compactions }))}
    </div>
    <div class="insights-overview-grid">
      <section class="block recblock">
        <h3>${escapeHtml(t('insights.recommendations'))}</h3>
        <div class="reclist">
          ${topSuggestions.length ? topSuggestions.map(item => `
            <div class="rec ${item.severity}">
              <div class="rectop"><b>${escapeHtml(suggestionTitle(item))}</b><span>${escapeHtml(severityLabel(item.severity))}</span></div>
              <div class="recev">${escapeHtml(t('insights.seenInSessions', { count: item.count }))}</div>
            </div>`).join('') : `<p class="mut">${escapeHtml(t('insights.noRecommendations'))}</p>`}
        </div>
      </section>
      <section class="block">
        <h3>${escapeHtml(t('insights.toolFailures'))}</h3>
        <div class="hbars">
          ${topTools.length ? topTools.map(tt => {
            const pct = Math.max(4, Math.round((tt.count / Math.max(1, topTools[0]!.count)) * 100));
            return `<div class="hbrow"><div class="hblabel">${escapeHtml(tt.tool)}</div><div class="hbtrack"><div class="hbfill" style="width:${pct}%"></div></div><div class="hbval">${fmtInt(tt.count)}</div></div>`;
          }).join('') : `<p class="mut">${escapeHtml(t('insights.noFailures'))}</p>`}
        </div>
      </section>
    </div>`;
}

function renderPhaseMix(report: SafeInsightReport): string {
  const entries = Object.entries(report.agg.phase ?? {}).filter(([, v]) => v.count > 0 || v.ms > 0);
  if (!entries.length) return '';
  return `<div class="mph">${entries.map(([phase, v]) => {
    const weight = Math.max(1, v.ms || v.count);
    return `<i class="${phaseClass(phase)}" style="flex:${weight}" title="${escapeHtml(`${phaseLabel(phase)} · ${v.count} · ${fmtMs(v.ms)}`)}"></i>`;
  }).join('')}</div>`;
}

// ── Top-level tabs + global filter dimensions (project / time) ──────────────
type InsightTab = 'overview' | 'sessions' | 'dist' | 'hot';
const INSIGHT_TABS: Array<{ key: InsightTab; label: string }> = [
  { key: 'overview', label: 'insights.tabOverview' },
  { key: 'sessions', label: 'insights.tabSessions' },
  { key: 'dist', label: 'insights.tabDist' },
  { key: 'hot', label: 'insights.tabHot' },
];
function renderTabBar(active: InsightTab): string {
  return `<div class="insight-tabs" role="tablist">${INSIGHT_TABS.map(tb =>
    `<button type="button" class="itab${tb.key === active ? ' on' : ''}" data-itab="${tb.key}" role="tab" aria-selected="${tb.key === active}">${escapeHtml(t(tb.label))}</button>`,
  ).join('')}</div>`;
}

function projectOf(rec: InsightRecord): string {
  const wd = String(rec.session.workingDir ?? '').replace(/\/+$/, '');
  if (!wd) return '';
  return wd.split('/').pop() || wd;
}
function projectOptions(records: InsightRecord[]): Array<{ id: string; count: number }> {
  const m = new Map<string, number>();
  for (const rec of records) { const p = projectOf(rec); if (p) m.set(p, (m.get(p) ?? 0) + 1); }
  return [...m.entries()].map(([id, count]) => ({ id, count })).sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));
}
const TIME_WINDOWS: Array<{ key: string; label: string; days: number }> = [
  { key: 'all', label: 'insights.timeAll', days: 0 },
  { key: '1d', label: 'insights.time1d', days: 1 },
  { key: '7d', label: 'insights.time7d', days: 7 },
  { key: '30d', label: 'insights.time30d', days: 30 },
];

function agentMsOf(r: SafeInsightReport): number {
  return INSIGHT_PHASES.reduce((sum, ph) => sum + (r.agg.phase?.[ph]?.ms ?? 0), 0);
}
function okReports(records: InsightRecord[]): SafeInsightReport[] {
  return records.map(r => r.report).filter((r): r is SafeInsightReport => !!r && r.status === 'ok');
}
function median(values: number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

// One histogram card. bins is an ordered list of {label, test}; each session value
// falls into the first matching bin. Reuses the .hbars bar styling.
function renderHistogram(title: string, values: number[], bins: Array<{ label: string; test: (v: number) => boolean }>, fmtMedian: (n: number) => string = fmtInt): string {
  const counts = bins.map(b => ({ label: b.label, count: values.filter(b.test).length }));
  const max = Math.max(1, ...counts.map(c => c.count));
  const total = Math.max(1, values.length);
  const rows = counts.map(c => {
    const pct = Math.max(c.count ? 4 : 0, Math.round((c.count / max) * 100));
    const share = Math.round((c.count / total) * 100);
    return `<div class="hbrow"><div class="hblabel">${escapeHtml(c.label)}</div><div class="hbtrack"><div class="hbfill" style="width:${pct}%"></div></div><div class="hbval">${fmtInt(c.count)}<small>${share}%</small></div></div>`;
  }).join('');
  return `<section class="block ihist">
    <div class="ihist-head"><h3>${escapeHtml(title)}</h3><span class="mut">${escapeHtml(t('insights.distMedian', { v: fmtMedian(median(values)) }))}</span></div>
    <div class="hbars">${rows}</div>
  </section>`;
}

function renderDistribution(records: InsightRecord[]): string {
  const reports = okReports(records);
  if (!reports.length) return `<div class="insight-empty">${escapeHtml(t('insights.distEmpty'))}</div>`;
  const spans = reports.map(r => r.agg.totalSpans);
  const failed = reports.map(r => r.agg.failedSpans);
  const slow = reports.map(r => r.agg.slowSpans);
  const agentMin = reports.map(r => agentMsOf(r) / 60000);
  const rw = reports.map(r => r.agg.readWriteRatio).filter((v): v is number => v !== null && Number.isFinite(v));
  return `<p class="mut ins-hint">${escapeHtml(t('insights.distHint'))}</p>
  <div class="ihist-grid">
    ${renderHistogram(t('insights.distSpans'), spans, [
      { label: '0–10', test: v => v <= 10 },
      { label: '11–50', test: v => v > 10 && v <= 50 },
      { label: '51–200', test: v => v > 50 && v <= 200 },
      { label: '201–500', test: v => v > 200 && v <= 500 },
      { label: '500+', test: v => v > 500 },
    ])}
    ${renderHistogram(t('insights.distFailed'), failed, [
      { label: '0', test: v => v === 0 },
      { label: '1–2', test: v => v >= 1 && v <= 2 },
      { label: '3–5', test: v => v >= 3 && v <= 5 },
      { label: '6–10', test: v => v >= 6 && v <= 10 },
      { label: '10+', test: v => v > 10 },
    ])}
    ${renderHistogram(t('insights.distSlow'), slow, [
      { label: '0', test: v => v === 0 },
      { label: '1–2', test: v => v >= 1 && v <= 2 },
      { label: '3–5', test: v => v >= 3 && v <= 5 },
      { label: '5+', test: v => v > 5 },
    ])}
    ${renderHistogram(t('insights.distAgentTime'), agentMin, [
      { label: '<1m', test: v => v < 1 },
      { label: '1–5m', test: v => v >= 1 && v < 5 },
      { label: '5–30m', test: v => v >= 5 && v < 30 },
      { label: '30m–2h', test: v => v >= 30 && v < 120 },
      { label: '2h+', test: v => v >= 120 },
    ], n => `${Math.round(n)}m`)}
    ${rw.length ? renderHistogram(t('insights.distRw'), rw, [
      { label: '0', test: v => v === 0 },
      { label: '0–1', test: v => v > 0 && v < 1 },
      { label: '1–3', test: v => v >= 1 && v < 3 },
      { label: '3+', test: v => v >= 3 },
    ], n => n.toFixed(1)) : ''}
  </div>`;
}

function renderHotspots(records: InsightRecord[]): string {
  const reports = okReports(records);
  if (!reports.length) return `<div class="insight-empty">${escapeHtml(t('insights.distEmpty'))}</div>`;
  // Tool failure hotspots: total fails + how many sessions hit each tool.
  const toolFails = new Map<string, { fails: number; sessions: number }>();
  for (const r of reports) {
    for (const [tool, n] of Object.entries(r.agg.failByTool ?? {})) {
      const e = toolFails.get(tool) ?? { fails: 0, sessions: 0 };
      e.fails += n; e.sessions += 1; toolFails.set(tool, e);
    }
  }
  const tools = [...toolFails.entries()].map(([tool, v]) => ({ tool, ...v })).sort((a, b) => b.fails - a.fails).slice(0, 10);
  const toolMax = Math.max(1, ...tools.map(x => x.fails));
  // Slowest sessions.
  const slowSessions = [...records].filter(r => r.report?.status === 'ok' && r.report.agg.slowSpans > 0)
    .sort((a, b) => (b.report!.agg.slowSpans) - (a.report!.agg.slowSpans)).slice(0, 8);
  // Projects by session + fails.
  const projMap = new Map<string, { sessions: number; fails: number }>();
  for (const rec of records) {
    if (rec.report?.status !== 'ok') continue;
    const p = projectOf(rec); if (!p) continue;
    const e = projMap.get(p) ?? { sessions: 0, fails: 0 };
    e.sessions += 1; e.fails += rec.report.agg.failedSpans; projMap.set(p, e);
  }
  const projects = [...projMap.entries()].map(([id, v]) => ({ id, ...v })).sort((a, b) => b.fails - a.fails || b.sessions - a.sessions).slice(0, 10);
  const projMax = Math.max(1, ...projects.map(x => x.sessions));
  return `<p class="mut ins-hint">${escapeHtml(t('insights.hotHint'))}</p>
  <div class="hot-grid">
    <section class="block">
      <h3>${escapeHtml(t('insights.hotToolFailures'))}</h3>
      <div class="hbars">${tools.length ? tools.map(x => {
        const pct = Math.max(4, Math.round((x.fails / toolMax) * 100));
        return `<div class="hbrow"><div class="hblabel">${escapeHtml(x.tool)}</div><div class="hbtrack"><div class="hbfill" style="width:${pct}%"></div></div><div class="hbval">${fmtInt(x.fails)}<small>${x.sessions} ${escapeHtml(t('insights.hotSessionsCol'))}</small></div></div>`;
      }).join('') : `<p class="mut">${escapeHtml(t('insights.noFailures'))}</p>`}</div>
    </section>
    <section class="block">
      <h3>${escapeHtml(t('insights.hotProjects'))}</h3>
      <div class="hbars">${projects.length ? projects.map(x => {
        const pct = Math.max(4, Math.round((x.sessions / projMax) * 100));
        return `<div class="hbrow"><div class="hblabel">${escapeHtml(x.id)}</div><div class="hbtrack"><div class="hbfill" style="width:${pct}%"></div></div><div class="hbval">${fmtInt(x.sessions)}<small>${x.fails} ${escapeHtml(t('insights.hotFailsCol'))}</small></div></div>`;
      }).join('') : `<p class="mut">-</p>`}</div>
    </section>
    <section class="block hot-sessions">
      <h3>${escapeHtml(t('insights.hotSlowSessions'))}</h3>
      <div class="slist">${slowSessions.length ? slowSessions.map(rec => {
        const a = rec.report!.agg;
        return `<button type="button" class="srow" data-session-id="${escapeHtml(rec.session.sessionId)}">
          <div class="srmain"><strong>${escapeHtml(sessionTitle(rec.session))}</strong>
          <small>${escapeHtml(botDisplayName(rec.session))} · ${escapeHtml(String(rec.session.cliId ?? '-'))}</small></div>
          <div class="srstats"><b>${escapeHtml(t('insights.hotSlowCol'))}<em>${fmtInt(a.slowSpans)}</em></b><b>span<em>${fmtInt(a.totalSpans)}</em></b></div>
        </button>`;
      }).join('') : `<p class="mut">-</p>`}</div>
    </section>
    <p class="hot-note mut">${escapeHtml(t('insights.hotComingSoon'))}</p>
  </div>`;
}

// ── Sessions tab: sort controls + full-width rich rows (mirrors ASI 会话) ────
type SessSort = 'recent' | 'review' | 'spans' | 'fails' | 'slow' | 'agent';
const SESS_SORTS: Array<{ key: SessSort; label: string }> = [
  { key: 'recent', label: 'insights.sortRecent' },
  { key: 'review', label: 'insights.sortReview' },
  { key: 'spans', label: 'insights.sortSpans' },
  { key: 'fails', label: 'insights.sortFails' },
  { key: 'slow', label: 'insights.sortSlow' },
  { key: 'agent', label: 'insights.sortAgent' },
];
function renderSortBar(active: SessSort): string {
  return `<span class="sesssort-label mut">${escapeHtml(t('insights.sortLabel'))}</span>` + SESS_SORTS.map(s =>
    `<button type="button" class="spanchip${s.key === active ? ' on' : ''}" data-sesssort="${s.key}">${escapeHtml(t(s.label))}</button>`).join('');
}
function reviewScore(r: SafeInsightReport | null): number {
  return r?.status === 'ok' ? r.agg.failedSpans * 6 + r.agg.slowSpans * 3 + r.suggestions.filter(s => s.severity === 'bad').length * 5 : 0;
}
function sortRecordsBy(records: InsightRecord[], key: SessSort): InsightRecord[] {
  const recency = (rec: InsightRecord) => Number(rec.session.lastMessageAt ?? 0);
  const val = (rec: InsightRecord): number => {
    const r = rec.report; const a = r?.status === 'ok' ? r.agg : null;
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

function renderSessionRows(records: InsightRecord[], selectedId: string | null, wide = false): string {
  if (!records.length) return `<div class="insight-empty">${escapeHtml(t('insights.empty'))}</div>`;
  const stat = (label: string, val: string, bad = false) =>
    `<b${bad ? ' class="bad"' : ''}>${escapeHtml(label)}<em>${escapeHtml(val)}</em></b>`;
  return `<div class="slist${wide ? ' wide' : ''}">${records.map(rec => {
    const s = rec.session;
    const r = rec.report;
    const ok = r?.status === 'ok';
    const agg = r?.agg;
    const on = s.sessionId === selectedId ? ' on' : '';
    const review = reportNeedsReview(r) ? ' review' : '';
    const reads = agg?.phase?.research?.count ?? 0;
    const edits = agg?.phase?.edit?.count ?? 0;
    return `<button type="button" class="srow${on}${review}" data-session-id="${escapeHtml(s.sessionId)}">
      <div class="srmain">
        <strong>${escapeHtml(sessionTitle(s))}</strong>
        <small>${escapeHtml(botDisplayName(s))} · ${escapeHtml(String(s.cliId ?? '-'))}${s.workingDir ? ` · ${escapeHtml(projectOf(rec))}` : ''} · ${escapeHtml(relTime(s.lastMessageAt ?? s.spawnedAt ?? 0))}</small>
        ${ok ? renderPhaseMix(r!) : ''}
      </div>
      ${ok ? `<div class="srstats">
        ${stat(t('insights.spansShort'), fmtInt(agg!.totalSpans))}
        ${stat(t('insights.failedShort'), fmtInt(agg!.failedSpans), agg!.failedSpans > 0)}
        ${stat(t('insights.slowShort'), fmtInt(agg!.slowSpans))}
        ${wide ? stat(t('insights.readsShort'), fmtInt(reads)) + stat(t('insights.editsShort'), fmtInt(edits)) + stat(t('insights.durShort'), fmtMs(agentMsOf(r!))) : ''}
        ${stat(t('insights.rwShort'), agg!.readWriteRatio !== null ? agg!.readWriteRatio.toFixed(1) : '-')}
      </div>` : `<div class="srmsg">${escapeHtml(safeStatus(r, rec.error))}</div>`}
    </button>`;
  }).join('')}</div>`;
}

// ── Diagnosis-driven detail view ────────────────────────────────────────────
// codex's detail=spans report carries everything rendered here as fail-closed safe
// projections (enums / tool names / numbers / basenames — never raw text):
//   • report.recommendations[] — actionable「影响·原因·下一步」, each with evidence
//     {spanIndexes,turnIndexes}; clicking one .hot-lights that evidence.
//   • report.spans[].detail — the per-row 详情 drawer (safe fields + adjacent intent).
//   • report.turnTimeline[] — ALL visible turns as an ordered event stream
//     (read→edit→run→result) + optional owner-only prompt, so 逐轮 reads as a timeline.

// Localised labels for codex's safe enums + {id,params} headlines (i18n by key, fallback to key).
function intentLabel(kind: string): string { const k = `insights.intent.${kind}`; const o = t(k); return o === k ? kind : o; }
function resultLabel(category: string): string { const k = `insights.result.${category}`; const o = t(k); return o === k ? category : o; }
function tagLabel(tag: string): string { const k = `insights.tag.${tag}`; const o = t(k); return o === k ? tag : o; }
function idText(ns: string, h: { id: string; params: Record<string, string | number> }): string {
  const k = `insights.${ns}.${h.id}`;
  const o = t(k, h.params);
  return o === k ? h.id : o;
}
const turnHeadline = (h: { id: string; params: Record<string, string | number> }): string => idText('turnHeadline', h);

// inputSummary/outputSummary cross only as a fixed allow-list of structural labels (redact.ts);
// localize the known ones, pass anything else through (it is already safe-projected).
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
function structLabel(v?: string): string {
  if (!v) return '';
  const m = v.match(/^exit (-?\d+)$/);
  if (m) return t('insights.struct.exit', { code: m[1] });
  return STRUCT_KEYS[v] ? translatedOrFallback(STRUCT_KEYS[v]!, v) : v;
}

const BAD_RESULTS = new Set<string>(['tool_error', 'test_failed', 'typecheck_failed', 'lint_failed', 'command_failed', 'timeout', 'no_output']);
function spanFailed(s: { status: string; result?: { category: string } }): boolean {
  return s.status === 'error' || (!!s.result && BAD_RESULTS.has(s.result.category));
}
function intentTextOf(intent: SafeSpanIntent | undefined, fallback: string): string {
  return intent && intent.kind !== 'unknown' ? intentLabel(intent.kind) : fallback;
}
function intentText(s: { tool: string; intent?: SafeSpanIntent }): string { return intentTextOf(s.intent, s.tool); }
function intentPhrase(intent?: SafeSpanIntent): string {
  if (!intent) return '';
  return [intent.kind !== 'unknown' ? intentLabel(intent.kind) : '', intent.subject, intent.detail].filter(Boolean).join(' · ');
}

// Turn tag → one-line「怎么优化」(老滕 point 1: the page must say what to DO, not just what happened).
const ADVICE_TAGS: SafeSpanTag[] = ['failure', 'retry', 'read_write_imbalance', 'slow'];
function turnAdvice(tags: SafeSpanTag[]): string {
  for (const tag of ADVICE_TAGS) if (tags.includes(tag)) { const o = t(`insights.advice.${tag}`); if (o !== `insights.advice.${tag}`) return o; }
  return '';
}

// The spans/turns the focused recommendation points at — used to .hot-light evidence.
function focusSets(report: SafeInsightReport, activeId: string | null): { rec: DiagnosticRecommendation | null; spanIdx: Set<number>; turnIdx: Set<number> } {
  const spans = report.spans ?? [];
  const rec = activeId ? (report.recommendations ?? []).find(r => r.id === activeId) ?? null : null;
  if (!rec) return { rec: null, spanIdx: new Set(), turnIdx: new Set() };
  const span = (rec.evidence?.spanIndexes ?? []).filter(i => Number.isInteger(i) && i >= 0 && i < spans.length);
  return { rec, spanIdx: new Set(span), turnIdx: new Set(rec.evidence?.turnIndexes ?? []) };
}

// Top of the detail: codex's actionable recommendations. Each card leads with the fix
// (下一步), backed by 影响 + 原因, and is a button that .hot-lights its evidence spans/turns.
function renderRecommendations(report: SafeInsightReport, activeId: string | null): string {
  const recs = report.recommendations ?? [];
  if (!recs.length) return `<p class="mut">${escapeHtml(t('insights.noRecommendations'))}</p>`;
  const sorted = [...recs].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
  return `<div class="reclist">${sorted.map(r => {
    const active = r.id === activeId;
    const targeted = (r.evidence?.spanIndexes?.length ?? 0) > 0 || (r.evidence?.turnIndexes?.length ?? 0) > 0;
    const impact = idText('impact', r.impact);
    const why = idText('why', r.why);
    const actions = r.nextActions.map(a => `<li>${escapeHtml(idText('action', a))}</li>`).join('');
    const cta = targeted ? `<span class="rec-cta">${escapeHtml(active ? t('insights.diagActive') : t('insights.diagShow'))}</span>` : '';
    return `<button type="button" class="rec ${r.severity}${targeted ? ' rec-clickable' : ''}${active ? ' active' : ''}" data-rec="${escapeHtml(r.id)}">
      <div class="rectop"><b>${escapeHtml(idText('rec', { id: r.id, params: {} }))}</b><span>${escapeHtml(severityLabel(r.severity))}</span></div>
      ${impact ? `<div class="rec-impact">${escapeHtml(impact)}</div>` : ''}
      ${actions ? `<ul class="rec-actions">${actions}</ul>` : ''}
      ${why ? `<div class="rec-why">${escapeHtml(why)}</div>` : ''}
      ${cta}
    </button>`;
  }).join('')}</div>`;
}

function opGlyph(s: SafeSpan, current: boolean): string {
  const title = `${intentText(s)}${s.intent?.subject ? ` ${s.intent.subject}` : ''}${s.result ? ` → ${resultLabel(s.result.category)}` : ''} · ${fmtMs(s.durationMs)}`;
  return `<i class="op ph-${escapeHtml(phaseSlug(s.phase))}${spanFailed(s) ? ' bad' : ''}${current ? ' cur' : ''}" title="${escapeHtml(title)}"></i>`;
}

// One compact evidence row: turn · status · what→result · tags · duration · 详情 toggle.
// Far denser than the old card; the drawer (span.detail) carries the rest on demand.
// The whole header line is the toggle (老滕: 点单个 span 就展开，不用专门点详情按钮); the pill is a
// state indicator only. data-span-idx lives on the line so clicks in the open drawer don't toggle.
function renderSpanRow(spans: SafeSpan[], idx: number, hot: boolean, open: boolean, detailable = true): string {
  const s = spans[idx]!;
  const subject = s.intent?.subject ? `<code class="span-subj">${escapeHtml(s.intent.subject)}</code>` : '';
  const res = s.result;
  const resChip = res && BAD_RESULTS.has(res.category)
    ? `<span class="span-res rc-bad">${escapeHtml(resultLabel(res.category))}${res.exitCode !== undefined ? ` · exit ${res.exitCode}` : ''}</span>`
    : '';
  const tags = (s.tags ?? []).filter(tg => tg !== 'normal' && tg !== 'diagnostic');
  const tagChips = tags.map(tg => `<span class="span-tag tg-${escapeHtml(tg)}">${escapeHtml(tagLabel(tg))}</span>`).join('');
  const detailBtn = detailable
    ? `<span class="span-detail-btn" aria-hidden="true">${escapeHtml(open ? t('insights.dCollapse') : t('insights.dDetail'))}</span>`
    : '';
  const lineAttrs = detailable ? ` data-span-idx="${idx}" role="button" tabindex="0" aria-expanded="${open}"` : '';
  return `<div class="spanrow ph-${escapeHtml(phaseSlug(s.phase))}${s.status === 'error' ? ' error' : ''}${hot ? ' hot' : ''}${open ? ' open' : ''}">
    <div class="sprow-line${detailable ? ' clickable' : ''}"${lineAttrs}>
      <span class="span-turn" title="${escapeHtml(`${t('insights.dStart')} ${fmtMs(s.relStartMs)}`)}">#${escapeHtml(String(s.turnIndex ?? 0))}</span>
      <span class="spanst ${escapeHtml(s.status)}">${escapeHtml(statusIcon(s.status))}</span>
      <b class="span-what">${escapeHtml(intentText(s))}</b>${subject}
      ${resChip}
      <span class="span-tags">${tagChips}</span>
      <span class="span-dur">${escapeHtml(fmtMs(s.durationMs))}</span>
      ${detailBtn}
    </div>
    ${detailable && open ? renderSpanDetail(spans, idx) : ''}
  </div>`;
}

// Owner-only raw command/output (codex's evidence.command/output: secret-scrubbed,
// capped 800/2000 chars, run-class spans only). detail=spans path only — absent ⇒ nothing renders.
function renderTextPreview(label: string, p?: { text: string; truncated: boolean }): string {
  if (!p?.text) return '';
  return `<div class="span-io"><span class="span-io-label">${escapeHtml(label)}</span><pre class="span-io-text">${escapeHtml(p.text)}${p.truncated ? '\n…' : ''}</pre></div>`;
}

// 详情 drawer for one span: codex's span.detail safe fields + raw command/output + the same-turn
// operation strip with this step highlighted ("what surrounded this step"). All safe projections.
function renderSpanDetail(spans: SafeSpan[], idx: number): string {
  const s = spans[idx]!;
  const d = s.detail;
  const ev = d?.evidence ?? s.evidence;
  const io = ev ? `${renderTextPreview(t('insights.dCommand'), ev.command)}${renderTextPreview(t('insights.dCmdOutput'), ev.output)}` : '';
  const kv: Array<[string, string]> = [
    [t('insights.dPhase'), phaseLabel(s.phase)],
    [t('insights.dStart'), fmtMs(s.relStartMs)],
    [t('insights.dDur'), fmtMs(s.durationMs)],
  ];
  const intent = intentPhrase(s.intent);
  if (intent) kv.push([t('insights.dIntent'), intent]);
  if (s.result) kv.push([t('insights.dResult'), `${resultLabel(s.result.category)}${s.result.exitCode !== undefined ? ` · exit ${s.result.exitCode}` : ''}`]);
  if (s.inputSummary) kv.push([t('insights.dIn'), structLabel(s.inputSummary)]);
  if (s.outputSummary) kv.push([t('insights.dOut'), structLabel(s.outputSummary)]);
  const tags = (s.tags ?? []).filter(tg => tg !== 'normal');
  if (tags.length) kv.push([t('insights.dTags'), tags.map(tagLabel).join('、')]);
  const prev = d?.context?.previousIntent ? intentPhrase(d.context.previousIntent) : '';
  const next = d?.context?.nextIntent ? intentPhrase(d.context.nextIntent) : '';
  const flank = (prev || next)
    ? `<div class="span-flank">${prev ? `<span class="sf-prev">↑ ${escapeHtml(prev)}</span>` : ''}${next ? `<span class="sf-next">↓ ${escapeHtml(next)}</span>` : ''}</div>`
    : '';
  const sibs = spans.map((sp, i) => ({ sp, i })).filter(x => x.sp.turnIndex === s.turnIndex).sort((a, b) => (a.sp.relStartMs ?? 0) - (b.sp.relStartMs ?? 0));
  const strip = sibs.map(x => opGlyph(x.sp, x.i === idx)).join('');
  return `<div class="spandetail">
    <dl class="span-kv">${kv.map(([k, v]) => `<div><dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd></div>`).join('')}</dl>
    ${io}
    ${flank}
    <div class="span-ctx"><span class="span-ctx-label">${escapeHtml(t('insights.dTurnContext', { turn: s.turnIndex }))}</span><div class="opstrip">${strip}</div></div>
  </div>`;
}

const SPAN_TAGS: SafeSpanTag[] = ['failure', 'slow', 'retry', 'read_write_imbalance'];

// 文件改动 + 跑过的命令 — session-level work summary (codex's workSummary, detail=spans, owner-only).
// Two panels at the top of 动作 span: which files were touched (read/edit counts + line churn) and
// which commands ran (deduped + ×repeat + failures). Ported from the reference tool (老滕's ask).
function renderWorkSummary(report: SafeInsightReport): string {
  const ws = report.workSummary;
  if (!ws || (!ws.fileChanges?.length && !ws.commandsRun?.length)) return '';
  const files = ws.fileChanges ?? [];
  const cmds = ws.commandsRun ?? [];
  const fileRows = files.length
    ? files.map(f => {
        const stat = (f.added || f.removed)
          ? `<span class="ws-stat"><span class="ws-add">+${f.added ?? 0}</span><span class="ws-del">−${f.removed ?? 0}</span></span>`
          : (f.edits ? `<span class="ws-stat ws-stat-edits">${escapeHtml(t('insights.wsEdits', { n: f.edits }))}</span>` : '');
        return `<div class="ws-row"><code class="ws-path" title="${escapeHtml(f.path)}">${escapeHtml(f.path)}</code><span class="ws-meta">${escapeHtml(t('insights.wsReads', { n: f.reads }))}</span>${stat}</div>`;
      }).join('')
    : `<p class="mut">${escapeHtml(t('insights.wsNoFiles'))}</p>`;
  const cmdRows = cmds.length
    ? cmds.map(c => {
        const bad = c.failures > 0;
        return `<div class="ws-row${bad ? ' bad' : ''}"><code class="ws-cmd" title="${escapeHtml(c.command.text)}">${escapeHtml(c.command.text)}${c.command.truncated ? '…' : ''}</code><span class="ws-meta">${c.count > 1 ? `<span class="ws-x">×${c.count}</span>` : ''}${bad ? `<span class="ws-fail">${escapeHtml(t('insights.wsFail', { n: c.failures }))}</span>` : ''}</span></div>`;
      }).join('')
    : `<p class="mut">${escapeHtml(t('insights.wsNoCmds'))}</p>`;
  return `<div class="worksum">
    <section class="ws-panel"><h4>${escapeHtml(t('insights.wsFiles', { n: files.length }))}</h4><div class="ws-list">${fileRows}</div></section>
    <section class="ws-panel"><h4>${escapeHtml(t('insights.wsCmds', { n: cmds.length }))}</h4><div class="ws-list">${cmdRows}</div></section>
  </div>`;
}

// 动作 span tab → compact evidence table. Tag chips filter (全部/失败/慢/…); each row expands
// to its 详情 drawer. Replaces the old giant cards + duplicated full timeline (老滕 point 2).
function renderEvidence(report: SafeInsightReport, focus: { rec: DiagnosticRecommendation | null; spanIdx: Set<number> }, spanFilter: string, openSpans: Set<number>): string {
  const spans = report.spans ?? [];
  const work = renderWorkSummary(report);
  if (!spans.length) return `${work}<p class="mut">${escapeHtml(t('insights.noSpans'))}</p>`;
  const order = [...spans.keys()].sort((a, b) => (spans[a]!.relStartMs ?? 0) - (spans[b]!.relStartMs ?? 0));
  const counts = new Map<string, number>();
  for (const i of order) for (const tg of spans[i]!.tags ?? []) if ((SPAN_TAGS as string[]).includes(tg)) counts.set(tg, (counts.get(tg) ?? 0) + 1);
  const chip = (key: string, label: string, n: number) => `<button type="button" class="spanchip${key === 'all' ? '' : ` tg-${escapeHtml(key)}`}${spanFilter === key ? ' on' : ''}" data-spanfilter="${escapeHtml(key)}">${escapeHtml(label)} <b>${n}</b></button>`;
  const chips = [chip('all', t('insights.spanAll'), order.length), ...SPAN_TAGS.filter(tg => counts.has(tg)).map(tg => chip(tg, tagLabel(tg), counts.get(tg)!))].join('');
  const visible = spanFilter === 'all' ? order : order.filter(i => spans[i]!.tags?.includes(spanFilter as SafeSpanTag));
  const reason = focus.rec ? `<div class="ev-reason">${escapeHtml(idText('why', focus.rec.why))}</div>` : '';
  const rows = visible.length
    ? visible.map(i => renderSpanRow(spans, i, focus.spanIdx.has(i), openSpans.has(i))).join('')
    : `<p class="mut">${escapeHtml(t('insights.evNoFlags'))}</p>`;
  return `<div class="evidence">${work}${reason}<div class="spanfilter">${chips}</div><div class="spantable">${rows}</div></div>`;
}

function renderDetailShell(rec: InsightRecord | undefined): string {
  if (!rec) return `<section class="insight-detail"><p class="mut">${escapeHtml(t('insights.selectSession'))}</p></section>`;
  const s = rec.session;
  return `<section class="insight-detail">
    <div class="shead">
      <h2>${escapeHtml(sessionTitle(s))}</h2>
      <div class="smeta">${escapeHtml(botDisplayName(s))} · ${escapeHtml(String(s.cliId ?? '-'))} · <code>${escapeHtml(String(s.sessionId ?? ''))}</code></div>
    </div>
    <div id="insight-detail-body"><p class="mut">${escapeHtml(t('insights.detailLoading'))}</p></div>
  </section>`;
}

// 逐轮对账 tab → per-turn timeline. ALL visible turns (codex's report.turnTimeline), normal
// turns collapsed to a one-line event strip, flagged turns severity-coloured with a「怎么优化」
// line; expand for the full ordered event rows. Owner-only prompt 原文 (turnTimeline[].prompt,
// detail=spans only) renders at the turn head. Answers 老滕 point 3: all turns + a real timeline.
// Display-only: strip botmux-injected scaffolding (sender/mentions/reminders/quote notices)
// from the owner-only prompt so the actual user text shows. The report still carries the raw
// (truncated, credential-scrubbed) text; this is a readability projection, not a security one.
function cleanPromptText(raw: string): string {
  let s = raw
    .replace(/<(mentions|attachments|available_bots|system-reminder|quoted_messages|sender)\b[\s\S]*?<\/\1>/g, ' ')
    .replace(/<botmux_reminder>[\s\S]*?<\/botmux_reminder>/g, ' ')
    .replace(/<\/?(user_message|local-command-[a-z]+)>/g, ' ')
    .replace(/<sender\b[^>]*\/?>/g, ' ')
    .replace(/<mention\b[^>]*\/?>/g, ' ')
    .replace(/\[用户引用了消息[\s\S]*?\]/g, ' ')
    .replace(/\[来自[^\]]*@mention\]/g, ' ')
    .replace(/\[(图片|文件)\s*\d+\][^\n]*/g, ' ');
  // Preserve newlines — markdown block structure (lists, fences, headings) depends on them.
  // Only collapse runs of spaces/tabs and trim spaces around newlines / cap blank-line runs.
  return s
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Owner-only prompt 原文 rendered as Markdown (老滕: prompt 里可能有 markdown，想 prettier 展示).
// html:false → any literal <…> in the prompt is escaped, never raw HTML/script; validateLink
// whitelists http/https/mailto so a javascript:/data: link can't slip through; links open in a
// new tab with noopener. The output is markdown-it's own safe tag set, so innerHTML of it is safe.
// Parse failure ⇒ fall back to escaped plain text — never break 对账.
const promptMd = new MarkdownIt({ html: false, linkify: true, breaks: true });
promptMd.validateLink = (url: string) => /^(https?:|mailto:)/i.test(url.trim());
const _linkOpen = promptMd.renderer.rules.link_open;
promptMd.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  tokens[idx]!.attrSet('target', '_blank');
  tokens[idx]!.attrSet('rel', 'noopener noreferrer nofollow');
  return _linkOpen ? _linkOpen(tokens, idx, options, env, self) : self.renderToken(tokens, idx, options);
};
function renderPromptMarkdown(text: string): string {
  try {
    const html = promptMd.render(text).trim();
    return html || `<p>${escapeHtml(text)}</p>`;
  } catch {
    return `<p>${escapeHtml(text)}</p>`;
  }
}

function turnEventGlyph(e: TurnTimelineEvent): string {
  const bad = e.status === 'error' || (!!e.result && BAD_RESULTS.has(e.result.category));
  const what = intentTextOf(e.intent, String(e.label.params.tool ?? e.kind));
  const title = `${what}${e.intent?.subject ? ` ${e.intent.subject}` : ''}${e.result ? ` → ${resultLabel(e.result.category)}` : ''} · ${fmtMs(e.durationMs)}`;
  return `<i class="op ph-${escapeHtml(phaseSlug(e.phase))}${bad ? ' bad' : ''}" title="${escapeHtml(title)}"></i>`;
}

// Prompt source attribution (codex's prompt.source: name/type/flags only, no open_id). Surfaces
// WHO actually sent the turn — 老滕/其他人 (👤), a bot (🤖), or an a2a forward (🤝) — answering
// 老滕's「区分 a2a / 其他人消息」, driven by codex's authoritative source.kind. a2a shows the
// specific sending agent (agentName ?? senderName); system = injected task-notification callbacks.
function promptSourceChip(src?: { kind?: string; agentName?: string; senderName?: string }): string {
  if (!src?.kind) return '';
  if (src.kind === 'a2a_agent') {
    const name = src.agentName || src.senderName;
    return `<span class="tp-label tp-src tp-src-a2a">🤝 ${name ? `${escapeHtml(name)} · a2a` : 'a2a'}</span>`;
  }
  if (src.kind === 'system') {
    return `<span class="tp-label tp-src tp-src-system">⚙️ ${escapeHtml(t('insights.senderSystem'))}</span>`;
  }
  const name = src.senderName ? escapeHtml(src.senderName) : '';
  return `<span class="tp-label tp-src tp-src-user">👤 ${name || escapeHtml(t('insights.turnPrompt'))}</span>`;
}
function promptMentions(src?: { mentionedNames?: string[] }): string {
  const ms = (src?.mentionedNames ?? []).filter(Boolean);
  if (!ms.length) return '';
  return `<span class="tp-mentions">${escapeHtml(t('insights.srcMentions'))} ${ms.map(n => '@' + escapeHtml(n)).join(' ')}</span>`;
}

// Full-text prompt modal (老滕: 做个弹窗看全文). Bigger centred reading surface for one turn's
// prompt — source badge + markdown (or 原文) + truncation note. Same safe markdown path as inline.
function renderPromptModalInner(turnIndex: number, prompt: TurnPromptPreview | undefined, raw: boolean): string {
  const src = prompt?.source;
  const badge = promptSourceChip(src) || `<span class="tp-label">${escapeHtml(t('insights.turnPrompt'))}</span>`;
  const mentions = promptMentions(src);
  const cleaned = prompt?.text ? (cleanPromptText(prompt.text) || prompt.text) : '';
  const trunc = prompt?.truncated;
  const bodyHtml = raw
    ? `<pre class="tp-raw modal-raw">${escapeHtml(cleaned)}${trunc ? '\n…' : ''}</pre>`
    : `<div class="md-body modal-md">${renderPromptMarkdown(cleaned + (trunc ? ' …' : ''))}</div>`;
  return `<div class="modal-backdrop" data-modal-close></div>
    <div class="modal-panel" role="dialog" aria-modal="true" aria-label="${escapeHtml(t('insights.turnPrompt'))}">
      <div class="modal-head">
        <div class="modal-who">${badge}${mentions}<span class="modal-turnno">#${escapeHtml(String(turnIndex))}</span></div>
        <div class="modal-acts">
          <button type="button" class="tp-toggle" data-modal-raw>${escapeHtml(raw ? t('insights.turnPromptRendered') : t('insights.turnPromptRaw'))}</button>
          <button type="button" class="modal-close" data-modal-close aria-label="${escapeHtml(t('insights.modalClose'))}">×</button>
        </div>
      </div>
      <div class="modal-body">${bodyHtml}${trunc ? `<p class="modal-trunc mut">${escapeHtml(t('insights.promptTruncated'))}</p>` : ''}</div>
    </div>`;
}

// One turn card: prompt 原文 + op-strip + 怎么优化 advice + expandable event rows. Each event row
// is detailable so its 详情 drawer carries the raw command/output too (老滕: 对账 tab 下也要看到命令和结果).
function renderTurnCard(report: SafeInsightReport, spans: SafeSpan[], tn: TurnTimelineTurn, focus: { turnIdx: Set<number> }, openTurns: Set<number>, openSpans: Set<number>, openPrompts: Set<number>, rawPrompts: Set<number>): string {
  const open = openTurns.has(tn.turnIndex);
  const hot = focus.turnIdx.has(tn.turnIndex) ? ' hot' : '';
  const m = tn.metrics;
  const advice = tn.severity !== 'info' ? turnAdvice(tn.tags) : '';
  const strip = tn.events.map(turnEventGlyph).join('');
  // Prompt 原文: render as Markdown by default (老滕 wants prettier), clamped so a long prompt can't
  // blow the timeline; 展开 lifts the clamp (still scroll-capped), 原文 shows the raw text instead.
  const ptext = tn.prompt?.text ? (cleanPromptText(tn.prompt.text) || tn.prompt.text) : '';
  const promptExpanded = openPrompts.has(tn.turnIndex);
  const promptRaw = rawPrompts.has(tn.turnIndex);
  const ptail = tn.prompt?.truncated ? ' …' : '';
  const promptBody = promptRaw
    ? `<pre class="tp-raw">${escapeHtml(ptext)}${tn.prompt?.truncated ? '\n…' : ''}</pre>`
    : `<div class="md-body">${renderPromptMarkdown(ptext + ptail)}</div>`;
  const srcChip = promptSourceChip(tn.prompt?.source) || `<span class="tp-label">${escapeHtml(t('insights.turnPrompt'))}</span>`;
  const mentionsHtml = promptMentions(tn.prompt?.source);
  const promptHtml = ptext
    ? `<div class="turn-prompt">
      ${srcChip}
      <div class="tp-body">
        <div class="tp-md${promptExpanded ? ' expanded' : ''}">${promptBody}</div>
        <div class="tp-actions">
          ${mentionsHtml}
          <button type="button" class="tp-toggle" data-prompt-expand="${escapeHtml(String(tn.turnIndex))}">${escapeHtml(promptExpanded ? t('insights.turnPromptCollapse') : t('insights.turnPromptExpand'))}</button>
          <button type="button" class="tp-toggle" data-prompt-raw="${escapeHtml(String(tn.turnIndex))}">${escapeHtml(promptRaw ? t('insights.turnPromptRendered') : t('insights.turnPromptRaw'))}</button>
          <button type="button" class="tp-toggle" data-prompt-full="${escapeHtml(String(tn.turnIndex))}">${escapeHtml(t('insights.turnPromptFull'))}</button>
        </div>
      </div>
    </div>`
    : '';
  const pill = (label: string, val: string, bad = false) => `<span class="tm${bad ? ' bad' : ''}"><i>${escapeHtml(label)}</i><b>${escapeHtml(val)}</b></span>`;
  const mini = `${t('insights.mEdits')}${m.edits} ${t('insights.mRuns')}${m.runs}${m.failures ? ` · ${t('insights.mFailures')}${m.failures}` : ''} · ${fmtMs(m.durationMs)}`;
  const detail = open
    ? `<div class="turn-detail">
        <div class="turn-metrics">${pill(t('insights.mReads'), String(m.reads))}${pill(t('insights.mEdits'), String(m.edits))}${pill(t('insights.mRuns'), String(m.runs))}${m.failures ? pill(t('insights.mFailures'), String(m.failures), true) : ''}${pill(t('insights.mDur'), fmtMs(m.durationMs))}</div>
        <div class="spantable">${tn.events.map(e => renderSpanRow(spans, e.spanIndex, false, openSpans.has(e.spanIndex), true)).join('')}</div>
      </div>`
    : '';
  return `<div class="turnrow sev-${escapeHtml(tn.severity)}${hot}${tn.severity !== 'info' ? ' flagged' : ''}${open ? ' open' : ''}" data-turn-card="${escapeHtml(String(tn.turnIndex))}">
    <div class="turnline">
      <span class="turn-no">#${escapeHtml(String(tn.turnIndex))}</span>
      <b class="turn-headline">${escapeHtml(turnHeadline(tn.headline))}</b>
      <div class="opstrip turn-strip">${strip}</div>
      <span class="turn-mini">${escapeHtml(mini)}</span>
      <button type="button" class="turn-expand-btn" data-turn="${escapeHtml(String(tn.turnIndex))}" aria-expanded="${open}">${escapeHtml(open ? t('insights.turnCollapse') : t('insights.turnExpand', { count: tn.events.length }))}</button>
    </div>
    ${promptHtml}
    ${advice ? `<div class="turn-advice">${escapeHtml(advice)}</div>` : ''}
    ${detail}
  </div>`;
}

// Classify a turn by who started it, straight from codex's source.kind (老滕's 发起人 filter):
// user (a person), a2a_agent (another bot), system (task-notification callbacks). Unattributed → user.
type LedgerSender = 'all' | 'user' | 'a2a_agent' | 'system';
function turnSenderKind(tn: TurnTimelineTurn): Exclude<LedgerSender, 'all'> {
  return tn.prompt?.source?.kind ?? 'user';
}

// 逐轮对账 tab → per-turn timeline. 发起人 filter narrows first (全部 = 对话 = user+a2a; 系统 is an
// opt-in, since task-notification callbacks aren't real conversation), then two orderings: 正常排序
// (by turnIndex) and 按建议分类 (turns grouped under the recommendation that cites them).
function renderTurnEfficiency(report: SafeInsightReport, focus: { turnIdx: Set<number> }, openTurns: Set<number>, openSpans: Set<number>, ledgerSort: 'normal' | 'grouped', openPrompts: Set<number>, rawPrompts: Set<number>, ledgerSender: LedgerSender): string {
  const spans = report.spans ?? [];
  const allTurns = report.turnTimeline ?? [];
  if (!allTurns.length) return `<p class="mut">${escapeHtml(t('insights.noSpans'))}</p>`;
  const recs = report.recommendations ?? [];
  const canGroup = recs.some(r => (r.evidence?.turnIndexes?.length ?? 0) > 0);

  // 发起人 filter chips — only show a kind that actually occurs; emoji mirror the prompt badges.
  // 全部 = conversation (user + a2a), system excluded by default; 系统 chip is muted opt-in.
  const senderCount: Record<Exclude<LedgerSender, 'all'>, number> = { user: 0, a2a_agent: 0, system: 0 };
  for (const tn of allTurns) senderCount[turnSenderKind(tn)]++;
  const senderChip = (key: LedgerSender, label: string, n: number, extra = '') => `<button type="button" class="spanchip${extra}${ledgerSender === key ? ' on' : ''}" data-ledgersender="${key}">${escapeHtml(label)} <b>${n}</b></button>`;
  const senderChips = [
    senderChip('all', t('insights.spanAll'), senderCount.user + senderCount.a2a_agent),
    ...(senderCount.user ? [senderChip('user', `👤 ${t('insights.senderHuman')}`, senderCount.user)] : []),
    ...(senderCount.a2a_agent ? [senderChip('a2a_agent', `🤝 ${t('insights.senderA2A')}`, senderCount.a2a_agent)] : []),
    ...(senderCount.system ? [senderChip('system', `⚙️ ${t('insights.senderSystem')}`, senderCount.system, ' spanchip-sys')] : []),
  ].join('');
  const senderFilter = `<div class="spanfilter ledgersender">${senderChips}</div>`;

  const turns = ledgerSender === 'all'
    ? allTurns.filter(tn => turnSenderKind(tn) !== 'system')
    : allTurns.filter(tn => turnSenderKind(tn) === ledgerSender);
  const flagged = turns.filter(tn => tn.severity !== 'info').length;
  const sortChip = (key: 'normal' | 'grouped', label: string) => `<button type="button" class="spanchip${ledgerSort === key ? ' on' : ''}" data-ledgersort="${key}">${escapeHtml(label)}</button>`;
  const toggle = canGroup ? `<div class="spanfilter ledgersort">${sortChip('normal', t('insights.ledgerNormal'))}${sortChip('grouped', t('insights.ledgerGrouped'))}</div>` : '';
  const controls = `${senderFilter}${toggle}`;
  const summary = `<p class="turn-sum mut">${escapeHtml(t('insights.turnSummary', { total: turns.length, flagged }))}</p>`;
  const note = report.meta?.capped ? `<p class="turn-hidden mut">${escapeHtml(t('insights.turnsCapped', { shown: String(report.meta.spansReturned ?? spans.length), total: String(report.meta.spansTotal ?? spans.length) }))}</p>` : '';
  const card = (tn: TurnTimelineTurn) => renderTurnCard(report, spans, tn, focus, openTurns, openSpans, openPrompts, rawPrompts);

  if (!turns.length) return `<div class="turnlist">${controls}<p class="mut">${escapeHtml(t('insights.evNoFlags'))}</p></div>`;

  if (ledgerSort === 'grouped' && canGroup) {
    const sortedRecs = [...recs].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
    const byIndex = new Map(turns.map(tn => [tn.turnIndex, tn] as const));
    const assigned = new Map<number, string>();
    for (const r of sortedRecs) for (const ti of r.evidence?.turnIndexes ?? []) if (byIndex.has(ti) && !assigned.has(ti)) assigned.set(ti, r.id);
    const groupHead = (sev: string, title: string, n: number) => `<div class="turn-group-head sev-${escapeHtml(sev)}"><b>${escapeHtml(title)}</b><span>${escapeHtml(t('insights.ledgerGroupCount', { count: n }))}</span></div>`;
    const blocks: string[] = [];
    for (const r of sortedRecs) {
      const ts = turns.filter(tn => assigned.get(tn.turnIndex) === r.id).sort((a, b) => a.turnIndex - b.turnIndex);
      if (ts.length) blocks.push(`<div class="turn-group">${groupHead(r.severity, idText('rec', { id: r.id, params: {} }), ts.length)}${ts.map(card).join('')}</div>`);
    }
    const other = turns.filter(tn => !assigned.has(tn.turnIndex)).sort((a, b) => a.turnIndex - b.turnIndex);
    if (other.length) blocks.push(`<div class="turn-group">${groupHead('info', t('insights.ledgerOther'), other.length)}${other.map(card).join('')}</div>`);
    return `<div class="turnlist">${summary}${controls}${blocks.join('')}${note}</div>`;
  }

  const ordered = [...turns].sort((a, b) => a.turnIndex - b.turnIndex);
  return `<div class="turnlist">${summary}${controls}${ordered.map(card).join('')}${note}</div>`;
}

// ── 对话回放 (conversation replay) ───────────────────────────────────────────
// codex's paginated conversation stream rendered as Feishu-style chat bubbles: one prompt bubble
// per user/a2a/system message, one "agent activity" bubble per run of consecutive same-turn agent
// ops. Each message carries severity/tags/source/event so error & sender overlays come straight
// from it; recommendation badges join by turnIndex against report.recommendations.

type ConvoState = { messages: InsightConversationMessage[]; total: number; hasMore: boolean; nextOffset: number; loading: boolean; q: string; role: string; tag: string; openOps: Set<string> };
type ConvoUnit = { kind: 'prompt'; msg: InsightConversationMessage } | { kind: 'ops'; turnIndex: number; msgs: InsightConversationMessage[] };

function groupConvo(messages: InsightConversationMessage[]): ConvoUnit[] {
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

// Recommendation badge(s) for a turn — links a chat turn to the optimisation findings that cite it.
function convoRecBadges(turnIndex: number, recByTurn: Map<number, string[]>): string {
  const ids = recByTurn.get(turnIndex);
  if (!ids?.length) return '';
  return ids.map(id => `<span class="cbub-rec" title="${escapeHtml(idText('rec', { id, params: {} }))}">💡 ${escapeHtml(idText('rec', { id, params: {} }))}</span>`).join('');
}

function renderConvoPrompt(m: InsightConversationMessage, recByTurn: Map<number, string[]>): string {
  const side = m.role === 'user' ? 'right' : 'left';
  const badge = promptSourceChip(m.source) || `<span class="tp-label">${escapeHtml(t('insights.turnPrompt'))}</span>`;
  const text = m.text ? (cleanPromptText(m.text) || m.text) : '';
  const sevCls = m.severity && m.severity !== 'info' ? ` sev-${escapeHtml(m.severity)}` : '';
  return `<div class="cbub cbub-${side} role-${escapeHtml(m.role)}${sevCls}">
    <div class="cbub-head">${badge}${promptMentions(m.source)}<span class="cbub-turn">#${escapeHtml(String(m.turnIndex))}</span>${convoRecBadges(m.turnIndex, recByTurn)}</div>
    <div class="cbub-body"><div class="md-body">${text ? renderPromptMarkdown(text + (m.truncated ? ' …' : '')) : `<p class="mut">${escapeHtml(t('insights.replayNoText'))}</p>`}</div></div>
    ${m.truncated ? `<div class="cbub-foot"><button type="button" class="tp-toggle" data-convo-full="${escapeHtml(String(m.turnIndex))}">${escapeHtml(t('insights.turnPromptFull'))}</button></div>` : ''}
  </div>`;
}

function renderConvoOpRow(m: InsightConversationMessage, open: boolean): string {
  const e = m.event;
  if (!e) return '';
  const bad = e.status === 'error' || (!!e.result && BAD_RESULTS.has(e.result.category));
  const subj = e.intent?.subject ? `<code class="span-subj">${escapeHtml(e.intent.subject)}</code>` : '';
  const what = intentTextOf(e.intent, String(e.label?.params?.tool ?? e.kind));
  const res = e.result && BAD_RESULTS.has(e.result.category)
    ? `<span class="span-res rc-bad">${escapeHtml(resultLabel(e.result.category))}${e.result.exitCode !== undefined ? ` · exit ${e.result.exitCode}` : ''}</span>`
    : '';
  const ev = e.evidence;
  const expandable = !!(ev?.command?.text || ev?.output?.text);
  const io = open && ev ? `${renderTextPreview(t('insights.dCommand'), ev.command)}${renderTextPreview(t('insights.dCmdOutput'), ev.output)}` : '';
  const tags = (m.tags ?? []).filter(tg => tg !== 'normal' && tg !== 'diagnostic');
  const tagChips = tags.map(tg => `<span class="span-tag tg-${escapeHtml(tg)}">${escapeHtml(tagLabel(tg))}</span>`).join('');
  return `<div class="cop${bad ? ' bad' : ''}${open ? ' open' : ''}">
    <div class="cop-line${expandable ? ' clickable' : ''}"${expandable ? ` data-convo-op="${escapeHtml(m.id)}" role="button" tabindex="0"` : ''}>
      <i class="op ph-${escapeHtml(phaseSlug(e.phase))}${bad ? ' bad' : ''}"></i>
      <b class="span-what">${escapeHtml(what)}</b>${subj}${res}
      <span class="span-tags">${tagChips}</span>
      <span class="span-dur">${escapeHtml(fmtMs(e.durationMs))}</span>
      ${expandable ? `<span class="span-detail-btn" aria-hidden="true">${escapeHtml(open ? t('insights.dCollapse') : t('insights.dDetail'))}</span>` : ''}
    </div>
    ${io ? `<div class="spandetail">${io}</div>` : ''}
  </div>`;
}

function renderConvoOps(unit: { turnIndex: number; msgs: InsightConversationMessage[] }, openOps: Set<string>, recByTurn: Map<number, string[]>): string {
  // An agent turn carries narration ('say': text, no event) + operations (event).
  const sayMsgs = unit.msgs.filter(m => m.text && !m.event);
  const opMsgs = unit.msgs.filter(m => m.event);
  const worst = unit.msgs.some(m => m.severity === 'bad') ? ' sev-bad' : unit.msgs.some(m => m.severity === 'warn') ? ' sev-warn' : '';
  // m.text already carries a trailing '…' when truncated (safeScrubAndTruncate),
  // so don't append another — that double-ellipsis'd the bubble.
  const say = sayMsgs.map(m => `<div class="cbub-say"><div class="md-body">${renderPromptMarkdown(m.text!)}</div></div>`).join('');
  const rows = opMsgs.map(m => renderConvoOpRow(m, openOps.has(m.id))).join('');
  return `<div class="cbub cbub-left role-agent cbub-ops${worst}">
    <div class="cbub-head"><span class="tp-label tp-src tp-src-system">🤖 ${escapeHtml(t('insights.replayAgent'))}</span><span class="cbub-turn">#${escapeHtml(String(unit.turnIndex))}</span>${opMsgs.length ? `<span class="cbub-opcount">${escapeHtml(t('insights.replayOps', { count: opMsgs.length }))}</span>` : ''}${convoRecBadges(unit.turnIndex, recByTurn)}</div>
    ${say ? `<div class="cbub-saywrap">${say}</div>` : ''}
    ${rows ? `<div class="cbub-ops-list">${rows}</div>` : ''}
  </div>`;
}

function renderConvoThread(convo: ConvoState, recByTurn: Map<number, string[]>): string {
  if (!convo.messages.length) {
    return convo.loading ? `<p class="mut">${escapeHtml(t('insights.detailLoading'))}</p>` : `<p class="mut">${escapeHtml(t('insights.replayEmpty'))}</p>`;
  }
  const units = groupConvo(convo.messages);
  const bubbles = units.map(u => u.kind === 'prompt' ? renderConvoPrompt(u.msg, recByTurn) : renderConvoOps(u, convo.openOps, recByTurn)).join('');
  const more = convo.hasMore
    ? `<div class="convo-more"><button type="button" class="primary convo-loadmore"${convo.loading ? ' disabled' : ''}>${escapeHtml(convo.loading ? t('insights.detailLoading') : t('insights.replayLoadMore', { shown: convo.messages.length, total: convo.total }))}</button></div>`
    : `<p class="convo-more mut">${escapeHtml(t('insights.replayAllLoaded', { total: convo.total }))}</p>`;
  return `${bubbles}${more}`;
}

const CONVO_ROLES: Array<{ key: string; label: string }> = [
  { key: 'all', label: 'spanAll' },
  { key: 'user', label: 'senderHuman' },
  { key: 'a2a_agent', label: 'senderA2A' },
  { key: 'system', label: 'senderSystem' },
];
const CONVO_TAGS: Array<{ key: string; label: string }> = [
  { key: 'all', label: 'spanAll' },
  { key: 'failure', label: 'tag.failure' },
  { key: 'slow', label: 'tag.slow' },
];

function renderConvo(convo: ConvoState, recByTurn: Map<number, string[]>): string {
  const roleChips = CONVO_ROLES.map(r => `<button type="button" class="spanchip${convo.role === r.key ? ' on' : ''}" data-convo-role="${r.key}">${escapeHtml(r.label.includes('.') ? tagLabel(r.label.split('.')[1]!) : t('insights.' + r.label))}</button>`).join('');
  const tagChips = CONVO_TAGS.map(tg => `<button type="button" class="spanchip${convo.tag === tg.key ? ' on' : ''}" data-convo-tag="${tg.key}">${escapeHtml(tg.label.includes('.') ? tagLabel(tg.label.split('.')[1]!) : t('insights.' + tg.label))}</button>`).join('');
  return `<div class="convo">
    <div class="convo-controls">
      <input type="search" class="convo-search" placeholder="${escapeHtml(t('insights.replaySearch'))}" value="${escapeHtml(convo.q)}">
      <div class="convo-filters">
        <div class="spanfilter convo-rolefilter"><span class="convo-flabel">${escapeHtml(t('insights.replayBy'))}</span>${roleChips}</div>
        <div class="spanfilter convo-tagfilter"><span class="convo-flabel">${escapeHtml(t('insights.replayState'))}</span>${tagChips}</div>
      </div>
    </div>
    <div class="convothread">${renderConvoThread(convo, recByTurn)}</div>
  </div>`;
}

// A turn has no single phase; pick the one its events spent the most time in (a +1 floor so
// zero-duration events still vote), so the rail node color reflects what the turn mostly did.
function turnMainPhase(tn: TurnTimelineTurn): string {
  const w = new Map<string, number>();
  for (const e of tn.events ?? []) { if (!e.phase) continue; w.set(e.phase, (w.get(e.phase) ?? 0) + (e.durationMs ?? 0) + 1); }
  let best = 'discuss', max = -1;
  for (const [p, d] of w) if (d > max) { max = d; best = p; }
  return best;
}

// 会话轨迹 — session-trace mini-map. One clickable node per turn, colored by its dominant phase,
// badged for failures/slow/recommendation hits, dimmed when a recommendation focus is active (so the
// cited turns pop). Clicking a node jumps to that turn in the 逐轮对账 ledger. Per codex: no turn-level
// compaction marker (only a session-level count exists — don't fake per-turn compaction points).
function renderTurnRail(report: SafeInsightReport, focus: { turnIdx: Set<number> }, recByTurn: Map<number, string[]>): string {
  // Serial main line — MUST be in turn order. turnTimeline arrives unsorted (the ledger sorts it too),
  // so sort by turnIndex here or the rail reads as random (老滕: 顺序乱).
  const turns = [...(report.turnTimeline ?? [])].sort((a, b) => a.turnIndex - b.turnIndex);
  if (turns.length < 2) return '';
  const focused = focus.turnIdx.size > 0;
  const items = turns.map(tn => {
    const m = tn.metrics;
    const phase = turnMainPhase(tn);
    const fail = (tn.tags ?? []).includes('failure') || (tn.events ?? []).some(e => e.status === 'error');
    const slow = (tn.tags ?? []).includes('slow');
    const recHit = recByTurn.has(tn.turnIndex);
    const hot = focus.turnIdx.has(tn.turnIndex);
    const cls = ['railnode', phaseClass(phase), hot ? 'hot' : '', (focused && !hot) ? 'dim' : ''].filter(Boolean).join(' ');
    const tip = `#${tn.turnIndex} · ${phaseLabel(phase)} · ${t('insights.mReads')}${m.reads} ${t('insights.mEdits')}${m.edits} ${t('insights.mRuns')}${m.runs}${m.failures ? ` · ${t('insights.mFailures')}${m.failures}` : ''} · ${fmtMs(m.durationMs)}`;
    const badges = `${fail ? '<i class="rb rb-fail"></i>' : ''}${slow ? '<i class="rb rb-slow"></i>' : ''}${recHit ? '<i class="rb rb-rec"></i>' : ''}`;
    const node = `<button type="button" class="${cls}" data-rail-turn="${escapeHtml(String(tn.turnIndex))}" data-tip="${escapeHtml(tip)}"><span>${escapeHtml(String(tn.turnIndex))}</span>${badges}</button>`;
    // 委派分支: one teal dot per subagent (delegate event) the turn spawned, so the serial main line
    // shows where work branched off — mirrors the reference's 串行主线 + 委派分支.
    const subs = (tn.events ?? []).filter(e => e.kind === 'delegate').length;
    const branch = subs ? `<span class="railbranch" data-tip="${escapeHtml(`#${tn.turnIndex} · ${t('insights.railSubagents', { n: subs })}`)}">${'<i class="rbr-sub"></i>'.repeat(Math.min(subs, 4))}</span>` : '';
    return node + branch;
  }).join('');
  const legend = [
    ...['research', 'edit', 'run', 'delegate', 'discuss'].map(p => `<span class="rl-item"><i class="${phaseClass(p)}"></i>${escapeHtml(phaseLabel(p))}</span>`),
    `<span class="rl-item rl-sep"><i class="rbr-sub"></i>${escapeHtml(t('insights.railSubagent'))}</span>`,
  ].join('');
  return `<section class="block turnrail-block">
    <div class="turnrail-head"><h3>${escapeHtml(t('insights.turnRail'))}</h3><span class="turnrail-legend">${legend}</span></div>
    <div class="turnrail">${items}</div>
  </section>`;
}

// 工作时序 — work-timeline Gantt. Each span is a bar positioned by relStartMs and sized by
// durationMs over the session's real elapsed span, colored by phase, failures/slow highlighted.
// Idle gaps show as empty track, so it's clear where the wall-clock actually went. Clicking a bar
// opens that span in the 动作 span tab.
function renderWorkGantt(report: SafeInsightReport): string {
  const timed = (report.spans ?? []).map((s, i) => ({ s, i, start: s.relStartMs ?? 0, dur: Math.max(s.durationMs ?? 0, 0) }))
    .filter(x => Number.isFinite(x.start)).sort((a, b) => a.start - b.start);
  if (timed.length < 2) return '';
  // Pack bars by time order, each width ∝ its duration — we deliberately drop real-time idle gaps
  // (a session left open for days would otherwise squish all the active work to the left). This reads
  // as "where the active wall-clock actually went": a 28s Bash is a fat bar, instant reads are slivers.
  const active = Math.max(timed.reduce((sum, x) => sum + x.dur, 0), 1);
  let cursor = 0;
  const bars = timed.map(x => {
    const left = cursor / active * 100;
    const width = Math.max(x.dur / active * 100, 0.3);
    cursor += x.dur;
    const fail = x.s.status === 'error' || (x.s.tags ?? []).includes('failure');
    const slow = (x.s.tags ?? []).includes('slow');
    const cls = ['gbar', phaseClass(x.s.phase), fail ? 'gbar-fail' : '', slow ? 'gbar-slow' : ''].filter(Boolean).join(' ');
    const st = x.s.status === 'error' ? ` · ${tagLabel('failure')}` : '';
    const tip = `#${x.i} · ${x.s.tool} · ${phaseLabel(x.s.phase)} · ${fmtMs(x.s.durationMs)}${st}`;
    return `<button type="button" class="${cls}" style="left:${left.toFixed(3)}%;width:${width.toFixed(3)}%" data-gantt-span="${x.i}" data-tip="${escapeHtml(tip)}"></button>`;
  }).join('');
  const realSpan = (timed[timed.length - 1]!.start + timed[timed.length - 1]!.dur) - timed[0]!.start;
  return `<section class="block gantt-block">
    <div class="turnrail-head"><h3>${escapeHtml(t('insights.gantt'))}</h3><span class="gantt-cap">${escapeHtml(t('insights.ganttCaption', { span: timed.length, dur: fmtMs(realSpan), active: fmtMs(active) }))}</span></div>
    <div class="gantt"><div class="gtrack">${bars}</div></div>
  </section>`;
}

// 上下文曲线 — context-pressure line. Plots codex's per-turn `context.contextTokens` (input + cache
// read + cache create = the size pushed into the model that turn) so the climb-then-drop at a
// compaction is visible from the curve shape. Backend-optional: only CLIs with usage carry context,
// and only on detail=spans — so this whole block hides when there are <2 points. No explicit
// turn-level compaction markers (codex: only a session-level count exists, don't fake per-turn ones).
function renderContextCurve(report: SafeInsightReport): string {
  const pts = (report.turnTimeline ?? [])
    .map(tn => (tn.context && Number.isFinite(tn.context.contextTokens)) ? { turn: tn.turnIndex, v: tn.context.contextTokens } : null)
    .filter((p): p is { turn: number; v: number } => p !== null)
    .sort((a, b) => a.turn - b.turn);
  if (pts.length < 2) return '';
  const max = Math.max(...pts.map(p => p.v), 1);
  const W = 100, H = 40, n = pts.length;
  const xs = (i: number) => (i / (n - 1)) * W;
  const ys = (v: number) => H - 1 - (v / max) * (H - 2);
  const line = pts.map((p, i) => `${xs(i).toFixed(2)},${ys(p.v).toFixed(2)}`).join(' ');
  const area = `0,${H} ${line} ${W},${H}`;
  // Invisible full-height hover bands per point — hovering anywhere in a turn's x-slice shows that
  // turn's exact context tokens via the shared tooltip (老滕: hover 要有具体数值).
  const band = W / n;
  const hits = pts.map((p, i) => `<rect class="ctxhit" x="${Math.max(0, xs(i) - band / 2).toFixed(2)}" y="0" width="${band.toFixed(2)}" height="${H}" data-tip="${escapeHtml(`${t('insights.ctxTurn', { n: p.turn })} · ${fmtInt(p.v)} tok`)}"></rect>`).join('');
  const mid = fmtInt(Math.round(max / 2));
  return `<section class="block ctxcurve-block">
    <div class="turnrail-head"><h3>${escapeHtml(t('insights.ctxCurve'))}</h3><span class="gantt-cap">${escapeHtml(t('insights.ctxCaption', { peak: fmtInt(max), turns: pts.length }))}</span></div>
    <div class="ctxchart">
      <div class="ctxyaxis"><span>${escapeHtml(fmtInt(max))}</span><span>${escapeHtml(mid)}</span><span>0 tok</span></div>
      <div class="ctxplot">
        <svg class="ctxcurve" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${escapeHtml(t('insights.ctxCurve'))}">
          <polygon class="ctxarea" points="${area}"/>
          <polyline class="ctxline" points="${line}"/>
          ${hits}
        </svg>
        <div class="ctxxaxis"><span>${escapeHtml(t('insights.ctxTurn', { n: pts[0]!.turn }))}</span><span>${escapeHtml(t('insights.ctxTurn', { n: pts[pts.length - 1]!.turn }))}</span></div>
      </div>
    </div>
  </section>`;
}

// Shared hover tooltip: any [data-tip] element inside a bound host (rail / gantt / context curve)
// shows its text in the persistent #insight-tip box, tracking the cursor. Native `title` is too slow
// and unreliable on the thin bars (老滕: 工作时序 hover 没提示).
function bindTip(host: HTMLElement, tipEl: HTMLElement): void {
  host.addEventListener('mousemove', e => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-tip]');
    if (!el) { tipEl.hidden = true; return; }
    tipEl.textContent = el.getAttribute('data-tip') || '';
    tipEl.hidden = false;
    const pad = 14;
    const r = tipEl.getBoundingClientRect();
    let x = e.clientX + pad, y = e.clientY + pad;
    if (x + r.width > window.innerWidth) x = e.clientX - r.width - pad;
    if (y + r.height > window.innerHeight) y = e.clientY - r.height - pad;
    tipEl.style.left = `${Math.max(4, x)}px`;
    tipEl.style.top = `${Math.max(4, y)}px`;
  });
  host.addEventListener('mouseleave', () => { tipEl.hidden = true; });
}

type DetailView = { activeId: string | null; tab: 'spans' | 'ledger' | 'convo'; spanFilter: string; openSpans: Set<number>; openTurns: Set<number>; ledgerSort: 'normal' | 'grouped'; openPrompts: Set<number>; rawPrompts: Set<number>; ledgerSender: LedgerSender; convo: ConvoState };
function renderDetailBody(report: SafeInsightReport, view: DetailView): string {
  if (report.status !== 'ok') {
    return `<p class="mut">${escapeHtml(safeStatus(report))}</p>`;
  }
  const a = report.agg;
  const focus = focusSets(report, view.activeId);
  const recByTurn = new Map<number, string[]>();
  for (const r of report.recommendations ?? []) for (const ti of r.evidence?.turnIndexes ?? []) { const arr = recByTurn.get(ti) ?? []; if (!arr.includes(r.id)) arr.push(r.id); recByTurn.set(ti, arr); }
  const meta = [
    report.meta?.asOf ? t('sessions.insightAsOf', { asOf: String(report.meta.asOf) }) : '',
    report.meta?.partial ? t('sessions.insightPartial') : '',
    report.meta?.capped ? t('sessions.insightCapped', { shown: String(report.meta.spansReturned ?? report.spans?.length ?? 0), total: String(report.meta.spansTotal ?? report.spans?.length ?? 0) }) : '',
  ].filter(Boolean).join(' · ');
  const spanCount = report.spans?.length ?? 0;
  const turnTotal = report.turnTimeline?.length ?? 0;
  return `
    <div class="cards insight-detail-metrics">
      ${renderMetric(t('insights.metricSpans'), fmtInt(a.totalSpans))}
      ${renderMetric(t('insights.metricFailed'), fmtInt(a.failedSpans))}
      ${renderMetric(t('insights.metricSlow'), fmtInt(a.slowSpans))}
      ${renderMetric(t('insights.metricRw'), a.readWriteRatio === null ? '-' : a.readWriteRatio.toFixed(1))}
    </div>
    ${meta ? `<p class="insight-meta">${escapeHtml(meta)}</p>` : ''}
    <section class="block recblock">
      <h3>${escapeHtml(t('insights.recommendations'))}</h3>
      ${renderRecommendations(report, view.activeId)}
    </section>
    ${renderTurnRail(report, focus, recByTurn)}
    ${renderWorkGantt(report)}
    ${renderContextCurve(report)}
    <div class="detailtabs">
      <div class="detailtabbar" role="tablist" aria-label="${escapeHtml(t('insights.detailTabs'))}">
        <button type="button" role="tab" data-tab="spans" class="${view.tab === 'spans' ? 'on' : ''}">${escapeHtml(t('insights.trace'))} <b>${spanCount}</b></button>
        <button type="button" role="tab" data-tab="ledger" class="${view.tab === 'ledger' ? 'on' : ''}">${escapeHtml(t('insights.ledger'))} <b>${turnTotal}</b></button>
        <button type="button" role="tab" data-tab="convo" class="${view.tab === 'convo' ? 'on' : ''}">${escapeHtml(t('insights.replay'))}</button>
      </div>
      <div class="detailtabbody">
        <div class="insight-tab-panel" data-panel="spans"${view.tab === 'spans' ? '' : ' hidden'}>${renderEvidence(report, focus, view.spanFilter, view.openSpans)}</div>
        <div class="insight-tab-panel" data-panel="ledger"${view.tab === 'ledger' ? '' : ' hidden'}>${renderTurnEfficiency(report, focus, view.openTurns, view.openSpans, view.ledgerSort, view.openPrompts, view.rawPrompts, view.ledgerSender)}</div>
        <div class="insight-tab-panel" data-panel="convo"${view.tab === 'convo' ? '' : ' hidden'}>${renderConvo(view.convo, recByTurn)}</div>
      </div>
    </div>`;
}

async function fetchDetail(sessionId: string): Promise<SafeInsightReport | null> {
  const r = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/insight?detail=spans`, { cache: 'no-store' });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || d?.ok === false) throw new Error(String(d?.error ?? r.status));
  return d.report as SafeInsightReport;
}

export function renderInsightsPage(root: HTMLElement): () => void {
  let overviewData: SafeInsightOverview | null = null;
  let records: InsightRecord[] = [];
  let filter: InsightFilter = 'all';
  const cliFilter = new Set<string>();
  let q = '';
  let selectedId: string | null = null;
  let activeRec: string | null = null;
  let detailReport: SafeInsightReport | null = null;
  let detailTab: 'spans' | 'ledger' | 'convo' = 'spans';
  let spanFilter = 'all';
  let openSpans = new Set<number>();
  let openTurns = new Set<number>();
  let ledgerSort: 'normal' | 'grouped' = 'normal';
  let ledgerSender: LedgerSender = 'all';
  let openPrompts = new Set<number>();
  let rawPrompts = new Set<number>();
  const newConvo = (): ConvoState => ({ messages: [], total: 0, hasMore: false, nextOffset: 0, loading: false, q: '', role: 'all', tag: 'all', openOps: new Set<string>() });
  let convo: ConvoState = newConvo();
  let modalTurn: number | null = null;
  let modalRaw = false;
  let modalPrompt: TurnPromptPreview | null = null;
  let modalReq = 0;
  let disposed = false;
  let tab: InsightTab = 'overview';
  let project = '';
  let timeWin = 'all';
  let showNoise = false;
  let sessSort: SessSort = 'recent';

  root.innerHTML = `
    <section class="page insights-page">
      <div class="page-heading">
        <div>
          <p class="eyebrow">${escapeHtml(t('nav.insights'))}</p>
          <h1>${escapeHtml(t('insights.title'))}</h1>
          <p>${escapeHtml(t('insights.subtitle'))}</p>
        </div>
        <button type="button" id="insight-refresh" class="primary">${escapeHtml(t('insights.refresh'))}</button>
      </div>
      <form id="insight-filters" class="filters insights-filters">
        <input type="search" name="q" placeholder="${escapeHtml(t('insights.search'))}">
        <select id="insight-project" class="ins-select" aria-label="${escapeHtml(t('insights.projectAll'))}"></select>
        <select id="insight-time" class="ins-select" aria-label="${escapeHtml(t('insights.timeAll'))}">
          ${TIME_WINDOWS.map(w => `<option value="${w.key}">${escapeHtml(t(w.label))}</option>`).join('')}
        </select>
        <div class="segmented" role="group" aria-label="${escapeHtml(t('insights.filter'))}">
          <button type="button" data-filter="all">${escapeHtml(t('insights.filterAll'))}</button>
          <button type="button" data-filter="review">${escapeHtml(t('insights.filterReview'))}</button>
          <button type="button" data-filter="failed">${escapeHtml(t('insights.filterFailed'))}</button>
          <button type="button" data-filter="slow">${escapeHtml(t('insights.filterSlow'))}</button>
        </div>
        <div id="insight-cli-filter" class="spanfilter cli-filter" role="group" aria-label="${escapeHtml(t('insights.filter'))}"></div>
        <label class="ins-toggle"><input type="checkbox" id="insight-noise"> ${escapeHtml(t('insights.showAll'))}</label>
        <button type="button" id="insight-clear" class="ins-clear">${escapeHtml(t('insights.clear'))}</button>
      </form>
      <div id="insight-tabbar">${renderTabBar(tab)}</div>
      <div id="insight-status" class="insight-page-status"></div>
      <div class="insight-panel" role="tabpanel" data-tabpanel="overview"><div id="insight-overview"></div></div>
      <div class="insight-panel" role="tabpanel" data-tabpanel="sessions" hidden>
        <div id="insight-list-view">
          <div class="insight-list-head">
            <span id="insight-list-subtitle"></span>
            <div class="sesssort" id="insight-sort"></div>
          </div>
          <div id="insight-list"></div>
        </div>
        <div id="insight-detail-view" hidden>
          <button type="button" id="insight-back" class="ins-back">← ${escapeHtml(t('insights.backToList'))}</button>
          <div id="insight-detail">${renderDetailShell(undefined)}</div>
        </div>
      </div>
      <div class="insight-panel" role="tabpanel" data-tabpanel="dist" hidden><div id="insight-dist"></div></div>
      <div class="insight-panel" role="tabpanel" data-tabpanel="hot" hidden><div id="insight-hot"></div></div>
      <div id="insight-modal" class="insight-modal" hidden></div>
      <div id="insight-tip" class="ins-tip" role="tooltip" hidden></div>
    </section>`;

  const status = root.querySelector<HTMLElement>('#insight-status')!;
  const overviewEl = root.querySelector<HTMLElement>('#insight-overview')!;
  const list = root.querySelector<HTMLElement>('#insight-list')!;
  const listSubtitle = root.querySelector<HTMLElement>('#insight-list-subtitle')!;
  const detail = root.querySelector<HTMLElement>('#insight-detail')!;
  const search = root.querySelector<HTMLInputElement>('input[name=q]')!;
  const refreshBtn = root.querySelector<HTMLButtonElement>('#insight-refresh')!;
  const filterButtons = [...root.querySelectorAll<HTMLButtonElement>('[data-filter]')];
  const cliFilterEl = root.querySelector<HTMLElement>('#insight-cli-filter')!;
  const distEl = root.querySelector<HTMLElement>('#insight-dist')!;
  const hotEl = root.querySelector<HTMLElement>('#insight-hot')!;
  const projectSel = root.querySelector<HTMLSelectElement>('#insight-project')!;
  const timeSel = root.querySelector<HTMLSelectElement>('#insight-time')!;
  const noiseToggle = root.querySelector<HTMLInputElement>('#insight-noise')!;
  const clearBtn = root.querySelector<HTMLButtonElement>('#insight-clear')!;
  const tabbar = root.querySelector<HTMLElement>('#insight-tabbar')!;
  const panels = [...root.querySelectorAll<HTMLElement>('.insight-panel')];
  const listView = root.querySelector<HTMLElement>('#insight-list-view')!;
  const detailView = root.querySelector<HTMLElement>('#insight-detail-view')!;
  const backBtn = root.querySelector<HTMLButtonElement>('#insight-back')!;
  const sortBar = root.querySelector<HTMLElement>('#insight-sort')!;

  // Sessions tab is list ⇆ full-width detail (not a cramped side panel): selecting
  // a session swaps to the detail view; 返回 clears it back to the list.
  function showSessionsView(): void {
    const detailMode = selectedId !== null;
    listView.hidden = detailMode;
    detailView.hidden = !detailMode;
  }

  function scopeOpts(): ScopeOpts {
    const w = TIME_WINDOWS.find(x => x.key === timeWin);
    const sinceMs = w && w.days > 0 ? Date.now() - w.days * 86400000 : undefined;
    return { project: project || undefined, sinceMs, analyzableOnly: !showNoise };
  }

  // Project <select> options reflect the severity+search+time scoped set (project
  // pick itself NOT applied), so the dropdown always shows reachable projects.
  function paintProjectOptions(): void {
    const base = filterRecords(records, filter, q, cliFilter, { ...scopeOpts(), project: undefined });
    const opts = projectOptions(base);
    const cur = project;
    projectSel.innerHTML = `<option value="">${escapeHtml(t('insights.projectAll'))}</option>` +
      opts.map(o => `<option value="${escapeHtml(o.id)}"${o.id === cur ? ' selected' : ''}>${escapeHtml(o.id)} (${o.count})</option>`).join('');
    if (cur && !opts.some(o => o.id === cur)) { project = ''; projectSel.value = ''; }
  }

  function showTab(): void {
    for (const p of panels) p.hidden = p.dataset.tabpanel !== tab;
    for (const b of tabbar.querySelectorAll<HTMLButtonElement>('[data-itab]')) {
      const on = b.dataset.itab === tab;
      b.classList.toggle('on', on);
      b.setAttribute('aria-selected', String(on));
    }
  }

  function wireSessionButtons(host: HTMLElement, jumpToSessions = false): void {
    for (const btn of host.querySelectorAll<HTMLButtonElement>('[data-session-id]')) {
      btn.onclick = () => {
        if (jumpToSessions && tab !== 'sessions') { tab = 'sessions'; showTab(); paint(); }
        void selectSession(btn.dataset.sessionId ?? '');
      };
    }
  }

  function currentRows(): InsightRecord[] {
    return sortRecordsBy(filterRecords(records, filter, q, cliFilter, scopeOpts()), sessSort);
  }

  function paint(): void {
    if (disposed) return;
    // Faceted CLI chips reflect the severity+search+scope set (CLI pick itself NOT
    // applied); drop stale CLI picks the other filters emptied out so the list
    // never gets stuck on nothing.
    const cliBase = filterRecords(records, filter, q, new Set(), scopeOpts());
    const present = new Set(cliBase.map(cliIdOf));
    for (const id of [...cliFilter]) if (!present.has(id)) cliFilter.delete(id);
    cliFilterEl.innerHTML = renderCliChips(cliBase, cliFilter);
    paintProjectOptions();
    noiseToggle.checked = showNoise;
    timeSel.value = timeWin;
    const rows = currentRows();
    filterButtons.forEach(btn => btn.classList.toggle('active', btn.dataset.filter === filter));
    overviewEl.innerHTML = overviewData ? renderOverview(aggregateRecords(rows)) : '';
    listSubtitle.textContent = t('insights.listCount', { shown: rows.length, total: records.length });
    sortBar.innerHTML = renderSortBar(sessSort);
    // When the analyzable-only default empties the list, point at the toggle so
    // the user isn't stranded on a blank page wondering where their sessions went.
    list.innerHTML = (!rows.length && !showNoise)
      ? `<div class="insight-empty">${escapeHtml(t('insights.empty'))}<br><span class="mut">${escapeHtml(t('insights.emptyAnalyzableHint'))}</span></div>`
      : renderSessionRows(rows, selectedId, true);
    const selected = rows.find(r => r.session.sessionId === selectedId) ?? records.find(r => r.session.sessionId === selectedId);
    if (!selectedId || !selected) detail.innerHTML = renderDetailShell(undefined);
    wireSessionButtons(list);
    showSessionsView();
    distEl.innerHTML = overviewData ? renderDistribution(rows) : '';
    hotEl.innerHTML = overviewData ? renderHotspots(rows) : '';
    wireSessionButtons(hotEl, true);
    showTab();
  }

  // Re-render the detail body in place (no refetch) after a focus/filter change.
  function paintDetailBody(): void {
    const body = detail.querySelector<HTMLElement>('#insight-detail-body');
    if (!body || !detailReport) return;
    // A full innerHTML replace recreates the scroll container, snapping the in-panel list back to
    // the top — which read as a page refresh (老滕). Preserve the active tab's list scroll (and
    // window scroll) across the re-render so toggling a 详情 drawer feels in-place.
    const sel = `.insight-tab-panel[data-panel="${detailTab}"] .spantable, .insight-tab-panel[data-panel="${detailTab}"] .turnlist, .insight-tab-panel[data-panel="${detailTab}"] .convothread`;
    const prevTop = body.querySelector<HTMLElement>(sel)?.scrollTop ?? 0;
    const winY = window.scrollY;
    body.innerHTML = renderDetailBody(detailReport, { activeId: activeRec, tab: detailTab, spanFilter, openSpans, openTurns, ledgerSort, openPrompts, rawPrompts, ledgerSender, convo });
    wireDetailBody(body);
    const next = body.querySelector<HTMLElement>(sel);
    if (next) next.scrollTop = prevTop;
    if (window.scrollY !== winY) window.scrollTo({ top: winY });
  }

  // 对话回放: fetch one page of the paginated conversation. reset=true replaces (filter/search
  // change), false appends (load-more). Filters/search go through codex's q/role/tag params.
  async function loadConvo(reset: boolean): Promise<void> {
    if (!selectedId || convo.loading) return;
    if (reset) { convo.messages = []; convo.nextOffset = 0; convo.hasMore = false; }
    convo.loading = true;
    if (detailTab === 'convo') paintDetailBody();
    const params = new URLSearchParams({ detail: 'conversation', offset: String(convo.nextOffset), limit: '40' });
    if (convo.q) params.set('q', convo.q);
    if (convo.role !== 'all') params.set('role', convo.role);
    if (convo.tag !== 'all') params.set('tag', convo.tag);
    const sid = selectedId;
    try {
      const r = await fetch(`/api/sessions/${encodeURIComponent(sid)}/insight?${params.toString()}`, { cache: 'no-store' });
      const d = await r.json().catch(() => ({}));
      if (disposed || sid !== selectedId) return;
      const c = d?.conversation;
      if (c) {
        convo.messages = reset ? (c.messages ?? []) : [...convo.messages, ...(c.messages ?? [])];
        convo.total = c.total ?? convo.messages.length;
        convo.hasMore = !!c.hasMore;
        convo.nextOffset = c.nextOffset ?? (convo.nextOffset + (c.messages?.length ?? 0));
      }
    } catch { /* leave what we have */ }
    convo.loading = false;
    if (detailTab === 'convo') paintDetailBody();
  }

  // Full-text prompt modal — lives in the persistent page shell (#insight-modal), not in the
  // re-rendered detail body. Prompt text is fetched full on demand (老滕: 弹窗别截断) via the
  // per-turn endpoint, since the bulk timeline only carries a 400-char preview.
  function paintModal(): void {
    const m = root.querySelector<HTMLElement>('#insight-modal');
    if (!m) return;
    if (modalTurn === null) { m.hidden = true; m.innerHTML = ''; document.body.classList.remove('insight-modal-open'); return; }
    m.hidden = false;
    document.body.classList.add('insight-modal-open');
    m.innerHTML = modalPrompt
      ? renderPromptModalInner(modalTurn, modalPrompt, modalRaw)
      : `<div class="modal-backdrop" data-modal-close></div><div class="modal-panel"><div class="modal-body"><p class="mut">${escapeHtml(t('insights.detailLoading'))}</p></div></div>`;
    m.querySelectorAll<HTMLElement>('[data-modal-close]').forEach(el => el.addEventListener('click', closeModal));
    m.querySelector<HTMLElement>('[data-modal-raw]')?.addEventListener('click', () => { modalRaw = !modalRaw; paintModal(); });
  }
  function closeModal(): void { modalTurn = null; modalRaw = false; modalPrompt = null; paintModal(); }
  async function openModal(turnIndex: number): Promise<void> {
    if (!selectedId) return;
    modalTurn = turnIndex; modalRaw = false; modalPrompt = null;
    const req = ++modalReq;
    const sid = selectedId;
    paintModal();
    try {
      const r = await fetch(`/api/sessions/${encodeURIComponent(sid)}/insight/turn/${turnIndex}?offset=0&limit=40000`, { cache: 'no-store' });
      const d = await r.json().catch(() => ({}));
      if (req !== modalReq || disposed) return;
      modalPrompt = (d?.turn?.prompt as TurnPromptPreview) ?? { text: '', truncated: false };
    } catch {
      if (req !== modalReq) return;
      modalPrompt = { text: t('insights.unavailable'), truncated: false };
    }
    paintModal();
  }

  function wireDetailBody(body: HTMLElement): void {
    const bar = body.querySelector<HTMLElement>('.detailtabbar');
    bar?.addEventListener('click', e => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-tab]');
      if (!btn) return;
      detailTab = (btn.dataset.tab as 'spans' | 'ledger' | 'convo') || 'spans';
      bar.querySelectorAll<HTMLButtonElement>('button[data-tab]').forEach(b => b.classList.toggle('on', b.dataset.tab === detailTab));
      body.querySelectorAll<HTMLElement>('.insight-tab-panel').forEach(p => { p.hidden = p.dataset.panel !== detailTab; });
      // 对话回放: load the first page lazily on first open.
      if (detailTab === 'convo' && !convo.messages.length && !convo.loading) void loadConvo(true);
    });
    // Recommendation cards .hot-light their evidence; clicking the active one clears.
    for (const btn of body.querySelectorAll<HTMLButtonElement>('.reclist [data-rec]')) {
      btn.addEventListener('click', () => {
        const id = btn.dataset.rec || null;
        activeRec = activeRec === id ? null : id;
        paintDetailBody();
      });
    }
    // 会话轨迹 nodes jump to that turn in the ledger: switch tab, expand it, scroll it into view.
    // Reset to linear sort + a sender filter that keeps the target turn visible (system turns are
    // hidden under the default 全部) so the jump never lands on a turn the ledger filtered away.
    for (const btn of body.querySelectorAll<HTMLButtonElement>('.turnrail [data-rail-turn]')) {
      btn.addEventListener('click', () => {
        const i = Number(btn.dataset.railTurn);
        const tn = detailReport?.turnTimeline?.find(t => t.turnIndex === i);
        detailTab = 'ledger';
        ledgerSort = 'normal';
        if (tn && turnSenderKind(tn) === 'system') ledgerSender = 'system';
        openTurns.add(i);
        paintDetailBody();
        detail.querySelector<HTMLElement>(`.insight-tab-panel[data-panel="ledger"] [data-turn-card="${i}"]`)
          ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
    }
    // 工作时序 bars open the span in the 动作 span tab (clearing any span filter that would hide it).
    for (const btn of body.querySelectorAll<HTMLButtonElement>('.gantt [data-gantt-span]')) {
      btn.addEventListener('click', () => {
        const i = Number(btn.dataset.ganttSpan);
        detailTab = 'spans';
        spanFilter = 'all';
        openSpans.add(i);
        paintDetailBody();
        detail.querySelector<HTMLElement>(`.insight-tab-panel[data-panel="spans"] .sprow-line[data-span-idx="${i}"]`)
          ?.closest<HTMLElement>('.spanrow')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
    }
    // Shared hover tooltips for the session-trace rail / work-timeline / context curve.
    const tipEl = root.querySelector<HTMLElement>('#insight-tip');
    if (tipEl) for (const host of body.querySelectorAll<HTMLElement>('.turnrail, .gtrack, .ctxcurve')) bindTip(host, tipEl);
    // span tab filter chips (全部/失败/慢/…).
    for (const btn of body.querySelectorAll<HTMLButtonElement>('.spanfilter [data-spanfilter]')) {
      btn.addEventListener('click', () => { spanFilter = btn.dataset.spanfilter || 'all'; paintDetailBody(); });
    }
    // 详情 drawer toggles — the whole span header line is the target (老滕: 点 span 行即展开).
    for (const el of body.querySelectorAll<HTMLElement>('.sprow-line[data-span-idx]')) {
      const toggle = () => {
        const i = Number(el.dataset.spanIdx);
        if (openSpans.has(i)) openSpans.delete(i); else openSpans.add(i);
        paintDetailBody();
      };
      el.addEventListener('click', toggle);
      el.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
    }
    // Per-turn expand/collapse in the timeline.
    for (const btn of body.querySelectorAll<HTMLButtonElement>('.turn-expand-btn[data-turn]')) {
      btn.addEventListener('click', () => {
        const i = Number(btn.dataset.turn);
        if (openTurns.has(i)) openTurns.delete(i); else openTurns.add(i);
        paintDetailBody();
      });
    }
    // 逐轮对账 sort toggle (正常排序 / 按建议分类).
    for (const btn of body.querySelectorAll<HTMLButtonElement>('.ledgersort [data-ledgersort]')) {
      btn.addEventListener('click', () => { ledgerSort = btn.dataset.ledgersort === 'grouped' ? 'grouped' : 'normal'; paintDetailBody(); });
    }
    // 逐轮对账 发起人 filter (全部 / 人类 / a2a / 其他).
    for (const btn of body.querySelectorAll<HTMLButtonElement>('.ledgersender [data-ledgersender]')) {
      btn.addEventListener('click', () => { ledgerSender = (btn.dataset.ledgersender as LedgerSender) || 'all'; paintDetailBody(); });
    }
    // Prompt 展开/收起 + 渲染/原文 toggles per turn.
    for (const btn of body.querySelectorAll<HTMLButtonElement>('.tp-toggle[data-prompt-expand]')) {
      btn.addEventListener('click', () => {
        const i = Number(btn.dataset.promptExpand);
        if (openPrompts.has(i)) openPrompts.delete(i); else openPrompts.add(i);
        paintDetailBody();
      });
    }
    for (const btn of body.querySelectorAll<HTMLButtonElement>('.tp-toggle[data-prompt-raw]')) {
      btn.addEventListener('click', () => {
        const i = Number(btn.dataset.promptRaw);
        if (rawPrompts.has(i)) rawPrompts.delete(i); else rawPrompts.add(i);
        paintDetailBody();
      });
    }
    // Prompt 全文弹窗 (老滕: 做个弹窗看全文) — fetches the full text on demand.
    for (const btn of body.querySelectorAll<HTMLButtonElement>('.tp-toggle[data-prompt-full]')) {
      btn.addEventListener('click', () => void openModal(Number(btn.dataset.promptFull)));
    }
    // 对话回放 controls + bubbles.
    const convoSearch = body.querySelector<HTMLInputElement>('.convo-search');
    convoSearch?.addEventListener('keydown', e => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const v = convoSearch.value.trim();
      if (v === convo.q) return;
      convo.q = v;
      void loadConvo(true);
    });
    for (const btn of body.querySelectorAll<HTMLButtonElement>('.convo-rolefilter [data-convo-role]')) {
      btn.addEventListener('click', () => { const k = btn.dataset.convoRole || 'all'; if (k === convo.role) return; convo.role = k; void loadConvo(true); });
    }
    for (const btn of body.querySelectorAll<HTMLButtonElement>('.convo-tagfilter [data-convo-tag]')) {
      btn.addEventListener('click', () => { const k = btn.dataset.convoTag || 'all'; if (k === convo.tag) return; convo.tag = k; void loadConvo(true); });
    }
    body.querySelector<HTMLButtonElement>('.convo-loadmore')?.addEventListener('click', () => void loadConvo(false));
    for (const btn of body.querySelectorAll<HTMLButtonElement>('.cbub [data-convo-full]')) {
      btn.addEventListener('click', () => void openModal(Number(btn.dataset.convoFull)));
    }
    for (const el of body.querySelectorAll<HTMLElement>('.cop-line[data-convo-op]')) {
      const toggle = () => { const id = el.dataset.convoOp!; if (convo.openOps.has(id)) convo.openOps.delete(id); else convo.openOps.add(id); paintDetailBody(); };
      el.addEventListener('click', toggle);
      el.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
    }
  }

  async function selectSession(sessionId: string): Promise<void> {
    selectedId = sessionId;
    showSessionsView();
    activeRec = null;
    detailTab = 'spans';
    spanFilter = 'all';
    openSpans = new Set<number>();
    openTurns = new Set<number>();
    ledgerSort = 'normal';
    ledgerSender = 'all';
    openPrompts = new Set<number>();
    rawPrompts = new Set<number>();
    convo = newConvo();
    modalTurn = null;
    modalRaw = false;
    modalPrompt = null;
    paintModal();
    detailReport = null;
    const rec = records.find(r => r.session.sessionId === sessionId);
    detail.innerHTML = renderDetailShell(rec);
    for (const btn of list.querySelectorAll<HTMLButtonElement>('[data-session-id]')) {
      btn.classList.toggle('on', btn.dataset.sessionId === sessionId);
    }
    const body = detail.querySelector<HTMLElement>('#insight-detail-body');
    if (!body) return;
    try {
      const report = await fetchDetail(sessionId);
      if (!disposed && report) {
        detailReport = report;
        paintDetailBody();
      }
    } catch (e) {
      if (!disposed) body.innerHTML = `<p class="mut">${escapeHtml(String(e))}</p>`;
    }
  }

  async function refresh(): Promise<void> {
    refreshBtn.disabled = true;
    status.textContent = t('insights.loading');
    try {
      const r = await fetch('/api/insights/summary?limit=200', { cache: 'no-store' });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || d?.ok === false || !d.overview) {
        overviewData = null;
        records = [];
        status.textContent = `${t('insights.unavailable')}: ${String(d?.error ?? r.status)}`;
      } else {
        overviewData = d.overview as SafeInsightOverview;
        records = overviewData.sessions.map(toRecord);
        status.textContent = t('insights.loaded', { count: overviewData.meta.analyzedSessions });
      }
    } catch (e) {
      overviewData = null;
      records = [];
      status.textContent = `${t('insights.unavailable')}: ${String(e)}`;
    }
    if (disposed) return;
    if (selectedId && !records.some(r => r.session.sessionId === selectedId)) selectedId = null;
    paint();
    refreshBtn.disabled = false;
  }

  search.oninput = () => { q = search.value; paint(); };
  refreshBtn.onclick = () => void refresh();
  tabbar.addEventListener('click', e => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-itab]');
    if (!btn) return;
    tab = (btn.dataset.itab as InsightTab) || 'overview';
    paint();
  });
  backBtn.addEventListener('click', () => { selectedId = null; showSessionsView(); paint(); });
  sortBar.addEventListener('click', e => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-sesssort]');
    if (!btn) return;
    sessSort = (btn.dataset.sesssort as SessSort) || 'recent';
    paint();
  });
  projectSel.addEventListener('change', () => { project = projectSel.value; paint(); });
  timeSel.addEventListener('change', () => { timeWin = timeSel.value; paint(); });
  noiseToggle.addEventListener('change', () => { showNoise = noiseToggle.checked; paint(); });
  clearBtn.addEventListener('click', () => {
    q = ''; search.value = ''; filter = 'all'; cliFilter.clear();
    project = ''; timeWin = 'all'; showNoise = false;
    paint();
  });
  for (const btn of filterButtons) {
    btn.onclick = () => {
      filter = (btn.dataset.filter as InsightFilter) || 'all';
      paint();
    };
  }
  cliFilterEl.addEventListener('click', e => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-clifilter]');
    if (!btn) return;
    const key = btn.dataset.clifilter || 'all';
    if (key === 'all') cliFilter.clear();
    else if (cliFilter.has(key)) cliFilter.delete(key);
    else cliFilter.add(key);
    paint();
  });

  // Esc closes the full-text prompt modal.
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && modalTurn !== null) closeModal(); };
  document.addEventListener('keydown', onKey);

  void loadNameMaps().then(() => { if (!disposed) paint(); });
  void refresh();

  return () => { disposed = true; document.removeEventListener('keydown', onKey); document.body.classList.remove('insight-modal-open'); };
}
