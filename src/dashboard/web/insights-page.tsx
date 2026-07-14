import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type {
  DiagnosticRecommendation,
  InsightConversationMessage,
  SafeInsightOverview,
  SafeInsightReport,
  SafeSpan,
  SafeSpanTag,
  TurnPromptPreview,
  TurnTimelineEvent,
  TurnTimelineTurn,
} from '../../services/insight/types.js';
import { useT } from './react-hooks.js';
import { mountReactPage, type PageDisposer } from './react-mount.js';
import { botDisplayName, loadNameMaps, relTime, t } from './ui.js';
import { DropdownMenu, LoadingState, RefreshIconButton } from './dashboard-components.js';
import {
  BAD_RESULTS,
  CONVO_ROLES,
  CONVO_TAGS,
  FLOW_PHASES,
  INSIGHT_FILTERS,
  INSIGHT_TABS,
  SESS_SORT_KEYS,
  SESS_SORTS,
  SEVERITY_RANK,
  SPAN_TAGS,
  TIME_WINDOWS,
  agentMsOf,
  aggregateRecords,
  buildInsightScope,
  buildInsightsHash,
  cleanPromptText,
  cliIdOf,
  cliCounts,
  fetchInsightConversation,
  fetchInsightDetail,
  fetchInsightsSummary,
  fetchTurnPrompt,
  filterRecords,
  fmtInt,
  fmtMs,
  focusSets,
  groupConvo,
  idText,
  initialInsightTab,
  intentPhrase,
  intentText,
  intentTextOf,
  median,
  newConvoState,
  okReports,
  parseInsightsHash,
  phaseClass,
  phaseLabel,
  phaseSlug,
  projectOf,
  projectOptions,
  promptMarkdownHtml,
  reportNeedsReview,
  resultLabel,
  safeStatus,
  sessionMetaLine,
  sessionTitle,
  severityLabel,
  sortRecordsBy,
  spanFailed,
  statusIcon,
  structLabel,
  suggestionTitle,
  tagLabel,
  toRecord,
  turnAdvice,
  turnHeadline,
  turnMainPhase,
  turnSenderKind,
  type ConvoState,
  type DetailTab,
  type DetailView,
  type DerivedOverview,
  type HotAgg,
  type InsightFilter,
  type InsightRecord,
  type InsightTab,
  type LedgerSender,
  type SessSort,
} from './insights.js';

type ModalState = { turnIndex: number | null; raw: boolean; prompt: TurnPromptPreview | null; loading: boolean };
type PaletteAnchor = { top: number; left: number; width: number; maxHeight: number };
type PaletteState = { open: boolean; q: string; idx: number; anchor?: PaletteAnchor };
type ScrollTarget = { kind: 'span'; index: number } | { kind: 'turn'; index: number } | null;
type TooltipState = { text: string; x: number; y: number; visible: boolean };
const CLI_FILTER_ALL = '__all__';

function clamp(n: number, min: number, max: number): number {
  return Math.min(Math.max(n, min), max);
}

function paletteAnchorFromButton(button: HTMLElement): PaletteAnchor {
  const rect = button.getBoundingClientRect();
  const margin = 12;
  const width = Math.min(420, Math.max(280, window.innerWidth - margin * 2));
  const left = clamp(
    Math.round(rect.left + rect.width / 2 - width / 2),
    margin,
    Math.max(margin, window.innerWidth - width - margin),
  );
  const naturalTop = Math.round(rect.bottom + 8);
  const top = clamp(naturalTop, margin, Math.max(margin, window.innerHeight - 132));
  const maxHeight = Math.max(140, Math.floor(window.innerHeight - top - margin));
  return { top, left, width, maxHeight };
}

function toggleSet<T>(set: Set<T>, value: T): Set<T> {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

function addToSet<T>(set: Set<T>, value: T): Set<T> {
  const next = new Set(set);
  next.add(value);
  return next;
}

function MarkdownBody({ text, className = 'md-body' }: { text: string; className?: string }) {
  return <div className={className} dangerouslySetInnerHTML={{ __html: promptMarkdownHtml(text) }} />;
}

function Tooltip({ tip }: { tip: TooltipState }) {
  return (
    <div
      id="insight-tip"
      className="ins-tip"
      role="tooltip"
      hidden={!tip.visible}
      style={{ left: tip.x, top: tip.y }}
    >
      {tip.text}
    </div>
  );
}

function MetricCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="card">
      <div className="cv">{value}</div>
      <div className="cl">{label}</div>
      {sub ? <div className="cs">{sub}</div> : null}
    </div>
  );
}

function DisclosureNote() {
  return <p className="insight-disclosure">⚖︎ {t('insights.disclosure')}</p>;
}

function PhaseMixBar({ phase }: { phase: Record<string, { count: number; ms: number }> | undefined }) {
  const entries = Object.entries(phase ?? {}).filter(([, v]) => v.count > 0 || v.ms > 0);
  if (!entries.length) return null;
  return (
    <div className="mph">
      {entries.map(([ph, v]) => {
        const weight = Math.max(1, v.ms || v.count);
        return (
          <i
            key={ph}
            className={phaseClass(ph)}
            style={{ flex: weight }}
            title={`${phaseLabel(ph)} · ${v.count} · ${fmtMs(v.ms)}`}
          />
        );
      })}
    </div>
  );
}

function InsightTabs({ active, onChange }: { active: InsightTab; onChange: (tab: InsightTab) => void }) {
  return (
    <div className="insight-tabs" role="tablist">
      {INSIGHT_TABS.map(tb => (
        <button
          key={tb.key}
          type="button"
          className={`itab${tb.key === active ? ' on' : ''}`}
          role="tab"
          aria-selected={tb.key === active}
          onClick={() => onChange(tb.key)}
        >
          {t(tb.label)}
        </button>
      ))}
    </div>
  );
}

function OverviewContent({ data }: { data: DerivedOverview }) {
  const a = data.agg;
  const rw = a.readWriteRatio === null ? '-' : a.readWriteRatio.toFixed(1);
  const topTools = data.topFailedTools.slice(0, 5);
  const topSuggestions = [...data.suggestions]
    .sort((x, y) => SEVERITY_RANK[x.severity] - SEVERITY_RANK[y.severity] || y.count - x.count)
    .slice(0, 6);

  return (
    <>
      <div className="cards insights-metrics">
        <MetricCard label={t('insights.metricSessions')} value={fmtInt(data.totalCount)} sub={t('insights.metricAnalyzed', { count: data.analyzedCount })} />
        <MetricCard label={t('insights.metricSpans')} value={fmtInt(a.totalSpans)} sub={t('insights.metricSafe')} />
        <MetricCard label={t('insights.metricFailed')} value={fmtInt(a.failedSpans)} sub={topTools[0] ? `${topTools[0].tool} ×${topTools[0].count}` : ''} />
        <MetricCard label={t('insights.metricSlow')} value={fmtInt(a.slowSpans)} />
        <MetricCard label={t('insights.metricRw')} value={rw} sub={t('insights.metricCompactions', { count: a.compactions })} />
      </div>
      <div className="insights-overview-grid">
        <section className="block recblock">
          <h3>{t('insights.recommendations')}</h3>
          <div className="reclist">
            {topSuggestions.length ? topSuggestions.map(item => (
              <div key={item.id} className={`rec ${item.severity}`}>
                <div className="rectop"><b>{suggestionTitle(item)}</b><span>{severityLabel(item.severity)}</span></div>
                <div className="recev">{t('insights.seenInSessions', { count: item.count })}</div>
              </div>
            )) : <p className="mut">{t('insights.noRecommendations')}</p>}
          </div>
        </section>
        <section className="block">
          <h3>{t('insights.toolFailures')}</h3>
          <HBarList rows={topTools.map(tt => ({ key: tt.tool, label: tt.tool, count: tt.count }))} empty={t('insights.noFailures')} />
        </section>
      </div>
      <DisclosureNote />
    </>
  );
}

function HBarList({ rows, empty, renderValue, onRowClick }: {
  rows: Array<{ key: string; label: string; count: number; sub?: ReactNode }>;
  empty: string;
  renderValue?: (row: { key: string; label: string; count: number; sub?: ReactNode }) => ReactNode;
  onRowClick?: (row: { key: string; label: string; count: number; sub?: ReactNode }) => void;
}) {
  if (!rows.length) return <div className="hbars"><p className="mut">{empty}</p></div>;
  const max = Math.max(1, ...rows.map(r => r.count));
  return (
    <div className="hbars">
      {rows.map(row => {
        const pct = Math.max(row.count ? 4 : 0, Math.round((row.count / max) * 100));
        const content = (
          <>
            <div className="hblabel" title={row.label}>{row.label}</div>
            <div className="hbtrack"><div className="hbfill" style={{ width: `${pct}%` }} /></div>
            <div className="hbval">{renderValue ? renderValue(row) : fmtInt(row.count)}{row.sub}</div>
          </>
        );
        return onRowClick ? (
          <button key={row.key} type="button" className="hbrow hbrow-click" onClick={() => onRowClick(row)}>{content}</button>
        ) : (
          <div key={row.key} className="hbrow">{content}</div>
        );
      })}
    </div>
  );
}

function Trend({ records }: { records: InsightRecord[] }) {
  const days = 28;
  const dayMs = 86400000;
  const now = Date.now();
  const counts = new Array(days).fill(0) as number[];
  for (const rec of records) {
    const ts = Number(rec.session.lastMessageAt ?? 0);
    if (!ts) continue;
    const age = Math.floor((now - ts) / dayMs);
    if (age >= 0 && age < days) counts[days - 1 - age] += 1;
  }
  const total = counts.reduce((a, b) => a + b, 0);
  if (!total) return null;
  const max = Math.max(1, ...counts);
  return (
    <section className="block trend-block">
      <div className="ihist-head"><h3>{t('insights.distTrend')}</h3><span className="mut">{t('insights.distTrendSub')} · {total}</span></div>
      <div className="trend">
        {counts.map((c, j) => {
          const d = new Date(now - (days - 1 - j) * dayMs);
          const label = `${d.getMonth() + 1}-${d.getDate()} · ${c}`;
          return <i key={j} className="trendbar" style={{ height: `${c ? Math.max(8, Math.round((c / max) * 100)) : 2}%` }} title={label} />;
        })}
      </div>
    </section>
  );
}

