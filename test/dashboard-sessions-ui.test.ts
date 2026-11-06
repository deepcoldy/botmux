import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { store } from '../src/dashboard/web/store.js';
import { KANBAN_COLUMN_PAGE, SessionsKanbanView, type SessionsKanbanCallbacks, type SessionsKanbanState } from '../src/dashboard/web/sessions-kanban.js';
import { isOffBoardDormant } from '../src/dashboard/web/kanban-model.js';
import { filterSessionRows, SESSION_STATUS_ANY, type SessionRowFilters } from '../src/dashboard/web/sessions.js';
import {
  canRestartSession,
  CLI_FILTER_OPTIONS,
  SESSION_STATUS_OPTIONS,
  clearSessionFilters,
  deriveSessionBoardColumn,
  hasActiveSessionFilters,
  isUnknownChatSession,
  normalizeStatusFilterForView,
  preferChatFilterLabel,
  chatFilterLabelIsUnresolved,
  restartConfirmMessage,
  resumeErrorMessage,
  historySenderKey,
  sessionLocationText,
  sessionExchangePreview,
  shouldOpenWritableTerminal,
} from '../src/dashboard/web/sessions.js';
import { createDashboardTranslator } from '../src/dashboard/web/i18n.js';
import { previewMarkdownHtml } from '../src/dashboard/web/preview-markdown.js';

const kanbanCallbacks: SessionsKanbanCallbacks = {
  canRestartSession: row => row.status !== 'closed',
  icons: {
    feishu: '<svg></svg>',
    history: '<svg></svg>',
    lock: '<svg></svg>',
    restart: '<svg></svg>',
    close: '<svg></svg>',
    terminal: '<svg></svg>',
    unlock: '<svg></svg>',
  },
  lockActionLabel: row => (row.locked ? 'unlock' : 'lock'),
  sessionStatusText: status => String(status ?? 'unknown'),
  onClose: () => {},
  onDetails: () => {},
  onHistory: () => {},
  onMoveRows: () => {},
  onOpenTerminal: () => {},
  onRename: () => {},
  onRestart: () => {},
  onToggleLock: () => {},
  onToggleSelect: () => {},
  selectedSessionIds: new Set<string>(),
};

function renderKanban(state: Partial<SessionsKanbanState>): string {
  const fullState: SessionsKanbanState = {
    rows: [],
    ...state,
  };
  return renderToStaticMarkup(createElement(SessionsKanbanView, {
    host: null,
    ...kanbanCallbacks,
    ...fullState,
  }));
}

describe('dashboard session resume errors', () => {
  it.each([
    ['zh', '该会话的工作区已回收，无法恢复。请在有效工作区创建新会话。', '恢复失败'],
    ['en', 'This session’s workspace has been reclaimed and the session cannot be resumed. Create a new session in a valid workspace.', 'Resume failed'],
  ] as const)('explains retirement in %s and preserves other failure details', (locale, message, failure) => {
    const translate = createDashboardTranslator(locale);
    expect(resumeErrorMessage('workspace_retired', translate)).toBe(message);
    expect(resumeErrorMessage('daemon_unavailable', translate)).toBe(`${failure}: daemon_unavailable`);
    expect(resumeErrorMessage(503, translate)).toBe(`${failure}: 503`);
  });
});

