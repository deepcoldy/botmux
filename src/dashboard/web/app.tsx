// Dashboard SPA entry: React chrome + lazy route host + SSE bootstrap.
import { createRoot } from 'react-dom/client';
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { bootstrap, store } from './store.js';
import {
  attentionReason,
  attentionWaitSince,
  botDisplayName,
  escapeHtml,
  loadNameMaps,
  relTime,
  t,
  ui,
} from './ui.js';
import { CLOSE_THEME_MENU_EVENT, initThemeMenu, paintThemeMenu } from './theme-menu.js';
import { normalizeDashboardLocale, type DashboardLocale } from './i18n.js';
import { findDashboardRoute, loadOverviewPage } from './dashboard-routes.js';
import {
  beginDashboardRoute,
  createDashboardRouteState,
  loadAndRenderDashboardRoute,
} from './route-lifecycle.js';
import { maybeReloadBrowserForStaleRouteChunk } from './stale-chunk-reload.js';
import { buildBotCards, loadGroupsSnapshot } from './overview.js';
import { BotOnboardingDialog, OPEN_BOT_ONBOARDING_EVENT, openBotOnboarding } from './bot-onboarding.js';
import { requestOpenCreateSession } from './create-session-entry.js';
import { InfoTip } from './dashboard-components.js';
import { initFloatingScrollbars } from './floating-scrollbars.js';
import { initIconTooltips } from './icon-tooltip.js';
import { PLUGIN_PINS_CHANGED_EVENT } from './plugin-events.js';
import { updateAndRestartBotmux, type BotmuxUpdatePhase } from './update-action.js';

type OwnerAvatar = { avatarUrl: string; name?: string };
type TopbarAttentionNotice = { count: number; time: string; bot: string; reason: string };
type TopbarStatusSummary = {
  working: number;
  attention: number;
  idle: number;
  onlineBots: number;
  attentionNotice: TopbarAttentionNotice | null;
};
type BotmuxUpdateStatus = {
  current: string;
  latest: string | null;
  versionLookupOk: boolean;
  behind: boolean;
  localDevInstall: boolean;
  updateSupported: boolean;
  updateCommand: string | null;
  node: { version: string; required: number; ok: boolean };
  installs: { entries: Array<{ binPath: string }>; multiple: boolean };
};

type NavItem = {
  id: string;
  href: string;
  labelKey?: string;
  label?: string;
  manage?: boolean;
  plugin?: boolean;
  icon: ReactNode;
};

type PluginDashboardNavEntry = {
  pluginId: string;
  id: string;
  route: string;
  displayName?: string;
  pinned?: boolean;
};

const MANAGE_ROUTES = [
  'roles',
  'role-profiles',
  'bot-defaults',
  'skills',
  'plugins',
  'team',
  'connectors',
  'insights',
  'whiteboards',
];

const NAV_ITEMS: NavItem[] = [
  {
    id: 'overview',
    href: '#/',
    labelKey: 'nav.overview',
    icon: (
      <>
        <rect x="1.5" y="1.5" width="5.4" height="5.4" rx="1.5" />
        <rect x="9.1" y="1.5" width="5.4" height="5.4" rx="1.5" />
        <rect x="1.5" y="9.1" width="5.4" height="5.4" rx="1.5" />
        <rect x="9.1" y="9.1" width="5.4" height="5.4" rx="1.5" />
      </>
    ),
  },
  { id: 'sessions', href: '#/sessions', labelKey: 'nav.sessions', icon: <path d="M2 3.5h12v7H6l-3 3v-3H2z" /> },
  {
    id: 'groups',
    href: '#/groups',
    labelKey: 'nav.groups',
    icon: (
      <>
        <circle cx="5.6" cy="5.8" r="2.4" />
        <circle cx="11" cy="6.8" r="1.9" />
        <path d="M1.8 13.2c.5-2.4 2-3.6 3.8-3.6s3.3 1.2 3.8 3.6M9.8 12.6c.4-1.7 1.5-2.6 2.8-2.6 1 0 1.9.5 2.4 1.6" />
      </>
    ),
  },
  { id: 'roles', href: '#/roles', labelKey: 'nav.roles', manage: true, icon: <><path d="M8 1.8l5.2 2v3.4c0 3.4-2.2 5.9-5.2 7-3-1.1-5.2-3.6-5.2-7V3.8z" /><path d="M5.8 8l1.6 1.6 2.8-3" /></> },
  {
    id: 'monitoring',
    href: '#/monitoring',
    labelKey: 'nav.monitoring',
    icon: (
      <>
        <path d="M2 9.2h2.3l1.3-4.8 2.5 8.4 1.8-5.1h4.1" />
        <path d="M2 2.5h12v11H2z" />
      </>
    ),
  },
  { id: 'insights', href: '#/insights', labelKey: 'nav.insights', manage: true, icon: <><path d="M2 2v12h12M5 11V7M8.5 11V4.5M12 11V8.5" /></> },
  {
    id: 'workflows',
    href: '#/workflows',
    labelKey: 'nav.workflows',
    icon: (
      <>
        <circle cx="3.4" cy="3.6" r="1.9" />
        <circle cx="3.4" cy="12.4" r="1.9" />
        <circle cx="12.6" cy="8" r="1.9" />
        <path d="M5.2 4.4l5.6 2.8M5.2 11.6l5.6-2.8" />
      </>
    ),
  },
  { id: 'schedules', href: '#/schedules', labelKey: 'nav.schedules', icon: <><circle cx="8" cy="8" r="6.2" /><path d="M8 4.5V8l2.4 1.6" /></> },
  { id: 'whiteboards', href: '#/whiteboards', labelKey: 'nav.whiteboards', manage: true, icon: <><rect x="2.2" y="2.2" width="11.6" height="11.6" rx="2" /><path d="M4.8 5.2h6.4M4.8 8h6.4M4.8 10.8h4" /></> },
  { id: 'office', href: '#/office', labelKey: 'nav.office', icon: <><rect x="3" y="4" width="10" height="7" rx="2" /><circle cx="6" cy="7.5" r="1" /><circle cx="10" cy="7.5" r="1" /><path d="M8 4V2M4.5 11v2M11.5 11v2" /></> },
  { id: 'bot-defaults', href: '#/bot-defaults', labelKey: 'nav.botDefaults', manage: true, icon: <><rect x="2.5" y="5" width="11" height="8" rx="2" /><circle cx="5.8" cy="9" r="1" /><circle cx="10.2" cy="9" r="1" /><path d="M8 5V2.5M5.5 13v1.2M10.5 13v1.2" /></> },
  { id: 'skills', href: '#/skills', labelKey: 'nav.skills', manage: true, icon: <><path d="M3 2.5h10v3H3zM3 7h10v6.5H3z" /><path d="M5.4 9.2h5.2M5.4 11.2h3.8" /></> },
  { id: 'plugins', href: '#/plugins', label: '插件', manage: true, icon: <><path d="M6.4 1.8h3.2v3h2.8v3.2H9.6v2.8H6.4V8H3.6V4.8h2.8z" /><path d="M2.2 11.8h11.6v2.4H2.2z" /></> },
  { id: 'team', href: '#/team', labelKey: 'nav.team', manage: true, icon: <><circle cx="8" cy="8" r="6.2" /><path d="M1.8 8h12.4M8 1.8c-2 1.8-2 10.6 0 12.4 2-1.8 2-10.6 0-12.4z" /></> },
  { id: 'connectors', href: '#/connectors', labelKey: 'nav.connectors', manage: true, icon: <><path d="M5.5 6.5v-3a2.5 2.5 0 0 1 5 0v3" /><rect x="3.5" y="6.5" width="9" height="7" rx="2" /></> },
  { id: 'settings', href: '#/settings', labelKey: 'nav.settings', icon: <><path d="M8 1.75 9.35 2.05 10 3.28l1.38.3 1.04-.96.96.96-.96 1.04.3 1.38 1.23.65L14.25 8l-.3 1.35-1.23.65-.3 1.38.96 1.04-.96.96-1.04-.96-1.38.3-.65 1.23L8 14.25l-1.35-.3L6 12.72l-1.38-.3-1.04.96-.96-.96.96-1.04-.3-1.38-1.23-.65L1.75 8l.3-1.35 1.23-.65.3-1.38-.96-1.04.96-.96 1.04.96 1.38-.3.65-1.23z" /><circle cx="8" cy="8" r="2" /></> },
];

