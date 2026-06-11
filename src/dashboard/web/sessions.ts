// Sessions page: filter bar, status board/table, detail drawer with locate/resume/close.
import {
  readStoredBoardOrder,
  readStoredSessionsViewMode,
  type SessionsViewMode,
  writeStoredBoardOrder,
  writeStoredSessionsViewMode,
} from './preferences.js';
import { store } from './store.js';
import {
  botDisplayName,
  botAvatarHtml,
  chatDisplayTitle,
  attentionWaitSince,
  escapeHtml,
  loadNameMaps,
  relTime,
  stripMentionPrefix,
  t,
  ui,
} from './ui.js';

function th(sort: string, label: string): string {
  return `<th data-sort="${sort}" data-label="${escapeHtml(label)}">${escapeHtml(label)}</th>`;
}

function tokenCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function formatTokenCount(value: unknown): string {
  const n = tokenCount(value);
  return n === null ? '-' : n.toLocaleString('en-US');
}

const CLI_FILTER_OPTIONS = [
  'claude-code',
  'seed',
  'codex',
  'codex-app',
  'cursor',
  'gemini',
  'opencode',
  'mtr',
  'hermes',
  'mira',
  'pi',
  'copilot',
  'aiden',
  'coco',
  'oh-my-pi',
  'unknown',
];

type BoardColumnId = 'needs-you' | 'starting' | 'working' | 'idle';

const BOARD_COLUMNS: Array<{ id: BoardColumnId; labelKey: string; hintKey: string }> = [
  { id: 'needs-you', labelKey: 'sessions.board.needsYou', hintKey: 'sessions.board.needsYouHint' },
  { id: 'starting', labelKey: 'sessions.board.starting', hintKey: 'sessions.board.startingHint' },
  { id: 'working', labelKey: 'sessions.board.working', hintKey: 'sessions.board.workingHint' },
  { id: 'idle', labelKey: 'sessions.board.idle', hintKey: 'sessions.board.idleHint' },
];

function cssToken(value: unknown): string {
  return String(value ?? 'unknown').toLowerCase().replace(/[^a-z0-9_-]/g, '-');
}

function repoBasename(workingDir: unknown): string {
  const value = String(workingDir ?? '').trim();
  if (!value) return '-';
  const parts = value.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts.at(-1) ?? value;
}

function terminalHref(s: any): string | null {
  if (!s.webPort) return null;
  const port = s.proxyPort ?? s.webPort;
  const suffix = s.proxyPort ? `/s/${encodeURIComponent(s.sessionId)}` : '';
  return `http://${location.hostname}:${port}${suffix}`;
}

// Cohesive icon set for the session-card action bar — stroke-based (CSS sets
// stroke:currentColor), 16px viewBox to match the sidebar nav glyphs. Icons
// instead of text labels keep the row a fixed width across locales: the EN
// labels used to be wider than zh and overflowed the narrow card, spilling
// "Close" onto its own line.
const ICON = {
  pin: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 14.3s4.2-3.9 4.2-7.3A4.2 4.2 0 0 0 8 2.9a4.2 4.2 0 0 0-4.2 4.1C3.8 10.4 8 14.3 8 14.3z"/><circle cx="8" cy="6.9" r="1.5"/></svg>',
  openChat: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9.4 2.8h3.8v3.8"/><path d="M13.2 2.8 7.3 8.7"/><path d="M11.5 9.3v2.9a1.2 1.2 0 0 1-1.2 1.2H3.8a1.2 1.2 0 0 1-1.2-1.2V5.7a1.2 1.2 0 0 1 1.2-1.2h2.9"/></svg>',
  details: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2.2" y="2.9" width="11.6" height="10.2" rx="1.8"/><path d="M9.9 2.9v10.2"/></svg>',
  terminal: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="1.7" y="2.7" width="12.6" height="10.6" rx="2"/><path d="M4.4 6.3 6.4 8.1 4.4 9.9"/><path d="M8.2 10.2h3.4"/></svg>',
  key: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="6" cy="6.1" r="3"/><path d="M8.1 8.2 13 13.1"/><path d="M11.3 11.4 12.6 10.1"/><path d="M12.7 12.8 13.7 11.8"/></svg>',
  close: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.2 4.2 11.8 11.8"/><path d="M11.8 4.2 4.2 11.8"/></svg>',
};

/** Compact icon action button for the card bar. `kind` adds a tint variant. */
function cardActBtn(action: string, icon: string, label: string, kind = ''): string {
  return `<button type="button" class="card-act${kind ? ' ' + kind : ''}" data-action="${action}" title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}">${icon}</button>`;
}

// Terminal access pill for a live session: a read-only "open" segment (always
// shown) plus — for authenticated users — a "key" segment that mints the
// writable (token-bearing) link on demand. Icon-only + tooltip keeps it compact;
// the writable segment carries the accent fill so it reads as the real action.
function terminalControlsHtml(url: string | null): string {
  if (!url) return '';
  const open = `<a class="term-btn term-open" href="${escapeHtml(url)}" target="_blank" rel="noopener" title="${escapeHtml(t('sessions.openTerminal'))}" aria-label="${escapeHtml(t('sessions.openTerminal'))}">${ICON.terminal}</a>`;
  if (!ui.authed) return `<span class="term-pill solo">${open}</span>`;
  const write = `<button type="button" class="term-btn term-write" data-action="write-link" title="${escapeHtml(t('sessions.writeLinkHint'))}" aria-label="${escapeHtml(t('sessions.writeLink'))}">${ICON.key}</button>`;
  return `<span class="term-pill">${open}${write}</span>`;
}

