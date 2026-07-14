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

interface MonitorCardEntry {
  article: HTMLElement;
  head: HTMLElement;
  frameWrap: HTMLElement;
  bodyKey: string;
}

export function monitorRoomPanelBodyKey(
  session: any | null | undefined,
  loc?: { protocol: string; origin: string; hostname: string } | null,
): string {
  if (!session) return 'missing';
  // Pass `loc` straight through: when the caller omits it (the production
  // render() path calls this with no loc), sessionTerminalHref falls back to
  // the live window.location default. Coercing undefined → null here would
  // defeat that default and pin the key to a constant `frame:none`, so the
  // iframe would never rebuild when a session's terminal URL appears or changes
  // (e.g. proxyPort comes up on the HTTPS dashboard) — the panel would stay
  // stuck on the "terminal unavailable" placeholder until a full page reload.
  const url = sessionTerminalHref(session, loc);
  return `frame:${url ?? 'none'}`;
}

function cardHeadHtml(sessionId: string, removable: boolean): string {
  const s = store.sessions.get(sessionId);
  const removeButton = removable ? removeButtonHtml(sessionId) : '';
  if (!s) {
    return `<div class="monitor-room-card-title">
      <strong>${escapeHtml(sessionId)}</strong>
      <span>${escapeHtml(t('monitorRoom.missing'))}</span>
    </div>${removeButton}`;
  }
  const title = cardTitle(s);
  const url = sessionTerminalHref(s);
  const botName = botDisplayName(s);
  const singleOpen = url ? popoverButtonHtml(sessionId) : '';
  return `<div class="monitor-room-card-title">
    ${botAvatarHtml({ name: botName, larkAppId: s.larkAppId, size: 'sm' })}
    <span class="monitor-room-card-meta">
      <strong title="${escapeHtml(String(s.title ?? title))}">${escapeHtml(title)}</strong>
      <small>${escapeHtml(botName)} · ${statusBadgeHtml(s.status)} · ${escapeHtml(t('monitorRoom.updated', { time: relTime(s.lastMessageAt) }))}</small>
    </span>
  </div>
  <div class="monitor-room-card-actions">
    ${singleOpen}
    ${removeButton}
  </div>`;
}

function cardFrameHtml(sessionId: string): string {
  const s = store.sessions.get(sessionId);
  if (!s) {
    return `<div class="monitor-room-placeholder">${escapeHtml(t('monitorRoom.missingHelp'))}</div>`;
  }
  const url = sessionTerminalHref(s);
  return url
    ? `<iframe class="monitor-room-frame" src="${escapeHtml(url)}" allow="clipboard-read; clipboard-write"></iframe>`
    : `<div class="monitor-room-placeholder">
        <b>${escapeHtml(t('monitorRoom.terminalUnavailable'))}</b>
        <span>${escapeHtml(t('monitorRoom.terminalUnavailableHelp'))}</span>
      </div>`;
}

function ensureCardEntry(
  entries: Map<string, MonitorCardEntry>,
  grid: HTMLElement,
  sessionId: string,
): MonitorCardEntry {
  const existing = entries.get(sessionId);
  if (existing) return existing;
  const article = document.createElement('article');
  article.className = 'monitor-room-card';
  article.dataset.id = sessionId;
  const head = document.createElement('header');
  head.className = 'monitor-room-card-head';
  const frameWrap = document.createElement('div');
  frameWrap.className = 'monitor-room-frame-wrap';
  article.appendChild(head);
  article.appendChild(frameWrap);
  grid.appendChild(article);
  const entry: MonitorCardEntry = { article, head, frameWrap, bodyKey: '' };
  entries.set(sessionId, entry);
  return entry;
}

function syncCardBody(entry: MonitorCardEntry, sessionId: string, bodyKey: string): void {
  if (entry.bodyKey === bodyKey) return;
  entry.frameWrap.innerHTML = cardFrameHtml(sessionId);
  entry.bodyKey = bodyKey;
}

