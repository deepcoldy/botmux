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
import { renderSettingsPage } from './settings.js';
import { renderWorkflowsPage } from './workflows.js';
import { renderWorkflowCatalogPage } from './workflow-catalog.js';
import { renderOfficePage } from './office.js';
import { wireBotOnboardingButton } from './bot-onboarding.js';
import { attentionReason, attentionWaitSince, botDisplayName, escapeHtml, loadNameMaps, relTime, t, ui } from './ui.js';
import { initThemeMenu, paintThemeMenu } from './theme-menu.js';
import { normalizeDashboardLocale, type DashboardLocale } from './i18n.js';
import { readStoredSidebarMode, writeStoredSidebarMode, type SidebarMode } from './preferences.js';

const root = document.getElementById('root')!;

// Resolved once at bootstrap from GET /api/settings:
//   - `isAuthed`        → gates the management nav + route guards
//   - `publicReadOnly`  → decides whether a read 401 is a hard lockout (token
//                          rotated → blocking overlay) or just a read-only
//                          visitor touching a token-gated page (soft toast).
// Defaults keep the authed / legacy UX if the probe fails.
let isAuthed = true;
let publicReadOnly = false;

// Management pages are token-gated end-to-end (no public GET) — a read-only
// visitor must not reach them. `data-route` values from index.html's nav.
const MANAGE_ROUTES = ['roles', 'bot-defaults', 'team', 'connectors'];

// ── Auth-expiry overlay ──────────────────────────────────────────────────────
// Shown only when the dashboard token was rotated WHILE public read-only is off
// (a real hard lockout). Under public read-only a 401 is a soft toast instead
// (see patchedFetch) — so this no longer fires for read-only visitors.
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
    '<div style="background:var(--surface);color:var(--fg);border:1px solid var(--border);border-radius:12px;' +
    'padding:36px 40px;max-width:460px;width:90vw;text-align:center;' +
    'box-shadow:0 12px 40px rgba(0,0,0,.35)">' +
    '<h2 style="margin:0 0 14px;font-size:19px;color:var(--fg)">访问链接已失效</h2>' +
    '<p style="margin:0 0 24px;line-height:1.7;color:var(--muted,#8f959e);font-size:14px">' +
    '当前链接/访问已失效，请使用最新授权链接重新进入（运行 botmux dashboard 获取）。</p>' +
    '<button id="auth-expired-dismiss" type="button" ' +
    'style="padding:8px 22px;background:var(--accent);color:var(--on-accent);border:none;' +
    'border-radius:8px;cursor:pointer;font-size:14px">知道了</button>' +
    '</div>';
  document.body.appendChild(el);
  // `window.close()` can't close a tab the user opened, so the old inline
  // onclick was a dead button (overlay got stuck). Dismiss the overlay instead,
  // and let it reappear on the next genuine 401.
  const dismiss = () => { el.remove(); _expiredShown = false; };
  el.querySelector<HTMLButtonElement>('#auth-expired-dismiss')?.addEventListener('click', dismiss);
  el.addEventListener('click', (e) => { if (e.target === el) dismiss(); });
}

// ── Read-only toast (write attempt without a valid token) ───────────────────
// In public read-only mode browsing GETs never 401, but a write action
// (close session, cancel run, …) without the active token does. That's not
// "your link died" — it's "you're a read-only visitor", so show a transient
// toast instead of the blocking overlay.
let _roToastTimer: number | undefined;
export function showReadOnlyToast(): void {
  let el = document.getElementById('readonly-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'readonly-toast';
    el.style.cssText =
      'position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:9999;' +
      'background:var(--fg,#1f2329);color:var(--bg,#fff);padding:10px 18px;' +
      'border-radius:8px;font-size:13px;box-shadow:0 8px 24px rgba(0,0,0,.25)';
    document.body.appendChild(el);
  }
  el.textContent = '当前是只读访问，此操作需要授权链接（运行 botmux dashboard 获取）';
  el.style.display = 'block';
  if (_roToastTimer) window.clearTimeout(_roToastTimer);
  _roToastTimer = window.setTimeout(() => { el!.style.display = 'none'; }, 4000);
}

// Patch the global fetch to route 401s: a read (GET/HEAD) 401 means the token
// was rotated while this tab was open (only possible when public read-only
// mode is off) → blocking overlay; a write 401 means "read-only visitor" →
// transient toast.
const _origFetch = window.fetch.bind(window);
window.fetch = async function patchedFetch(
  ...args: Parameters<typeof fetch>
): ReturnType<typeof fetch> {
  const res = await _origFetch(...args);
  if (res.status === 401) {
    const method = (args[1]?.method ?? 'GET').toUpperCase();
    const isRead = method === 'GET' || method === 'HEAD';
    // A read 401 is a hard lockout (token rotated → blocking overlay) ONLY when
    // public read-only is off. Under public read-only a read 401 just means a
    // tokenless visitor touched a token-gated page → soft toast, never the
    // stuck overlay. Writes are always a soft "needs the active token".
    if (isRead && !publicReadOnly) showAuthExpiredOverlay();
    else showReadOnlyToast();
  }
  return res;
};

