// Dashboard SPA entry: hash router + bootstrap + online indicator.
import { bootstrap, store } from './store.js';
import { renderSessionsPage } from './sessions.js';
import { renderSchedulesPage } from './schedules.js';
import { renderGroupsPage } from './groups.js';
import { renderBotDefaultsPage } from './bot-defaults.js';

const root = document.getElementById('root')!;

function route() {
  const hash = location.hash || '#/';
  if (hash.startsWith('#/groups')) renderGroupsPage(root);
  else if (hash.startsWith('#/bot-defaults')) renderBotDefaultsPage(root);
  else if (hash.startsWith('#/schedules')) renderSchedulesPage(root);
  else renderSessionsPage(root);

  // active nav highlighting
  for (const a of document.querySelectorAll<HTMLAnchorElement>('header nav a')) {
    a.classList.toggle(
      'active',
      a.getAttribute('href') === (hash || '#/') ||
        (hash === '#/' && a.dataset.route === 'sessions'),
    );
  }
}

const statusEl = document.getElementById('status');
function paintStatus() {
  if (!statusEl) return;
  statusEl.textContent = store.online ? '● live' : '● disconnected';
  statusEl.className = 'status ' + (store.online ? 'online' : 'offline');
}
store.on(paintStatus);
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