// Returns the inner content only — the host element already carries the
// `.monitor-room-empty` class, so wrapping in another same-class <div> here
// would double the empty-state padding/min-height.
function emptyPlaceholderHtml(usingAutoActive: boolean): string {
  return `<h2>${escapeHtml(t(usingAutoActive ? 'monitorRoom.autoEmptyTitle' : 'monitorRoom.emptyTitle'))}</h2>
      <p>${escapeHtml(t(usingAutoActive ? 'monitorRoom.autoEmptyHelp' : 'monitorRoom.emptyHelp'))}</p>
      <a class="btn-link" href="#/sessions">${escapeHtml(t('monitorRoom.openSessions'))}</a>`;
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

function pageHtml(): string {
  return `<section class="page monitor-room-page">
    <div class="page-heading">
      <div class="monitor-room-heading-main">
        <p class="eyebrow">${escapeHtml(t('monitorRoom.eyebrow'))}</p>
        <div class="monitor-room-title-row">
          <a class="btn-link monitor-room-back" href="#/sessions">← ${escapeHtml(t('monitorRoom.backToSessions'))}</a>
          <h1>${escapeHtml(t('monitorRoom.title'))}</h1>
          <span id="monitor-room-summary" class="monitor-room-summary"></span>
        </div>
      </div>
      <div class="monitor-room-actions dashboard-toolbar">
        <label class="monitor-room-toggle filter-toggle" title="${escapeHtml(t('monitorRoom.autoActiveHelp'))}">
          <input type="checkbox" id="monitor-room-auto-active">
          <span class="filter-toggle-label">${escapeHtml(t('monitorRoom.autoActive'))}</span>
          <span class="filter-toggle-switch" aria-hidden="true"></span>
        </label>
        <button type="button" id="monitor-room-clear" class="contrast">${escapeHtml(t('monitorRoom.clear'))}</button>
      </div>
    </div>
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

  const cardEntries = new Map<string, MonitorCardEntry>();
  let emptyPlaceholder: HTMLElement | null = null;
  let syncRafId = 0;
  let resizeObserver: ResizeObserver | null = null;

  function scheduleSync(): void {
    if (syncRafId) return;
    syncRafId = requestAnimationFrame(() => {
      syncRafId = 0;
      syncMonitorRoomFrameScales(root, grid);
    });
  }

  function render(): void {
    const manualIds = readMonitorRoomSessionIds();
    const autoActive = readMonitorRoomAutoActive();
    const usingAutoActive = manualIds.length === 0 && autoActive;
    const ids = usingAutoActive ? activeSessionIds() : manualIds;
    const removable = !usingAutoActive;
    const liveCount = ids.filter(id => !!sessionTerminalHref(store.sessions.get(id))).length;
    autoActiveInput.checked = autoActive;
    summary.textContent = usingAutoActive && ids.length
      ? t('monitorRoom.autoSummary', { count: ids.length, live: liveCount })
      : ids.length
      ? t('monitorRoom.summary', { count: ids.length, live: liveCount })
      : t('monitorRoom.emptySummary');
    clearBtn.disabled = manualIds.length === 0;
    grid.dataset.count = String(ids.length);

    // Remove empty placeholder if we now have sessions
    if (ids.length > 0 && emptyPlaceholder) {
      emptyPlaceholder.remove();
      emptyPlaceholder = null;
    }

    // Keyed DOM update: keep stable <article> elements for existing sessionIds
    const seenKeys = new Set(ids);
    for (const [id, entry] of cardEntries) {
      if (!seenKeys.has(id)) {
        entry.article.remove();
        cardEntries.delete(id);
      }
    }

    if (ids.length === 0) {
      // Show empty placeholder without wiping grid
      if (!emptyPlaceholder) {
        emptyPlaceholder = document.createElement('div');
        emptyPlaceholder.className = 'monitor-room-empty';
        grid.appendChild(emptyPlaceholder);
      }
      emptyPlaceholder.innerHTML = emptyPlaceholderHtml(usingAutoActive);
    } else {
      ids.forEach((id, index) => {
        const entry = ensureCardEntry(cardEntries, grid, id);
        // Visual order via CSS `order` property — avoids DOM node reordering
        entry.article.style.order = String(index);
        // Update header (always refresh meta: status, time, title)
        entry.head.innerHTML = cardHeadHtml(id, removable);
        // Update body/iframe only when URL or missing state changed
        const bodyKey = monitorRoomPanelBodyKey(store.sessions.get(id));
        syncCardBody(entry, id, bodyKey);
      });
    }

    scheduleSync();
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
  window.addEventListener('resize', scheduleSync);
  if (typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(scheduleSync);
    resizeObserver.observe(root);
    resizeObserver.observe(grid);
  }
  render();
  void loadNameMaps().then(render);
  return () => {
    closePopover?.();
    window.removeEventListener('resize', scheduleSync);
    if (resizeObserver) resizeObserver.disconnect();
    if (syncRafId) cancelAnimationFrame(syncRafId);
    unsubscribe();
  };
}