let pinnedPluginNavItems: NavItem[] = [];

let isAuthed = true;
let publicReadOnly = false;
let activeHash = location.hash || '#/';
let ownerAvatar: OwnerAvatar | null = null;
let updateBehind = false;
let latestVersion: string | null = null;
let updateBadgeKind: 'botmux' | 'codex' | null = null;
let botmuxUpdateStatus: BotmuxUpdateStatus | null = null;
let routeRoot: HTMLElement | null = null;
let appRoot: ReturnType<typeof createRoot> | null = null;

const routeState = createDashboardRouteState();
const OWNER_AVATAR_KEY = 'botmux.ownerAvatar.v1';
const BUSY_STATUSES = new Set(['working', 'analyzing', 'active', 'starting']);
const AUTH_EXPIRED_EVENT = 'botmux:auth-expired';

function icon(children: ReactNode): ReactNode {
  return <svg viewBox="0 0 16 16" aria-hidden="true">{children}</svg>;
}

function labelOf(item: NavItem): string {
  return item.labelKey ? t(item.labelKey) : (item.label ?? '');
}

function isActiveNav(item: NavItem, hash: string): boolean {
  const current = hash || '#/';
  if (item.id === 'plugins' && pinnedPluginNavItems.some(plugin => (
    plugin.href === current || current.startsWith(`${plugin.href}?`) || current.startsWith(`${plugin.href}/`)
  ))) {
    return false;
  }
  if (
    item.id === 'sessions' &&
    (current === '#/monitor-room' || current.startsWith('#/monitor-room?') || current.startsWith('#/monitor-room/'))
  ) {
    return true;
  }
  if (item.id === 'connectors' && (current === '#/webhook-logs' || current.startsWith('#/webhook-logs?') || current.startsWith('#/webhook-logs/'))) {
    return true;
  }
  return item.href === current || (
    item.href !== '#/' && (current.startsWith(`${item.href}?`) || current.startsWith(`${item.href}/`))
  );
}

function sidebarNavItems(): NavItem[] {
  if (pinnedPluginNavItems.length === 0) return NAV_ITEMS;
  const pluginIndex = NAV_ITEMS.findIndex(item => item.id === 'plugins');
  if (pluginIndex < 0) return [...NAV_ITEMS, ...pinnedPluginNavItems];
  return [
    ...NAV_ITEMS.slice(0, pluginIndex + 1),
    ...pinnedPluginNavItems,
    ...NAV_ITEMS.slice(pluginIndex + 1),
  ];
}

function navClassName(item: NavItem): string | undefined {
  const classes = [];
  if (isActiveNav(item, activeHash)) classes.push('active');
  if (item.id === 'settings' && updateBehind) classes.push('nav-has-update');
  return classes.length ? classes.join(' ') : undefined;
}

function readShellLocale(): DashboardLocale | null {
  const fromSearch = normalizeDashboardLocale(new URLSearchParams(location.search).get('locale'));
  if (fromSearch) return fromSearch;

  const queryIndex = location.hash.indexOf('?');
  if (queryIndex < 0) return null;
  // Desktop keeps shell flags inside the hash so auth redirects preserve them.
  return normalizeDashboardLocale(new URLSearchParams(location.hash.slice(queryIndex + 1)).get('locale'));
}

function applyShellLocaleFromHash(): boolean {
  const shellLocale = readShellLocale();
  if (!shellLocale || shellLocale === ui.locale) return false;
  // Desktop changes locale by rewriting the embedded webview hash. That is an
  // in-page navigation, so the dashboard must re-apply locale before routing.
  ui.setLocale(shellLocale);
  return true;
}

function readHashActionParams(): { path: string; params: URLSearchParams } | null {
  const queryIndex = location.hash.indexOf('?');
  if (queryIndex < 0) return null;
  return {
    path: location.hash.slice(0, queryIndex) || '#/',
    params: new URLSearchParams(location.hash.slice(queryIndex + 1)),
  };
}

function consumeDesktopShellRouteAction(): boolean {
  const action = readHashActionParams();
  const open = action?.params.get('open');
  if (!action || !open) return false;
  if (open !== 'bot-onboarding' && open !== 'create-session') return false;

  action.params.delete('open');
  const query = action.params.toString();
  // Desktop uses hash flags as one-shot commands; clear them so locale/route
  // re-renders do not reopen the same dialog.
  history.replaceState(null, '', query ? `${action.path}?${query}` : action.path);
  if (open === 'bot-onboarding') {
    window.dispatchEvent(new Event(OPEN_BOT_ONBOARDING_EVENT));
  } else {
    requestOpenCreateSession();
  }
  return true;
}

function updateBadgeTitle(): string {
  const version = latestVersion ? `v${latestVersion}` : '';
  return updateBadgeKind === 'codex'
    ? t('update.navRuntimeBadgeTitle', { version })
    : t('update.navBadgeTitle', { version });
}

function setRouteRoot(node: HTMLElement | null): void {
  routeRoot = node;
}

function getRouteRoot(): HTMLElement {
  if (routeRoot) return routeRoot;
  const el = document.getElementById('root');
  if (!el) throw new Error('dashboard root is not mounted');
  routeRoot = el;
  return el;
}

