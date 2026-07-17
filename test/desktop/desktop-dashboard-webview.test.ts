import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('desktop dashboard embed', () => {
  function sidebarRoutes(html: string): string[] {
    // Compare the authored navigation routes, not rendered text; i18n labels can
    // differ while the desktop shell still needs every dashboard entry.
    const nav = /<nav class="sidebar-nav"[\s\S]*?<\/nav>/.exec(html)?.[0] ?? '';
    return [...nav.matchAll(/\bdata-route="([^"]+)"/g)].map(match => match[1]);
  }

  function dashboardNavRoutes(source: string): string[] {
    const navItems = /const NAV_ITEMS: NavItem\[] = \[([\s\S]*?)\];/.exec(source)?.[1] ?? '';
    return [...navItems.matchAll(/\bid: '([^']+)'/g)].map(match => match[1]);
  }

  it('renders native dashboard chrome around the webview', () => {
    const html = readFileSync(
      fileURLToPath(new URL('../../src/desktop/renderer/index.html', import.meta.url)),
      'utf-8',
    );
    const styleSource = readFileSync(
      fileURLToPath(new URL('../../src/desktop/renderer/style.css', import.meta.url)),
      'utf-8',
    );

    // The macOS app owns the persistent navigation and status bars while the
    // webview renders only dashboard content.
    expect(html).toContain('class="sidebar-nav"');
    expect(html).toContain('class="topbar"');
    const brandText = /<div class="brand-text">([\s\S]*?)<\/div>/.exec(html)?.[1] ?? '';
    expect(brandText).not.toContain('data-i18n="app.subtitle"');
    expect(styleSource).toContain('--topbar-height: 56px');
    expect(html).not.toContain('id="connection-status"');
    expect(html).toContain('data-dashboard-route="#/sessions"');
  });

  it('mirrors the browser dashboard navigation routes', () => {
    const dashboardSource = readFileSync(
      fileURLToPath(new URL('../../src/dashboard/web/app.tsx', import.meta.url)),
      'utf-8',
    );
    const desktopHtml = readFileSync(
      fileURLToPath(new URL('../../src/desktop/renderer/index.html', import.meta.url)),
      'utf-8',
    );

    expect(sidebarRoutes(desktopHtml)).toEqual(dashboardNavRoutes(dashboardSource));
  });

  it('keeps lower-left runtime status distinct from topbar counts', () => {
    const html = readFileSync(
      fileURLToPath(new URL('../../src/desktop/renderer/index.html', import.meta.url)),
      'utf-8',
    );
    const rendererSource = readFileSync(
      fileURLToPath(new URL('../../src/desktop/renderer/app.ts', import.meta.url)),
      'utf-8',
    );
    const runtimeStateSource = readFileSync(
      fileURLToPath(new URL('../../src/desktop/renderer/runtime-state.ts', import.meta.url)),
      'utf-8',
    );

    // Topbar owns aggregate counts; the lower-left runtime block should not
    // repeat routine CLI source labels under the status.
    expect(html).not.toContain('id="connection-status"');
    const runtimeMetaFunction = /function buildRuntimeMeta[\s\S]*?function buildVersionLine/.exec(runtimeStateSource)?.[0] ?? '';
    expect(runtimeMetaFunction).not.toContain('runtime.botCount');
    expect(runtimeMetaFunction).not.toContain('runtime.onlineCount');
    expect(runtimeMetaFunction).not.toContain('runtime.attentionCount');
    expect(runtimeMetaFunction).not.toContain('onlineDaemonCount');
    expect(runtimeMetaFunction).toContain("case 'global-cli'");
    expect(runtimeMetaFunction).toContain("return ''");
    expect(runtimeMetaFunction).toContain("runtimeSource.none");
    expect(runtimeMetaFunction).not.toContain("runtimeSource.appBootstrap");
    expect(runtimeStateSource).toContain('/ CLI ${runtimeVersion}');
    expect(rendererSource).toContain("from './runtime-state.js'");
    expect(rendererSource).toContain('runtimeMeta.hidden = true');
  });

  it('labels desktop summary counts by their runtime-state sources', () => {
    const html = readFileSync(
      fileURLToPath(new URL('../../src/desktop/renderer/index.html', import.meta.url)),
      'utf-8',
    );
    const rendererSource = readFileSync(
      fileURLToPath(new URL('../../src/desktop/renderer/app.ts', import.meta.url)),
      'utf-8',
    );

    expect(html).toContain('data-i18n="summary.onlineDaemons">在线 Daemon</span><strong id="online-count"');
    expect(html).toContain('data-i18n="summary.needsAttention">需要处理</span><strong id="attention-count"');
    expect(html).toContain('data-i18n="summary.configuredBots">已配置 Bot</span><strong id="bot-count"');
    expect(rendererSource).toContain("'summary.onlineDaemons': 'Online daemons'");
    expect(rendererSource).toContain('onlineCount.textContent = String(state?.onlineDaemonCount ?? 0)');
    expect(rendererSource).toContain('botCount.textContent = String(state?.botCount ?? 0)');
  });

  it('uses an isolated webview instead of a file-page iframe', () => {
    const html = readFileSync(
      fileURLToPath(new URL('../../src/desktop/renderer/index.html', import.meta.url)),
      'utf-8',
    );
    const windowSource = readFileSync(
      fileURLToPath(new URL('../../src/desktop/main/window.ts', import.meta.url)),
      'utf-8',
    );

    // Chromium blocks the packaged file:// shell from embedding the HTTP
    // dashboard in a normal iframe; webview keeps it in an isolated guest.
    expect(html).toMatch(/<webview\b[\s\S]*\bid="dashboard-frame"/);
    expect(windowSource).toContain('webviewTag: true');
    expect(windowSource).toContain("will-attach-webview");
  });

  it('allows embedded dashboard target-blank links to reach the browser handoff', () => {
    const html = readFileSync(
      fileURLToPath(new URL('../../src/desktop/renderer/index.html', import.meta.url)),
      'utf-8',
    );
    const windowSource = readFileSync(
      fileURLToPath(new URL('../../src/desktop/main/window.ts', import.meta.url)),
      'utf-8',
    );

    // Session terminal links are authored inside the dashboard webview with
    // target=_blank. The shell must allow the popup request, then the main
    // process safely hands http(s) URLs to the user's browser.
    expect(html).toMatch(/<webview\b[\s\S]*\ballowpopups\b/);
    expect(windowSource).toContain("did-attach-webview");
    expect(windowSource).toContain("setWindowOpenHandler");
    expect(windowSource).toContain("shouldOpenUrlExternally(url)");
  });

  it('keeps the webview laid out while visually hidden', () => {
    const html = readFileSync(
      fileURLToPath(new URL('../../src/desktop/renderer/index.html', import.meta.url)),
      'utf-8',
    );
    const rendererSource = readFileSync(
      fileURLToPath(new URL('../../src/desktop/renderer/app.ts', import.meta.url)),
      'utf-8',
    );
    const styleSource = readFileSync(
      fileURLToPath(new URL('../../src/desktop/renderer/style.css', import.meta.url)),
      'utf-8',
    );

    // A hidden webview attaches at Chromium's default 300x150 guest viewport
    // and can stay cropped after the host element becomes visible.
    expect(html).not.toMatch(/<webview\\b[^>]*\\bhidden\\b/);
    expect(rendererSource).not.toContain('dashboardFrame.hidden');
    const frameRule = /#dashboard-frame\s*{(?<body>[^}]*)}/.exec(styleSource)?.groups?.body ?? '';
    expect(frameRule).toContain('display: flex;');
  });

  it('opens the embedded dashboard in desktop shell mode', () => {
    const rendererSource = readFileSync(
      fileURLToPath(new URL('../../src/desktop/renderer/app.ts', import.meta.url)),
      'utf-8',
    );
    const dashboardUrlSource = readFileSync(
      fileURLToPath(new URL('../../src/desktop/renderer/dashboard-url.ts', import.meta.url)),
      'utf-8',
    );

    // The native shell owns the left nav and topbar, so the embedded page must
    // be told to hide its own duplicate dashboard chrome.
    expect(rendererSource).toContain("from './dashboard-url.js'");
    expect(rendererSource).toContain('routeDashboardUrl as buildDashboardUrl');
    expect(dashboardUrlSource).toContain("params.set('shell', 'desktop')");
    expect(dashboardUrlSource).toContain('withDesktopShell');
  });

  it('uses structured dashboard locate before falling back to legacy URL lookup', () => {
    const preloadSource = readFileSync(
      fileURLToPath(new URL('../../src/desktop/preload.ts', import.meta.url)),
      'utf-8',
    );
    const rendererSource = readFileSync(
      fileURLToPath(new URL('../../src/desktop/renderer/app.ts', import.meta.url)),
      'utf-8',
    );

    expect(preloadSource).toContain("ipcRenderer.invoke('desktop:locate-dashboard')");
    expect(rendererSource).toContain('locateDashboard?:');
    expect(rendererSource).toContain('locateDashboardUrl(api)');
    expect(rendererSource.indexOf('api.locateDashboard')).toBeLessThan(
      rendererSource.indexOf('api.getDashboardUrl'),
    );
  });

  it('renders structured dashboard locate failure reason/message', () => {
    const rendererSource = readFileSync(
      fileURLToPath(new URL('../../src/desktop/renderer/app.ts', import.meta.url)),
      'utf-8',
    );

    expect(rendererSource).toContain('Dashboard unavailable ({reason}): {message}');
    expect(rendererSource).toContain('控制台不可用（{reason}）：{message}');
    expect(rendererSource).toContain('formatDashboardLocateFailure');
    expect(rendererSource).toContain('locate.reason');
    expect(rendererSource).toContain('locate.message');
  });

  it('switches sidebar routes without re-querying the dashboard URL after load', () => {
    const rendererSource = readFileSync(
      fileURLToPath(new URL('../../src/desktop/renderer/app.ts', import.meta.url)),
      'utf-8',
    );

    const openRouteFunction = /async function openDashboardRoute[\s\S]*?function routeDashboardUrl/.exec(rendererSource)?.[0] ?? '';
    // Route changes inside an already-loaded webview should be a hash update,
    // not a slow round trip through the main process and CLI dashboard lookup.
    expect(openRouteFunction).toContain('currentDashboardUrl()');
    expect(openRouteFunction.indexOf('currentDashboardUrl()')).toBeLessThan(
      openRouteFunction.indexOf('api.getDashboardUrl()'),
    );
    expect(openRouteFunction).toContain('showDashboard(routeDashboardUrl(cachedDashboardUrl))');
  });

  it('keeps sidebar route clicks working when webview focus swallows click follow-up', () => {
    const rendererSource = readFileSync(
      fileURLToPath(new URL('../../src/desktop/renderer/app.ts', import.meta.url)),
      'utf-8',
    );

    // Real Electron webviews can take focus after a sidebar press and lose the
    // click follow-up. The pointerup fallback keeps the native rail responsive.
    expect(rendererSource).toContain('function wireDashboardNavLink');
    expect(rendererSource).toContain("link.addEventListener('pointerup'");
    expect(rendererSource).toContain('isRecentPointerNavigation(route)');
    expect(rendererSource).toContain('navPointerDedupMs');
  });

  it('allows sidebar hash navigation on a loaded dashboard during non-protocol degraded state', () => {
    const rendererSource = readFileSync(
      fileURLToPath(new URL('../../src/desktop/renderer/app.ts', import.meta.url)),
      'utf-8',
    );

    const openRouteFunction = /async function openDashboardRoute[\s\S]*?async function locateDashboardUrl/.exec(rendererSource)?.[0] ?? '';
    expect(openRouteFunction).toContain("lastState?.status === 'degraded'");
    expect(openRouteFunction).toContain('shouldKeepLoadedDashboardDuringDegradedState(lastState)');
    expect(openRouteFunction.indexOf('currentDashboardUrl()')).toBeLessThan(
      openRouteFunction.indexOf("lastState?.status === 'degraded'"),
    );
  });

  it('keeps an already-loaded dashboard during ordinary runtime monitor refreshes', () => {
    const rendererSource = readFileSync(
      fileURLToPath(new URL('../../src/desktop/renderer/app.ts', import.meta.url)),
      'utf-8',
    );

    const syncDashboardFunction = /async function syncDashboardForState[\s\S]*?function showDashboard/.exec(rendererSource)?.[0] ?? '';
    expect(syncDashboardFunction).toContain('const cachedDashboardUrl = currentDashboardUrl()');
    expect(syncDashboardFunction).toContain("state.status === 'running'");
    expect(syncDashboardFunction).toContain('showDashboard(routeDashboardUrl(cachedDashboardUrl))');
    expect(syncDashboardFunction.indexOf('currentDashboardUrl()')).toBeLessThan(
      syncDashboardFunction.indexOf('locateDashboardUrl(api)'),
    );
    expect(syncDashboardFunction).toContain('shouldKeepLoadedDashboardDuringDegradedState(state)');
  });

  it('retries dashboard locate after a running-state compat failure', () => {
    const rendererSource = readFileSync(
      fileURLToPath(new URL('../../src/desktop/renderer/app.ts', import.meta.url)),
      'utf-8',
    );

    const syncDashboardFunction = /async function syncDashboardForState[\s\S]*?function showDashboard/.exec(rendererSource)?.[0] ?? '';
    // A compatible runtime can appear without changing the running state shape,
    // so the empty incompatible view needs its own low-frequency retry path.
    expect(rendererSource).toContain('dashboardLocateRetryMs');
    expect(rendererSource).toContain('function scheduleDashboardLocateRetry');
    expect(syncDashboardFunction).toContain('scheduleDashboardLocateRetry(state)');
    expect(rendererSource).toContain('window.setTimeout');
  });

  it('uses setup messages from runtime state before the generic add-bot empty state', () => {
    const runtimeStateSource = readFileSync(
      fileURLToPath(new URL('../../src/desktop/renderer/runtime-state.ts', import.meta.url)),
      'utf-8',
    );

    const emptyMessageFunction = /function emptyDashboardMessage[\s\S]*?function shouldKeepLoadedDashboardDuringDegradedState/.exec(runtimeStateSource)?.[0] ?? '';
    expect(emptyMessageFunction).toContain("state.status === 'not_configured'");
    expect(emptyMessageFunction).toContain('state.message ??');
  });

  it('validates runtimeSource in pushed runtime state snapshots', () => {
    const runtimeStateSource = readFileSync(
      fileURLToPath(new URL('../../src/desktop/renderer/runtime-state.ts', import.meta.url)),
      'utf-8',
    );

    const stateGuardFunction = /function isRuntimeState[\s\S]*?function isNullableString/.exec(runtimeStateSource)?.[0] ?? '';
    expect(stateGuardFunction).toContain('runtimeSourceValues.has');
    expect(stateGuardFunction).toContain('candidate.runtimeSource');
    expect(stateGuardFunction).not.toContain('source-checkout');
  });

  it('validates pulled runtime state snapshots before painting controls', () => {
    const rendererSource = readFileSync(
      fileURLToPath(new URL('../../src/desktop/renderer/app.ts', import.meta.url)),
      'utf-8',
    );

    const readStateFunction = /async function readRuntimeState[\s\S]*?function paintState/.exec(rendererSource)?.[0] ?? '';
    expect(readStateFunction).toContain('const state = await api.getState()');
    expect(readStateFunction).toContain('if (isRuntimeState(state)) return state');
    expect(rendererSource).toContain('const state = await readRuntimeState(api)');
  });

  it('deduplicates desktop shell CSS injection during one webview load', () => {
    const rendererSource = readFileSync(
      fileURLToPath(new URL('../../src/desktop/renderer/app.ts', import.meta.url)),
      'utf-8',
    );

    const injectFunction = /async function injectDesktopShellCss[\s\S]*?function clearDashboard/.exec(rendererSource)?.[0] ?? '';
    expect(rendererSource).toContain('desktopShellCssInjectedUrl');
    expect(rendererSource).toContain("dashboardFrame.addEventListener('did-start-loading'");
    expect(injectFunction).toContain('desktopShellCssInjectedUrl === url');
    expect(injectFunction).toContain('desktopShellCssInjectedUrl = url');
  });

  it('keeps log polling from clobbering user scroll and unchanged target selection', () => {
    const rendererSource = readFileSync(
      fileURLToPath(new URL('../../src/desktop/renderer/app.ts', import.meta.url)),
      'utf-8',
    );

    const targetFunction = /async function populateLogTargets[\s\S]*?async function tailSelectedLogs/.exec(rendererSource)?.[0] ?? '';
    const tailFunction = /async function tailSelectedLogs[\s\S]*?async function copyLogs/.exec(rendererSource)?.[0] ?? '';
    expect(targetFunction).toContain('if (!logTargetOptionsMatch(targets))');
    expect(rendererSource).toContain('function logTargetOptionsMatch');
    expect(tailFunction).toContain('const shouldStickToBottom = shouldAutoScrollLogs()');
    expect(tailFunction).toContain('if (shouldStickToBottom)');
    expect(rendererSource).toContain('function shouldAutoScrollLogs');
  });

  it('keeps legacy takeover IPC but does not offer a failing handoff action', () => {
    const html = readFileSync(
      fileURLToPath(new URL('../../src/desktop/renderer/index.html', import.meta.url)),
      'utf-8',
    );
    const preloadSource = readFileSync(
      fileURLToPath(new URL('../../src/desktop/preload.ts', import.meta.url)),
      'utf-8',
    );
    const rendererSource = readFileSync(
      fileURLToPath(new URL('../../src/desktop/renderer/app.ts', import.meta.url)),
      'utf-8',
    );
    const dashboardUrlSource = readFileSync(
      fileURLToPath(new URL('../../src/desktop/renderer/dashboard-url.ts', import.meta.url)),
      'utf-8',
    );

    // The IPC remains for older renderers, but CLI-first handoff states are
    // resolved by the user in Terminal instead of a button that would fail.
    expect(html).toContain('id="takeover-btn"');
    expect(preloadSource).toContain("ipcRenderer.invoke('desktop:takeover')");
    expect(rendererSource).toContain('takeoverBtn.hidden = true');
    expect(rendererSource).toContain('takeoverBtn.disabled = true');
    expect(rendererSource).toContain('api.takeover()');
  });

  it('releases runtime action controls before slow state refresh completes', () => {
    const rendererSource = readFileSync(
      fileURLToPath(new URL('../../src/desktop/renderer/app.ts', import.meta.url)),
      'utf-8',
    );

    const actionFunction = /async function runRuntimeAction[\s\S]*?function describeRunResult/.exec(rendererSource)?.[0] ?? '';
    expect(actionFunction.indexOf('actionPending = false')).toBeGreaterThan(-1);
    expect(actionFunction.indexOf('actionPending = false')).toBeLessThan(actionFunction.indexOf('await refreshState()'));
  });

  it('renders runtime actions as a polished icon control group', () => {
    const html = readFileSync(
      fileURLToPath(new URL('../../src/desktop/renderer/index.html', import.meta.url)),
      'utf-8',
    );
    const styleSource = readFileSync(
      fileURLToPath(new URL('../../src/desktop/renderer/style.css', import.meta.url)),
      'utf-8',
    );

    expect(html).toContain('runtime-control-group');
    expect(html).toContain('runtime-action-primary');
    expect(html).toContain('runtime-action-danger');
    expect(html).toContain('runtime-action-quiet');
    expect(html).toContain('runtime-action-takeover');
    expect(html).toContain('runtime-action-label');
    expect(styleSource).toContain('.runtime-action[hidden]');
    expect(styleSource).toContain('.runtime-action svg');
    expect(styleSource).toContain('.runtime-action-takeover');
    expect(styleSource).toContain('grid-column: 1 / -1');
    expect(html).toContain('footer-meta-row');
    expect(html).toContain('开机启动 App');
    expect(styleSource).toContain('grid-template-columns: repeat(3, minmax(0, 1fr))');
    expect(styleSource).toContain('grid-template-columns: minmax(0, 1fr)');
    expect(styleSource).toContain('text-align: left');
    expect(styleSource).toContain('-webkit-line-clamp: 2');
  });

  it('syncs desktop locale into the embedded dashboard', () => {
    const html = readFileSync(
      fileURLToPath(new URL('../../src/desktop/renderer/index.html', import.meta.url)),
      'utf-8',
    );
    const rendererSource = readFileSync(
      fileURLToPath(new URL('../../src/desktop/renderer/app.ts', import.meta.url)),
      'utf-8',
    );
    const styleSource = readFileSync(
      fileURLToPath(new URL('../../src/desktop/renderer/style.css', import.meta.url)),
      'utf-8',
    );
    const dashboardUrlSource = readFileSync(
      fileURLToPath(new URL('../../src/desktop/renderer/dashboard-url.ts', import.meta.url)),
      'utf-8',
    );

    // The desktop chrome owns the visible language switcher in app mode, and
    // passes the selected locale through the hash route so token redirects keep it.
    expect(html).toContain('data-locale="zh"');
    expect(html).toContain('data-locale="en"');
    expect(styleSource).toContain('.topbar-actions > button');
    expect(styleSource).not.toContain('.topbar-actions button,');
    expect(rendererSource).toContain('locale: currentLocale');
    expect(dashboardUrlSource).toContain("params.set('locale', options.locale)");
  });

  it('syncs desktop runtime version into the embedded dashboard update card', () => {
    const rendererSource = readFileSync(
      fileURLToPath(new URL('../../src/desktop/renderer/app.ts', import.meta.url)),
      'utf-8',
    );
    const dashboardUrlSource = readFileSync(
      fileURLToPath(new URL('../../src/desktop/renderer/dashboard-url.ts', import.meta.url)),
      'utf-8',
    );

    // The native shell knows the effective runtime selected by the app. Pass it
    // through the hash route so the embedded dashboard Settings page does not
    // show the packaged dashboard process's local 0.0.0 placeholder.
    expect(dashboardUrlSource).toContain("params.set('runtimeVersion'");
    expect(rendererSource).toContain('lastState?.runtimeVersion');
    expect(dashboardUrlSource).toContain("params.delete('runtimeVersion')");
  });

  it('opens add bot through the dashboard onboarding flow', () => {
    const rendererSource = readFileSync(
      fileURLToPath(new URL('../../src/desktop/renderer/app.ts', import.meta.url)),
      'utf-8',
    );

    // The desktop topbar hides the browser dashboard topbar, so its Add bot
    // button must ask the embedded dashboard to open the same onboarding modal.
    expect(rendererSource).toContain("#/?open=bot-onboarding");
    expect(rendererSource).toContain("dashboard.openBotOnboarding");
    expect(rendererSource).not.toContain('async function openBotDefaults');
  });
});
