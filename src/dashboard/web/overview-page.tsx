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
} from './ui.js';
import { buildBotCards, loadGroupsSnapshot, type BotCard } from './overview.js';
import {
  HeaderAction,
  HeaderControls,
  Html,
  OverviewList,
  OverviewListItem,
  OverviewListMain,
  OverviewListTail,
  OverflowText,
  SectionHeader,
  SortMenu,
} from './dashboard-components.js';

type SessionRow = Record<string, any> & { sessionId: string };
type ScheduleRow = Record<string, any> & { id: string };
type ActiveSortMode = 'time' | 'attention';

const BUSY_STATUSES = new Set(['working', 'analyzing', 'active', 'starting']);
const IDLE_STATUSES = new Set(['idle', 'dormant']);
const TEAM_EXPAND_KEY = 'botmux.overview.teamExpanded';
const ACTIVE_SORT_KEY = 'botmux.overview.activeSort';
const TEAM_DESKTOP_COLUMNS = 5;
const TEAM_COLLAPSED_ROWS = 1;
const ACTIVE_SESSIONS_PANEL_MIN_H = 260;

function readTeamExpanded(): boolean {
  try { return window.localStorage.getItem(TEAM_EXPAND_KEY) === '1'; } catch { return false; }
}

function persistTeamExpanded(v: boolean): void {
  try { window.localStorage.setItem(TEAM_EXPAND_KEY, v ? '1' : '0'); } catch { /* silent */ }
}

function normalizeActiveSortMode(value: unknown): ActiveSortMode {
  return value === 'attention' ? 'attention' : 'time';
}

function readActiveSortMode(): ActiveSortMode {
  try { return normalizeActiveSortMode(window.localStorage.getItem(ACTIVE_SORT_KEY)); } catch { return 'time'; }
}

function persistActiveSortMode(mode: ActiveSortMode): void {
  try { window.localStorage.setItem(ACTIVE_SORT_KEY, mode); } catch { /* silent */ }
}

