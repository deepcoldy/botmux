import type { DashboardLocateResult, DesktopRuntimeState, LogTail, LogTarget } from '../shared/types.js';
import {
  currentDashboardUrlFromSrc,
  dashboardRouteFromUrl,
  dashboardRouteMatches,
  normalizeDashboardRoute,
  routeDashboardUrl as buildDashboardUrl,
} from './dashboard-url.js';
import {
  buildRuntimeMeta,
  buildVersionLine,
  emptyDashboardMessage,
  isRuntimeState,
  shouldKeepLoadedDashboardDuringDegradedState,
} from './runtime-state.js';

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  signal?: string | null;
}

interface LoginItemState {
  openAtLogin: boolean;
  legacyAutostart?: boolean;
  legacyPath?: string;
}

type DashboardNavigationEvent = Event & { url?: string };
type DashboardWebviewElement = HTMLElement & {
  insertCSS?: (css: string) => Promise<string> | string;
};
type DesktopLocale = 'zh' | 'en';

interface BotmuxDesktopApi {
  getState: () => Promise<unknown>;
  start: () => Promise<RunResult>;
  stop: () => Promise<RunResult>;
  restart: () => Promise<RunResult>;
  takeover: () => Promise<RunResult>;
  locateDashboard?: () => Promise<DashboardLocateResult>;
  getDashboardUrl: () => Promise<string | null>;
  listLogTargets: () => Promise<LogTarget[]>;
  tailLogs: (targetId: string) => Promise<LogTail>;
  openLogsDir: () => Promise<string>;
  openBotmuxHome: () => Promise<string>;
  getLoginItem: () => Promise<LoginItemState>;
  setLoginItem: (enabled: boolean) => Promise<LoginItemState>;
  onStateChanged: (fn: (state: unknown) => void) => () => void;
}

declare global {
  interface Window {
    botmuxDesktop?: BotmuxDesktopApi;
  }
}

