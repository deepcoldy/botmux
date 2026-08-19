import type React from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { mountReactPage, type PageDisposer } from './react-mount.js';
import { useStoreSelector, useT } from './react-hooks.js';
import {
  attentionReason,
  attentionWaitSince,
  botAvatarHtml,
  botDisplayName,
  chatDisplayTitle,
  larkConsoleUrl,
  loadNameMaps,
  relTime,
  stripMentionPrefix,
} from './ui.js';
import { buildBotCards, loadGroupsSnapshot, type BotCard } from './overview.js';
import { requestOpenCreateSession } from './create-session-entry.js';
import {
  CreateActionButton,
  HeaderAction,
  HeaderControls,
  Html,
  OverviewList,
  OverviewListItem,
  OverviewListMain,
  OverflowText,
  SectionHeader,
  SortMenu,
} from './dashboard-components.js';

type SessionRow = Record<string, any> & { sessionId: string };
type ScheduleRow = Record<string, any> & { id: string };
type ActiveSortMode = 'time' | 'attention';

/** 「进行中」口径：working / analyzing / active（starting 是过渡态，不计入）。 */
const WORKING_STATUSES = new Set(['working', 'analyzing', 'active']);
const TEAM_EXPAND_KEY = 'botmux.overview.teamExpanded';
const ACTIVE_SORT_KEY = 'botmux.overview.activeSort';
const TEAM_DESKTOP_COLUMNS = 5;
const TEAM_COLLAPSED_ROWS = 1;
const ATTENTION_LIST_CAP = 6;
const WORKING_LIST_CAP = 7;
const SPARK_SAMPLES = 24;
const SPARK_INTERVAL_MS = 4000;

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

/**
 * 迷你趋势线：在浏览器里对当前指标做滚动采样（纯渲染层，不碰数据层）。
 * 首屏用当前值填满，画一条平线——没有历史时诚实表达「暂无趋势」，
 * 随后每 4 秒落一个点，24 个点（约 1.5 分钟）滑窗。
 */
