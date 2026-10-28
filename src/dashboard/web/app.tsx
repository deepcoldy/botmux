// Dashboard SPA entry: React chrome + lazy route host + SSE bootstrap.
import type React from 'react';
import { createPortal } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import {
  updateAndRestartBotmux,
  type BotmuxUpdatePhase,
  type BinaryUpdateStatus,
  type UpdateStatusSnapshot,
  type OtherUpdateState,
  updateActionErrorCode,
  classifyOtherUpdate,
  observedInstallCompleted,
  pollUpdateStatus,
  binaryProgressRingValue,
  binaryProgressText,
} from './update-action.js';
import {
  canonicalDashboardClientShellUrl,
  dashboardClientShellRedirect,
  readDashboardClientShell,
  readDashboardWorkbenchShell,
} from './client-shell.js';
import { dashboardLoginHref } from './auth-login.js';
import { ToastStack } from './toast.js';
import { createHashChangeHandler } from './leave-guard.js';
import { ConfirmModalRoot } from './confirm-modal.js';
import {
  NO_WORKBENCH_CAPABILITIES,
  parseWorkbenchCapabilities,
} from './agent-workbench-capabilities.js';
import { isMacLike, isPaletteHotkey, paletteShortcutLabel } from './command-palette-model.js';
import { NAV_GROUPS, NAV_ITEMS, NAV_SUBPAGES, type NavItem } from './nav-items.js';
import { DECISION_BOARD_CHANGED_EVENT, boardsFromResponse } from './decision-board-model.js';
import type { PalettePageEntry, PaletteShellContext } from './command-palette-sources.js';

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
  latestSource?: 'configured' | 'public' | 'configured-fallback' | null;
  behind: boolean;
  localDevInstall: boolean;
  updateSupported: boolean;
  /** Whether /api/update/rollback can actually drive this install. Absent on
   *  older backends; see the fallback where it is consumed. */
  rollbackSupported?: boolean;
  updateCommand: string | null;
  node: { version: string; required: number; ok: boolean };
  installs: { entries: Array<{ binPath: string }>; multiple: boolean };
  runningDaemons?: Array<{ larkAppId: string; version?: string }>;
  runningDaemonRestartHint?: string;
  // Present on backends that report live binary-download progress.
  updateInFlight?: boolean;
  binaryUpdate?: BinaryUpdateStatus | null;
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
  'agents',
  'skills',
  'customization',
  'doc-watches',
  'message-listeners',
  'plugins',
  'team',
  'connectors',
  'insights',
  'feedback',
  'whiteboards',
  'terminal',
];


let pinnedPluginNavItems: NavItem[] = [];
/** 至少有一个 Bot 设为管家时，侧边栏才显示「决策看板」（见 loadDecisionBoardNav）。 */
let decisionBoardNavVisible = false;
/** 全部插件 Dashboard 页面（含没置顶的）；⌘K 收录全部，侧边栏只放置顶的。 */
let pluginPageNavItems: NavItem[] = [];

let isAuthed = true;
/**
 * `/api/settings` 明确回答了登录态（200 或带身份语义的 401）才置位。请求失败（网络错误 /
 * 5xx）时 isAuthed 只是默认的 true，不能据此去拉管理数据——公开只读访客会吃到 401 弹登录浮层。
 */
let authStateKnown = false;
/** 上一次探 /api/settings 的时间；登录态未知时唤起面板会再探，但至少间隔 AUTH_REPROBE_MS。 */
let lastAuthProbeAt = 0;
const AUTH_REPROBE_MS = 10_000;
let publicReadOnly = false;
let activeHash = location.hash || '#/';
let ownerAvatar: OwnerAvatar | null = null;
let updateBehind = false;
let latestVersion: string | null = null;
let updateBadgeKind: 'botmux' | 'runtime' | null = null;
let botmuxUpdateStatus: BotmuxUpdateStatus | null = null;
let routeRoot: HTMLElement | null = null;
let appRoot: ReturnType<typeof createRoot> | null = null;

const routeState = createDashboardRouteState();
const OWNER_AVATAR_KEY = 'botmux.ownerAvatar.v1';
const BUSY_STATUSES = new Set(['working', 'analyzing', 'active', 'starting']);
const AUTH_EXPIRED_EVENT = 'botmux:auth-expired';
let authLoginBaseUrl: string | undefined;

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
  const clientShell = readDashboardClientShell();
  const builtInItems = NAV_ITEMS.filter(item => {
    if (clientShell && item.id === 'workflows') return false;
    // 网页终端在 Desktop/Mobile 客户端壳里归原生会话面管（见 dashboardShellAllowsWebTerminal）。
    if (item.id === 'terminal') return !clientShell && ui.hostTerminal;
    if (item.id === 'decision-board') return decisionBoardNavVisible;
    return true;
  });
  if (pinnedPluginNavItems.length === 0) return builtInItems;
  const pluginIndex = builtInItems.findIndex(item => item.id === 'plugins');
  if (pluginIndex < 0) return [...builtInItems, ...pinnedPluginNavItems];
  return [
    ...builtInItems.slice(0, pluginIndex + 1),
    ...pinnedPluginNavItems,
    ...builtInItems.slice(pluginIndex + 1),
  ];
}

