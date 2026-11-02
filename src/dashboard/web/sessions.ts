// Sessions page shared helpers: pure display helpers and small API utilities.
import {
  botDisplayName,
  chatDisplayTitle,
  t,
  ui,
} from './ui.js';
import { CLI_OPTIONS } from '../../setup/bot-config-editor.js';
import { isRemoteCliId } from '../../core/remote-cli-ids.js';
import { sessionTerminalHref } from './session-terminal.js';
import { copyText } from './clipboard.js';
import { toast } from './toast.js';
import { sessionMutationBlockedText } from './session-mutation-blocked.js';

export function resumeErrorMessage(reason: unknown, translate: typeof t = t): string {
  if (reason === 'workspace_retired') return translate('sessions.resumeWorkspaceRetired');
  return `${translate('sessions.resumeFailed')}: ${reason}`;
}

/** 「重启失败」提示：被未处理完的会话挡住时说清卡在什么、怎么办，其余沿用 daemon 的 message / error。 */
export function restartErrorMessage(body: any, status: number, translate: typeof t = t): string {
  const blocked = sessionMutationBlockedText(body, translate);
  const reason = blocked
    ? translate('sessions.restartBlocked', { detail: blocked })
    : body?.message ?? body?.error ?? status;
  return `${translate('sessions.restartFailed')}: ${reason}`;
}

export function tokenCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function formatTokenCount(value: unknown): string {
  const n = tokenCount(value);
  return n === null ? '-' : n.toLocaleString('en-US');
}

export interface SessionExchangePreview {
  userText: string;
  userFullText: string;
  botText: string;
  botFullText: string;
}