// Mint + open the writable web terminal for `s`. The tab is opened synchronously
// inside the click gesture (then navigated post-fetch) so the popup blocker —
// which fires when window.open trails an await — stays quiet. The token lands in
// the new tab's address bar, same as the Lark card's link, by design.
async function openWriteLink(s: any, btn?: HTMLButtonElement): Promise<void> {
  const tab = window.open('about:blank', '_blank');
  if (tab) tab.opener = null;
  if (btn) btn.disabled = true;
  try {
    const r = await fetch(`/api/sessions/${encodeURIComponent(s.sessionId)}/write-link`);
    const body = await r.json().catch(() => ({}));
    if (!r.ok || body?.ok === false || !body?.url) {
      tab?.close();
      // 401 already raises the global read-only toast — don't double-alert.
      if (r.status !== 401) alert(`${t('sessions.writeLinkFail')}: ${body?.error ?? r.status}`);
      return;
    }
    if (tab) tab.location.href = body.url;
    else window.open(body.url, '_blank', 'noopener');
  } catch (e) {
    tab?.close();
    alert(`${t('sessions.writeLinkFail')}: ${e}`);
  } finally {
    if (btn) btn.disabled = false;
  }
}

function deriveSessionBoardColumn(s: any): BoardColumnId | null {
  if (s.status === 'closed') return null;
  if (s.pendingRepo || s.tuiPromptActive || s.agentAttention || s.status === 'limited') return 'needs-you';
  if (s.status === 'starting') return 'starting';
  if (s.status === 'working' || s.status === 'analyzing' || s.status === 'active') return 'working';
  return 'idle';
}

// CLI 多选收进一个下拉 chip：默认全选时只占一个胶囊位，点开才展开
// 全部选项，避免 15 个 checkbox 铺满一整行。
export function renderCliFilterGroup(): string {
  return `<details class="filter-cli">
    <summary>${t('sessions.cli')} · <b id="cli-filter-count">${t('common.all')}</b></summary>
    <div class="filter-cli-pop" role="group" aria-label="${t('sessions.cli')}">
      ${CLI_FILTER_OPTIONS.map(cli => `
        <label class="filter-check">
          <input type="checkbox" name="cli" value="${escapeHtml(cli)}" checked>
          <span>${escapeHtml(cli)}</span>
        </label>
      `).join('')}
    </div>
  </details>`;
}

function pageHtml(): string {
  return `<section class="page">
    <div class="page-heading">
      <div>
        <p class="eyebrow">${t('nav.sessions')}</p>
        <h1>${t('sessions.title')}</h1>
        <p>${t('sessions.subtitle')}</p>
      </div>
      <div class="segmented sessions-view-toggle" role="group" aria-label="${t('sessions.viewMode')}">
        <button type="button" data-view="board">${t('sessions.viewBoard')}</button>
        <button type="button" data-view="table">${t('sessions.viewTable')}</button>
      </div>
    </div>
    <form id="filters" class="filters sessions-filters">
      <input type="search" name="q" placeholder="${t('sessions.search')}" />
      <select name="status">
        <option value="">${t('sessions.anyStatus')}</option>
        <option>starting</option><option>working</option><option>idle</option>
        <option>analyzing</option><option>active</option><option>closed</option>
      </select>
      <select name="adopt">
        <option value="">${t('sessions.adoptAny')}</option>
        <option value="yes">${t('sessions.adoptYes')}</option>
        <option value="no">${t('sessions.adoptNo')}</option>
      </select>
      ${renderCliFilterGroup()}
      <label class="filter-toggle"><input type="checkbox" name="active" checked> <span>${t('sessions.activeOnly')}</span></label>
    </form>
    <div id="bulk-bar" class="bulk-bar" hidden>
      <span id="bulk-count"></span>
      <button type="button" id="bulk-close" class="contrast">${t('sessions.closeSelected')}</button>
      <button type="button" id="bulk-clear">${t('sessions.clearSelection')}</button>
    </div>
    <table id="sessions-table">
      <thead><tr>
        <th><input type="checkbox" id="select-all" title="${t('sessions.activeOnly')}"></th>
        ${th('botName', t('sessions.bot'))}
        ${th('cliId', t('sessions.cli'))}
        ${th('status', t('sessions.status'))}
        ${th('tokenIn', t('sessions.tokenIn'))}
        ${th('tokenOut', t('sessions.tokenOut'))}
        ${th('title', t('sessions.titleCol'))}
        ${th('workingDir', t('sessions.workingDir'))}
        ${th('spawnedAt', t('sessions.created'))}
        ${th('lastMessageAt', t('sessions.last'))}
        ${th('adopt', t('sessions.adopt'))}
        <th>${t('sessions.actions')}</th>
      </tr></thead>
      <tbody></tbody>
    </table>
    <div id="sessions-board" class="sessions-board" hidden></div>
    <dialog id="drawer"></dialog>
  </section>`;
}