/** ⌘K 面板的「页面」条目：与侧边栏同一份可见性（权限 / 客户端壳 / pinned 插件）。 */
function paletteNavPages(): PalettePageEntry[] {
  const groupOf = new Map<string, string>();
  for (const group of NAV_GROUPS) for (const id of group.items) groupOf.set(id, group.labelKey);
  const visible = sidebarNavItems().filter(item => isAuthed || !item.manage);
  const byId = new Map(visible.map(item => [item.id, item]));
  const pages: PalettePageEntry[] = visible.map(item => {
    const groupKey = groupOf.get(item.plugin ? 'plugins' : item.id);
    return {
      id: item.id,
      href: item.href,
      label: labelOf(item),
      labelKey: item.labelKey,
      aliases: item.aliases,
      groupLabel: groupKey ? t(groupKey) : undefined,
      icon: item.icon,
    };
  });
  // 不在侧边栏的子页面 / 页内 tab：父项可见才收录，客户端壳会重定向走的地址跳过。
  for (const sub of NAV_SUBPAGES) {
    const parent = byId.get(sub.parentId);
    if (!parent || dashboardClientShellRedirect(sub.href)) continue;
    const groupKey = groupOf.get(parent.id);
    pages.push({
      id: sub.id,
      href: sub.href,
      label: t(sub.labelKey),
      labelKey: sub.labelKey,
      aliases: sub.aliases,
      parent: { label: labelOf(parent), labelKey: parent.labelKey },
      groupLabel: groupKey ? t(groupKey) : undefined,
      icon: parent.icon,
    });
  }
  // 没置顶的插件页面（置顶的已作为侧边栏条目收录）。
  const pluginsEntry = byId.get('plugins');
  if (pluginsEntry) {
    for (const plugin of pluginPageNavItems) {
      if (byId.has(plugin.id)) continue;
      pages.push({ id: plugin.id, href: plugin.href, label: labelOf(plugin), groupLabel: labelOf(pluginsEntry), icon: plugin.icon });
    }
  }
  return pages;
}

function navClassName(item: NavItem): string | undefined {
  const classes = [];
  if (isActiveNav(item, activeHash)) classes.push('active');
  if (item.id === 'settings' && updateBehind) classes.push('nav-has-update');
  return classes.length ? classes.join(' ') : undefined;
}

