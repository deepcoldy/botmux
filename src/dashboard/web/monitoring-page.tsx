import { useEffect, useMemo, useState } from 'react';
import { mountReactPage, type PageDisposer } from './react-mount.js';
import { useT } from './react-hooks.js';

type ResourceCurrent = {
  supported?: boolean;
  reason?: string;
  sampledAt?: number;
  intervalMs?: number;
  host?: { cpuPct?: number; memUsedPct?: number; load1?: number };
  botmux?: { cpuPct?: number; rssBytes?: number };
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

function formatCount(value: unknown): string {
  const n = Number(value);
  return Number.isFinite(n) ? String(n) : '0';
}

function formatDuration(value: unknown): string {
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms <= 0) return '-';
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

function Sparkline({
  values,
  timestamps,
  unit = 'pct',
  startLabel,
  endLabel,
  emptyLabel,
}: {
  values?: number[];
  timestamps?: number[];
  unit?: 'pct' | 'bytes';
  startLabel: string;
  endLabel: string;
  emptyLabel: string;
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
  return (
    <div className="resource-chart">
      <div className="resource-chart-y" aria-hidden="true">
        <span>{data.length ? formatAxisValue(max, unit) : '-'}</span>
        <span>{data.length ? formatAxisValue(min, unit) : '-'}</span>
      </div>
      <div className="resource-chart-plot">
        <svg className="resource-spark" viewBox="0 0 100 100" preserveAspectRatio="none" aria-label={data.length > 1 ? undefined : emptyLabel}>
          <line x1="0" y1="12" x2="100" y2="12" className="resource-grid-line" />
          <line x1="0" y1="50" x2="100" y2="50" className="resource-grid-line" />
          <line x1="0" y1="88" x2="100" y2="88" className="resource-grid-line" />
          {points ? <polyline points={points} /> : null}
        </svg>
        <div className="resource-chart-x" aria-hidden="true">
          <span>{data.length > 1 ? startLabel : emptyLabel}</span>
          <span>{data.length > 1 ? endLabel : ''}</span>
        </div>
      </div>
    </div>
  );
}

function RankReasons({ reasons }: { reasons?: string[] }) {
  return <span className="resource-reasons">{(reasons ?? []).join(', ') || '-'}</span>;
}

export function SessionResourceTable({ sessions }: { sessions: ResourceSession[] }) {
  const tr = useT();
  return (
    <div className="resource-table resource-session-table">
      <div className="resource-row resource-row-head">
        <span>{tr('monitoring.session')}</span><span>{tr('monitoring.bot')}</span><span>{tr('monitoring.cpu')}</span><span>{tr('monitoring.rss')}</span><span>{tr('monitoring.growth')}</span><span>{tr('monitoring.confidence')}</span><span>{tr('monitoring.rank')}</span>
      </div>
      <div className="resource-session-scroll" data-visible-rows={10}>
        {sessions.length ? sessions.map(session => (
          <div className={`resource-row${session.tracked ? ' is-tracked' : ''}`} key={session.sessionId}>
            <b>{session.title || session.sessionId}</b>
            <span>{session.botName}</span>
            <span>{formatPct(session.current?.cpu1mPct ?? session.current?.cpuPct)}</span>
            <span>{formatBytes(session.current?.rssBytes)}</span>
            <span>{formatBytes(session.current?.rssGrowth5mBytes)}</span>
            <span>{session.confidence ?? 'unknown'}</span>
            <RankReasons reasons={session.rankReasons} />
          </div>
        )) : <div className="empty">{tr('overview.noSessions')}</div>}
      </div>
    </div>
  );
}

function HelpTip({ label, text }: { label: string; text: string }) {
  return (
    <span className="resource-help-tip">
      <button type="button" className="help-icon-button resource-help-button" aria-label={label}>?</button>
      <span className="resource-help-popover" role="tooltip">{text}</span>
    </span>
  );
}

function RuntimeHealth({ current }: { current: ResourceCurrent }) {
  const tr = useT();
  const runtime = current.runtime;
  const sampleStatus = runtimeSampleStatus(runtime?.sampleHealth?.status);
  const daemonTotal = runtime?.daemons?.total ?? 0;
  const daemonOnline = runtime?.daemons?.online ?? 0;
  const daemonOffline = runtime?.daemons?.offline ?? Math.max(0, daemonTotal - daemonOnline);
  const sessionTotal = runtime?.sessions?.total ?? 0;
  const working = runtime?.sessions?.working ?? 0;
  const starting = runtime?.sessions?.starting ?? 0;

  return (
    <section className="panel runtime-health-panel">
      <header className="panel-header">
        <div>
          <h2>{tr('monitoring.runtimeHealth')}</h2>
          <p>{tr('monitoring.runtimeHealthHint')}</p>
        </div>
      </header>
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
          <strong>{formatPct(current.host?.cpuPct)}</strong>
          <small>{tr('monitoring.hostMemory')} {formatPct(current.host?.memUsedPct)} · RSS {formatBytes(current.botmux?.rssBytes)}</small>
        </section>
      </div>
    </section>
  );
}

function RuntimeSessionPressure({ runtime }: { runtime?: RuntimeSummary }) {
  const tr = useT();
  const sessions = runtime?.sessions;
  const running = sessions?.longestRunning;
  const waiting = sessions?.longestWaiting;

  return (
    <section className="panel runtime-session-pressure">
      <header className="panel-header">
        <div>
          <h2>{tr('monitoring.sessionPressure')}</h2>
          <p>{tr('monitoring.sessionPressureHint')}</p>
        </div>
      </header>
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
  );
}

function MonitoringPage() {
  const tr = useT();
  const [current, setCurrent] = useState<ResourceCurrent | null>(null);
  const [history, setHistory] = useState<ResourceHistory | null>(null);
  const [sort, setSort] = useState<SortKey>('cpu');

  useEffect(() => {
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
  }, []);

  const sessions = useMemo(() => sortedSessions(current?.sessions ?? [], sort), [current?.sessions, sort]);
  const hottest = sessions[0];
  const supported = current?.supported !== false;
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
          <p>{tr('monitoring.runtimeSubtitle')}</p>
        </div>
      </div>

      {current ? <RuntimeHealth current={current} /> : null}

      {!supported ? (
        <section className="panel resource-unavailable">
          <h2>{tr('monitoring.unsupported')}</h2>
          <p>{current?.reason ?? 'procfs_unavailable'}</p>
        </section>
      ) : (
        <>
          <section className="panel resource-pressure">
            <header className="panel-header">
              <div>
                <h2>{tr('monitoring.resourcePressure')}</h2>
                <p>{tr('monitoring.resourcePressureHint')}</p>
              </div>
            </header>
            <div className="resource-metrics runtime-pressure-grid">
              <section className="metric-card"><span>{tr('monitoring.hostCpu')}</span><strong>{formatPct(current?.host?.cpuPct)}</strong><small>load {Number(current?.host?.load1 ?? 0).toFixed(2)}</small></section>
              <section className="metric-card"><span>{tr('monitoring.hostMemory')}</span><strong>{formatPct(current?.host?.memUsedPct)}</strong><small>{tr('monitoring.memoryOnly')}</small></section>
              <section className="metric-card">
                <div className="metric-label-with-help">
                  <span>{tr('monitoring.botmuxRss')}</span>
                  <HelpTip label={tr('monitoring.rssHelpLabel')} text={tr('monitoring.rssHelp')} />
                </div>
                <strong>{formatBytes(current?.botmux?.rssBytes)}</strong>
                <small>{formatPct(current?.botmux?.cpuPct)}</small>
              </section>
              <section className="metric-card"><span>{tr('monitoring.trackedSessions')}</span><strong>{current?.rankings?.tracked?.length ?? 0}</strong><small>{tr('monitoring.currentSessions')} {(current?.sessions ?? []).length}</small></section>
            </div>
          </section>

          <section className="panel resource-trends">
            <header className="panel-header">
              <div>
                <h2>{tr('monitoring.trends')}</h2>
                <p>{tr('monitoring.trendsHint')}</p>
              </div>
            </header>
            <div className="resource-trend-grid">
              <article className="resource-trend-cell">
                <b>{tr('monitoring.trendHostCpu')}</b>
                <Sparkline values={history?.host?.cpuPct} timestamps={history?.host?.timestamps} unit="pct" startLabel={chartLabels.hostStartLabel} endLabel={chartLabels.endLabel} emptyLabel={chartLabels.emptyLabel} />
              </article>
              <article className="resource-trend-cell">
                <b>{tr('monitoring.trendHostMemory')}</b>
                <Sparkline values={history?.host?.memUsedPct} timestamps={history?.host?.timestamps} unit="pct" startLabel={chartLabels.hostStartLabel} endLabel={chartLabels.endLabel} emptyLabel={chartLabels.emptyLabel} />
              </article>
              <article className="resource-trend-cell">
                <b>{tr('monitoring.trendBotmuxCpu')}</b>
                <Sparkline values={history?.botmux?.cpuPct} timestamps={history?.botmux?.timestamps} unit="pct" startLabel={chartLabels.botmuxStartLabel} endLabel={chartLabels.endLabel} emptyLabel={chartLabels.emptyLabel} />
              </article>
              <article className="resource-trend-cell">
                <b>{tr('monitoring.botmuxRss')}</b>
                <Sparkline values={history?.botmux?.rssBytes} timestamps={history?.botmux?.timestamps} unit="bytes" startLabel={chartLabels.botmuxStartLabel} endLabel={chartLabels.endLabel} emptyLabel={chartLabels.emptyLabel} />
              </article>
            </div>
          </section>
        </>
      )}

      {current ? <RuntimeSessionPressure runtime={current.runtime} /> : null}

      {supported ? (
        <>
          <section className="panel">
            <header className="panel-header">
              <div>
                <h2>{tr('monitoring.botRuntime')}</h2>
                <p>{tr('monitoring.botRuntimeHint')}</p>
              </div>
            </header>
            <div className="resource-table resource-bot-table">
              <div className="resource-row resource-row-head">
                <span>{tr('monitoring.bot')}</span><span>{tr('monitoring.daemon')}</span><span>{tr('monitoring.sessionsCount')}</span><span>{tr('monitoring.working')}</span><span>{tr('monitoring.starting')}</span><span>{tr('monitoring.cpu')}</span><span>{tr('monitoring.rss')}</span>
              </div>
              {(current?.bots ?? []).map(bot => {
                const botRuntime = bot.runtime?.sessions;
                return (
                  <div className="resource-row" key={bot.larkAppId}>
                    <b>{bot.botName}</b>
                    <span>{bot.runtime?.daemonStatus ?? bot.daemonStatus ?? 'unknown'}</span>
                    <span>{formatCount(botRuntime?.total ?? bot.sessions?.count)}</span>
                    <span>{formatCount(botRuntime?.working)}</span>
                    <span>{formatCount(botRuntime?.starting)}</span>
                    <span>{formatPct(bot.total?.cpuPct)}</span>
                    <span>{formatBytes(bot.total?.rssBytes)}</span>
                  </div>
                );
              })}
            </div>
          </section>

          <section className="panel">
            <header className="panel-header">
              <div>
                <h2>{tr('monitoring.sessions')}</h2>
                <p>{tr('monitoring.sessionsHint')}</p>
              </div>
              {hottest ? <span className="resource-hot">{tr('monitoring.hottest')}: {hottest.botName} · {hottest.title || hottest.sessionId}</span> : null}
            </header>
            <div className="resource-sortbar" role="group" aria-label={tr('monitoring.sort')}>
              {(['cpu', 'rss', 'growth', 'bot', 'status'] as const).map(key => (
                <button type="button" className={sort === key ? 'on' : ''} key={key} onClick={() => setSort(key)}>
                  {tr(`monitoring.sort.${key}`)}
                </button>
              ))}
            </div>
            <SessionResourceTable sessions={sessions} />
          </section>

          <section className="panel">
            <header className="panel-header">
              <div>
                <h2>{tr('monitoring.trackedSessionTrends')}</h2>
                <p>{tr('monitoring.trackedSessionHint')}</p>
              </div>
            </header>
            <div className="resource-trend-grid">
              {(history?.sessions ?? []).map(session => (
                <article className="resource-trend-cell" key={session.sessionId}>
                  <b>{session.botName} · {session.title || session.sessionId}</b>
                  <Sparkline
                    values={session.series?.rssBytes}
                    timestamps={session.series?.timestamps}
                    unit="bytes"
                    startLabel={historyStartLabel(session.series?.timestamps, current?.sampledAt, tr)}
                    endLabel={chartLabels.endLabel}
                    emptyLabel={chartLabels.emptyLabel}
                  />
                </article>
              ))}
              {!(history?.sessions ?? []).length ? <div className="empty">{tr('monitoring.noTrackedHistory')}</div> : null}
            </div>
          </section>
        </>
      ) : null}
    </section>
  );
}

export function renderMonitoringPage(root: HTMLElement): PageDisposer {
  return mountReactPage(root, <MonitoringPage />);
}