export function renderSessionsPage(root: HTMLElement) {
  root.innerHTML = pageHtml();
  const tbody = root.querySelector<HTMLElement>('#sessions-table tbody')!;
  const filtersForm = root.querySelector<HTMLFormElement>('#filters')!;
  const drawer = root.querySelector<HTMLDialogElement>('#drawer')!;
  const selectAllBox = root.querySelector<HTMLInputElement>('#select-all')!;
  const bulkBar = root.querySelector<HTMLElement>('#bulk-bar')!;
  const bulkCountSpan = root.querySelector<HTMLElement>('#bulk-count')!;
  const bulkCloseBtn = root.querySelector<HTMLButtonElement>('#bulk-close')!;
  const bulkClearBtn = root.querySelector<HTMLButtonElement>('#bulk-clear')!;
  const table = root.querySelector<HTMLTableElement>('#sessions-table')!;
  const board = root.querySelector<HTMLElement>('#sessions-board')!;
  const viewButtons = root.querySelectorAll<HTMLButtonElement>('[data-view]');

  const selected = new Set<string>();
  let sortKey = 'lastMessageAt';
  let sortDir: 'asc' | 'desc' = 'desc';
  let viewMode: SessionsViewMode = readStoredSessionsViewMode(window.localStorage);
  // 列顺序用户可调（拖列头 / ‹› 按钮），localStorage 持久化
  let boardOrder: string[] = readStoredBoardOrder(window.localStorage);
  let dragColId: string | null = null;
  // 防闪烁：上次渲染的 HTML 快照（内容没变就跳过 innerHTML），以及
  // 入场动画是否已播过（只在首次渲染播一轮）。
  let lastBoardHtml = '';
  let lastTableHtml = '';
  let boardAnimated = false;

  function orderedBoardColumns() {
    return boardOrder
      .map(id => BOARD_COLUMNS.find(c => c.id === id))
      .filter((c): c is typeof BOARD_COLUMNS[number] => !!c);
  }

  function moveColumn(id: string, delta: number): void {
    const from = boardOrder.indexOf(id);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= boardOrder.length) return;
    const next = [...boardOrder];
    next.splice(from, 1);
    next.splice(to, 0, id);
    boardOrder = next;
    writeStoredBoardOrder(window.localStorage, boardOrder);
    rerender();
  }

  function moveColumnTo(id: string, targetId: string): void {
    if (id === targetId) return;
    const from = boardOrder.indexOf(id);
    const to = boardOrder.indexOf(targetId);
    if (from < 0 || to < 0) return;
    const next = [...boardOrder];
    next.splice(from, 1);
    next.splice(to, 0, id);
    boardOrder = next;
    writeStoredBoardOrder(window.localStorage, boardOrder);
    rerender();
  }

  function rowHtml(s: any): string {
    const closed = s.status === 'closed';
    const checked = selected.has(s.sessionId) ? 'checked' : '';
    return `<tr data-id="${escapeHtml(s.sessionId)}">
      <td><input type="checkbox" class="row-select" ${checked} ${closed ? 'disabled' : ''}></td>
      <td>${escapeHtml(botDisplayName(s))}</td>
      <td><span class="badge cli-${cssToken(s.cliId)}">${escapeHtml(s.cliId ?? 'unknown')}</span></td>
      <td><span class="status status-${escapeHtml(s.status ?? 'unknown')}">${escapeHtml(s.status ?? 'unknown')}</span></td>
      <td class="token-cell">${formatTokenCount(s.tokenUsage?.in)}</td>
      <td class="token-cell">${formatTokenCount(s.tokenUsage?.out)}</td>
      <td title="${escapeHtml(String(s.title ?? ''))}">${escapeHtml(stripMentionPrefix(s.title ?? '').slice(0, 48))}</td>
      <td title="${escapeHtml(s.workingDir ?? '')}">${escapeHtml((s.workingDir ?? '').slice(-34))}</td>
      <td>${relTime(s.spawnedAt)}</td>
      <td>${relTime(s.lastMessageAt)}</td>
      <td>${s.adopt ? '<span class="badge">adopt</span>' : ''}</td>
      <td><button class="open" type="button">${t('sessions.details')}</button></td>
    </tr>`;
  }

  // chat-scope（普通群/单聊平铺回复）没有话题可定位——「定位话题」换成直接
  // 打开群聊的 applink。旧 daemon 上报的行没有 scope 字段，保持定位行为。
  function chatScopeLink(s: any): string | null {
    if (s.scope !== 'chat' || !s.feishuChatLink) return null;
    const label = t('sessions.openChat');
    return `<a class="card-act" href="${escapeHtml(s.feishuChatLink)}" target="_blank" rel="noopener" title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}">${ICON.openChat}</a>`;
  }

  function boardSignalLabel(s: any): string {
    // Agent-raised reason is the most informative — show it verbatim so the
    // human sees *why* the task is stuck, not a generic label.
    if (s.agentAttention?.reason) return s.agentAttention.reason;
    if (s.agentAttention) return t('sessions.board.signalAgent');
    if (s.pendingRepo) return t('sessions.board.signalRepo');
    if (s.tuiPromptActive) return t('sessions.board.signalPrompt');
    if (s.status === 'limited') return t('sessions.board.signalLimited');
    return '';
  }

  function boardCardHtml(s: any): string {
    const isSelected = selected.has(s.sessionId);
    // title 剥掉开头的 "@bot" mention，只留消息内容；副行的群聊名比 cliId 更
    // 有辨识度（同一 bot 可能在多个群干活），查不到群名时回退 cliId。
    const title = stripMentionPrefix(s.title) || s.sessionId;
    const botName = botDisplayName(s);
    const chatTitle = chatDisplayTitle(s);
    const terminal = terminalHref(s);
    const signal = boardSignalLabel(s);
    const repo = repoBasename(s.workingDir);
    return `<article class="session-card${isSelected ? ' selected' : ''}" data-id="${escapeHtml(s.sessionId)}" aria-pressed="${isSelected}">
      <div class="session-card-top">
        ${botAvatarHtml({ name: botName, larkAppId: s.larkAppId, size: 'sm' })}
        <div class="session-card-title">
          <strong title="${escapeHtml(String(s.title ?? title))}">${escapeHtml(String(title).slice(0, 72))}</strong>
          <span>${escapeHtml(botName)} · ${escapeHtml(chatTitle ?? s.cliId ?? 'unknown')}</span>
        </div>
        <span class="status status-${escapeHtml(s.status ?? 'unknown')}">${escapeHtml(s.status ?? 'unknown')}</span>
      </div>
      ${repo !== '-' || s.adopt ? `<div class="session-card-meta">
        ${repo !== '-' ? `<span title="${escapeHtml(s.workingDir ?? '')}">${escapeHtml(repo)}</span>` : ''}
        ${s.adopt ? '<span class="badge">adopt</span>' : ''}
      </div>` : ''}
      <div class="session-card-time">
        <span>${s.agentAttention?.at
          ? `${escapeHtml(t('sessions.board.waiting'))} ${relTime(attentionWaitSince(s))}`
          : `${escapeHtml(t('sessions.last'))}: ${relTime(s.lastMessageAt)}`}</span>
      </div>
      ${signal ? `<div class="session-signal" title="${escapeHtml(signal)}">${escapeHtml(signal)}</div>` : ''}
      <div class="session-card-actions">
        ${chatScopeLink(s) ?? cardActBtn('locate', ICON.pin, t('sessions.locate'))}
        ${cardActBtn('details', ICON.details, t('sessions.details'))}
        ${terminalControlsHtml(terminal)}
        ${cardActBtn('close', ICON.close, t('sessions.close'), 'danger')}
      </div>
    </article>`;
  }

  function compareBoardRows(a: any, b: any, column: BoardColumnId): number {
    const av = column === 'needs-you' ? attentionWaitSince(a) : Number(a.lastMessageAt ?? 0);
    const bv = column === 'needs-you' ? attentionWaitSince(b) : Number(b.lastMessageAt ?? 0);
    if (av !== bv) return column === 'needs-you' ? av - bv : bv - av;
    return String(a.title ?? a.sessionId).localeCompare(String(b.title ?? b.sessionId));
  }

  function renderBoard(rows: any[]): void {
    const groups = new Map<BoardColumnId, any[]>(BOARD_COLUMNS.map(c => [c.id, []]));
    for (const row of rows) {
      const column = deriveSessionBoardColumn(row);
      if (column) groups.get(column)!.push(row);
    }
    const columns = orderedBoardColumns();
    const html = columns.map((column, idx) => {
      const columnRows = (groups.get(column.id) ?? []).sort((a, b) => compareBoardRows(a, b, column.id));
      return `<section class="session-board-column session-board-${column.id}" data-col="${column.id}">
        <header draggable="true" title="${escapeHtml(t('sessions.board.dragHint'))}">
          <div>
            <h2>${escapeHtml(t(column.labelKey))}</h2>
            <p>${escapeHtml(t(column.hintKey))}</p>
          </div>
          <span class="session-board-head-right">
            <span class="session-board-move">
              <button type="button" data-move-col="${column.id}" data-dir="-1"
                aria-label="${escapeHtml(t('sessions.board.moveLeft'))}" ${idx === 0 ? 'disabled' : ''}>‹</button>
              <button type="button" data-move-col="${column.id}" data-dir="1"
                aria-label="${escapeHtml(t('sessions.board.moveRight'))}" ${idx === columns.length - 1 ? 'disabled' : ''}>›</button>
            </span>
            <span class="session-board-count">${columnRows.length}</span>
          </span>
        </header>
        <div class="session-board-list">
          ${columnRows.length ? columnRows.map(boardCardHtml).join('') : `<div class="session-board-empty">${t('sessions.board.emptyColumn')}</div>`}
        </div>
      </section>`;
    }).join('');
    // SSE 事件（心跳/无关字段 patch）远多于真正的可见变化——内容没变就不碰
    // DOM，避免 backdrop-blur 面板整板重排造成的闪烁。
    if (html === lastBoardHtml) return;
    lastBoardHtml = html;
    board.innerHTML = html;
    // 入场动画只在看板第一次画出来时播一轮（.board-enter），之后的状态更新
    // 重绘不再整板重播——那就是「每次状态更新页面闪一下」的来源。
    board.classList.toggle('board-enter', !boardAnimated);
    boardAnimated = true;
  }

  function filtered(): any[] {
    const f = new FormData(filtersForm);
    const q = ((f.get('q') as string) ?? '').toLowerCase();
    const cli = f.getAll('cli') as string[];
    const cliFilterActive = cli.length > 0 && cli.length < CLI_FILTER_OPTIONS.length;
    const status = f.get('status') as string;
    const adopt = f.get('adopt') as string;
    const active = !!f.get('active');
    const rows = [...store.sessions.values()]
      .filter(s => !cliFilterActive || cli.includes(s.cliId ?? 'unknown'))
      .filter(s => !status || s.status === status)
      .filter(s => !adopt || (adopt === 'yes') === !!s.adopt)
      .filter(s => !active || s.status !== 'closed')
      .filter(s => !q || JSON.stringify(s).toLowerCase().includes(q));
    rows.sort(compareRows);
    return rows;
  }

  function sortValue(s: any, key: string): string | number | boolean {
    if (key === 'spawnedAt' || key === 'lastMessageAt') return Number(s[key] ?? 0);
    if (key === 'tokenIn') return tokenCount(s.tokenUsage?.in) ?? -1;
    if (key === 'tokenOut') return tokenCount(s.tokenUsage?.out) ?? -1;
    if (key === 'adopt') return !!s.adopt;
    return String(s[key] ?? '').toLowerCase();
  }

  function compareRows(a: any, b: any): number {
    const av = sortValue(a, sortKey);
    const bv = sortValue(b, sortKey);
    let cmp = 0;
    if (typeof av === 'number' && typeof bv === 'number') cmp = av - bv;
    else if (typeof av === 'boolean' && typeof bv === 'boolean') cmp = Number(av) - Number(bv);
    else cmp = String(av).localeCompare(String(bv));
    if (cmp === 0) cmp = Number(a.lastMessageAt ?? 0) - Number(b.lastMessageAt ?? 0);
    return sortDir === 'asc' ? cmp : -cmp;
  }

  function paintSortHeaders(): void {
    table.querySelectorAll<HTMLTableCellElement>('th[data-sort]').forEach(header => {
      const active = header.dataset.sort === sortKey;
      header.classList.toggle('sorted', active);
      header.setAttribute('aria-sort', active ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none');
      const label = header.dataset.label ?? header.textContent?.trim() ?? '';
      header.textContent = active ? `${label} ${sortDir === 'asc' ? '▲' : '▼'}` : label;
    });
  }

  function syncBulkUi(rows: any[]): void {
    bulkBar.hidden = selected.size === 0;
    bulkCountSpan.textContent = t('sessions.selectedCount', { count: selected.size });
    const selectable = rows.filter(r => r.status !== 'closed');
    if (selectable.length === 0) {
      selectAllBox.checked = false;
      selectAllBox.indeterminate = false;
      selectAllBox.disabled = true;
      return;
    }
    selectAllBox.disabled = false;
    const selectedInView = selectable.filter(r => selected.has(r.sessionId)).length;
    selectAllBox.checked = selectedInView === selectable.length;
    selectAllBox.indeterminate = selectedInView > 0 && selectedInView < selectable.length;
  }

  function paintViewToggle(): void {
    viewButtons.forEach(btn => {
      const active = btn.dataset.view === viewMode;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-pressed', String(active));
    });
  }

  // CLI 下拉 chip 上的已选计数：全选时显示「全部」，否则显示 N/总数
  function paintCliFilterCount(): void {
    const countEl = filtersForm.querySelector<HTMLElement>('#cli-filter-count');
    if (!countEl) return;
    const boxes = [...filtersForm.querySelectorAll<HTMLInputElement>('input[name="cli"]')];
    const checked = boxes.filter(b => b.checked).length;
    countEl.textContent = checked === boxes.length ? t('common.all') : `${checked}/${boxes.length}`;
    countEl.classList.toggle('cli-filter-active', checked !== boxes.length);
  }

  function rerender(): void {
    const rows = filtered();
    for (const sid of [...selected]) {
      const s = store.sessions.get(sid);
      if (!s || s.status === 'closed') selected.delete(sid);
    }
    const boardRows = rows.filter(r => r.status !== 'closed');
    const visibleRows = viewMode === 'board' ? boardRows : rows;
    table.hidden = viewMode !== 'table';
    board.hidden = viewMode !== 'board';
    if (viewMode === 'table') {
      const tableHtml = rows.length
        ? rows.map(rowHtml).join('')
        : `<tr><td colspan="12" class="empty">${t('sessions.empty')}</td></tr>`;
      if (tableHtml !== lastTableHtml) {
        lastTableHtml = tableHtml;
        tbody.innerHTML = tableHtml;
      }
    } else {
      renderBoard(boardRows);
    }
    paintViewToggle();
    paintSortHeaders();
    paintCliFilterCount();
    syncBulkUi(visibleRows);
  }

  async function locateSession(s: any, locateBtn?: HTMLButtonElement): Promise<void> {
    if (locateBtn) {
      locateBtn.disabled = true;
      locateBtn.textContent = t('sessions.locating');
    }
    try {
      const r = await fetch(`/api/sessions/${encodeURIComponent(s.sessionId)}/locate`, { method: 'POST' });
      const body = await r.json();
      if (body.ok) {
        if (!locateBtn) return;
        let left = 30;
        locateBtn.textContent = t('sessions.cooldown', { seconds: left });
        const tick = setInterval(() => {
          left -= 1;
          if (left <= 0) {
            clearInterval(tick);
            locateBtn.disabled = false;
            locateBtn.textContent = t('sessions.locate');
          } else {
            locateBtn.textContent = t('sessions.cooldown', { seconds: left });
          }
        }, 1000);
      } else {
        alert(`Locate failed: ${body.error ?? r.status}`);
        if (locateBtn) {
          locateBtn.disabled = false;
          locateBtn.textContent = t('sessions.locate');
        }
      }
    } catch (e) {
      alert(`Locate error: ${e}`);
      if (locateBtn) {
        locateBtn.disabled = false;
        locateBtn.textContent = t('sessions.locate');
      }
    }
  }

  async function closeSession(s: any, closeBtn?: HTMLButtonElement): Promise<boolean> {
    if (!confirm(t('sessions.closeConfirm'))) return false;
    if (closeBtn) closeBtn.disabled = true;
    try {
      // 与批量关闭同口径：401（只读访客）/ 5xx 都不能当成功——否则抽屉
      // 静默关闭、board 重绘，用户以为关掉了。401 的提示由全局 fetch
      // patch 弹只读 toast，这里只负责不误报成功。
      const r = await fetch(`/api/sessions/${encodeURIComponent(s.sessionId)}/close`, { method: 'POST' });
      const body = await r.json().catch(() => ({}));
      if (!r.ok || body?.ok === false) {
        if (r.status !== 401) alert(`Close failed: ${body?.error ?? r.status}`);
        return false;
      }
      return true;
    } catch (e) {
      alert(`Close error: ${e}`);
      return false;
    } finally {
      if (closeBtn) closeBtn.disabled = false;
    }
  }

  function openDrawer(s: any): void {
    const closed = s.status === 'closed';
    const terminal = terminalHref(s);
    drawer.innerHTML = `<article>
      <header>
        <h3>${escapeHtml(stripMentionPrefix(s.title) || s.sessionId)}</h3>
        <span class="status status-${escapeHtml(s.status ?? 'unknown')}">${escapeHtml(s.status ?? 'unknown')}</span>
        <p><code>${escapeHtml(s.sessionId)}</code> <button data-copy="${escapeHtml(s.sessionId)}">${t('sessions.copy')}</button></p>
      </header>
      <p><b>${t('sessions.bot')}:</b> ${escapeHtml(botDisplayName(s))} · <b>${t('sessions.cli')}:</b> ${escapeHtml(s.cliId ?? '?')}</p>
      ${chatDisplayTitle(s) ? `<p><b>${t('sessions.chat')}:</b> ${escapeHtml(chatDisplayTitle(s)!)}</p>` : ''}
      <p><b>chatId:</b> <code>${escapeHtml(s.chatId ?? '')}</code> <button data-copy="${escapeHtml(s.chatId ?? '')}">${t('sessions.copy')}</button></p>
      <p><b>rootMessageId:</b> <code>${escapeHtml(s.rootMessageId ?? '')}</code> <button data-copy="${escapeHtml(s.rootMessageId ?? '')}">${t('sessions.copy')}</button></p>
      ${s.threadId ? `<p><b>threadId:</b> <code>${escapeHtml(s.threadId)}</code></p>` : ''}
      <p><b>${t('sessions.workingDir')}:</b> ${escapeHtml(s.workingDir ?? '-')}</p>
      <div class="actions">
        ${chatScopeLink(s) ?? `<button id="locate-btn" type="button">${t('sessions.locate')}</button>`}
        ${terminalControlsHtml(terminal)}
        ${closed ? `<button id="resume-btn" type="button" class="primary">${t('sessions.resume')}</button>` : ''}
        ${!closed ? `<button id="close-btn" type="button" class="contrast">${t('sessions.close')}</button>` : ''}
        <button id="land-btn" type="button">${t('sessions.land')}</button>
      </div>
      <div id="land-area"></div>
      <form method="dialog"><button>${t('sessions.dismiss')}</button></form>
    </article>`;

    drawer.querySelectorAll<HTMLButtonElement>('[data-copy]').forEach(btn => {
      btn.onclick = () => {
        navigator.clipboard.writeText(btn.dataset.copy ?? '');
        btn.textContent = t('sessions.copied');
        setTimeout(() => { btn.textContent = t('sessions.copy'); }, 800);
      };
    });

    const locateBtn = drawer.querySelector<HTMLButtonElement>('#locate-btn');
    if (locateBtn) {
      locateBtn.onclick = () => void locateSession(s, locateBtn);
    }

    // Writable-terminal segment (.term-write) lives inside the drawer, outside
    // the board's click delegation — wire it directly.
    const writeBtn = drawer.querySelector<HTMLButtonElement>('.term-write');
    if (writeBtn) {
      writeBtn.onclick = () => void openWriteLink(s, writeBtn);
    }

    const resumeBtn = drawer.querySelector<HTMLButtonElement>('#resume-btn');
    if (resumeBtn) {
      resumeBtn.onclick = async () => {
        resumeBtn.disabled = true;
        try {
          const r = await fetch(`/api/sessions/${encodeURIComponent(s.sessionId)}/resume`, { method: 'POST' });
          const body = await r.json().catch(() => ({}));
          if (!r.ok || body.ok === false) {
            alert(`${t('sessions.resumeFailed')}: ${body?.error ?? r.status}`);
            resumeBtn.disabled = false;
            return;
          }
          drawer.close();
        } catch (e) {
          alert(`${t('sessions.resumeFailed')}: ${e}`);
          resumeBtn.disabled = false;
        }
      };
    }

    const closeBtn = drawer.querySelector<HTMLButtonElement>('#close-btn');
    if (closeBtn) {
      closeBtn.onclick = async () => {
        if (await closeSession(s, closeBtn)) drawer.close();
      };
    }

    // Sandbox landing: fetch the clone's diff, show it, then apply/discard.
    const landBtn = drawer.querySelector<HTMLButtonElement>('#land-btn');
    const landArea = drawer.querySelector<HTMLDivElement>('#land-area');
    if (landBtn && landArea) {
      landBtn.onclick = async () => {
        landBtn.disabled = true;
        landArea.innerHTML = `<p>${t('sessions.landLoading')}</p>`;
        try {
          const r = await fetch(`/api/sessions/${encodeURIComponent(s.sessionId)}/sandbox-diff`);
          const d = await r.json().catch(() => ({}));
          if (!d.ok) { landArea.innerHTML = `<p>${t('sessions.landUnavailable')}: ${escapeHtml(d.error ?? String(r.status))}</p>`; landBtn.disabled = false; return; }
          if (d.empty) { landArea.innerHTML = `<p>${t('sessions.landEmpty')}</p>`; landBtn.disabled = false; return; }
          const full = String(d.patch ?? '');
          const patch = full.slice(0, 20000) + (full.length > 20000 ? '\n…(truncated)' : '');
          landArea.innerHTML = `
            <p><b>${d.files}</b> files (+${d.insertions}/-${d.deletions}) → <code>${escapeHtml(String(d.workingDir ?? ''))}</code></p>
            <pre style="max-height:320px;overflow:auto;white-space:pre-wrap">${escapeHtml(patch)}</pre>
            <div class="actions">
              <button id="land-apply" type="button" class="primary">${t('sessions.landApply')}</button>
              <button id="land-discard" type="button" class="contrast">${t('sessions.landDiscard')}</button>
            </div>`;
          const applyBtn = landArea.querySelector<HTMLButtonElement>('#land-apply')!;
          const discardBtn = landArea.querySelector<HTMLButtonElement>('#land-discard')!;
          applyBtn.onclick = async () => {
            applyBtn.disabled = true; discardBtn.disabled = true;
            const rr = await fetch(`/api/sessions/${encodeURIComponent(s.sessionId)}/sandbox-land/apply`, { method: 'POST' });
            const res = await rr.json().catch(() => ({}));
            landArea.innerHTML = res.ok
              ? `<p>✅ ${t('sessions.landApplied')}: ${res.files} files (+${res.insertions}/-${res.deletions}) → <code>${escapeHtml(String(res.workingDir ?? ''))}</code></p>`
              : `<p>❌ ${t('sessions.landFailed')}: ${escapeHtml(res.error ?? String(rr.status))}</p>`;
          };
          discardBtn.onclick = async () => {
            await fetch(`/api/sessions/${encodeURIComponent(s.sessionId)}/sandbox-land/discard`, { method: 'POST' });
            landArea.innerHTML = `<p>🗑 ${t('sessions.landDiscarded')}</p>`;
          };
        } catch (e) {
          landArea.innerHTML = `<p>${t('sessions.landUnavailable')}: ${escapeHtml(String(e))}</p>`;
          landBtn.disabled = false;
        }
      };
    }

    drawer.showModal();
  }

  tbody.addEventListener('click', e => {
    const target = e.target as HTMLElement;
    if (target.classList.contains('row-select')) {
      const tr = target.closest<HTMLTableRowElement>('tr[data-id]');
      if (!tr) return;
      const cb = target as HTMLInputElement;
      if (cb.checked) selected.add(tr.dataset.id!);
      else selected.delete(tr.dataset.id!);
      syncBulkUi(filtered());
      return;
    }
    const td = target.closest<HTMLTableCellElement>('td');
    if (td && td.querySelector('.row-select')) return;
    const tr = target.closest<HTMLTableRowElement>('tr[data-id]');
    if (!tr) return;
    const s = store.sessions.get(tr.dataset.id!);
    if (s) openDrawer(s);
  });

  board.addEventListener('click', e => {
    const target = e.target as HTMLElement;
    // 列头 ‹/› 按钮：交换列顺序（拖拽的键盘/触屏兜底）
    const moveBtn = target.closest<HTMLButtonElement>('button[data-move-col]');
    if (moveBtn) {
      moveColumn(moveBtn.dataset.moveCol!, Number(moveBtn.dataset.dir));
      return;
    }
    const card = target.closest<HTMLElement>('.session-card[data-id]');
    if (!card) return;
    const s = store.sessions.get(card.dataset.id!);
    if (!s) return;

    const actionButton = target.closest<HTMLButtonElement>('button[data-action]');
    if (actionButton) {
      const action = actionButton.dataset.action;
      if (action === 'details') openDrawer(s);
      else if (action === 'write-link') void openWriteLink(s, actionButton);
      else if (action === 'locate') void locateSession(s, actionButton);
      else if (action === 'close') void closeSession(s, actionButton).then(ok => {
        if (ok) {
          selected.delete(s.sessionId);
          rerender();
        }
      });
      return;
    }

    // Clicking the card body toggles selection (the Feishu topic link lives
    // behind the 定位 button) — no checkbox, the whole card is the target.
    if (target.closest('a, button, input, label')) return;
    if (selected.has(s.sessionId)) selected.delete(s.sessionId);
    else selected.add(s.sessionId);
    card.classList.toggle('selected', selected.has(s.sessionId));
    card.setAttribute('aria-pressed', String(selected.has(s.sessionId)));
    syncBulkUi(filtered().filter(r => r.status !== 'closed'));
  });

  // ── 列头拖拽排序：拖起一列，放到目标列的位置 ─────────────────────────────
  board.addEventListener('dragstart', e => {
    const header = (e.target as HTMLElement).closest<HTMLElement>('.session-board-column > header[draggable]');
    const col = header?.closest<HTMLElement>('.session-board-column');
    if (!col?.dataset.col) return;
    dragColId = col.dataset.col;
    col.classList.add('dragging');
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', dragColId);
    }
  });
  board.addEventListener('dragover', e => {
    if (!dragColId) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    const target = (e.target as HTMLElement).closest<HTMLElement>('.session-board-column');
    board.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
    if (target && target.dataset.col !== dragColId) target.classList.add('drag-over');
  });
  board.addEventListener('drop', e => {
    if (!dragColId) return;
    e.preventDefault();
    const target = (e.target as HTMLElement).closest<HTMLElement>('.session-board-column');
    const from = dragColId;
    dragColId = null;
    if (target?.dataset.col) moveColumnTo(from, target.dataset.col);
  });
  board.addEventListener('dragend', () => {
    dragColId = null;
    board.querySelectorAll('.drag-over, .dragging').forEach(el => el.classList.remove('drag-over', 'dragging'));
  });

  viewButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      const next = btn.dataset.view === 'table' ? 'table' : 'board';
      if (next === viewMode) return;
      viewMode = next;
      writeStoredSessionsViewMode(window.localStorage, viewMode);
      rerender();
    });
  });

  selectAllBox.addEventListener('change', () => {
    const rows = filtered().filter(r => r.status !== 'closed');
    for (const row of rows) {
      if (selectAllBox.checked) selected.add(row.sessionId);
      else selected.delete(row.sessionId);
    }
    rerender();
  });

  bulkClearBtn.addEventListener('click', () => {
    selected.clear();
    rerender();
  });

  bulkCloseBtn.addEventListener('click', async () => {
    const ids = [...selected];
    if (ids.length === 0) return;
    if (!confirm(t('sessions.closeBulkConfirm', { count: ids.length }))) return;
    bulkCloseBtn.disabled = true;
    bulkClearBtn.disabled = true;
    const original = bulkCloseBtn.textContent;
    let done = 0;
    let failed = 0;
    const queue = [...ids];
    bulkCloseBtn.textContent = `0/${ids.length}`;
    async function worker() {
      while (queue.length) {
        const sid = queue.shift()!;
        try {
          const r = await fetch(`/api/sessions/${encodeURIComponent(sid)}/close`, { method: 'POST' });
          const body = await r.json().catch(() => ({}));
          if (!r.ok || body?.ok === false) failed += 1;
        } catch {
          failed += 1;
        } finally {
          done += 1;
          bulkCloseBtn.textContent = `${done}/${ids.length}`;
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(6, ids.length) }, () => worker()));
    bulkCloseBtn.textContent = original;
    bulkCloseBtn.disabled = false;
    bulkClearBtn.disabled = false;
    selected.clear();
    rerender();
    if (failed > 0) alert(`Failed: ${failed}/${ids.length}`);
  });

  table.querySelectorAll<HTMLTableCellElement>('th[data-sort]').forEach(header => {
    header.addEventListener('click', () => {
      const key = header.dataset.sort!;
      if (sortKey === key) sortDir = sortDir === 'asc' ? 'desc' : 'asc';
      else {
        sortKey = key;
        sortDir = key === 'spawnedAt' || key === 'lastMessageAt' ? 'desc' : 'asc';
      }
      rerender();
    });
  });

  filtersForm.addEventListener('input', rerender);
  store.on(rerender);
  rerender();
  // bot 友好名 / 群聊标题异步解析，回来后补一次重绘（首帧先显示原值）
  void loadNameMaps().then(rerender);
}