// ── 全局 attention strip ─────────────────────────────────────────────────────
// 「需要你」是全局最高优先级：不管在哪个页面，待处理数和最久等待项都常驻
// 顶部一条琥珀色 strip，点「立即处理」跳到会话页（needs-you 列置顶）。
let lastStripHtml = '';
function paintAttentionStrip(): void {
  const el = document.getElementById('attention-strip');
  if (!el) return;
  const pending = [...store.sessions.values()]
    .map(s => ({ s, reason: attentionReason(s) }))
    .filter((x): x is { s: any; reason: string } => !!x.reason)
    .sort((a, b) => attentionWaitSince(a.s) - attentionWaitSince(b.s));
  if (pending.length === 0) {
    el.hidden = true;
    el.innerHTML = '';
    lastStripHtml = '';
    return;
  }
  const longest = pending[0];
  const html = `
    <span class="attention-strip-ic" aria-hidden="true">!</span>
    <b>${escapeHtml(t('strip.pending', { count: pending.length }))}</b>
    <span class="attention-strip-longest">${escapeHtml(t('strip.longest', {
      time: relTime(attentionWaitSince(longest.s)),
      bot: botDisplayName(longest.s),
      reason: longest.reason,
    }))}</span>
    <a class="attention-strip-go" href="#/sessions">${escapeHtml(t('strip.handle'))}</a>`;
  el.hidden = false;
  // 内容没变就不重写 — innerHTML 重建会把 strip-pulse 动画打回起点（视觉跳变）
  if (html === lastStripHtml) return;
  lastStripHtml = html;
  el.innerHTML = html;
}
store.on(paintAttentionStrip);
// bot 友好名异步解析回来后刷一次 strip（页面级重绘由各 mount 自己处理）
void loadNameMaps().then(paintAttentionStrip);

// Resolve the read-only/authed state from /api/settings (authed reflects the
// cookie; publicReadOnly is the global toggle). Errors keep the authed default
// so a transient probe failure never hides nav from a real token holder.
async function loadAuthState(): Promise<void> {
  try {
    const r = await fetch('/api/settings');
    if (r.ok) {
      const j = await r.json();
      isAuthed = !!j.authed;
      // Share the cookie-auth verdict with per-row renderers (the sessions
      // board's writable-terminal segment reads ui.authed at render time).
      ui.authed = isAuthed;
      publicReadOnly = !!(j.settings && j.settings.publicReadOnly);
      // The global UI locale (`botmux lang`) is the single source of truth: when
      // set, it wins over the browser-detected / locally-stored locale so the
      // dashboard always reflects the same language as the Feishu cards. When
      // unset (null), keep the browser/local default ui.init() already picked.
      const serverLocale = normalizeDashboardLocale(j.lang);
      if (serverLocale) ui.setLocale(serverLocale);
    }
  } catch { /* keep defaults */ }
}

// Persist a language choice back to the global config so it drives `botmux lang`
// and the Feishu cards too (the server fans the change out to every daemon
// live). Authed-only — read-only visitors just change their local view, which
// the server-authoritative locale overrides on their next load.
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

// Read-only visitors can't use the management pages (all token-gated), so hide
// their nav entries + the add-bot action instead of luring them into a 401.
function applyAuthVisibility(): void {
  for (const r of MANAGE_ROUTES) {
    const a = document.querySelector<HTMLElement>(`.sidebar-nav a[data-route="${r}"]`);
    if (a) a.style.display = isAuthed ? '' : 'none';
  }
  const addBot = document.getElementById('add-bot-btn');
  if (addBot) addBot.style.display = isAuthed ? '' : 'none';
}

function renderAuthRequiredPage(host: HTMLElement): void {
  host.innerHTML =
    '<section class="auth-required" style="max-width:520px;margin:64px auto;text-align:center;' +
    'background:var(--surface);color:var(--fg);border:1px solid var(--border);border-radius:14px;' +
    'padding:40px 36px;box-shadow:0 8px 28px rgba(0,0,0,.12)">' +
    '<h2 style="margin:0 0 12px;font-size:20px;color:var(--fg)">此页需要授权链接</h2>' +
    '<p style="margin:0 0 24px;line-height:1.7;color:var(--muted);font-size:14px">' +
    '你当前是只读访问，管理页（角色 / Bot 配置 / 团队 / Webhook）需要授权链接。' +
    '运行 <code>botmux dashboard</code> 获取最新链接后即可管理。</p>' +
    '<a href="#/" style="display:inline-block;padding:8px 22px;background:var(--accent);' +
    'color:var(--on-accent);border-radius:8px;text-decoration:none;font-size:14px">返回总览</a>' +
    '</section>';
}

// Pages that own a polling loop / cleanup return a disposer; we run it
// on the next route switch so timers don't leak across navigations.
let pageDispose: (() => void) | null = null;