function useSparkline(value: number): { line: string; area: string } {
  const historyRef = useRef<number[] | null>(null);
  const valueRef = useRef(value);
  valueRef.current = value;
  const [, setTick] = useState(0);

  useEffect(() => {
    if (historyRef.current === null) {
      historyRef.current = Array(SPARK_SAMPLES).fill(valueRef.current);
    }
    const id = window.setInterval(() => {
      const history = historyRef.current;
      if (!history) return;
      history.push(valueRef.current);
      if (history.length > SPARK_SAMPLES) history.shift();
      setTick(tick => tick + 1);
    }, SPARK_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, []);

  const history = historyRef.current ?? Array(SPARK_SAMPLES).fill(value);
  const min = Math.min(...history);
  const max = Math.max(...history);
  const span = max - min;
  const width = 100;
  const height = 32;
  const pad = 4;
  const points = history.map((v, i) => {
    const x = (i / (history.length - 1)) * width;
    const y = span === 0 ? height / 2 : height - pad - ((v - min) / span) * (height - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const line = points.join(' ');
  return { line, area: `0,${height} ${line} ${width},${height}` };
}

type StatTone = 'need' | 'work' | 'active' | 'online';

function StatIcon({ kind }: { kind: StatTone }): React.JSX.Element {
  const common = {
    viewBox: '0 0 24 24',
    width: 18,
    height: 18,
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': true,
  } as const;
  if (kind === 'need') {
    return (
      <svg {...common}>
        <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
        <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
      </svg>
    );
  }
  if (kind === 'work') {
    return (
      <svg {...common}>
        <path d="M3 12h4l3 8 4-16 3 8h4" />
      </svg>
    );
  }
  if (kind === 'active') {
    return (
      <svg {...common}>
        <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <rect x="4" y="8" width="16" height="12" rx="3" />
      <path d="M12 8V4" />
      <circle cx="12" cy="3" r="1" />
      <path d="M9 14h.01M15 14h.01" />
    </svg>
  );
}

function StatChip(props: {
  tone: StatTone;
  label: string;
  value: number;
  suffix?: string;
}): React.JSX.Element {
  const { line, area } = useSparkline(props.value);
  return (
    <article className={`stat-chip stat-chip--${props.tone}`}>
      <span className="stat-chip-icon"><StatIcon kind={props.tone} /></span>
      <div className="stat-chip-body">
        <b className="stat-chip-value">
          {props.value}
          {props.suffix ? <small className="stat-chip-suffix">{props.suffix}</small> : null}
        </b>
        <span className="stat-chip-label">{props.label}</span>
      </div>
      <svg className="stat-chip-spark" viewBox="0 0 100 32" preserveAspectRatio="none" aria-hidden="true">
        <polygon points={area} />
        <polyline points={line} vectorEffect="non-scaling-stroke" />
      </svg>
    </article>
  );
}

function MateCard({ card }: { card: BotCard }) {
  const tr = useT();
  const consoleUrl = larkConsoleUrl(card.larkAppId, card.brand);
  const offline = !card.online && card.active.length === 0;
  const needsYou = card.attention.length > 0;
  const busy = card.busy.length > 0;
  const dotClass = needsYou ? 'warn' : busy ? 'busy' : offline ? 'off' : 'ok';
  let task: React.JSX.Element | string;
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
      {consoleUrl ? (
        <a
          className="mate-console"
          href={consoleUrl}
          target="_blank"
          rel="noopener noreferrer"
          data-tip={tr('overview.botConsole')}
          aria-label={tr('overview.botConsole')}
        >
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M7 17 17 7M9 7h8v8" />
          </svg>
        </a>
      ) : null}
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

/** 「需要你处理」队列行：琥珀左条 + 头像 + 标题 + 等待原因/时长 + 处理入口。 */
function AttentionRow({ session }: { session: SessionRow }): React.JSX.Element {
  const tr = useT();
  const botName = botDisplayName(session);
  const reason = attentionReason(session) ?? '';
  return (
    <a className="attn-item" href="#/sessions" role="listitem">
      <Html html={botAvatarHtml({ name: botName, larkAppId: session.larkAppId, size: 'sm' })} />
      <span className="attn-main">
        <b>{(stripMentionPrefix(session.title) || session.sessionId).slice(0, 64)}</b>
        <span>{reason} · {tr('overview.waitingFor', { time: relTime(attentionWaitSince(session)) })}</span>
      </span>
      <span className="attn-action">{tr('strip.handle')}</span>
    </a>
  );
}

/** 「进行中」会话行：头像 + 标题 + bot/群/时间 + 状态徽章。 */
function WorkingRow({ session }: { session: SessionRow }): React.JSX.Element {
  const tr = useT();
  const botName = botDisplayName(session);
  const status = String(session.status ?? 'unknown');
  return (
    <a className="work-item" href="#/sessions" role="listitem">
      <Html html={botAvatarHtml({ name: botName, larkAppId: session.larkAppId, size: 'sm' })} />
      <span className="work-main">
        <b>{(stripMentionPrefix(session.title) || session.sessionId).slice(0, 64)}</b>
        <span>{botName} · {chatDisplayTitle(session) ?? session.cliId ?? 'unknown'} · {relTime(session.lastMessageAt)}</span>
      </span>
      <span className={`status work-status status-${statusToken(status)}`}>
        {sessionStatusText(status, tr)}
      </span>
    </a>
  );
}

function ScheduleMini({ schedule, timeZone }: { schedule: ScheduleRow; timeZone?: string }): React.JSX.Element {
  const next = schedule.nextRunAt
    ? new Date(schedule.nextRunAt).toLocaleString(undefined, timeZone ? { timeZone, timeZoneName: 'short' } : undefined)
    : '-';
  return (
    <OverviewListItem kind="schedule">
      <span className="sched-clock" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v5l3 2" />
        </svg>
      </span>
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

function ActiveSortControl({ mode, onModeChange }: { mode: ActiveSortMode; onModeChange: (mode: ActiveSortMode) => void }): React.JSX.Element {
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
  const [teamExpanded, setTeamExpanded] = useState(readTeamExpanded);
  const [activeSortMode, setActiveSortMode] = useState<ActiveSortMode>(readActiveSortMode);
  const [collapsedN, setCollapsedN] = useState(TEAM_COLLAPSED_ROWS * TEAM_DESKTOP_COLUMNS);
  const [namesVersion, forceNamesRefresh] = useState(0);
  const { sessions, schedules, scheduleTimeZone, schedulesAvailable, online } = useStoreSelector(snapshot => ({
    sessions: [...snapshot.sessions.values()] as SessionRow[],
    schedules: [...snapshot.schedules.values()] as ScheduleRow[],
    scheduleTimeZone: snapshot.scheduleTimeZone,
    schedulesAvailable: snapshot.schedulesAvailable,
    online: snapshot.online,
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

  // 「需要你处理」：全量计数进统计条/副标题，列表按等待时长排序、限量展示。
  const attentionAll = useMemo(() => active.filter(s => attentionReason(s)), [active]);
  const attention = useMemo(
    () => sortActiveSessions(attentionAll, activeSortMode).slice(0, ATTENTION_LIST_CAP),
    [attentionAll, activeSortMode],
  );
  // 「进行中」：只保留 working/analyzing/active，按最近消息排序。
  const workingAll = useMemo(
    () => active
      .filter(s => WORKING_STATUSES.has(String(s.status)))
      .sort((a, b) => Number(b.lastMessageAt ?? 0) - Number(a.lastMessageAt ?? 0)),
    [active],
  );
  const working = workingAll.slice(0, WORKING_LIST_CAP);
  const onlineBots = useMemo(() => cards.filter(c => c.online || c.active.length > 0).length, [cards]);
  const upcoming = useMemo(
    () => schedules
      .filter(s => s.nextRunAt)
      .sort((a, b) => Date.parse(a.nextRunAt) - Date.parse(b.nextRunAt))
      .slice(0, 5),
    [schedules],
  );
  // 无排程数据（无能力 或 确实没有 upcoming）时整块隐藏，不画空占位。
  const showSchedules = schedulesAvailable && upcoming.length > 0;

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
        <div className="overview-head">
          <p className="eyebrow">{tr('app.subtitle')}</p>
          <h1>{tr('overview.title')}</h1>
          <p className="overview-subtitle">
            <span>{tr('overview.headingSubtitle', { bots: onlineBots, needs: attentionAll.length })}</span>
            <span className={`overview-live${online ? ' is-online' : ' is-offline'}`}>
              <i aria-hidden="true" />
              {online ? tr('overview.liveSync') : tr('overview.syncOffline')}
            </span>
          </p>
        </div>
        <div className="page-heading-actions">
          <a className="btn-link" href="#/monitoring">{tr('nav.monitoring')}</a>
          <CreateActionButton className="page-primary-action" onClick={() => requestOpenCreateSession()}>
            {tr('nav.createSession')}
          </CreateActionButton>
        </div>
      </div>

      <div className="overview-stats">
        <StatChip tone="need" label={tr('overview.attention')} value={attentionAll.length} />
        <StatChip tone="work" label={tr('overview.workingSessions')} value={workingAll.length} />
        <StatChip tone="active" label={tr('overview.activeSessions')} value={active.length} />
        <StatChip tone="online" label={tr('overview.onlineBots')} value={onlineBots} suffix={`/ ${cards.length}`} />
      </div>

      <section className="overview-block attention-section">
        <SectionHeader
          title={tr('overview.attention')}
          count={tr('strip.pending', { count: attentionAll.length })}
        >
          {attentionAll.length > 1 ? (
            <HeaderControls>
              <ActiveSortControl mode={activeSortMode} onModeChange={changeActiveSortMode} />
            </HeaderControls>
          ) : null}
        </SectionHeader>
        {attention.length ? (
          <div className="attn-list" role="list">
            {attention.map(s => <AttentionRow key={s.sessionId} session={s} />)}
          </div>
        ) : (
          <div className="attn-empty">
            <span className="attn-empty-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M20 6 9 17l-5-5" />
              </svg>
            </span>
            <span>{tr('overview.allClear')}</span>
          </div>
        )}
      </section>

      <div className={`overview-layout${showSchedules ? '' : ' overview-layout--single'}`}>
        <div className="overview-main">
          <section className="overview-block">
            <SectionHeader title={tr('overview.workingSessions')} count={String(workingAll.length)}>
              <HeaderControls>
                <HeaderAction href="#/sessions">{tr('overview.viewAllPlain')}</HeaderAction>
              </HeaderControls>
            </SectionHeader>
            <section className="panel active-sessions-panel">
              {working.length ? (
                <div className="work-list" role="list">
                  {working.map(s => <WorkingRow key={s.sessionId} session={s} />)}
                </div>
              ) : (
                <div className="empty">{tr('overview.noSessions')}</div>
              )}
            </section>
          </section>

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
        </div>

        {/* P1-14：排程不在 Workbench-only 身份的能力表里（/api/schedules 明确
            401）。这时排程既不是「暂时空」也不是「没有排程」，而是压根读不到，
            画一个永远为空的面板只会误导——整块隐藏。 */}
        {showSchedules ? (
          <aside className="overview-side">
            <section className="overview-block">
              <SectionHeader title={tr('overview.upcomingSchedules')}>
                <HeaderAction href="#/schedules">{tr('overview.viewAllPlain')}</HeaderAction>
              </SectionHeader>
              <section className="panel schedules-panel">
                <OverviewList id="next-schedules">
                  {upcoming.map(s => <ScheduleMini key={s.id} schedule={s} timeZone={scheduleTimeZone} />)}
                </OverviewList>
              </section>
            </section>
          </aside>
        ) : null}
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