function ThemeMenuSlot(): JSX.Element {
  useEffect(() => {
    initThemeMenu();
  }, []);
  useEffect(() => {
    paintThemeMenu();
  });
  return (
    <div className="theme-menu" id="theme-menu">
      <button
        type="button"
        className="theme-menu-btn"
        id="theme-menu-btn"
        aria-haspopup="listbox"
        aria-expanded="false"
        aria-label="Theme"
      >
        <span className="tm-ic">
          <svg
            className="tm-svg"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <circle cx="13.5" cy="6.5" r=".5" fill="currentColor" />
            <circle cx="17.5" cy="10.5" r=".5" fill="currentColor" />
            <circle cx="8.5" cy="7.5" r=".5" fill="currentColor" />
            <circle cx="6.5" cy="12.5" r=".5" fill="currentColor" />
            <path d="M12 2a10 10 0 0 0 0 20h1.7a2.3 2.3 0 0 0 1.6-4c-.5-.5-.2-1.3.5-1.3H17a5 5 0 0 0 5-5 9.7 9.7 0 0 0-10-9.7z" />
          </svg>
        </span>
      </button>
      <div className="theme-menu-pop" id="theme-menu-pop" role="listbox" hidden />
    </div>
  );
}

function dashboardStatusSummary(): TopbarStatusSummary {
  const sessions = [...store.sessions.values()] as Array<Record<string, any>>;
  const active = sessions.filter(s => s.status !== 'closed');
  const attention = active
    .map(s => ({ s, reason: attentionReason(s) }))
    .filter((x): x is { s: Record<string, any>; reason: string } => !!x.reason)
    .sort((a, b) => attentionWaitSince(a.s) - attentionWaitSince(b.s));
  const attentionIds = new Set(attention.map(item => String(item.s.sessionId ?? '')));
  const working = active.filter(s => BUSY_STATUSES.has(String(s.status)) && !attentionIds.has(String(s.sessionId ?? ''))).length;
  const longest = attention[0] ?? null;
  const onlineBots = buildBotCards(sessions).filter(c => c.online || c.active.length > 0).length;
  const idle = Math.max(0, active.length - attention.length - working);
  return {
    working,
    attention: attention.length,
    idle,
    onlineBots,
    attentionNotice: longest ? {
      count: attention.length,
      time: relTime(attentionWaitSince(longest.s)),
      bot: botDisplayName(longest.s),
      reason: longest.reason,
    } : null,
  };
}

function TopbarStatusRow(props: { label: string; value: number; hot?: boolean }): JSX.Element {
  return (
    <div className={`topbar-status-row${props.hot ? ' topbar-status-row-hot' : ''}`}>
      <span>{props.label}</span>
      <b className={props.value > 0 ? 'status-count-on' : undefined}>{props.value}</b>
    </div>
  );
}

function TopbarStatusDonut(props: { summary: TopbarStatusSummary }): JSX.Element {
  const { attention, idle, working } = props.summary;
  const total = working + attention + idle;
  const background = total === 0
    ? 'conic-gradient(var(--border) 0 360deg)'
    : (() => {
        const workingDeg = (working / total) * 360;
        const attentionDeg = workingDeg + (attention / total) * 360;
        return `conic-gradient(var(--accent) 0 ${workingDeg}deg, var(--warning) ${workingDeg}deg ${attentionDeg}deg, var(--success) ${attentionDeg}deg 360deg)`;
      })();
  return (
    <div className="topbar-status-donut-wrap" aria-hidden="true">
      <div className="topbar-status-donut" style={{ background }} />
      <div className="topbar-status-donut-center">
        <b>{total}</b>
        <span>{t('overview.openSessions')}</span>
      </div>
    </div>
  );
}

function closeThemeMenuFromStatus(): void {
  window.dispatchEvent(new Event(CLOSE_THEME_MENU_EVENT));
}

function TopbarStatusMenu(props: { summary: TopbarStatusSummary; autoOpen?: boolean }): JSX.Element {
  const { autoOpen = false, summary } = props;
  const [open, setOpen] = useState(false);
  const [autoDismissed, setAutoDismissed] = useState(false);
  const [hoverSuppressed, setHoverSuppressed] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const autoVisible = autoOpen && !autoDismissed;
  const visible = open || autoVisible;

  useEffect(() => {
    if (!autoOpen) setAutoDismissed(false);
  }, [autoOpen]);

  useEffect(() => {
    if (!visible) return undefined;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && rootRef.current?.contains(target)) return;
      setOpen(false);
      setAutoDismissed(true);
    };
    document.addEventListener('pointerdown', closeOnOutsidePointer);
    return () => document.removeEventListener('pointerdown', closeOnOutsidePointer);
  }, [visible]);

  const toggle = () => {
    closeThemeMenuFromStatus();
    if (visible) {
      setOpen(false);
      setAutoDismissed(true);
      setHoverSuppressed(true);
      return;
    }
    setHoverSuppressed(false);
    setOpen(true);
  };

  return (
    <div
      ref={rootRef}
      className={`topbar-status-menu${autoVisible ? ' topbar-status-auto-open' : ''}${open ? ' is-open' : ''}${hoverSuppressed ? ' suppress-hover' : ''}`}
      onPointerEnter={closeThemeMenuFromStatus}
      onPointerLeave={() => setHoverSuppressed(false)}
      onFocusCapture={closeThemeMenuFromStatus}
      onBlur={event => {
        const next = event.relatedTarget;
        if (!(next instanceof Node) || !event.currentTarget.contains(next)) setOpen(false);
      }}
      onKeyDown={event => {
        if (event.key !== 'Escape') return;
        setOpen(false);
        setAutoDismissed(true);
        setHoverSuppressed(true);
        (event.currentTarget.querySelector('#status') as HTMLButtonElement | null)?.focus();
      }}
    >
      <button
        type="button"
        id="status"
        className="connection-status"
        aria-haspopup="true"
        aria-expanded={visible}
        onClick={toggle}
      >
        {t('overview.sessionOverview')}
      </button>
      <div className="topbar-status-pop">
        {summary.attentionNotice ? (
          <a className="topbar-attention-notice" href="#/sessions">
            <span className="topbar-attention-dot" aria-hidden="true" />
            <span className="topbar-attention-copy">
              <b>{t('strip.pending', { count: summary.attentionNotice.count })}</b>
              <small>{t('strip.longestCompact', {
                time: summary.attentionNotice.time,
                bot: summary.attentionNotice.bot,
                reason: summary.attentionNotice.reason,
              })}</small>
            </span>
            <span className="topbar-attention-action">{t('strip.handle')}</span>
          </a>
        ) : null}
        <div className="topbar-status-list">
          <TopbarStatusRow label={t('overview.workingSessions')} value={summary.working} />
          <TopbarStatusRow label={t('overview.idleSessions')} value={summary.idle} />
          <TopbarStatusRow label={t('overview.attention')} value={summary.attention} hot={summary.attention > 0} />
          <TopbarStatusRow label={t('overview.onlineBots')} value={summary.onlineBots} />
        </div>
        <TopbarStatusDonut summary={summary} />
      </div>
    </div>
  );
}

