// Sessions page: filter bar, status board/table, detail drawer with locate/resume/close.
import {
  type KanbanGroupBy,
  KANBAN_TEAM_STORAGE_KEY,
  normalizeSessionsViewMode,
  readStoredBoardOrder,
  readStoredKanbanGroupBy,
  readStoredSessionsViewMode,
  type SessionsViewMode,
  writeStoredBoardOrder,
  writeStoredKanbanGroupBy,
  writeStoredSessionsViewMode,
} from './preferences.js';
import {
  computeDropPosition,
  deriveKanbanColumn,
  effectiveKanbanPosition,
  type SessionKanbanColumn,
} from './kanban-model.js';
import { store } from './store.js';
import {
  botDisplayName,
  botAvatarHtml,
  chatAvatarHtml,
  chatDisplayTitle,
  attentionWaitSince,
  escapeHtml,
  loadNameMaps,
  relTime,
  stripMentionPrefix,
  t,
  ui,
} from './ui.js';
import {
  IDLE_CLEANUP_HOUR_OPTIONS,
  parseIdleCleanupHours,
  selectIdleCleanupCandidates,
  type IdleCleanupHours,
} from '../session-cleanup.js';

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
  'relay',
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

// ── 看板视图 ──────────────────────────────────────────────────────────────────
// 五列手动工作流（待办池/待办/进行中/待确认/已完成）：卡片可拖拽换列与列内排序，
// 放置持久化在 Session 上（daemon /board 端点）；未手动放置的会话按运行状态
// 推导默认列（kanban-model.ts），已关闭会话固定落「已完成」。
const KANBAN_COLUMNS: Array<{ id: SessionKanbanColumn; labelKey: string }> = [
  { id: 'backlog', labelKey: 'sessions.kanban.backlog' },
  { id: 'todo', labelKey: 'sessions.kanban.todo' },
  { id: 'in_progress', labelKey: 'sessions.kanban.inProgress' },
  { id: 'in_review', labelKey: 'sessions.kanban.inReview' },
  { id: 'done', labelKey: 'sessions.kanban.done' },
];

// 「已完成」列收纳所有已关闭会话，可能积累上千条——只展示最前的一截，剩余计数提示。
const KANBAN_DONE_CAP = 50;

// 列状态图标：14x14 SVG，圆环 + 不同填充度的扇形/对勾表达工作流进度，
// 颜色由列容器的 currentColor 决定（CSS 里按列着色）。
function kanbanStatusIcon(id: SessionKanbanColumn): string {
  const ring = (extra = '') =>
    `<svg viewBox="0 0 14 14" aria-hidden="true"><circle cx="7" cy="7" r="5.4" fill="none" stroke="currentColor" stroke-width="1.6"${extra}/>`;
  switch (id) {
    case 'backlog': // 虚线圆环
      return `${ring(' stroke-dasharray="1.6 2.1"')}</svg>`;
    case 'in_progress': // 半圆填充
      return `${ring()}<path d="M7,7 L7,3.6 A3.4,3.4 0 0 1 7,10.4 Z" fill="currentColor"/></svg>`;
    case 'in_review': // 3/4 填充
      return `${ring()}<path d="M7,7 L7,3.6 A3.4,3.4 0 1 1 3.6,7 Z" fill="currentColor"/></svg>`;
    case 'done': // 实心圆 + 对勾
      return `<svg viewBox="0 0 14 14" aria-hidden="true"><circle cx="7" cy="7" r="6.2" fill="currentColor"/><path d="M4.4 7.2 6.2 9 9.7 5.4" fill="none" stroke="var(--surface)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    case 'todo': // 空心圆环
    default:
      return `${ring()}</svg>`;
  }
}

function cssToken(value: unknown): string {
  return String(value ?? 'unknown').toLowerCase().replace(/[^a-z0-9_-]/g, '-');
}

export const SESSION_STATUS_OPTIONS = [
  'starting',
  'working',
  'idle',
  'dormant',
  'analyzing',
  'active',
  'limited',
  'closed',
];

export function sessionStatusText(status: unknown): string {
  const raw = String(status ?? 'unknown');
  const key = `sessions.status.${raw}`;
  const label = t(key);
  return label === key ? raw : label;
}

function statusBadgeHtml(status: unknown): string {
  const raw = String(status ?? 'unknown');
  return `<span class="status status-${escapeHtml(cssToken(raw))}">${escapeHtml(sessionStatusText(raw))}</span>`;
}

function repoBasename(workingDir: unknown): string {
  const value = String(workingDir ?? '').trim();
  if (!value) return '-';
  const parts = value.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts.at(-1) ?? value;
}

function terminalHref(s: any): string | null {
  if (!s.webPort) return null;
  // 经中心化平台访问时（本页是 HTTPS 机器子域 m-<id>.<host>）：终端走**同源 /s/<session>**——
  // 平台在 443 反代该路径 → 本机 dashboard → 本地终端。不能带 :port（平台只在 443 反代，:8801 打不通）。
  // 需要本地终端反代口(proxyPort)已起；没起则平台侧无法反代，返回 null 不给死链。
  if (location.protocol === 'https:') {
    return s.proxyPort ? `${location.origin}/s/${encodeURIComponent(s.sessionId)}` : null;
  }
  // 本地直连：http://host:port[/s/...]
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
  lock: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3.2" y="7" width="9.6" height="6.2" rx="1.4"/><path d="M5.2 7V5.2a2.8 2.8 0 0 1 5.6 0V7"/></svg>',
  unlock: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3.2" y="7" width="9.6" height="6.2" rx="1.4"/><path d="M5.2 7V5.2a2.8 2.8 0 0 1 5.2-1.4"/></svg>',
  close: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.2 4.2 11.8 11.8"/><path d="M11.8 4.2 4.2 11.8"/></svg>',
  edit: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10.7 3.3 12.7 5.3 6.3 11.7 3.7 12.3 4.3 9.7 10.7 3.3z"/></svg>',
  history: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.2 4.8a2 2 0 0 1 2-2h7.6a2 2 0 0 1 2 2v4.6a2 2 0 0 1-2 2H6.6l-2.9 2.4v-2.4h-.5a2 2 0 0 1-2-2z"/><path d="M5.2 6.2h5.6M5.2 8.4h3.6"/></svg>',
  restart: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M12.4 6.2a4.8 4.8 0 1 0 1.1 3.1"/><path d="M12.4 2.9v3.3H9.1"/></svg>',
  // 飞书：两片交叠的羽毛向右上展翅（还原 Lark 彩色 logo 的飞鸟造型），单色
  // stroke:currentColor 适配本组线性图标，圆角端点呼应原 logo 的圆润羽尖。
  feishu: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.6 4.4C6.4 4 10.4 5.4 13.4 8.2 9.8 7 6.4 6.6 3.4 7.4"/><path d="M13.4 8.2C9.6 8.7 6 10 2.9 12 5.6 9 8.8 7.6 13.4 8.2"/></svg>',
};

/** Compact icon action button for the card bar. `kind` adds a tint variant. */
function cardActBtn(action: string, icon: string, label: string, kind = ''): string {
  return `<button type="button" class="card-act${kind ? ' ' + kind : ''}" data-action="${action}" title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}">${icon}</button>`;
}

function lockActionLabel(s: any): string {
  return s.locked ? t('sessions.unlock') : t('sessions.lock');
}

