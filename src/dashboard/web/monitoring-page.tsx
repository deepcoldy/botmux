import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { mountReactPage, type PageDisposer } from './react-mount.js';
import { useT } from './react-hooks.js';
import {
  InfoTip,
  LoadingState,
  OverviewList,
  OverviewListItem,
  OverviewListMain,
  OverviewListTail,
  SectionHeader,
} from './dashboard-components.js';

type ResourceCurrent = {
  supported?: boolean;
  cpuReady?: boolean;
  reason?: string;
  sampledAt?: number;
  intervalMs?: number;
  host?: { cpuPct?: number; memUsedPct?: number; load1?: number };
  botmux?: { cpuPct?: number; rssBytes?: number };
  botmuxBreakdown?: {
    daemon: { cpuPct?: number; rssBytes?: number };
    worker: { cpuPct?: number; rssBytes?: number };
    cli: { cpuPct?: number; rssBytes?: number };
  };
  bots?: ResourceBot[];
  sessions?: ResourceSession[];
  runtime?: RuntimeSummary;
  rankings?: { tracked?: string[] };
};

type ResourceHistory = {
  supported?: boolean;
  host?: ResourceSeries;
  botmux?: ResourceSeries;
  bots?: Array<{ larkAppId: string; botName: string; series: ResourceSeries }>;
  sessions?: Array<{ sessionId: string; larkAppId: string; botName: string; title?: string; series: ResourceSeries }>;
};

type ResourceSeries = {
  timestamps?: number[];
  cpuPct?: number[];
  rssBytes?: number[];
  memUsedPct?: number[];
  rssGrowth5mBytes?: number[];
};

type ResourceBot = {
  larkAppId: string;
  botName: string;
  daemonStatus?: string;
  daemon?: { cpuPct?: number; rssBytes?: number };
  sessions?: { count?: number; cpuPct?: number; rssBytes?: number };
  runtime?: {
    daemonStatus?: string;
    sessions?: {
      total?: number;
      working?: number;
      starting?: number;
      waiting?: number;
    };
  };
  total?: { cpuPct?: number; rssBytes?: number };
};

type RuntimeSummary = {
  sampleHealth?: { status?: string; sampledAt?: number; ageMs?: number; intervalMs?: number };
  daemons?: { total?: number; online?: number; offline?: number };
  sessions?: {
    total?: number;
    working?: number;
    starting?: number;
    idle?: number;
    waiting?: number;
    unknown?: number;
    unattributed?: number;
    longestRunning?: RuntimeSessionRef;
    longestWaiting?: RuntimeSessionRef;
  };
};

type RuntimeSessionRef = {
  sessionId: string;
  larkAppId: string;
  botName: string;
  title?: string;
  status?: string;
  durationMs?: number;
};

type ResourceSession = {
  sessionId: string;
  larkAppId: string;
  botName: string;
  title?: string;
  status?: string;
  tracked?: boolean;
  rankReasons?: string[];
  confidence?: string;
  current?: {
    cpuPct?: number;
    cpu1mPct?: number;
    cpu5mPct?: number;
    rssBytes?: number;
    rssGrowth5mBytes?: number;
  };
  pids?: { sampledPids?: number; workerPid?: number; cliPids?: number[] };
};

type SortKey = 'cpu' | 'rss' | 'growth' | 'bot' | 'status';

type MonitoringPageProps = {
  initialCurrent?: ResourceCurrent | null;
  initialHistory?: ResourceHistory | null;
  poll?: boolean;
};

type ResourceDetail = {
  title: string;
  value: string;
  detail: string;
  chart?: {
    values?: number[];
    timestamps?: number[];
    unit: 'pct' | 'bytes';
    startLabel: string;
    endLabel: string;
    emptyLabel: string;
  };
  emptyText?: string;
};

