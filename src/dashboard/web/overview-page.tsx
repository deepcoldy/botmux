import { useEffect, useMemo, useRef, useState } from 'react';
import { mountReactPage, type PageDisposer } from './react-mount.js';
import { useStoreSelector, useT } from './react-hooks.js';
import {
  attentionReason,
  attentionWaitSince,
  botAvatarHtml,
  botDisplayName,
  chatDisplayTitle,
  loadNameMaps,
  relTime,
  stripMentionPrefix,
  t,
} from './ui.js';
import { buildBotCards, loadGroupsSnapshot, type BotCard } from './overview.js';

type SessionRow = Record<string, any> & { sessionId: string };
type ScheduleRow = Record<string, any> & { id: string };
type ResourceSummary = {
  supported?: boolean;
  cpuReady?: boolean;
  host?: { cpuPct?: number; memUsedPct?: number; memTotalBytes?: number };
  botmux?: { rssBytes?: number };
  sessions?: Array<{ sessionId: string }>;
  runtime?: {
    sampleHealth?: { status?: string };
    sessions?: { total?: number; working?: number; starting?: number; waiting?: number };
  };
};
type ResourceHealth = 'ok' | 'warn' | 'danger' | 'unknown';
type RuntimeSessionSummary = NonNullable<NonNullable<ResourceSummary['runtime']>['sessions']>;

const BUSY_STATUSES = new Set(['working', 'analyzing', 'active', 'starting']);
const IDLE_STATUSES = new Set(['idle', 'dormant']);
const TEAM_EXPAND_KEY = 'botmux.overview.teamExpanded';
const TEAM_CARD_MIN_W = 230;
const TEAM_GRID_GAP = 13;
const TEAM_COLLAPSED_ROWS = 2;

function Html(props: { html: string }) {
  return <span style={{ display: 'contents' }} dangerouslySetInnerHTML={{ __html: props.html }} />;
}

function readTeamExpanded(): boolean {
  try { return window.localStorage.getItem(TEAM_EXPAND_KEY) === '1'; } catch { return false; }
}

function persistTeamExpanded(v: boolean): void {
  try { window.localStorage.setItem(TEAM_EXPAND_KEY, v ? '1' : '0'); } catch { /* silent */ }
}

function statusToken(status: unknown): string {
  return String(status ?? 'unknown').toLowerCase().replace(/[^a-z0-9_-]/g, '-');
}

function sessionStatusText(status: unknown, tr: (key: string) => string): string {
  const raw = String(status ?? 'unknown');
  const key = `sessions.status.${raw}`;
  const label = tr(key);
  return label === key ? raw : label;
}

function resourcePct(value: unknown): string {
  const n = Number(value);
  return Number.isFinite(n) ? `${n.toFixed(1)}%` : '-';
}

