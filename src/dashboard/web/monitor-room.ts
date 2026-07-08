import {
  clearMonitorRoomSessionIds,
  readMonitorRoomSessionIds,
  removeMonitorRoomSessionId,
} from './monitor-room-store.js';
import { sessionTerminalHref } from './session-terminal.js';
import { store } from './store.js';
import { botAvatarHtml, botDisplayName, escapeHtml, loadNameMaps, relTime, stripMentionPrefix, t } from './ui.js';

function statusText(status: unknown): string {
  const raw = String(status ?? 'unknown');
  const key = `sessions.status.${raw}`;
  const label = t(key);
  return label === key ? raw : label;
}

function cssToken(value: unknown): string {
  return String(value ?? 'unknown').toLowerCase().replace(/[^a-z0-9_-]/g, '-');
}

function statusBadgeHtml(status: unknown): string {
  const raw = String(status ?? 'unknown');
  return `<span class="status status-${escapeHtml(cssToken(raw))}">${escapeHtml(statusText(raw))}</span>`;
}

function cardTitle(s: any): string {
  return stripMentionPrefix(s?.title) || String(s?.sessionId ?? '');
}

export function monitorRoomFrameGeometry(
  viewport: { width: number; height: number },
  frame: { width: number; height: number },
): { width: number; height: number; scale: number } {
  const width = Math.max(1, Math.floor(viewport.width));
  const height = Math.max(1, Math.floor(viewport.height));
  const frameWidth = Math.max(1, frame.width);
  const frameHeight = Math.max(1, frame.height);
  const scale = Math.min(1, frameWidth / width, frameHeight / height);
  return { width, height, scale };
}

function syncMonitorRoomFrameScales(root: HTMLElement): void {
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  root.querySelectorAll<HTMLElement>('.monitor-room-frame-wrap').forEach(wrap => {
    const frame = wrap.querySelector<HTMLIFrameElement>('.monitor-room-frame');
    if (!frame) return;
    const rect = wrap.getBoundingClientRect();
    const g = monitorRoomFrameGeometry(viewport, { width: rect.width, height: rect.height });
    frame.style.width = `${g.width}px`;
    frame.style.height = `${g.height}px`;
    frame.style.transform = `scale(${g.scale})`;
  });
}

function sessionPanelHtml(sessionId: string): string {
  const s = store.sessions.get(sessionId);
  if (!s) {
    return `<article class="monitor-room-card monitor-room-card-empty" data-id="${escapeHtml(sessionId)}">
      <header class="monitor-room-card-head">
        <div class="monitor-room-card-title">
          <strong>${escapeHtml(sessionId)}</strong>
          <span>${escapeHtml(t('monitorRoom.missing'))}</span>
        </div>
        <button type="button" class="card-act" data-remove="${escapeHtml(sessionId)}" title="${escapeHtml(t('monitorRoom.remove'))}" aria-label="${escapeHtml(t('monitorRoom.remove'))}">×</button>
      </header>
      <div class="monitor-room-placeholder">${escapeHtml(t('monitorRoom.missingHelp'))}</div>
    </article>`;
  }
  const title = cardTitle(s);
  const url = sessionTerminalHref(s);
  const botName = botDisplayName(s);
  const singleOpen = url
    ? `<a class="card-act" href="${escapeHtml(url)}" target="_blank" rel="noopener" title="${escapeHtml(t('monitorRoom.openTerminal'))}" aria-label="${escapeHtml(t('monitorRoom.openTerminal'))}">↗</a>`
    : '';
  const body = url
    ? `<iframe class="monitor-room-frame" src="${escapeHtml(url)}" allow="clipboard-read; clipboard-write"></iframe>`
    : `<div class="monitor-room-placeholder">
        <b>${escapeHtml(t('monitorRoom.terminalUnavailable'))}</b>
        <span>${escapeHtml(t('monitorRoom.terminalUnavailableHelp'))}</span>
      </div>`;
  return `<article class="monitor-room-card" data-id="${escapeHtml(sessionId)}">
    <header class="monitor-room-card-head">
      <div class="monitor-room-card-title">
        ${botAvatarHtml({ name: botName, larkAppId: s.larkAppId, size: 'sm' })}
        <span class="monitor-room-card-meta">
          <strong title="${escapeHtml(String(s.title ?? title))}">${escapeHtml(title)}</strong>
          <small>${escapeHtml(botName)} · ${statusBadgeHtml(s.status)} · ${escapeHtml(t('monitorRoom.updated', { time: relTime(s.lastMessageAt) }))}</small>
        </span>
      </div>
      <div class="monitor-room-card-actions">
        ${singleOpen}
        <button type="button" class="card-act" data-remove="${escapeHtml(sessionId)}" title="${escapeHtml(t('monitorRoom.remove'))}" aria-label="${escapeHtml(t('monitorRoom.remove'))}">×</button>
      </div>
    </header>
    <div class="monitor-room-frame-wrap">${body}</div>
  </article>`;
}