function highlightNav(hash: string): void {
  for (const a of document.querySelectorAll<HTMLAnchorElement>('.sidebar-nav a')) {
    const href = a.getAttribute('href') ?? '#/';
    a.classList.toggle('active', href === (hash || '#/'));
  }
}

function route() {
  if (pageDispose) { pageDispose(); pageDispose = null; }
  const hash = location.hash || '#/';

  // Read-only hard-guard: a tokenless visitor hitting a management route gets a
  // friendly notice instead of a page that fires a 401 (which used to pop a
  // stuck "link expired" overlay).
  if (!isAuthed && MANAGE_ROUTES.some(r => hash.startsWith('#/' + r))) {
    renderAuthRequiredPage(root);
    highlightNav(hash);
    return;
  }
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
  else if (hash.startsWith('#/settings')) void renderSettingsPage(root);
  else if (hash.startsWith('#/bot-defaults')) renderBotDefaultsPage(root);
  else if (hash.startsWith('#/connectors')) renderConnectorsPage(root);
  else if (hash.startsWith('#/team/manage')) renderTeamManagePage(root);
  else if (hash.startsWith('#/team')) renderTeamFederationPage(root);
  else if (hash.startsWith('#/roles')) renderRolesPage(root);
  else if (hash.startsWith('#/schedules')) renderSchedulesPage(root);
  else if (hash.startsWith('#/sessions')) renderSessionsPage(root);
  else if (hash.startsWith('#/office')) pageDispose = renderOfficePage(root) ?? null;
  else void renderOverviewPage(root);

  highlightNav(hash);
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
  paintThemeMenu();
  paintStatus();
}

function wireChromeControls() {
  document.querySelectorAll<HTMLButtonElement>('[data-locale]').forEach(btn => {
    btn.onclick = () => {
      const locale = btn.dataset.locale as DashboardLocale;
      ui.setLocale(locale);
      void persistLocale(locale);
    };
  });
  initThemeMenu();
  wireSidebarToggle();
}

// 左上角 brand 显示部署 owner（「我」）的飞书头像：localStorage 缓存先出图
// 防闪烁，再后台刷新；拿不到（未绑定 owner / 只读访客 401）保持渐变球。
const OWNER_AVATAR_KEY = 'botmux.ownerAvatar.v1';

function paintOwnerAvatar(avatarUrl: string, name?: string): void {
  const mark = document.querySelector<HTMLElement>('.brand-mark');
  if (!mark || !avatarUrl) return;
  mark.innerHTML = `<img class="brand-owner-img" src="${escapeHtml(avatarUrl)}" alt="" decoding="async" referrerpolicy="no-referrer" onerror="this.remove()">`;
  if (name) mark.title = name;
}

function initOwnerAvatar(): void {
  try {
    const cached = JSON.parse(window.localStorage.getItem(OWNER_AVATAR_KEY) ?? 'null');
    if (cached?.avatarUrl) paintOwnerAvatar(String(cached.avatarUrl), cached.name ? String(cached.name) : undefined);
  } catch { /* 缓存损坏忽略 */ }
  void fetch('/api/owner-profile')
    .then(r => (r.ok ? r.json() : null))
    .then(body => {
      if (!body?.ok || !body.avatarUrl) return;
      paintOwnerAvatar(String(body.avatarUrl), body.name ? String(body.name) : undefined);
      try { window.localStorage.setItem(OWNER_AVATAR_KEY, JSON.stringify({ avatarUrl: body.avatarUrl, name: body.name ?? '' })); } catch { /* 忽略 */ }
    })
    .catch(() => { /* 只读访客/离线：保持渐变球 */ });
}

// 左侧菜单栏收起/展开：状态挂在 <html data-sidebar>，CSS 收窄成图标栏；
// 偏好进 localStorage，刷新/换页保持。
function wireSidebarToggle() {
  const btn = document.getElementById('sidebar-toggle');
  if (!btn) return;
  let mode: SidebarMode = readStoredSidebarMode(window.localStorage);
  const apply = () => {
    document.documentElement.dataset.sidebar = mode;
    btn.title = t(mode === 'collapsed' ? 'nav.sidebarExpand' : 'nav.sidebarCollapse');
  };
  apply();
  btn.addEventListener('click', () => {
    mode = mode === 'collapsed' ? 'expanded' : 'collapsed';
    writeStoredSidebarMode(window.localStorage, mode);
    apply();
  });
}

// esbuild's IIFE bundle does not support top-level await — use an async IIFE.
void (async () => {
  ui.init();
  wireChromeControls();
  wireBotOnboardingButton();
  ui.on(() => {
    paintChrome();
    paintAttentionStrip();
    route();
  });
  paintChrome();
  paintAttentionStrip();
  // Resolve authed/publicReadOnly BEFORE first render so the management nav is
  // hidden and route guards are active for read-only visitors from frame one.
  await loadAuthState();
  applyAuthVisibility();
  initOwnerAvatar();
  try {
    await bootstrap();
  } catch (err) {
    console.error('botmux dashboard bootstrap failed', err);
    store.setOnline(false);
  }
  window.addEventListener('hashchange', route);
  route();
})();