function AuthExpiredOverlay(props: { open: boolean; onClose(): void }): JSX.Element | null {
  if (!props.open) return null;
  return (
    <div
      id="auth-expired-overlay"
      className="auth-expired-overlay"
      role="presentation"
      onClick={event => { if (event.target === event.currentTarget) props.onClose(); }}
    >
      <div className="auth-expired-dialog" role="dialog" aria-modal="true" aria-labelledby="auth-expired-title">
        <h2 id="auth-expired-title">访问链接已失效</h2>
        <p>当前链接/访问已失效，请使用最新授权链接重新进入（运行 botmux dashboard 获取）。</p>
        <button id="auth-expired-dismiss" type="button" className="primary" onClick={props.onClose}>知道了</button>
      </div>
    </div>
  );
}

type TopbarUpdatePhase = 'idle' | BotmuxUpdatePhase | 'error';

type RollbackVersion = {
  version: string;
  publishedAt: string | null;
};

function formatRollbackDate(publishedAt: string): string {
  const date = new Date(publishedAt);
  if (Number.isNaN(date.getTime())) return publishedAt.slice(0, 10);
  try {
    return new Intl.DateTimeFormat(ui.locale === 'zh' ? 'zh-CN' : 'en-US', {
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
    }).format(date);
  } catch {
    return publishedAt.slice(0, 10);
  }
}

async function dashboardInstance(): Promise<string> {
  const response = await fetch('/__selfcheck', { cache: 'no-store' });
  const instance = await response.text();
  if (!response.ok || !instance) {
    throw new Error(t('update.healthCheckFailed'));
  }
  return instance;
}