function Histogram({ title, values, bins, fmtMedian = fmtInt, sortKey, onSort }: {
  title: string;
  values: number[];
  bins: Array<{ label: string; test: (v: number) => boolean }>;
  fmtMedian?: (n: number) => string;
  sortKey?: SessSort;
  onSort?: (sort: SessSort) => void;
}) {
  const counts = bins.map(b => ({ label: b.label, count: values.filter(b.test).length }));
  const max = Math.max(1, ...counts.map(c => c.count));
  const total = Math.max(1, values.length);
  return (
    <section className="block ihist">
      <div className="ihist-head">
        <h3>{title}</h3>
        <span className="mut">{t('insights.distMedian', { v: fmtMedian(median(values)) })}</span>
        {sortKey ? <button type="button" className="ihist-jump" onClick={() => onSort?.(sortKey)}>{t('insights.viewSessions')} ›</button> : null}
      </div>
      <div className="hbars">
        {counts.map(c => {
          const pct = Math.max(c.count ? 4 : 0, Math.round((c.count / max) * 100));
          const share = Math.round((c.count / total) * 100);
          return (
            <div key={c.label} className="hbrow">
              <div className="hblabel">{c.label}</div>
              <div className="hbtrack"><div className="hbfill" style={{ width: `${pct}%` }} /></div>
              <div className="hbval">{fmtInt(c.count)}<small>{share}%</small></div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function Distribution({ records, onSort }: { records: InsightRecord[]; onSort: (sort: SessSort) => void }) {
  const reports = okReports(records);
  if (!reports.length) return <div className="insight-empty">{t('insights.distEmpty')}</div>;
  const churn = reports.map(r => (r.hot?.files ?? []).reduce((s, f) => s + (f.added ?? 0) + (f.removed ?? 0), 0));
  const spans = reports.map(r => r.agg.totalSpans);
  const failed = reports.map(r => r.agg.failedSpans);
  const slow = reports.map(r => r.agg.slowSpans);
  const agentMin = reports.map(r => agentMsOf(r) / 60000);
  const rw = reports.map(r => r.agg.readWriteRatio).filter((v): v is number => v !== null && Number.isFinite(v));
  return (
    <>
      <p className="mut ins-hint">{t('insights.distHint')}</p>
      <div className="ihist-grid">
        <Trend records={records} />
        <Histogram title={t('insights.distSpans')} values={spans} onSort={onSort} sortKey="spans" bins={[
          { label: '0-10', test: v => v <= 10 },
          { label: '11-50', test: v => v > 10 && v <= 50 },
          { label: '51-200', test: v => v > 50 && v <= 200 },
          { label: '201-500', test: v => v > 200 && v <= 500 },
          { label: '500+', test: v => v > 500 },
        ]} />
        <Histogram title={t('insights.distFailed')} values={failed} onSort={onSort} sortKey="fails" bins={[
          { label: '0', test: v => v === 0 },
          { label: '1-2', test: v => v >= 1 && v <= 2 },
          { label: '3-5', test: v => v >= 3 && v <= 5 },
          { label: '6-10', test: v => v >= 6 && v <= 10 },
          { label: '10+', test: v => v > 10 },
        ]} />
        <Histogram title={t('insights.distSlow')} values={slow} onSort={onSort} sortKey="slow" bins={[
          { label: '0', test: v => v === 0 },
          { label: '1-2', test: v => v >= 1 && v <= 2 },
          { label: '3-5', test: v => v >= 3 && v <= 5 },
          { label: '5+', test: v => v > 5 },
        ]} />
        <Histogram title={t('insights.distAgentTime')} values={agentMin} onSort={onSort} sortKey="agent" fmtMedian={n => `${Math.round(n)}m`} bins={[
          { label: '<1m', test: v => v < 1 },
          { label: '1-5m', test: v => v >= 1 && v < 5 },
          { label: '5-30m', test: v => v >= 5 && v < 30 },
          { label: '30m-2h', test: v => v >= 30 && v < 120 },
          { label: '2h+', test: v => v >= 120 },
        ]} />
        {rw.length ? (
          <Histogram title={t('insights.distRw')} values={rw} fmtMedian={n => n.toFixed(1)} bins={[
            { label: '0', test: v => v === 0 },
            { label: '0-1', test: v => v > 0 && v < 1 },
            { label: '1-3', test: v => v >= 1 && v < 3 },
            { label: '3+', test: v => v >= 3 },
          ]} />
        ) : null}
        <Histogram title={t('insights.distChurn')} values={churn} bins={[
          { label: '0', test: v => v === 0 },
          { label: '1-100', test: v => v > 0 && v <= 100 },
          { label: '100-1k', test: v => v > 100 && v <= 1000 },
          { label: '1k-10k', test: v => v > 1000 && v <= 10000 },
          { label: '10k+', test: v => v > 10000 },
        ]} />
      </div>
      <DisclosureNote />
    </>
  );
}

function Flow({ records, onSession }: { records: InsightRecord[]; onSession: (id: string) => void }) {
  const ok = records.filter(r => r.report && r.report.status === 'ok' && r.report.agg);
  if (!ok.length) return <div className="insight-empty">{t('insights.distEmpty')}</div>;
  const tot: Record<string, { count: number; ms: number }> = {};
  for (const p of FLOW_PHASES) tot[p] = { count: 0, ms: 0 };
  for (const rec of ok) for (const p of FLOW_PHASES) {
    const v = rec.report!.agg.phase?.[p];
    if (v) {
      tot[p].count += v.count;
      tot[p].ms += v.ms;
    }
  }
  const totCount = FLOW_PHASES.reduce((s, p) => s + tot[p].count, 0) || 1;
  const totMs = FLOW_PHASES.reduce((s, p) => s + tot[p].ms, 0) || 1;
  const rhythm = [...ok].sort((a, b) => agentMsOf(b.report!) - agentMsOf(a.report!)).slice(0, 40);
  return (
    <>
      <p className="mut ins-hint">{t('insights.flowHint')}</p>
      <section className="block flow-pipe-block">
        <h3>{t('insights.flowPipeline')}</h3>
        <p className="mut flow-sub">{t('insights.flowPipeSub')}</p>
        <div className="flow-pipe">
          {FLOW_PHASES.map((p, i) => {
            const v = tot[p];
            const cPct = Math.round((v.count / totCount) * 100);
            const tPct = Math.round((v.ms / totMs) * 100);
            return (
              <span key={p} style={{ display: 'contents' }}>
                <div className="flow-node">
                  <i className={`flow-dot ${phaseClass(p)}`} />
                  <strong>{phaseLabel(p)}</strong>
                  <span className="flow-n">{fmtInt(v.count)}<em> · {cPct}%</em></span>
                  <span className="flow-t">{fmtMs(v.ms)}<em> · {tPct}%</em></span>
                </div>
                {i < FLOW_PHASES.length - 1 ? <span className="flow-arrow">→</span> : null}
              </span>
            );
          })}
        </div>
      </section>
      <div className="insights-overview-grid">
        <section className="block">
          <h3>{t('insights.flowShares')}</h3>
          <div className="flow-bhead"><span /><span>{t('insights.flowActShare')}</span><span>{t('insights.flowTimeShare')}</span></div>
          <div className="flow-bars">
            {FLOW_PHASES.map(p => {
              const v = tot[p];
              const cPct = (v.count / totCount) * 100;
              const tPct = (v.ms / totMs) * 100;
              return (
                <div key={p} className="flow-brow">
                  <span className="flow-blabel"><i className={phaseClass(p)} />{phaseLabel(p)}</span>
                  <span className="flow-btrack"><span className={`flow-bfill ${phaseClass(p)}`} style={{ width: `${Math.max(2, cPct).toFixed(1)}%` }} /><em>{Math.round(cPct)}%</em></span>
                  <span className="flow-btrack"><span className={`flow-bfill ${phaseClass(p)}`} style={{ width: `${Math.max(2, tPct).toFixed(1)}%` }} /><em>{Math.round(tPct)}%</em></span>
                </div>
              );
            })}
          </div>
        </section>
        <section className="block">
          <h3>{t('insights.flowRhythm')}</h3>
          <div className="flow-rhythm">
            {rhythm.map(rec => (
              <button key={String(rec.session.sessionId)} type="button" className="flow-sess" onClick={() => onSession(String(rec.session.sessionId))}>
                <span className="flow-stitle">{sessionTitle(rec.session)}</span>
                <PhaseMixBar phase={rec.report!.agg.phase} />
                <span className="flow-stime">{fmtMs(agentMsOf(rec.report!))}</span>
              </button>
            ))}
          </div>
          <div className="rl-legend">{FLOW_PHASES.map(p => <span key={p} className="rl-item"><i className={phaseClass(p)} />{phaseLabel(p)}</span>)}</div>
        </section>
      </div>
      <DisclosureNote />
    </>
  );
}

function Hotspots({ records, openHot, onToggleHot, onProject, onSession }: {
  records: InsightRecord[];
  openHot: Set<string>;
  onToggleHot: (key: string) => void;
  onProject: (project: string) => void;
  onSession: (id: string) => void;
}) {
  const reports = records.filter(r => !!r.report && r.report.status === 'ok');
  if (!reports.length) return <div className="insight-empty">{t('insights.distEmpty')}</div>;
  const fileAgg = new Map<string, HotAgg>();
  const cmdAgg = new Map<string, HotAgg>();
  const errAgg = new Map<string, HotAgg>();
  const bump = (m: Map<string, HotAgg>, key: string, label: string, sid: string, title: string): HotAgg => {
    let h = m.get(key);
    if (!h) {
      h = { key, label, sessions: [], reads: 0, edits: 0, runs: 0, fails: 0, count: 0 };
      m.set(key, h);
    }
    if (!h.sessions.some(s => s.id === sid)) h.sessions.push({ id: sid, title });
    return h;
  };
  for (const rec of reports) {
    const sid = String(rec.session.sessionId);
    const title = sessionTitle(rec.session);
    const hot = rec.report!.hot;
    for (const f of hot?.files ?? []) {
      const h = bump(fileAgg, `file:${f.path}`, f.path, sid, title);
      h.reads += f.reads;
      h.edits += f.edits;
    }
    for (const c of hot?.cmds ?? []) {
      const h = bump(cmdAgg, `cmd:${c.cmd}`, c.cmd, sid, title);
      h.runs += c.runs;
      h.fails += c.fails;
    }
    for (const e of hot?.errs ?? []) {
      const h = bump(errAgg, `err:${e.tool} ${e.result}`, `${e.tool} · ${resultLabel(e.result)}`, sid, title);
      h.count += e.count;
    }
  }
  const recur = (a: HotAgg, b: HotAgg) => b.sessions.length - a.sessions.length;
  const files = [...fileAgg.values()].sort((a, b) => recur(a, b) || (b.edits + b.reads) - (a.edits + a.reads)).slice(0, 12);
  const cmds = [...cmdAgg.values()].sort((a, b) => recur(a, b) || b.fails - a.fails || b.runs - a.runs).slice(0, 12);
  const errs = [...errAgg.values()].sort((a, b) => recur(a, b) || b.count - a.count).slice(0, 10);
  const projMap = new Map<string, { sessions: number; fails: number }>();
  for (const rec of reports) {
    const p = projectOf(rec);
    if (!p) continue;
    const e = projMap.get(p) ?? { sessions: 0, fails: 0 };
    e.sessions += 1;
    e.fails += rec.report!.agg.failedSpans;
    projMap.set(p, e);
  }
  const projects = [...projMap.entries()].map(([id, v]) => ({ id, ...v })).sort((a, b) => b.fails - a.fails || b.sessions - a.sessions).slice(0, 10);
  const projRows = projects.map(x => ({ key: x.id, label: x.id, count: x.sessions, sub: <small>{x.fails} {t('insights.hotFailsCol')}</small> }));
  const slowSessions = [...reports].filter(r => r.report!.agg.slowSpans > 0).sort((a, b) => b.report!.agg.slowSpans - a.report!.agg.slowSpans).slice(0, 8);

  return (
    <>
      <p className="mut ins-hint">{t('insights.hotHint')}</p>
      <div className="hot-grid">
        <HotBlock title={t('insights.hotFiles')} rows={files} openHot={openHot} onToggle={onToggleHot} onSession={onSession} meta={h => `${t('insights.readsShort')}${h.reads} · ${t('insights.editsShort')}${h.edits}`} />
        <HotBlock title={t('insights.hotCommands')} rows={cmds} openHot={openHot} onToggle={onToggleHot} onSession={onSession} meta={h => <>{h.runs}×{h.fails ? <> · <span className="bad">{h.fails} {t('insights.hotFailsCol')}</span></> : null}</>} />
        <HotBlock title={t('insights.hotErrors')} rows={errs} openHot={openHot} onToggle={onToggleHot} onSession={onSession} meta={h => `${h.count}×`} />
        <section className="block">
          <h3>{t('insights.hotProjects')}</h3>
          <HBarList rows={projRows} empty="-" onRowClick={row => onProject(row.key)} renderValue={row => fmtInt(row.count)} />
        </section>
        <section className="block hot-sessions">
          <h3>{t('insights.hotSlowSessions')}</h3>
          <div className="slist">
            {slowSessions.length ? slowSessions.map(rec => {
              const a = rec.report!.agg;
              return (
                <button key={String(rec.session.sessionId)} type="button" className="srow" onClick={() => onSession(String(rec.session.sessionId))}>
                  <div className="srmain">
                    <strong>{sessionTitle(rec.session)}</strong>
                    <small>{botDisplayName(rec.session)} · {String(rec.session.cliId ?? '-')}</small>
                  </div>
                  <div className="srstats"><b>{t('insights.hotSlowCol')}<em>{fmtInt(a.slowSpans)}</em></b><b>span<em>{fmtInt(a.totalSpans)}</em></b></div>
                </button>
              );
            }) : <p className="mut">-</p>}
          </div>
        </section>
      </div>
    </>
  );
}

function HotBlock({ title, rows, openHot, onToggle, onSession, meta }: {
  title: string;
  rows: HotAgg[];
  openHot: Set<string>;
  onToggle: (key: string) => void;
  onSession: (id: string) => void;
  meta: (h: HotAgg) => ReactNode;
}) {
  return (
    <section className="block">
      <h3>{title}</h3>
      <div className="hotlist">
        {rows.length ? rows.map(h => {
          const open = openHot.has(h.key);
          return (
            <div key={h.key} className={`hotitem${open ? ' open' : ''}`}>
              <button type="button" className="hotrow" aria-expanded={open} onClick={() => onToggle(h.key)}>
                <span className="hotlabel" title={h.label}>{h.label}</span>
                <span className="hotmeta">{meta(h)}</span>
                <span className="hotses">{h.sessions.length} {t('insights.hotSessionsCol')}</span>
              </button>
              {open ? (
                <div className="hot-sess">
                  {h.sessions.map(s => <button key={s.id} type="button" className="hot-sesslink" onClick={() => onSession(s.id)}>{s.title || s.id}</button>)}
                </div>
              ) : null}
            </div>
          );
        }) : <p className="mut">-</p>}
      </div>
    </section>
  );
}

function SortBar({ sort, layout, onSort, onLayout }: { sort: SessSort; layout: 'card' | 'table'; onSort: (sort: SessSort) => void; onLayout: (layout: 'card' | 'table') => void }) {
  const sortOptions = SESS_SORTS.map(s => ({ value: s.key, label: t(s.label) }));
  const sortLabel = sortOptions.find(option => option.value === sort)?.label ?? t('insights.sortLabel');
  return (
    <>
      <DropdownMenu
        id="insight-session-sort"
        className="insight-sort-menu"
        ariaLabel={t('insights.sortLabel')}
        label={sortLabel}
        value={sort}
        options={sortOptions}
        onChange={onSort}
      />
      <div className="insight-layout-switch" role="group" aria-label={`${t('insights.layoutCard')} / ${t('insights.layoutTable')}`}>
        {([
          ['card', 'insights.layoutCard'],
          ['table', 'insights.layoutTable'],
        ] as const).map(([k, lbl]) => (
          <button
            key={k}
            type="button"
            className={layout === k ? 'active' : ''}
            aria-pressed={layout === k}
            onClick={() => onLayout(k)}
          >
            {t(lbl)}
          </button>
        ))}
      </div>
    </>
  );
}

function SessionRows({ records, selectedId, wide, onSelect, emptyHint }: {
  records: InsightRecord[];
  selectedId: string | null;
  wide?: boolean;
  onSelect: (id: string) => void;
  emptyHint?: string;
}) {
  if (!records.length) {
    return (
      <div className="insight-empty">
        {t('insights.empty')}
        {emptyHint ? <><br /><span className="mut">{emptyHint}</span></> : null}
      </div>
    );
  }
  const stat = (label: string, val: string, bad = false) => <b className={bad ? 'bad' : undefined}>{label}<em>{val}</em></b>;
  return (
    <div className={`slist${wide ? ' wide' : ''}`}>
      {records.map(rec => {
        const s = rec.session;
        const r = rec.report;
        const ok = r?.status === 'ok';
        const agg = r?.agg;
        const reads = agg?.phase?.research?.count ?? 0;
        const edits = agg?.phase?.edit?.count ?? 0;
        return (
          <button
            key={String(s.sessionId)}
            type="button"
            className={`srow${s.sessionId === selectedId ? ' on' : ''}${reportNeedsReview(r) ? ' review' : ''}`}
            onClick={() => onSelect(String(s.sessionId))}
          >
            <div className="srmain">
              <strong>{sessionTitle(s)}</strong>
              <small>{sessionMetaLine(rec)}</small>
              {ok ? <PhaseMixBar phase={r!.agg.phase} /> : null}
            </div>
            {ok ? (
              <div className="srstats">
                {stat(t('insights.spansShort'), fmtInt(agg!.totalSpans))}
                {stat(t('insights.failedShort'), fmtInt(agg!.failedSpans), agg!.failedSpans > 0)}
                {stat(t('insights.slowShort'), fmtInt(agg!.slowSpans))}
                {wide ? <>{stat(t('insights.readsShort'), fmtInt(reads))}{stat(t('insights.editsShort'), fmtInt(edits))}{stat(t('insights.durShort'), fmtMs(agentMsOf(r!)))}</> : null}
                {stat(t('insights.rwShort'), agg!.readWriteRatio !== null ? agg!.readWriteRatio.toFixed(1) : '-')}
              </div>
            ) : <div className="srmsg">{safeStatus(r, rec.error)}</div>}
          </button>
        );
      })}
    </div>
  );
}

function SessionTable({ records, selectedId, onSelect, emptyHint }: { records: InsightRecord[]; selectedId: string | null; onSelect: (id: string) => void; emptyHint?: string }) {
  if (!records.length) {
    return (
      <div className="insight-empty">
        {t('insights.empty')}
        {emptyHint ? <><br /><span className="mut">{emptyHint}</span></> : null}
      </div>
    );
  }
  return (
    <div className="stable">
      <div className="strow sthead">
        <span className="stc-title">{t('insights.colTitle')}</span>
        <span className="stc-proj">{t('insights.colProject')}</span>
        <span className="stc-num">{t('insights.spansShort')}</span>
        <span className="stc-num">{t('insights.failedShort')}</span>
        <span className="stc-num">{t('insights.slowShort')}</span>
        <span className="stc-num">{t('insights.rwShort')}</span>
        <span className="stc-num">{t('insights.durShort')}</span>
        <span className="stc-num">{t('insights.colTime')}</span>
      </div>
      {records.map(rec => {
        const s = rec.session;
        const r = rec.report;
        const ok = r?.status === 'ok';
        const agg = r?.agg;
        return (
          <button
            key={String(s.sessionId)}
            type="button"
            className={`strow${s.sessionId === selectedId ? ' on' : ''}${reportNeedsReview(r) ? ' review' : ''}${ok ? '' : ' nostat'}`}
            onClick={() => onSelect(String(s.sessionId))}
          >
            <span className="stc-title"><strong>{sessionTitle(s)}</strong><small>{botDisplayName(s)} · {String(s.cliId ?? '-')}</small></span>
            <span className="stc-proj">{s.workingDir ? projectOf(rec) : '-'}</span>
            {ok ? (
              <>
                <span className="stc-num">{fmtInt(agg!.totalSpans)}</span>
                <span className={`stc-num${agg!.failedSpans ? ' bad' : ''}`}>{fmtInt(agg!.failedSpans)}</span>
                <span className="stc-num">{fmtInt(agg!.slowSpans)}</span>
                <span className="stc-num">{agg!.readWriteRatio !== null ? agg!.readWriteRatio.toFixed(1) : '-'}</span>
                <span className="stc-num">{fmtMs(agentMsOf(r!))}</span>
              </>
            ) : <span className="stc-msg">{safeStatus(r, rec.error)}</span>}
            <span className="stc-num stc-time">{relTime(s.lastMessageAt ?? s.spawnedAt ?? 0)}</span>
          </button>
        );
      })}
    </div>
  );
}

function TextPreview({ label, preview }: { label: string; preview?: { text: string; truncated: boolean } }) {
  if (!preview?.text) return null;
  return (
    <div className="span-io">
      <span className="span-io-label">{label}</span>
      <pre className="span-io-text">{preview.text}{preview.truncated ? '\n…' : ''}</pre>
    </div>
  );
}

function OpGlyph({ span, current }: { span: SafeSpan; current?: boolean }) {
  const title = `${intentText(span)}${span.intent?.subject ? ` ${span.intent.subject}` : ''}${span.result ? ` → ${resultLabel(span.result.category)}` : ''} · ${fmtMs(span.durationMs)}`;
  return <i className={`op ph-${phaseSlug(span.phase)}${spanFailed(span) ? ' bad' : ''}${current ? ' cur' : ''}`} title={title} />;
}

function SpanDetail({ spans, idx }: { spans: SafeSpan[]; idx: number }) {
  const s = spans[idx];
  if (!s) return null;
  const d = s.detail;
  const ev = d?.evidence ?? s.evidence;
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
  const sibs = spans.map((sp, i) => ({ sp, i })).filter(x => x.sp.turnIndex === s.turnIndex).sort((a, b) => (a.sp.relStartMs ?? 0) - (b.sp.relStartMs ?? 0));
  return (
    <div className="spandetail">
      <dl className="span-kv">{kv.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
      <TextPreview label={t('insights.dCommand')} preview={ev?.command} />
      <TextPreview label={t('insights.dCmdOutput')} preview={ev?.output} />
      {prev || next ? <div className="span-flank">{prev ? <span className="sf-prev">↑ {prev}</span> : null}{next ? <span className="sf-next">↓ {next}</span> : null}</div> : null}
      <div className="span-ctx"><span className="span-ctx-label">{t('insights.dTurnContext', { turn: s.turnIndex })}</span><div className="opstrip">{sibs.map(x => <OpGlyph key={x.i} span={x.sp} current={x.i === idx} />)}</div></div>
    </div>
  );
}

function SpanRow({ spans, idx, hot, open, detailable = true, onToggle, scrollTarget, onScrolled }: {
  spans: SafeSpan[];
  idx: number;
  hot: boolean;
  open: boolean;
  detailable?: boolean;
  onToggle?: (idx: number) => void;
  scrollTarget?: ScrollTarget;
  onScrolled?: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const s = spans[idx];
  useEffect(() => {
    if (!ref.current || scrollTarget?.kind !== 'span' || scrollTarget.index !== idx) return;
    ref.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
    onScrolled?.();
  }, [idx, onScrolled, scrollTarget]);
  if (!s) return null;
  const subject = s.intent?.subject ? <code className="span-subj">{s.intent.subject}</code> : null;
  const res = s.result;
  const tags = (s.tags ?? []).filter(tg => tg !== 'normal' && tg !== 'diagnostic');
  const toggle = () => detailable && onToggle?.(idx);
  return (
    <div ref={ref} className={`spanrow ph-${phaseSlug(s.phase)}${s.status === 'error' ? ' error' : ''}${hot ? ' hot' : ''}${open ? ' open' : ''}`}>
      <div
        className={`sprow-line${detailable ? ' clickable' : ''}`}
        role={detailable ? 'button' : undefined}
        tabIndex={detailable ? 0 : undefined}
        aria-expanded={detailable ? open : undefined}
        onClick={toggle}
        onKeyDown={event => {
          if (!detailable) return;
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            toggle();
          }
        }}
      >
        <span className="span-turn" title={`${t('insights.dStart')} ${fmtMs(s.relStartMs)}`}>#{String(s.turnIndex ?? 0)}</span>
        <span className={`spanst ${s.status}`}>{statusIcon(s.status)}</span>
        <b className="span-what">{intentText(s)}</b>{subject}
        {res && BAD_RESULTS.has(res.category) ? <span className="span-res rc-bad">{resultLabel(res.category)}{res.exitCode !== undefined ? ` · exit ${res.exitCode}` : ''}</span> : null}
        <span className="span-tags">{tags.map(tg => <span key={tg} className={`span-tag tg-${tg}`}>{tagLabel(tg)}</span>)}</span>
        <span className="span-dur">{fmtMs(s.durationMs)}</span>
        {detailable ? <span className="span-detail-btn" aria-hidden="true">{open ? t('insights.dCollapse') : t('insights.dDetail')}</span> : null}
      </div>
      {detailable && open ? <SpanDetail spans={spans} idx={idx} /> : null}
    </div>
  );
}

function WorkSummary({ report }: { report: SafeInsightReport }) {
  const ws = report.workSummary;
  if (!ws || (!ws.fileChanges?.length && !ws.commandsRun?.length)) return null;
  const files = ws.fileChanges ?? [];
  const cmds = ws.commandsRun ?? [];
  return (
    <div className="worksum">
      <section className="ws-panel">
        <h4>{t('insights.wsFiles', { n: files.length })}</h4>
        <div className="ws-list">
          {files.length ? files.map((f, i) => (
            <div key={`${f.path}:${i}`} className="ws-row">
              <code className="ws-path" title={f.path}>{f.path}</code>
              <span className="ws-meta">{t('insights.wsReads', { n: f.reads })}</span>
              {(f.added || f.removed) ? <span className="ws-stat"><span className="ws-add">+{f.added ?? 0}</span><span className="ws-del">-{f.removed ?? 0}</span></span> : f.edits ? <span className="ws-stat ws-stat-edits">{t('insights.wsEdits', { n: f.edits })}</span> : null}
            </div>
          )) : <p className="mut">{t('insights.wsNoFiles')}</p>}
        </div>
      </section>
      <section className="ws-panel">
        <h4>{t('insights.wsCmds', { n: cmds.length })}</h4>
        <div className="ws-list">
          {cmds.length ? cmds.map((c, i) => {
            const bad = c.failures > 0;
            return (
              <div key={`${c.command.text}:${i}`} className={`ws-row${bad ? ' bad' : ''}`}>
                <code className="ws-cmd" title={c.command.text}>{c.command.text}{c.command.truncated ? '…' : ''}</code>
                <span className="ws-meta">{c.count > 1 ? <span className="ws-x">×{c.count}</span> : null}{bad ? <span className="ws-fail">{t('insights.wsFail', { n: c.failures })}</span> : null}</span>
              </div>
            );
          }) : <p className="mut">{t('insights.wsNoCmds')}</p>}
        </div>
      </section>
    </div>
  );
}

function Evidence({ report, focus, view, onSpanFilter, onToggleSpan, scrollTarget, onScrolled }: {
  report: SafeInsightReport;
  focus: { rec: DiagnosticRecommendation | null; spanIdx: Set<number> };
  view: DetailView;
  onSpanFilter: (filter: string) => void;
  onToggleSpan: (idx: number) => void;
  scrollTarget: ScrollTarget;
  onScrolled: () => void;
}) {
  const spans = report.spans ?? [];
  if (!spans.length) {
    return <><WorkSummary report={report} /><p className="mut">{t('insights.noSpans')}</p></>;
  }
  const order = [...spans.keys()].sort((a, b) => (spans[a]!.relStartMs ?? 0) - (spans[b]!.relStartMs ?? 0));
  const counts = new Map<string, number>();
  for (const i of order) for (const tg of spans[i]!.tags ?? []) if ((SPAN_TAGS as string[]).includes(tg)) counts.set(tg, (counts.get(tg) ?? 0) + 1);
  const visible = view.spanFilter === 'all' ? order : order.filter(i => spans[i]!.tags?.includes(view.spanFilter as SafeSpanTag));
  return (
    <div className="evidence">
      <WorkSummary report={report} />
      {focus.rec ? <div className="ev-reason">{idText('why', focus.rec.why)}</div> : null}
      <div className="spanfilter">
        <button type="button" className={`spanchip${view.spanFilter === 'all' ? ' on' : ''}`} onClick={() => onSpanFilter('all')}>{t('insights.spanAll')} <b>{order.length}</b></button>
        {SPAN_TAGS.filter(tg => counts.has(tg)).map(tg => (
          <button key={tg} type="button" className={`spanchip tg-${tg}${view.spanFilter === tg ? ' on' : ''}`} onClick={() => onSpanFilter(tg)}>{tagLabel(tg)} <b>{counts.get(tg)}</b></button>
        ))}
      </div>
      <div className="spantable">
        {visible.length ? visible.map(i => (
          <SpanRow
            key={i}
            spans={spans}
            idx={i}
            hot={focus.spanIdx.has(i)}
            open={view.openSpans.has(i)}
            onToggle={onToggleSpan}
            scrollTarget={scrollTarget}
            onScrolled={onScrolled}
          />
        )) : <p className="mut">{t('insights.evNoFlags')}</p>}
      </div>
    </div>
  );
}

function PromptSourceChip({ src, fallback }: { src?: { kind?: string; agentName?: string; senderName?: string }; fallback?: string }) {
  if (!src?.kind) return <span className="tp-label">{fallback ?? t('insights.turnPrompt')}</span>;
  if (src.kind === 'a2a_agent') {
    const name = src.agentName || src.senderName;
    return <span className="tp-label tp-src tp-src-a2a">🤝 {name ? `${name} · a2a` : 'a2a'}</span>;
  }
  if (src.kind === 'system') return <span className="tp-label tp-src tp-src-system">⚙️ {t('insights.senderSystem')}</span>;
  return <span className="tp-label tp-src tp-src-user">👤 {src.senderName || fallback || t('insights.turnPrompt')}</span>;
}

function PromptMentions({ src }: { src?: { mentionedNames?: string[] } }) {
  const mentions = (src?.mentionedNames ?? []).filter(Boolean);
  if (!mentions.length) return null;
  return <span className="tp-mentions">{t('insights.srcMentions')} {mentions.map(n => `@${n}`).join(' ')}</span>;
}

function TurnEventGlyph({ event }: { event: TurnTimelineEvent }) {
  const bad = event.status === 'error' || (!!event.result && BAD_RESULTS.has(event.result.category));
  const what = intentTextOf(event.intent, String(event.label.params.tool ?? event.kind));
  const title = `${what}${event.intent?.subject ? ` ${event.intent.subject}` : ''}${event.result ? ` → ${resultLabel(event.result.category)}` : ''} · ${fmtMs(event.durationMs)}`;
  return <i className={`op ph-${phaseSlug(event.phase)}${bad ? ' bad' : ''}`} title={title} />;
}

function TurnCard({ report, turn, focus, view, onToggleTurn, onToggleSpan, onTogglePrompt, onTogglePromptRaw, onOpenPrompt, scrollTarget, onScrolled }: {
  report: SafeInsightReport;
  turn: TurnTimelineTurn;
  focus: { turnIdx: Set<number> };
  view: DetailView;
  onToggleTurn: (idx: number) => void;
  onToggleSpan: (idx: number) => void;
  onTogglePrompt: (idx: number) => void;
  onTogglePromptRaw: (idx: number) => void;
  onOpenPrompt: (idx: number) => void;
  scrollTarget: ScrollTarget;
  onScrolled: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const spans = report.spans ?? [];
  const open = view.openTurns.has(turn.turnIndex);
  const hot = focus.turnIdx.has(turn.turnIndex);
  const m = turn.metrics;
  const advice = turn.severity !== 'info' ? turnAdvice(turn.tags) : '';
  const ptext = turn.prompt?.text ? (cleanPromptText(turn.prompt.text) || turn.prompt.text) : '';
  const promptExpanded = view.openPrompts.has(turn.turnIndex);
  const promptRaw = view.rawPrompts.has(turn.turnIndex);
  const promptBody = promptRaw
    ? <pre className="tp-raw">{ptext}{turn.prompt?.truncated ? '\n…' : ''}</pre>
    : <MarkdownBody text={ptext + (turn.prompt?.truncated ? ' …' : '')} />;
  const mini = `${t('insights.mEdits')}${m.edits} ${t('insights.mRuns')}${m.runs}${m.failures ? ` · ${t('insights.mFailures')}${m.failures}` : ''} · ${fmtMs(m.durationMs)}`;
  useEffect(() => {
    if (!ref.current || scrollTarget?.kind !== 'turn' || scrollTarget.index !== turn.turnIndex) return;
    ref.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
    onScrolled();
  }, [onScrolled, scrollTarget, turn.turnIndex]);
  const pill = (label: string, val: string, bad = false) => <span className={`tm${bad ? ' bad' : ''}`}><i>{label}</i><b>{val}</b></span>;
  return (
    <div ref={ref} className={`turnrow sev-${turn.severity}${hot ? ' hot' : ''}${turn.severity !== 'info' ? ' flagged' : ''}${open ? ' open' : ''}`}>
      <div className="turnline">
        <span className="turn-no">#{String(turn.turnIndex)}</span>
        <b className="turn-headline">{turnHeadline(turn.headline)}</b>
        <div className="opstrip turn-strip">{turn.events.map((e, i) => <TurnEventGlyph key={`${e.spanIndex}:${i}`} event={e} />)}</div>
        <span className="turn-mini">{mini}</span>
        <button type="button" className="turn-expand-btn" aria-expanded={open} onClick={() => onToggleTurn(turn.turnIndex)}>
          {open ? t('insights.turnCollapse') : t('insights.turnExpand', { count: turn.events.length })}
        </button>
      </div>
      {ptext ? (
        <div className="turn-prompt">
          <PromptSourceChip src={turn.prompt?.source} />
          <div className="tp-body">
            <div className={`tp-md${promptExpanded ? ' expanded' : ''}`}>{promptBody}</div>
            <div className="tp-actions">
              <PromptMentions src={turn.prompt?.source} />
              <button type="button" className="tp-toggle" onClick={() => onTogglePrompt(turn.turnIndex)}>{promptExpanded ? t('insights.turnPromptCollapse') : t('insights.turnPromptExpand')}</button>
              <button type="button" className="tp-toggle" onClick={() => onTogglePromptRaw(turn.turnIndex)}>{promptRaw ? t('insights.turnPromptRendered') : t('insights.turnPromptRaw')}</button>
              <button type="button" className="tp-toggle" onClick={() => onOpenPrompt(turn.turnIndex)}>{t('insights.turnPromptFull')}</button>
            </div>
          </div>
        </div>
      ) : null}
      {advice ? <div className="turn-advice">{advice}</div> : null}
      {open ? (
        <div className="turn-detail">
          <div className="turn-metrics">{pill(t('insights.mReads'), String(m.reads))}{pill(t('insights.mEdits'), String(m.edits))}{pill(t('insights.mRuns'), String(m.runs))}{m.failures ? pill(t('insights.mFailures'), String(m.failures), true) : null}{pill(t('insights.mDur'), fmtMs(m.durationMs))}</div>
          <div className="spantable">
            {turn.events.map(e => (
              <SpanRow
                key={e.spanIndex}
                spans={spans}
                idx={e.spanIndex}
                hot={false}
                open={view.openSpans.has(e.spanIndex)}
                onToggle={onToggleSpan}
                scrollTarget={scrollTarget}
                onScrolled={onScrolled}
              />
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function TurnEfficiency({ report, focus, view, onLedgerSort, onLedgerSender, onToggleTurn, onToggleSpan, onTogglePrompt, onTogglePromptRaw, onOpenPrompt, scrollTarget, onScrolled }: {
  report: SafeInsightReport;
  focus: { turnIdx: Set<number> };
  view: DetailView;
  onLedgerSort: (sort: 'normal' | 'grouped') => void;
  onLedgerSender: (sender: LedgerSender) => void;
  onToggleTurn: (idx: number) => void;
  onToggleSpan: (idx: number) => void;
  onTogglePrompt: (idx: number) => void;
  onTogglePromptRaw: (idx: number) => void;
  onOpenPrompt: (idx: number) => void;
  scrollTarget: ScrollTarget;
  onScrolled: () => void;
}) {
  const spans = report.spans ?? [];
  const allTurns = report.turnTimeline ?? [];
  if (!allTurns.length) return <p className="mut">{t('insights.noSpans')}</p>;
  const recs = report.recommendations ?? [];
  const canGroup = recs.some(r => (r.evidence?.turnIndexes?.length ?? 0) > 0);
  const senderCount: Record<Exclude<LedgerSender, 'all'>, number> = { user: 0, a2a_agent: 0, system: 0 };
  for (const tn of allTurns) senderCount[turnSenderKind(tn)] += 1;
  const turns = view.ledgerSender === 'all'
    ? allTurns.filter(tn => turnSenderKind(tn) !== 'system')
    : allTurns.filter(tn => turnSenderKind(tn) === view.ledgerSender);
  const flagged = turns.filter(tn => tn.severity !== 'info').length;
  const card = (tn: TurnTimelineTurn) => (
    <TurnCard
      key={tn.turnIndex}
      report={report}
      turn={tn}
      focus={focus}
      view={view}
      onToggleTurn={onToggleTurn}
      onToggleSpan={onToggleSpan}
      onTogglePrompt={onTogglePrompt}
      onTogglePromptRaw={onTogglePromptRaw}
      onOpenPrompt={onOpenPrompt}
      scrollTarget={scrollTarget}
      onScrolled={onScrolled}
    />
  );
  const controls = (
    <>
      <div className="spanfilter ledgersender">
        <button type="button" className={`spanchip${view.ledgerSender === 'all' ? ' on' : ''}`} onClick={() => onLedgerSender('all')}>{t('insights.spanAll')} <b>{senderCount.user + senderCount.a2a_agent}</b></button>
        {senderCount.user ? <button type="button" className={`spanchip${view.ledgerSender === 'user' ? ' on' : ''}`} onClick={() => onLedgerSender('user')}>👤 {t('insights.senderHuman')} <b>{senderCount.user}</b></button> : null}
        {senderCount.a2a_agent ? <button type="button" className={`spanchip${view.ledgerSender === 'a2a_agent' ? ' on' : ''}`} onClick={() => onLedgerSender('a2a_agent')}>🤝 {t('insights.senderA2A')} <b>{senderCount.a2a_agent}</b></button> : null}
        {senderCount.system ? <button type="button" className={`spanchip spanchip-sys${view.ledgerSender === 'system' ? ' on' : ''}`} onClick={() => onLedgerSender('system')}>⚙️ {t('insights.senderSystem')} <b>{senderCount.system}</b></button> : null}
      </div>
      {canGroup ? (
        <div className="spanfilter ledgersort">
          <button type="button" className={`spanchip${view.ledgerSort === 'normal' ? ' on' : ''}`} onClick={() => onLedgerSort('normal')}>{t('insights.ledgerNormal')}</button>
          <button type="button" className={`spanchip${view.ledgerSort === 'grouped' ? ' on' : ''}`} onClick={() => onLedgerSort('grouped')}>{t('insights.ledgerGrouped')}</button>
        </div>
      ) : null}
    </>
  );
  const note = report.meta?.capped ? <p className="turn-hidden mut">{t('insights.turnsCapped', { shown: String(report.meta.spansReturned ?? spans.length), total: String(report.meta.spansTotal ?? spans.length) })}</p> : null;
  if (!turns.length) return <div className="turnlist">{controls}<p className="mut">{t('insights.evNoFlags')}</p></div>;
  if (view.ledgerSort === 'grouped' && canGroup) {
    const sortedRecs = [...recs].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
    const byIndex = new Map(turns.map(tn => [tn.turnIndex, tn] as const));
    const assigned = new Map<number, string>();
    for (const r of sortedRecs) for (const ti of r.evidence?.turnIndexes ?? []) if (byIndex.has(ti) && !assigned.has(ti)) assigned.set(ti, r.id);
    const blocks: ReactNode[] = [];
    for (const r of sortedRecs) {
      const ts = turns.filter(tn => assigned.get(tn.turnIndex) === r.id).sort((a, b) => a.turnIndex - b.turnIndex);
      if (!ts.length) continue;
      blocks.push(
        <div key={r.id} className="turn-group">
          <div className={`turn-group-head sev-${r.severity}`}><b>{idText('rec', { id: r.id, params: {} })}</b><span>{t('insights.ledgerGroupCount', { count: ts.length })}</span></div>
          {ts.map(card)}
        </div>,
      );
    }
    const other = turns.filter(tn => !assigned.has(tn.turnIndex)).sort((a, b) => a.turnIndex - b.turnIndex);
    if (other.length) {
      blocks.push(
        <div key="other" className="turn-group">
          <div className="turn-group-head sev-info"><b>{t('insights.ledgerOther')}</b><span>{t('insights.ledgerGroupCount', { count: other.length })}</span></div>
          {other.map(card)}
        </div>,
      );
    }
    return <div className="turnlist"><p className="turn-sum mut">{t('insights.turnSummary', { total: turns.length, flagged })}</p>{controls}{blocks}{note}</div>;
  }
  return <div className="turnlist"><p className="turn-sum mut">{t('insights.turnSummary', { total: turns.length, flagged })}</p>{controls}{[...turns].sort((a, b) => a.turnIndex - b.turnIndex).map(card)}{note}</div>;
}

function ConvoRecBadges({ turnIndex, recByTurn }: { turnIndex: number; recByTurn: Map<number, string[]> }) {
  const ids = recByTurn.get(turnIndex);
  if (!ids?.length) return null;
  return <>{ids.map(id => <span key={id} className="cbub-rec" title={idText('rec', { id, params: {} })}>💡 {idText('rec', { id, params: {} })}</span>)}</>;
}

function ConvoPrompt({ msg, recByTurn, onOpenPrompt }: { msg: InsightConversationMessage; recByTurn: Map<number, string[]>; onOpenPrompt: (idx: number) => void }) {
  const side = msg.role === 'user' ? 'right' : 'left';
  const text = msg.text ? (cleanPromptText(msg.text) || msg.text) : '';
  const sevCls = msg.severity && msg.severity !== 'info' ? ` sev-${msg.severity}` : '';
  return (
    <div className={`cbub cbub-${side} role-${msg.role}${sevCls}`}>
      <div className="cbub-head"><PromptSourceChip src={msg.source} /><PromptMentions src={msg.source} /><span className="cbub-turn">#{String(msg.turnIndex)}</span><ConvoRecBadges turnIndex={msg.turnIndex} recByTurn={recByTurn} /></div>
      <div className="cbub-body">{text ? <MarkdownBody text={text + (msg.truncated ? ' …' : '')} /> : <p className="mut">{t('insights.replayNoText')}</p>}</div>
      {msg.truncated ? <div className="cbub-foot"><button type="button" className="tp-toggle" onClick={() => onOpenPrompt(msg.turnIndex)}>{t('insights.turnPromptFull')}</button></div> : null}
    </div>
  );
}

function ConvoOpRow({ msg, open, onToggle }: { msg: InsightConversationMessage; open: boolean; onToggle: (id: string) => void }) {
  const e = msg.event;
  if (!e) return null;
  const bad = e.status === 'error' || (!!e.result && BAD_RESULTS.has(e.result.category));
  const subj = e.intent?.subject ? <code className="span-subj">{e.intent.subject}</code> : null;
  const what = intentTextOf(e.intent, String(e.label?.params?.tool ?? e.kind));
  const ev = e.evidence;
  const expandable = !!(ev?.command?.text || ev?.output?.text);
  const tags = (msg.tags ?? []).filter(tg => tg !== 'normal' && tg !== 'diagnostic');
  const toggle = () => expandable && onToggle(msg.id);
  return (
    <div className={`cop${bad ? ' bad' : ''}${open ? ' open' : ''}`}>
      <div
        className={`cop-line${expandable ? ' clickable' : ''}`}
        role={expandable ? 'button' : undefined}
        tabIndex={expandable ? 0 : undefined}
        onClick={toggle}
        onKeyDown={event => {
          if (!expandable) return;
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            toggle();
          }
        }}
      >
        <i className={`op ph-${phaseSlug(e.phase)}${bad ? ' bad' : ''}`} />
        <b className="span-what">{what}</b>{subj}
        {e.result && BAD_RESULTS.has(e.result.category) ? <span className="span-res rc-bad">{resultLabel(e.result.category)}{e.result.exitCode !== undefined ? ` · exit ${e.result.exitCode}` : ''}</span> : null}
        <span className="span-tags">{tags.map(tg => <span key={tg} className={`span-tag tg-${tg}`}>{tagLabel(tg)}</span>)}</span>
        <span className="span-dur">{fmtMs(e.durationMs)}</span>
        {expandable ? <span className="span-detail-btn" aria-hidden="true">{open ? t('insights.dCollapse') : t('insights.dDetail')}</span> : null}
      </div>
      {open && ev ? <div className="spandetail"><TextPreview label={t('insights.dCommand')} preview={ev.command} /><TextPreview label={t('insights.dCmdOutput')} preview={ev.output} /></div> : null}
    </div>
  );
}

function ConvoOps({ unit, convo, recByTurn, onToggleOp }: { unit: { turnIndex: number; msgs: InsightConversationMessage[] }; convo: ConvoState; recByTurn: Map<number, string[]>; onToggleOp: (id: string) => void }) {
  const sayMsgs = unit.msgs.filter(m => m.text && !m.event);
  const opMsgs = unit.msgs.filter(m => m.event);
  const worst = unit.msgs.some(m => m.severity === 'bad') ? ' sev-bad' : unit.msgs.some(m => m.severity === 'warn') ? ' sev-warn' : '';
  return (
    <div className={`cbub cbub-left role-agent cbub-ops${worst}`}>
      <div className="cbub-head"><span className="tp-label tp-src tp-src-system">🤖 {t('insights.replayAgent')}</span><span className="cbub-turn">#{String(unit.turnIndex)}</span>{opMsgs.length ? <span className="cbub-opcount">{t('insights.replayOps', { count: opMsgs.length })}</span> : null}<ConvoRecBadges turnIndex={unit.turnIndex} recByTurn={recByTurn} /></div>
      {sayMsgs.length ? <div className="cbub-saywrap">{sayMsgs.map(m => <div key={m.id} className="cbub-say"><MarkdownBody text={m.text!} /></div>)}</div> : null}
      {opMsgs.length ? <div className="cbub-ops-list">{opMsgs.map(m => <ConvoOpRow key={m.id} msg={m} open={convo.openOps.has(m.id)} onToggle={onToggleOp} />)}</div> : null}
    </div>
  );
}

function Conversation({ convo, recByTurn, onQuery, onRole, onTag, onLoadMore, onToggleOp, onOpenPrompt }: {
  convo: ConvoState;
  recByTurn: Map<number, string[]>;
  onQuery: (q: string) => void;
  onRole: (role: string) => void;
  onTag: (tag: string) => void;
  onLoadMore: () => void;
  onToggleOp: (id: string) => void;
  onOpenPrompt: (idx: number) => void;
}) {
  const [draft, setDraft] = useState(convo.q);
  useEffect(() => setDraft(convo.q), [convo.q]);
  const units = groupConvo(convo.messages);
  return (
    <div className="convo">
      <div className="convo-controls">
        <input
          type="search"
          className="convo-search"
          placeholder={t('insights.replaySearch')}
          value={draft}
          onChange={event => setDraft(event.currentTarget.value)}
          onKeyDown={event => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            const next = draft.trim();
            if (next !== convo.q) onQuery(next);
          }}
        />
        <div className="convo-filters">
          <div className="spanfilter convo-rolefilter">
            <span className="convo-flabel">{t('insights.replayBy')}</span>
            {CONVO_ROLES.map(r => <button key={r.key} type="button" className={`spanchip${convo.role === r.key ? ' on' : ''}`} onClick={() => onRole(r.key)}>{t(`insights.${r.label}`)}</button>)}
          </div>
          <div className="spanfilter convo-tagfilter">
            <span className="convo-flabel">{t('insights.replayState')}</span>
            {CONVO_TAGS.map(tg => <button key={tg.key} type="button" className={`spanchip${convo.tag === tg.key ? ' on' : ''}`} onClick={() => onTag(tg.key)}>{tg.label.startsWith('tag.') ? tagLabel(tg.label.slice(4)) : t(`insights.${tg.label}`)}</button>)}
          </div>
        </div>
      </div>
      <div className="convothread">
        {!convo.messages.length ? (
          convo.loading ? <LoadingState label={t('insights.detailLoading')} compact /> : <p className="mut">{t('insights.replayEmpty')}</p>
        ) : (
          <>
            {units.map((u, i) => u.kind === 'prompt'
              ? <ConvoPrompt key={u.msg.id} msg={u.msg} recByTurn={recByTurn} onOpenPrompt={onOpenPrompt} />
              : <ConvoOps key={`${u.turnIndex}:${i}`} unit={u} convo={convo} recByTurn={recByTurn} onToggleOp={onToggleOp} />)}
            {convo.hasMore ? (
              <div className="convo-more"><button type="button" className="primary convo-loadmore" disabled={convo.loading} onClick={onLoadMore}>{convo.loading ? t('insights.detailLoading') : t('insights.replayLoadMore', { shown: convo.messages.length, total: convo.total })}</button></div>
            ) : <p className="convo-more mut">{t('insights.replayAllLoaded', { total: convo.total })}</p>}
          </>
        )}
      </div>
    </div>
  );
}

function Recommendations({ report, activeId, onActive }: { report: SafeInsightReport; activeId: string | null; onActive: (id: string | null) => void }) {
  const recs = report.recommendations ?? [];
  if (!recs.length) return <p className="mut">{t('insights.noRecommendations')}</p>;
  return (
    <div className="reclist">
      {[...recs].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]).map(r => {
        const active = r.id === activeId;
        const targeted = (r.evidence?.spanIndexes?.length ?? 0) > 0 || (r.evidence?.turnIndexes?.length ?? 0) > 0;
        const impact = idText('impact', r.impact);
        const why = idText('why', r.why);
        return (
          <button key={r.id} type="button" className={`rec ${r.severity}${targeted ? ' rec-clickable' : ''}${active ? ' active' : ''}`} onClick={() => onActive(active ? null : r.id)}>
            <div className="rectop"><b>{idText('rec', { id: r.id, params: {} })}</b><span>{severityLabel(r.severity)}</span></div>
            {impact ? <div className="rec-impact">{impact}</div> : null}
            {r.nextActions.length ? <ul className="rec-actions">{r.nextActions.map(a => <li key={`${a.id}:${JSON.stringify(a.params)}`}>{idText('action', a)}</li>)}</ul> : null}
            {why ? <div className="rec-why">{why}</div> : null}
            {targeted ? <span className="rec-cta">{active ? t('insights.diagActive') : t('insights.diagShow')}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

function Subagents({ report }: { report: SafeInsightReport }) {
  const lanes = report.subagents ?? [];
  if (!lanes.length) return null;
  const totMs = lanes.reduce((s, l) => s + l.durationMs, 0);
  return (
    <section className="block subagent-block">
      <h3>{t('insights.subagents')} <span className="mut">· {lanes.length} · {fmtMs(totMs)}</span></h3>
      <p className="mut ins-hint">{t('insights.subagentsHint')}</p>
      <div className="sublanes">
        {lanes.map((l, i) => (
          <div key={`${l.agentType}:${i}`} className={`sublane${l.failures ? ' bad' : ''}`}>
            <div className="sublane-head"><span className="sublane-type">{l.agentType}</span><span className="sublane-task">{l.task?.text ?? ''}{l.task?.truncated ? '…' : ''}</span></div>
            <PhaseMixBar phase={l.phase} />
            <div className="sublane-stats"><span>{fmtInt(l.spans)} {t('insights.spansShort')}</span><span>{fmtMs(l.durationMs)}</span>{l.failures ? <span className="bad">{fmtInt(l.failures)} {t('insights.failedShort')}</span> : null}</div>
          </div>
        ))}
      </div>
    </section>
  );
}

function TurnRail({ report, focus, recByTurn, onJumpTurn, onTip, onTipHide }: {
  report: SafeInsightReport;
  focus: { turnIdx: Set<number> };
  recByTurn: Map<number, string[]>;
  onJumpTurn: (turn: TurnTimelineTurn) => void;
  onTip: (event: React.MouseEvent, text: string) => void;
  onTipHide: () => void;
}) {
  const turns = [...(report.turnTimeline ?? [])].sort((a, b) => a.turnIndex - b.turnIndex);
  if (turns.length < 2) return null;
  const focused = focus.turnIdx.size > 0;
  const legend = ['research', 'edit', 'run', 'delegate', 'discuss'];
  return (
    <section className="block turnrail-block">
      <div className="turnrail-head">
        <h3>{t('insights.turnRail')}</h3>
        <span className="turnrail-legend">
          {legend.map(p => <span key={p} className="rl-item"><i className={phaseClass(p)} />{phaseLabel(p)}</span>)}
          <span className="rl-item rl-sep"><i className="rbr-sub" />{t('insights.railSubagent')}</span>
        </span>
      </div>
      <div className="turnrail" onMouseLeave={onTipHide}>
        {turns.map(tn => {
          const m = tn.metrics;
          const phase = turnMainPhase(tn);
          const fail = (tn.tags ?? []).includes('failure') || (tn.events ?? []).some(e => e.status === 'error');
          const slow = (tn.tags ?? []).includes('slow');
          const recHit = recByTurn.has(tn.turnIndex);
          const hot = focus.turnIdx.has(tn.turnIndex);
          const cls = ['railnode', phaseClass(phase), hot ? 'hot' : '', (focused && !hot) ? 'dim' : ''].filter(Boolean).join(' ');
          const tip = `#${tn.turnIndex} · ${phaseLabel(phase)} · ${t('insights.mReads')}${m.reads} ${t('insights.mEdits')}${m.edits} ${t('insights.mRuns')}${m.runs}${m.failures ? ` · ${t('insights.mFailures')}${m.failures}` : ''} · ${fmtMs(m.durationMs)}`;
          const subs = (tn.events ?? []).filter(e => e.kind === 'delegate').length;
          return (
            <span key={tn.turnIndex} style={{ display: 'contents' }}>
              <button type="button" className={cls} onMouseMove={event => onTip(event, tip)} onBlur={onTipHide} onClick={() => onJumpTurn(tn)}>
                <span>{String(tn.turnIndex)}</span>{fail ? <i className="rb rb-fail" /> : null}{slow ? <i className="rb rb-slow" /> : null}{recHit ? <i className="rb rb-rec" /> : null}
              </button>
              {subs ? <span className="railbranch" onMouseMove={event => onTip(event, `#${tn.turnIndex} · ${t('insights.railSubagents', { n: subs })}`)}>{Array.from({ length: Math.min(subs, 4) }).map((_, i) => <i key={i} className="rbr-sub" />)}</span> : null}
            </span>
          );
        })}
      </div>
    </section>
  );
}

function WorkGantt({ report, onOpenSpan, onTip, onTipHide }: {
  report: SafeInsightReport;
  onOpenSpan: (idx: number) => void;
  onTip: (event: React.MouseEvent, text: string) => void;
  onTipHide: () => void;
}) {
  const timed = (report.spans ?? []).map((s, i) => ({ s, i, start: s.relStartMs ?? 0, dur: Math.max(s.durationMs ?? 0, 0) }))
    .filter(x => Number.isFinite(x.start)).sort((a, b) => a.start - b.start);
  if (timed.length < 2) return null;
  const active = Math.max(timed.reduce((sum, x) => sum + x.dur, 0), 1);
  let cursor = 0;
  const realSpan = (timed[timed.length - 1]!.start + timed[timed.length - 1]!.dur) - timed[0]!.start;
  return (
    <section className="block gantt-block">
      <div className="turnrail-head"><h3>{t('insights.gantt')}</h3><span className="gantt-cap">{t('insights.ganttCaption', { span: timed.length, dur: fmtMs(realSpan), active: fmtMs(active) })}</span></div>
      <div className="gantt">
        <div className="gtrack" onMouseLeave={onTipHide}>
          {timed.map(x => {
            const left = cursor / active * 100;
            const width = Math.max(x.dur / active * 100, 0.3);
            cursor += x.dur;
            const fail = x.s.status === 'error' || (x.s.tags ?? []).includes('failure');
            const slow = (x.s.tags ?? []).includes('slow');
            const cls = ['gbar', phaseClass(x.s.phase), fail ? 'gbar-fail' : '', slow ? 'gbar-slow' : ''].filter(Boolean).join(' ');
            const st = x.s.status === 'error' ? ` · ${tagLabel('failure')}` : '';
            const tip = `#${x.i} · ${x.s.tool} · ${phaseLabel(x.s.phase)} · ${fmtMs(x.s.durationMs)}${st}`;
            return <button key={x.i} type="button" className={cls} style={{ left: `${left.toFixed(3)}%`, width: `${width.toFixed(3)}%` }} onMouseMove={event => onTip(event, tip)} onClick={() => onOpenSpan(x.i)} />;
          })}
        </div>
      </div>
    </section>
  );
}

function ContextCurve({ report, onTip, onTipHide }: { report: SafeInsightReport; onTip: (event: React.MouseEvent, text: string) => void; onTipHide: () => void }) {
  const pts = (report.turnTimeline ?? [])
    .map(tn => (tn.context && Number.isFinite(tn.context.contextTokens)) ? { turn: tn.turnIndex, v: tn.context.contextTokens } : null)
    .filter((p): p is { turn: number; v: number } => p !== null)
    .sort((a, b) => a.turn - b.turn);
  if (pts.length < 2) return null;
  const max = Math.max(...pts.map(p => p.v), 1);
  const w = 100;
  const h = 40;
  const xs = (i: number) => (i / (pts.length - 1)) * w;
  const ys = (v: number) => h - 1 - (v / max) * (h - 2);
  const line = pts.map((p, i) => `${xs(i).toFixed(2)},${ys(p.v).toFixed(2)}`).join(' ');
  const area = `0,${h} ${line} ${w},${h}`;
  const band = w / pts.length;
  const mid = fmtInt(Math.round(max / 2));
  return (
    <section className="block ctxcurve-block">
      <div className="turnrail-head"><h3>{t('insights.ctxCurve')}</h3><span className="gantt-cap">{t('insights.ctxCaption', { peak: fmtInt(max), turns: pts.length })}</span></div>
      <div className="ctxchart">
        <div className="ctxyaxis"><span>{fmtInt(max)}</span><span>{mid}</span><span>0 tok</span></div>
        <div className="ctxplot">
          <svg className="ctxcurve" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" role="img" aria-label={t('insights.ctxCurve')} onMouseLeave={onTipHide}>
            <polygon className="ctxarea" points={area} />
            <polyline className="ctxline" points={line} />
            {pts.map((p, i) => (
              <rect
                key={p.turn}
                className="ctxhit"
                x={Math.max(0, xs(i) - band / 2)}
                y={0}
                width={band}
                height={h}
                onMouseMove={event => onTip(event, `${t('insights.ctxTurn', { n: p.turn })} · ${fmtInt(p.v)} tok`)}
              />
            ))}
          </svg>
          <div className="ctxxaxis"><span>{t('insights.ctxTurn', { n: pts[0]!.turn })}</span><span>{t('insights.ctxTurn', { n: pts[pts.length - 1]!.turn })}</span></div>
        </div>
      </div>
    </section>
  );
}

function DetailBody({ report, view, onViewChange, onOpenPrompt, onJumpTurn, onOpenSpan, scrollTarget, onScrolled, onTip, onTipHide, onLoadConvo }: {
  report: SafeInsightReport;
  view: DetailView;
  onViewChange: (patch: Partial<DetailView>) => void;
  onOpenPrompt: (idx: number) => void;
  onJumpTurn: (turn: TurnTimelineTurn) => void;
  onOpenSpan: (idx: number) => void;
  scrollTarget: ScrollTarget;
  onScrolled: () => void;
  onTip: (event: React.MouseEvent, text: string) => void;
  onTipHide: () => void;
  onLoadConvo: (reset: boolean, overrides?: Partial<Pick<ConvoState, 'q' | 'role' | 'tag'>>) => void;
}) {
  if (report.status !== 'ok') return <p className="mut">{safeStatus(report)}</p>;
  const a = report.agg;
  const focus = focusSets(report, view.activeId);
  const recByTurn = new Map<number, string[]>();
  for (const r of report.recommendations ?? []) for (const ti of r.evidence?.turnIndexes ?? []) {
    const arr = recByTurn.get(ti) ?? [];
    if (!arr.includes(r.id)) arr.push(r.id);
    recByTurn.set(ti, arr);
  }
  const meta = [
    report.meta?.asOf ? t('sessions.insightAsOf', { asOf: String(report.meta.asOf) }) : '',
    report.meta?.partial ? t('sessions.insightPartial') : '',
    report.meta?.capped ? t('sessions.insightCapped', { shown: String(report.meta.spansReturned ?? report.spans?.length ?? 0), total: String(report.meta.spansTotal ?? report.spans?.length ?? 0) }) : '',
  ].filter(Boolean).join(' · ');
  const spanCount = report.spans?.length ?? 0;
  const turnTotal = report.turnTimeline?.length ?? 0;
  const setTab = (tab: DetailTab) => {
    onViewChange({ tab });
    if (tab === 'convo' && !view.convo.messages.length && !view.convo.loading) onLoadConvo(true);
  };
  const toggleSpan = (idx: number) => onViewChange({ openSpans: toggleSet(view.openSpans, idx) });
  const toggleTurn = (idx: number) => onViewChange({ openTurns: toggleSet(view.openTurns, idx) });
  const togglePrompt = (idx: number) => onViewChange({ openPrompts: toggleSet(view.openPrompts, idx) });
  const togglePromptRaw = (idx: number) => onViewChange({ rawPrompts: toggleSet(view.rawPrompts, idx) });
  return (
    <>
      <div className="cards insight-detail-metrics">
        <MetricCard label={t('insights.metricSpans')} value={fmtInt(a.totalSpans)} />
        <MetricCard label={t('insights.metricFailed')} value={fmtInt(a.failedSpans)} />
        <MetricCard label={t('insights.metricSlow')} value={fmtInt(a.slowSpans)} />
        <MetricCard label={t('insights.metricRw')} value={a.readWriteRatio === null ? '-' : a.readWriteRatio.toFixed(1)} />
      </div>
      {meta ? <p className="insight-meta">{meta}</p> : null}
      <section className="block recblock">
        <h3>{t('insights.recommendations')}</h3>
        <Recommendations report={report} activeId={view.activeId} onActive={activeId => onViewChange({ activeId })} />
      </section>
      <TurnRail report={report} focus={focus} recByTurn={recByTurn} onJumpTurn={onJumpTurn} onTip={onTip} onTipHide={onTipHide} />
      <WorkGantt report={report} onOpenSpan={onOpenSpan} onTip={onTip} onTipHide={onTipHide} />
      <Subagents report={report} />
      <ContextCurve report={report} onTip={onTip} onTipHide={onTipHide} />
      <div className="detailtabs">
        <div className="detailtabbar" role="tablist" aria-label={t('insights.detailTabs')}>
          <button type="button" role="tab" className={view.tab === 'spans' ? 'on' : ''} onClick={() => setTab('spans')}>{t('insights.trace')} <b>{spanCount}</b></button>
          <button type="button" role="tab" className={view.tab === 'ledger' ? 'on' : ''} onClick={() => setTab('ledger')}>{t('insights.ledger')} <b>{turnTotal}</b></button>
          <button type="button" role="tab" className={view.tab === 'convo' ? 'on' : ''} onClick={() => setTab('convo')}>{t('insights.replay')}</button>
        </div>
        <div className="detailtabbody">
          <div className="insight-tab-panel" data-panel="spans" hidden={view.tab !== 'spans'}>
            <Evidence report={report} focus={focus} view={view} onSpanFilter={spanFilter => onViewChange({ spanFilter })} onToggleSpan={toggleSpan} scrollTarget={scrollTarget} onScrolled={onScrolled} />
          </div>
          <div className="insight-tab-panel" data-panel="ledger" hidden={view.tab !== 'ledger'}>
            <TurnEfficiency
              report={report}
              focus={focus}
              view={view}
              onLedgerSort={ledgerSort => onViewChange({ ledgerSort })}
              onLedgerSender={ledgerSender => onViewChange({ ledgerSender })}
              onToggleTurn={toggleTurn}
              onToggleSpan={toggleSpan}
              onTogglePrompt={togglePrompt}
              onTogglePromptRaw={togglePromptRaw}
              onOpenPrompt={onOpenPrompt}
              scrollTarget={scrollTarget}
              onScrolled={onScrolled}
            />
          </div>
          <div className="insight-tab-panel" data-panel="convo" hidden={view.tab !== 'convo'}>
            <Conversation
              convo={view.convo}
              recByTurn={recByTurn}
              onQuery={q => onLoadConvo(true, { q })}
              onRole={role => { if (role !== view.convo.role) onLoadConvo(true, { role }); }}
              onTag={tag => { if (tag !== view.convo.tag) onLoadConvo(true, { tag }); }}
              onLoadMore={() => onLoadConvo(false)}
              onToggleOp={id => onViewChange({ convo: { ...view.convo, openOps: toggleSet(view.convo.openOps, id) } })}
              onOpenPrompt={onOpenPrompt}
            />
          </div>
        </div>
      </div>
    </>
  );
}

function PromptModal({ modal, onClose, onToggleRaw }: { modal: ModalState; onClose: () => void; onToggleRaw: () => void }) {
  if (modal.turnIndex === null) return null;
  const prompt = modal.prompt;
  const src = prompt?.source;
  const cleaned = prompt?.text ? (cleanPromptText(prompt.text) || prompt.text) : '';
  const trunc = prompt?.truncated;
  const body = prompt
    ? modal.raw
      ? <pre className="tp-raw modal-raw">{cleaned}{trunc ? '\n…' : ''}</pre>
      : <MarkdownBody className="md-body modal-md" text={cleaned + (trunc ? ' …' : '')} />
    : <LoadingState label={t('insights.detailLoading')} compact />;
  return (
    <div id="insight-modal" className="insight-modal">
      <div className="modal-backdrop" onClick={onClose} />
      <div className="modal-panel" role="dialog" aria-modal="true" aria-label={t('insights.turnPrompt')}>
        {prompt ? (
          <>
            <div className="modal-head">
              <div className="modal-who"><PromptSourceChip src={src} /><PromptMentions src={src} /><span className="modal-turnno">#{modal.turnIndex}</span></div>
              <div className="modal-acts">
                <button type="button" className="tp-toggle" onClick={onToggleRaw}>{modal.raw ? t('insights.turnPromptRendered') : t('insights.turnPromptRaw')}</button>
                <button type="button" className="modal-close" onClick={onClose} aria-label={t('insights.modalClose')}>×</button>
              </div>
            </div>
            <div className="modal-body">{body}{trunc ? <p className="modal-trunc mut">{t('insights.promptTruncated')}</p> : null}</div>
          </>
        ) : <div className="modal-body">{body}</div>}
      </div>
    </div>
  );
}

function CommandPalette({ palette, items, onClose, onInput, onChoose }: {
  palette: PaletteState;
  items: Array<{ type: 'tab' | 'session'; key: string; label: string; sub: string }>;
  onClose: () => void;
  onInput: (q: string) => void;
  onChoose: (type: 'tab' | 'session', key: string) => void;
}) {
  if (!palette.open) return null;
  const anchored = !!palette.anchor;
  const panelStyle = anchored
    ? {
        top: palette.anchor!.top,
        left: palette.anchor!.left,
        width: palette.anchor!.width,
        '--palette-panel-max-height': `${palette.anchor!.maxHeight}px`,
        '--palette-list-max-height': `${Math.max(80, palette.anchor!.maxHeight - 54)}px`,
      } as CSSProperties
    : undefined;
  const node = (
    <div id="insight-palette" className={`insights-page insight-palette ${anchored ? 'palette-anchored' : 'palette-centered'}`}>
      <div className="modal-backdrop" onClick={onClose} />
      <div
        className={`palette-panel${anchored ? ' anchored' : ''}`}
        role="dialog"
        aria-modal="false"
        style={panelStyle}
      >
        <input type="search" className="palette-input" placeholder={t('insights.palettePlaceholder')} value={palette.q} autoFocus onChange={event => onInput(event.currentTarget.value)} />
        <div className="palette-list">
          {items.length ? items.map((it, i) => (
            <button key={`${it.type}:${it.key}`} type="button" className={`palette-item${i === palette.idx ? ' on' : ''}`} onClick={() => onChoose(it.type, it.key)}>
              <span className="pal-label">{it.label}</span><span className="pal-sub">{it.sub}</span>
            </button>
          )) : <p className="mut palette-empty">{t('insights.paletteEmpty')}</p>}
        </div>
      </div>
    </div>
  );
  return createPortal(node, document.body);
}

function readInitialState() {
  const hp = parseInsightsHash();
  return {
    tab: initialInsightTab(),
    filter: INSIGHT_FILTERS.includes(hp.filter as InsightFilter) ? hp.filter as InsightFilter : 'all',
    cli: new Set<string>((hp.cli ?? '').split(',').filter(Boolean)),
    q: hp.q ?? '',
    sess: hp.sess ?? null,
    project: hp.project ?? '',
    time: hp.time ?? 'all',
    showNoise: hp.noise === '1',
    sort: SESS_SORT_KEYS.includes(hp.sort as SessSort) ? hp.sort as SessSort : 'recent',
    layout: hp.layout === 'table' ? 'table' as const : 'card' as const,
  };
}

function InsightsPage() {
  const tr = useT();
  const initial = useRef(readInitialState()).current;
  const selectedIdRef = useRef<string | null>(null);
  const initialSessRef = useRef<string | null>(initial.sess);
  const detailReqRef = useRef(0);
  const convoReqRef = useRef(0);
  const modalReqRef = useRef(0);
  const [namesVersion, setNamesVersion] = useState(0);
  const [overviewData, setOverviewData] = useState<SafeInsightOverview | null>(null);
  const [records, setRecords] = useState<InsightRecord[]>([]);
  const [statusText, setStatusText] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [tab, setTab] = useState<InsightTab>(initial.tab);
  const [filter, setFilter] = useState<InsightFilter>(initial.filter);
  const [cliFilter, setCliFilter] = useState<Set<string>>(
    // Single-select model: a legacy multi-CLI deep-link (?cli=a,b) collapses to its first CLI
    // so the dropdown label always matches the active filter (was: showed "all" while filtering ≥2).
    initial.cli.size > 1 ? new Set([[...initial.cli][0]!]) : initial.cli,
  );
  const [q, setQ] = useState(initial.q);
  const [project, setProject] = useState(initial.project);
  const [timeWin, setTimeWin] = useState(initial.time);
  const [showNoise, setShowNoise] = useState(initial.showNoise);
  const [sessSort, setSessSort] = useState<SessSort>(initial.sort);
  const [sessLayout, setSessLayout] = useState<'card' | 'table'>(initial.layout);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detailReport, setDetailReport] = useState<SafeInsightReport | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');
  const [detailView, setDetailView] = useState<DetailView>({
    activeId: null,
    tab: 'spans',
    spanFilter: 'all',
    openSpans: new Set<number>(),
    openTurns: new Set<number>(),
    ledgerSort: 'normal',
    openPrompts: new Set<number>(),
    rawPrompts: new Set<number>(),
    ledgerSender: 'all',
    convo: newConvoState(),
  });
  const [openHot, setOpenHot] = useState<Set<string>>(new Set());
  const [palette, setPalette] = useState<PaletteState>({ open: false, q: '', idx: 0 });
  const [modal, setModal] = useState<ModalState>({ turnIndex: null, raw: false, prompt: null, loading: false });
  const [scrollTarget, setScrollTarget] = useState<ScrollTarget>(null);
  const [tip, setTip] = useState<TooltipState>({ text: '', x: 0, y: 0, visible: false });

  const scope = useMemo(() => buildInsightScope(timeWin, project, showNoise), [project, showNoise, timeWin]);
  const cliBase = useMemo(() => filterRecords(records, filter, q, new Set(), scope), [filter, q, records, scope, namesVersion]);
  const presentCliKey = useMemo(() => [...new Set(cliBase.map(cliIdOf))].sort().join(','), [cliBase]);
  const projectBase = useMemo(() => filterRecords(records, filter, q, cliFilter, { ...scope, project: undefined }), [cliFilter, filter, q, records, scope, namesVersion]);
  const projectOpts = useMemo(() => projectOptions(projectBase), [projectBase]);
  const projectDropdownOptions = useMemo(
    () => [
      { value: '', label: tr('insights.projectAll') },
      ...projectOpts.map(o => ({ value: o.id, label: `${o.id} (${o.count})` })),
    ],
    [projectOpts, tr],
  );
  const timeDropdownOptions = useMemo(
    () => TIME_WINDOWS.map(w => ({ value: w.key, label: tr(w.label) })),
    [tr],
  );
  const reviewDropdownOptions = useMemo(
    () => INSIGHT_FILTERS.map(f => ({
      value: f,
      label: f === 'all'
        ? tr('insights.filterAllSessions')
        : f === 'review'
          ? tr('insights.filterReview')
          : f === 'failed'
            ? tr('insights.filterFailed')
            : tr('insights.filterSlow'),
    })),
    [tr],
  );
  const cliDropdownOptions = useMemo(
    () => [
      { value: CLI_FILTER_ALL, label: `${tr('insights.filterAllCli')} (${cliBase.length})` },
      ...cliCounts(cliBase).map(c => ({ value: c.id, label: `${c.id} (${c.count})` })),
    ],
    [cliBase, tr],
  );
  const projectLabel = projectDropdownOptions.find(option => option.value === project)?.label ?? tr('insights.projectAll');
  const timeLabel = timeDropdownOptions.find(option => option.value === timeWin)?.label ?? tr('insights.timeAll');
  const reviewLabel = reviewDropdownOptions.find(option => option.value === filter)?.label ?? tr('insights.filterAllSessions');
  const cliFilterValue = cliFilter.size === 1 ? [...cliFilter][0]! : CLI_FILTER_ALL;
  const cliFilterLabel = cliDropdownOptions.find(option => option.value === cliFilterValue)?.label ?? tr('insights.filterAllCli');
  const rows = useMemo(() => sortRecordsBy(filterRecords(records, filter, q, cliFilter, scope), sessSort), [cliFilter, filter, q, records, scope, sessSort, namesVersion]);
  const overview = useMemo(() => overviewData ? aggregateRecords(rows) : null, [overviewData, rows]);
  const selectedRecord = useMemo(() => selectedId ? rows.find(r => r.session.sessionId === selectedId) ?? records.find(r => r.session.sessionId === selectedId) : undefined, [records, rows, selectedId]);
  const paletteItems = useMemo(() => {
    const ql = palette.q.trim().toLowerCase();
    const tabs = INSIGHT_TABS
      .map(tb => ({ type: 'tab' as const, key: tb.key, label: t(tb.label), sub: t('insights.paletteTabs') }))
      .filter(it => !ql || it.label.toLowerCase().includes(ql));
    const sess = records
      .filter(r => {
        const s = r.session;
        return !ql || `${sessionTitle(s)} ${botDisplayName(s)} ${s.cliId ?? ''}`.toLowerCase().includes(ql);
      })
      .slice(0, 20)
      .map(r => ({ type: 'session' as const, key: String(r.session.sessionId), label: sessionTitle(r.session), sub: `${botDisplayName(r.session)} · ${r.session.cliId ?? '-'}` }));
    return [...tabs, ...sess];
  }, [palette.q, records, namesVersion]);

  const showTip = useCallback((event: React.MouseEvent, text: string) => {
    const pad = 14;
    setTip({ text, x: event.clientX + pad, y: event.clientY + pad, visible: true });
  }, []);
  const hideTip = useCallback(() => setTip(v => ({ ...v, visible: false })), []);

  const patchDetailView = useCallback((patch: Partial<DetailView>) => {
    setDetailView(prev => ({ ...prev, ...patch }));
  }, []);

  const closeModal = useCallback(() => {
    setModal({ turnIndex: null, raw: false, prompt: null, loading: false });
  }, []);

  const resetDetailState = useCallback(() => {
    setDetailReport(null);
    setDetailError('');
    setDetailLoading(false);
    setDetailView({
      activeId: null,
      tab: 'spans',
      spanFilter: 'all',
      openSpans: new Set<number>(),
      openTurns: new Set<number>(),
      ledgerSort: 'normal',
      openPrompts: new Set<number>(),
      rawPrompts: new Set<number>(),
      ledgerSender: 'all',
      convo: newConvoState(),
    });
    setScrollTarget(null);
    closeModal();
  }, [closeModal]);

  const selectSession = useCallback((sessionId: string) => {
    selectedIdRef.current = sessionId;
    setSelectedId(sessionId);
    resetDetailState();
    setDetailLoading(true);
    const req = ++detailReqRef.current;
    void (async () => {
      try {
        const report = await fetchInsightDetail(sessionId);
        if (req !== detailReqRef.current || selectedIdRef.current !== sessionId) return;
        setDetailReport(report);
      } catch (e) {
        if (req !== detailReqRef.current || selectedIdRef.current !== sessionId) return;
        setDetailError(String(e));
      } finally {
        if (req === detailReqRef.current && selectedIdRef.current === sessionId) setDetailLoading(false);
      }
    })();
  }, [resetDetailState]);

  const loadConvo = useCallback((reset: boolean, overrides: Partial<Pick<ConvoState, 'q' | 'role' | 'tag'>> = {}) => {
    const sid = selectedIdRef.current;
    if (!sid || detailView.convo.loading) return;
    const nextQ = overrides.q ?? detailView.convo.q;
    const nextRole = overrides.role ?? detailView.convo.role;
    const nextTag = overrides.tag ?? detailView.convo.tag;
    const offset = reset ? 0 : detailView.convo.nextOffset;
    setDetailView(prev => ({
      ...prev,
      convo: {
        ...prev.convo,
        ...overrides,
        messages: reset ? [] : prev.convo.messages,
        nextOffset: reset ? 0 : prev.convo.nextOffset,
        hasMore: reset ? false : prev.convo.hasMore,
        loading: true,
      },
    }));
    const req = ++convoReqRef.current;
    void (async () => {
      try {
        const c = await fetchInsightConversation(sid, { offset, limit: 40, q: nextQ, role: nextRole, tag: nextTag });
        if (req !== convoReqRef.current || selectedIdRef.current !== sid) return;
        setDetailView(prev => ({
          ...prev,
          convo: {
            ...prev.convo,
            messages: reset ? c.messages : [...prev.convo.messages, ...c.messages],
            total: c.total,
            hasMore: c.hasMore,
            nextOffset: c.nextOffset,
            loading: false,
          },
        }));
      } catch {
        if (req !== convoReqRef.current || selectedIdRef.current !== sid) return;
        setDetailView(prev => ({ ...prev, convo: { ...prev.convo, loading: false } }));
      }
    })();
  }, [detailView.convo]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    setStatusText(tr('insights.loading'));
    try {
      const overviewNext = await fetchInsightsSummary();
      setOverviewData(overviewNext);
      setRecords(overviewNext.sessions.map(toRecord));
      setStatusText(tr('insights.loaded', { count: overviewNext.meta.analyzedSessions }));
    } catch (e) {
      setOverviewData(null);
      setRecords([]);
      setStatusText(`${tr('insights.unavailable')}: ${String(e)}`);
    } finally {
      setRefreshing(false);
    }
  }, [tr]);

  const openPromptModal = useCallback((turnIndex: number) => {
    const sid = selectedIdRef.current;
    if (!sid) return;
    const req = ++modalReqRef.current;
    setModal({ turnIndex, raw: false, prompt: null, loading: true });
    void (async () => {
      try {
        const prompt = await fetchTurnPrompt(sid, turnIndex);
        if (req !== modalReqRef.current || selectedIdRef.current !== sid) return;
        setModal({ turnIndex, raw: false, prompt, loading: false });
      } catch {
        if (req !== modalReqRef.current || selectedIdRef.current !== sid) return;
        setModal({ turnIndex, raw: false, prompt: { text: tr('insights.unavailable'), truncated: false }, loading: false });
      }
    })();
  }, [tr]);

  const jumpToSession = useCallback((sessionId: string) => {
    setTab('sessions');
    selectSession(sessionId);
  }, [selectSession]);

  const openSpanFromVisual = useCallback((idx: number) => {
    patchDetailView({ tab: 'spans', spanFilter: 'all', openSpans: addToSet(detailView.openSpans, idx) });
    setScrollTarget({ kind: 'span', index: idx });
  }, [detailView.openSpans, patchDetailView]);

  const jumpTurnFromRail = useCallback((turn: TurnTimelineTurn) => {
    patchDetailView({
      tab: 'ledger',
      ledgerSort: 'normal',
      ledgerSender: turnSenderKind(turn) === 'system' ? 'system' : detailView.ledgerSender,
      openTurns: addToSet(detailView.openTurns, turn.turnIndex),
    });
    setScrollTarget({ kind: 'turn', index: turn.turnIndex });
  }, [detailView.ledgerSender, detailView.openTurns, patchDetailView]);

  const choosePalette = useCallback((type: 'tab' | 'session', key: string) => {
    setPalette({ open: false, q: '', idx: 0 });
    if (type === 'tab') {
      setTab(key as InsightTab);
      selectedIdRef.current = null;
      setSelectedId(null);
      return;
    }
    jumpToSession(key);
  }, [jumpToSession]);

  useEffect(() => {
    void loadNameMaps().then(() => setNamesVersion(v => v + 1));
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);

  useEffect(() => {
    const present = new Set(presentCliKey.split(',').filter(Boolean));
    setCliFilter(prev => {
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (present.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [presentCliKey]);

  useEffect(() => {
    if (project && !projectOpts.some(o => o.id === project)) setProject('');
  }, [project, projectOpts]);

  useEffect(() => {
    if (selectedId && records.length && !records.some(r => r.session.sessionId === selectedId)) {
      selectedIdRef.current = null;
      setSelectedId(null);
      resetDetailState();
    }
  }, [records, resetDetailState, selectedId]);

  useEffect(() => {
    const want = initialSessRef.current;
    if (!want || selectedId || !records.some(r => r.session.sessionId === want)) return;
    initialSessRef.current = null;
    selectSession(want);
  }, [records, selectSession, selectedId]);

  useEffect(() => {
    if (detailView.tab === 'convo' && !detailView.convo.messages.length && !detailView.convo.loading) loadConvo(true);
  }, [detailView.convo.loading, detailView.convo.messages.length, detailView.tab, loadConvo]);

  useEffect(() => {
    const p: Record<string, string> = {};
    if (tab !== 'overview') p.tab = tab;
    if (filter !== 'all') p.filter = filter;
    if (q.trim()) p.q = q.trim();
    if (project) p.project = project;
    if (timeWin !== 'all') p.time = timeWin;
    if (cliFilter.size) p.cli = [...cliFilter].join(',');
    if (sessSort !== 'recent') p.sort = sessSort;
    if (sessLayout !== 'card') p.layout = sessLayout;
    if (showNoise) p.noise = '1';
    if (selectedId) p.sess = selectedId;
    try { history.replaceState(null, '', buildInsightsHash(p)); } catch { /* ignore */ }
  }, [cliFilter, filter, project, q, selectedId, sessLayout, sessSort, showNoise, tab, timeWin]);

  useEffect(() => {
    const active = palette.open || modal.turnIndex !== null;
    document.body.classList.toggle('insight-modal-open', active);
    return () => document.body.classList.remove('insight-modal-open');
  }, [modal.turnIndex, palette.open]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.key === 'k' || event.key === 'K') && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        setPalette(p => p.open ? { open: false, q: '', idx: 0 } : { open: true, q: '', idx: 0, anchor: undefined });
        return;
      }
      if (palette.open) {
        if (event.isComposing || event.keyCode === 229) return;
        if (event.key === 'Escape') {
          event.preventDefault();
          setPalette({ open: false, q: '', idx: 0 });
        } else if (event.key === 'ArrowDown') {
          event.preventDefault();
          setPalette(p => ({ ...p, idx: Math.min(Math.max(0, paletteItems.length - 1), p.idx + 1) }));
        } else if (event.key === 'ArrowUp') {
          event.preventDefault();
          setPalette(p => ({ ...p, idx: Math.max(0, p.idx - 1) }));
        } else if (event.key === 'Enter') {
          event.preventDefault();
          const it = paletteItems[palette.idx];
          if (it) choosePalette(it.type, it.key);
        }
        return;
      }
      if (event.key === 'Escape' && modal.turnIndex !== null) closeModal();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [choosePalette, closeModal, modal.turnIndex, palette.idx, palette.open, paletteItems]);

  const clearFilters = () => {
    setQ('');
    setFilter('all');
    setCliFilter(new Set());
    setProject('');
    setTimeWin('all');
    setShowNoise(false);
  };

  const emptyHint = !rows.length && !showNoise ? t('insights.emptyAnalyzableHint') : undefined;

  return (
    <section className="page insights-page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">{tr('nav.insights')}</p>
          <div className="insight-title-line">
            <h1>{tr('insights.title')}</h1>
            <InsightTabs active={tab} onChange={next => setTab(next)} />
            <div id="insight-status" className="insight-page-status">{statusText}</div>
          </div>
        </div>
        <div className="page-heading-actions insight-heading-actions">
          <button
            type="button"
            id="insight-palette-open"
            className="insight-palette-trigger"
            onClick={event => {
              setPalette({
                open: true,
                q: '',
                idx: 0,
                anchor: paletteAnchorFromButton(event.currentTarget),
              });
            }}
          >
            {tr('insights.paletteOpen')}
          </button>
        </div>
      </div>
      <form id="insight-filters" className="filters dashboard-toolbar insights-filters" onSubmit={event => event.preventDefault()}>
        <input type="search" name="q" placeholder={tr('insights.search')} value={q} onChange={event => setQ(event.currentTarget.value)} />
        <DropdownMenu
          id="insight-project"
          className="insight-filter-menu"
          ariaLabel={tr('insights.projectAll')}
          label={projectLabel}
          value={project}
          options={projectDropdownOptions}
          onChange={setProject}
        />
        <DropdownMenu
          id="insight-time"
          className="insight-filter-menu"
          ariaLabel={tr('insights.timeAll')}
          label={timeLabel}
          value={timeWin}
          options={timeDropdownOptions}
          onChange={setTimeWin}
        />
        <DropdownMenu
          id="insight-review-filter"
          className="insight-filter-menu insight-review-menu"
          ariaLabel={tr('insights.filter')}
          label={reviewLabel}
          value={filter}
          options={reviewDropdownOptions}
          onChange={setFilter}
        />
        <DropdownMenu
          id="insight-cli-filter"
          className="insight-filter-menu insight-cli-menu"
          ariaLabel={tr('insights.filter')}
          label={cliFilterLabel}
          value={cliFilterValue}
          options={cliDropdownOptions}
          onChange={value => setCliFilter(value === CLI_FILTER_ALL ? new Set() : new Set([value]))}
        />
        <label className="filter-toggle ins-toggle">
          <input type="checkbox" id="insight-noise" checked={showNoise} onChange={event => setShowNoise(event.currentTarget.checked)} />
          <span className="filter-toggle-label">{tr('insights.showAll')}</span>
          <span className="filter-toggle-switch" aria-hidden="true" />
        </label>
        <button type="button" id="insight-clear" className="ins-clear" onClick={clearFilters}>{tr('insights.clear')}</button>
        <div className="insight-head-acts">
          <RefreshIconButton id="insight-refresh" label={tr('insights.refresh')} busy={refreshing} disabled={refreshing} onClick={() => void refresh()} />
        </div>
      </form>
      <div className="insight-panel" role="tabpanel" data-tabpanel="overview" hidden={tab !== 'overview'}>
        <div id="insight-overview">{overview ? <OverviewContent data={overview} /> : null}</div>
      </div>
      <div className="insight-panel" role="tabpanel" data-tabpanel="sessions" hidden={tab !== 'sessions'}>
        {!selectedId ? (
          <div id="insight-list-view">
            <div className="insight-list-head">
              <span id="insight-list-subtitle">{tr('insights.listCount', { shown: rows.length, total: records.length })}</span>
              <div className="sesssort" id="insight-sort"><SortBar sort={sessSort} layout={sessLayout} onSort={setSessSort} onLayout={setSessLayout} /></div>
            </div>
            <div id="insight-list">
              {sessLayout === 'table'
                ? <SessionTable records={rows} selectedId={selectedId} onSelect={selectSession} emptyHint={emptyHint} />
                : <SessionRows records={rows} selectedId={selectedId} wide onSelect={selectSession} emptyHint={emptyHint} />}
            </div>
          </div>
        ) : (
          <div id="insight-detail-view">
            <button type="button" id="insight-back" className="ins-back" onClick={() => { selectedIdRef.current = null; setSelectedId(null); resetDetailState(); }}>← {tr('insights.backToList')}</button>
            <section id="insight-detail" className="insight-detail">
              {selectedRecord ? (
                <>
                  <div className="shead">
                    <h2>{sessionTitle(selectedRecord.session)}</h2>
                    <div className="smeta">{botDisplayName(selectedRecord.session)} · {String(selectedRecord.session.cliId ?? '-')} · <code>{String(selectedRecord.session.sessionId ?? '')}</code></div>
                  </div>
                  <div id="insight-detail-body">
                    {detailLoading ? <LoadingState label={tr('insights.detailLoading')} compact /> : detailError ? <p className="mut">{detailError}</p> : detailReport ? (
                      <DetailBody
                        report={detailReport}
                        view={detailView}
                        onViewChange={patchDetailView}
                        onOpenPrompt={openPromptModal}
                        onJumpTurn={jumpTurnFromRail}
                        onOpenSpan={openSpanFromVisual}
                        scrollTarget={scrollTarget}
                        onScrolled={() => setScrollTarget(null)}
                        onTip={showTip}
                        onTipHide={hideTip}
                        onLoadConvo={loadConvo}
                      />
                    ) : <p className="mut">{tr('insights.selectSession')}</p>}
                  </div>
                </>
              ) : <p className="mut">{tr('insights.selectSession')}</p>}
            </section>
          </div>
        )}
      </div>
      <div className="insight-panel" role="tabpanel" data-tabpanel="flow" hidden={tab !== 'flow'}>
        <div id="insight-flow">{overviewData ? <Flow records={rows} onSession={jumpToSession} /> : null}</div>
      </div>
      <div className="insight-panel" role="tabpanel" data-tabpanel="dist" hidden={tab !== 'dist'}>
        <div id="insight-dist">{overviewData ? <Distribution records={rows} onSort={sort => { setSessSort(sort); setTab('sessions'); selectedIdRef.current = null; setSelectedId(null); }} /> : null}</div>
      </div>
      <div className="insight-panel" role="tabpanel" data-tabpanel="hot" hidden={tab !== 'hot'}>
        <div id="insight-hot">{overviewData ? (
          <Hotspots
            records={rows}
            openHot={openHot}
            onToggleHot={key => setOpenHot(prev => toggleSet(prev, key))}
            onProject={p => { setProject(p); setTab('sessions'); selectedIdRef.current = null; setSelectedId(null); }}
            onSession={jumpToSession}
          />
        ) : null}</div>
      </div>
      <PromptModal modal={modal} onClose={closeModal} onToggleRaw={() => setModal(m => ({ ...m, raw: !m.raw }))} />
      <CommandPalette
        palette={palette}
        items={paletteItems}
        onClose={() => setPalette({ open: false, q: '', idx: 0 })}
        onInput={next => setPalette(prev => ({ ...prev, open: true, q: next, idx: 0 }))}
        onChoose={choosePalette}
      />
      <Tooltip tip={tip} />
    </section>
  );
}

export function renderInsightsPage(root: HTMLElement): PageDisposer {
  return mountReactPage(root, <InsightsPage />);
}