describe('dashboard sessions filters', () => {
  it('shows only a current bot reply in the latest exchange preview', () => {
    expect(sessionExchangePreview({
      previewUserFullText: 'latest question',
      previewBotFullText: 'latest answer',
      previewBotState: 'replied',
    })).toEqual({
      userText: 'latest question',
      userFullText: 'latest question',
      botText: 'latest answer',
      botFullText: 'latest answer',
    });

    expect(sessionExchangePreview({
      previewUserText: 'follow-up',
      previewBotText: 'stale answer',
      previewBotState: 'waiting',
    })).toEqual({
      userText: 'follow-up',
      userFullText: 'follow-up',
      botText: '',
      botFullText: '',
    });
  });

  it('clears merged preview fields when a close SSE patch explicitly sends nulls', () => {
    store.replaceSnapshot([{
      sessionId: 'closing-preview',
      status: 'idle',
      previewUserText: 'private question',
      previewBotText: 'private answer',
      previewUserFullText: 'private question in full',
      previewBotFullText: 'private answer in full',
      previewUserAt: 100,
      previewBotAt: 200,
      previewBotState: 'replied',
    }], []);

    store.applySse('session.update', {
      sessionId: 'closing-preview',
      patch: {
        status: 'closed',
        previewUserText: null,
        previewBotText: null,
        previewUserFullText: null,
        previewBotFullText: null,
        previewUserAt: null,
        previewBotAt: null,
        previewBotState: null,
      },
    });

    expect(store.sessions.get('closing-preview')).toMatchObject({
      status: 'closed',
      previewUserText: null,
      previewBotText: null,
      previewUserFullText: null,
      previewBotFullText: null,
      previewUserAt: null,
      previewBotAt: null,
      previewBotState: null,
    });
    expect(sessionExchangePreview(store.sessions.get('closing-preview') ?? {})).toEqual({
      userText: '',
      userFullText: '',
      botText: '',
      botFullText: '',
    });
  });

  it('does not resurrect private text from legacy fallback fields after close preview cleanup', () => {
    expect(sessionExchangePreview({
      status: 'closed',
      previewUserText: null,
      previewBotText: null,
      previewUserFullText: null,
      previewBotFullText: null,
      previewUserAt: null,
      previewBotAt: null,
      previewBotState: null,
      lastUserPrompt: 'private closed question',
      currentTurnTitle: 'private closed title',
    })).toEqual({
      userText: '',
      userFullText: '',
      botText: '',
      botFullText: '',
    });
  });

  it('links preview Markdown only to http(s)/mailto targets and opens them without an opener', () => {
    const safe = previewMarkdownHtml('[docs](https://example.com/guide)');
    expect(safe).toContain('href="https://example.com/guide"');
    expect(safe).toContain('target="_blank"');
    expect(safe).toContain('rel="noopener noreferrer nofollow"');
    expect(previewMarkdownHtml('[mail](mailto:ops@example.com)')).toContain('href="mailto:ops@example.com"');
    // markdown-it's default validator would accept these; the preview must not
    // turn a prompt or bot reply into a clickable dashboard-relative or ftp link.
    for (const unsafe of ['[x](/api/sessions/s1/close)', '[x](ftp://host/file)', '[x](javascript:alert(1))']) {
      expect(previewMarkdownHtml(unsafe)).not.toContain('href=');
    }
  });

  it('never emits an auto-loading <img> for Markdown image syntax (SSRF / tracking-pixel safe)', () => {
    // `html:false` does NOT cover Markdown image tokens — they still emit
    // <img src=…>, which the auto-opening overlay would fetch on hover/focus,
    // leaking to an external tracker or hitting an internal URL (SSRF). The
    // image rule must degrade to a non-fetching text placeholder. Verified by
    // ACTUALLY RENDERING, not by scanning source for `html:false`.
    const external = previewMarkdownHtml('![track](https://attacker.example/pixel?id=secret)');
    const internal = previewMarkdownHtml('![lan](http://127.0.0.1:8080/admin)');
    const jsScheme = previewMarkdownHtml('![x](javascript:alert(1))');
    for (const html of [external, internal, jsScheme]) {
      expect(html).not.toMatch(/<img\b/i);
    }
    // Alt text is preserved; a safe-scheme src becomes an opt-in click-through
    // link (never auto-loaded), an unsafe scheme stays inert text.
    expect(external).toContain('session-card-exchange-img');
    expect(external).toContain('track');
    expect(external).toContain('href="https://attacker.example/pixel?id=secret"');
    expect(jsScheme).not.toContain('href="javascript:');
    // Ordinary Markdown still renders.
    expect(previewMarkdownHtml('**bold**')).toContain('<strong>bold</strong>');
    // Raw HTML / script stays escaped.
    expect(previewMarkdownHtml('<script>alert(1)</script>')).not.toMatch(/<script/i);
  });

  it('surfaces stalled sessions as a filterable needs-you state', () => {
    expect(SESSION_STATUS_OPTIONS).toContain('stalled');
    expect(deriveSessionBoardColumn({ status: 'stalled' })).toBe('needs-you');
  });

  it('derives CLI filter options from the shared CLI registry', () => {
    expect(CLI_FILTER_OPTIONS).toContain('codex');
    expect(CLI_FILTER_OPTIONS).toContain('codex-app');
    expect(CLI_FILTER_OPTIONS).toContain('mira');
    expect(CLI_FILTER_OPTIONS).toContain('pi');
    expect(CLI_FILTER_OPTIONS).toContain('kiro-cli');
    expect(CLI_FILTER_OPTIONS).toContain('unknown');
    expect(new Set(CLI_FILTER_OPTIONS).size).toBe(CLI_FILTER_OPTIONS.length);
  });

  it('builds restart confirmation text with current status and CLI', () => {
    const message = restartConfirmMessage({ status: 'working', cliId: 'codex' });

    expect(message).toContain('当前状态：工作中');
    expect(message).toContain('CLI：codex');
    expect(message).toContain('确认重启');
  });

  it('only shows restart for active botmux-owned sessions whose CLI has started', () => {
    expect(canRestartSession({ status: 'idle', adopt: false })).toBe(true);
    expect(canRestartSession({ status: 'closed', adopt: false })).toBe(false);
    expect(canRestartSession({ status: 'idle', adopt: true })).toBe(false);
    expect(canRestartSession({ status: 'starting', pendingRepo: true })).toBe(false);
    expect(canRestartSession({ status: 'idle', adopt: false, cliId: 'riff' })).toBe(false);
  });

  it('formats session location labels for group chats and direct chats', () => {
    expect(sessionLocationText({ chatType: 'group', chatId: 'oc_group' })).toBe('群聊 · oc_group');
    expect(sessionLocationText({ chatType: 'p2p', chatId: 'oc_dm', chatDisplayName: '韩毅', botName: 'Nil-RD' })).toBe('单聊 · 韩毅 - Nil-RD');
    expect(sessionLocationText({ chatType: 'p2p', chatId: 'oc_dm', botName: 'Nil-RD' })).toBe('单聊 · oc_dm - Nil-RD');
    expect(sessionLocationText({})).toBe('未知聊天');
  });

  it('treats sessions with chatId but no resolved chat title as unknown chats', () => {
    const row = { chatType: 'group', chatId: 'oc_stale' };
    const namedDirect = { chatType: 'p2p', chatId: 'oc_dm', chatDisplayName: '韩毅', botName: 'Nil-RD' };

    expect(isUnknownChatSession(row, () => null)).toBe(true);
    expect(isUnknownChatSession(row, () => 'SellerIM Agent 集中营')).toBe(false);
    expect(isUnknownChatSession(namedDirect)).toBe(false);
    expect(isUnknownChatSession({}, () => null)).toBe(false);
  });

  it('detects chat-filter labels that still fall back to the raw chatId', () => {
    expect(chatFilterLabelIsUnresolved('单聊 · oc_dm - Nil-RD', 'oc_dm')).toBe(true);
    expect(chatFilterLabelIsUnresolved('单聊 · 韩毅 - Nil-RD', 'oc_dm')).toBe(false);
    expect(chatFilterLabelIsUnresolved('群聊 · oc_group', 'oc_group')).toBe(true);
    expect(chatFilterLabelIsUnresolved('anything', '')).toBe(false);
  });

  it('prefers a resolved chat-filter label over a raw-id one during dedup', () => {
    // Same p2p chatId: one row resolved the human name, another (a scheduled
    // task with no user sender) fell back to the raw id. The resolved name must
    // win regardless of arrival order, even though ASCII `oc_…` sorts before CJK.
    const resolved = '单聊 · 韩毅 - 韩毅';
    const rawId = '单聊 · oc_cfa427 - 韩毅';
    expect(preferChatFilterLabel(undefined, rawId, 'oc_cfa427')).toBe(rawId);
    expect(preferChatFilterLabel(rawId, resolved, 'oc_cfa427')).toBe(resolved);
    expect(preferChatFilterLabel(resolved, rawId, 'oc_cfa427')).toBe(resolved);
  });

  it('falls back to a deterministic lexicographic pick when both labels are equally resolved', () => {
    expect(preferChatFilterLabel('群聊 · B', '群聊 · A', 'oc_x')).toBe('群聊 · A');
    expect(preferChatFilterLabel('群聊 · A', '群聊 · B', 'oc_x')).toBe('群聊 · A');
    // Both unresolved (raw id) → still deterministic, no crash.
    expect(preferChatFilterLabel('群聊 · oc_x', '群聊 · oc_x', 'oc_x')).toBe('群聊 · oc_x');
  });

  it('groups consecutive app/bot history records by sender identity', () => {
    expect(historySenderKey({ senderType: 'app', senderId: 'ou_bot' }))
      .toBe(historySenderKey({ senderType: 'bot', senderId: 'ou_bot' }));
    expect(historySenderKey({ senderType: 'bot', senderId: 'ou_other' }))
      .not.toBe(historySenderKey({ senderType: 'bot', senderId: 'ou_bot' }));
  });

  it('prioritizes dashboard auth over public read-only sharing', () => {
    expect(shouldOpenWritableTerminal({ authed: true, publicReadOnly: false })).toBe(true);
    expect(shouldOpenWritableTerminal({ authed: true, publicReadOnly: true })).toBe(true);
    expect(shouldOpenWritableTerminal({ authed: false, publicReadOnly: true })).toBe(false);
    expect(shouldOpenWritableTerminal({ authed: false, publicReadOnly: false })).toBe(false);
  });
});