function TopbarVersionControl(props: {
  status: BotmuxUpdateStatus | null;
  onRefresh(): Promise<boolean>;
}): JSX.Element | null {
  const { status } = props;
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<TopbarUpdatePhase>('idle');
  const [refreshing, setRefreshing] = useState(false);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const [errorDetail, setErrorDetail] = useState('');
  const [rollbackOpen, setRollbackOpen] = useState(false);
  const [rollbackLoaded, setRollbackLoaded] = useState(false);
  const [rollbackLoading, setRollbackLoading] = useState(false);
  const [rollbackLoadFailed, setRollbackLoadFailed] = useState(false);
  const [rollbackVersions, setRollbackVersions] = useState<RollbackVersion[]>([]);
  const [selectedRollback, setSelectedRollback] = useState<string | null>(null);
  const [activeRollback, setActiveRollback] = useState<string | null>(null);
  const actionInFlightRef = useRef(false);
  const reconnectTimerRef = useRef<number | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const clearReconnectTimer = () => {
    if (reconnectTimerRef.current === null) return;
    window.clearTimeout(reconnectTimerRef.current);
    reconnectTimerRef.current = null;
  };

  useEffect(() => {
    actionInFlightRef.current = false;
    setPhase('idle');
    setRefreshing(false);
    setRefreshFailed(false);
    setErrorDetail('');
    setRollbackOpen(false);
    setRollbackLoaded(false);
    setRollbackLoading(false);
    setRollbackLoadFailed(false);
    setRollbackVersions([]);
    setSelectedRollback(null);
    setActiveRollback(null);
  }, [status?.current, status?.latest]);

  useEffect(() => {
    if (status) setRefreshFailed(status.versionLookupOk === false);
  }, [status]);

  useEffect(() => {
    if (!open) setRollbackOpen(false);
  }, [open]);

  useEffect(() => () => clearReconnectTimer(), []);

  useEffect(() => {
    if (!open) return;
    const closeOnPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener('pointerdown', closeOnPointerDown);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnPointerDown);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [open]);

  if (!status) return null;

  const behind = status.behind && !!status.latest;
  const unknown = !status.latest;
  const automatic = behind && status.updateSupported && !status.localDevInstall && status.node.ok;
  const rollbackSupported = status.updateSupported && !status.localDevInstall && status.node.ok;
  const busy = phase === 'updating' || phase === 'restarting';
  const command = status.updateCommand ?? 'botmux update';
  const currentVersion = `v${status.current}`;
  const latestVersion = status.latest ? `v${status.latest}` : '';
  const unavailableReason = status.localDevInstall
    ? t('update.localDev')
    : !status.updateSupported
      ? t('update.unsupportedInstall')
      : !status.node.ok
        ? t('update.nodeWarn', { version: status.node.version, required: status.node.required })
        : '';

  const pollReconnect = (previousInstance: string) => {
    const startedAt = Date.now();
    const tick = async (): Promise<void> => {
      try {
        const response = await fetch('/__selfcheck', { cache: 'no-store' });
        const instance = await response.text();
        if (response.ok && instance && instance !== previousInstance) {
          location.reload();
          return;
        }
      } catch { /* dashboard is still restarting */ }
      if (Date.now() - startedAt > 90_000) {
        actionInFlightRef.current = false;
        setPhase('error');
        setErrorDetail(t('update.restartSlow'));
        return;
      }
      reconnectTimerRef.current = window.setTimeout(() => void tick(), 2_000);
    };
    reconnectTimerRef.current = window.setTimeout(() => void tick(), 3_000);
  };

  const run = async () => {
    if (!behind) return;
    if (!automatic) {
      setOpen(false);
      location.hash = '#/settings';
      return;
    }
    if (actionInFlightRef.current) return;

    actionInFlightRef.current = true;
    setActiveRollback(null);
    setRefreshFailed(false);
    setErrorDetail('');
    try {
      const previousInstance = await dashboardInstance();
      const result = await updateAndRestartBotmux(fetch, setPhase);
      if (!result.restarted) {
        // Update installed but the restart handoff failed — surface it
        // directly instead of polling for a reconnect that will never come.
        actionInFlightRef.current = false;
        setPhase('error');
        setErrorDetail(t('update.restartFailed', { detail: result.restartError ?? 'unknown' }));
        return;
      }
      pollReconnect(previousInstance);
    } catch (error) {
      actionInFlightRef.current = false;
      setPhase('error');
      setErrorDetail(error instanceof Error ? error.message : String(error));
    }
  };

  const loadRollbackVersions = async (force = false): Promise<boolean> => {
    if (rollbackLoading) return !rollbackLoadFailed;
    setRollbackLoading(true);
    setRollbackLoadFailed(false);
    try {
      const response = await fetch(`/api/update/versions${force ? '?refresh=1' : ''}`, { cache: 'no-store' });
      const body = await response.json().catch(() => null) as Record<string, unknown> | null;
      if (!body || !Array.isArray(body.versions)) throw new Error('Invalid rollback versions response');
      const versions = body.versions
        .filter((entry): entry is RollbackVersion => {
          if (!entry || typeof entry !== 'object') return false;
          const value = entry as Record<string, unknown>;
          return typeof value.version === 'string'
            && (typeof value.publishedAt === 'string' || value.publishedAt === null);
        })
        .slice(0, 3);
      setRollbackVersions(versions);
      setSelectedRollback(value => versions.some(entry => entry.version === value) ? value : null);
      setRollbackLoaded(true);
      const ok = response.ok && body.ok === true;
      setRollbackLoadFailed(!ok);
      return ok;
    } catch {
      setRollbackLoaded(true);
      setRollbackLoadFailed(true);
      return false;
    } finally {
      setRollbackLoading(false);
    }
  };

  const runRollback = async () => {
    if (!selectedRollback || !rollbackSupported || rollbackLoading || actionInFlightRef.current) return;

    actionInFlightRef.current = true;
    setActiveRollback(selectedRollback);
    setRefreshFailed(false);
    setErrorDetail('');
    try {
      const previousInstance = await dashboardInstance();
      await updateAndRestartBotmux(fetch, setPhase, selectedRollback);
      pollReconnect(previousInstance);
    } catch (error) {
      actionInFlightRef.current = false;
      setPhase('error');
      setErrorDetail(error instanceof Error ? error.message : String(error));
    }
  };

  const refresh = async () => {
    if (refreshing || busy) return;
    setRefreshing(true);
    setRefreshFailed(false);
    try {
      const statusOk = await props.onRefresh();
      if (rollbackOpen) await loadRollbackVersions(true);
      setRefreshFailed(!statusOk);
    } finally {
      setRefreshing(false);
    }
  };

  const message = phase === 'updating'
    ? activeRollback
      ? t('update.rollbackInstalling', { version: activeRollback })
      : t('update.updating', { command })
    : phase === 'restarting'
      ? activeRollback
        ? t('update.rollbackRestarting', { version: activeRollback })
        : t('update.restarting')
      : phase === 'error'
        ? activeRollback
          ? t('update.rollbackFailed', { detail: errorDetail })
          : t('update.updateFailed', { detail: errorDetail })
        : refreshFailed
          ? t('update.topbarRefreshFailed')
          : behind
          ? automatic
            ? t('update.versionUpgradePrompt', { version: latestVersion })
            : unavailableReason
          : status.latest
            ? t('update.upToDate')
            : t('update.checkUnavailable');
  const action = !automatic
    ? t('update.topbarReview')
    : phase === 'error'
      ? t('update.topbarRetry')
      : phase === 'idle'
        ? t('update.topbarAction')
        : t('update.topbarWorking');
  const versionSignal = phase === 'error' || (refreshFailed && unknown)
    ? { className: 'is-error', symbol: '!' }
    : behind
      ? { className: 'has-update', symbol: '↑' }
      : unknown
        ? { className: 'is-unknown', symbol: '?' }
        : { className: 'is-current', symbol: '✓' };

  return (
    <div ref={rootRef} className={`dashboard-version-control${open ? ' is-open' : ''}`}>
      <button
        ref={triggerRef}
        type="button"
        className={`dashboard-version-chip${behind ? ' has-update' : ''}${unknown ? ' is-unknown' : ''}${phase === 'error' ? ' is-error' : ''}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`${currentVersion}. ${message}`}
        title={message}
        onClick={() => setOpen(value => !value)}
      >
        <span>{currentVersion}</span>
        {busy
          ? <span className="dashboard-update-spinner" aria-hidden="true" />
          : <span
              className={`dashboard-version-state ${versionSignal.className}`}
              aria-hidden="true"
            >{versionSignal.symbol}</span>}
      </button>
      {open ? (
        <section
          className="dashboard-version-popover"
          role="dialog"
          aria-modal="false"
          aria-labelledby="dashboard-version-title"
        >
          <header className="dashboard-version-popover-head">
            <strong id="dashboard-version-title">{t('update.current')}</strong>
            <div className="dashboard-version-head-actions">
              <button
                type="button"
                className={`dashboard-version-refresh${refreshing ? ' is-refreshing' : ''}`}
                aria-label={t(refreshing ? 'update.topbarRefreshing' : 'update.topbarRefresh')}
                title={t(refreshing ? 'update.topbarRefreshing' : 'update.topbarRefresh')}
                disabled={refreshing || rollbackLoading || busy}
                onClick={() => void refresh()}
              >
                <svg viewBox="0 0 16 16" aria-hidden="true">
                  <path d="M13.2 5.7A5.8 5.8 0 1 0 13 10.8" />
                  <path d="M13.2 2.8v2.9h-2.9" />
                </svg>
              </button>
              <button
                type="button"
                className="dashboard-version-close"
                aria-label={t('update.topbarClose')}
                onClick={() => setOpen(false)}
              >×</button>
            </div>
          </header>
          <div className="dashboard-version-popover-body">
            <div className="dashboard-version-current">
              <strong>{currentVersion}</strong>
              <span className={versionSignal.className} aria-hidden="true">
                {busy ? <span className="dashboard-update-spinner" /> : versionSignal.symbol}
              </span>
            </div>
            <p
              className={`dashboard-version-message${phase === 'error' || refreshFailed ? ' is-error' : ''}`}
              role={phase === 'error' || refreshFailed ? 'alert' : 'status'}
              aria-live="polite"
            >{message}</p>
            <a
              className="dashboard-version-release-link"
              href="https://github.com/deepcoldy/botmux/releases"
              target="_blank"
              rel="noopener noreferrer"
            >
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path d="M8 1.5a6.5 6.5 0 0 0-2.1 12.65c.33.06.45-.14.45-.32v-1.26c-1.84.4-2.23-.78-2.23-.78-.3-.76-.73-.96-.73-.96-.6-.41.05-.4.05-.4.66.05 1 .68 1 .68.59 1 1.54.72 1.92.55.06-.42.23-.72.42-.88-1.47-.17-3.02-.74-3.02-3.28 0-.72.26-1.32.68-1.78-.07-.17-.3-.84.07-1.75 0 0 .56-.18 1.79.68A6.2 6.2 0 0 1 8 4.63a6.2 6.2 0 0 1 1.71.22c1.23-.86 1.79-.68 1.79-.68.37.91.14 1.58.07 1.75.42.46.68 1.06.68 1.78 0 2.55-1.55 3.11-3.03 3.28.24.21.45.61.45 1.23v1.62c0 .18.12.38.46.32A6.5 6.5 0 0 0 8 1.5Z" />
              </svg>
              <span>{t('update.changelogViewOnGitHub')}</span>
            </a>
            {(behind || rollbackOpen) && status.installs.multiple ? (
              <details className="dashboard-version-installs">
                <summary>{t('update.multiInstallWarn')}</summary>
                <ul>{status.installs.entries.map(entry => <li key={entry.binPath}>{entry.binPath}</li>)}</ul>
              </details>
            ) : null}
            {rollbackSupported ? (
              <details
                className="dashboard-version-rollback"
                open={rollbackOpen}
                aria-busy={rollbackLoading}
                onToggle={event => {
                  const nextOpen = event.currentTarget.open;
                  setRollbackOpen(nextOpen);
                  if (nextOpen && !rollbackLoaded && !rollbackLoading) void loadRollbackVersions();
                }}
              >
                <summary>
                  <svg viewBox="0 0 16 16" aria-hidden="true">
                    <circle cx="8" cy="8" r="5.5" />
                    <path d="M8 4.8V8l2.2 1.3" />
                  </svg>
                  <span>{t('update.rollbackTitle')}</span>
                  <span className="dashboard-version-rollback-chevron" aria-hidden="true">⌄</span>
                </summary>
                <div className="dashboard-version-rollback-body">
                  {rollbackLoading && rollbackVersions.length === 0 ? (
                    <p className="dashboard-version-rollback-status" role="status" aria-live="polite">
                      <span className="dashboard-update-spinner" aria-hidden="true" />
                      {t('update.rollbackLoading')}
                    </p>
                  ) : null}
                  {rollbackLoadFailed ? (
                    <p className="dashboard-version-rollback-load-error" role="alert">
                      <span>{t('update.rollbackLoadFailed')}</span>
                      <button type="button" disabled={rollbackLoading} onClick={() => void loadRollbackVersions(true)}>
                        {t('update.rollbackRetry')}
                      </button>
                    </p>
                  ) : null}
                  {rollbackLoaded && !rollbackLoading && !rollbackLoadFailed && rollbackVersions.length === 0 ? (
                    <p className="dashboard-version-rollback-status">{t('update.rollbackEmpty')}</p>
                  ) : null}
                  {rollbackVersions.length > 0 ? (
                    <fieldset disabled={busy || rollbackLoading || rollbackLoadFailed}>
                      <legend>{t('update.rollbackHint')}</legend>
                      <div className="dashboard-version-rollback-options">
                        {rollbackVersions.map(entry => (
                          <label
                            key={entry.version}
                            className={selectedRollback === entry.version ? 'is-selected' : ''}
                          >
                            <input
                              type="radio"
                              name="dashboard-rollback-version"
                              value={entry.version}
                              checked={selectedRollback === entry.version}
                              onChange={() => setSelectedRollback(entry.version)}
                            />
                            <strong>v{entry.version}</strong>
                            {entry.publishedAt ? (
                              <time dateTime={entry.publishedAt}>{formatRollbackDate(entry.publishedAt)}</time>
                            ) : null}
                          </label>
                        ))}
                      </div>
                    </fieldset>
                  ) : null}
                  {selectedRollback ? (
                    <p id="dashboard-version-rollback-risk" className="dashboard-version-rollback-risk" role="note">
                      <svg viewBox="0 0 16 16" aria-hidden="true">
                        <path d="M7.1 2.3 1.8 12a1 1 0 0 0 .9 1.5h10.6a1 1 0 0 0 .9-1.5L8.9 2.3a1 1 0 0 0-1.8 0Z" />
                        <path d="M8 5.5v3.6M8 11.6h.01" />
                      </svg>
                      <span>
                        {t('update.rollbackRisk', { version: selectedRollback })}{' '}
                        <a
                          href={`https://github.com/deepcoldy/botmux/releases/tag/v${encodeURIComponent(selectedRollback)}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          aria-label={t('update.rollbackReleaseNotesA11y', { version: selectedRollback })}
                        >{t('update.rollbackReleaseNotes', { version: selectedRollback })}</a>
                      </span>
                    </p>
                  ) : null}
                  {rollbackVersions.length > 0 ? (
                    <button
                      type="button"
                      className="dashboard-version-rollback-action"
                      disabled={!selectedRollback || rollbackLoading || rollbackLoadFailed || busy}
                      aria-describedby={selectedRollback ? 'dashboard-version-rollback-risk' : undefined}
                      onClick={() => void runRollback()}
                    >
                      {busy && activeRollback ? <span className="dashboard-update-spinner" aria-hidden="true" /> : null}
                      {selectedRollback
                        ? phase === 'error' && activeRollback === selectedRollback
                          ? t('update.rollbackRetry')
                          : t('update.rollbackAction', { version: selectedRollback })
                        : t('update.rollbackSelect')}
                    </button>
                  ) : null}
                </div>
              </details>
            ) : null}
          </div>
          {behind && !rollbackOpen && !activeRollback ? (
            <footer className="dashboard-version-popover-actions">
              <button type="button" className="dashboard-version-secondary" onClick={() => setOpen(false)}>
                {busy ? t('update.topbarClose') : t('update.topbarLater')}
              </button>
              <button
                type="button"
                className="dashboard-version-primary"
                disabled={busy}
                onClick={() => void run()}
              >
                {busy ? <span className="dashboard-update-spinner" aria-hidden="true" /> : null}
                {action}
              </button>
            </footer>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}

function DashboardShell(): JSX.Element {
  const statusSummary = dashboardStatusSummary();
  const [botOnboardingOpen, setBotOnboardingOpen] = useState(false);
  const [authExpiredOpen, setAuthExpiredOpen] = useState(false);
  const [statusAutoOpen, setStatusAutoOpen] = useState(false);
  const previousAttentionRef = useRef(statusSummary.attention);
  const statusAutoOpenTimerRef = useRef<number | null>(null);

  const clearStatusAutoOpenTimer = () => {
    if (statusAutoOpenTimerRef.current === null) return;
    window.clearTimeout(statusAutoOpenTimerRef.current);
    statusAutoOpenTimerRef.current = null;
  };

  useEffect(() => {
    const open = () => setBotOnboardingOpen(true);
    window.addEventListener(OPEN_BOT_ONBOARDING_EVENT, open);
    return () => window.removeEventListener(OPEN_BOT_ONBOARDING_EVENT, open);
  }, []);
  useEffect(() => {
    const open = () => setAuthExpiredOpen(true);
    window.addEventListener(AUTH_EXPIRED_EVENT, open);
    // Catch a 401 that latched expiredShown before this listener mounted (else the overlay
    // would be permanently suppressed by the module-level guard).
    if (expiredShown) setAuthExpiredOpen(true);
    return () => window.removeEventListener(AUTH_EXPIRED_EVENT, open);
  }, []);
  useEffect(() => {
    return () => clearStatusAutoOpenTimer();
  }, []);
  useEffect(() => {
    const previousAttention = previousAttentionRef.current;
    previousAttentionRef.current = statusSummary.attention;

    if (statusSummary.attention === 0) {
      clearStatusAutoOpenTimer();
      setStatusAutoOpen(false);
      return;
    }
    if (previousAttention !== 0 || document.body.classList.contains('theme-menu-open')) return;

    setStatusAutoOpen(true);
    clearStatusAutoOpenTimer();
    statusAutoOpenTimerRef.current = window.setTimeout(() => {
      statusAutoOpenTimerRef.current = null;
      setStatusAutoOpen(false);
    }, 4000);
  }, [statusSummary.attention]);
  const closeAuthExpired = () => {
    expiredShown = false;
    setAuthExpiredOpen(false);
  };
  return (
    <>
      <div className="aurora" aria-hidden="true"><i className="a1" /><i className="a2" /><i className="a3" /></div>
      <div className="app-shell">
        <header className="topbar">
          <div className="topbar-left">
            <div className="topbar-brand-block">
              <a className="brand" href="#/">
                <span className="brand-mark" aria-hidden="true">
                  <img className="brand-logo-img" src="/assets/brand-logo.png" alt="" decoding="sync" loading="eager" fetchPriority="high" />
                </span>
                <strong className="brand-wordmark">Botmux</strong>
                <span className="brand-product">Dashboard</span>
              </a>
              <TopbarVersionControl status={botmuxUpdateStatus} onRefresh={() => checkUpdateBadge(true)} />
            </div>
          </div>
          <div className="topbar-actions">
            <TopbarStatusMenu summary={statusSummary} autoOpen={statusAutoOpen} />
            <div className="topbar-tool-group">
              <button
                type="button"
                className="topbar-locale-toggle"
                aria-label={ui.locale === 'zh' ? 'Switch to English' : '切换到中文'}
                title={ui.locale === 'zh' ? 'Switch to English' : '切换到中文'}
                onClick={() => setLocale(ui.locale === 'zh' ? 'en' : 'zh')}
              >
                {ui.locale === 'zh' ? 'CN' : 'EN'}
              </button>
              <ThemeMenuSlot />
              <a
                className="topbar-docs-link"
                href="https://bytedance.aiforce.cloud/app/app_4k9smq6rdxher/"
                target="_blank"
                rel="noopener noreferrer"
                title={t('nav.docs')}
                aria-label={t('nav.docs')}
              >
                {icon(<><rect x="2.2" y="2.2" width="11.6" height="11.6" rx="2" /><path d="M4.8 5.2h6.4M4.8 8h6.4M4.8 10.8h4" /></>)}
                <span>{t('nav.docs')}</span>
              </a>
            </div>
            <span className="topbar-owner" title={ownerAvatar?.name} aria-label={ownerAvatar?.name ?? 'Owner'}>
              <span className="topbar-owner-placeholder" aria-hidden="true">
                {icon(<><circle cx="8" cy="6" r="2.4" /><path d="M3.7 13c.7-2.5 2.2-3.7 4.3-3.7s3.6 1.2 4.3 3.7" /></>)}
              </span>
              {ownerAvatar?.avatarUrl ? (
                <img
                  className="topbar-owner-img"
                  src={ownerAvatar.avatarUrl}
                  alt=""
                  decoding="async"
                  referrerPolicy="no-referrer"
                  onError={(e) => { e.currentTarget.remove(); }}
                />
              ) : null}
            </span>
          </div>
        </header>
        <div className="chrome-body">
          <aside className="sidebar">
            {isAuthed ? (
              <div className="sidebar-create-actions">
                <button type="button" className="sidebar-create-btn" onClick={() => requestOpenCreateSession()}>
                  {icon(<><path d="M2 3.5h12v7H6l-3 3v-3H2z" /><path d="M8 4.9v4.2M5.9 7h4.2" /></>)}
                  <span className="sidebar-nav-label">{t('nav.createSession')}</span>
                </button>
                <button type="button" className="sidebar-create-btn" onClick={() => void openBotOnboarding()}>
                  {icon(<><rect x="2.5" y="6" width="11" height="7.5" rx="2" /><circle cx="5.8" cy="9.75" r="1" /><circle cx="10.2" cy="9.75" r="1" /><path d="M8 6V3.8M6.3 1.9h3.4" /></>)}
                  <span className="sidebar-nav-label">{t('nav.createBot')}</span>
                </button>
              </div>
            ) : null}
            <nav className="sidebar-nav" aria-label="Dashboard">
              {sidebarNavItems().filter(item => isAuthed || !item.manage).map(item => (
                <a
                  key={item.id}
                  href={item.href}
                  data-route={item.id}
                  className={[navClassName(item), item.plugin ? 'sidebar-plugin-item' : ''].filter(Boolean).join(' ') || undefined}
                  title={item.plugin ? labelOf(item) : undefined}
                >
                  {icon(item.icon)}
                  <span className="sidebar-nav-label">{labelOf(item)}</span>
                  {item.id === 'settings' && updateBehind ? (
                    <InfoTip
                      className="nav-update-tip"
                      label={updateBadgeTitle()}
                      trigger={<span className="nav-update-dot" aria-hidden="true" />}
                      preventClick={false}
                      focusable={false}
                    >
                      {updateBadgeTitle()}
                    </InfoTip>
                  ) : null}
                </a>
            ))}
            </nav>
          </aside>
          <div className="workspace">
            <dialog id="create-session-modal" className="create-session-modal" />
            <BotOnboardingDialog open={botOnboardingOpen} onClose={() => setBotOnboardingOpen(false)} />
            <main id="root" ref={setRouteRoot} />
          </div>
        </div>
      </div>
      <AuthExpiredOverlay open={authExpiredOpen} onClose={closeAuthExpired} />
    </>
  );
}

function renderShell(): void {
  appRoot?.render(<DashboardShell />);
}

function setLocale(locale: DashboardLocale): void {
  ui.setLocale(locale);
  void persistLocale(locale);
}

// ── Auth-expiry overlay ──────────────────────────────────────────────────────
let expiredShown = false;
export function showAuthExpiredOverlay(): void {
  if (expiredShown) return;
  expiredShown = true;
  window.dispatchEvent(new Event(AUTH_EXPIRED_EVENT));
}

let roToastTimer: number | undefined;
export function showReadOnlyToast(): void {
  let el = document.getElementById('readonly-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'readonly-toast';
    el.style.cssText =
      'position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:9999;' +
      'background:var(--fg,#1f2329);color:var(--bg,#fff);padding:10px 18px;' +
      'border-radius:var(--radius-lg);font-size:13px;box-shadow:0 8px 24px rgba(0,0,0,.25)';
    document.body.appendChild(el);
  }
  el.textContent = '当前是只读访问，此操作需要授权链接（运行 botmux dashboard 获取）';
  el.style.display = 'block';
  if (roToastTimer) window.clearTimeout(roToastTimer);
  roToastTimer = window.setTimeout(() => { el!.style.display = 'none'; }, 4000);
}

const origFetch = window.fetch.bind(window);
window.fetch = async function patchedFetch(
  ...args: Parameters<typeof fetch>
): ReturnType<typeof fetch> {
  const res = await origFetch(...args);
  if (res.status === 401) {
    const method = (args[1]?.method ?? 'GET').toUpperCase();
    const isRead = method === 'GET' || method === 'HEAD';
    if (isRead && !publicReadOnly) showAuthExpiredOverlay();
    else showReadOnlyToast();
  }
  return res;
};

async function loadAuthState(): Promise<void> {
  try {
    const r = await fetch('/api/settings');
    if (r.ok) {
      const j = await r.json();
      isAuthed = !!j.authed;
      ui.authed = isAuthed;
      publicReadOnly = !!(j.settings && j.settings.publicReadOnly);
      ui.publicReadOnly = publicReadOnly;
      const serverLocale = readShellLocale() ?? normalizeDashboardLocale(j.lang);
      if (serverLocale) ui.setLocale(serverLocale);
    }
  } catch { /* keep defaults */ }
}

async function loadPinnedPluginNavItems(): Promise<void> {
  try {
    const response = await fetch('/api/plugins/dashboard');
    if (!response.ok) return;
    const body = await response.json();
    const entries = (Array.isArray(body?.plugins) ? body.plugins : []) as PluginDashboardNavEntry[];
    pinnedPluginNavItems = entries
      .filter(entry => entry.pinned === true && typeof entry.route === 'string')
      .map(entry => ({
        id: `plugin:${entry.pluginId}:${entry.id}`,
        href: entry.route,
        label: entry.displayName || entry.pluginId,
        manage: true,
        plugin: true,
        icon: <><path d="M5.2 2.2h5.6v3.1l1.7 1.7-1.4 1.4-1-1v6.4H5.9V7.4l-1 1L3.5 7l1.7-1.7z" /><path d="M8 13.8v1" /></>,
      }));
    renderShell();
  } catch {
    // The core navigation remains usable when plugin metadata is unavailable.
  }
}

async function persistLocale(locale: DashboardLocale): Promise<void> {
  if (!isAuthed) return;
  try {
    await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lang: locale }),
    });
  } catch { /* best-effort; UI already switched locally */ }
}

