// Sessions page shared helpers: pure display helpers and small API utilities.
import {
  chatDisplayTitle,
  t,
  ui,
} from './ui.js';
import { CLI_OPTIONS } from '../../setup/bot-config-editor.js';
import { sessionTerminalHref } from './session-terminal.js';

export function tokenCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function formatTokenCount(value: unknown): string {
  const n = tokenCount(value);
  return n === null ? '-' : n.toLocaleString('en-US');
}

// CLI 过滤选项从 setup 的单一事实源 CLI_OPTIONS 派生，新增 CLI 自动跟随，
// 不再手抄一份（手抄版曾漏 antigravity/traex/mir/kimi/genius）。
// 'unknown' 兜底：没有 cliId 的会话在 filtered() 里按 'unknown' 归类。
export const CLI_FILTER_OPTIONS = [...CLI_OPTIONS.map(o => o.id), 'unknown'];

export type BoardColumnId = 'needs-you' | 'starting' | 'working' | 'idle';

export const BOARD_COLUMNS: Array<{ id: BoardColumnId; labelKey: string; hintKey: string }> = [
  { id: 'needs-you', labelKey: 'sessions.board.needsYou', hintKey: 'sessions.board.needsYouHint' },
  { id: 'starting', labelKey: 'sessions.board.starting', hintKey: 'sessions.board.startingHint' },
  { id: 'working', labelKey: 'sessions.board.working', hintKey: 'sessions.board.workingHint' },
  { id: 'idle', labelKey: 'sessions.board.idle', hintKey: 'sessions.board.idleHint' },
];