const desktopLocaleStorageKey = 'botmux.dashboard.locale';
const logPollIntervalMs = 1500;
const navPointerDedupMs = 350;
const dashboardLocateRetryMs = 5000;
const desktopShellInjectedCss = `
  .sidebar,
  .topbar {
    display: none !important;
  }

  .app-shell {
    display: block !important;
    grid-template-columns: minmax(0, 1fr) !important;
    min-height: 100vh !important;
  }

  .chrome-body {
    /* Hidden sidebar is removed from auto-placement, but explicit grid tracks remain. */
    grid-template-columns: minmax(0, 1fr) !important;
    gap: 0 !important;
  }

  .workspace {
    grid-column: 1 / -1 !important;
    min-width: 0 !important;
    width: 100% !important;
  }

  .attention-strip {
    margin-top: 0 !important;
  }
`;
const messages: Record<DesktopLocale, Record<string, string>> = {
  zh: {
    'app.subtitle': '飞书 AI CLI 控制台',
    'nav.overview': '总览',
    'nav.sessions': '会话',
    'nav.insights': '洞察',
    'nav.workflows': '工作流',
    'nav.goals': '目标看板',
    'nav.groups': '群组',
    'nav.monitoring': '监控看板',
    'nav.schedules': '定时',
    'nav.whiteboards': '白板',
    'nav.roles': '角色管理',
    'nav.botDefaults': 'Bot 配置',
    'nav.skills': 'Skills',
    'nav.team': '团队',
    'nav.connectors': 'Webhook',
    'nav.office': '办公室',
    'nav.settings': '设置',
    'summary.onlineDaemons': '在线 Daemon',
    'summary.needsAttention': '需要处理',
    'summary.configuredBots': '已配置 Bot',
    'runtime.checking': '正在检查 CLI',
    'runtime.waitingBridge': '等待桌面桥接',
    'runtime.status.not_configured': '需要配置',
    'runtime.status.stopped': '已停止',
    'runtime.status.starting': '启动中',
    'runtime.status.running': '运行中',
    'runtime.status.degraded': '需要处理',
    'runtime.stateUnavailable': '状态不可用',
    'runtime.stateUnavailableDetail': '无法读取 CLI 状态：{error}',
    'runtime.bridgeUnavailable': '桌面桥接不可用',
    'runtime.bridgeUnavailableDetail': '重启 Botmux Desktop 以重新连接 IPC。',
    'runtimeSource.globalCli': '全局 CLI',
    'runtimeSource.none': '未连接 CLI',
    'version.unavailable': '版本信息不可用',
    'empty.notConfigured': '添加机器人后启动 CLI，即可加载控制台。',
    'empty.stopped': '启动 CLI 后加载控制台。',
    'empty.degraded': 'CLI 需要处理后才能加载控制台。',
    'empty.dashboardMissing': '控制台 URL 暂不可用。',
    'empty.stateUnavailable': 'CLI 状态不可用。',
    'empty.bridgeUnavailable': '桌面桥接不可用。',
    'empty.dashboardUnavailable': '控制台不可用：{error}',
    'empty.dashboardLocateFailed': '控制台不可用（{reason}）：{message}',
    'empty.startRuntime': '启动 CLI 后加载控制台。',
    'empty.startFirst': '请先启动 CLI，再打开控制台页面。',
    'runtime.restartMessage': '正在重启 CLI...',
    'action.start': '启动',
    'action.stop': '停止',
    'action.restart': '重启',
    'action.takeover': '连接当前 CLI',
    'action.createSession': '创建会话',
    'action.addBot': '添加机器人',
    'action.docs': '文档',
    'action.logs': '日志',
    'action.openHome': '打开目录',
    'action.copy': '复制',
    'action.openFolder': '打开文件夹',
    'action.close': '关闭',
    'action.requested': '已请求{label}...',
    'action.failed': '{label}失败：{error}',
    'path.home': 'Botmux 目录',
    'path.logs': '日志文件夹',
    'dashboard.openBotOnboarding': '正在打开添加机器人...',
    'dashboard.openCreateSession': '正在打开创建会话...',
    'dashboard.openingPage': '正在打开页面...',
    'dashboard.urlUnavailable': '控制台 URL 暂不可用。',
    'dashboard.openFailed': '打开页面失败：{error}',
    'login.launchAtLogin': '开机启动 App',
    'login.unavailable': '登录项不可用：{error}',
    'login.updateFailed': '登录项更新失败：{error}',
    'logs.title': '日志',
    'logs.initial': '打开日志后开始跟随输出。',
    'logs.noFiles': '暂未找到日志文件。',
    'logs.listFailed': '无法列出日志：{error}',
    'logs.recentPrefix': '[仅显示最近的日志输出]\n\n',
    'logs.empty': '暂无日志输出。',
    'logs.readFailed': '无法读取日志：{error}',
    'logs.copied': '日志已复制到剪贴板。',
    'logs.copyFailed': '复制失败：{error}',
    'path.openFailed': '{label}打开失败：{error}',
    'error.unknown': '未知错误',
  },
  en: {
    'app.subtitle': 'Feishu AI CLI Control',
    'nav.overview': 'Overview',
    'nav.sessions': 'Sessions',
    'nav.insights': 'Insight',
    'nav.workflows': 'Workflows',
    'nav.goals': 'Goals',
    'nav.groups': 'Groups',
    'nav.monitoring': 'Monitoring',
    'nav.schedules': 'Schedules',
    'nav.whiteboards': 'Whiteboards',
    'nav.roles': 'Roles',
    'nav.botDefaults': 'Bot Profiles',
    'nav.skills': 'Skills',
    'nav.team': 'Team',
    'nav.connectors': 'Webhook',
    'nav.office': 'Office',
    'nav.settings': 'Settings',
    'summary.onlineDaemons': 'Online daemons',
    'summary.needsAttention': 'Needs attention',
    'summary.configuredBots': 'Configured bots',
    'runtime.checking': 'Checking CLI',
    'runtime.waitingBridge': 'Waiting for desktop bridge',
    'runtime.status.not_configured': 'Setup needed',
    'runtime.status.stopped': 'Stopped',
    'runtime.status.starting': 'Starting',
    'runtime.status.running': 'Running',
    'runtime.status.degraded': 'Needs attention',
    'runtime.stateUnavailable': 'State unavailable',
    'runtime.stateUnavailableDetail': 'Could not read CLI state: {error}',
    'runtime.bridgeUnavailable': 'Desktop bridge unavailable',
    'runtime.bridgeUnavailableDetail': 'Restart Botmux Desktop to reconnect IPC.',
    'runtimeSource.globalCli': 'Global CLI',
    'runtimeSource.none': 'No CLI connected',
    'version.unavailable': 'Version unavailable',
    'empty.notConfigured': 'Add a bot, then start the CLI to load the dashboard.',
    'empty.stopped': 'Start the CLI to load the dashboard.',
    'empty.degraded': 'CLI needs attention before the dashboard can load.',
    'empty.dashboardMissing': 'Dashboard URL is not available yet.',
    'empty.stateUnavailable': 'CLI state is unavailable.',
    'empty.bridgeUnavailable': 'Desktop bridge is unavailable.',
    'empty.dashboardUnavailable': 'Dashboard unavailable: {error}',
    'empty.dashboardLocateFailed': 'Dashboard unavailable ({reason}): {message}',
    'empty.startRuntime': 'Start the CLI to load the dashboard.',
    'empty.startFirst': 'Start the CLI before opening a dashboard page.',
    'runtime.restartMessage': 'Restarting CLI...',
    'action.start': 'Start',
    'action.stop': 'Stop',
    'action.restart': 'Restart',
    'action.takeover': 'Connect current CLI',
    'action.createSession': 'Create session',
    'action.addBot': 'Add bot',
    'action.docs': 'Docs',
    'action.logs': 'Logs',
    'action.openHome': 'Open folder',
    'action.copy': 'Copy',
    'action.openFolder': 'Open folder',
    'action.close': 'Close',
    'action.requested': '{label} requested...',
    'action.failed': '{label} failed: {error}',
    'path.home': 'Botmux home',
    'path.logs': 'Logs folder',
    'dashboard.openBotOnboarding': 'Opening add bot...',
    'dashboard.openCreateSession': 'Opening create session...',
    'dashboard.openingPage': 'Opening page...',
    'dashboard.urlUnavailable': 'Dashboard URL is not available yet.',
    'dashboard.openFailed': 'Open page failed: {error}',
    'login.launchAtLogin': 'Launch app at login',
    'login.unavailable': 'Login item unavailable: {error}',
    'login.updateFailed': 'Login item update failed: {error}',
    'logs.title': 'Logs',
    'logs.initial': 'Open logs to begin tailing.',
    'logs.noFiles': 'No log files found yet.',
    'logs.listFailed': 'Could not list logs: {error}',
    'logs.recentPrefix': '[Showing the most recent log output]\n\n',
    'logs.empty': 'No log output yet.',
    'logs.readFailed': 'Could not read logs: {error}',
    'logs.copied': 'Logs copied to clipboard.',
    'logs.copyFailed': 'Copy failed: {error}',
    'path.openFailed': '{label} failed: {error}',
    'error.unknown': 'Unknown error',
  },
};