function compactPreviewText(value: unknown, limit: number): string {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

/** Length-bound while preserving newlines — feeds the overlay, which renders
 * Markdown. The single-line card summary keeps using compactPreviewText(). */
function compactMultilinePreview(value: unknown, limit: number): string {
  const text = String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[^\S\n]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+/, '')
    .replace(/\s+$/, '');
  if (!text) return '';
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

/** Latest user/bot exchange for a session card. A bot preview is shown only
 * when it is newer than the latest user input; otherwise the card communicates
 * the still-waiting state with the user line alone. */
export function sessionExchangePreview(row: Record<string, any>): SessionExchangePreview {
  const userFullText = compactMultilinePreview(
    row.previewUserFullText
      ?? row.previewUserText
      ?? '',
    4_000,
  );
  const botFullText = row.previewBotState === 'replied'
    ? compactMultilinePreview(row.previewBotFullText ?? row.previewBotText ?? '', 4_000)
    : '';
  return {
    userText: compactPreviewText(userFullText, 120),
    userFullText,
    botText: compactPreviewText(botFullText, 220),
    botFullText,
  };
}

// CLI 过滤选项从 setup 的单一事实源 CLI_OPTIONS 派生，新增 CLI 自动跟随，
// 不再手抄一份（手抄版曾漏 antigravity/traex/mir/kimi/genius）。
// 'unknown' 兜底：没有 cliId 的会话在 filtered() 里按 'unknown' 归类。
export const CLI_FILTER_OPTIONS = [...CLI_OPTIONS.map(o => o.id), 'unknown'];

// 看板卡片左侧状态色条的语义分组：「启动中」并入「进行中」；「待办」是任务态（有未完成
// TODO），不拿 idle 冒充——idle 且无未完成 todo 才是真「空闲」。
export type BoardColumnId = 'needs-you' | 'working' | 'todo' | 'idle';

export function cssToken(value: unknown): string {
  return String(value ?? 'unknown').toLowerCase().replace(/[^a-z0-9_-]/g, '-');
}

export const SESSION_STATUS_OPTIONS = [
  'starting',
  'working',
  'idle',
  'dormant',
  'analyzing',
  'stalled',
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

/** 单聊（p2p）会话的展示名：`单聊 · 用户名 - bot名`。
  * 用户名取 chatDisplayName（缺失回退 chatId）；bot 名取 botDisplayName
  * （与表格 bot 列同源）。群聊/未知聊天不走这里。 */
export function sessionDirectChatText(s: any): string {
  const kind = t('sessions.directChat');
  const name = String(s?.chatDisplayName ?? '').trim()
    || String(s?.chatId ?? '').trim()
    || t('sessions.chatUnknown');
  const bot = botDisplayName(s);
  return `${kind} · ${name} - ${bot}`;
}

export function sessionLocationText(s: any): string {
  const chatId = String(s?.chatId ?? '').trim();
  if (s?.chatType === 'p2p') return sessionDirectChatText(s);
  const name = chatDisplayTitle(s);
  // 单聊(p2p)：同一个人对不同 bot 的私聊标题都是「单聊 · 申晗」，无法区分是哪个
  // bot。附上 bot 名做后缀（单聊 · 申晗 · <bot名>），让筛选选项/定位可辨别。
  const botSuffix = s?.chatType === 'p2p'
    ? (() => { const b = String(s?.botName ?? '').trim(); return b ? ` · ${b}` : ''; })()
    : '';
  if (name) return `${sessionChatKindLabel(s)} · ${name}${botSuffix}`;
  if (chatId) return `${sessionChatKindLabel(s)} · ${chatId}${botSuffix}`;
  return t('sessions.chatUnknown');
}

export function isUnknownChatSession(
  s: any,
  resolveTitle: (session: any) => string | null = chatDisplayTitle,
): boolean {
  const chatId = String(s?.chatId ?? '').trim();
  return !!chatId && !resolveTitle(s);
}

/** True when a chat-filter label still falls back to the raw `chatId` (no
 * human-readable name resolved). Used to demote unresolved labels during
 * option dedup so a named session always wins over an id-only one. */
export function chatFilterLabelIsUnresolved(label: string, chatId: string): boolean {
  const id = String(chatId ?? '').trim();
  return !!id && String(label ?? '').includes(id);
}

/** Pick the better of two chat-filter labels for the same `chatId`. A label
 * that resolved to a real name beats one that still shows the raw id; when both
 * are equally (un)resolved, fall back to a deterministic lexicographic pick so
 * option ordering stays stable across renders.
 *
 * Fixes the dedup bug where `label < existing` alone let a raw-id label
 * (ASCII `oc_…`, which sorts before CJK names) mask an already-resolved name
 * such as `单聊 · 韩毅 - Nil-RD`. */
export function preferChatFilterLabel(existing: string | undefined, candidate: string, chatId: string): string {
  if (existing === undefined) return candidate;
  const existingUnresolved = chatFilterLabelIsUnresolved(existing, chatId);
  const candidateUnresolved = chatFilterLabelIsUnresolved(candidate, chatId);
  if (existingUnresolved !== candidateUnresolved) {
    return existingUnresolved ? candidate : existing;
  }
  return candidate < existing ? candidate : existing;
}

export function sessionLocationTitle(s: any): string {
  const label = sessionLocationText(s);
  const chatId = String(s?.chatId ?? '').trim();
  return chatId && !label.includes(chatId) ? `${label} · ${chatId}` : label;
}

/** 状态筛选里「全部（含已关闭）」的取值；空串表示「未关闭的全部」。 */
export const SESSION_STATUS_ANY = '__any';

export interface SessionRowFilters {
  q: string;
  /** '' = 未关闭的全部；SESSION_STATUS_ANY = 含已关闭；其它 = 精确状态。 */
  status: string;
  /** '' | 'yes'（/adopt 接入）| 'no'（飞书原生） */
  adopt: string;
  bot: string;
  chat: string;
  /** '' = 全部 CLI；没有 cliId 的会话按 'unknown' 归类。 */
  cli: string;
  showUnknownChats: boolean;
}

/** 会话页的行筛选。keepClosed：看板要把已关闭会话留给「已完成」列，状态为空时也不剔除。 */
export function filterSessionRows<T extends Record<string, any>>(
  rows: readonly T[],
  filters: SessionRowFilters,
  options: { keepClosed: boolean },
): T[] {
  const q = filters.q.trim().toLowerCase();
  return rows.filter(s => {
    if (filters.cli && String(s.cliId ?? 'unknown') !== filters.cli) return false;
    if (!filters.showUnknownChats && isUnknownChatSession(s)) return false;
    if (filters.status === '') {
      if (!options.keepClosed && s.status === 'closed') return false;
    } else if (filters.status !== SESSION_STATUS_ANY && s.status !== filters.status) {
      return false;
    }
    if (filters.adopt && (filters.adopt === 'yes') !== !!s.adopt) return false;
    if (filters.bot && String(s.larkAppId ?? '') !== filters.bot) return false;
    if (filters.chat && String(s.chatId ?? '') !== filters.chat) return false;
    if (q && !sessionSearchText(s).includes(q)) return false;
    return true;
  });
}

/** 用户是否施加了真正收窄结果的筛选维度。「显示未知聊天」是独立显示设置（有自己的
 *  开关、默认开启），不算筛选——把它计入会让全新页面在零操作时就出现「清除筛选」。 */
export function hasActiveSessionFilters(filters: SessionRowFilters): boolean {
  return !!(filters.status || filters.bot || filters.chat || filters.cli || filters.adopt);
}

/** 清除筛选：只清空五个筛选维度，搜索词与「显示未知聊天」显示设置原样保留
 *  （清除筛选不应反过来隐藏一批会话，也不该改写用户的显示偏好）。 */
export function clearSessionFilters(filters: SessionRowFilters): SessionRowFilters {
  return {
    q: filters.q,
    status: '',
    adopt: '',
    bot: '',
    chat: '',
    cli: '',
    showUnknownChats: filters.showUnknownChats,
  };
}

/** 切到看板时，状态下拉里的「全部（含已关闭）」与默认项等价（看板恒保留已关闭给
 *  「已完成」列），该取值没有对应选项，归一化成默认项，避免芯片停在无选项的悬空值。 */
export function normalizeStatusFilterForView(status: string, keepClosed: boolean): string {
  return keepClosed && status === SESSION_STATUS_ANY ? '' : status;
}

export function sessionSearchText(s: any): string {
  return `${JSON.stringify(s)} ${sessionLocationText(s)} ${sessionLocationTitle(s)}`.toLowerCase();
}

export const terminalHref = sessionTerminalHref;

export function shouldOpenWritableTerminal(state: { authed: boolean; publicReadOnly: boolean } = ui): boolean {
  if (state.authed) return true;
  if (state.publicReadOnly) return false;
  return false;
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
  copy: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5.5" y="5.5" width="7.5" height="7.5" rx="1.4"/><path d="M10.5 5.5V4.1a1.4 1.4 0 0 0-1.4-1.4H4.1a1.4 1.4 0 0 0-1.4 1.4v5a1.4 1.4 0 0 0 1.4 1.4h1.4"/></svg>',
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
      if (r.status !== 401) toast(`${t('sessions.writeLinkFail')}: ${body?.error ?? r.status}`, { kind: 'error' });
      return;
    }
    if (tab) tab.location.href = body.url;
    else window.open(body.url, '_blank', 'noopener');
  } catch (e) {
    tab?.close();
    toast(`${t('sessions.writeLinkFail')}: ${e}`, { kind: 'error' });
  } finally {
    if (btn) btn.disabled = false;
  }
}