async function checkUpdateBadge(force = false): Promise<boolean> {
  if (!isAuthed) return false;
  try {
    const r = await fetch(`/api/update/status${force ? '?refresh=1' : ''}`, { cache: 'no-store' });
    if (!r.ok) return false;
    const j = await r.json();
    botmuxUpdateStatus = j as BotmuxUpdateStatus;
    const runtime = Array.isArray(j.cliUpdates)
      ? j.cliUpdates.find((entry: any) => entry?.updateAvailable === true && entry?.latest)
      : null;
    if (j.behind === true && j.latest) {
      updateBehind = true;
      updateBadgeKind = 'botmux';
      latestVersion = String(j.latest);
    } else if (runtime) {
      updateBehind = true;
      updateBadgeKind = 'codex';
      latestVersion = String(runtime.latest);
    } else {
      updateBehind = false;
      updateBadgeKind = null;
      latestVersion = null;
    }
    renderShell();
    return j.versionLookupOk !== false;
  } catch {
    return false;
  }
}

function renderAuthRequiredPage(host: HTMLElement): void {
  host.innerHTML =
    '<section class="auth-required" style="max-width:520px;margin:64px auto;text-align:center;' +
    'background:var(--surface);color:var(--fg);border:1px solid var(--border);border-radius:var(--radius-lg);' +
    'padding:40px 36px;box-shadow:0 8px 28px rgba(0,0,0,.12)">' +
    '<h2 style="margin:0 0 12px;font-size:20px;color:var(--fg)">此页需要授权链接</h2>' +
    '<p style="margin:0 0 24px;line-height:1.7;color:var(--muted);font-size:14px">' +
    '你当前是只读访问，管理页（群角色 / Profiles / Bot 配置 / 团队 / Webhook）需要授权链接。' +
    '运行 <code>botmux dashboard</code> 获取最新链接后即可管理。</p>' +
    '<a href="#/" style="display:inline-block;padding:8px 22px;background:var(--accent);' +
    'color:var(--on-accent);border-radius:var(--radius-lg);text-decoration:none;font-size:14px">返回总览</a>' +
    '</section>';
}

