// Dashboard SPA entry: hash router + bootstrap + online indicator.
import { bootstrap, store } from './store.js';
import { renderOverviewPage } from './overview.js';
import { renderSessionsPage } from './sessions.js';
import { renderSchedulesPage } from './schedules.js';
import { renderGroupsPage } from './groups.js';
import { renderBotDefaultsPage } from './bot-defaults.js';
import { renderRolesPage } from './roles.js';
import { renderTeamFederationPage, renderTeamManagePage } from './team-federation.js';
import { renderConnectorsPage } from './connectors.js';
import { renderWorkflowsPage } from './workflows.js';
import { renderWorkflowCatalogPage } from './workflow-catalog.js';
import { wireBotOnboardingButton } from './bot-onboarding.js';
import { t, ui } from './ui.js';
import type { DashboardLocale } from './i18n.js';
import type { ThemeMode } from './preferences.js';

const root = document.getElementById('root')!;

// ── Auth-expiry overlay ──────────────────────────────────────────────────────
// Any 401 from an API call means the dashboard token was rotated (a new access
// link was generated). Show a blocking overlay so the user knows to switch tabs.
let _expiredShown = false;
export function showAuthExpiredOverlay(): void {
  if (_expiredShown) return;
  _expiredShown = true;
  const el = document.createElement('div');
  el.id = 'auth-expired-overlay';
  el.style.cssText =
    'position:fixed;inset:0;background:rgba(0,0,0,.65);display:flex;' +
    'align-items:center;justify-content:center;z-index:9999';
  el.innerHTML =
    '<div style="background:var(--card,#fff);color:var(--text,#1f2329);border-radius:12px;' +
    'padding:36px 40px;max-width:460px;width:90vw;text-align:center;' +
    'box-shadow:0 12px 40px rgba(0,0,0,.35)">' +
    '<h2 style="margin:0 0 14px;font-size:19px">访问链接已失效</h2>' +
    '<p style="margin:0 0 24px;line-height:1.7;color:var(--muted,#8f959e);font-size:14px">' +
    '当前链接/访问已失效，请使用最新授权链接重新进入。<br>最好关闭当前页。</p>' +
    '<button onclick="window.close()" ' +
    'style="padding:8px 22px;background:var(--accent,#3370ff);color:#fff;border:none;' +
    'border-radius:8px;cursor:pointer;font-size:14px">关闭此页</button>' +
    '</div>';
  document.body.appendChild(el);
}

// Patch the global fetch so every 401 from any API call triggers the overlay.
// Public routes (static shell, read-only workflow API) never return 401, so any
// 401 we see means the session token was rotated while this tab was open.
const _origFetch = window.fetch.bind(window);
window.fetch = async function patchedFetch(
  ...args: Parameters<typeof fetch>
): ReturnType<typeof fetch> {
  const res = await _origFetch(...args);
  if (res.status === 401) showAuthExpiredOverlay();
  return res;
};

// Pages that own a polling loop / cleanup return a disposer; we run it
// on the next route switch so timers don't leak across navigations.
let pageDispose: (() => void) | null = null;

function route() {
  if (pageDispose) { pageDispose(); pageDispose = null; }
  const hash = location.hash || '#/';
  // Catalog is a sub-route under Workflows now (`#/workflows/catalog[/<id>]`)
  // so the top nav has a single "Workflows (beta)" entry.  Legacy
  // `#/workflows-catalog[*]` URLs are kept working for any external links
  // that may have been pasted before the move.
  if (
    hash.startsWith('#/workflows/catalog') ||
    hash.startsWith('#/workflows-catalog')
  ) {
    pageDispose = renderWorkflowCatalogPage(root);
  } else if (hash.startsWith('#/workflows')) pageDispose = renderWorkflowsPage(root);
  else if (hash.startsWith('#/groups')) renderGroupsPage(root);
  else if (hash.startsWith('#/bot-defaults')) renderBotDefaultsPage(root);
  else if (hash.startsWith('#/connectors')) renderConnectorsPage(root);
  else if (hash.startsWith('#/team/manage')) renderTeamManagePage(root);
  else if (hash.startsWith('#/team')) renderTeamFederationPage(root);
  else if (hash.startsWith('#/roles')) renderRolesPage(root);
  else if (hash.startsWith('#/schedules')) renderSchedulesPage(root);
  else if (hash.startsWith('#/sessions')) renderSessionsPage(root);
  else void renderOverviewPage(root);

  // active nav highlighting
  for (const a of document.querySelectorAll<HTMLAnchorElement>('.sidebar-nav a')) {
    const href = a.getAttribute('href') ?? '#/';
    a.classList.toggle('active', href === (hash || '#/'));
  }
}

const statusEl = document.getElementById('status');
function paintStatus() {
  if (!statusEl) return;
  statusEl.textContent = store.online ? t('status.live') : t('status.disconnected');
  statusEl.className = 'connection-status ' + (store.online ? 'online' : 'offline');
}
store.on(paintStatus);

function paintChrome() {
  document.querySelectorAll<HTMLElement>('[data-i18n]').forEach(el => {
    el.textContent = t(el.dataset.i18n ?? '');
  });
  document.querySelectorAll<HTMLButtonElement>('[data-locale]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.locale === ui.locale);
  });
  document.querySelectorAll<HTMLButtonElement>('[data-theme-mode]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.themeMode === ui.themeMode);
  });
  paintStatus();
}

function wireChromeControls() {
  document.querySelectorAll<HTMLButtonElement>('[data-locale]').forEach(btn => {
    btn.onclick = () => ui.setLocale(btn.dataset.locale as DashboardLocale);
  });
  document.querySelectorAll<HTMLButtonElement>('[data-theme-mode]').forEach(btn => {
    btn.onclick = () => ui.setThemeMode(btn.dataset.themeMode as ThemeMode);
  });
}

// esbuild's IIFE bundle does not support top-level await — use an async IIFE.
void (async () => {
  ui.init();
  wireChromeControls();
  wireBotOnboardingButton();
  ui.on(() => {
    paintChrome();
    route();
  });
  paintChrome();
  try {
    await bootstrap();
  } catch (err) {
    console.error('botmux dashboard bootstrap failed', err);
    store.setOnline(false);
  }
  window.addEventListener('hashchange', route);
  route();
})();