// Fetch the session's real spawn command (bin + argv + cwd + env) and copy it to
// the clipboard, for pasting into the debug terminal to reproduce an issue. The
// command carries credentials so the endpoint is management-token-gated (mirrors
// write-link); only writable views expose this action.
export async function copySpawnCommand(s: any, btn?: HTMLButtonElement): Promise<void> {
  if (btn) btn.disabled = true;
  try {
    const r = await fetch(`/api/sessions/${encodeURIComponent(s.sessionId)}/spawn-command`);
    const body = await r.json().catch(() => ({}));
    if (!r.ok || body?.ok === false || !body?.command) {
      if (r.status !== 401) toast(`${t('sessions.copyCommandFail')}: ${body?.error ?? r.status}`, { kind: 'error' });
      return;
    }
    if (await copyText(body.command, t('sessions.copyCommand'))) {
      if (btn) {
        const prev = btn.textContent;
        btn.textContent = t('sessions.copyCommandDone');
        setTimeout(() => { if (prev !== null) btn.textContent = prev; }, 1500);
      }
    }
  } catch (e) {
    toast(`${t('sessions.copyCommandFail')}: ${e}`, { kind: 'error' });
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
  // needs-you 保留 master 新增的 stalled 触发；starting 并入「进行中」(P1 命名收敛)。
  if (s.pendingRepo || s.tuiPromptActive || s.agentAttention || s.status === 'limited' || s.status === 'stalled') return 'needs-you';
  // 「启动中」并入「进行中」：starting / working / analyzing / active 同列。
  if (s.status === 'starting' || s.status === 'working' || s.status === 'analyzing' || s.status === 'active') return 'working';
  // 任务态优先于「空闲」：机器停了但还有未完成 TODO → 待办（真），正是要抓的
  // 「活没干完」。读不到 todo（其它 CLI / 无 transcript）时退回空闲，不硬判。
  if (hasOpenTodos(s)) return 'todo';
  return 'idle';
}

/** 会话是否有未完成 TODO（任务态）。openTodos 缺失 = 未知/不支持 → 视为无。 */
export function hasOpenTodos(s: any): boolean {
  const t = s?.openTodos;
  return !!t && typeof t.remaining === 'number' && t.remaining > 0;
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
  // No restart for ANY remote CLI, matching the Feishu card render surface and
  // the server's 409 (remote_restart_unsupported): a riff worker refuses the
  // IPC, and a mojo worker executes it — cancelling the remote session.
  return s.status !== 'closed' && !s.adopt && !s.pendingRepo && !isRemoteCliId(s.cliId);
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