/** 侧边栏导航锚点：桌面分组导航与移动端横向 rail 共用同一份渲染。 */
function renderNavAnchor(item: NavItem): React.JSX.Element {
  return (
    <a
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
  );
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
  return updateBadgeKind === 'runtime'
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

function ThemeMenuSlot(): React.JSX.Element {
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

function TopbarStatusRow(props: { label: string; value: number; hot?: boolean }): React.JSX.Element {
  return (
    <div className={`topbar-status-row${props.hot ? ' topbar-status-row-hot' : ''}`}>
      <span>{props.label}</span>
      <b className={props.value > 0 ? 'status-count-on' : undefined}>{props.value}</b>
    </div>
  );
}

function TopbarStatusDonut(props: { summary: TopbarStatusSummary }): React.JSX.Element {
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

// ── ⌘K 全局搜索 ─────────────────────────────────────────────────────────────
// 壳层只负责唤起（快捷键 + 顶栏入口）；面板本体是独立 chunk，首次唤起或空闲时预取。
const PALETTE_MAC = typeof navigator !== 'undefined' && isMacLike(
  (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform || navigator.platform || '',
);
type CommandPaletteModule = typeof import('./command-palette.js');
let commandPaletteModule: Promise<CommandPaletteModule> | null = null;

function loadCommandPalette(): Promise<CommandPaletteModule> {
  commandPaletteModule ??= import('./command-palette.js').catch(error => {
    commandPaletteModule = null;
    throw error;
  });
  return commandPaletteModule;
}

/** 当前 hash 是否落在无边框工作台壳上（没有顶栏 / 侧栏，也不挂 ⌘K 面板）；见 DashboardShell 里的说明。 */
function framelessWorkbenchSurface(hash: string): 'dock' | 'appCenter' | 'board' | null {
  if (!readDashboardClientShell() && !readDashboardWorkbenchShell()) return null;
  if (hash.startsWith('#/agent-workbench-dock')) return 'dock';
  if (hash.startsWith('#/agent-workbench')) return 'appCenter';
  // 决策看板的直达入口（飞书侧栏 AppLink → /board/<app>/<seq>）带沉浸式标记：侧栏只有
  // 350–800px，不放 Dashboard 的顶栏和侧栏；从 Dashboard 侧边栏点进来仍是正常壳。
  if (readDashboardWorkbenchShell() && hash.startsWith('#/board')) return 'board';
  return null;
}

function preloadCommandPalette(): void {
  void loadCommandPalette().catch(() => { /* 真正唤起时再报错 */ });
}

function openCreateBotFromPalette(): void {
  void openBotOnboarding();
}

function CommandPaletteTrigger(props: { onOpen(): void }): React.JSX.Element {
  const shortcut = paletteShortcutLabel(PALETTE_MAC);
  return (
    <button
      type="button"
      className="topbar-search-trigger"
      aria-haspopup="dialog"
      aria-keyshortcuts={PALETTE_MAC ? 'Meta+K' : 'Control+K'}
      aria-label={`${t('palette.dialogLabel')} (${shortcut})`}
      title={`${t('palette.dialogLabel')} (${shortcut})`}
      onPointerEnter={preloadCommandPalette}
      onFocus={preloadCommandPalette}
      onClick={props.onOpen}
    >
      {icon(<><circle cx="7" cy="7" r="4.6" /><path d="m10.4 10.4 3.6 3.6" /></>)}
      <span className="topbar-search-text">{t('palette.triggerPlaceholder')}</span>
      <kbd className="topbar-search-kbd" aria-hidden="true">{shortcut}</kbd>
    </button>
  );
}

function closeThemeMenuFromStatus(): void {
  window.dispatchEvent(new Event(CLOSE_THEME_MENU_EVENT));
}

function TopbarStatusMenu(props: { summary: TopbarStatusSummary; autoOpen?: boolean }): React.JSX.Element {
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

function AuthExpiredOverlay(props: {
  open: boolean;
  loginUrl?: string;
  onClose(): void;
}): React.JSX.Element | null {
  if (!props.open) return null;
  const canLogin = !!props.loginUrl;
  return (
    <div
      id="auth-expired-overlay"
      className="auth-expired-overlay"
      role="presentation"
      onClick={event => { if (event.target === event.currentTarget) props.onClose(); }}
    >
      <div className="auth-expired-dialog" role="dialog" aria-modal="true" aria-labelledby="auth-expired-title">
        <h2 id="auth-expired-title">{canLogin ? '登录 Dashboard' : '访问链接已失效'}</h2>
        <p>{canLogin
          ? '当前浏览器尚未登录。点击后将通过 Botmux 平台校验机器 owner 权限，并返回当前页面；无权限账号仍会被拒绝。'
          : '当前链接/访问已失效，请使用最新授权链接重新进入（运行 botmux dashboard 获取）。'}</p>
        <div className="auth-expired-actions">
          {props.loginUrl ? (
            <a
              id="dashboard-one-click-login"
              className="auth-login-link primary"
              href={props.loginUrl}
              target="_top"
              rel="noopener"
            >
              一键登录
            </a>
          ) : null}
          <button
            id="auth-expired-dismiss"
            type="button"
            className={canLogin ? 'secondary' : 'primary'}
            onClick={props.onClose}
          >
            {canLogin ? '暂不登录' : '知道了'}
          </button>
        </div>
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
}): React.JSX.Element | null {
  const { status } = props;
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<TopbarUpdatePhase>('idle');
  const [progress, setProgress] = useState(0);
  const [binaryStatus, setBinaryStatus] = useState<BinaryUpdateStatus | null>(null);
  const [observeKind, setObserveKind] = useState<OtherUpdateState | null>(null);
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
  const progressTimerRef = useRef<number | null>(null);
  const stopPollingRef = useRef<(() => void) | null>(null);
  // After a 409 update_in_flight we attach to the update that blocked us, which
  // may run in another tab (flag visible) or in the CLI/maintenance process
  // (flag invisible — install completion is detected from version state, and
  // the actual reload only after the dashboard instance changes).
  const observingRef = useRef(false);
  const observeRollbackRef = useRef(false);
  const observeStartVersionRef = useRef('');
  const observeInstanceRef = useRef('');
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLElement>(null);
  const [popoverPosition, setPopoverPosition] = useState<{ top: number; left: number } | null>(null);

  const clearReconnectTimer = () => {
    if (reconnectTimerRef.current === null) return;
    window.clearTimeout(reconnectTimerRef.current);
    reconnectTimerRef.current = null;
  };

  const clearProgressTimer = () => {
    if (progressTimerRef.current === null) return;
    window.clearInterval(progressTimerRef.current);
    progressTimerRef.current = null;
  };

  useEffect(() => {
    actionInFlightRef.current = false;
    observingRef.current = false;
    stopPollingRef.current?.();
    stopPollingRef.current = null;
    setPhase('idle');
    setProgress(0);
    setBinaryStatus(null);
    setObserveKind(null);
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

  // Faux progress bar. npm install gives no reliable percentage, so we creep a
  // deliberately-capped bar per phase: install climbs toward 50% (the real
  // install ends there), restart+reconnect climbs toward ~95%; the actual
  // reconnect reload finishes the job, so we never fake a 100%. A live binary
  // download replaces the creep with its measured byte progress. Reset to 0 on
  // idle/error clears it.
  useEffect(() => {
    clearProgressTimer();
    if (phase === 'idle' || phase === 'error') {
      setProgress(0);
      return;
    }
    if (phase === 'updating' && binaryStatus) {
      const ring = binaryProgressRingValue(binaryStatus);
      if (ring !== null) setProgress(ring);
      return;
    }
    const cap = phase === 'updating' ? 50 : 95;
    if (phase === 'restarting') setProgress(value => Math.max(value, 50));
    progressTimerRef.current = window.setInterval(() => {
      setProgress(value => (value >= cap ? cap : value + Math.max(0.5, (cap - value) * 0.08)));
    }, 400);
    return () => clearProgressTimer();
  }, [phase, binaryStatus]);

  useEffect(() => {
    if (status) setRefreshFailed(status.versionLookupOk === false);
  }, [status]);

  useEffect(() => {
    if (!open) setRollbackOpen(false);
  }, [open]);

  // A portaled dialog is no longer the next DOM sibling of the trigger. Move
  // focus into it once after mounting so keyboard users do not skip the whole
  // dialog when pressing Tab. Do not depend on the actual coordinates: scroll
  // updates must never steal focus from a user interacting with the popover.
  useEffect(() => {
    if (!open || !popoverPosition) return;
    const frame = window.requestAnimationFrame(() => {
      const firstFocusable = popoverRef.current?.querySelector<HTMLElement>(
        'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      firstFocusable?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open, popoverPosition !== null]);

  useEffect(() => {
    if (!open) {
      setPopoverPosition(null);
      return;
    }

    const updatePopoverPosition = () => {
      const trigger = triggerRef.current;
      if (!trigger) return;
      const rect = trigger.getBoundingClientRect();
      const maxWidth = Math.min(340, Math.max(0, window.innerWidth - 32));
      const left = Math.max(16, Math.min(rect.left, window.innerWidth - maxWidth - 16));
      setPopoverPosition({ top: rect.bottom + 8, left });
    };

    updatePopoverPosition();
    window.addEventListener('resize', updatePopoverPosition);
    // The trigger can move when any ancestor scrolls, not just the window.
    document.addEventListener('scroll', updatePopoverPosition, true);
    return () => {
      window.removeEventListener('resize', updatePopoverPosition);
      document.removeEventListener('scroll', updatePopoverPosition, true);
    };
  }, [open]);

  useEffect(() => () => { clearReconnectTimer(); clearProgressTimer(); stopPollingRef.current?.(); }, []);

  useEffect(() => {
    if (!open) return;
    const closeOnPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (rootRef.current?.contains(target) || popoverRef.current?.contains(target)) return;
      setOpen(false);
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
  const mirrorFallback = status.latestSource === 'configured-fallback';
  const automatic = behind && status.updateSupported && !status.localDevInstall && status.node.ok;
  // Older backends omit rollbackSupported; retain their update capability fallback.
  const rollbackSupported = (status.rollbackSupported ?? status.updateSupported)
    && !status.localDevInstall && status.node.ok;
  const busy = phase === 'updating' || phase === 'restarting';
  // Progress-ring geometry. R=20 → circumference C; the arc fills clockwise
  // from 12 o'clock for `progress`%.
  const RING_R = 20;
  const RING_C = 2 * Math.PI * RING_R;
  const ringDashoffset = RING_C * (1 - Math.max(2, Math.round(progress)) / 100);
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

  // Called by the status poller both while OUR OWN POST is in flight (live byte
  // progress) and after a 409, while observing an update running elsewhere.
  const handleStatusSnapshot = (snapshot: UpdateStatusSnapshot): void => {
    if (!observingRef.current) {
      setBinaryStatus(snapshot.binaryUpdate ?? null);
      return;
    }
    // A cross-process updater never flips this dashboard's in-memory flag, so
    // install completion comes from version state: rollback moves current, an
    // update makes `behind` false. But "installed on disk" is NOT "running":
    // the winner may still be sitting on a restart confirmation (Settings) or
    // be a CLI update that never restarts. So we only switch to the restart
    // phase here and let the /__selfcheck instance watcher decide about the
    // reload — never reload on version state alone.
    if (observedInstallCompleted(snapshot, observeStartVersionRef.current, observeRollbackRef.current)) {
      observingRef.current = false;
      stopPollingRef.current?.();
      stopPollingRef.current = null;
      setBinaryStatus(null);
      setObserveKind(null);
      setPhase('restarting');
      pollReconnect(observeInstanceRef.current);
      return;
    }
    const kind = classifyOtherUpdate(snapshot);
    setObserveKind(kind);
    setBinaryStatus(kind === 'progress' ? snapshot.binaryUpdate ?? null : null);
  };

  // Progress-only polling while our own POST is in flight (no timeout: the
  // POST settling ends it).
  const startStatusPolling = (): (() => void) =>
    pollUpdateStatus(fetch, handleStatusSnapshot, 1000);

  // Polling after a 409: bounded by an independent timer so persistent 503s /
  // dead network / a hung request still reach a terminal state.
  const startObservePolling = (): (() => void) =>
    pollUpdateStatus(fetch, handleStatusSnapshot, 1000, 10 * 60_000, () => {
      observingRef.current = false;
      actionInFlightRef.current = false;
      setBinaryStatus(null);
      setObserveKind(null);
      setPhase('error');
      setErrorDetail(t('update.inProgressSlow'));
    });

  // Our POST lost to an update running in another tab/process: stay in the
  // updating UI and track that update instead of reporting a failure.
  const beginObserve = (isRollback: boolean, instance: string): void => {
    observingRef.current = true;
    observeRollbackRef.current = isRollback;
    observeStartVersionRef.current = status?.current ?? '';
    observeInstanceRef.current = instance;
    setBinaryStatus(null);
    setObserveKind('busy');
    setPhase('updating');
    setErrorDetail('');
    stopPollingRef.current?.();
    stopPollingRef.current = startObservePolling();
  };

  const stopStatusPolling = (): void => {
    stopPollingRef.current?.();
    stopPollingRef.current = null;
    setBinaryStatus(null);
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
    observingRef.current = false;
    setActiveRollback(null);
    setRefreshFailed(false);
    setErrorDetail('');
    setBinaryStatus(null);
    setObserveKind(null);
    stopPollingRef.current?.();
    stopPollingRef.current = startStatusPolling();
    let previousInstance: string;
    try {
      previousInstance = await dashboardInstance();
    } catch (error) {
      stopStatusPolling();
      actionInFlightRef.current = false;
      setPhase('error');
      setErrorDetail(error instanceof Error ? error.message : String(error));
      return;
    }
    try {
      const result = await updateAndRestartBotmux(fetch, setPhase);
      stopStatusPolling();
      if (!result.changed && !result.restarted && !result.restartError) {
        // The server skipped an implicit update. Refresh the stale badge and
        // return to idle instead of reporting a failed restart or reconnecting.
        actionInFlightRef.current = false;
        setPhase('idle');
        setProgress(0);
        setBinaryStatus(null);
        setRefreshFailed(!await props.onRefresh());
        return;
      }
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
      if (updateActionErrorCode(error) === 'update_in_flight') {
        beginObserve(false, previousInstance);
        return; // the status poller keeps tracking the winner
      }
      stopStatusPolling();
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
    observingRef.current = false;
    setActiveRollback(selectedRollback);
    setRefreshFailed(false);
    setErrorDetail('');
    setBinaryStatus(null);
    setObserveKind(null);
    stopPollingRef.current?.();
    stopPollingRef.current = startStatusPolling();
    let previousInstance: string;
    try {
      previousInstance = await dashboardInstance();
    } catch (error) {
      stopStatusPolling();
      actionInFlightRef.current = false;
      setPhase('error');
      setErrorDetail(error instanceof Error ? error.message : String(error));
      return;
    }
    try {
      await updateAndRestartBotmux(fetch, setPhase, selectedRollback);
      stopStatusPolling();
      pollReconnect(previousInstance);
    } catch (error) {
      if (updateActionErrorCode(error) === 'update_in_flight') {
        beginObserve(true, previousInstance);
        return;
      }
      stopStatusPolling();
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
    ? binaryStatus
      ? binaryProgressText(binaryStatus, t)
      : observeKind === 'busy'
        ? t('update.inProgressBusy')
        : observeKind === 'waiting'
          ? t('update.inProgressExternal')
          : activeRollback
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
            ? mirrorFallback
              ? t('update.mirrorVersionUpgradePrompt', { version: latestVersion })
              : t('update.versionUpgradePrompt', { version: latestVersion })
            : unavailableReason
          : status.latest
            ? mirrorFallback
              ? t('update.mirrorUpToDate')
              : t('update.upToDate')
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
        <span
          className={`dashboard-version-state ${versionSignal.className}`}
          aria-hidden="true"
        >{versionSignal.symbol}</span>
      </button>
      {open && popoverPosition && typeof document !== 'undefined' ? createPortal((
        <section
          ref={popoverRef}
          className="dashboard-version-popover"
          role="dialog"
          aria-modal="false"
          aria-labelledby="dashboard-version-title"
          style={{ top: popoverPosition.top, left: popoverPosition.left }}
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
              {busy ? (
                <span
                  className="dashboard-version-ring"
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(progress)}
                  aria-label={message}
                >
                  <svg viewBox="0 0 44 44" width="44" height="44" aria-hidden="true">
                    <defs>
                      <linearGradient id="dvr-grad" x1="0%" y1="100%" x2="100%" y2="0%">
                        <stop offset="0%" stopColor="var(--brand-accent-cyan)" />
                        <stop offset="55%" stopColor="var(--accent)" />
                        <stop offset="100%" stopColor="var(--brand-accent-pink)" />
                      </linearGradient>
                    </defs>
                    <circle className="dvr-track" cx="22" cy="22" r="20" />
                    <circle
                      className="dvr-arc"
                      cx="22" cy="22" r="20"
                      style={{ strokeDasharray: RING_C, strokeDashoffset: ringDashoffset }}
                    />
                  </svg>
                  <span className="dvr-pct">{Math.round(progress)}%</span>
                </span>
              ) : (
                <span className={versionSignal.className} aria-hidden="true">{versionSignal.symbol}</span>
              )}
            </div>
            <p
              className={`dashboard-version-message${phase === 'error' || refreshFailed ? ' is-error' : ''}`}
              role={phase === 'error' || refreshFailed ? 'alert' : 'status'}
              aria-live="polite"
            >{message}</p>
            {status.runningDaemonRestartHint ? (
              <p className="dashboard-version-message" role="status">{status.runningDaemonRestartHint}</p>
            ) : null}
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
                {action}
              </button>
            </footer>
          ) : null}
        </section>
      ), document.body) : null}
    </div>
  );
}

function DashboardShell(): React.JSX.Element {
  const statusSummary = dashboardStatusSummary();
  const [botOnboardingOpen, setBotOnboardingOpen] = useState(false);
  const [authExpiredOpen, setAuthExpiredOpen] = useState(false);
  const [statusAutoOpen, setStatusAutoOpen] = useState(false);
  const previousAttentionRef = useRef(statusSummary.attention);
  const statusAutoOpenTimerRef = useRef<number | null>(null);
  // 每次唤起 seq+1 作为面板的 key：重新挂载 = 查询 / 分类 / 选中项从零开始。
  const [palette, setPalette] = useState<{ open: boolean; seq: number }>({ open: false, seq: 0 });
  const [PaletteView, setPaletteView] = useState<CommandPaletteModule['CommandPalette'] | null>(null);
  const paletteOpenRef = useRef(false);
  const paletteEnabledRef = useRef(true);
  paletteOpenRef.current = palette.open;

  const closePalette = useCallback(() => setPalette(prev => (prev.open ? { ...prev, open: false } : prev)), []);
  // 允许叠在会话详情抽屉等原生模态框之上：面板 showModal 后是 top layer 最上层，
  // Esc 只关它自己；选中跳转会换 hash 重挂载页面，底下的抽屉随之卸掉。
  const openPalette = useCallback(() => {
    // 首屏 /api/settings 失败（网络错误 / 5xx）时登录态未知，面板不拉 Skill / Agent；唤起时再探
    // （限频：服务端持续出错时反复开关面板不该线性放大请求）。
    if (!authStateKnown && Date.now() - lastAuthProbeAt >= AUTH_REPROBE_MS) void loadAuthState().then(renderShell);
    void loadCommandPalette()
      .then(mod => {
        setPaletteView(() => mod.CommandPalette);
        setPalette(prev => (prev.open ? prev : { open: true, seq: prev.seq + 1 }));
      })
      .catch(error => {
        if (maybeReloadBrowserForStaleRouteChunk(error, {
          href: window.location.href,
          hash: location.hash || '#/',
          getSessionStorage: () => window.sessionStorage,
          reload: () => window.location.reload(),
        })) return;
        console.error('botmux command palette failed to load', error);
      });
  }, []);

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
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || !isPaletteHotkey(event, PALETTE_MAC)) return;
      if (!paletteEnabledRef.current) return;
      // 宿主终端（xterm）里 Ctrl+K 是 readline 删到行尾，xterm 自己处理后会拦下；这里再兜一层。
      if (event.target instanceof Element && event.target.closest('.xterm')) return;
      event.preventDefault();
      if (paletteOpenRef.current) closePalette();
      else openPalette();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [closePalette, openPalette]);
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
  // 工作台默认是无边框壳（没有 topbar / 侧栏），但无边框只留给两类入口：桌面 / 移动
  // 客户端（botmuxClientShell），以及带沉浸式标记的直达入口（botmuxWorkbenchShell，
  // `/workbench`、短票兑换、卡片按钮与 CLI 打印的链接都 302 到这种 hash，见
  // core/workbench-shell.ts）。从侧边栏等网页入口点进 #/agent-workbench 时必须保持
  // 正常壳，否则导航一去不回。两种标记都可能挂在 search 或 hash（为过登录重定向把
  // 标记放在 hash 里，启动时再提升进 search），reader 两种都认。
  const workbenchSurface = framelessWorkbenchSurface(activeHash);
  // 无边框工作台壳没有顶栏，也不挂面板。
  paletteEnabledRef.current = !workbenchSurface;
  // 壳层随每条 SSE 重渲染；context 换新对象会让面板重建全部条目并重跑整次搜索。
  // 只有页面清单可能变化时才换：开关面板、切语言、登录态、置顶插件、宿主终端权限。
  const paletteContext = useMemo<PaletteShellContext>(() => ({
    pages: palette.open ? paletteNavPages() : [],
    manageDataReady: authStateKnown && isAuthed,
    setLocale,
    openCreateSession: requestOpenCreateSession,
    openCreateBot: openCreateBotFromPalette,
  }), [palette.open, ui.locale, isAuthed, authStateKnown, pinnedPluginNavItems, pluginPageNavItems, ui.hostTerminal, decisionBoardNavVisible]);
  if (workbenchSurface) {
    return (
      <>
        <div className="workbench-route-host" data-workbench-surface={workbenchSurface}>
          <main id="root" ref={setRouteRoot} />
        </div>
        {/* 工作台是无边框壳（没有 topbar / 侧栏），登录态失效时这个浮层是它唯一
            的自救出口——漏传 loginUrl 会让浮层退化成「访问链接已失效 / 知道了」
            的死胡同，一键登录压根不渲染。与下面普通壳的传参保持一致。 */}
        <AuthExpiredOverlay
          open={authExpiredOpen}
          loginUrl={dashboardLoginHref(authLoginBaseUrl, location.hash)}
          onClose={closeAuthExpired}
        />
        {/* 全局反馈系统：toast() / confirm() 的挂载点（fixed 定位，与树位置无关）。
            workbench 无边框壳也需要挂载，否则将来 workbench 内调用 confirm() 会永久挂起。 */}
        <ToastStack />
        <ConfirmModalRoot />
      </>
    );
  }
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
          <div className="topbar-center">
            <CommandPaletteTrigger onOpen={openPalette} />
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
                href="https://deepcoldy.github.io/botmux/"
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
              {(() => {
                const visible = sidebarNavItems().filter(item => isAuthed || !item.manage);
                const byId = new Map(visible.map(item => [item.id, item]));
                // pinned plugin 项没有自己的组，跟在「管理」组的「插件」之后。
                const pinnedPlugins = visible.filter(item => item.plugin);
                return NAV_GROUPS.map(group => {
                  const items = group.items.flatMap(id => {
                    const item = byId.get(id);
                    if (!item) return [];
                    return item.id === 'plugins' ? [item, ...pinnedPlugins] : [item];
                  });
                  if (items.length === 0) return null;
                  return (
                    <div className="nav-group" key={group.id}>
                      <div className="nav-group-title">{t(group.labelKey)}</div>
                      {items.map(renderNavAnchor)}
                    </div>
                  );
                });
              })()}
            </nav>
          </aside>
          <div className="workspace">
            <dialog id="create-session-modal" className="create-session-modal" />
            <BotOnboardingDialog open={botOnboardingOpen} onClose={() => setBotOnboardingOpen(false)} />
            <main id="root" ref={setRouteRoot} />
          </div>
        </div>
      </div>
      <AuthExpiredOverlay
        open={authExpiredOpen}
        loginUrl={dashboardLoginHref(authLoginBaseUrl, location.hash)}
        onClose={closeAuthExpired}
      />
      {PaletteView ? (
        <PaletteView
          key={palette.seq}
          open={palette.open}
          onClose={closePalette}
          mac={PALETTE_MAC}
          context={paletteContext}
        />
      ) : null}
      {/* 全局反馈系统：toast() / confirm() 的挂载点（fixed 定位，与树位置无关） */}
      <ToastStack />
      <ConfirmModalRoot />
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
export function showAuthExpiredOverlay(loginUrl?: string): void {
  const hasLoginUrl = !!dashboardLoginHref(loginUrl, location.hash);
  const loginUrlChanged = hasLoginUrl && authLoginBaseUrl !== loginUrl;
  if (hasLoginUrl) authLoginBaseUrl = loginUrl;
  if (expiredShown && loginUrlChanged) renderShell();
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
    // Management reads are intentionally outside an H5/platform Workbench
    // identity's capability map. The server marks that expected narrow denial;
    // an unmarked 401 still means the identity expired and opens the login UI.
    if (res.headers.get('x-botmux-auth-scope') === 'workbench') return res;
    const loginUrl = res.headers.get('x-botmux-login-url') ?? undefined;
    const method = (args[1]?.method ?? 'GET').toUpperCase();
    const isRead = method === 'GET' || method === 'HEAD';
    if (loginUrl || (isRead && !publicReadOnly)) showAuthExpiredOverlay(loginUrl);
    else showReadOnlyToast();
  }
  return res;
};

/**
 * P1-4：拉取服务端投影的最小操作能力集。走 origFetch 绕过全局 401 包装——匿名
 * （含 publicReadOnly 访客）在这里 401 是预期的能力探测结果，不是登录过期事件。
 * 任何失败（401、网络错误、响应不合形）严格回落全 false：操作入口宁可少画，
 * 不给无权身份画出会 401/403 的按钮。
 */
async function loadWorkbenchCapabilities(): Promise<void> {
  try {
    const r = await origFetch('/api/workbench/capabilities', { cache: 'no-store' });
    ui.workbenchCapabilities = r.ok
      ? parseWorkbenchCapabilities(await r.json())
      : NO_WORKBENCH_CAPABILITIES;
  } catch {
    ui.workbenchCapabilities = NO_WORKBENCH_CAPABILITIES;
  }
}

async function loadAuthState(): Promise<void> {
  lastAuthProbeAt = Date.now();
  // 能力探测与 /api/settings 并行：两者互不依赖，也都在首次 route() 之前完成。
  const capabilitiesProbe = loadWorkbenchCapabilities();
  try {
    // Use the unwrapped request: a valid narrow Workbench identity is supposed
    // to get a scoped 401 here, and that is auth-state data rather than an
    // expiry event for the global fetch wrapper.
    const r = await origFetch('/api/settings');
    if (r.ok) {
      const j = await r.json();
      isAuthed = !!j.authed;
      ui.authed = isAuthed;
      ui.workbenchAuthed = isAuthed;
      ui.hostTerminal = isAuthed && j.hostTerminal === true;
      publicReadOnly = !!(j.settings && j.settings.publicReadOnly);
      ui.publicReadOnly = publicReadOnly;
      authStateKnown = true;
      const serverLocale = readShellLocale() ?? normalizeDashboardLocale(j.lang);
      if (serverLocale) ui.setLocale(serverLocale);
    } else if (r.status === 401 && r.headers.get('x-botmux-auth-scope') === 'workbench') {
      // H5/platform identities can use Workbench control leases but must never
      // become Dashboard owners merely because the shell probed /api/settings.
      isAuthed = false;
      ui.authed = false;
      ui.workbenchAuthed = true;
      ui.hostTerminal = false;
      publicReadOnly = false;
      ui.publicReadOnly = false;
      authStateKnown = true;
    } else if (r.status === 401) {
      isAuthed = false;
      ui.authed = false;
      ui.workbenchAuthed = false;
      ui.hostTerminal = false;
      authStateKnown = true;
      const loginUrl = r.headers.get('x-botmux-login-url') ?? undefined;
      showAuthExpiredOverlay(loginUrl);
    }
  } catch { /* keep defaults */ }
  await capabilitiesProbe;
}

async function loadPinnedPluginNavItems(): Promise<void> {
  try {
    const response = await fetch('/api/plugins/dashboard');
    if (!response.ok) return;
    const body = await response.json();
    const entries = (Array.isArray(body?.plugins) ? body.plugins : []) as PluginDashboardNavEntry[];
    const routable = entries.filter(entry => typeof entry.route === 'string');
    const pages: Array<{ pinned: boolean; item: NavItem }> = routable.map(entry => ({
      pinned: entry.pinned === true,
      item: {
        id: `plugin:${entry.pluginId}:${entry.id}`,
        href: entry.route,
        label: entry.displayName || entry.pluginId,
        manage: true,
        plugin: true,
        icon: <><path d="M5.2 2.2h5.6v3.1l1.7 1.7-1.4 1.4-1-1v6.4H5.9V7.4l-1 1L3.5 7l1.7-1.7z" /><path d="M8 13.8v1" /></>,
      },
    }));
    pluginPageNavItems = pages.map(page => page.item);
    pinnedPluginNavItems = pages.filter(page => page.pinned).map(page => page.item);
    renderShell();
  } catch {
    // The core navigation remains usable when plugin metadata is unavailable.
  }
}

/**
 * 侧边栏要不要显示「决策看板」：问一次 /api/decision-board/boards（只列开了管家的 Bot）。
 * 本机管理身份和飞书 H5 免登身份都能读；其它身份（匿名、平台访客）对它是既定的 401，
 * 所以走 origFetch，不让全局 401 包装弹登录浮层。失败一律当作没有看板。
 */
async function loadDecisionBoardNav(): Promise<void> {
  let visible = false;
  if (ui.authed || ui.workbenchAuthed) {
    try {
      const r = await origFetch('/api/decision-board/boards', { cache: 'no-store' });
      visible = r.ok && boardsFromResponse(await r.json().catch(() => null)).length > 0;
    } catch { /* 当作没有看板 */ }
  }
  if (visible === decisionBoardNavVisible) return;
  decisionBoardNavVisible = visible;
  renderShell();
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
      updateBadgeKind = 'runtime';
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

  const clientShellRedirect = dashboardClientShellRedirect(hash);
  if (clientShellRedirect) {
    window.location.replace(clientShellRedirect);
    return;
  }
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
  const canonicalClientShellUrl = canonicalDashboardClientShellUrl(window.location.href);
  if (canonicalClientShellUrl) {
    window.history.replaceState(window.history.state, '', canonicalClientShellUrl);
  }
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
  // Bot 配置里开关管家后会发这个事件，侧边栏随之出现 / 消失。
  window.addEventListener(DECISION_BOARD_CHANGED_EVENT, () => { void loadDecisionBoardNav(); });
  void loadDecisionBoardNav();
  void checkUpdateBadge();
  window.setInterval(() => {
    if (document.hidden) return;
    void checkUpdateBadge();
  }, 30 * 60_000);
  initOwnerAvatar();
  try {
    await bootstrap({
      // P1-14：排程只对「本机管理身份」和「publicReadOnly 匿名访客」开放。
      // Workbench-only 身份（飞书 H5 / 平台 teammate|guest，loadAuthState 里把
      // authed 置 false、workbenchAuthed 置 true）对 /api/schedules 是既定的
      // 401，别发这一跳。注意能力判断只影响「发不发请求」，会话快照的容错不
      // 依赖它对不对。
      canReadSchedules: () => ui.authed || ui.publicReadOnly,
    });
  } catch (err) {
    console.error('botmux dashboard bootstrap failed', err);
    store.setOnline(false);
  }
  void loadNameMaps().then(renderShell);
  void loadGroupsSnapshot().then(renderShell);
  // 空闲时预取 ⌘K 面板 chunk，首次唤起不等网络；无边框工作台壳不挂面板，不白取。
  if (!framelessWorkbenchSurface(location.hash || '#/')) {
    if (typeof window.requestIdleCallback === 'function') window.requestIdleCallback(preloadCommandPalette, { timeout: 5_000 });
    else window.setTimeout(preloadCommandPalette, 3_000);
  }
  // A page with unsaved edits can hold a navigation back (see leave-guard.ts).
  window.addEventListener('hashchange', createHashChangeHandler({
    applyLocale: applyShellLocaleFromHash,
    route: () => { void route(); },
  }));
  void route();
})();