export function cssToken(value: unknown): string {
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

export function sessionRuntimeCounts(rows: Iterable<any>): {
  logical: number;
  resident: number;
  dormant: number;
} {
  let logical = 0;
  let resident = 0;
  let dormant = 0;
  for (const row of rows) {
    if (row?.status === 'closed') continue;
    logical++;
    if (typeof row?.workerPid === 'number') resident++;
    if (row?.status === 'dormant') dormant++;
  }
  return { logical, resident, dormant };
}

export function repoBasename(workingDir: unknown): string {
  const value = String(workingDir ?? '').trim();
  if (!value) return '-';
  const parts = value.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts.at(-1) ?? value;
}

function sessionChatKindLabel(s: any): string {
  return s?.chatType === 'p2p' ? t('sessions.directChat') : t('sessions.groupChat');
}

export function sessionLocationText(s: any): string {
  const chatId = String(s?.chatId ?? '').trim();
  const name = chatDisplayTitle(s);
  if (name) return `${sessionChatKindLabel(s)} · ${name}`;
  if (chatId) return `${sessionChatKindLabel(s)} · ${chatId}`;
  return t('sessions.chatUnknown');
}

export function isUnknownChatSession(
  s: any,
  resolveTitle: (session: any) => string | null = chatDisplayTitle,
): boolean {
  const chatId = String(s?.chatId ?? '').trim();
  return !!chatId && !resolveTitle(s);
}

export function sessionLocationTitle(s: any): string {
  const label = sessionLocationText(s);
  const chatId = String(s?.chatId ?? '').trim();
  return chatId && !label.includes(chatId) ? `${label} · ${chatId}` : label;
}

export function sessionSearchText(s: any): string {
  return `${JSON.stringify(s)} ${sessionLocationText(s)} ${sessionLocationTitle(s)}`.toLowerCase();
}

export const terminalHref = sessionTerminalHref;

export function shouldOpenWritableTerminal(state: { authed: boolean; publicReadOnly: boolean } = ui): boolean {
  return state.authed && !state.publicReadOnly;
}

// Cohesive icon set for the session-card action bar — stroke-based (CSS sets
// stroke:currentColor), 16px viewBox to match the sidebar nav glyphs. Icons
// instead of text labels keep rows fixed width across locales.
export const ICON = {
  pin: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 14.3s4.2-3.9 4.2-7.3A4.2 4.2 0 0 0 8 2.9a4.2 4.2 0 0 0-4.2 4.1C3.8 10.4 8 14.3 8 14.3z"/><circle cx="8" cy="6.9" r="1.5"/></svg>',
  openChat: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9.4 2.8h3.8v3.8"/><path d="M13.2 2.8 7.3 8.7"/><path d="M11.5 9.3v2.9a1.2 1.2 0 0 1-1.2 1.2H3.8a1.2 1.2 0 0 1-1.2-1.2V5.7a1.2 1.2 0 0 1 1.2-1.2h2.9"/></svg>',
  details: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2.4" y="2.6" width="11.2" height="10.8" rx="2"/><path d="M5.2 5.4h5.6"/><path d="M5.2 8h5.6"/><path d="M5.2 10.6h3.2"/></svg>',
  terminal: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="1.8" y="2.2" width="12.4" height="10.5" rx="2"/><path d="M1.8 5h12.4"/><circle cx="4" cy="3.6" r=".45" fill="currentColor" stroke="none"/><path d="m4.2 7.3 1.8 1.6-1.8 1.6"/><path d="M8 10.6h3.4"/></svg>',
  key: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="6" cy="6.1" r="3"/><path d="M8.1 8.2 13 13.1"/><path d="M11.3 11.4 12.6 10.1"/><path d="M12.7 12.8 13.7 11.8"/></svg>',
  lock: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3" y="7" width="10" height="6.4" rx="1.8"/><path d="M5.1 7V5.4a2.9 2.9 0 0 1 5.8 0V7"/><path d="M8 9.5v1.4"/></svg>',
  unlock: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3" y="7" width="10" height="6.4" rx="1.8"/><path d="M5.1 7V5.3a2.9 2.9 0 0 1 5.1-1.9"/><path d="M8 9.5v1.4"/></svg>',
  close: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.2 4.2 11.8 11.8"/><path d="M11.8 4.2 4.2 11.8"/></svg>',
  edit: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10.7 3.3 12.7 5.3 6.3 11.7 3.7 12.3 4.3 9.7 10.7 3.3z"/></svg>',
  history: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.2 7.8a4.8 4.8 0 1 0 1.4-3.4"/><path d="M3.2 3.1v3.2h3.2"/><path d="M8 5.4v3l2.1 1.2"/></svg>',
  restart: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M12.7 6.5A4.8 4.8 0 1 0 13 9"/><path d="M12.7 3.3v3.2H9.5"/></svg>',
  feishu: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 5.2a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v3.3a2 2 0 0 1-2 2H7.1L4.3 13v-2.5H5"/><path d="M9.1 3.2h3.7v3.7"/><path d="M12.8 3.2 8.5 7.5"/></svg>',
};

export function lockActionLabel(s: any): string {
  return s.locked ? t('sessions.unlock') : t('sessions.lock');
}

// Mint + open the writable web terminal for `s`. The tab is opened synchronously
// inside the click gesture so popup blockers do not reject the delayed URL.
export async function openWriteLink(s: any, btn?: HTMLButtonElement): Promise<void> {
  const tab = window.open('about:blank', '_blank');
  if (tab) tab.opener = null;
  if (btn) btn.disabled = true;
  try {
    const r = await fetch(`/api/sessions/${encodeURIComponent(s.sessionId)}/write-link`);
    const body = await r.json().catch(() => ({}));
    if (!r.ok || body?.ok === false || !body?.url) {
      tab?.close();
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

export function historySenderKey(message: any): string {
  const rawType = String(message?.senderType ?? 'unknown');
  const type = rawType === 'app' || rawType === 'bot' ? 'bot' : rawType;
  const id = String(message?.senderId ?? '').trim();
  const name = String(message?.senderName ?? '').trim();
  return `${type}:${id || name || 'unknown'}`;
}

export function deriveSessionBoardColumn(s: any): BoardColumnId | null {
  if (s.status === 'closed') return null;
  if (s.pendingRepo || s.tuiPromptActive || s.agentAttention || s.status === 'limited') return 'needs-you';
  if (s.status === 'starting') return 'starting';
  if (s.status === 'working' || s.status === 'analyzing' || s.status === 'active') return 'working';
  if (s.status === 'dormant') return 'idle';
  return 'idle';
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

export interface PickerBot { larkAppId: string; botName: string; }

export async function fetchPickerBots(): Promise<PickerBot[]> {
  try {
    const r = await fetch('/api/groups');
    if (!r.ok) return [];
    const data = await r.json();
    const bots = Array.isArray(data?.bots) ? data.bots : [];
    return bots
      .filter((b: any) => b && typeof b.larkAppId === 'string')
      .map((b: any) => ({
        larkAppId: b.larkAppId,
        botName: typeof b.botName === 'string' && b.botName ? b.botName : b.larkAppId,
      }));
  } catch {
    return [];
  }
}
