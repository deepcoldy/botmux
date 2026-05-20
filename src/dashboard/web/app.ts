// Dashboard SPA entry: hash router + bootstrap + online indicator.
import { bootstrap, store } from './store.js';
import { renderSessionsPage } from './sessions.js';
import { renderSchedulesPage } from './schedules.js';
import { renderGroupsPage } from './groups.js';
import { renderBotDefaultsPage } from './bot-defaults.js';
import { renderWorkflowsPage } from './workflows.js';
import { renderWorkflowCatalogPage } from './workflow-catalog.js';
import { getLang, onLangChange, setLang, t, translateDom, type Lang } from './i18n.js';

const root = document.getElementById('root')!;
const langPicker = document.getElementById('lang-picker') as HTMLSelectElement | null;

// Pages that own a polling loop / cleanup return a disposer; we run it
// on the next route switch so timers don't leak across navigations.
let pageDispose: (() => void) | null = null;

function route() {
  if (pageDispose) { pageDispose(); pageDispose = null; }
  const hash = location.hash || '#/';
  if (hash.startsWith('#/workflows-catalog')) pageDispose = renderWorkflowCatalogPage(root);
  else if (hash.startsWith('#/workflows')) pageDispose = renderWorkflowsPage(root);
  else if (hash.startsWith('#/groups')) renderGroupsPage(root);
  else if (hash.startsWith('#/bot-defaults')) renderBotDefaultsPage(root);
  else if (hash.startsWith('#/schedules')) renderSchedulesPage(root);
  else renderSessionsPage(root);

  // active nav highlighting
  for (const a of document.querySelectorAll<HTMLAnchorElement>('header nav a')) {
    const href = a.getAttribute('href');
    a.classList.toggle(
      'active',
      href === (hash || '#/') ||
        (href && href !== '#/' && hash.startsWith(href + '/')) ||
        (hash === '#/' && a.dataset.route === 'sessions'),
    );
  }
}

const statusEl = document.getElementById('status');
function paintStatus() {
  if (!statusEl) return;
  statusEl.textContent = store.online ? t('status.live') : t('status.offline');
  statusEl.className = 'status ' + (store.online ? 'online' : 'offline');
}
store.on(paintStatus);
translateDom();
if (langPicker) {
  langPicker.value = getLang();
  langPicker.addEventListener('change', () => setLang(langPicker.value as Lang));
}
onLangChange(() => {
  translateDom();
  if (langPicker) langPicker.value = getLang();
  paintStatus();
  route();
});
paintStatus();

// esbuild's IIFE bundle does not support top-level await — use an async IIFE.
void (async () => {
  try {
    await bootstrap();
  } catch (err) {
    console.error('botmux dashboard bootstrap failed', err);
    store.setOnline(false);
  }
  window.addEventListener('hashchange', route);
  route();
})();
