import {
  clearMonitorRoomSessionIds,
  readMonitorRoomAutoActive,
  readMonitorRoomSessionIds,
  removeMonitorRoomSessionId,
  writeMonitorRoomAutoActive,
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

const MONITOR_ROOM_GRID_GAP = 14;
const MONITOR_ROOM_CARD_HEADER_HEIGHT = 49;
const MONITOR_ROOM_GRID_BOTTOM_GUTTER = 18;

function activeSessionIds(): string[] {
  const sessions = [...store.sessions.values()]
    .filter(s => typeof s?.sessionId === 'string' && s.sessionId && s.status !== 'closed')
    .sort((a, b) => Number(b.lastMessageAt ?? 0) - Number(a.lastMessageAt ?? 0));
  return [...new Set(sessions.map(s => String(s.sessionId)))];
}

export function monitorRoomGridGeometry(
  viewport: { width: number; height: number },
  grid: { width: number; top: number },
  count: number,
): { columns: number; rows: number; frameWidth: number; frameHeight: number; ratio: number } {
  const safeCount = Math.max(0, Math.floor(count));
  const viewportWidth = Math.max(1, viewport.width);
  const viewportHeight = Math.max(1, viewport.height);
  const ratio = viewportWidth / viewportHeight;
  const gridWidth = Math.max(1, grid.width);
  const availableHeight = Math.max(
    180,
    viewportHeight - Math.max(0, grid.top) - MONITOR_ROOM_GRID_BOTTOM_GUTTER,
  );
  if (safeCount <= 0) {
    return {
      columns: 1,
      rows: 0,
      frameWidth: Math.floor(gridWidth),
      frameHeight: Math.floor(gridWidth / ratio),
      ratio,
    };
  }

  let best: { columns: number; rows: number; frameWidth: number; frameHeight: number; score: number } | null = null;
  for (let columns = 1; columns <= safeCount; columns += 1) {
    const rows = Math.ceil(safeCount / columns);
    const maxFrameWidth = (gridWidth - MONITOR_ROOM_GRID_GAP * (columns - 1)) / columns;
    const maxFrameHeight = (availableHeight - MONITOR_ROOM_GRID_GAP * (rows - 1) - MONITOR_ROOM_CARD_HEADER_HEIGHT * rows) / rows;
    if (maxFrameWidth <= 0 || maxFrameHeight <= 0) continue;
    const frameWidth = Math.max(1, Math.min(maxFrameWidth, maxFrameHeight * ratio));
    const frameHeight = frameWidth / ratio;
    const score = frameWidth * frameHeight;
    if (!best || score > best.score) {
      best = { columns, rows, frameWidth, frameHeight, score };
    }
  }

  if (!best) {
    const columns = Math.min(safeCount, Math.max(1, Math.floor(gridWidth / 220)));
    const rows = Math.ceil(safeCount / columns);
    const frameWidth = Math.max(1, (gridWidth - MONITOR_ROOM_GRID_GAP * (columns - 1)) / columns);
    return { columns, rows, frameWidth: Math.floor(frameWidth), frameHeight: Math.floor(frameWidth / ratio), ratio };
  }
  return {
    columns: best.columns,
    rows: best.rows,
    frameWidth: Math.floor(best.frameWidth),
    frameHeight: Math.floor(best.frameHeight),
    ratio,
  };
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

function syncMonitorRoomFrameScales(root: HTMLElement, grid: HTMLElement): void {
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  const gridRect = grid.getBoundingClientRect();
  const count = Number(grid.dataset.count || '0');
  const layout = monitorRoomGridGeometry(viewport, { width: gridRect.width, top: gridRect.top }, count);
  root.style.setProperty('--monitor-room-viewport-ratio', `${viewport.width} / ${viewport.height}`);
  if (count > 0) {
    grid.style.gridTemplateColumns = `repeat(${layout.columns}, minmax(0, ${layout.frameWidth}px))`;
  } else {
    grid.style.gridTemplateColumns = '';
  }
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

function removeButtonHtml(sessionId: string): string {
  return `<button type="button" class="card-act" data-remove="${escapeHtml(sessionId)}" title="${escapeHtml(t('monitorRoom.remove'))}" aria-label="${escapeHtml(t('monitorRoom.remove'))}">×</button>`;
}

function popoverButtonHtml(sessionId: string): string {
  return `<button type="button" class="card-act" data-popout="${escapeHtml(sessionId)}" title="${escapeHtml(t('monitorRoom.openTerminal'))}" aria-label="${escapeHtml(t('monitorRoom.openTerminal'))}">↗</button>`;
}

function sessionPanelHtml(sessionId: string, options: { removable: boolean }): string {
  const s = store.sessions.get(sessionId);
  const removeButton = options.removable ? removeButtonHtml(sessionId) : '';
  if (!s) {
    return `<article class="monitor-room-card monitor-room-card-empty" data-id="${escapeHtml(sessionId)}">
      <header class="monitor-room-card-head">
        <div class="monitor-room-card-title">
          <strong>${escapeHtml(sessionId)}</strong>
          <span>${escapeHtml(t('monitorRoom.missing'))}</span>
        </div>
        ${removeButton}
      </header>
      <div class="monitor-room-placeholder">${escapeHtml(t('monitorRoom.missingHelp'))}</div>
    </article>`;
  }
  const title = cardTitle(s);
  const url = sessionTerminalHref(s);
  const botName = botDisplayName(s);
  const singleOpen = url ? popoverButtonHtml(sessionId) : '';
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
        ${removeButton}
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
        <label class="monitor-room-toggle" title="${escapeHtml(t('monitorRoom.autoActiveHelp'))}">
          <input type="checkbox" id="monitor-room-auto-active">
          <span>${escapeHtml(t('monitorRoom.autoActive'))}</span>
        </label>
        <a class="btn-link" href="#/sessions">${escapeHtml(t('monitorRoom.backToSessions'))}</a>
        <button type="button" id="monitor-room-clear" class="contrast">${escapeHtml(t('monitorRoom.clear'))}</button>
      </div>
    </div>
    <div id="monitor-room-summary" class="monitor-room-summary"></div>
    <div id="monitor-room-grid" class="monitor-room-grid"></div>
  </section>`;
}

function popoverHtml(sessionId: string, url: string): string {
  const s = store.sessions.get(sessionId);
  const title = s ? cardTitle(s) : sessionId;
  const botName = s ? botDisplayName(s) : '';
  return `<div class="monitor-room-popover-backdrop">
    <section class="monitor-room-popover" role="dialog" tabindex="-1" aria-label="${escapeHtml(t('monitorRoom.openTerminal'))}">
      <header class="monitor-room-popover-head">
        <div class="monitor-room-card-title">
          ${s ? botAvatarHtml({ name: botName, larkAppId: s.larkAppId, size: 'sm' }) : ''}
          <span class="monitor-room-card-meta">
            <strong title="${escapeHtml(title)}">${escapeHtml(title)}</strong>
            <small>${escapeHtml(botName || sessionId)}</small>
          </span>
        </div>
        <button type="button" class="card-act" data-popover-close title="${escapeHtml(t('monitorRoom.closePopover'))}" aria-label="${escapeHtml(t('monitorRoom.closePopover'))}">×</button>
      </header>
      <iframe class="monitor-room-popover-frame" src="${escapeHtml(url)}" allow="clipboard-read; clipboard-write"></iframe>
    </section>
  </div>`;
}

export function renderMonitorRoomPage(root: HTMLElement): () => void {
  root.innerHTML = pageHtml();
  const grid = root.querySelector<HTMLElement>('#monitor-room-grid')!;
  const summary = root.querySelector<HTMLElement>('#monitor-room-summary')!;
  const clearBtn = root.querySelector<HTMLButtonElement>('#monitor-room-clear')!;
  const autoActiveInput = root.querySelector<HTMLInputElement>('#monitor-room-auto-active')!;
  let closePopover: (() => void) | null = null;

  function openTerminalPopover(sessionId: string): void {
    const url = sessionTerminalHref(store.sessions.get(sessionId));
    if (!url) return;
    closePopover?.();
    root.insertAdjacentHTML('beforeend', popoverHtml(sessionId, url));
    const backdrop = root.querySelector<HTMLElement>('.monitor-room-popover-backdrop')!;
    const panel = backdrop.querySelector<HTMLElement>('.monitor-room-popover')!;
    const closeButton = backdrop.querySelector<HTMLButtonElement>('[data-popover-close]')!;

    let closing = false;
    const close = () => {
      if (closing) return;
      closing = true;
      window.removeEventListener('keydown', onKeyDown);
      backdrop.removeEventListener('pointerdown', onPointerDown);
      backdrop.removeEventListener('focusout', onFocusOut);
      closeButton.removeEventListener('click', close);
      backdrop.remove();
      if (closePopover === close) closePopover = null;
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      close();
    };
    const onPointerDown = (event: PointerEvent) => {
      if (panel.contains(event.target as Node)) return;
      close();
    };
    const onFocusOut = () => {
      window.setTimeout(() => {
        const active = document.activeElement;
        if (!active || !backdrop.contains(active)) close();
      }, 0);
    };

    closePopover = close;
    window.addEventListener('keydown', onKeyDown);
    backdrop.addEventListener('pointerdown', onPointerDown);
    backdrop.addEventListener('focusout', onFocusOut);
    closeButton.addEventListener('click', close);
    panel.focus();
  }

  function render(): void {
    const manualIds = readMonitorRoomSessionIds();
    const autoActive = readMonitorRoomAutoActive();
    const usingAutoActive = manualIds.length === 0 && autoActive;
    const ids = usingAutoActive ? activeSessionIds() : manualIds;
    const liveCount = ids.filter(id => !!sessionTerminalHref(store.sessions.get(id))).length;
    autoActiveInput.checked = autoActive;
    summary.textContent = usingAutoActive && ids.length
      ? t('monitorRoom.autoSummary', { count: ids.length, live: liveCount })
      : ids.length
      ? t('monitorRoom.summary', { count: ids.length, live: liveCount })
      : t('monitorRoom.emptySummary');
    clearBtn.disabled = manualIds.length === 0;
    grid.dataset.count = String(ids.length);
    grid.innerHTML = ids.length
      ? ids.map(id => sessionPanelHtml(id, { removable: !usingAutoActive })).join('')
      : `<div class="monitor-room-empty">
          <h2>${escapeHtml(t(usingAutoActive ? 'monitorRoom.autoEmptyTitle' : 'monitorRoom.emptyTitle'))}</h2>
          <p>${escapeHtml(t(usingAutoActive ? 'monitorRoom.autoEmptyHelp' : 'monitorRoom.emptyHelp'))}</p>
          <a class="btn-link" href="#/sessions">${escapeHtml(t('monitorRoom.openSessions'))}</a>
        </div>`;
    syncMonitorRoomFrameScales(root, grid);
  }

  grid.addEventListener('click', e => {
    const popout = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-popout]');
    if (popout?.dataset.popout) {
      openTerminalPopover(popout.dataset.popout);
      return;
    }
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

  autoActiveInput.addEventListener('change', () => {
    writeMonitorRoomAutoActive(autoActiveInput.checked);
    render();
  });

  const unsubscribe = store.on(render);
  const resize = () => syncMonitorRoomFrameScales(root, grid);
  window.addEventListener('resize', resize);
  render();
  void loadNameMaps().then(render);
  return () => {
    closePopover?.();
    window.removeEventListener('resize', resize);
    unsubscribe();
  };
}