function sortActiveSessions(rows: SessionRow[], mode: ActiveSortMode): SessionRow[] {
  const byRecent = (a: SessionRow, b: SessionRow) => Number(b.lastMessageAt ?? 0) - Number(a.lastMessageAt ?? 0);
  if (mode === 'attention') {
    return [...rows].sort((a, b) => {
      const aNeeds = attentionReason(a) ? 0 : 1;
      const bNeeds = attentionReason(b) ? 0 : 1;
      if (aNeeds !== bNeeds) return aNeeds - bNeeds;
      if (aNeeds === 0) {
        const byWait = attentionWaitSince(a) - attentionWaitSince(b);
        if (byWait !== 0) return byWait;
      }
      return byRecent(a, b);
    });
  }
  return [...rows].sort(byRecent);
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

function collapsedCardCount(gridEl: HTMLElement | null): number {
  if (!gridEl) return TEAM_COLLAPSED_ROWS * TEAM_DESKTOP_COLUMNS;
  const tracks = window.getComputedStyle(gridEl).gridTemplateColumns
    .split(/\s+/)
    .filter(track => Number.parseFloat(track) > 0);
  const cols = Math.max(1, tracks.length || TEAM_DESKTOP_COLUMNS);
  return cols * TEAM_COLLAPSED_ROWS;
}

function alignPanelToSidebarBottom(panel: HTMLElement | null, propertyName: string): void {
  if (!panel) return;
  const sidebar = document.querySelector<HTMLElement>('.sidebar');
  if (!sidebar || window.matchMedia('(max-width: 980px)').matches) {
    panel.style.removeProperty(propertyName);
    return;
  }

  const sidebarBottom = sidebar.getBoundingClientRect().bottom;
  const panelTop = panel.getBoundingClientRect().top;
  const minHeight = Math.max(ACTIVE_SESSIONS_PANEL_MIN_H, Math.round(sidebarBottom - panelTop));
  const value = `${minHeight}px`;
  if (panel.style.getPropertyValue(propertyName) !== value) {
    panel.style.setProperty(propertyName, value);
  }
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

function ActiveSessionRow({ session }: { session: SessionRow }) {
  const tr = useT();
  const botName = botDisplayName(session);
  const status = String(session.status ?? 'unknown');
  const reason = attentionReason(session);
  return (
    <OverviewListItem kind="session">
      <Html html={botAvatarHtml({ name: botName, larkAppId: session.larkAppId, size: 'sm' })} />
      <OverviewListMain>
        <b>{(stripMentionPrefix(session.title) || session.sessionId).slice(0, 64)}</b>
        <span>{botName} · {chatDisplayTitle(session) ?? session.cliId ?? 'unknown'} · {relTime(session.lastMessageAt)}</span>
      </OverviewListMain>
      <OverviewListTail>
        {reason ? (
          <>
            <a className="overview-list-action" href="#/sessions">{tr('strip.handle')}</a>
            <span className="status overview-list-status status-attention">{reason}</span>
          </>
        ) : (
          <span className={`status overview-list-status status-${statusToken(status)}`}>
            {sessionStatusText(status, tr)}
          </span>
        )}
      </OverviewListTail>
    </OverviewListItem>
  );
}

function ScheduleMini({ schedule, timeZone }: { schedule: ScheduleRow; timeZone?: string }) {
  const next = schedule.nextRunAt
    ? new Date(schedule.nextRunAt).toLocaleString(undefined, timeZone ? { timeZone, timeZoneName: 'short' } : undefined)
    : '-';
  return (
    <OverviewListItem kind="schedule">
      <OverviewListMain>
        <strong>{schedule.name ?? schedule.id}</strong>
        <span>{botDisplayName(schedule)} · {schedule.parsed?.display ?? ''}</span>
      </OverviewListMain>
      <span className="overview-list-meta">
        <OverflowText text={next} showPopover={false} durationMs={2600} />
      </span>
    </OverviewListItem>
  );
}

function ActiveSortControl({ mode, onModeChange }: { mode: ActiveSortMode; onModeChange: (mode: ActiveSortMode) => void }) {
  const tr = useT();
  const label = mode === 'attention' ? tr('overview.sortAttentionFirst') : tr('overview.sortByTime');

  return (
    <SortMenu
      className="overview-active-sort-menu"
      label={label}
      value={mode}
      options={[
        { value: 'time', label: tr('overview.sortByTime') },
        { value: 'attention', label: tr('overview.sortAttentionFirst') },
      ]}
      onChange={onModeChange}
    />
  );
}

function OverviewPage() {
  const tr = useT();
  const teamRef = useRef<HTMLDivElement | null>(null);
  const activePanelRef = useRef<HTMLElement | null>(null);
  const schedulesPanelRef = useRef<HTMLElement | null>(null);
  const [teamExpanded, setTeamExpanded] = useState(readTeamExpanded);
  const [activeSortMode, setActiveSortMode] = useState<ActiveSortMode>(readActiveSortMode);
  const [collapsedN, setCollapsedN] = useState(TEAM_COLLAPSED_ROWS * TEAM_DESKTOP_COLUMNS);
  const [namesVersion, forceNamesRefresh] = useState(0);
  const { sessions, schedules, scheduleTimeZone } = useStoreSelector(snapshot => ({
    sessions: [...snapshot.sessions.values()] as SessionRow[],
    schedules: [...snapshot.schedules.values()] as ScheduleRow[],
    scheduleTimeZone: snapshot.scheduleTimeZone,
  }));

  useEffect(() => {
    let raf = 0;
    const refresh = () => {
      window.cancelAnimationFrame(raf);
      raf = window.requestAnimationFrame(() => {
        const next = collapsedCardCount(teamRef.current);
        setCollapsedN(current => (current === next ? current : next));
      });
    };
    refresh();
    const observer = typeof ResizeObserver === 'undefined' || !teamRef.current
      ? null
      : new ResizeObserver(refresh);
    if (observer && teamRef.current) observer.observe(teamRef.current);
    window.addEventListener('resize', refresh);
    return () => {
      window.cancelAnimationFrame(raf);
      observer?.disconnect();
      window.removeEventListener('resize', refresh);
    };
  }, []);

  useEffect(() => {
    void loadGroupsSnapshot().then(() => forceNamesRefresh(v => v + 1));
    void loadNameMaps().then(() => forceNamesRefresh(v => v + 1));
  }, []);

  const active = useMemo(() => sessions.filter(s => s.status !== 'closed'), [sessions]);
  const cards = useMemo(() => buildBotCards(sessions), [sessions, namesVersion]);
  const visibleCards = teamExpanded ? cards : cards.slice(0, collapsedN);
  const recent = useMemo(
    () => sortActiveSessions(
      active.filter(s => attentionReason(s) || BUSY_STATUSES.has(s.status) || IDLE_STATUSES.has(s.status)),
      activeSortMode,
    ).slice(0, 7),
    [active, activeSortMode],
  );
  const upcoming = useMemo(
    () => schedules
      .filter(s => s.nextRunAt)
      .sort((a, b) => Date.parse(a.nextRunAt) - Date.parse(b.nextRunAt))
      .slice(0, 5),
    [schedules],
  );

  useEffect(() => {
    const panels = [
      { el: activePanelRef.current, propertyName: '--active-sessions-min-height' },
      { el: schedulesPanelRef.current, propertyName: '--schedules-panel-min-height' },
    ].filter((entry): entry is { el: HTMLElement; propertyName: string } => !!entry.el);
    if (!panels.length) return;

    let raf = 0;
    const update = () => {
      window.cancelAnimationFrame(raf);
      raf = window.requestAnimationFrame(() => {
        for (const panel of panels) alignPanelToSidebarBottom(panel.el, panel.propertyName);
      });
    };
    update();

    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    if (observer) {
      for (const panel of panels) observer.observe(panel.el);
      const sidebar = document.querySelector<HTMLElement>('.sidebar');
      const page = panels[0].el.closest<HTMLElement>('.page');
      if (sidebar) observer.observe(sidebar);
      if (page) observer.observe(page);
    }
    window.addEventListener('resize', update);

    return () => {
      window.cancelAnimationFrame(raf);
      observer?.disconnect();
      window.removeEventListener('resize', update);
      for (const panel of panels) panel.el.style.removeProperty(panel.propertyName);
    };
  }, [teamExpanded, collapsedN, cards.length, upcoming.length]);

  const toggleTeam = () => {
    setTeamExpanded(v => {
      persistTeamExpanded(!v);
      return !v;
    });
  };
  const changeActiveSortMode = (next: ActiveSortMode) => {
    setActiveSortMode(next);
    persistActiveSortMode(next);
  };

  return (
    <section className="page hero-page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">{tr('app.subtitle')}</p>
          <h1>{tr('overview.title')}</h1>
        </div>
      </div>

      <div className="overview-layout">
        <div className="overview-main">
          <section className="overview-block team-section">
            <SectionHeader
              title={tr('overview.team')}
              count={tr('overview.teamCount', { count: cards.length })}
              hint={tr('overview.teamHint')}
            >
              <HeaderControls>
                <HeaderAction href="#/bot-defaults">{tr('overview.viewAllPlain')}</HeaderAction>
              </HeaderControls>
            </SectionHeader>
            <div className="team-grid" id="team-grid" ref={teamRef}>
              {visibleCards.length ? visibleCards.map(card => <MateCard key={card.larkAppId ?? card.botName} card={card} />) : <div className="empty">{tr('overview.noSessions')}</div>}
            </div>
            {cards.length > collapsedN ? (
              <button type="button" className="team-toggle" id="team-toggle" onClick={toggleTeam}>
                {teamExpanded ? tr('overview.teamCollapse') : tr('overview.teamExpand')}
              </button>
            ) : null}
          </section>

          <section className="overview-block">
            <SectionHeader title={tr('overview.activeSessions')}>
              <HeaderControls>
                <ActiveSortControl mode={activeSortMode} onModeChange={changeActiveSortMode} />
                <HeaderAction href="#/sessions">{tr('overview.viewAllPlain')}</HeaderAction>
              </HeaderControls>
            </SectionHeader>
            <section className="panel active-sessions-panel" ref={activePanelRef}>
              <OverviewList id="recent-sessions">
                {recent.length ? recent.map(s => <ActiveSessionRow key={s.sessionId} session={s} />) : <li className="empty">{tr('overview.noSessions')}</li>}
              </OverviewList>
            </section>
          </section>
        </div>

        <aside className="overview-side">
          <section className="overview-block">
            <SectionHeader title={tr('overview.nextSchedules')}>
              <HeaderAction href="#/schedules">{tr('overview.viewAllPlain')}</HeaderAction>
            </SectionHeader>
            <section className="panel schedules-panel" ref={schedulesPanelRef}>
              <OverviewList id="next-schedules">
                {upcoming.length ? upcoming.map(s => <ScheduleMini key={s.id} schedule={s} timeZone={scheduleTimeZone} />) : <li className="empty">{tr('overview.noSchedules')}</li>}
              </OverviewList>
            </section>
          </section>
        </aside>
      </div>
    </section>
  );
}

export function renderOverviewPage(root: HTMLElement): PageDisposer {
  root.classList.add('overview-root');
  const dispose = mountReactPage(root, <OverviewPage />);
  return () => {
    dispose();
    root.classList.remove('overview-root');
  };
}
