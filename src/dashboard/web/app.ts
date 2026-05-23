// Dashboard SPA entry: hash router + bootstrap + online indicator.
import { bootstrap, store } from './store.js';
import { renderOverviewPage } from './overview.js';
import { renderSessionsPage } from './sessions.js';
import { renderSchedulesPage } from './schedules.js';
import { renderGroupsPage } from './groups.js';
import { renderBotDefaultsPage } from './bot-defaults.js';
import { renderRolesPage } from './roles.js';
import { renderWorkflowsPage } from './workflows.js';
import { renderWorkflowCatalogPage } from './workflow-catalog.js';
import { wireBotOnboardingButton } from './bot-onboarding.js';
import { t, ui } from './ui.js';
import type { DashboardLocale } from './i18n.js';
import type { ThemeMode } from './preferences.js';

const root = document.getElementById('root')!;

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