const runtimeDot = byId<HTMLSpanElement>('runtime-dot');
const runtimeStatus = byId<HTMLDivElement>('runtime-status');
const runtimeMeta = byId<HTMLDivElement>('runtime-meta');
const botCount = byId<HTMLElement>('bot-count');
const onlineCount = byId<HTMLElement>('online-count');
const attentionCount = byId<HTMLElement>('attention-count');
const startBtn = byId<HTMLButtonElement>('start-btn');
const stopBtn = byId<HTMLButtonElement>('stop-btn');
const restartBtn = byId<HTMLButtonElement>('restart-btn');
const takeoverBtn = byId<HTMLButtonElement>('takeover-btn');
const createSessionBtn = byId<HTMLButtonElement>('create-session-btn');
const addBotBtn = byId<HTMLButtonElement>('add-bot-btn');
const logsBtn = byId<HTMLButtonElement>('logs-btn');
const homeBtn = byId<HTMLButtonElement>('home-btn');
const loginToggle = byId<HTMLInputElement>('login-toggle');
const versionLine = byId<HTMLDivElement>('version-line');
const dashboardFrame = byId<DashboardWebviewElement>('dashboard-frame');
const emptyDashboard = byId<HTMLDivElement>('empty-dashboard');
const logsDrawer = byId<HTMLElement>('logs-drawer');
const logTarget = byId<HTMLSelectElement>('log-target');
const copyLogsBtn = byId<HTMLButtonElement>('copy-logs');
const openLogsBtn = byId<HTMLButtonElement>('open-logs');
const closeLogsBtn = byId<HTMLButtonElement>('close-logs');
const logOutput = byId<HTMLPreElement>('log-output');
const dashboardNavLinks = Array.from(document.querySelectorAll<HTMLAnchorElement>('[data-dashboard-route]'));
const localeButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-locale]'));

let currentLocale: DesktopLocale = readStoredLocale();
let lastState: DesktopRuntimeState | null = null;
let runtimeNotice: string | null = null;
let actionPending = false;
// Sequence async dashboard loads so slower state polls cannot overwrite newer UI.
let dashboardLoadToken = 0;
// Only dashboard-clearing actions should cancel Add Bot navigation in flight.
let dashboardGeneration = 0;
let dashboardRoute: string | null = null;
let dashboardLocateRetryTimer: number | null = null;
let desktopShellCssInjectedUrl: string | null = null;
let logTimer: number | null = null;
let logPollInFlight = false;
// Each drawer open gets a token; stale log promises must not write after close.
let logsOpenToken = 0;
let lastPointerNavigation: { route: string; time: number } | null = null;

class DashboardLocateError extends Error {}