function pageHtml(): string {
  return `<section class="page monitor-room-page">
    <div class="page-heading">
      <div>
        <p class="eyebrow">${escapeHtml(t('monitorRoom.eyebrow'))}</p>
        <h1>${escapeHtml(t('monitorRoom.title'))}</h1>
        <p>${escapeHtml(t('monitorRoom.subtitle'))}</p>
      </div>
      <div class="monitor-room-actions">
        <a class="btn-link" href="#/sessions">${escapeHtml(t('monitorRoom.backToSessions'))}</a>
        <button type="button" id="monitor-room-clear" class="contrast">${escapeHtml(t('monitorRoom.clear'))}</button>
      </div>
    </div>
    <div id="monitor-room-summary" class="monitor-room-summary"></div>
    <div id="monitor-room-grid" class="monitor-room-grid"></div>
  </section>`;
}

export function renderMonitorRoomPage(root: HTMLElement): () => void {
  root.innerHTML = pageHtml();
  const grid = root.querySelector<HTMLElement>('#monitor-room-grid')!;
  const summary = root.querySelector<HTMLElement>('#monitor-room-summary')!;
  const clearBtn = root.querySelector<HTMLButtonElement>('#monitor-room-clear')!;

  function render(): void {
    const ids = readMonitorRoomSessionIds();
    const liveCount = ids.filter(id => !!sessionTerminalHref(store.sessions.get(id))).length;
    summary.textContent = ids.length
      ? t('monitorRoom.summary', { count: ids.length, live: liveCount })
      : t('monitorRoom.emptySummary');
    clearBtn.disabled = ids.length === 0;
    grid.dataset.count = String(ids.length);
    grid.innerHTML = ids.length
      ? ids.map(sessionPanelHtml).join('')
      : `<div class="monitor-room-empty">
          <h2>${escapeHtml(t('monitorRoom.emptyTitle'))}</h2>
          <p>${escapeHtml(t('monitorRoom.emptyHelp'))}</p>
          <a class="btn-link" href="#/sessions">${escapeHtml(t('monitorRoom.openSessions'))}</a>
        </div>`;
    syncMonitorRoomFrameScales(root);
  }

  grid.addEventListener('click', e => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-remove]');
    if (!btn?.dataset.remove) return;
    removeMonitorRoomSessionId(btn.dataset.remove);
    render();
  });

  clearBtn.addEventListener('click', () => {
    if (!confirm(t('monitorRoom.clearConfirm'))) return;
    clearMonitorRoomSessionIds();
    render();
  });

  const unsubscribe = store.on(render);
  const resize = () => syncMonitorRoomFrameScales(root);
  window.addEventListener('resize', resize);
  render();
  void loadNameMaps().then(render);
  return () => {
    window.removeEventListener('resize', resize);
    unsubscribe();
  };
}