function formatBytes(value: unknown): string {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return '-';
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GiB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(0)} MiB`;
  return `${Math.max(1, Math.round(n / 1024))} KiB`;
}

function formatPct(value: unknown): string {
  const n = Number(value);
  return Number.isFinite(n) ? `${n.toFixed(1)}%` : '-';
}

function formatCpuPct(value: unknown, cpuReady: boolean): string {
  return cpuReady ? formatPct(value) : '-';
}

function currentCpuReady(current: ResourceCurrent | null | undefined): boolean {
  return current?.cpuReady !== false;
}

function formatCount(value: unknown): string {
  const n = Number(value);
  return Number.isFinite(n) ? String(n) : '-';
}

function formatDuration(value: unknown): string {
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms < 0) return '-';
  if (ms === 0) return '0s';
  if (ms < 60_000) return `${Math.max(1, Math.floor(ms / 1000))}s`;
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${Math.max(1, minutes)}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

function runtimeSampleStatus(value: unknown): 'fresh' | 'stale' | 'unsupported' | 'unknown' {
  return value === 'fresh' || value === 'stale' || value === 'unsupported' ? value : 'unknown';
}

function runtimeSessionLabel(session: RuntimeSessionRef | undefined): string {
  if (!session) return '-';
  return `${session.botName || '-'} · ${session.title || session.sessionId}`;
}

function metricValue(session: ResourceSession, sort: SortKey): number | string {
  if (sort === 'cpu') return Number(session.current?.cpu1mPct ?? session.current?.cpuPct ?? 0);
  if (sort === 'rss') return Number(session.current?.rssBytes ?? 0);
  if (sort === 'growth') return Number(session.current?.rssGrowth5mBytes ?? 0);
  if (sort === 'bot') return session.botName ?? '';
  return session.status ?? '';
}

function sortedSessions(rows: ResourceSession[], sort: SortKey): ResourceSession[] {
  return [...rows].sort((a, b) => {
    const av = metricValue(a, sort);
    const bv = metricValue(b, sort);
    if (typeof av === 'number' && typeof bv === 'number') return bv - av || a.sessionId.localeCompare(b.sessionId);
    return String(av).localeCompare(String(bv)) || a.sessionId.localeCompare(b.sessionId);
  });
}

function formatAxisValue(value: number, unit: 'pct' | 'bytes'): string {
  return unit === 'bytes' ? formatBytes(value) : formatPct(value);
}

function historyStartLabel(timestamps: number[] | undefined, nowMs: number | undefined, tr: (key: string, params?: Record<string, string | number>) => string): string {
  const points = (timestamps ?? []).filter(Number.isFinite);
  if (points.length < 2) return tr('monitoring.chartNoData');
  const first = points[0];
  const now = Number.isFinite(nowMs) ? Number(nowMs) : Date.now();
  const deltaMs = Math.max(0, now - first);
  const minutes = Math.max(1, Math.round(deltaMs / 60_000));
  if (minutes < 60) return tr('monitoring.chartMinutesAgo', { value: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 48) return tr('monitoring.chartHoursAgo', { value: hours });
  return tr('monitoring.chartDaysAgo', { value: Math.round(hours / 24) });
}

function lastFiniteValue(values: number[] | undefined): number | undefined {
  const data = (values ?? []).filter(Number.isFinite);
  return data.length ? data[data.length - 1] : undefined;
}

function Sparkline({
  values,
  timestamps,
  unit = 'pct',
  startLabel,
  endLabel,
  emptyLabel,
  className,
}: {
  values?: number[];
  timestamps?: number[];
  unit?: 'pct' | 'bytes';
  startLabel: string;
  endLabel: string;
  emptyLabel: string;
  className?: string;
}) {
  const data = (values ?? []).filter(Number.isFinite);
  const min = data.length ? Math.min(...data) : 0;
  const max = data.length ? Math.max(...data) : 0;
  const range = max - min;
  const points = data.length > 1
    ? data.map((v, i) => {
      const x = (i / (data.length - 1)) * 100;
      const y = range > 0 ? 100 - ((v - min) / range) * 100 : 50;
      return `${x},${y}`;
    }).join(' ')
    : '';
  const areaPoints = points ? `0,100 ${points} 100,100` : '';
  const pointParts = points ? points.split(' ') : [];
  const lastPoint = pointParts.length ? pointParts[pointParts.length - 1].split(',').map(Number) : null;
  return (
    <div className={['resource-chart', className].filter(Boolean).join(' ')}>
      <div className="resource-chart-y" aria-hidden="true">
        <span>{data.length ? formatAxisValue(max, unit) : '-'}</span>
        <span>{data.length ? formatAxisValue(min, unit) : '-'}</span>
      </div>
      <div className="resource-chart-plot">
        <div className="resource-spark-wrap">
          <svg className="resource-spark" viewBox="0 0 100 100" preserveAspectRatio="none" aria-label={data.length > 1 ? undefined : emptyLabel}>
            <line x1="0" y1="12" x2="100" y2="12" className="resource-grid-line" />
            <line x1="0" y1="50" x2="100" y2="50" className="resource-grid-line" />
            <line x1="0" y1="88" x2="100" y2="88" className="resource-grid-line" />
            {areaPoints ? <polygon className="resource-spark-area" points={areaPoints} /> : null}
            {points ? <polyline points={points} /> : null}
          </svg>
          {lastPoint && Number.isFinite(lastPoint[0]) && Number.isFinite(lastPoint[1]) ? (
            <span
              className="resource-spark-dot"
              aria-hidden="true"
              style={{ left: `${lastPoint[0]}%`, top: `${lastPoint[1]}%` }}
            />
          ) : null}
        </div>
        <div className="resource-chart-x" aria-hidden="true">
          <span>{data.length > 1 ? startLabel : emptyLabel}</span>
          <span>{data.length > 1 ? endLabel : ''}</span>
        </div>
      </div>
    </div>
  );
}

function ExpandableMetricCard(props: { label: string; onOpen(): void; children: ReactNode }) {
  const shouldIgnore = (target: EventTarget | null): boolean => target instanceof Element && !!target.closest('.ui-info-tip');
  return (
    <section
      className="metric-card"
      data-resource-expandable=""
      role="button"
      tabIndex={0}
      aria-label={props.label}
      onClick={event => {
        if (!shouldIgnore(event.target)) props.onOpen();
      }}
      onKeyDown={event => {
        if (shouldIgnore(event.target) || (event.key !== 'Enter' && event.key !== ' ')) return;
        event.preventDefault();
        props.onOpen();
      }}
    >
      {props.children}
    </section>
  );
}

function ExpandableTrendCell(props: { label: string; onOpen(): void; children: ReactNode }) {
  return (
    <article
      className="resource-trend-cell"
      data-resource-expandable=""
      role="button"
      tabIndex={0}
      aria-label={props.label}
      onClick={props.onOpen}
      onKeyDown={event => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        props.onOpen();
      }}
    >
      {props.children}
    </article>
  );
}

function ResourceDetailModal(props: { detail: ResourceDetail | null; onClose(): void }) {
  const tr = useT();
  const dialogRef = useRef<HTMLDialogElement | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (props.detail) {
      if (!dialog.open) {
        try { dialog.showModal(); } catch { /* dialog already opening */ }
      }
    } else if (dialog.open) {
      dialog.close();
    }
  }, [props.detail]);

  useEffect(() => () => {
    const dialog = dialogRef.current;
    if (dialog?.open) dialog.close();
  }, []);

  return (
    <dialog
      ref={dialogRef}
      className="resource-detail-modal"
      onCancel={event => {
        event.preventDefault();
        props.onClose();
      }}
      onClose={props.onClose}
      onClick={event => {
        if (event.target === event.currentTarget) props.onClose();
      }}
    >
      {props.detail ? (
        <article className="resource-detail-modal-card">
          <header className="resource-detail-modal-head">
            <h3>{props.detail.title}</h3>
            <button
              type="button"
              className="resource-detail-modal-close"
              aria-label={tr('monitoring.modalClose')}
              title={tr('monitoring.modalClose')}
              onClick={props.onClose}
            />
          </header>
          <div className="resource-detail-modal-body">
            <section className="resource-detail-summary">
              <strong>{props.detail.value}</strong>
              <p>{props.detail.detail}</p>
            </section>
            {props.detail.chart ? (
              <Sparkline
                className="resource-detail-chart"
                values={props.detail.chart.values}
                timestamps={props.detail.chart.timestamps}
                unit={props.detail.chart.unit}
                startLabel={props.detail.chart.startLabel}
                endLabel={props.detail.chart.endLabel}
                emptyLabel={props.detail.chart.emptyLabel}
              />
            ) : <p className="resource-detail-empty">{props.detail.emptyText}</p>}
          </div>
        </article>
      ) : null}
    </dialog>
  );
}

function RankReasons({ reasons }: { reasons?: string[] }) {
  return <span className="resource-reasons">{(reasons ?? []).join(', ') || '-'}</span>;
}

function ResourcePill({ label, value, tone }: { label: string; value: string; tone?: 'ok' | 'warn' | 'accent' | 'off' }) {
  return (
    <span className={`resource-pill${tone ? ` ${tone}` : ''}`}>
      <span>{label}</span>
      <b>{value}</b>
    </span>
  );
}

function BotRuntimeList({ bots, cpuReady = true }: { bots: ResourceBot[]; cpuReady?: boolean }) {
  const tr = useT();
  return (
    <div className="resource-list-shell">
      <OverviewList className="resource-runtime-list">
        {bots.length ? bots.map(bot => {
          const botRuntime = bot.runtime?.sessions;
          const daemonStatus = bot.runtime?.daemonStatus ?? bot.daemonStatus ?? 'unknown';
          const statusTone = daemonStatus === 'online' ? 'ok' : daemonStatus === 'offline' ? 'off' : 'warn';
          return (
            <OverviewListItem className="resource-list-item resource-bot-item" key={bot.larkAppId}>
              <OverviewListMain>
                <strong title={bot.botName}>{bot.botName}</strong>
                <span>
                  {tr('monitoring.sessionsCount')} {formatCount(botRuntime?.total ?? bot.sessions?.count)}
                </span>
              </OverviewListMain>
              <OverviewListTail>
                <div className="resource-pill-group">
                  <ResourcePill label={tr('monitoring.daemon')} value={daemonStatus} tone={statusTone} />
                  <ResourcePill label={tr('monitoring.working')} value={formatCount(botRuntime?.working)} tone="accent" />
                  <ResourcePill label={tr('monitoring.starting')} value={formatCount(botRuntime?.starting)} />
                  <ResourcePill label={tr('monitoring.cpu')} value={formatCpuPct(bot.total?.cpuPct, cpuReady)} />
                  <ResourcePill label={tr('monitoring.rss')} value={formatBytes(bot.total?.rssBytes)} />
                </div>
              </OverviewListTail>
            </OverviewListItem>
          );
        }) : <li className="empty">{tr('overview.noSessions')}</li>}
      </OverviewList>
    </div>
  );
}

export function SessionResourceTable({ sessions, cpuReady = true }: { sessions: ResourceSession[]; cpuReady?: boolean }) {
  const tr = useT();
  return (
    <div className="resource-list-shell resource-session-shell">
      <OverviewList className="resource-runtime-list resource-session-list">
        {sessions.length ? sessions.map(session => (
          <OverviewListItem
            className={`resource-list-item resource-session-item${session.tracked ? ' is-tracked' : ''}`}
            key={session.sessionId}
          >
            <OverviewListMain>
              <strong title={session.title || session.sessionId}>{session.title || session.sessionId}</strong>
              <span title={session.sessionId}>{session.botName} · {session.sessionId}</span>
            </OverviewListMain>
            <OverviewListTail>
              <div className="resource-pill-group">
                <ResourcePill label={tr('monitoring.cpu')} value={formatCpuPct(session.current?.cpu1mPct ?? session.current?.cpuPct, cpuReady)} tone="accent" />
                <ResourcePill label={tr('monitoring.rss')} value={formatBytes(session.current?.rssBytes)} />
                <ResourcePill label={tr('monitoring.growth')} value={formatBytes(session.current?.rssGrowth5mBytes)} />
                <ResourcePill label={tr('monitoring.confidence')} value={session.confidence ?? 'unknown'} tone={session.tracked ? 'ok' : undefined} />
                <span className="resource-pill resource-rank-pill">
                  <span>{tr('monitoring.rank')}</span>
                  <RankReasons reasons={session.rankReasons} />
                </span>
              </div>
            </OverviewListTail>
          </OverviewListItem>
        )) : <li className="empty">{tr('overview.noSessions')}</li>}
      </OverviewList>
    </div>
  );
}

function RuntimeHealth({ current }: { current: ResourceCurrent }) {
  const tr = useT();
  const runtime = current.runtime;
  const cpuReady = currentCpuReady(current);
  const sampleStatus = runtimeSampleStatus(runtime?.sampleHealth?.status);
  const daemonTotal = runtime?.daemons?.total;
  const daemonOnline = runtime?.daemons?.online;
  const daemonOffline = runtime?.daemons?.offline ?? (
    Number.isFinite(Number(daemonTotal)) && Number.isFinite(Number(daemonOnline))
      ? Math.max(0, Number(daemonTotal) - Number(daemonOnline))
      : undefined
  );
  const sessionTotal = runtime?.sessions?.total;
  const working = runtime?.sessions?.working;
  const starting = runtime?.sessions?.starting;

  return (
    <section className="overview-block resource-block">
      <SectionHeader title={tr('monitoring.runtimeHealth')} />
      <section className="panel runtime-health-panel">
        <div className="runtime-health-grid">
          <section className="metric-card runtime-health-card">
            <span>{tr('monitoring.sampleHealth')}</span>
            <strong><span className={`runtime-status-pill ${sampleStatus}`}>{tr(`monitoring.sample.${sampleStatus}`)}</span></strong>
            <small>{tr('monitoring.sampleAge')} {formatDuration(runtime?.sampleHealth?.ageMs)}</small>
          </section>
          <section className="metric-card runtime-health-card">
            <span>{tr('monitoring.daemonHealth')}</span>
            <strong>{formatCount(daemonOnline)}/{formatCount(daemonTotal)}</strong>
            <small>{formatCount(daemonOffline)} {tr('monitoring.offline')}</small>
          </section>
          <section className="metric-card runtime-health-card">
            <span>{tr('monitoring.sessionHealth')}</span>
            <strong>{formatCount(sessionTotal)}</strong>
            <small>{tr('monitoring.working')} {formatCount(working)} · {tr('monitoring.starting')} {formatCount(starting)}</small>
          </section>
          <section className="metric-card runtime-health-card">
            <span>{tr('monitoring.resourcePressure')}</span>
            <strong>{formatCpuPct(current.host?.cpuPct, cpuReady)}</strong>
            <small>{tr('monitoring.hostMemory')} {formatPct(current.host?.memUsedPct)} · RSS {formatBytes(current.botmux?.rssBytes)}</small>
          </section>
        </div>
      </section>
    </section>
  );
}

function RuntimeSessionPressure({ runtime }: { runtime?: RuntimeSummary }) {
  const tr = useT();
  const sessions = runtime?.sessions;
  const running = sessions?.longestRunning;
  const waiting = sessions?.longestWaiting;

  return (
    <section className="overview-block resource-block">
      <SectionHeader title={tr('monitoring.sessionPressure')} />
      <section className="panel runtime-session-pressure">
        <div className="runtime-session-grid">
          <section className="metric-card runtime-session-card">
            <span>{tr('monitoring.statusDistribution')}</span>
            <strong>{formatCount(sessions?.total)}</strong>
            <small>
              {tr('monitoring.working')} {formatCount(sessions?.working)} · {tr('monitoring.starting')} {formatCount(sessions?.starting)} · {tr('monitoring.waiting')} {formatCount(sessions?.waiting)} · {tr('monitoring.idle')} {formatCount(sessions?.idle)} · {tr('monitoring.unknown')} {formatCount(sessions?.unknown)}
            </small>
          </section>
          <section className="metric-card runtime-session-card">
            <span>{tr('monitoring.longestRunning')}</span>
            <strong>{runtimeSessionLabel(running)}</strong>
            <small>{formatDuration(running?.durationMs)}</small>
          </section>
          <section className="metric-card runtime-session-card">
            <span>{tr('monitoring.longestWaiting')}</span>
            <strong>{runtimeSessionLabel(waiting)}</strong>
            <small>{formatDuration(waiting?.durationMs)}</small>
          </section>
          <section className="metric-card runtime-session-card">
            <span>{tr('monitoring.unattributedSessions')}</span>
            <strong>{formatCount(sessions?.unattributed)}</strong>
            <small>{tr('monitoring.unattributedHint')}</small>
          </section>
        </div>
      </section>
    </section>
  );
}

export function MonitoringPage({ initialCurrent = null, initialHistory = null, poll = true }: MonitoringPageProps = {}) {
  const tr = useT();
  const [current, setCurrent] = useState<ResourceCurrent | null>(initialCurrent);
  const [history, setHistory] = useState<ResourceHistory | null>(initialHistory);
  const [sort, setSort] = useState<SortKey>('cpu');
  const [resourceDetail, setResourceDetail] = useState<ResourceDetail | null>(null);

  useEffect(() => {
    if (!poll) return;
    let disposed = false;
    async function load() {
      try {
        const [currentRes, historyRes] = await Promise.all([
          fetch('/api/resources/current', { cache: 'no-store' }),
          fetch('/api/resources/history?range=3h', { cache: 'no-store' }),
        ]);
        const [nextCurrent, nextHistory] = await Promise.all([currentRes.json(), historyRes.json()]);
        if (!disposed) {
          setCurrent(nextCurrent);
          setHistory(nextHistory);
        }
      } catch {
        if (!disposed) {
          setCurrent({ supported: false, reason: 'fetch_failed', bots: [], sessions: [] });
          setHistory({ supported: false, bots: [], sessions: [] });
        }
      }
    }
    void load();
    const timer = window.setInterval(() => void load(), 10_000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [poll]);

  const ready = current !== null && history !== null;
  const sessions = useMemo(() => sortedSessions(current?.sessions ?? [], sort), [current?.sessions, sort]);
  const supported = current?.supported !== false;
  const cpuReady = currentCpuReady(current);
  const chartLabels = {
    hostStartLabel: historyStartLabel(history?.host?.timestamps, current?.sampledAt, tr),
    botmuxStartLabel: historyStartLabel(history?.botmux?.timestamps, current?.sampledAt, tr),
    endLabel: tr('monitoring.chartNow'),
    emptyLabel: tr('monitoring.chartNoData'),
  };

  return (
    <section className="page resource-page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">{tr('monitoring.eyebrow')}</p>
          <h1>{tr('monitoring.runtimeTitle')}</h1>
        </div>
      </div>

      {!ready ? <LoadingState label={tr('common.loading')} /> : null}

      {ready ? (
        <>
      {current ? <RuntimeHealth current={current} /> : null}

      {!supported ? (
        <section className="panel resource-unavailable">
          <div className="resource-unavailable-card">
            <span className="resource-unavailable-status" aria-hidden="true" />
            <div className="resource-unavailable-copy">
              <span>{tr('monitoring.unsupportedKicker')}</span>
              <h2>{tr('monitoring.unsupportedTitle')}</h2>
              <p>{tr('monitoring.unsupportedHint')}</p>
            </div>
            <div className="resource-unavailable-tags" aria-label={tr('monitoring.unsupported')}>
              <span>{tr('monitoring.unsupportedRuntimeOk')}</span>
              <span>{tr('monitoring.unsupportedResourceOnly')}</span>
            </div>
          </div>
        </section>
      ) : (
        <>
          <section className="overview-block resource-block resource-pressure-block">
            <SectionHeader title={tr('monitoring.resourcePressure')} />
            <section className="panel resource-pressure">
              <div className="resource-metrics runtime-pressure-grid">
                <ExpandableMetricCard
                  label={tr('monitoring.hostCpu')}
                  onOpen={() => setResourceDetail({
                    title: tr('monitoring.hostCpu'),
                    value: formatCpuPct(current?.host?.cpuPct, cpuReady),
                    detail: `load ${Number(current?.host?.load1 ?? 0).toFixed(2)}`,
                    chart: {
                      values: history?.host?.cpuPct,
                      timestamps: history?.host?.timestamps,
                      unit: 'pct',
                      startLabel: chartLabels.hostStartLabel,
                      endLabel: chartLabels.endLabel,
                      emptyLabel: chartLabels.emptyLabel,
                    },
                  })}
                >
                  <span>{tr('monitoring.hostCpu')}</span>
                  <strong>{formatCpuPct(current?.host?.cpuPct, cpuReady)}</strong>
                  <small>load {Number(current?.host?.load1 ?? 0).toFixed(2)}</small>
                </ExpandableMetricCard>
                <ExpandableMetricCard
                  label={tr('monitoring.hostMemory')}
                  onOpen={() => setResourceDetail({
                    title: tr('monitoring.hostMemory'),
                    value: formatPct(current?.host?.memUsedPct),
                    detail: tr('monitoring.memoryOnly'),
                    chart: {
                      values: history?.host?.memUsedPct,
                      timestamps: history?.host?.timestamps,
                      unit: 'pct',
                      startLabel: chartLabels.hostStartLabel,
                      endLabel: chartLabels.endLabel,
                      emptyLabel: chartLabels.emptyLabel,
                    },
                  })}
                >
                  <span>{tr('monitoring.hostMemory')}</span>
                  <strong>{formatPct(current?.host?.memUsedPct)}</strong>
                  <small>{tr('monitoring.memoryOnly')}</small>
                </ExpandableMetricCard>
                <ExpandableMetricCard
                  label={tr('monitoring.botmuxRss')}
                  onOpen={() => setResourceDetail({
                    title: tr('monitoring.botmuxRss'),
                    value: formatBytes(current?.botmux?.rssBytes),
                    detail: current?.botmuxBreakdown
                      ? `${tr('monitoring.botmuxSelf')} ${formatBytes((current.botmuxBreakdown.daemon.rssBytes ?? 0) + (current.botmuxBreakdown.worker.rssBytes ?? 0))}\n${tr('monitoring.botmuxCli')} ${formatBytes(current.botmuxBreakdown.cli.rssBytes)}`
                      : formatCpuPct(current?.botmux?.cpuPct, cpuReady),
                    chart: {
                      values: history?.botmux?.rssBytes,
                      timestamps: history?.botmux?.timestamps,
                      unit: 'bytes',
                      startLabel: chartLabels.botmuxStartLabel,
                      endLabel: chartLabels.endLabel,
                      emptyLabel: chartLabels.emptyLabel,
                    },
                  })}
                >
                  <div className="metric-label-with-help">
                    <span>{tr('monitoring.botmuxRss')}</span>
                    <InfoTip label={tr('monitoring.rssHelpLabel')}>{tr('monitoring.rssHelp')}</InfoTip>
                  </div>
                  <strong>{formatBytes(current?.botmux?.rssBytes)}</strong>
                  {current?.botmuxBreakdown && (
                    <>
                      <small className="metric-breakdown">
                        {tr('monitoring.botmuxSelf')} {formatBytes((current.botmuxBreakdown.daemon.rssBytes ?? 0) + (current.botmuxBreakdown.worker.rssBytes ?? 0))}
                        <span className="metric-breakdown-detail"> ({tr('monitoring.botmuxDaemon')} {formatBytes(current.botmuxBreakdown.daemon.rssBytes)} · {tr('monitoring.botmuxWorker')} {formatBytes(current.botmuxBreakdown.worker.rssBytes)})</span>
                      </small>
                      <small className="metric-breakdown">
                        {tr('monitoring.botmuxCli')} {formatBytes(current.botmuxBreakdown.cli.rssBytes)}
                      </small>
                    </>
                  )}
                </ExpandableMetricCard>
                <ExpandableMetricCard
                  label={tr('monitoring.trackedSessions')}
                  onOpen={() => setResourceDetail({
                    title: tr('monitoring.trackedSessions'),
                    value: formatCount(current?.rankings?.tracked?.length),
                    detail: `${tr('monitoring.currentSessions')} ${(current?.sessions ?? []).length}`,
                    emptyText: tr('monitoring.trackedSessionHint'),
                  })}
                >
                  <span>{tr('monitoring.trackedSessions')}</span>
                  <strong>{current?.rankings?.tracked?.length ?? 0}</strong>
                  <small>{tr('monitoring.currentSessions')} {(current?.sessions ?? []).length}</small>
                </ExpandableMetricCard>
              </div>
            </section>
          </section>

          <section className="overview-block resource-block">
            <SectionHeader title={tr('monitoring.trends')} />
            <section className="panel resource-trends">
              <div className="resource-trend-grid">
                <ExpandableTrendCell
                  label={tr('monitoring.trendHostCpu')}
                  onOpen={() => setResourceDetail({
                    title: tr('monitoring.trendHostCpu'),
                    value: formatPct(lastFiniteValue(history?.host?.cpuPct)),
                    detail: `load ${Number(current?.host?.load1 ?? 0).toFixed(2)}`,
                    chart: {
                      values: history?.host?.cpuPct,
                      timestamps: history?.host?.timestamps,
                      unit: 'pct',
                      startLabel: chartLabels.hostStartLabel,
                      endLabel: chartLabels.endLabel,
                      emptyLabel: chartLabels.emptyLabel,
                    },
                  })}
                >
                  <b>{tr('monitoring.trendHostCpu')}</b>
                  <Sparkline values={history?.host?.cpuPct} timestamps={history?.host?.timestamps} unit="pct" startLabel={chartLabels.hostStartLabel} endLabel={chartLabels.endLabel} emptyLabel={chartLabels.emptyLabel} />
                </ExpandableTrendCell>
                <ExpandableTrendCell
                  label={tr('monitoring.trendHostMemory')}
                  onOpen={() => setResourceDetail({
                    title: tr('monitoring.trendHostMemory'),
                    value: formatPct(lastFiniteValue(history?.host?.memUsedPct)),
                    detail: tr('monitoring.memoryOnly'),
                    chart: {
                      values: history?.host?.memUsedPct,
                      timestamps: history?.host?.timestamps,
                      unit: 'pct',
                      startLabel: chartLabels.hostStartLabel,
                      endLabel: chartLabels.endLabel,
                      emptyLabel: chartLabels.emptyLabel,
                    },
                  })}
                >
                  <b>{tr('monitoring.trendHostMemory')}</b>
                  <Sparkline values={history?.host?.memUsedPct} timestamps={history?.host?.timestamps} unit="pct" startLabel={chartLabels.hostStartLabel} endLabel={chartLabels.endLabel} emptyLabel={chartLabels.emptyLabel} />
                </ExpandableTrendCell>
                <ExpandableTrendCell
                  label={tr('monitoring.trendBotmuxCpu')}
                  onOpen={() => setResourceDetail({
                    title: tr('monitoring.trendBotmuxCpu'),
                    value: formatPct(lastFiniteValue(history?.botmux?.cpuPct)),
                    detail: tr('monitoring.botRuntime'),
                    chart: {
                      values: history?.botmux?.cpuPct,
                      timestamps: history?.botmux?.timestamps,
                      unit: 'pct',
                      startLabel: chartLabels.botmuxStartLabel,
                      endLabel: chartLabels.endLabel,
                      emptyLabel: chartLabels.emptyLabel,
                    },
                  })}
                >
                  <b>{tr('monitoring.trendBotmuxCpu')}</b>
                  <Sparkline values={history?.botmux?.cpuPct} timestamps={history?.botmux?.timestamps} unit="pct" startLabel={chartLabels.botmuxStartLabel} endLabel={chartLabels.endLabel} emptyLabel={chartLabels.emptyLabel} />
                </ExpandableTrendCell>
                <ExpandableTrendCell
                  label={tr('monitoring.botmuxRss')}
                  onOpen={() => setResourceDetail({
                    title: tr('monitoring.botmuxRss'),
                    value: formatBytes(lastFiniteValue(history?.botmux?.rssBytes)),
                    detail: tr('monitoring.memoryOnly'),
                    chart: {
                      values: history?.botmux?.rssBytes,
                      timestamps: history?.botmux?.timestamps,
                      unit: 'bytes',
                      startLabel: chartLabels.botmuxStartLabel,
                      endLabel: chartLabels.endLabel,
                      emptyLabel: chartLabels.emptyLabel,
                    },
                  })}
                >
                  <b>{tr('monitoring.botmuxRss')}</b>
                  <Sparkline values={history?.botmux?.rssBytes} timestamps={history?.botmux?.timestamps} unit="bytes" startLabel={chartLabels.botmuxStartLabel} endLabel={chartLabels.endLabel} emptyLabel={chartLabels.emptyLabel} />
                </ExpandableTrendCell>
              </div>
            </section>
          </section>
        </>
      )}

      {current ? <RuntimeSessionPressure runtime={current.runtime} /> : null}

      {supported ? (
        <>
          <section className="overview-block resource-block">
            <SectionHeader title={tr('monitoring.botRuntime')} />
            <section className="panel">
              <BotRuntimeList bots={current?.bots ?? []} cpuReady={cpuReady} />
            </section>
          </section>

          <section className="overview-block resource-block">
            <SectionHeader title={tr('monitoring.sessions')}>
              <div className="resource-sortbar resource-sortbar-inline dashboard-toolbar" role="group" aria-label={tr('monitoring.sort')}>
                <div className="segmented resource-sort-switch">
                  {(['cpu', 'rss', 'growth', 'bot', 'status'] as const).map(key => (
                    <button
                      type="button"
                      className={sort === key ? 'active' : undefined}
                      aria-pressed={sort === key}
                      key={key}
                      onClick={() => setSort(key)}
                    >
                      {tr(`monitoring.sort.${key}`)}
                    </button>
                  ))}
                </div>
              </div>
            </SectionHeader>
            <section className="panel">
              <SessionResourceTable sessions={sessions} cpuReady={cpuReady} />
            </section>
          </section>

          <section className="overview-block resource-block">
            <SectionHeader title={tr('monitoring.trackedSessionTrends')} />
            <section className="panel">
              <div className="resource-trend-grid">
                {(history?.sessions ?? []).map(session => {
                  const title = `${session.botName} · ${session.title || session.sessionId}`;
                  const startLabel = historyStartLabel(session.series?.timestamps, current?.sampledAt, tr);
                  return (
                    <ExpandableTrendCell
                      key={session.sessionId}
                      label={title}
                      onOpen={() => setResourceDetail({
                        title,
                        value: formatBytes(lastFiniteValue(session.series?.rssBytes)),
                        detail: session.sessionId,
                        chart: {
                          values: session.series?.rssBytes,
                          timestamps: session.series?.timestamps,
                          unit: 'bytes',
                          startLabel,
                          endLabel: chartLabels.endLabel,
                          emptyLabel: chartLabels.emptyLabel,
                        },
                      })}
                    >
                      <b title={title}>{title}</b>
                      <Sparkline
                        values={session.series?.rssBytes}
                        timestamps={session.series?.timestamps}
                        unit="bytes"
                        startLabel={startLabel}
                        endLabel={chartLabels.endLabel}
                        emptyLabel={chartLabels.emptyLabel}
                      />
                    </ExpandableTrendCell>
                  );
                })}
                {!(history?.sessions ?? []).length ? <div className="empty">{tr('monitoring.noTrackedHistory')}</div> : null}
              </div>
            </section>
          </section>
        </>
      ) : null}
        </>
      ) : null}
      <ResourceDetailModal detail={resourceDetail} onClose={() => setResourceDetail(null)} />
    </section>
  );
}

export function renderMonitoringPage(root: HTMLElement): PageDisposer {
  return mountReactPage(root, <MonitoringPage />);
}