wireControls();
paintChrome();
paintDashboardNav('#/');
void initialize();

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing renderer element: ${id}`);
  }
  return element as T;
}

function getApi(): BotmuxDesktopApi | null {
  return window.botmuxDesktop ?? null;
}

function readStoredLocale(): DesktopLocale {
  const stored = window.localStorage.getItem(desktopLocaleStorageKey);
  if (stored === 'zh' || stored === 'en') return stored;
  const languages = navigator.languages?.length ? navigator.languages : [navigator.language].filter(Boolean);
  return languages.some(language => language.toLowerCase().startsWith('en')) ? 'en' : 'zh';
}

function t(key: string, params?: Record<string, string | number>): string {
  const template = messages[currentLocale][key] ?? messages.zh[key] ?? key;
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (_, name) => {
    const value = params[name];
    return value === undefined || value === null ? `{${name}}` : String(value);
  });
}

function paintChrome(): void {
  document.documentElement.lang = currentLocale === 'zh' ? 'zh-CN' : 'en';
  for (const element of document.querySelectorAll<HTMLElement>('[data-i18n]')) {
    if (element === logOutput) continue;
    element.textContent = t(element.dataset.i18n ?? '');
  }
  if (
    logOutput.textContent === messages.zh['logs.initial'] ||
    logOutput.textContent === messages.en['logs.initial']
  ) {
    logOutput.textContent = t('logs.initial');
  }
  for (const button of localeButtons) {
    button.classList.toggle('active', button.dataset.locale === currentLocale);
    button.setAttribute('aria-pressed', String(button.dataset.locale === currentLocale));
  }
}

async function initialize(): Promise<void> {
  const api = getApi();
  if (!api) {
    paintBridgeUnavailable();
    return;
  }

  await initializeLoginToggle(api);
  await refreshState();
  api.onStateChanged(state => {
    // Treat push events as untrusted IPC data and fall back to polling if the
    // payload is not a complete runtime state.
    if (isRuntimeState(state)) {
      lastState = state;
      paintState(state);
      void syncDashboardForState(state);
      return;
    }
    void refreshState();
  });
}

function wireControls(): void {
  for (const button of localeButtons) {
    button.addEventListener('click', () => {
      setLocale(button.dataset.locale);
    });
  }
  for (const link of dashboardNavLinks) wireDashboardNavLink(link);
  dashboardFrame.addEventListener('did-navigate-in-page', event => {
    const url = (event as DashboardNavigationEvent).url;
    if (!url) return;
    dashboardRoute = dashboardRouteFromUrl(url);
    paintDashboardNav(dashboardRoute);
  });
  dashboardFrame.addEventListener('dom-ready', () => {
    void injectDesktopShellCss();
  });
  dashboardFrame.addEventListener('did-start-loading', () => {
    desktopShellCssInjectedUrl = null;
  });
  dashboardFrame.addEventListener('did-finish-load', () => {
    void injectDesktopShellCss();
  });
  startBtn.addEventListener('click', () => {
    void runRuntimeAction(t('action.start'), api => api.start());
  });
  stopBtn.addEventListener('click', () => {
    void runRuntimeAction(t('action.stop'), api => api.stop());
  });
  restartBtn.addEventListener('click', () => {
    clearDashboard(t('runtime.restartMessage'));
    void runRuntimeAction(t('action.restart'), api => api.restart());
  });
  takeoverBtn.addEventListener('click', () => {
    clearDashboard(t('runtime.restartMessage'));
    void runRuntimeAction(t('action.takeover'), api => api.takeover());
  });
  createSessionBtn.addEventListener('click', () => {
    void openCreateSession();
  });
  addBotBtn.addEventListener('click', () => {
    void openBotOnboarding();
  });
  logsBtn.addEventListener('click', () => {
    void openLogsDrawer();
  });
  homeBtn.addEventListener('click', () => {
    void openPath(t('path.home'), api => api.openBotmuxHome());
  });
  logTarget.addEventListener('change', () => {
    void tailSelectedLogs();
  });
  copyLogsBtn.addEventListener('click', () => {
    void copyLogs();
  });
  openLogsBtn.addEventListener('click', () => {
    void openPath(t('path.logs'), api => api.openLogsDir());
  });
  closeLogsBtn.addEventListener('click', closeLogsDrawer);
}

function wireDashboardNavLink(link: HTMLAnchorElement): void {
  link.addEventListener('pointerup', event => {
    if (!isPrimaryUnmodifiedPointer(event)) return;
    event.preventDefault();
    const route = link.dataset.dashboardRoute ?? '#/';
    // Electron webview focus can swallow the follow-up click after the sidebar
    // visually receives focus, so pointerup gives native navigation a fallback.
    lastPointerNavigation = { route, time: performance.now() };
    void openDashboardRoute(route);
  });
  link.addEventListener('click', event => {
    event.preventDefault();
    const route = link.dataset.dashboardRoute ?? '#/';
    if (isRecentPointerNavigation(route)) return;
    void openDashboardRoute(route);
  });
}

function isPrimaryUnmodifiedPointer(event: PointerEvent): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

function isRecentPointerNavigation(route: string): boolean {
  if (!lastPointerNavigation || lastPointerNavigation.route !== route) return false;
  return performance.now() - lastPointerNavigation.time < navPointerDedupMs;
}

function setLocale(locale: string | undefined): void {
  if (locale !== 'zh' && locale !== 'en') return;
  if (locale === currentLocale) return;
  currentLocale = locale;
  window.localStorage.setItem(desktopLocaleStorageKey, currentLocale);
  runtimeNotice = null;
  paintChrome();
  if (lastState) {
    paintState(lastState);
    if (dashboardFrame.dataset.visible === 'false') {
      clearDashboard(emptyDashboardMessage(lastState, t));
    }
  }
  syncDashboardLocale();
}

function syncDashboardLocale(): void {
  const src = dashboardFrame.getAttribute('src');
  if (!src || src === 'about:blank') return;
  dashboardFrame.setAttribute('src', routeDashboardUrl(src));
}

async function refreshState(): Promise<void> {
  const api = getApi();
  if (!api) {
    paintBridgeUnavailable();
    return;
  }

  try {
    const state = await readRuntimeState(api);
    lastState = state;
    paintState(state);
    await syncDashboardForState(state);
  } catch (error) {
    runtimeDot.dataset.status = 'degraded';
    runtimeStatus.textContent = t('runtime.stateUnavailable');
    setRuntimeMetaText(t('runtime.stateUnavailableDetail', { error: formatError(error) }));
    versionLine.textContent = t('version.unavailable');
    paintControls(null);
    paintRuntimeCounts(null);
    clearDashboard(t('empty.stateUnavailable'));
  }
}

async function readRuntimeState(api: BotmuxDesktopApi): Promise<DesktopRuntimeState> {
  const state = await api.getState();
  if (isRuntimeState(state)) return state;
  throw new Error('Invalid runtime state from desktop IPC');
}

function paintState(state: DesktopRuntimeState): void {
  runtimeDot.dataset.status = state.status;
  runtimeStatus.textContent = t(`runtime.status.${state.status}`);
  setRuntimeMetaText(runtimeNotice ?? state.message ?? buildRuntimeMeta(state, t));
  const versionText = buildVersionLine(state);
  versionLine.textContent = versionText;
  versionLine.title = state.runtimePath ? `${versionText}\n${state.runtimePath}` : versionText;
  paintRuntimeCounts(state);
  paintControls(state);
}

function setRuntimeMetaText(message: string): void {
  // The compact footer clamps long CLI messages, so keep the full text available on hover.
  const trimmed = message.trim();
  if (!trimmed) {
    runtimeMeta.hidden = true;
    runtimeMeta.textContent = '';
    runtimeMeta.title = '';
    return;
  }
  runtimeMeta.hidden = false;
  runtimeMeta.textContent = trimmed;
  runtimeMeta.title = trimmed;
}

function paintRuntimeCounts(state: DesktopRuntimeState | null): void {
  botCount.textContent = String(state?.botCount ?? 0);
  onlineCount.textContent = String(state?.onlineDaemonCount ?? 0);
  attentionCount.textContent = String(state?.attentionCount ?? 0);
}

function paintControls(state: DesktopRuntimeState | null): void {
  const bridgeUnavailable = !getApi();
  const disabled = bridgeUnavailable || actionPending;
  const status = state?.status;
  const unmanagedRuntime = Boolean(state && !state.runtimeManaged);

  startBtn.disabled = disabled || unmanagedRuntime || status === 'running' || status === 'starting';
  stopBtn.disabled =
    disabled || unmanagedRuntime || !status || status === 'not_configured' || status === 'stopped' || status === 'starting';
  restartBtn.disabled = disabled || unmanagedRuntime || !status || status === 'not_configured' || status === 'starting';
  takeoverBtn.hidden = true;
  takeoverBtn.disabled = true;
  createSessionBtn.disabled = bridgeUnavailable || unmanagedRuntime;
  addBotBtn.disabled = bridgeUnavailable || unmanagedRuntime;
  logsBtn.disabled = bridgeUnavailable;
  homeBtn.disabled = bridgeUnavailable;
}

function paintBridgeUnavailable(): void {
  runtimeDot.dataset.status = 'degraded';
  runtimeStatus.textContent = t('runtime.bridgeUnavailable');
  setRuntimeMetaText(t('runtime.bridgeUnavailableDetail'));
  versionLine.textContent = t('version.unavailable');
  loginToggle.disabled = true;
  paintRuntimeCounts(null);
  paintControls(null);
  clearDashboard(t('empty.bridgeUnavailable'));
  setLogOutput(t('empty.bridgeUnavailable'));
}

async function syncDashboardForState(state: DesktopRuntimeState): Promise<void> {
  const api = getApi();
  const cachedDashboardUrl = currentDashboardUrl();

  if (cachedDashboardUrl && state.status === 'running') {
    // Runtime monitor refreshes should not re-run dashboard URL discovery once
    // the webview is loaded; PM2/CLI probes are much slower than a hash update.
    cancelDashboardLocateRetry();
    showDashboard(routeDashboardUrl(cachedDashboardUrl));
    return;
  }
  if (cachedDashboardUrl && shouldKeepLoadedDashboardDuringDegradedState(state)) {
    return;
  }

  const shouldLoad = Boolean(state.dashboardUrl) || state.status === 'running';

  if (!shouldLoad) {
    clearDashboard(emptyDashboardMessage(state, t));
    return;
  }

  const token = ++dashboardLoadToken;
  let dashboardUrl = state.dashboardUrl;
  if (!dashboardUrl) {
    if (!api) {
      paintBridgeUnavailable();
      return;
    }
    try {
      dashboardUrl = await locateDashboardUrl(api);
    } catch (error) {
      if (token === dashboardLoadToken) {
        clearDashboard(formatDashboardError(error));
        scheduleDashboardLocateRetry(state);
      }
      return;
    }
  }

  if (token !== dashboardLoadToken) return;
  if (dashboardUrl) {
    cancelDashboardLocateRetry();
    showDashboard(routeDashboardUrl(dashboardUrl));
  } else {
    clearDashboard(emptyDashboardMessage(state, t));
  }
}

function showDashboard(url: string): void {
  cancelDashboardLocateRetry();
  emptyDashboard.hidden = true;
  setDashboardVisible(true);
  paintDashboardNav(dashboardRoute ?? '#/');
  if (dashboardFrame.getAttribute('src') !== url) {
    desktopShellCssInjectedUrl = null;
    dashboardFrame.setAttribute('src', url);
  }
}

async function injectDesktopShellCss(): Promise<void> {
  const url = currentDashboardUrl();
  if (!url || desktopShellCssInjectedUrl === url) return;
  if (typeof dashboardFrame.insertCSS !== 'function') return;
  desktopShellCssInjectedUrl = url;
  try {
    // Keep dashboard source code browser-first: Desktop owns native chrome, so it
    // masks the embedded dashboard chrome from the webview boundary.
    await dashboardFrame.insertCSS(desktopShellInjectedCss);
  } catch {
    if (desktopShellCssInjectedUrl === url) desktopShellCssInjectedUrl = null;
    // CSS injection is best-effort; compat checks still prevent unsafe embeds.
  }
}

function clearDashboard(message: string): void {
  cancelDashboardLocateRetry();
  dashboardRoute = null;
  dashboardGeneration += 1;
  dashboardLoadToken += 1;
  desktopShellCssInjectedUrl = null;
  paintDashboardNav('#/');
  setDashboardVisible(false);
  dashboardFrame.setAttribute('src', 'about:blank');
  emptyDashboard.hidden = false;
  emptyDashboard.textContent = message;
}

function scheduleDashboardLocateRetry(state: DesktopRuntimeState): void {
  if (state.status !== 'running' || dashboardLocateRetryTimer !== null) return;
  // A compat endpoint can become available without changing the runtime state
  // shape, so retry the empty incompatible view independently of state pushes.
  dashboardLocateRetryTimer = window.setTimeout(() => {
    dashboardLocateRetryTimer = null;
    if (!lastState || lastState.status !== 'running' || currentDashboardUrl()) return;
    void syncDashboardForState(lastState);
  }, dashboardLocateRetryMs);
}

function cancelDashboardLocateRetry(): void {
  if (dashboardLocateRetryTimer === null) return;
  window.clearTimeout(dashboardLocateRetryTimer);
  dashboardLocateRetryTimer = null;
}

function setDashboardVisible(visible: boolean): void {
  // Keep the webview laid out even when hidden; Electron guests attached under
  // display:none can keep the default 300x150 viewport after becoming visible.
  dashboardFrame.dataset.visible = visible ? 'true' : 'false';
  dashboardFrame.setAttribute('aria-hidden', visible ? 'false' : 'true');
}

async function runRuntimeAction(label: string, action: (api: BotmuxDesktopApi) => Promise<RunResult>): Promise<void> {
  if (actionPending) return;

  const api = getApi();
  if (!api) {
    paintBridgeUnavailable();
    return;
  }

  actionPending = true;
  paintControls(lastState);
  setRuntimeNotice(t('action.requested', { label }));
  try {
    const result = await action(api);
    runtimeNotice = describeRunResult(label, result);
  } catch (error) {
    runtimeNotice = t('action.failed', { label, error: formatError(error) });
  } finally {
    // State refresh can take several seconds because it may spawn the CLI to
    // query PM2/dashboard state; release controls first so the UI never looks
    // permanently stuck after the runtime action itself has returned.
    actionPending = false;
    paintControls(lastState);
    await refreshState();
  }
}

function describeRunResult(label: string, result: RunResult): string | null {
  if (!result || result.code === 0) return null;
  const detail = concise(result.stderr || result.stdout || `exit code ${result.code}`);
  return t('action.failed', { label, error: detail });
}

async function openBotOnboarding(): Promise<void> {
  // The desktop shell hides the dashboard topbar, so pass a one-shot route
  // action that lets the embedded dashboard open its own onboarding modal.
  await openDashboardRoute('#/?open=bot-onboarding', t('dashboard.openBotOnboarding'));
}

async function openCreateSession(): Promise<void> {
  // The dashboard's create-session button lives in its hidden topbar; Desktop
  // routes to Sessions so the page-owned React dialog is mounted before opening.
  await openDashboardRoute('#/sessions?open=create-session', t('dashboard.openCreateSession'));
}

async function openDashboardRoute(route: string, notice = t('dashboard.openingPage')): Promise<void> {
  const api = getApi();
  if (!api) {
    paintBridgeUnavailable();
    return;
  }

  const generation = dashboardGeneration;
  dashboardRoute = normalizeDashboardRoute(route);
  paintDashboardNav(dashboardRoute);
  setRuntimeNotice(notice);
  const cachedDashboardUrl = currentDashboardUrl();
  if (cachedDashboardUrl && lastState?.status === 'degraded' && shouldKeepLoadedDashboardDuringDegradedState(lastState)) {
    // PM2/status degradation should not prevent in-webview hash navigation once
    // a compatible dashboard has already loaded; protocol mismatch still clears below.
    showDashboard(routeDashboardUrl(cachedDashboardUrl));
    setRuntimeNotice(null);
    return;
  }
  if (lastState?.status === 'degraded') {
    setRuntimeNotice(null);
    clearDashboard(emptyDashboardMessage(lastState, t));
    return;
  }

  if (cachedDashboardUrl) {
    // Sidebar route changes should stay inside the already-loaded webview; a
    // fresh dashboard URL lookup can spawn the CLI and make navigation feel stuck.
    showDashboard(routeDashboardUrl(cachedDashboardUrl));
    setRuntimeNotice(null);
    return;
  }

  try {
    const dashboardUrl = await locateDashboardUrl(api);
    if (generation !== dashboardGeneration) return;
    if (!dashboardUrl) {
      setRuntimeNotice(t('dashboard.urlUnavailable'));
      clearDashboard(t('empty.startFirst'));
      return;
    }
    // Preserve the selected route across ordinary runtime state refreshes.
    showDashboard(routeDashboardUrl(dashboardUrl));
    setRuntimeNotice(null);
  } catch (error) {
    if (generation === dashboardGeneration) {
      setRuntimeNotice(error instanceof DashboardLocateError
        ? error.message
        : t('dashboard.openFailed', { error: formatError(error) }));
    }
  }
}

async function locateDashboardUrl(api: BotmuxDesktopApi): Promise<string | null> {
  if (api.locateDashboard) {
    const locate = await api.locateDashboard();
    if (locate.ok) return locate.url;
    // Structured locate failures are user-facing state, not generic exceptions:
    // preserve reason/message so the empty dashboard can say what is wrong.
    throw new DashboardLocateError(formatDashboardLocateFailure(locate));
  }
  return api.getDashboardUrl();
}

function formatDashboardLocateFailure(locate: Extract<DashboardLocateResult, { ok: false }>): string {
  return t('empty.dashboardLocateFailed', {
    reason: locate.reason,
    message: locate.message || t('error.unknown'),
  });
}

function formatDashboardError(error: unknown): string {
  if (error instanceof DashboardLocateError) return error.message;
  return t('empty.dashboardUnavailable', { error: formatError(error) });
}

function routeDashboardUrl(url: string): string {
  return buildDashboardUrl(url, dashboardRoute, {
    locale: currentLocale,
    runtimeVersion: lastState?.runtimeVersion ?? null,
  });
}

function currentDashboardUrl(): string | null {
  return currentDashboardUrlFromSrc(dashboardFrame.getAttribute('src'));
}

function paintDashboardNav(hash: string): void {
  for (const link of dashboardNavLinks) {
    const route = normalizeDashboardRoute(link.dataset.dashboardRoute ?? '#/');
    link.classList.toggle('active', dashboardRouteMatches(route, hash));
  }
}

async function initializeLoginToggle(api: BotmuxDesktopApi): Promise<void> {
  loginToggle.disabled = true;
  try {
    const state = await api.getLoginItem();
    loginToggle.checked = Boolean(state.openAtLogin);
    loginToggle.title = state.legacyAutostart ? `Legacy autostart detected at ${state.legacyPath ?? 'LaunchAgents'}` : '';
  } catch (error) {
    setRuntimeNotice(t('login.unavailable', { error: formatError(error) }));
  } finally {
    loginToggle.disabled = false;
  }

  loginToggle.addEventListener('change', () => {
    void updateLoginItem(api, loginToggle.checked);
  });
}

async function updateLoginItem(api: BotmuxDesktopApi, enabled: boolean): Promise<void> {
  loginToggle.disabled = true;
  try {
    const state = await api.setLoginItem(enabled);
    loginToggle.checked = Boolean(state.openAtLogin);
    setRuntimeNotice(null);
  } catch (error) {
    loginToggle.checked = !enabled;
    setRuntimeNotice(t('login.updateFailed', { error: formatError(error) }));
  } finally {
    loginToggle.disabled = false;
  }
}

async function openLogsDrawer(): Promise<void> {
  const token = ++logsOpenToken;
  logsDrawer.classList.add('open');
  logsDrawer.setAttribute('aria-hidden', 'false');
  await populateLogTargets(token);
  if (!isLogsDrawerOpen(token)) return;
  await pollLogs(token);
  if (!isLogsDrawerOpen(token)) return;
  startLogPolling(token);
}

function closeLogsDrawer(): void {
  logsOpenToken += 1;
  logsDrawer.classList.remove('open');
  logsDrawer.setAttribute('aria-hidden', 'true');
  stopLogPolling();
}

function startLogPolling(token: number): void {
  stopLogPolling();
  logTimer = window.setInterval(() => {
    void pollLogs(token);
  }, logPollIntervalMs);
}

function stopLogPolling(): void {
  if (logTimer !== null) {
    window.clearInterval(logTimer);
    logTimer = null;
  }
}

async function pollLogs(token = logsOpenToken): Promise<void> {
  if (logPollInFlight || !isLogsDrawerOpen(token)) return;
  logPollInFlight = true;
  try {
    // Refresh targets on every poll so newly-created daemon logs appear without
    // closing and reopening the drawer.
    await populateLogTargets(token);
    if (!isLogsDrawerOpen(token)) return;
    if (!logTarget.disabled && logTarget.value) {
      await tailSelectedLogs(token);
    }
  } finally {
    logPollInFlight = false;
  }
}

function isLogsDrawerOpen(token = logsOpenToken): boolean {
  return token === logsOpenToken && logsDrawer.classList.contains('open');
}

async function populateLogTargets(token = logsOpenToken): Promise<void> {
  const api = getApi();
  if (!api) {
    paintBridgeUnavailable();
    return;
  }

  try {
    const targets = await api.listLogTargets();
    if (!isLogsDrawerOpen(token)) return;
    const previous = logTarget.value;
    if (!logTargetOptionsMatch(targets)) {
      logTarget.replaceChildren();

      for (const target of targets) {
        const option = document.createElement('option');
        option.value = target.id;
        option.textContent = target.label;
        logTarget.append(option);
      }
    }

    const hasFiles = targets.some(target => target.files.length > 0);
    logTarget.disabled = targets.length === 0 || !hasFiles;
    if (targets.length > 0) {
      const selected = targets.find(target => target.id === previous)?.id ?? targets[0].id;
      logTarget.value = selected;
    }
    if (!hasFiles) {
      setLogOutput(t('logs.noFiles'));
    }
  } catch (error) {
    if (!isLogsDrawerOpen(token)) return;
    logTarget.disabled = true;
    setLogOutput(t('logs.listFailed', { error: formatError(error) }));
  }
}

async function tailSelectedLogs(token = logsOpenToken): Promise<void> {
  if (!isLogsDrawerOpen(token)) return;

  const api = getApi();
  if (!api) {
    paintBridgeUnavailable();
    return;
  }

  const targetId = logTarget.value;
  if (!targetId) return;

  try {
    const tail = await api.tailLogs(targetId);
    if (!isLogsDrawerOpen(token)) return;
    const text = tail.text.trimEnd();
    const prefix = tail.truncated ? t('logs.recentPrefix') : '';
    const shouldStickToBottom = shouldAutoScrollLogs();
    setLogOutput(text ? `${prefix}${text}` : t('logs.empty'));
    if (shouldStickToBottom) logOutput.scrollTop = logOutput.scrollHeight;
  } catch (error) {
    if (!isLogsDrawerOpen(token)) return;
    setLogOutput(t('logs.readFailed', { error: formatError(error) }));
  }
}

function logTargetOptionsMatch(targets: LogTarget[]): boolean {
  const options = Array.from(logTarget.options);
  return options.length === targets.length && options.every((option, index) => (
    option.value === targets[index]?.id && option.textContent === targets[index]?.label
  ));
}

function shouldAutoScrollLogs(): boolean {
  return logOutput.scrollHeight - logOutput.scrollTop - logOutput.clientHeight <= 8;
}

async function copyLogs(): Promise<void> {
  try {
    await navigator.clipboard.writeText(logOutput.textContent ?? '');
    setRuntimeNotice(t('logs.copied'));
  } catch (error) {
    setRuntimeNotice(t('logs.copyFailed', { error: formatError(error) }));
  }
}

async function openPath(label: string, opener: (api: BotmuxDesktopApi) => Promise<string>): Promise<void> {
  const api = getApi();
  if (!api) {
    paintBridgeUnavailable();
    return;
  }

  try {
    const result = await opener(api);
    setRuntimeNotice(result ? t('path.openFailed', { label, error: concise(result) }) : null);
  } catch (error) {
    setRuntimeNotice(t('path.openFailed', { label, error: formatError(error) }));
  }
}

function setRuntimeNotice(message: string | null): void {
  runtimeNotice = message ? concise(message) : null;
  if (lastState) {
    paintState(lastState);
  } else if (runtimeNotice) {
    setRuntimeMetaText(runtimeNotice);
  }
}

function setLogOutput(message: string): void {
  logOutput.textContent = message;
}

function formatError(error: unknown): string {
  if (error instanceof Error) return concise(error.message);
  return concise(String(error));
}

function concise(value: string): string {
  const text = value.replace(/\s+/g, ' ').trim();
  if (text.length <= 180) return text || t('error.unknown');
  return `${text.slice(0, 177)}...`;
}