function lockChipHtml(s: any): string {
  return s.locked
    ? `<span class="session-lock-badge" title="${escapeHtml(t('sessions.locked'))}">${escapeHtml(t('sessions.locked'))}</span>`
    : '';
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
  if (s.status === 'dormant') return 'idle';
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

export function restartConfirmMessage(s: any): string {
  const status = String(s.status ?? 'unknown');
  const cli = String(s.cliId ?? 'unknown');
  const sep = ui.locale === 'zh' ? '：' : ': ';
  return [
    t('sessions.restartConfirmIntro'),
    '',
    `${t('sessions.restartConfirmStatus')}${sep}${sessionStatusText(status)}`,
    `${t('sessions.restartConfirmCli')}${sep}${cli}`,
    '',
    t('sessions.restartConfirmQuestion'),
  ].join('\n');
}

export function canRestartSession(s: any): boolean {
  return s.status !== 'closed' && !s.adopt && !s.pendingRepo;
}

function pageHtml(): string {
  return `<section class="page">
    <div class="page-heading">
      <div>
        <p class="eyebrow">${t('nav.sessions')}</p>
        <h1>${t('sessions.title')}</h1>
        <p>${t('sessions.subtitle')}</p>
      </div>
      <div class="sessions-view-controls">
        <button type="button" id="create-session-btn" class="primary create-session-btn">＋ ${t('sessions.create.button')}</button>
        <span id="kanban-team-stats" class="kanban-team-stats" hidden></span>
        <select id="kanban-team" class="kanban-team-select" aria-label="${t('sessions.kanban.groupTeam')}" hidden></select>
        <div class="segmented kanban-groupby" id="kanban-groupby" role="group" aria-label="${t('sessions.kanban.groupBy')}" hidden>
          <button type="button" data-groupby="flow">${t('sessions.kanban.groupFlow')}</button>
          <button type="button" data-groupby="team">${t('sessions.kanban.groupTeam')}</button>
          <button type="button" data-groupby="bot">${t('sessions.kanban.groupBot')}</button>
        </div>
        <div class="segmented sessions-view-toggle" role="group" aria-label="${t('sessions.viewMode')}">
          <button type="button" data-view="kanban">${t('sessions.viewKanban')}</button>
          <button type="button" data-view="board">${t('sessions.viewBoard')}</button>
          <button type="button" data-view="table">${t('sessions.viewTable')}</button>
        </div>
      </div>
    </div>
    <form id="filters" class="filters sessions-filters">
      <input type="search" name="q" placeholder="${t('sessions.search')}" />
      <select name="status">
        <option value="">${t('sessions.anyStatus')}</option>
        ${SESSION_STATUS_OPTIONS.map(status => `<option value="${escapeHtml(status)}">${escapeHtml(sessionStatusText(status))}</option>`).join('')}
      </select>
      <select name="adopt">
        <option value="">${t('sessions.adoptAny')}</option>
        <option value="yes">${t('sessions.adoptYes')}</option>
        <option value="no">${t('sessions.adoptNo')}</option>
      </select>
      ${renderCliFilterGroup()}
      <label class="filter-toggle"><input type="checkbox" name="active" checked> <span>${t('sessions.activeOnly')}</span></label>
    </form>
    <div id="idle-cleanup-bar" class="idle-cleanup-bar">
      <div class="idle-cleanup-summary">
        <span class="idle-cleanup-dot" aria-hidden="true"></span>
        <span id="idle-cleanup-count" class="idle-cleanup-count"></span>
      </div>
      <div class="idle-cleanup-controls">
        <span class="idle-cleanup-label">${t('sessions.idleCleanupOlderThan')}</span>
        <div id="idle-cleanup-threshold" class="idle-cleanup-thresholds" role="group" aria-label="${t('sessions.idleCleanupThreshold')}">
          ${IDLE_CLEANUP_HOUR_OPTIONS.map(hours => `<button type="button" data-hours="${hours}" aria-pressed="${hours === 24 ? 'true' : 'false'}">${hours === 168 ? '7d' : `${hours}H`}</button>`).join('')}
        </div>
        <button type="button" id="idle-cleanup-run" class="contrast idle-cleanup-run">${t('sessions.idleCleanupRun')}</button>
      </div>
      <span id="idle-cleanup-status" class="idle-cleanup-status" aria-live="polite"></span>
    </div>
    <div id="bulk-bar" class="bulk-bar" hidden>
      <span id="bulk-count"></span>
      <button type="button" id="bulk-lock">${t('sessions.lockSelected')}</button>
      <button type="button" id="bulk-unlock">${t('sessions.unlockSelected')}</button>
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
    <div id="sessions-kanban" class="sessions-kanban" hidden></div>
    <dialog id="drawer"></dialog>
    <dialog id="term-modal" class="term-modal"></dialog>
    <dialog id="history-modal" class="history-modal"></dialog>
    <dialog id="create-session-modal" class="create-session-modal"></dialog>
  </section>`;
}

// ─── 创建会话 modal ──────────────────────────────────────────────────────────

interface PickerBot { larkAppId: string; botName: string; }

async function fetchPickerBots(): Promise<PickerBot[]> {
  try {
    const r = await fetch('/api/groups');
    if (!r.ok) return [];
    const data = await r.json();
    const bots = Array.isArray(data?.bots) ? data.bots : [];
    return bots
      .filter((b: any) => b && typeof b.larkAppId === 'string')
      .map((b: any) => ({ larkAppId: b.larkAppId, botName: typeof b.botName === 'string' && b.botName ? b.botName : b.larkAppId }));
  } catch { return []; }
}

function renderCreateSessionForm(bots: PickerBot[]): string {
  const botRows = bots.map(b => `
    <label class="cs-bot"><input type="checkbox" name="bot" value="${escapeHtml(b.larkAppId)}"> <span>${escapeHtml(b.botName)}</span></label>`).join('');
  return `
    <article class="cs-card">
      <header><h3>${t('sessions.create.title')}</h3></header>
      <form id="cs-form">
        <label class="form-row">
          <span>${t('sessions.create.content')}</span>
          <textarea name="content" rows="5" placeholder="${escapeHtml(t('sessions.create.contentPlaceholder'))}" required></textarea>
        </label>
        <fieldset class="cs-bots">
          <legend>${t('sessions.create.bots')}</legend>
          ${botRows || `<p class="cs-empty">${t('sessions.create.noBots')}</p>`}
        </fieldset>
        <fieldset class="cs-mode">
          <legend>${t('sessions.create.mode')}</legend>
          <label><input type="radio" name="mode" value="lead" checked> ${t('sessions.create.modeLead')}</label>
          <label><input type="radio" name="mode" value="all"> ${t('sessions.create.modeAll')}</label>
          <small>${t('sessions.create.modeHelp')}</small>
        </fieldset>
        <div class="cs-lead-row form-row" hidden>
          <span>${t('sessions.create.lead')}</span>
          <select name="lead"></select>
          <small>${t('sessions.create.leadHelp')}</small>
        </div>
        <fieldset class="cs-column">
          <legend>${t('sessions.create.column')}</legend>
          <label><input type="radio" name="column" value="in_progress" checked> ${t('sessions.create.columnInProgress')}</label>
          <label><input type="radio" name="column" value="backlog"> ${t('sessions.create.columnBacklog')}</label>
          <small>${t('sessions.create.columnHelp')}</small>
        </fieldset>
        <details class="cs-advanced">
          <summary>${t('sessions.create.advanced')}</summary>
          <label class="form-row">
            <span>${t('sessions.create.groupName')}</span>
            <input type="text" name="name" maxlength="60" placeholder="${escapeHtml(t('sessions.create.groupNamePlaceholder'))}">
          </label>
          <label class="form-row">
            <span>${t('sessions.create.workingDir')}</span>
            <input type="text" name="bindWorkingDir" placeholder="e.g. ~/projects/foo">
            <small>${t('sessions.create.workingDirHelp')}</small>
          </label>
        </details>
        <div class="actions cs-actions">
          <button type="submit" class="primary">${t('sessions.create.submit')}</button>
          <button type="button" id="cs-cancel">${t('sessions.create.cancel')}</button>
        </div>
      </form>
    </article>`;
}

function setupCreateSessionModal(modal: HTMLDialogElement, btn: HTMLButtonElement): void {
  btn.onclick = async () => {
    btn.disabled = true;
    try {
      const bots = await fetchPickerBots();
      if (bots.length === 0) { alert(t('sessions.create.noBots')); return; }
      modal.innerHTML = renderCreateSessionForm(bots);
      modal.showModal();
      wireCreateSessionForm(modal, bots);
    } finally {
      btn.disabled = false;
    }
  };
}

function wireCreateSessionForm(modal: HTMLDialogElement, bots: PickerBot[]): void {
  const form = modal.querySelector<HTMLFormElement>('#cs-form')!;
  const leadRow = modal.querySelector<HTMLElement>('.cs-lead-row')!;
  const leadSelect = modal.querySelector<HTMLSelectElement>('select[name=lead]')!;
  const nameOf = (id: string) => bots.find(b => b.larkAppId === id)?.botName ?? id;

  const checkedBotIds = (): string[] =>
    Array.from(form.querySelectorAll<HTMLInputElement>('input[name=bot]:checked')).map(i => i.value);
  const currentMode = (): string =>
    (form.querySelector<HTMLInputElement>('input[name=mode]:checked')?.value) ?? 'all';

  // lead 下拉只列「已勾选」的 bot；勾选/模式变化时重建，尽量保留原选中项。
  function repopulateLead(): void {
    const ids = checkedBotIds();
    const prev = leadSelect.value;
    // 没勾选任何机器人时，空 <select> 会渲染成一个空白小框，看着像 bug——给一个
    // 禁用的占位项并禁用整个选择器，提示先去上面勾选。
    if (ids.length === 0) {
      leadSelect.innerHTML = `<option value="" disabled selected>${escapeHtml(t('sessions.create.leadPickFirst'))}</option>`;
      leadSelect.disabled = true;
      return;
    }
    leadSelect.disabled = false;
    leadSelect.innerHTML = ids.map(id => `<option value="${escapeHtml(id)}">${escapeHtml(nameOf(id))}</option>`).join('');
    if (ids.includes(prev)) leadSelect.value = prev;
  }
  function syncMode(): void {
    if (currentMode() === 'lead') { leadRow.hidden = false; repopulateLead(); }
    else { leadRow.hidden = true; }
  }

  form.querySelectorAll<HTMLInputElement>('input[name=mode]').forEach(r => r.addEventListener('change', syncMode));
  form.querySelectorAll<HTMLInputElement>('input[name=bot]').forEach(c => c.addEventListener('change', () => {
    if (currentMode() === 'lead') repopulateLead();
  }));
  // 按默认模式(Lead 分配)初始化 Lead 行的显隐——一起开工时整行不展示。
  syncMode();
  modal.querySelector<HTMLButtonElement>('#cs-cancel')!.onclick = () => modal.close();

  form.onsubmit = async ev => {
    ev.preventDefault();
    const fd = new FormData(form);
    const content = ((fd.get('content') as string) ?? '').trim();
    const larkAppIds = checkedBotIds();
    const mode = currentMode();
    const column = ((fd.get('column') as string) ?? 'in_progress');
    const name = ((fd.get('name') as string) ?? '').trim();
    const bindWorkingDir = ((fd.get('bindWorkingDir') as string) ?? '').trim();
    const leadLarkAppId = ((fd.get('lead') as string) ?? '');
    if (!content) { alert(t('sessions.create.errContent')); return; }
    if (larkAppIds.length === 0) { alert(t('sessions.create.errNoBot')); return; }
    if (mode === 'lead' && (!leadLarkAppId || !larkAppIds.includes(leadLarkAppId))) { alert(t('sessions.create.errLead')); return; }
    const submitBtn = form.querySelector<HTMLButtonElement>('button[type=submit]');
    if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = t('sessions.create.submitting'); }
    try {
      const r = await fetch('/api/sessions/create', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          content, larkAppIds, mode, column,
          leadLarkAppId: mode === 'lead' ? leadLarkAppId : undefined,
          name: name || undefined,
          bindWorkingDir: bindWorkingDir || undefined,
        }),
      });
      const body = await r.json().catch(() => null);
      if (r.ok && body?.ok) {
        renderCreateSessionSuccess(modal, body);
      } else if (r.status !== 401) {
        alert(`${t('sessions.create.failed')}: ${body?.error ?? r.status}`);
        if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = t('sessions.create.submit'); }
      }
    } catch (e) {
      alert(`${t('sessions.create.failed')}: ${e}`);
      if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = t('sessions.create.submit'); }
    }
  };
}

function renderCreateSessionSuccess(modal: HTMLDialogElement, body: any): void {
  const link = typeof body.shareLink === 'string' && body.shareLink ? body.shareLink : '';
  const failedN = Array.isArray(body.failed) ? body.failed.length : 0;
  const spawnedN = Array.isArray(body.spawned) ? body.spawned.length : 0;
  const colNote = body.column === 'backlog' ? t('sessions.create.doneBacklog') : t('sessions.create.doneInProgress');
  const failNote = failedN > 0 ? `<p class="cs-warn">${t('sessions.create.partialFail', { n: String(failedN) })}</p>` : '';
  modal.innerHTML = `
    <article class="cs-card">
      <header><h3>${t('sessions.create.doneTitle')}</h3></header>
      <p>${escapeHtml(colNote)}（${spawnedN}）</p>
      ${failNote}
      ${link ? `<p><a href="${escapeHtml(link)}" target="_blank" rel="noopener">${t('sessions.create.openChat')}</a></p>` : ''}
      <div class="actions"><button type="button" id="cs-done" class="primary">${t('sessions.create.close')}</button></div>
    </article>`;
  modal.querySelector<HTMLButtonElement>('#cs-done')!.onclick = () => modal.close();
}

export function renderSessionsPage(root: HTMLElement): () => void {
  root.innerHTML = pageHtml();
  return wireSessionsPage(root);
}