function resourceBytes(value: unknown): string {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return '-';
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GiB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(0)} MiB`;
  return `${Math.max(1, Math.round(n / 1024))} KiB`;
}

function pctHealth(value: unknown, warnAt: number, dangerAt: number, ready = true): ResourceHealth {
  const n = Number(value);
  if (!ready || !Number.isFinite(n)) return 'unknown';
  if (n >= dangerAt) return 'danger';
  if (n >= warnAt) return 'warn';
  return 'ok';
}

function rssHealth(rssBytes: unknown, memTotalBytes: unknown): ResourceHealth {
  const rss = Number(rssBytes);
  if (!Number.isFinite(rss) || rss <= 0) return 'unknown';
  const total = Number(memTotalBytes);
  if (Number.isFinite(total) && total > 0) return pctHealth((rss / total) * 100, 30, 50);
  const gib = rss / (1024 ** 3);
  if (gib >= 32) return 'danger';
  if (gib >= 16) return 'warn';
  return 'ok';
}

function sampleHealth(status: unknown): ResourceHealth {
  if (status === 'fresh') return 'ok';
  if (status === 'stale') return 'danger';
  return 'unknown';
}

function sessionPressureHealth(sessions?: RuntimeSessionSummary): ResourceHealth {
  if (!sessions) return 'unknown';
  const waiting = Number(sessions.waiting ?? 0);
  const starting = Number(sessions.starting ?? 0);
  if (waiting >= 5 || starting >= 20) return 'danger';
  if (waiting > 0 || starting >= 10) return 'warn';
  return 'ok';
}

function combinedHealth(values: ResourceHealth[]): ResourceHealth {
  if (values.includes('danger')) return 'danger';
  if (values.includes('warn')) return 'warn';
  if (values.includes('ok')) return 'ok';
  return 'unknown';
}

function sessionSummaryText(resources: ResourceSummary | null, tr: (key: string) => string): string {
  const runtime = resources?.runtime?.sessions;
  const total = runtime?.total ?? resources?.sessions?.length;
  if (!Number.isFinite(Number(total))) return '-';
  const waiting = Number(runtime?.waiting ?? 0);
  return `${Number(total)} · ${tr('monitoring.waiting')} ${waiting}`;
}

function collapsedCardCount(gridEl: HTMLElement | null): number {
  const width = gridEl?.clientWidth ?? 0;
  if (!width) return TEAM_COLLAPSED_ROWS * 3;
  const cols = Math.max(1, Math.floor((width + TEAM_GRID_GAP) / (TEAM_CARD_MIN_W + TEAM_GRID_GAP)));
  return cols * TEAM_COLLAPSED_ROWS;
}

function MateCard({ card }: { card: BotCard }) {
  const tr = useT();
  const offline = !card.online && card.active.length === 0;
  const needsYou = card.attention.length > 0;
  const busy = card.busy.length > 0;
  const dotClass = needsYou ? 'warn' : busy ? 'busy' : offline ? 'off' : 'ok';
  let task: JSX.Element | string;
  if (needsYou) {
    const a = [...card.attention].sort((x, y) => attentionWaitSince(x) - attentionWaitSince(y))[0];
    task = <><b>{(stripMentionPrefix(a.title) || a.sessionId).slice(0, 60)}</b>{' · '}{attentionReason(a) ?? ''}</>;
  } else if (busy) {
    const w = [...card.busy].sort((x, y) => Number(y.lastMessageAt ?? 0) - Number(x.lastMessageAt ?? 0))[0];
    task = <b>{(stripMentionPrefix(w.title) || w.sessionId).slice(0, 60)}</b>;
  } else if (offline) {
    task = tr('overview.botOffline');
  } else {
    task = tr('overview.botIdle');
  }
  const tag = needsYou
    ? <span className="tag tag-warn">{tr('overview.botNeedsYou')}</span>
    : busy
      ? <span className="tag tag-run">{tr('overview.botBusy', { count: card.busy.length })}</span>
      : offline
        ? <span className="tag tag-off">{tr('overview.botOff')}</span>
        : <span className="tag tag-ok">{tr('overview.botReady')}</span>;

  return (
    <article className={`mate${needsYou ? ' mate-attn' : ''}${offline ? ' mate-off' : ''}`}>
      <div className="mate-top">
        <Html html={botAvatarHtml({ name: card.botName, larkAppId: card.larkAppId, avatarUrl: card.botAvatarUrl, dot: dotClass })} />
        <div className="mate-id">
          <b>{card.botName}</b>
          <span className="mate-role">{card.cliId}</span>
        </div>
      </div>
      <div className="mate-task">{task}</div>
      <div className="mate-foot">
        {tag}
        <span>{card.lastActiveAt ? tr('overview.lastActive', { time: relTime(card.lastActiveAt) }) : tr('common.never')}</span>
      </div>
    </article>
  );
}

function AttentionCard({ session }: { session: SessionRow }) {
  const tr = useT();
  const botName = botDisplayName(session);
  return (
    <article className="qcard" data-id={session.sessionId}>
      <Html html={botAvatarHtml({ name: botName, larkAppId: session.larkAppId, size: 'sm' })} />
      <div className="qcard-tx">
        <b>{botName} · {(stripMentionPrefix(session.title) || session.sessionId).slice(0, 56)}</b>
        <span>{attentionReason(session) ?? ''} · {relTime(attentionWaitSince(session))}</span>
      </div>
      <a className="qcard-go" href="#/sessions">{tr('strip.handle')}</a>
    </article>
  );
}

function ActiveSessionRow({ session }: { session: SessionRow }) {
  const tr = useT();
  const botName = botDisplayName(session);
  const status = String(session.status ?? 'unknown');
  return (
    <li className="sess-row">
      <Html html={botAvatarHtml({ name: botName, larkAppId: session.larkAppId, size: 'sm' })} />
      <div className="sess-tx">
        <b>{(stripMentionPrefix(session.title) || session.sessionId).slice(0, 64)}</b>
        <span>{botName} · {chatDisplayTitle(session) ?? session.cliId ?? 'unknown'} · {relTime(session.lastMessageAt)}</span>
      </div>
      <span className={`status status-${statusToken(status)}`}>
        {sessionStatusText(status, tr)}
      </span>
    </li>
  );
}

function ScheduleMini({ schedule, timeZone }: { schedule: ScheduleRow; timeZone?: string }) {
  const next = schedule.nextRunAt
    ? new Date(schedule.nextRunAt).toLocaleString(undefined, timeZone ? { timeZone, timeZoneName: 'short' } : undefined)
    : '-';
  return (
    <li className="overview-list-row">
      <div>
        <strong>{schedule.name ?? schedule.id}</strong>
        <span>{botDisplayName(schedule)} · {schedule.parsed?.display ?? ''}</span>
      </div>
      <span>{next}</span>
    </li>
  );
}

function Donut({ working, attention, idle }: { working: number; attention: number; idle: number }) {
  const tr = useT();
  const total = working + attention + idle;
  const background = total === 0
    ? 'conic-gradient(var(--border) 0 360deg)'
    : (() => {
        const wDeg = (working / total) * 360;
        const aDeg = wDeg + (attention / total) * 360;
        return `conic-gradient(var(--accent) 0 ${wDeg}deg, var(--warning) ${wDeg}deg ${aDeg}deg, var(--success) ${aDeg}deg 360deg)`;
      })();
  return (
    <>
      <div className="donut-wrap">
        <div className="donut" style={{ background }} />
        <div className="donut-center"><b>{total}</b><span>{tr('overview.openSessions')}</span></div>
      </div>
      <div className="donut-legend">
        <span><i style={{ background: 'var(--accent)' }} />{tr('overview.workingSessions')} {working}</span>
        <span><i style={{ background: 'var(--warning)' }} />{tr('overview.attention')} {attention}</span>
        <span><i style={{ background: 'var(--success)' }} />{tr('sessions.board.idle')} {idle}</span>
      </div>
    </>
  );
}

function OverviewPage() {
  const tr = useT();
  const teamRef = useRef<HTMLDivElement | null>(null);
  const [teamExpanded, setTeamExpanded] = useState(readTeamExpanded);
  const [collapsedN, setCollapsedN] = useState(TEAM_COLLAPSED_ROWS * 3);
  const [namesVersion, forceNamesRefresh] = useState(0);
  const [resources, setResources] = useState<ResourceSummary | null>(null);
  const { sessions, schedules, scheduleTimeZone } = useStoreSelector(snapshot => ({
    sessions: [...snapshot.sessions.values()] as SessionRow[],
    schedules: [...snapshot.schedules.values()] as ScheduleRow[],
    scheduleTimeZone: snapshot.scheduleTimeZone,
  }));

  useEffect(() => {
    const refresh = () => setCollapsedN(collapsedCardCount(teamRef.current));
    refresh();
    window.addEventListener('resize', refresh);
    return () => window.removeEventListener('resize', refresh);
  }, []);

  useEffect(() => {
    void loadGroupsSnapshot().then(() => forceNamesRefresh(v => v + 1));
    void loadNameMaps().then(() => forceNamesRefresh(v => v + 1));
  }, []);

  useEffect(() => {
    let disposed = false;
    const load = async () => {
      try {
        const res = await fetch('/api/resources/current', { cache: 'no-store' });
        const json = await res.json();
        if (!disposed) setResources(json);
      } catch {
        if (!disposed) setResources({ supported: false });
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), 10_000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, []);

  const active = useMemo(() => sessions.filter(s => s.status !== 'closed'), [sessions]);
  const attentionRows = useMemo(
    () => active.filter(s => attentionReason(s)).sort((a, b) => attentionWaitSince(a) - attentionWaitSince(b)),
    [active],
  );
  const busy = useMemo(() => active.filter(s => BUSY_STATUSES.has(s.status) && !attentionReason(s)), [active]);
  const idle = active.length - attentionRows.length - busy.length;
  const cards = useMemo(() => buildBotCards(sessions), [sessions, namesVersion]);
  const visibleCards = teamExpanded ? cards : cards.slice(0, collapsedN);
  const onlineBots = cards.filter(c => c.online || c.active.length > 0).length;
  const recent = useMemo(
    () => active
      .filter(s => BUSY_STATUSES.has(s.status) || IDLE_STATUSES.has(s.status))
      .sort((a, b) => Number(b.lastMessageAt ?? 0) - Number(a.lastMessageAt ?? 0))
      .slice(0, 7),
    [active],
  );
  const upcoming = useMemo(
    () => schedules
      .filter(s => s.nextRunAt)
      .sort((a, b) => Date.parse(a.nextRunAt) - Date.parse(b.nextRunAt))
      .slice(0, 5),
    [schedules],
  );
  const hostCpuText = resources?.supported === false
    ? '-'
    : resources?.cpuReady === false ? '-' : resourcePct(resources?.host?.cpuPct);
  const memoryText = resources?.supported === false ? '-' : resourcePct(resources?.host?.memUsedPct);
  const botmuxRssText = resources?.supported === false ? '-' : resourceBytes(resources?.botmux?.rssBytes);
  const cpuHealth = pctHealth(resources?.host?.cpuPct, 70, 90, resources?.supported !== false && resources?.cpuReady !== false);
  const memoryHealth = pctHealth(resources?.host?.memUsedPct, 75, 90, resources?.supported !== false);
  const botmuxHealth = resources?.supported === false ? 'unknown' : rssHealth(resources?.botmux?.rssBytes, resources?.host?.memTotalBytes);
  const sessionsHealth = sessionPressureHealth(resources?.runtime?.sessions);
  const overallHealth = resources?.supported === false
    ? 'unknown'
    : combinedHealth([sampleHealth(resources?.runtime?.sampleHealth?.status), cpuHealth, memoryHealth, botmuxHealth, sessionsHealth]);

  const toggleTeam = () => {
    setTeamExpanded(v => {
      persistTeamExpanded(!v);
      return !v;
    });
  };

  return (
    <section className="page hero-page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">{tr('app.subtitle')}</p>
          <h1>{tr('overview.title')}</h1>
          <p id="overview-sub">{tr('overview.subtitle')}</p>
        </div>
        <div className="hero-pills" id="overview-pills">
          <span className="pill">{tr('overview.workingSessions')} <b>{busy.length}</b></span>
          <span className={`pill${attentionRows.length ? ' pill-hot' : ''}`}>{tr('overview.attention')} <b>{attentionRows.length}</b></span>
          <span className="pill">{tr('overview.onlineBots')} <b>{onlineBots}</b></span>
        </div>
      </div>

      <a className="resource-strip" href="#/monitoring">
        <span className="resource-strip-title">
          <i className={`resource-health-dot ${overallHealth}`} aria-hidden="true" />
          <span>{tr('monitoring.runtimeTitle')}</span>
          <em>{tr(`monitoring.health.${overallHealth}`)}</em>
        </span>
        <span className={`resource-strip-metric ${cpuHealth}`}>
          <i className={`resource-health-dot ${cpuHealth}`} aria-hidden="true" />
          <span>{tr('monitoring.hostCpu')}</span>
          <strong>{hostCpuText}</strong>
        </span>
        <span className={`resource-strip-metric ${memoryHealth}`}>
          <i className={`resource-health-dot ${memoryHealth}`} aria-hidden="true" />
          <span>{tr('monitoring.hostMemory')}</span>
          <strong>{memoryText}</strong>
        </span>
        <span className={`resource-strip-metric ${botmuxHealth}`}>
          <i className={`resource-health-dot ${botmuxHealth}`} aria-hidden="true" />
          <span>{tr('monitoring.botmuxRss')}</span>
          <strong>{botmuxRssText}</strong>
        </span>
        <span className={`resource-strip-metric ${sessionsHealth}`}>
          <i className={`resource-health-dot ${sessionsHealth}`} aria-hidden="true" />
          <span>{tr('monitoring.sessions')}</span>
          <strong>{sessionSummaryText(resources, tr)}</strong>
        </span>
      </a>

      <div className="sect-head">
        <h2>{tr('overview.team')}</h2><span>{tr('overview.teamHint')}</span>
        <a href="#/bot-defaults">{tr('overview.viewAll')}</a>
      </div>
      <div className="team-grid" id="team-grid" ref={teamRef}>
        {visibleCards.length ? visibleCards.map(card => <MateCard key={card.larkAppId ?? card.botName} card={card} />) : <div className="empty">{tr('overview.noSessions')}</div>}
      </div>
      <button type="button" className="team-toggle" id="team-toggle" hidden={cards.length <= collapsedN} onClick={toggleTeam}>
        {teamExpanded ? tr('overview.teamCollapse') : tr('overview.teamExpand', { count: cards.length })}
      </button>

      <div className="sect-head" id="attention-head">
        <h2>{tr('overview.attention')}</h2><span>{tr('overview.attentionHint')}</span>
      </div>
      <div className="qgrid" id="attention-list">
        {attentionRows.length ? attentionRows.map(s => <AttentionCard key={s.sessionId} session={s} />) : <div className="qcard qcard-empty">{tr('overview.noAttention')}</div>}
      </div>

      <div className="overview-cols">
        <section className="panel">
          <header className="panel-header">
            <div>
              <h2>{tr('overview.activeSessions')}</h2>
              <p>{tr('overview.activeSessionsHint')}</p>
            </div>
            <a className="btn-link" href="#/sessions">{tr('overview.viewAll')}</a>
          </header>
          <ul className="overview-list" id="recent-sessions">
            {recent.length ? recent.map(s => <ActiveSessionRow key={s.sessionId} session={s} />) : <li className="empty">{tr('overview.noSessions')}</li>}
          </ul>
        </section>
        <div className="overview-side">
          <section className="panel">
            <header className="panel-header">
              <div>
                <h2>{tr('overview.today')}</h2>
                <p>{tr('overview.todayHint')}</p>
              </div>
            </header>
            <div className="donut-row" id="today-donut">
              <Donut working={busy.length} attention={attentionRows.length} idle={Math.max(0, idle)} />
            </div>
          </section>
          <section className="panel">
            <header className="panel-header">
              <div>
                <h2>{tr('overview.nextSchedules')}</h2>
                <p>{tr('schedules.subtitle')}</p>
              </div>
              <a className="btn-link" href="#/schedules">{tr('overview.viewAll')}</a>
            </header>
            <ul className="overview-list" id="next-schedules">
              {upcoming.length ? upcoming.map(s => <ScheduleMini key={s.id} schedule={s} timeZone={scheduleTimeZone} />) : <li className="empty">{tr('overview.noSchedules')}</li>}
            </ul>
          </section>
        </div>
      </div>
    </section>
  );
}

export function renderOverviewPage(root: HTMLElement): PageDisposer {
  return mountReactPage(root, <OverviewPage />);
}