async function route(): Promise<void> {
  const seq = beginDashboardRoute(routeState);
  const hash = location.hash || '#/';
  activeHash = hash;
  renderShell();

  if (!isAuthed && MANAGE_ROUTES.some(r => hash.startsWith('#/' + r))) {
    renderAuthRequiredPage(getRouteRoot());
    routeState.rerenderOnUiChange = true;
    return;
  }
  if (hash.startsWith('#/v3')) {
    window.location.replace(`#/workflows${hash.slice('#/v3'.length)}`);
    return;
  } else if (hash.startsWith('#/legacy-workflow')) {
    window.location.replace('#/workflows');
    return;
  } else if (/^#\/workflows(?:\/|-)catalog(?:[/?].*)?$/.test(hash)) {
    window.location.replace('#/workflows');
    return;
  }
  if (hash.startsWith('#/role-profiles')) {
    window.location.replace(`#/roles/profile${hash.slice('#/role-profiles'.length)}`);
    return;
  }

  try {
    const matched = findDashboardRoute(hash);
    await loadAndRenderDashboardRoute(
      routeState,
      seq,
      getRouteRoot(),
      matched ? matched.load : loadOverviewPage,
      { rerenderOnUiChange: matched ? matched.rerenderOnUiChange : false },
    );
    if (seq === routeState.seq && isAuthed) consumeDesktopShellRouteAction();
  } catch (err) {
    if (seq !== routeState.seq) return;
    if (maybeReloadBrowserForStaleRouteChunk(err, {
      href: window.location.href,
      hash,
      getSessionStorage: () => window.sessionStorage,
      reload: () => window.location.reload(),
    })) return;
    getRouteRoot().innerHTML = `<section class="page"><div class="empty">Dashboard route failed: ${escapeHtml(String(err))}</div></section>`;
    routeState.pageDispose = null;
    routeState.rerenderOnUiChange = true;
  }
}