export function wireSessionsPage(root: HTMLElement): () => void {
  const tbody = root.querySelector<HTMLElement>('#sessions-table tbody')!;
  const filtersForm = root.querySelector<HTMLFormElement>('#filters')!;
  const drawer = root.querySelector<HTMLDialogElement>('#drawer')!;
  const selectAllBox = root.querySelector<HTMLInputElement>('#select-all')!;
  const bulkBar = root.querySelector<HTMLElement>('#bulk-bar')!;
  const bulkCountSpan = root.querySelector<HTMLElement>('#bulk-count')!;
  const bulkLockBtn = root.querySelector<HTMLButtonElement>('#bulk-lock')!;
  const bulkUnlockBtn = root.querySelector<HTMLButtonElement>('#bulk-unlock')!;
  const bulkCloseBtn = root.querySelector<HTMLButtonElement>('#bulk-close')!;
  const bulkClearBtn = root.querySelector<HTMLButtonElement>('#bulk-clear')!;
  const idleCleanupBar = root.querySelector<HTMLElement>('#idle-cleanup-bar')!;
  const idleCleanupThreshold = root.querySelector<HTMLElement>('#idle-cleanup-threshold')!;
  const idleCleanupBtn = root.querySelector<HTMLButtonElement>('#idle-cleanup-run')!;
  const idleCleanupCount = root.querySelector<HTMLElement>('#idle-cleanup-count')!;
  const idleCleanupStatus = root.querySelector<HTMLElement>('#idle-cleanup-status')!;
  const table = root.querySelector<HTMLTableElement>('#sessions-table')!;
  const board = root.querySelector<HTMLElement>('#sessions-board')!;
  const kanban = root.querySelector<HTMLElement>('#sessions-kanban')!;
  const termModal = root.querySelector<HTMLDialogElement>('#term-modal')!;
  const historyModal = root.querySelector<HTMLDialogElement>('#history-modal')!;
  const groupByBox = root.querySelector<HTMLElement>('#kanban-groupby')!;
  const teamSelect = root.querySelector<HTMLSelectElement>('#kanban-team')!;
  const teamStats = root.querySelector<HTMLElement>('#kanban-team-stats')!;
  const viewButtons = root.querySelectorAll<HTMLButtonElement>('.sessions-view-toggle [data-view]');
  const createSessionBtn = root.querySelector<HTMLButtonElement>('#create-session-btn')!;
  const createSessionModal = root.querySelector<HTMLDialogElement>('#create-session-modal')!;
  setupCreateSessionModal(createSessionModal, createSessionBtn);

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
  let lastKanbanHtml = '';
  let boardAnimated = false;
  // 看板交互态：拖拽中的卡片 id / 标题就地编辑中 —— 两者期间都跳过看板重绘，
  // 否则 SSE 触发的 innerHTML 重建会把拖拽源/输入框拍没。
  let kanbanDragId: string | null = null;
  let kanbanEditing = false;
  // 单击开终端 vs 双击改标题的仲裁：单击延迟 220ms 执行，双击先到就取消。
  let kanbanOpenTimer: ReturnType<typeof setTimeout> | null = null;
  // 上次渲染时每列的有序行（聚簇后的视觉平铺顺序）—— drop 落点据此找相邻卡片
  // 算持久化位置。
  let lastKanbanGroups = new Map<SessionKanbanColumn, any[]>();
  // 看板分组维度：flow=工作流五列（可拖拽）；team=选定团队的工作流看板（含
  // 团队内所有 bot 的会话，可拖拽）；bot=机器人视角列（只读总览）
  let kanbanGroupBy: KanbanGroupBy = readStoredKanbanGroupBy(window.localStorage);
  // 整簇拖拽：拖群组容器头部时记录 (chatId, 源列)，drop 时整组搬运
  let kanbanDragClusterChat: string | null = null;
  let kanbanDragClusterCol: SessionKanbanColumn | null = null;
  // 团队清单（groupBy='team' 首次激活时懒加载：本地托管团队 + 远程 roster）。
  // botNames 用来与 /introduce 记录的外部 bot 按名字匹配（introduce 只留
  // openId+name，而 open_id 是 app-scoped 的，名字是两边唯一的公共标识）。
  let kanbanTeams: Array<{
    key: string;
    label: string;
    botIds: Set<string>;
    botNames: Set<string>;
    groupChats: Set<string>;
  }> = [];
  // 群 → { 在场自家 bot 集合, introduce 过的外部 bot 名字集合 }（/api/groups）。
  let kanbanChatBots: Map<string, { botIds: Set<string>; observedNames: Set<string> }> | null = null;
  let kanbanTeamsLoaded = false;
  let kanbanTeamsLoading = false;
  let kanbanTeamKey: string = (() => {
    try { return window.localStorage.getItem(KANBAN_TEAM_STORAGE_KEY) ?? ''; } catch { return ''; }
  })();
  let idleCleanupBusy = false;
  let idleCleanupHours: IdleCleanupHours = 24;

  function selectedIdleCleanupHours(): IdleCleanupHours {
    return idleCleanupHours;
  }

  function idleCleanupLabel(hours: IdleCleanupHours): string {
    return hours === 168 ? '7d' : `${hours}H`;
  }

  /** Chat IDs that belong to `team` in the kanban "team" view — the same
   *  whitelist renderKanban uses to narrow the board (team-bound group chats +
   *  groups where a same-team bot was /introduce'd). Extracted so idle cleanup
   *  can scope to exactly what the team board shows. */
  function teamChatIdsFor(team: any): Set<string> {
    const teamChats = new Set<string>();
    if (!team) return teamChats;
    for (const chatId of team.groupChats) teamChats.add(chatId);
    if (kanbanChatBots) {
      for (const [chatId, c] of kanbanChatBots) {
        if (teamChats.has(chatId)) continue;
        let hasTeamBot = false;
        for (const id of team.botIds) {
          if (c.botIds.has(id)) { hasTeamBot = true; break; }
        }
        if (!hasTeamBot) continue;
        for (const n of c.observedNames) {
          if (team.botNames.has(n)) { teamChats.add(chatId); break; }
        }
      }
    }
    return teamChats;
  }

  /** Local rows actually visible in the current view — the basis for idle
   *  cleanup so "所见即所关" holds everywhere. Table/board and kanban
   *  (by-status / by-bot) render the full `filtered()` set; only the team
   *  kanban narrows further to the selected team's chats AND overlays remote
   *  rows from other deployments (which this dashboard can't close). Mirror the
   *  team narrowing and never include remote rows. */
  function currentCleanupVisibleRows(): any[] {
    const rows = filtered();
    if (viewMode === 'kanban' && kanbanGroupBy === 'team') {
      const team = kanbanTeams.find(tm => tm.key === kanbanTeamKey) ?? kanbanTeams[0];
      const teamChats = teamChatIdsFor(team);
      return rows.filter(r => teamChats.has(String(r.chatId)));
    }
    return rows;
  }

  function currentIdleCleanupCandidates(): any[] {
    // Scope to the rows actually visible in the current view (WYSIWYG): the
    // count, the confirm dialog, and the sessionIds we POST all describe exactly
    // what the operator sees — never other bots'/teams' sessions off-screen.
    return selectIdleCleanupCandidates(currentCleanupVisibleRows(), selectedIdleCleanupHours());
  }

  function paintIdleCleanupThresholds(): void {
    idleCleanupThreshold.querySelectorAll<HTMLButtonElement>('button[data-hours]').forEach(btn => {
      const active = parseIdleCleanupHours(btn.dataset.hours) === idleCleanupHours;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
  }

  async function loadKanbanTeams(): Promise<void> {
    if (kanbanTeamsLoading || kanbanTeamsLoaded) return;
    kanbanTeamsLoading = true;
    try {
      const [hosted, remote, groups] = await Promise.all([
        fetch('/api/team/hosted').then(r => r.json()).catch(() => null),
        fetch('/api/team/remote-roster').then(r => r.json()).catch(() => null),
        fetch('/api/groups').then(r => r.json()).catch(() => null),
      ]);
      if (Array.isArray(groups?.chats)) {
        kanbanChatBots = new Map(groups.chats.map((c: any) => [
          String(c.chatId),
          {
            botIds: new Set<string>((c.memberBots ?? []).filter((mb: any) => mb.inChat).map((mb: any) => String(mb.larkAppId))),
            observedNames: new Set<string>((c.observedBotNames ?? []).map((n: any) => String(n))),
          },
        ]));
      }
      const rosterBots = (bots: any[]): { ids: Set<string>; names: Set<string> } => ({
        ids: new Set<string>(bots.map((b: any) => String(b.larkAppId))),
        names: new Set<string>(bots.map((b: any) => String(b.name ?? '')).filter(Boolean)),
      });
      const teams: typeof kanbanTeams = [];
      for (const tm of hosted?.teams ?? []) {
        const { ids, names } = rosterBots(tm.bots ?? []);
        teams.push({
          key: `local:${tm.teamId}`,
          label: tm.isDefault ? t('team.myHostedTeam') : String(tm.name ?? tm.teamId),
          botIds: ids,
          botNames: names,
          groupChats: new Set<string>((tm.groupChatIds ?? []).map((c: any) => String(c))),
        });
      }
      for (const m of remote?.memberships ?? []) {
        const { ids, names } = rosterBots(m.roster?.bots ?? []);
        teams.push({
          key: `${m.hubUrl}::${m.teamId}`,
          label: String(m.teamName ?? m.teamId ?? m.hubUrl),
          botIds: ids,
          botNames: names,
          // 远程团队发起的协作群绑定记录在 hub 侧，spoke 暂取不到
          groupChats: new Set<string>(),
        });
      }
      kanbanTeams = teams;
    } finally {
      kanbanTeamsLoaded = true;
      kanbanTeamsLoading = false;
    }
    if (kanbanTeams.length && !kanbanTeams.some(tm => tm.key === kanbanTeamKey)) {
      kanbanTeamKey = kanbanTeams[0].key;
    }
    delete teamSelect.dataset.loading;
    teamSelect.disabled = kanbanTeams.length === 0;
    teamSelect.innerHTML = kanbanTeams.length
      ? kanbanTeams.map(tm => `<option value="${escapeHtml(tm.key)}"${tm.key === kanbanTeamKey ? ' selected' : ''}>${escapeHtml(tm.label)}</option>`).join('')
      : `<option value="">${escapeHtml(t('sessions.kanban.noTeam'))}</option>`;
    lastKanbanHtml = '';
    rerender();
  }

  // ── hub 团队看板（共享编排 + 对方部署会话快照）────────────────────────────
  // 编排存团队 host：托管团队读本地 /api/team/board/local/<id>，加入的远程团队
  // 经 spoke 代理 /api/team/remote-board 到 hub。30s 软刷新。
  let kanbanTeamBoardData: { board: Record<string, { column: string; position: number }>; remoteRows: any[] } | null = null;
  let kanbanTeamBoardKey = '';
  let kanbanTeamBoardFetchedAt = 0;
  let kanbanTeamBoardLoading = false;
  // 对方部署的行不在 store 里——拖拽落点查这里
  let kanbanRemoteRows = new Map<string, any>();

  async function ensureTeamBoard(team: { key: string }): Promise<void> {
    const fresh = kanbanTeamBoardKey === team.key && Date.now() - kanbanTeamBoardFetchedAt < 30_000;
    if (kanbanTeamBoardLoading || fresh) return;
    kanbanTeamBoardLoading = true;
    try {
      const isLocal = team.key.startsWith('local:');
      const u = isLocal
        ? `/api/team/board/local/${encodeURIComponent(team.key.slice('local:'.length))}`
        : `/api/team/remote-board?key=${encodeURIComponent(team.key)}`;
      const r = await fetch(u);
      const body = await r.json().catch(() => ({}));
      if (!r.ok || body?.ok === false) return;
      const myDeploymentId = typeof body.deploymentId === 'string' ? body.deploymentId : null;
      const remoteRows: any[] = [];
      kanbanRemoteRows = new Map();
      for (const rep of Array.isArray(body.reports) ? body.reports : []) {
        // 远程团队的响应里含自己部署的上报——本地行走实时 store，跳过
        if (myDeploymentId && rep.deploymentId === myDeploymentId) continue;
        for (const s of Array.isArray(rep.sessions) ? rep.sessions : []) {
          const row = { ...s, remoteDeployment: rep.deploymentName || rep.deploymentId };
          remoteRows.push(row);
          kanbanRemoteRows.set(String(s.sessionId), row);
        }
      }
      kanbanTeamBoardData = {
        board: body.board && typeof body.board === 'object' ? body.board : {},
        remoteRows,
      };
      kanbanTeamBoardKey = team.key;
      kanbanTeamBoardFetchedAt = Date.now();
      lastKanbanHtml = '';
      rerender();
    } catch {
      // 拉不到 hub 看板时退化为只看本地行
    } finally {
      kanbanTeamBoardLoading = false;
    }
  }

  /** 团队看板拖拽落盘：写 host 的共享编排（不动会话的个人看板字段）。 */
  async function persistTeamBoardMove(
    teamKey: string,
    sessionId: string,
    column: SessionKanbanColumn,
    position: number,
    prevEntry: { column: string; position: number } | undefined,
  ): Promise<void> {
    try {
      const isLocal = teamKey.startsWith('local:');
      const r = isLocal
        ? await fetch(`/api/team/board/local/${encodeURIComponent(teamKey.slice('local:'.length))}/move`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId, column, position }),
          })
        : await fetch('/api/team/remote-board-move', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ key: teamKey, sessionId, column, position }),
          });
      const body = await r.json().catch(() => ({}));
      if (!r.ok || body?.ok === false) {
        if (kanbanTeamBoardData) {
          if (prevEntry) kanbanTeamBoardData.board[sessionId] = prevEntry;
          else delete kanbanTeamBoardData.board[sessionId];
        }
        lastKanbanHtml = '';
        rerender();
        if (r.status !== 401) alert(`${t('sessions.kanban.moveFail')}: ${body?.error ?? r.status}`);
      }
    } catch (e) {
      if (kanbanTeamBoardData) {
        if (prevEntry) kanbanTeamBoardData.board[sessionId] = prevEntry;
        else delete kanbanTeamBoardData.board[sessionId];
      }
      lastKanbanHtml = '';
      rerender();
      alert(`${t('sessions.kanban.moveFail')}: ${e}`);
    }
  }

  /** 团队模式拖拽的统一落点：乐观写本地缓存的共享编排 + POST host。 */
  function applyTeamBoardMove(sessionId: string, column: SessionKanbanColumn, position: number): void {
    const team = kanbanTeams.find(tm => tm.key === kanbanTeamKey) ?? kanbanTeams[0];
    if (!team) return;
    if (!kanbanTeamBoardData || kanbanTeamBoardKey !== team.key) {
      // 首次拉取尚未完成也允许拖：先建本地空编排缓存，写入照常进行
      kanbanTeamBoardData = { board: {}, remoteRows: kanbanTeamBoardData?.remoteRows ?? [] };
      kanbanTeamBoardKey = team.key;
    }
    const prev = kanbanTeamBoardData.board[sessionId];
    kanbanTeamBoardData.board[sessionId] = { column, position };
    void persistTeamBoardMove(team.key, sessionId, column, position, prev);
  }

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
      <td>${statusBadgeHtml(s.status)}${lockChipHtml(s)}</td>
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
    return `<a class="card-act" href="${escapeHtml(s.feishuChatLink)}" target="_blank" rel="noopener" title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}">${ICON.feishu}</a>`;
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
    return `<article class="session-card${isSelected ? ' selected' : ''}${s.locked ? ' locked' : ''}" data-id="${escapeHtml(s.sessionId)}" aria-pressed="${isSelected}">
      <div class="session-card-top">
        ${botAvatarHtml({ name: botName, larkAppId: s.larkAppId, size: 'sm' })}
        <div class="session-card-title">
          <strong title="${escapeHtml(String(s.title ?? title))}">${escapeHtml(String(title).slice(0, 72))}</strong>
          <span>${escapeHtml(botName)} · ${escapeHtml(chatTitle ?? s.cliId ?? 'unknown')}</span>
        </div>
        <span class="session-card-status-group">
          ${statusBadgeHtml(s.status)}
          ${lockChipHtml(s)}
        </span>
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
        ${canRestartSession(s) ? cardActBtn('restart', ICON.restart, t('sessions.restart')) : ''}
        ${terminalControlsHtml(terminal)}
        ${cardActBtn('lock', s.locked ? ICON.unlock : ICON.lock, lockActionLabel(s), s.locked ? 'locked' : '')}
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

  // ── 看板视图卡片 ─────────────────────────────────────────────────────────
  // 卡片整体即点击目标：单击开页面内终端弹窗；铅笔改标题；「详情」进抽屉；
  // 整卡可拖拽换列/排序。
  function kanbanCardHtml(s: any): string {
    const title = stripMentionPrefix(s.title) || s.sessionId;
    const botName = botDisplayName(s);
    const chatTitle = chatDisplayTitle(s);
    const repo = repoBasename(s.workingDir);
    const signal = boardSignalLabel(s);
    const desc = [chatTitle, repo !== '-' ? repo : null].filter(Boolean).join(' · ');
    const status = String(s.status ?? 'unknown');
    // 对方部署的会话：数据是 host 快照，终端/历史/改名都在对方机器上做不了——
    // 只保留状态点与部署来源徽章，卡片仍可拖（团队共享编排）。
    const remote = typeof s.remoteDeployment === 'string' ? s.remoteDeployment : '';
    return `<article class="kanban-card${remote ? ' kanban-card-remote' : ''}${s.locked ? ' locked' : ''}" data-id="${escapeHtml(s.sessionId)}" tabindex="0" role="button" draggable="true">
      <div class="kanban-card-top">
        <span class="badge cli-${cssToken(s.cliId)}">${escapeHtml(s.cliId ?? 'unknown')}</span>
        ${s.adopt ? '<span class="badge">adopt</span>' : ''}
        ${lockChipHtml(s)}
        ${remote ? `<span class="badge kanban-remote-badge" title="${escapeHtml(t('sessions.kanban.remoteHint', { name: remote }))}">${escapeHtml(remote)}</span>` : ''}
        <span class="kanban-card-top-right">
          <span class="kanban-card-dot" data-status="${escapeHtml(cssToken(status))}" title="${escapeHtml(sessionStatusText(status))}"></span>
          ${remote ? '' : `<button type="button" class="card-act kanban-card-act" data-action="history" title="${escapeHtml(t('sessions.history.title'))}" aria-label="${escapeHtml(t('sessions.history.title'))}">${ICON.history}</button>
          ${s.feishuChatLink ? `<a class="card-act kanban-card-act" href="${escapeHtml(s.feishuChatLink)}" target="_blank" rel="noopener" title="${escapeHtml(t('sessions.kanban.openFeishu'))}" aria-label="${escapeHtml(t('sessions.kanban.openFeishu'))}">${ICON.feishu}</a>` : ''}
          <button type="button" class="card-act kanban-card-act${s.locked ? ' locked' : ''}" data-action="lock" title="${escapeHtml(lockActionLabel(s))}" aria-label="${escapeHtml(lockActionLabel(s))}">${s.locked ? ICON.unlock : ICON.lock}</button>
          <button type="button" class="card-act kanban-card-act" data-action="details" title="${escapeHtml(t('sessions.details'))}" aria-label="${escapeHtml(t('sessions.details'))}">${ICON.details}</button>
          ${canRestartSession(s) ? `<button type="button" class="card-act kanban-card-act" data-action="restart" title="${escapeHtml(t('sessions.restart'))}" aria-label="${escapeHtml(t('sessions.restart'))}">${ICON.restart}</button>` : ''}`}
        </span>
      </div>
      <p class="kanban-card-title" title="${escapeHtml(String(s.title ?? title))}">${escapeHtml(String(title).slice(0, 140))}</p>
      ${desc ? `<p class="kanban-card-desc" title="${escapeHtml(desc)}">${escapeHtml(desc)}</p>` : ''}
      ${signal ? `<div class="session-signal" title="${escapeHtml(signal)}">${escapeHtml(signal)}</div>` : ''}
      <div class="kanban-card-foot">
        <span class="kanban-card-owner">${botAvatarHtml({ name: botName, larkAppId: s.larkAppId, size: 'sm' })}<span>${escapeHtml(botName)}</span></span>
        <span class="kanban-card-updated">${escapeHtml(t('sessions.kanban.updated', { time: relTime(s.lastMessageAt) }))}</span>
      </div>
    </article>`;
  }

  /** 列内同群聚合：≥2 张同 chatId 的卡片折成群组容器（群头像 + 群名 + 计数），
   *  一眼看出它们关联同一个群/话题群；簇按首个成员出现位置参与列内排序。
   *  返回聚簇后 HTML 与视觉平铺顺序（drop 落点据此算相邻位置）。 */
  function clusteredListHtml(columnRows: any[]): { html: string; flat: any[] } {
    const order: Array<{ chatId: string; rows: any[] }> = [];
    const byChat = new Map<string, { chatId: string; rows: any[] }>();
    for (const r of columnRows) {
      const key = String(r.chatId ?? r.sessionId);
      let g = byChat.get(key);
      if (!g) {
        g = { chatId: key, rows: [] };
        byChat.set(key, g);
        order.push(g);
      }
      g.rows.push(r);
    }
    const flat: any[] = [];
    const html = order.map(g => {
      flat.push(...g.rows);
      if (g.rows.length < 2) return kanbanCardHtml(g.rows[0]);
      const title = chatDisplayTitle(g.rows[0]) ?? g.chatId;
      return `<div class="kanban-cluster" data-chat="${escapeHtml(g.chatId)}">
        <header draggable="true" title="${escapeHtml(title)} · ${escapeHtml(t('sessions.kanban.clusterDragHint'))}">
          ${chatAvatarHtml({ chatId: g.chatId, name: title, size: 'sm' })}
          <span class="kanban-cluster-name">${escapeHtml(title)}</span>
          <span class="kanban-cluster-count">${g.rows.length}</span>
        </header>
        ${g.rows.map(kanbanCardHtml).join('')}
      </div>`;
    }).join('');
    return { html, flat };
  }

  /** 团队模式：列 = 团队里的每个 bot（按名字排序），卡片 = 它名下的活跃会话，
   *  按最近活跃倒序、同群聚簇。协作总览视图——不支持拖拽（会话不能换 bot）。 */
  function kanbanByBotHtml(rows: any[]): string {
    const bots = new Map<string, { name: string; larkAppId: string; rows: any[] }>();
    for (const r of rows) {
      if (r.status === 'closed') continue;
      const key = String(r.larkAppId || r.botName || 'unknown');
      let b = bots.get(key);
      if (!b) {
        b = { name: botDisplayName(r), larkAppId: r.larkAppId, rows: [] };
        bots.set(key, b);
      }
      b.rows.push(r);
    }
    const cols = [...bots.values()].sort((a, b) => a.name.localeCompare(b.name));
    if (!cols.length) return `<div class="kanban-col-empty">${t('sessions.board.emptyColumn')}</div>`;
    return cols.map(col => {
      const colRows = col.rows.sort((a, b) => Number(b.lastMessageAt ?? 0) - Number(a.lastMessageAt ?? 0));
      const { html: listHtml } = clusteredListHtml(colRows);
      return `<section class="kanban-column kanban-bot-col" data-bot="${escapeHtml(col.larkAppId ?? col.name)}">
        <header>
          <span class="kanban-col-avatar">${botAvatarHtml({ name: col.name, larkAppId: col.larkAppId, size: 'sm' })}</span>
          <h2>${escapeHtml(col.name)}</h2>
          <span class="kanban-col-count">${colRows.length}</span>
        </header>
        <div class="kanban-col-list">${listHtml}</div>
      </section>`;
    }).join('');
  }

  /** 工作流五列看板（flow/team 共用）：聚簇 + 拖拽落点数据。 */
  function kanbanFlowHtml(rows: any[]): string {
    const groups = new Map<SessionKanbanColumn, any[]>(KANBAN_COLUMNS.map(c => [c.id, []]));
    for (const row of rows) groups.get(deriveKanbanColumn(row))!.push(row);
    const html = KANBAN_COLUMNS.map(column => {
      let columnRows = (groups.get(column.id) ?? [])
        .sort((a, b) => effectiveKanbanPosition(a) - effectiveKanbanPosition(b));
      let hiddenCount = 0;
      if (column.id === 'done' && columnRows.length > KANBAN_DONE_CAP) {
        hiddenCount = columnRows.length - KANBAN_DONE_CAP;
        columnRows = columnRows.slice(0, KANBAN_DONE_CAP);
      }
      const { html: listHtml, flat } = clusteredListHtml(columnRows);
      groups.set(column.id, flat);
      return `<section class="kanban-column kanban-${column.id}" data-col="${column.id}">
        <header>
          <span class="kanban-col-icon">${kanbanStatusIcon(column.id)}</span>
          <h2>${escapeHtml(t(column.labelKey))}</h2>
          <span class="kanban-col-count">${columnRows.length + hiddenCount}</span>
        </header>
        <div class="kanban-col-list">
          ${columnRows.length ? listHtml : `<div class="kanban-col-empty">${t('sessions.board.emptyColumn')}</div>`}
          ${hiddenCount ? `<div class="kanban-col-more">${escapeHtml(t('sessions.kanban.moreHidden', { count: hiddenCount }))}</div>` : ''}
        </div>
      </section>`;
    }).join('');
    lastKanbanGroups = groups;
    return html;
  }

  function renderKanban(rows: any[]): void {
    // 拖拽/编辑期间冻结 DOM —— innerHTML 重建会拍掉拖拽源和输入框。
    if (kanbanDragId || kanbanDragClusterChat || kanbanEditing) return;
    kanban.classList.toggle('kanban-mode-bot', kanbanGroupBy === 'bot');
    let html: string;
    if (kanbanGroupBy === 'bot') {
      html = kanbanByBotHtml(rows);
      lastKanbanGroups = new Map(); // 机器人视角无拖拽，不需要落点数据
    } else if (kanbanGroupBy === 'team') {
      if (!kanbanTeamsLoaded) {
        html = `<div class="kanban-loading">${t('sessions.kanban.teamLoading')}</div>`;
        lastKanbanGroups = new Map();
        // 加载期间下拉显示占位项并禁用——空胶囊很难看，也防止误操作
        if (!teamSelect.dataset.loading) {
          teamSelect.dataset.loading = '1';
          teamSelect.disabled = true;
          teamSelect.innerHTML = `<option>${escapeHtml(t('sessions.kanban.teamLoading'))}</option>`;
        }
        void loadKanbanTeams();
      } else {
        const team = kanbanTeams.find(tm => tm.key === kanbanTeamKey) ?? kanbanTeams[0];
        // 「团队群」白名单（申晗定稿）：
        //   A. dashboard 团队页发起的协作群（建群时落盘的 team↔chatId 绑定）
        //   B. 群里 /introduce 过该团队成员机器人的群——介绍记录按名字与团队
        //      roster 匹配；介绍过的若不是本团队成员，不算（防误筛）
        // 命中群里所有 bot 的会话都展示（本质 = 同团队 bot 所在群/话题的会话）。
        const teamChats = teamChatIdsFor(team);
        const teamRows = team ? rows.filter(r => teamChats.has(String(r.chatId))) : [];
        // ── hub 团队看板合并（申晗架构：编排存团队 host）──────────────────────
        // 本地行（实时）+ 对方部署上报的裁剪行（host 快照）；共享编排的列/排序
        // 覆盖个人看板字段——团队视图里大家看到同一份摆放。
        if (team) void ensureTeamBoard(team);
        const board = (kanbanTeamBoardKey === team?.key ? kanbanTeamBoardData?.board : null) ?? {};
        const remoteRows = (kanbanTeamBoardKey === team?.key ? kanbanTeamBoardData?.remoteRows : null) ?? [];
        const merged = [...teamRows, ...remoteRows].map(r => {
          const e = (board as any)[r.sessionId];
          return e ? { ...r, kanbanColumn: e.column, kanbanPosition: e.position } : r;
        });
        teamStats.textContent = t('sessions.kanban.teamScope', { chats: teamChats.size, sessions: merged.length });
        html = kanbanFlowHtml(merged);
      }
    } else {
      html = kanbanFlowHtml(rows);
    }
    if (html === lastKanbanHtml) return;
    lastKanbanHtml = html;
    // innerHTML 重建会把每列列表的滚动位置归零（改名失焦/SSE 更新时列表跳回
    // 顶部）——重建前按列记录 scrollTop，重建后恢复。
    const scrollTops = new Map<string, number>();
    kanban.querySelectorAll<HTMLElement>('.kanban-col-list').forEach(el => {
      const col = el.closest<HTMLElement>('.kanban-column')?.dataset.col;
      if (col && el.scrollTop) scrollTops.set(col, el.scrollTop);
    });
    kanban.innerHTML = html;
    if (scrollTops.size) {
      kanban.querySelectorAll<HTMLElement>('.kanban-col-list').forEach(el => {
        const col = el.closest<HTMLElement>('.kanban-column')?.dataset.col;
        const top = col ? scrollTops.get(col) : undefined;
        if (top) el.scrollTop = top;
      });
    }
  }

  // ── 看板写操作：拖拽放置 / 重命名（乐观更新 + 失败回滚）────────────────────
  async function persistBoardMove(
    s: any,
    column: SessionKanbanColumn,
    position: number,
    prev: { column: unknown; position: unknown },
  ): Promise<void> {
    try {
      const r = await fetch(`/api/sessions/${encodeURIComponent(s.sessionId)}/board`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ column, position }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok || body?.ok === false) {
        s.kanbanColumn = prev.column;
        s.kanbanPosition = prev.position;
        lastKanbanHtml = '';
        rerender();
        // 401（只读访客）由全局 fetch patch 弹只读 toast，这里只负责回滚。
        if (r.status !== 401) alert(`${t('sessions.kanban.moveFail')}: ${body?.error ?? r.status}`);
      }
    } catch (e) {
      s.kanbanColumn = prev.column;
      s.kanbanPosition = prev.position;
      lastKanbanHtml = '';
      rerender();
      alert(`${t('sessions.kanban.moveFail')}: ${e}`);
    }
  }

  async function persistRename(s: any, title: string): Promise<void> {
    const prevTitle = s.title;
    s.title = title;
    lastKanbanHtml = '';
    rerender();
    try {
      const r = await fetch(`/api/sessions/${encodeURIComponent(s.sessionId)}/rename`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok || body?.ok === false) {
        s.title = prevTitle;
        lastKanbanHtml = '';
        rerender();
        if (r.status !== 401) alert(`${t('sessions.kanban.renameFail')}: ${body?.error ?? r.status}`);
      }
    } catch (e) {
      s.title = prevTitle;
      lastKanbanHtml = '';
      rerender();
      alert(`${t('sessions.kanban.renameFail')}: ${e}`);
    }
  }

  // ── 会话历史弹窗：实时拉取该会话所在飞书话题/群的消息，按聊天气泡渲染 ──────
  /** Lark create_time 是毫秒 epoch（数字或数字字符串）——直接 new Date(字符串)
   *  会得到 Invalid Date。统一转数字解析，解析不出就不显示。 */
  function historyTime(v: unknown): string {
    if (v === undefined || v === null || v === '') return '';
    const n = Number(v);
    const d = Number.isFinite(n) && n > 0 ? new Date(n) : new Date(String(v));
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleString();
  }

  function historyBubbleHtml(s: any, m: any, ownerOpenId?: string): string {
    const mine = m.senderType === 'user';
    // 后端经 contact API 补了 senderName/senderAvatar（可见范围内的真人）；
    // 拿不到回退「创建者/用户」占位 + 首字圆。
    const name = mine
      ? (m.senderName
          || (ownerOpenId && m.senderId === ownerOpenId ? t('sessions.history.owner') : t('sessions.history.user')))
      : botDisplayName(s);
    const time = historyTime(m.createTime);
    const content = String(m.content ?? '').trim() || `[${m.msgType ?? 'message'}]`;
    const avatar = mine
      ? (m.senderAvatar
          ? `<img class="history-avatar-img" src="${escapeHtml(String(m.senderAvatar))}" alt="" decoding="async" referrerpolicy="no-referrer">`
          : `<span class="history-avatar-user" aria-hidden="true">${escapeHtml(String(name).slice(0, 1))}</span>`)
      : botAvatarHtml({ name: botDisplayName(s), larkAppId: s.larkAppId, size: 'sm' });
    return `<div class="history-msg${mine ? ' mine' : ''}">
      ${avatar}
      <div class="history-msg-main">
        <div class="history-msg-meta"><span>${escapeHtml(name)}</span><time>${escapeHtml(time)}</time></div>
        <div class="history-bubble">${escapeHtml(content)}</div>
      </div>
    </div>`;
  }

  async function openHistoryModal(s: any): Promise<void> {
    const botName = botDisplayName(s);
    historyModal.innerHTML = `<div class="term-modal-head">
        <span class="term-modal-title">
          ${botAvatarHtml({ name: botName, larkAppId: s.larkAppId, size: 'sm' })}
          <strong title="${escapeHtml(String(s.title ?? ''))}">${escapeHtml((stripMentionPrefix(s.title) || s.sessionId).slice(0, 60))}</strong>
          <span class="history-scope-tag">${escapeHtml(t('sessions.history.title'))}</span>
        </span>
        <span class="term-modal-actions">
          <button type="button" id="history-close" class="card-act" title="${escapeHtml(t('sessions.dismiss'))}" aria-label="${escapeHtml(t('sessions.dismiss'))}">${ICON.close}</button>
        </span>
      </div>
      <div class="history-body"><div class="term-modal-loading">${t('sessions.history.loading')}</div></div>`;
    historyModal.showModal();
    historyModal.querySelector<HTMLButtonElement>('#history-close')!.onclick = () => historyModal.close();
    try {
      const r = await fetch(`/api/sessions/${encodeURIComponent(s.sessionId)}/history?limit=80`);
      const body = await r.json().catch(() => ({}));
      if (!historyModal.open) return;
      const bodyEl = historyModal.querySelector<HTMLElement>('.history-body')!;
      if (!r.ok || body?.ok === false) {
        const errCode = String(body?.error ?? r.status);
        // not_found_yet = dashboard 进程没有该路由；not_found = daemon 没有 ——
        // 都是进程仍跑旧 build 的特征，明示重启而不是让人猜。
        const stale = errCode === 'not_found_yet' || errCode === 'not_found';
        bodyEl.innerHTML = `<div class="history-error">${escapeHtml(t('sessions.history.fail'))}: ${escapeHtml(errCode)}${
          stale ? `<br><span>${escapeHtml(t('sessions.history.staleHint'))}</span>` : ''}</div>`;
        return;
      }
      const messages: any[] = Array.isArray(body.messages) ? body.messages : [];
      if (!messages.length) {
        bodyEl.innerHTML = `<div class="history-error">${t('sessions.history.empty')}</div>`;
        return;
      }
      bodyEl.innerHTML = `<div class="history-list">${messages.map(m => historyBubbleHtml(s, m, body.ownerOpenId)).join('')}</div>`;
      bodyEl.scrollTop = bodyEl.scrollHeight; // 默认停在最新一条
    } catch (e) {
      if (!historyModal.open) return;
      const bodyEl = historyModal.querySelector<HTMLElement>('.history-body');
      if (bodyEl) bodyEl.innerHTML = `<div class="history-error">${escapeHtml(t('sessions.history.fail'))}: ${escapeHtml(String(e))}</div>`;
    }
  }

  /** 把卡片标题就地换成输入框：Enter/失焦保存，Esc 取消。 */
  function startKanbanRename(card: HTMLElement, s: any): void {
    const titleEl = card.querySelector<HTMLElement>('.kanban-card-title');
    if (!titleEl || card.querySelector('.kanban-rename-input')) return;
    kanbanEditing = true;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'kanban-rename-input';
    input.maxLength = 200;
    input.value = stripMentionPrefix(s.title) || '';
    titleEl.replaceWith(input);
    input.focus();
    input.select();
    let settled = false;
    const finish = (commit: boolean) => {
      if (settled) return;
      settled = true;
      kanbanEditing = false;
      const next = input.value.trim();
      if (commit && next && next !== (stripMentionPrefix(s.title) || '')) {
        void persistRename(s, next);
      } else {
        lastKanbanHtml = '';
        rerender();
      }
    };
    input.addEventListener('keydown', ev => {
      ev.stopPropagation();
      if (ev.key === 'Enter') { ev.preventDefault(); finish(true); }
      else if (ev.key === 'Escape') { ev.preventDefault(); finish(false); }
    });
    input.addEventListener('blur', () => finish(true));
    input.addEventListener('click', ev => ev.stopPropagation());
  }

  /** 指针 Y 落点之下的第一张卡片（不含拖拽源）—— 新卡插它前面；null = 追加列尾。 */
  function kanbanInsertBeforeCard(column: HTMLElement, clientY: number): HTMLElement | null {
    for (const card of column.querySelectorAll<HTMLElement>('.kanban-card:not(.dragging)')) {
      // 整簇拖拽时簇内成员不能当落点参照
      if (card.closest('.kanban-cluster.dragging')) continue;
      const rect = card.getBoundingClientRect();
      if (clientY < rect.top + rect.height / 2) return card;
    }
    return null;
  }

  function clearKanbanDragMarks(): void {
    kanban.querySelectorAll('.drag-over, .dragging, .drop-before')
      .forEach(el => el.classList.remove('drag-over', 'dragging', 'drop-before'));
  }

  // 终端弹窗标题就地改名：标题文本换输入框，Enter/失焦保存、Esc 取消；
  // 复用 persistRename（乐观更新 + 失败回滚 + 全视图同步）。
  function startTermTitleEdit(s: any): void {
    const nameEl = termModal.querySelector<HTMLElement>('.term-modal-name');
    if (!nameEl || termModal.querySelector('.term-modal-name-input')) return;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'term-modal-name-input';
    input.maxLength = 200;
    input.value = stripMentionPrefix(s.title) || '';
    nameEl.replaceWith(input);
    // 宽度贴合内容：按文本实测像素宽设宽，clamp 到 [80, 60vw]，超长则到上限
    // 后内部横向滚动（与原标题省略号的「有上限」体感一致）。
    const fitInput = () => {
      const cs = getComputedStyle(input);
      const span = document.createElement('span');
      span.style.cssText = 'position:absolute;visibility:hidden;white-space:pre';
      span.style.fontSize = cs.fontSize;
      span.style.fontFamily = cs.fontFamily;
      span.style.fontWeight = cs.fontWeight;
      span.style.letterSpacing = cs.letterSpacing;
      span.textContent = input.value || ' ';
      document.body.appendChild(span);
      const w = span.offsetWidth;
      span.remove();
      const max = Math.round(window.innerWidth * 0.6);
      input.style.width = `${Math.min(Math.max(w + 22, 80), max)}px`;
    };
    fitInput();
    input.addEventListener('input', fitInput);
    input.focus();
    input.select();
    let settled = false;
    const finish = (commit: boolean) => {
      if (settled) return;
      settled = true;
      const next = input.value.trim();
      const cur = stripMentionPrefix(s.title) || '';
      if (commit && next && next !== cur) {
        s.title = next; // 弹窗内即时反映；persistRename 再发请求 + 背后 rerender
        const strong = document.createElement('strong');
        strong.className = 'term-modal-name';
        strong.title = next;
        strong.textContent = next.slice(0, 60);
        input.replaceWith(strong);
        void persistRename(s, next);
      } else {
        const strong = document.createElement('strong');
        strong.className = 'term-modal-name';
        strong.title = String(s.title ?? cur);
        strong.textContent = cur.slice(0, 60);
        input.replaceWith(strong);
      }
    };
    input.addEventListener('keydown', ev => {
      ev.stopPropagation();
      if (ev.key === 'Enter') { ev.preventDefault(); finish(true); }
      else if (ev.key === 'Escape') { ev.preventDefault(); finish(false); }
    });
    input.addEventListener('blur', () => finish(true));
  }

  // 页面内终端弹窗：默认嵌只读终端；已认证用户先 mint 可写链接（弹窗里能直接
  // 打字），拿不到再回退只读。没有 web 终端（挂起/已关闭）时退回详情抽屉。
  async function openTerminalModal(s: any): Promise<void> {
    const readonlyUrl = terminalHref(s);
    if (!readonlyUrl) {
      openDrawer(s);
      return;
    }
    const title = stripMentionPrefix(s.title) || s.sessionId;
    const feishu = s.feishuChatLink
      ? `<a class="card-act" href="${escapeHtml(s.feishuChatLink)}" target="_blank" rel="noopener" title="${escapeHtml(t('sessions.kanban.openFeishu'))}" aria-label="${escapeHtml(t('sessions.kanban.openFeishu'))}">${ICON.feishu}</a>`
      : '';
    termModal.innerHTML = `<div class="term-modal-head">
        <span class="term-modal-title">
          ${botAvatarHtml({ name: botDisplayName(s), larkAppId: s.larkAppId, size: 'sm' })}
          <strong class="term-modal-name" title="${escapeHtml(String(s.title ?? title))}">${escapeHtml(String(title).slice(0, 60))}</strong>
          <button type="button" id="term-modal-edit" class="card-act" title="${escapeHtml(t('sessions.kanban.rename'))}" aria-label="${escapeHtml(t('sessions.kanban.rename'))}">${ICON.edit}</button>
          ${statusBadgeHtml(s.status)}
        </span>
        <span class="term-modal-actions">
          ${feishu}
          <a id="term-modal-tab" class="card-act" href="${escapeHtml(readonlyUrl)}" target="_blank" rel="noopener" title="${escapeHtml(t('sessions.kanban.openTab'))}" aria-label="${escapeHtml(t('sessions.kanban.openTab'))}">${ICON.terminal}</a>
          <button type="button" id="term-modal-close" class="card-act" title="${escapeHtml(t('sessions.dismiss'))}" aria-label="${escapeHtml(t('sessions.dismiss'))}">${ICON.close}</button>
        </span>
      </div>
      <div class="term-modal-body"><div class="term-modal-loading">${t('sessions.kanban.terminalLoading')}</div></div>`;
    termModal.showModal();
    termModal.querySelector<HTMLButtonElement>('#term-modal-close')!.onclick = () => termModal.close();
    termModal.querySelector<HTMLButtonElement>('#term-modal-edit')!.onclick = () => startTermTitleEdit(s);
    let url = readonlyUrl;
    if (ui.authed) {
      try {
        const r = await fetch(`/api/sessions/${encodeURIComponent(s.sessionId)}/write-link`);
        const body = await r.json().catch(() => ({}));
        if (r.ok && body?.ok !== false && body?.url) url = body.url;
      } catch {
        // 可写链接拿不到就用只读链接，弹窗仍可观看
      }
    }
    if (!termModal.open) return; // 加载期间用户已关掉弹窗
    const bodyEl = termModal.querySelector<HTMLElement>('.term-modal-body')!;
    bodyEl.innerHTML = `<iframe class="term-modal-frame" src="${escapeHtml(url)}" allow="clipboard-read; clipboard-write"></iframe>`;
    const tab = termModal.querySelector<HTMLAnchorElement>('#term-modal-tab');
    if (tab) tab.href = url;
  }

  function filtered(): any[] {
    const f = new FormData(filtersForm);
    const q = ((f.get('q') as string) ?? '').toLowerCase();
    const cli = f.getAll('cli') as string[];
    const cliFilterActive = cli.length > 0 && cli.length < CLI_FILTER_OPTIONS.length;
    const status = f.get('status') as string;
    const adopt = f.get('adopt') as string;
    const active = !!f.get('active');
    // 看板视图的「已完成」列收纳已关闭会话——「仅活跃」开关不再把它们整体
    // 滤掉，否则该列永远是空的。
    const keepClosed = viewMode === 'kanban';
    const rows = [...store.sessions.values()]
      .filter(s => !cliFilterActive || cli.includes(s.cliId ?? 'unknown'))
      .filter(s => !status || s.status === status)
      .filter(s => !adopt || (adopt === 'yes') === !!s.adopt)
      .filter(s => !active || keepClosed || s.status !== 'closed')
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
    const selectedRows = [...selected]
      .map(id => store.sessions.get(id))
      .filter((r): r is any => !!r && r.status !== 'closed');
    bulkLockBtn.disabled = !selectedRows.some(r => !r.locked);
    bulkUnlockBtn.disabled = !selectedRows.some(r => !!r.locked);
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

  function syncIdleCleanupUi(): void {
    const count = currentIdleCleanupCandidates().length;
    idleCleanupCount.textContent = t('sessions.idleCleanupCount', { count });
    idleCleanupBtn.disabled = idleCleanupBusy || count === 0;
    // Keep the bar (and its threshold switcher) visible so the operator can
    // probe other thresholds, but drop the danger-red dot to neutral when
    // there's nothing to clean — a red alarm at 0 candidates is misleading.
    idleCleanupBar.classList.toggle('is-empty', count === 0);
    paintIdleCleanupThresholds();
  }

  function paintViewToggle(): void {
    viewButtons.forEach(btn => {
      const active = btn.dataset.view === viewMode;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-pressed', String(active));
    });
    groupByBox.hidden = viewMode !== 'kanban';
    teamSelect.hidden = !(viewMode === 'kanban' && kanbanGroupBy === 'team');
    teamStats.hidden = teamSelect.hidden || !kanbanTeamsLoaded;
    groupByBox.querySelectorAll<HTMLButtonElement>('[data-groupby]').forEach(btn => {
      const active = btn.dataset.groupby === kanbanGroupBy;
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
    const visibleRows = viewMode === 'table' ? rows : boardRows;
    table.hidden = viewMode !== 'table';
    board.hidden = viewMode !== 'board';
    kanban.hidden = viewMode !== 'kanban';
    if (viewMode === 'table') {
      const tableHtml = rows.length
        ? rows.map(rowHtml).join('')
        : `<tr><td colspan="12" class="empty">${t('sessions.empty')}</td></tr>`;
      if (tableHtml !== lastTableHtml) {
        lastTableHtml = tableHtml;
        tbody.innerHTML = tableHtml;
      }
    } else if (viewMode === 'kanban') {
      renderKanban(rows);
    } else {
      renderBoard(boardRows);
    }
    paintViewToggle();
    paintSortHeaders();
    paintCliFilterCount();
    syncBulkUi(visibleRows);
    syncIdleCleanupUi();
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

  function invalidateSessionViews(): void {
    lastBoardHtml = '';
    lastTableHtml = '';
    lastKanbanHtml = '';
  }

  async function setSessionLocked(s: any, locked: boolean, btn?: HTMLButtonElement): Promise<boolean> {
    const prev = !!s.locked;
    if (prev === locked) return true;
    s.locked = locked;
    invalidateSessionViews();
    rerender();
    if (btn) btn.disabled = true;
    try {
      const r = await fetch(`/api/sessions/${encodeURIComponent(s.sessionId)}/lock`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ locked }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok || body?.ok === false) {
        s.locked = prev;
        invalidateSessionViews();
        rerender();
        if (r.status !== 401) alert(`${t('sessions.lockFailed')}: ${body?.error ?? r.status}`);
        return false;
      }
      s.locked = !!body.locked;
      invalidateSessionViews();
      rerender();
      return true;
    } catch (e) {
      s.locked = prev;
      invalidateSessionViews();
      rerender();
      alert(`${t('sessions.lockFailed')}: ${e}`);
      return false;
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  // Per-session restart cooldown. The route returns 200 the instant the IPC is
  // sent — long before the worker's ~500ms+ respawn — so re-enabling the button
  // immediately let a second restart land inside the respawn window, which trips
  // the worker's tier-2 crash-loop guard (2 restarts before the CLI reaches its
  // prompt) and silently drops --resume, losing conversation context. This Set
  // debounces independently of the button DOM, which the table/board/kanban
  // rebuild via innerHTML on every SSE update (a DOM-only `disabled` is wiped).
  const restartCooldownIds = new Set<string>();

  async function restartSession(s: any, restartBtn?: HTMLButtonElement): Promise<boolean> {
    if (restartCooldownIds.has(s.sessionId)) return false;
    if (!confirm(restartConfirmMessage(s))) return false;
    if (restartBtn) restartBtn.disabled = true;
    try {
      const r = await fetch(`/api/sessions/${encodeURIComponent(s.sessionId)}/restart`, { method: 'POST' });
      const body = await r.json().catch(() => ({}));
      if (!r.ok || body?.ok === false) {
        if (r.status !== 401) alert(`${t('sessions.restartFailed')}: ${body?.error ?? r.status}`);
        return false;
      }
      restartCooldownIds.add(s.sessionId);
      setTimeout(() => restartCooldownIds.delete(s.sessionId), 5000);
      return true;
    } catch (e) {
      alert(`${t('sessions.restartFailed')}: ${e}`);
      return false;
    } finally {
      if (restartBtn) restartBtn.disabled = false;
    }
  }

  // ── Insight (owner-only): render a SafeInsightReport into the drawer. All
  //    free text (suggestions, span input/output summaries) is escapeHtml'd —
  //    the report is already fail-closed redacted upstream, this is defense in
  //    depth against transcript content reaching innerHTML. ──────────────────
  function insightDur(ms?: number): string {
    if (ms === undefined) return '—';
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    return `${Math.floor(ms / 60000)}m${Math.round((ms % 60000) / 1000)}s`;
  }
  function renderInsightReport(rep: any): string {
    if (!rep || (rep.status !== 'ok')) {
      const msg = rep?.error?.message ? escapeHtml(String(rep.error.message)) : escapeHtml(String(rep?.status ?? 'error'));
      return `<p>${t('sessions.insightUnavailable')}: ${msg}</p>`;
    }
    const a = rep.agg ?? {};
    if (!a.totalSpans) return `<p>${t('sessions.insightEmpty')}</p>`;
    const mut = 'color:var(--muted,#8f959e)';
    const parts: string[] = [];
    const metaBits: string[] = [];
    if (rep.meta?.asOf) metaBits.push(escapeHtml(t('sessions.insightAsOf', { asOf: String(rep.meta.asOf) })));
    if (rep.meta?.partial) metaBits.push(escapeHtml(t('sessions.insightPartial')));
    if (metaBits.length) parts.push(`<p style="font-size:12px;${mut}">${metaBits.join(' · ')}</p>`);
    parts.push(`<p>${escapeHtml(t('sessions.insightMetrics', {
      total: String(a.totalSpans ?? 0),
      failed: String(a.failedSpans ?? 0),
      slow: String(a.slowSpans ?? 0),
      rw: (a.readWriteRatio === null || a.readWriteRatio === undefined) ? '—' : String(a.readWriteRatio),
      compactions: String(a.compactions ?? 0),
    }))}</p>`);
    if (Array.isArray(rep.suggestions) && rep.suggestions.length) {
      const icon = (sev: string) => (sev === 'bad' ? '🔴' : sev === 'warn' ? '🟡' : 'ℹ️');
      const lis = rep.suggestions.map((sg: any) =>
        `<li>${icon(sg.severity)} <b>${escapeHtml(String(sg.title ?? ''))}</b> — ${escapeHtml(String(sg.action ?? ''))}`
        + (Array.isArray(sg.evidence) && sg.evidence.length ? `<br><small style="${mut}">${escapeHtml(sg.evidence.join('；'))}</small>` : '')
        + `</li>`).join('');
      parts.push(`<details open><summary>${t('sessions.insightSuggestions')}</summary><ul style="padding-left:18px;margin:6px 0">${lis}</ul></details>`);
    }
    if (Array.isArray(rep.spans) && rep.spans.length) {
      const sIcon = (st: string) => (st === 'error' ? '🔴' : st === 'running' ? '⏳' : '✅');
      const rows = [...rep.spans].sort((x: any, y: any) => (x.relStartMs ?? 0) - (y.relStartMs ?? 0)).map((sp: any) => {
        const io = [sp.inputSummary, sp.outputSummary].filter(Boolean).map((x: string) => escapeHtml(String(x))).join(' → ');
        const cls = sp.status === 'error' ? ' style="color:var(--danger,#d33)"' : '';
        return `<tr${cls}><td>${sIcon(sp.status)}</td><td><code>${escapeHtml(String(sp.tool ?? ''))}</code></td><td>${escapeHtml(String(sp.phase ?? ''))}</td><td>${insightDur(sp.durationMs)}</td><td>#${escapeHtml(String(sp.turnIndex ?? 0))}</td><td>${io}</td></tr>`;
      }).join('');
      const cap = rep.meta?.capped
        ? `<p style="font-size:12px;${mut}">${escapeHtml(t('sessions.insightCapped', { shown: String(rep.meta.spansReturned ?? rep.spans.length), total: String(rep.meta.spansTotal ?? rep.spans.length) }))}</p>`
        : '';
      parts.push(`<details><summary>${t('sessions.insightSpans')} (${rep.spans.length})</summary>${cap}<div style="max-height:320px;overflow:auto"><table style="width:100%;font-size:12px"><tbody>${rows}</tbody></table></div></details>`);
    }
    return parts.join('');
  }

  function openDrawer(s: any): void {
    const closed = s.status === 'closed';
    const terminal = terminalHref(s);
    drawer.innerHTML = `<article>
      <header>
        <h3>${escapeHtml(stripMentionPrefix(s.title) || s.sessionId)}</h3>
        <span class="drawer-status-line">
          ${statusBadgeHtml(s.status)}
          ${lockChipHtml(s)}
        </span>
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
        <button id="history-drawer-btn" type="button">${t('sessions.history.title')}</button>
        ${terminalControlsHtml(terminal)}
        ${canRestartSession(s) ? `<button id="restart-btn" type="button">${t('sessions.restart')}</button>` : ''}
        ${!closed ? `<button id="lock-btn" type="button">${escapeHtml(lockActionLabel(s))}</button>` : ''}
        ${s.queued && !closed ? `<button id="start-btn" type="button" class="primary">${t('sessions.create.start')}</button>` : ''}
        ${closed ? `<button id="resume-btn" type="button" class="primary">${t('sessions.resume')}</button>` : ''}
        ${!closed ? `<button id="close-btn" type="button" class="contrast">${t('sessions.close')}</button>` : ''}
        <button id="land-btn" type="button">${t('sessions.land')}</button>
        ${ui.authed ? `<button id="insight-btn" type="button">${t('sessions.insight')}</button>` : ''}
      </div>
      <div id="land-area"></div>
      <div id="insight-area"></div>
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

    const historyBtn = drawer.querySelector<HTMLButtonElement>('#history-drawer-btn');
    if (historyBtn) {
      historyBtn.onclick = () => void openHistoryModal(s);
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

    const restartBtn = drawer.querySelector<HTMLButtonElement>('#restart-btn');
    if (restartBtn) {
      restartBtn.onclick = async () => {
        if (await restartSession(s, restartBtn)) drawer.close();
      };
    }

    const closeBtn = drawer.querySelector<HTMLButtonElement>('#close-btn');
    if (closeBtn) {
      closeBtn.onclick = async () => {
        if (await closeSession(s, closeBtn)) drawer.close();
      };
    }

    const lockBtn = drawer.querySelector<HTMLButtonElement>('#lock-btn');
    if (lockBtn) {
      lockBtn.onclick = async () => {
        const next = !s.locked;
        if (await setSessionLocked(s, next, lockBtn)) {
          lockBtn.textContent = lockActionLabel(s);
          const line = drawer.querySelector<HTMLElement>('.drawer-status-line');
          if (line) {
            line.innerHTML = `${statusBadgeHtml(s.status)}${lockChipHtml(s)}`;
          }
        }
      };
    }

    // 待办池会话「开始」：激活 parked 会话（发首轮、起 CLI）。
    const startBtn = drawer.querySelector<HTMLButtonElement>('#start-btn');
    if (startBtn) {
      startBtn.onclick = async () => {
        startBtn.disabled = true;
        try {
          const r = await fetch(`/api/sessions/${encodeURIComponent(s.sessionId)}/start`, { method: 'POST' });
          const body = await r.json().catch(() => ({}));
          if (!r.ok || body.ok === false) {
            if (r.status !== 401) alert(`${t('sessions.create.startFailed')}: ${body?.error ?? r.status}`);
            startBtn.disabled = false;
            return;
          }
          drawer.close();
        } catch (e) {
          alert(`${t('sessions.create.startFailed')}: ${e}`);
          startBtn.disabled = false;
        }
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

    // Insight (owner-only — button only rendered when ui.authed). Fetches the
    // SafeInsightReport with span detail and renders agg + suggestions + spans.
    const insightBtn = drawer.querySelector<HTMLButtonElement>('#insight-btn');
    const insightArea = drawer.querySelector<HTMLDivElement>('#insight-area');
    if (insightBtn && insightArea) {
      insightBtn.onclick = async () => {
        insightBtn.disabled = true;
        insightArea.innerHTML = `<p>${t('sessions.insightLoading')}</p>`;
        try {
          const r = await fetch(`/api/sessions/${encodeURIComponent(s.sessionId)}/insight?detail=spans`);
          const d = await r.json().catch(() => ({}));
          if (!d.ok || !d.report) {
            insightArea.innerHTML = `<p>${t('sessions.insightUnavailable')}: ${escapeHtml(String(d.error ?? r.status))}</p>`;
          } else {
            insightArea.innerHTML = renderInsightReport(d.report);
          }
        } catch (e) {
          insightArea.innerHTML = `<p>${t('sessions.insightUnavailable')}: ${escapeHtml(String(e))}</p>`;
        }
        insightBtn.disabled = false;
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
      else if (action === 'restart') void restartSession(s, actionButton);
      else if (action === 'lock') void setSessionLocked(s, !s.locked, actionButton);
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
      const next = normalizeSessionsViewMode(btn.dataset.view) ?? 'board';
      if (next === viewMode) return;
      viewMode = next;
      writeStoredSessionsViewMode(window.localStorage, viewMode);
      rerender();
    });
  });

  groupByBox.querySelectorAll<HTMLButtonElement>('[data-groupby]').forEach(btn => {
    btn.addEventListener('click', () => {
      const raw = btn.dataset.groupby;
      const next: KanbanGroupBy = raw === 'bot' ? 'bot' : raw === 'team' ? 'team' : 'flow';
      if (next === kanbanGroupBy) return;
      kanbanGroupBy = next;
      writeStoredKanbanGroupBy(window.localStorage, next);
      lastKanbanHtml = '';
      rerender();
    });
  });

  teamSelect.addEventListener('change', () => {
    kanbanTeamKey = teamSelect.value;
    try { window.localStorage.setItem(KANBAN_TEAM_STORAGE_KEY, kanbanTeamKey); } catch { /* 仅当前页生效 */ }
    lastKanbanHtml = '';
    rerender();
  });

  // ── 看板交互：单击开终端弹窗（延迟仲裁让位双击）、铅笔/双击改标题、
  //    「详情」进抽屉、整卡拖拽换列与排序 ─────────────────────────────────────
  function cancelKanbanOpen(): void {
    if (kanbanOpenTimer !== null) {
      clearTimeout(kanbanOpenTimer);
      kanbanOpenTimer = null;
    }
  }

  kanban.addEventListener('click', e => {
    const target = e.target as HTMLElement;
    const card = target.closest<HTMLElement>('.kanban-card[data-id]');
    if (!card) return;
    const s = store.sessions.get(card.dataset.id!);
    if (!s) return;
    const actionButton = target.closest<HTMLButtonElement>('button[data-action]');
    if (actionButton) {
      if (actionButton.dataset.action === 'details') openDrawer(s);
      else if (actionButton.dataset.action === 'rename') startKanbanRename(card, s);
      else if (actionButton.dataset.action === 'history') void openHistoryModal(s);
      else if (actionButton.dataset.action === 'restart') void restartSession(s, actionButton);
      else if (actionButton.dataset.action === 'lock') void setSessionLocked(s, !s.locked, actionButton);
      return;
    }
    if (target.closest('a, button, input, label')) return;
    cancelKanbanOpen();
    kanbanOpenTimer = setTimeout(() => {
      kanbanOpenTimer = null;
      void openTerminalModal(s);
    }, 220);
  });

  kanban.addEventListener('dblclick', e => {
    const target = e.target as HTMLElement;
    const titleEl = target.closest<HTMLElement>('.kanban-card-title');
    const card = target.closest<HTMLElement>('.kanban-card[data-id]');
    if (!titleEl || !card) return;
    cancelKanbanOpen();
    const s = store.sessions.get(card.dataset.id!);
    if (s) startKanbanRename(card, s);
  });

  kanban.addEventListener('keydown', e => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const target = e.target as HTMLElement;
    if (!target.classList?.contains('kanban-card')) return;
    e.preventDefault();
    const s = store.sessions.get(target.dataset.id!);
    if (s) void openTerminalModal(s);
  });

  // ── 看板卡片拖拽 ──────────────────────────────────────────────────────────
  kanban.addEventListener('dragstart', e => {
    if (kanbanGroupBy === 'bot') return; // 机器人视角只读：会话不能拖给别的 bot
    const target = e.target as HTMLElement;
    // 拖群组容器头部 = 整簇搬运
    const clusterHeader = target.closest<HTMLElement>('.kanban-cluster > header[draggable]');
    if (clusterHeader) {
      const cluster = clusterHeader.closest<HTMLElement>('.kanban-cluster')!;
      const col = cluster.closest<HTMLElement>('.kanban-column')?.dataset.col as SessionKanbanColumn | undefined;
      if (!cluster.dataset.chat || !col) return;
      cancelKanbanOpen();
      kanbanDragClusterChat = cluster.dataset.chat;
      kanbanDragClusterCol = col;
      cluster.classList.add('dragging');
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', `cluster:${kanbanDragClusterChat}`);
      }
      return;
    }
    const card = target.closest<HTMLElement>('.kanban-card[data-id]');
    if (!card) return;
    cancelKanbanOpen();
    kanbanDragId = card.dataset.id!;
    card.classList.add('dragging');
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', kanbanDragId);
    }
  });

  kanban.addEventListener('dragover', e => {
    if (!kanbanDragId && !kanbanDragClusterChat) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    const column = (e.target as HTMLElement).closest<HTMLElement>('.kanban-column');
    kanban.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
    kanban.querySelectorAll('.drop-before').forEach(el => el.classList.remove('drop-before'));
    if (!column) return;
    column.classList.add('drag-over');
    kanbanInsertBeforeCard(column, e.clientY)?.classList.add('drop-before');
  });

  kanban.addEventListener('drop', e => {
    const clusterChat = kanbanDragClusterChat;
    const clusterCol = kanbanDragClusterCol;
    const dragId = kanbanDragId;
    if (!dragId && !clusterChat) return;
    e.preventDefault();
    kanbanDragId = null;
    kanbanDragClusterChat = null;
    kanbanDragClusterCol = null;
    clearKanbanDragMarks();
    const column = (e.target as HTMLElement).closest<HTMLElement>('.kanban-column');
    const targetCol = column?.dataset.col as SessionKanbanColumn | undefined;
    if (!column || !targetCol) return;
    const beforeCard = kanbanInsertBeforeCard(column, e.clientY);

    // ── 整簇搬运：源列里该群的全部卡片保持相对顺序插到落点 ──────────────────
    if (clusterChat && clusterCol) {
      const members = (lastKanbanGroups.get(clusterCol) ?? [])
        .filter((r: any) => String(r.chatId) === clusterChat)
        // 已关闭会话固定在「已完成」：整簇挪去别的列时留下它们
        .filter((r: any) => !(r.status === 'closed' && targetCol !== 'done'));
      if (!members.length) return;
      const memberIds = new Set(members.map((r: any) => r.sessionId));
      const colRows = (lastKanbanGroups.get(targetCol) ?? []).filter((r: any) => !memberIds.has(r.sessionId));
      let index = beforeCard ? colRows.findIndex((r: any) => r.sessionId === beforeCard.dataset.id) : colRows.length;
      if (index < 0) index = colRows.length;
      const prevRow = index > 0 ? colRows[index - 1] : null;
      const nextRow = index < colRows.length ? colRows[index] : null;
      const base = computeDropPosition(
        prevRow ? effectiveKanbanPosition(prevRow) : null,
        nextRow ? effectiveKanbanPosition(nextRow) : null,
      );
      members.forEach((m: any, i: number) => {
        const pos = base + i * 0.001;
        if (kanbanGroupBy === 'team') {
          // 团队模式写 host 的共享编排，不动各会话的个人看板字段
          applyTeamBoardMove(String(m.sessionId), targetCol, pos);
        } else {
          const prev = { column: m.kanbanColumn, position: m.kanbanPosition };
          m.kanbanColumn = targetCol;
          m.kanbanPosition = pos;
          void persistBoardMove(m, targetCol, pos, prev);
        }
      });
      lastKanbanHtml = '';
      rerender();
      return;
    }

    // ── 单卡搬运 ─────────────────────────────────────────────────────────────
    // 对方部署的行不在 store 里——团队看板的远程缓存兜底
    const s = store.sessions.get(dragId!) ?? kanbanRemoteRows.get(dragId!);
    if (!s) return;
    // 已关闭会话固定在「已完成」列，只允许列内重排。
    if (s.status === 'closed' && targetCol !== 'done') return;
    const colRows = (lastKanbanGroups.get(targetCol) ?? []).filter((r: any) => r.sessionId !== dragId);
    let index = beforeCard ? colRows.findIndex((r: any) => r.sessionId === beforeCard.dataset.id) : colRows.length;
    if (index < 0) index = colRows.length;
    const prevRow = index > 0 ? colRows[index - 1] : null;
    const nextRow = index < colRows.length ? colRows[index] : null;
    const position = computeDropPosition(
      prevRow ? effectiveKanbanPosition(prevRow) : null,
      nextRow ? effectiveKanbanPosition(nextRow) : null,
    );
    if (kanbanGroupBy === 'team') {
      applyTeamBoardMove(String(s.sessionId), targetCol, position);
      lastKanbanHtml = '';
      rerender();
      return;
    }
    const prev = { column: s.kanbanColumn, position: s.kanbanPosition };
    s.kanbanColumn = targetCol;
    s.kanbanPosition = position;
    lastKanbanHtml = '';
    rerender();
    void persistBoardMove(s, targetCol, position, prev);
  });

  kanban.addEventListener('dragend', () => {
    kanbanDragId = null;
    kanbanDragClusterChat = null;
    kanbanDragClusterCol = null;
    clearKanbanDragMarks();
    lastKanbanHtml = '';
    rerender();
  });

  // 点弹窗 backdrop 关闭；关闭时清空内容，立刻断开 iframe 里的终端 WebSocket。
  termModal.addEventListener('click', e => {
    if (e.target === termModal) termModal.close();
  });
  termModal.addEventListener('close', () => {
    termModal.innerHTML = '';
  });
  historyModal.addEventListener('click', e => {
    if (e.target === historyModal) historyModal.close();
  });
  historyModal.addEventListener('close', () => {
    historyModal.innerHTML = '';
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

  async function setSelectedLocked(locked: boolean): Promise<void> {
    const rows = [...selected]
      .map(id => store.sessions.get(id))
      .filter((s): s is any => !!s && s.status !== 'closed' && !!s.locked !== locked);
    if (rows.length === 0) return;
    bulkLockBtn.disabled = true;
    bulkUnlockBtn.disabled = true;
    const original = locked ? bulkLockBtn.textContent : bulkUnlockBtn.textContent;
    const activeBtn = locked ? bulkLockBtn : bulkUnlockBtn;
    let done = 0;
    let failed = 0;
    const queue = [...rows];
    activeBtn.textContent = `0/${rows.length}`;
    async function worker() {
      while (queue.length) {
        const s = queue.shift()!;
        const prev = !!s.locked;
        try {
          const r = await fetch(`/api/sessions/${encodeURIComponent(s.sessionId)}/lock`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ locked }),
          });
          const body = await r.json().catch(() => ({}));
          if (!r.ok || body?.ok === false) {
            failed += 1;
            s.locked = prev;
          } else {
            s.locked = !!body.locked;
          }
        } catch {
          failed += 1;
          s.locked = prev;
        } finally {
          done += 1;
          activeBtn.textContent = `${done}/${rows.length}`;
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(6, rows.length) }, () => worker()));
    activeBtn.textContent = original;
    invalidateSessionViews();
    rerender();
    if (failed > 0) alert(`${t('sessions.lockFailed')}: ${failed}/${rows.length}`);
  }

  bulkLockBtn.addEventListener('click', () => void setSelectedLocked(true));
  bulkUnlockBtn.addEventListener('click', () => void setSelectedLocked(false));

  idleCleanupThreshold.addEventListener('click', e => {
    // Don't let a threshold switch mid-cleanup repaint the count/pill against a
    // different threshold than the request that's already running.
    if (idleCleanupBusy) return;
    const btn = (e.target as HTMLElement | null)?.closest<HTMLButtonElement>('button[data-hours]');
    if (!btn) return;
    const next = parseIdleCleanupHours(btn.dataset.hours);
    if (!next || next === idleCleanupHours) return;
    idleCleanupHours = next;
    idleCleanupStatus.textContent = '';
    syncIdleCleanupUi();
  });

  idleCleanupBtn.addEventListener('click', async () => {
    const hours = selectedIdleCleanupHours();
    const candidates = currentIdleCleanupCandidates();
    if (candidates.length === 0) return;
    const label = idleCleanupLabel(hours);
    if (!confirm(t('sessions.idleCleanupConfirm', { count: candidates.length, threshold: label }))) return;
    idleCleanupBusy = true;
    idleCleanupBtn.disabled = true;
    idleCleanupStatus.textContent = t('sessions.idleCleanupRunning');
    try {
      const r = await fetch('/api/sessions/cleanup-idle', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // Send the filtered candidate ids so the server closes exactly what the
        // operator saw and confirmed (it re-validates each is still idle).
        body: JSON.stringify({ olderThanHours: hours, sessionIds: candidates.map(c => c.sessionId) }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) {
        if (r.status !== 401) alert(`${t('sessions.idleCleanupFailed')}: ${body?.error ?? r.status}`);
        idleCleanupStatus.textContent = '';
        return;
      }
      for (const item of body?.results ?? []) {
        if (item?.ok && item?.sessionId) selected.delete(String(item.sessionId));
      }
      idleCleanupStatus.textContent = t('sessions.idleCleanupDone', {
        closed: Number(body?.closed ?? 0),
        failed: Number(body?.failed ?? 0),
      });
      rerender();
    } catch (e) {
      alert(`${t('sessions.idleCleanupFailed')}: ${e}`);
      idleCleanupStatus.textContent = '';
    } finally {
      idleCleanupBusy = false;
      syncIdleCleanupUi();
    }
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
  const unsubscribeStore = store.on(rerender);
  // 团队看板 30s 软刷新（拉对方部署的会话快照与共享编排）；页面切走后
  // kanban 脱离 DOM，定时器自清。
  const teamBoardTimer = setInterval(() => {
    if (!document.body.contains(kanban)) {
      clearInterval(teamBoardTimer);
      return;
    }
    if (viewMode === 'kanban' && kanbanGroupBy === 'team') {
      lastKanbanHtml = '';
      rerender();
    }
  }, 30_000);
  rerender();
  // bot 友好名 / 群聊标题异步解析，回来后补一次重绘（首帧先显示原值）
  void loadNameMaps().then(rerender);
  return () => {
    unsubscribeStore();
    clearInterval(teamBoardTimer);
    cancelKanbanOpen();
    drawer.close();
    termModal.close();
    historyModal.close();
    createSessionModal.close();
  };
}