describe('dashboard sessions kanban react view', () => {
  it('renders the five workflow columns with existing kanban DOM semantics', () => {
    const html = renderKanban({
      rows: [
        { sessionId: 's-backlog', status: 'idle', kanbanColumn: 'backlog', cliId: 'codex', title: 'Backlog', botName: 'Bot A', lastMessageAt: 1000 },
        { sessionId: 's-todo', status: 'idle', cliId: 'codex', title: 'Todo', botName: 'Bot A', lastMessageAt: 2000 },
        { sessionId: 's-progress', status: 'working', cliId: 'codex', title: 'Working', botName: 'Bot A', lastMessageAt: 3000, webPort: 3001 },
        { sessionId: 's-review', status: 'limited', cliId: 'codex', title: 'Review', botName: 'Bot A', lastMessageAt: 4000 },
        { sessionId: 's-stalled', status: 'stalled', cliId: 'codex-app', title: 'Stalled', botName: 'Bot A', lastMessageAt: 4500 },
        { sessionId: 's-done', status: 'closed', cliId: 'codex', title: 'Done', botName: 'Bot A', lastMessageAt: 5000 },
      ],
    });

    for (const column of ['backlog', 'todo', 'in_progress', 'in_review', 'done']) {
      expect(html).toContain(`kanban-column kanban-${column}`);
      expect(html).toContain(`data-col="${column}"`);
    }
    expect(html).toContain('class="kanban-col-list"');
    expect(html).toContain('class="kanban-card');
    expect(html).toContain('data-id="s-progress"');
    expect(html).toContain('role="button"');
    // 「需要你」原因单独一行，不再挤在卡片头里。
    expect(html).toContain('class="session-signal kanban-card-reason"');
    expect(html).toContain('长时间无进展');
    // 重设计后：状态色条 + 「终端」文字按钮 + 「⋯」菜单（原 icon rail 已移除）
    expect(html).toContain('data-signal="needs-you"');
    expect(html).toContain('class="kanban-card-term"');
    expect(html).toContain('data-action="more"');
    expect(html).toContain('kanban-col-dot kanban-col-dot-');
  });

  it('disables the selection checkbox on closed cards but not on active cards', () => {
    const html = renderKanban({
      rows: [
        { sessionId: 's-active', status: 'idle', cliId: 'codex', title: 'Active', botName: 'Bot A', lastMessageAt: 1000 },
        { sessionId: 's-closed', status: 'closed', cliId: 'codex', title: 'Closed', botName: 'Bot A', lastMessageAt: 900 },
      ],
    });
    // 已关闭卡片（done 列）勾选框必须 disabled：与表格行一致，避免选中后被下一次 SSE 清空、
    // 以及批量关闭对已关闭会话再发一次 /close。
    const closedCard = html.slice(html.indexOf('data-id="s-closed"'));
    const closedCheck = closedCard.slice(0, 2000).match(/<input[^>]*kanban-card-check[^>]*>/)?.[0] ?? '';
    expect(closedCheck).toContain('type="checkbox"');
    expect(closedCheck).toContain('disabled');
    const activeCard = html.slice(html.indexOf('data-id="s-active"'));
    const activeCheck = activeCard.slice(0, 2000).match(/<input[^>]*kanban-card-check[^>]*>/)?.[0] ?? '';
    expect(activeCheck).not.toContain('disabled');
  });

  it('clusters cards by chat and preserves the done column cap', () => {
    const closedRows = Array.from({ length: 55 }, (_, i) => ({
      sessionId: `closed-${i}`,
      chatId: `done-${i}`,
      status: 'closed',
      cliId: 'codex',
      title: `Closed ${i}`,
      botName: 'Bot A',
      lastMessageAt: i,
      kanbanPosition: i,
    }));
    const html = renderKanban({
      rows: [
        { sessionId: 'cluster-a', chatId: 'oc_1', status: 'working', cliId: 'codex', title: 'A', botName: 'Bot A', lastMessageAt: 100 },
        { sessionId: 'cluster-b', chatId: 'oc_1', status: 'working', cliId: 'codex', title: 'B', botName: 'Bot A', lastMessageAt: 99 },
        ...closedRows,
      ],
    });

    expect(html).toContain('class="kanban-cluster collapsed"');
    expect(html).toContain('data-chat="oc_1"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('data-id="cluster-a"');
    expect((html.match(/data-id="closed-/g) ?? []).length).toBe(50);
    expect(html).toContain('还有 5 个未显示');
  });

  it('renders only the first page of a long column and offers to show the rest', () => {
    const extra = 7;
    const rows = Array.from({ length: KANBAN_COLUMN_PAGE + extra }, (_, i) => ({
      sessionId: `idle-${i}`,
      chatId: `oc_${i}`,
      status: 'idle',
      cliId: 'codex',
      title: `Idle ${i}`,
      botName: 'Bot A',
      lastMessageAt: 10_000 - i,
    }));
    const html = renderKanban({ rows });

    expect((html.match(/data-id="idle-/g) ?? []).length).toBe(KANBAN_COLUMN_PAGE);
    // 最近活跃的在前：被收起的是最旧的那几张。
    expect(html).toContain('data-id="idle-0"');
    expect(html).not.toContain(`data-id="idle-${KANBAN_COLUMN_PAGE}"`);
    expect(html).toContain('kanban-col-show-more');
    expect(html).toContain(`显示更多（还有 ${extra} 个）`);
    // 列头计数仍是整列总数，不是已渲染数。
    expect(html).toContain(`<span class="kanban-col-count">${KANBAN_COLUMN_PAGE + extra}</span>`);
  });

  it('omits the terminal action when the embedding shell does not provide it', () => {
    const html = renderToStaticMarkup(createElement(SessionsKanbanView, {
      host: null,
      ...kanbanCallbacks,
      onOpenTerminal: undefined,
      rows: [{
        sessionId: 'embedded-session',
        status: 'working',
        cliId: 'codex',
        title: 'Embedded',
        botName: 'Bot A',
        lastMessageAt: 1000,
        webPort: 3001,
      }],
    }));

    expect(html).not.toContain('data-action="terminal"');
  });

  it('renders a single terminal entry and no separate writable-terminal menu item', () => {
    const html = renderKanban({
      rows: [{
        sessionId: 'dual-terminal-session',
        status: 'working',
        cliId: 'codex',
        title: 'Dual terminal',
        botName: 'Bot A',
        lastMessageAt: 1000,
        webPort: 3001,
      }],
    });

    // 只有底部一个「终端」按钮：开可操作还是只读由页面按身份决定，「⋯」菜单里不再重复一项。
    expect((html.match(/data-action="terminal"/g) ?? []).length).toBe(1);
    expect(html).toContain('data-menu-items="history,restart,lock,close"');
  });
});

describe('filterSessionRows', () => {
  const base: SessionRowFilters = { q: '', status: '', adopt: '', bot: '', chat: '', cli: '', showUnknownChats: true };
  const rows = [
    { sessionId: 'a', status: 'idle', cliId: 'codex', larkAppId: 'bot_1', chatId: 'oc_1', chatDisplayName: 'Alpha', adopt: false },
    { sessionId: 'b', status: 'working', cliId: 'claude-code', larkAppId: 'bot_2', chatId: 'oc_2', chatDisplayName: 'Beta', adopt: true },
    { sessionId: 'c', status: 'closed', cliId: 'codex', larkAppId: 'bot_1', chatId: 'oc_1', chatDisplayName: 'Alpha', adopt: false },
    { sessionId: 'd', status: 'idle', larkAppId: 'bot_2', chatId: 'oc_3', chatDisplayName: 'Gamma', adopt: false },
  ];
  const ids = (f: Partial<SessionRowFilters>, keepClosed = false) =>
    filterSessionRows(rows, { ...base, ...f }, { keepClosed }).map(r => r.sessionId);

  it('hides closed sessions by default, keeps them for the kanban, and shows them for "all incl. closed"', () => {
    expect(ids({})).toEqual(['a', 'b', 'd']);
    expect(ids({}, true)).toEqual(['a', 'b', 'c', 'd']);
    expect(ids({ status: SESSION_STATUS_ANY })).toEqual(['a', 'b', 'c', 'd']);
    expect(ids({ status: 'closed' })).toEqual(['c']);
    expect(ids({ status: 'idle' })).toEqual(['a', 'd']);
  });

  it('filters by bot, chat, source and a single CLI (missing cliId counts as unknown)', () => {
    expect(ids({ bot: 'bot_2' })).toEqual(['b', 'd']);
    expect(ids({ chat: 'oc_1' }, true)).toEqual(['a', 'c']);
    expect(ids({ adopt: 'yes' })).toEqual(['b']);
    expect(ids({ adopt: 'no' })).toEqual(['a', 'd']);
    expect(ids({ cli: 'codex' })).toEqual(['a']);
    expect(ids({ cli: 'unknown' })).toEqual(['d']);
  });

  it('combines filters with the free-text search', () => {
    expect(ids({ q: 'gamma' })).toEqual(['d']);
    expect(ids({ q: 'alpha', status: SESSION_STATUS_ANY, cli: 'codex' })).toEqual(['a', 'c']);
  });
});

describe('hasActiveSessionFilters / clearSessionFilters', () => {
  const fresh: SessionRowFilters = { q: '', status: '', adopt: '', bot: '', chat: '', cli: '', showUnknownChats: true };

  it('does not treat the showUnknownChats display setting as an active filter in either position', () => {
    // 默认（显示未知聊天=true）全新页面不该出现「清除筛选」；关掉它也不出现——它有自己的开关。
    expect(hasActiveSessionFilters(fresh)).toBe(false);
    expect(hasActiveSessionFilters({ ...fresh, showUnknownChats: false })).toBe(false);
  });

  it.each([
    ['status', { status: 'idle' }],
    ['adopt', { adopt: 'yes' }],
    ['bot', { bot: 'app_1' }],
    ['chat', { chat: 'oc_1' }],
    ['cli', { cli: 'codex' }],
  ] as const)('reports active when %s is set', (_key, patch) => {
    expect(hasActiveSessionFilters({ ...fresh, ...patch })).toBe(true);
  });

  it('clears the five narrowing dimensions but keeps the search query and the unknown-chats setting', () => {
    const cleared = clearSessionFilters({
      q: 'build', status: 'idle', adopt: 'yes', bot: 'app_1', chat: 'oc_1', cli: 'codex',
      showUnknownChats: false,
    });
    expect(cleared).toEqual({
      q: 'build', status: '', adopt: '', bot: '', chat: '', cli: '', showUnknownChats: false,
    });
    // 默认开启时同样保持开启：清除筛选绝不能反过来隐藏一批会话。
    expect(clearSessionFilters({ ...fresh, q: 'x' }).showUnknownChats).toBe(true);
  });
});

describe('normalizeStatusFilterForView', () => {
  it('collapses "all incl. closed" only when the view already keeps closed sessions', () => {
    expect(normalizeStatusFilterForView(SESSION_STATUS_ANY, true)).toBe('');
    expect(normalizeStatusFilterForView(SESSION_STATUS_ANY, false)).toBe(SESSION_STATUS_ANY);
    expect(normalizeStatusFilterForView('idle', true)).toBe('idle');
    expect(normalizeStatusFilterForView('', false)).toBe('');
  });
});

describe('isOffBoardDormant', () => {
  it('keeps dormant sessions off the board unless they were placed by hand', () => {
    expect(isOffBoardDormant({ status: 'dormant' })).toBe(true);
    expect(isOffBoardDormant({ status: 'dormant', kanbanColumn: 'bogus' })).toBe(true);
    expect(isOffBoardDormant({ status: 'dormant', kanbanColumn: 'backlog' })).toBe(false);
    expect(isOffBoardDormant({ status: 'idle' })).toBe(false);
    expect(isOffBoardDormant({ status: 'working' })).toBe(false);
    expect(isOffBoardDormant({ status: 'closed' })).toBe(false);
  });
});

describe('deriveSessionBoardColumn', () => {
  it('drops closed sessions off the board', () => {
    expect(deriveSessionBoardColumn({ status: 'closed' })).toBeNull();
  });

  it('routes needs-you signals ahead of runtime state', () => {
    expect(deriveSessionBoardColumn({ status: 'working', pendingRepo: true })).toBe('needs-you');
    expect(deriveSessionBoardColumn({ status: 'idle', tuiPromptActive: true })).toBe('needs-you');
    expect(deriveSessionBoardColumn({ status: 'idle', agentAttention: { kind: 'x', reason: 'y', at: 1 } })).toBe('needs-you');
    expect(deriveSessionBoardColumn({ status: 'limited' })).toBe('needs-you');
  });

  it('folds "starting" into the "working" (进行中) column', () => {
    for (const status of ['starting', 'working', 'analyzing', 'active']) {
      expect(deriveSessionBoardColumn({ status })).toBe('working');
    }
  });

  it('treats idle/dormant with no open todos as idle', () => {
    expect(deriveSessionBoardColumn({ status: 'idle' })).toBe('idle');
    expect(deriveSessionBoardColumn({ status: 'dormant' })).toBe('idle');
    // openTodos present but nothing left → still idle (task delivered).
    expect(deriveSessionBoardColumn({ status: 'idle', openTodos: { total: 3, done: 3, remaining: 0, hasInProgress: false } })).toBe('idle');
  });

  it('routes an idle process with unfinished todos to the "待办" (todo) column', () => {
    expect(deriveSessionBoardColumn({ status: 'idle', openTodos: { total: 3, done: 1, remaining: 2, hasInProgress: false } })).toBe('todo');
    expect(deriveSessionBoardColumn({ status: 'dormant', openTodos: { total: 2, done: 0, remaining: 2, hasInProgress: true } })).toBe('todo');
  });

  it('keeps running/needs-you state ahead of the todo task-state', () => {
    // 运行态优先：机器还在跑就归「进行中」，即便有未完成 todo。
    expect(deriveSessionBoardColumn({ status: 'working', openTodos: { total: 3, done: 1, remaining: 2, hasInProgress: true } })).toBe('working');
    // needs-you 信号仍最高优先。
    expect(deriveSessionBoardColumn({ status: 'idle', pendingRepo: true, openTodos: { total: 3, done: 1, remaining: 2, hasInProgress: false } })).toBe('needs-you');
  });
});