function readCachedOwnerAvatar(): OwnerAvatar | null {
  try {
    const cached = JSON.parse(window.localStorage.getItem(OWNER_AVATAR_KEY) ?? 'null');
    if (cached?.avatarUrl) {
      return {
        avatarUrl: String(cached.avatarUrl),
        name: cached.name ? String(cached.name) : undefined,
      };
    }
  } catch { /* ignore corrupt cache */ }
  return null;
}

function initOwnerAvatar(): void {
  ownerAvatar = readCachedOwnerAvatar();
  renderShell();
  void fetch('/api/owner-profile')
    .then(r => (r.ok ? r.json() : null))
    .then(body => {
      if (!body?.ok || !body.avatarUrl) return;
      ownerAvatar = { avatarUrl: String(body.avatarUrl), name: body.name ? String(body.name) : undefined };
      try { window.localStorage.setItem(OWNER_AVATAR_KEY, JSON.stringify({ avatarUrl: body.avatarUrl, name: body.name ?? '' })); } catch { /* ignore */ }
      renderShell();
    })
    .catch(() => { /* read-only/offline: keep gradient mark */ });
}

void (async () => {
  ui.init();
  applyShellLocaleFromHash();
  const host = document.getElementById('app-root');
  if (!host) throw new Error('missing dashboard app root');
  initFloatingScrollbars(host);
  initIconTooltips();
  appRoot = createRoot(host);
  renderShell();

  ui.on(() => {
    renderShell();
    if (routeState.rerenderOnUiChange) void route();
  });
  store.on(() => {
    renderShell();
  });

  await loadAuthState();
  renderShell();
  window.addEventListener(PLUGIN_PINS_CHANGED_EVENT, () => { void loadPinnedPluginNavItems(); });
  void loadPinnedPluginNavItems();
  void checkUpdateBadge();
  window.setInterval(() => {
    if (document.hidden) return;
    void checkUpdateBadge();
  }, 30 * 60_000);
  initOwnerAvatar();
  try {
    await bootstrap();
  } catch (err) {
    console.error('botmux dashboard bootstrap failed', err);
    store.setOnline(false);
  }
  void loadNameMaps().then(renderShell);
  void loadGroupsSnapshot().then(renderShell);
  window.addEventListener('hashchange', () => {
    if (!applyShellLocaleFromHash()) void route();
  });
  void route();
})();
