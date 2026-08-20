import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { store } from '../src/dashboard/web/store.js';
import { SessionsKanbanView, type SessionsKanbanCallbacks, type SessionsKanbanState } from '../src/dashboard/web/sessions-kanban.js';
import {
  canRestartSession,
  CLI_FILTER_OPTIONS,
  SESSION_STATUS_OPTIONS,
  deriveSessionBoardColumn,
  groupSessionsByTopic,
  isUnknownChatSession,
  preferChatFilterLabel,
  chatFilterLabelIsUnresolved,
  restartConfirmMessage,
  historySenderKey,
  sessionLocationText,
  sessionExchangePreview,
  sessionTopicKey,
  shouldOpenWritableTerminal,
  previewOverlayReducer,
  previewOverlayInitialState,
} from '../src/dashboard/web/sessions.js';
import { CliFilterGroup, TopicGroupsView } from '../src/dashboard/web/sessions-page.js';
import { previewMarkdownHtml } from '../src/dashboard/web/preview-markdown.js';

const kanbanCallbacks: SessionsKanbanCallbacks = {
  canRestartSession: row => row.status !== 'closed',
  getTeamChatIds: () => new Set<string>(),
  icons: {
    details: '<svg></svg>',
    feishu: '<svg></svg>',
    history: '<svg></svg>',
    key: '<svg></svg>',
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
  onNeedTeamBoard: () => {},
  onNeedTeams: () => {},
  onOpenTerminal: () => {},
  onOpenWritableTerminal: () => {},
  onRename: () => {},
  onRestart: () => {},
  onTeamScope: () => {},
  onToggleLock: () => {},
  onToggleSelect: () => {},
  selectedSessionIds: new Set<string>(),
};

function renderKanban(state: Partial<SessionsKanbanState>): string {
  const fullState: SessionsKanbanState = {
    rows: [],
    groupBy: 'flow',
    teams: [],
    teamsLoaded: true,
    teamKey: '',
    teamBoardData: null,
    teamBoardKey: '',
    ...state,
  };
  return renderToStaticMarkup(createElement(SessionsKanbanView, {
    host: null,
    ...kanbanCallbacks,
    ...fullState,
  }));
}

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

  it('renders accessible user and bot preview lines on session cards', () => {
    const page = readFileSync(new URL('../src/dashboard/web/sessions-page.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/dashboard/web/style.css', import.meta.url), 'utf8');

    expect(page).toContain('className="session-card-exchange"');
    expect(page).toContain("t('sessions.history.user')");
    expect(page).toContain("t('sessions.history.bot')");
    expect(page).toContain('className="session-card-exchange-tooltip"');
    // Overlay carries interactive Markdown links, so it is a non-modal dialog
    // (not a tooltip): keyboard-focusable and reachable.
    expect(page).toContain('role="dialog"');
    expect(page).toContain("t('sessions.preview.showFull')");
    expect(page).toContain('aria-expanded={open}');
    expect(page).toContain('onPointerEnter={event => {');
    expect(page).toContain("if (event.key === 'Escape') hide();");
    // Card summary stays plain-text (2-line clamp); the overlay renders Markdown.
    expect(page).toContain('<p>{exchange.userText}</p>');
    expect(page).toContain('<p>{exchange.botText}</p>');
    expect(css).toContain('.session-card-exchange-line > p');
    expect(css).toContain('-webkit-line-clamp: 2');
    expect(css).toContain('.session-card-exchange-tooltip {');
    expect(css).toContain('position: fixed;');
    expect(css).toContain('.session-card-exchange-tooltip-scroll {');
    expect(css).toContain('.session-card-exchange-tooltip-line > p');
    expect(css).toContain('user-select: text;');
  });

  it('renders the full-exchange overlay as sanitized Markdown, not raw text', () => {
    const page = readFileSync(new URL('../src/dashboard/web/sessions-page.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/dashboard/web/style.css', import.meta.url), 'utf8');
    const md = readFileSync(new URL('../src/dashboard/web/preview-markdown.ts', import.meta.url), 'utf8');

    // The overlay renders both sides through the Markdown helper (raw HTML off
    // for XSS safety), replacing the old raw `<p>{fullText}</p>` nodes.
    expect(page).toContain("import { previewMarkdownHtml } from './preview-markdown.js'");
    expect(page).toContain('previewMarkdownHtml(exchange.userFullText)');
    expect(page).toContain('previewMarkdownHtml(exchange.botFullText)');
    expect(page).toContain('className="session-card-exchange-md"');
    expect(page).not.toContain('<p>{exchange.userFullText}</p>');
    expect(page).not.toContain('<p>{exchange.botFullText}</p>');

    // Reuses markdown-it with the same hardening insights.ts applies: no raw
    // HTML, links forced to a safe scheme, and a plain-text escape fallback.
    expect(md).toContain("new MarkdownIt({ html: false");
    expect(md).toContain('validateLink');
    expect(md).toContain("attrSet('rel', 'noopener noreferrer nofollow')");
    expect(md).toContain('escapeHtml');

    // Overlay Markdown body is styled with dashboard tokens (no new palette).
    expect(css).toContain('.session-card-exchange-md');
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

  it('keeps the overlay open and reachable for keyboard focus into Markdown links', () => {
    const page = readFileSync(new URL('../src/dashboard/web/sessions-page.tsx', import.meta.url), 'utf8');

    // Focus entering the panel cancels the trigger's blur-close timer, so
    // Tabbing into a rendered link does not unmount the overlay mid-navigation.
    expect(page).toContain('onFocusCapture={clearHide}');
    // It only closes once focus leaves BOTH the panel and the trigger.
    expect(page).toContain('tooltipRef.current?.contains(next) || triggerRef.current?.contains(next)');
    // Escape closes and returns focus to the trigger.
    expect(page).toContain('triggerRef.current?.focus()');
    // Popover semantics on the trigger (not aria-describedby on a tooltip).
    expect(page).toContain('aria-haspopup="dialog"');
    expect(page).toContain('aria-controls={open ? tooltipId : undefined}');
  });

  it('Escape then refocus does not reopen the overlay (reducer the component actually uses)', () => {
    const page = readFileSync(new URL('../src/dashboard/web/sessions-page.tsx', import.meta.url), 'utf8');

    // Guard against "test the model, run other code": assert the component wires
    // its useReducer to THIS reducer + dispatches the transitions under test.
    expect(page).toContain('useReducer(previewOverlayReducer, previewOverlayInitialState)');
    expect(page).toContain("dispatch('escape-refocus')");
    expect(page).toContain("dispatch('focus')");

    // Now EXECUTE the transitions in the exact order the Escape key produces:
    // an open overlay with focus inside → 'escape-refocus' (close + arm one-shot)
    // → the trigger's programmatic refocus dispatches 'focus'. The one-shot must
    // be consumed WITHOUT reopening, so the terminal state is closed.
    let state = previewOverlayInitialState;
    state = previewOverlayReducer(state, 'open');
    expect(state.open).toBe(true);
    state = previewOverlayReducer(state, 'escape-refocus');
    expect(state).toEqual({ open: false, suppressFocusOpen: true });
    state = previewOverlayReducer(state, 'focus');
    expect(state).toEqual({ open: false, suppressFocusOpen: false });

    // A normal (non-suppressed) focus opens; suppress is one-shot only.
    expect(previewOverlayReducer(previewOverlayInitialState, 'focus'))
      .toEqual({ open: true, suppressFocusOpen: false });
    // A second focus after the consumed one-shot opens as usual.
    expect(previewOverlayReducer({ open: false, suppressFocusOpen: false }, 'focus').open).toBe(true);
  });

  it('drops the ••• details button and makes the preview body itself the toggle', () => {
    const page = readFileSync(new URL('../src/dashboard/web/sessions-page.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/dashboard/web/style.css', import.meta.url), 'utf8');

    // The dedicated ••• button is gone entirely — content + markup + styles.
    expect(page).not.toContain('•••');
    expect(page).not.toContain('session-card-exchange-details');
    expect(css).not.toContain('.session-card-exchange-details');

    // The exchange body itself is now the toggle: keyboard + pointer reachable,
    // so touch users (no hover) and keyboard users keep a way to open the
    // overlay that the ••• button used to provide.
    const exchangeStart = page.indexOf('className="session-card-exchange"');
    expect(exchangeStart).toBeGreaterThan(-1);
    const exchangeAttrs = page.slice(exchangeStart - 400, exchangeStart + 400);
    expect(exchangeAttrs).toContain('role="button"');
    expect(exchangeAttrs).toContain('tabIndex={0}');
    // Enter/Space toggles the overlay for keyboard users.
    expect(page).toContain("event.key === 'Enter' || event.key === ' '");
    expect(css).toContain('.session-card-exchange {');
    expect(css).toContain('cursor: pointer;');
  });

  it('wires @ completion and pasted-image previews into the create-session composer', () => {
    const page = readFileSync(new URL('../src/dashboard/web/sessions-page.tsx', import.meta.url), 'utf8');

    expect(page).toContain('findMentionTrigger');
    expect(page).toContain('onPaste={event => { void handleContentPaste(event); }}');
    expect(page).toContain('event.preventDefault();');
    expect(page).toContain('images: images.map(image => ({');
    expect(page).toContain('className="cs-image-list"');
    expect(page).toContain('insertImageMarkers(content, pasteStart, pasteEnd');
    expect(page).toContain('className="cs-image-remove"');
    expect(page).toContain('removeAndReindexImageMarkers(');
    expect(page).toContain('nextImageOrdinalRef.current = remaining.length + 1;');
  });

  it('reads filter input values before entering React state updaters', () => {
    const page = readFileSync(new URL('../src/dashboard/web/sessions-page.tsx', import.meta.url), 'utf8');

    expect(page).toContain('const q = event.currentTarget.value;');
    expect(page).toContain('const active = event.currentTarget.checked;');
    expect(page).toContain('const multiBotTopics = event.currentTarget.checked;');
    expect(page).toContain('const botTriggeredTopics = event.currentTarget.checked;');
    expect(page).not.toContain('q: event.currentTarget.value');
    expect(page).not.toContain('active: event.currentTarget.checked');
    expect(page).not.toContain('multiBotTopics: event.currentTarget.checked');
    expect(page).not.toContain('botTriggeredTopics: event.currentTarget.checked');
  });

  it('groups thread sessions by chat and root message without claiming ancestry', () => {
    const rows = [
      {
        sessionId: 'codex',
        chatId: 'oc_coding',
        rootMessageId: 'om_topic',
        scope: 'thread',
        larkAppId: 'app_codex',
        botName: 'Nil-Codex',
        status: 'working',
        title: '@Nil-Codex 协作排查',
        spawnedAt: 10,
        lastMessageAt: 100,
        lastInputFromBot: true,
      },
      {
        sessionId: 'traex',
        chatId: 'oc_coding',
        rootMessageId: 'om_topic',
        scope: 'thread',
        larkAppId: 'app_traex',
        botName: 'Nil-TraeX',
        status: 'closed',
        title: '后续处理',
        spawnedAt: 20,
        lastMessageAt: 90,
      },
      {
        sessionId: 'other-topic',
        chatId: 'oc_coding',
        rootMessageId: 'om_other',
        scope: 'thread',
        larkAppId: 'app_codex',
        botName: 'Nil-Codex',
        status: 'idle',
        lastMessageAt: 80,
      },
    ];

    const groups = groupSessionsByTopic(rows);
    expect(groups).toHaveLength(2);
    expect(sessionTopicKey(rows[0])).toBe(sessionTopicKey(rows[1]));
    expect(sessionTopicKey(rows[0])).not.toBe(sessionTopicKey(rows[2]));
    expect(groups[0]).toMatchObject({
      kind: 'thread',
      chatId: 'oc_coding',
      rootMessageId: 'om_topic',
      title: '@Nil-Codex 协作排查',
      botCount: 2,
      activeCount: 1,
      closedCount: 1,
      inferredBotInputCount: 1,
      multiBot: true,
      inferredBotTriggered: true,
    });
    expect(groups[0].rows.map(row => row.sessionId)).toEqual(['codex', 'traex']);
  });

  it('groups chat-scope sessions at whole-chat granularity', () => {
    const first = { sessionId: 'a', chatId: 'oc_chat', rootMessageId: 'om_a', scope: 'chat', status: 'idle' };
    const second = { sessionId: 'b', chatId: 'oc_chat', rootMessageId: 'om_b', scope: 'chat', status: 'idle' };
    const groups = groupSessionsByTopic([first, second]);

    expect(sessionTopicKey(first)).toBe(sessionTopicKey(second));
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ kind: 'chat', chatId: 'oc_chat' });
    expect(groups[0].rootMessageId).toBeUndefined();
  });

  it('keeps thread sessions with incomplete topic anchors separate', () => {
    const first = {
      sessionId: 'a', chatId: 'oc_chat', rootMessageId: '', scope: 'thread',
      larkAppId: 'app_a', status: 'idle',
    };
    const second = {
      sessionId: 'b', chatId: 'oc_chat', scope: 'thread',
      larkAppId: 'app_b', status: 'idle',
    };
    const groups = groupSessionsByTopic([first, second]);

    expect(sessionTopicKey(first)).not.toBe(sessionTopicKey(second));
    expect(groups).toHaveLength(2);
    expect(groups.every(group => group.kind === 'session')).toBe(true);
    expect(groups.every(group => !group.multiBot)).toBe(true);
  });

  it('does not infer multiple Bots from sessions whose Bot identity is missing', () => {
    const groups = groupSessionsByTopic([
      { sessionId: 'a', chatId: 'oc_chat', rootMessageId: 'om_topic', scope: 'thread', status: 'idle' },
      { sessionId: 'b', chatId: 'oc_chat', rootMessageId: 'om_topic', scope: 'thread', status: 'idle' },
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ botCount: 1, multiBot: false });
  });

  it('renders topic aggregation with multi-Bot and inferred trigger signals', () => {
    const html = renderToStaticMarkup(createElement(TopicGroupsView, {
      rows: [
        {
          sessionId: 'codex', chatId: 'oc_coding', rootMessageId: 'om_topic', scope: 'thread',
          larkAppId: 'app_codex', botName: 'Nil-Codex', cliId: 'codex', status: 'working',
          title: '@Nil-Codex 协作排查', lastMessageAt: 100, lastInputFromBot: true,
        },
        {
          sessionId: 'traex', chatId: 'oc_coding', rootMessageId: 'om_topic', scope: 'thread',
          larkAppId: 'app_traex', botName: 'Nil-TraeX', cliId: 'traex', status: 'idle',
          title: '后续处理', lastMessageAt: 90,
        },
      ],
      selected: new Set<string>(),
      hidden: false,
      onToggleSelect: () => {},
      onOpen: () => {},
      onHistory: () => {},
      onLocate: async () => true,
      onRestart: () => {},
      onLock: () => {},
      onClose: () => {},
    }));

    expect(html).toContain('class="session-topic-group multi-bot inferred-bot-trigger"');
    expect(html).toContain('data-topic-key="thread');
    expect(html).toContain('多 Bot 协作');
    expect(html).toContain('1 个会话最近由 Bot 唤醒（推断）');
    expect((html.match(/<article class="session-card/g) ?? []).length).toBe(2);
  });

  it('labels an incomplete topic anchor as a single session', () => {
    const html = renderToStaticMarkup(createElement(TopicGroupsView, {
      rows: [{
        sessionId: 'orphan', chatId: 'oc_coding', rootMessageId: '', scope: 'thread',
        larkAppId: 'app_codex', botName: 'Nil-Codex', cliId: 'codex', status: 'idle',
        lastMessageAt: 100,
      }],
      selected: new Set<string>(),
      hidden: false,
      onToggleSelect: () => {},
      onOpen: () => {},
      onHistory: () => {},
      onLocate: async () => true,
      onRestart: () => {},
      onLock: () => {},
      onClose: () => {},
    }));

    expect(html).toContain('>单会话</code>');
    expect(html).not.toContain('整群会话');
  });

  it('keeps full topic relation metadata when current filters hide sibling sessions', () => {
    const visible = {
      sessionId: 'codex', chatId: 'oc_coding', rootMessageId: 'om_topic', scope: 'thread',
      larkAppId: 'app_codex', botName: 'Nil-Codex', cliId: 'codex', status: 'working',
      title: '协作排查', lastMessageAt: 100,
    };
    const hiddenClosed = {
      sessionId: 'traex', chatId: 'oc_coding', rootMessageId: 'om_topic', scope: 'thread',
      larkAppId: 'app_traex', botName: 'Nil-TraeX', cliId: 'traex', status: 'closed',
      title: '后续处理', lastMessageAt: 90, lastInputFromBot: true,
    };
    const html = renderToStaticMarkup(createElement(TopicGroupsView, {
      rows: [visible],
      relationRows: [visible, hiddenClosed],
      selected: new Set<string>(),
      hidden: false,
      onToggleSelect: () => {},
      onOpen: () => {},
      onHistory: () => {},
      onLocate: async () => true,
      onRestart: () => {},
      onLock: () => {},
      onClose: () => {},
    }));

    expect(html).toContain('session-topic-group multi-bot inferred-bot-trigger');
    expect(html).toContain('2 个会话');
    expect(html).toContain('1 已关闭');
    expect((html.match(/<article class="session-card/g) ?? []).length).toBe(1);
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

  it('renders the CLI filter as a multi-select checkbox group, not a dropdown', () => {
    const html = renderToStaticMarkup(createElement(CliFilterGroup, {
      selected: new Set(CLI_FILTER_OPTIONS),
      onToggle: () => {},
    }));
    // One checkbox per CLI option, named "cli" — never a <select> dropdown.
    expect(html).toContain('name="cli"');
    expect(html).not.toContain('<select');
    expect((html.match(/type="checkbox"/g) ?? []).length).toBe(CLI_FILTER_OPTIONS.length);
    // Full set selected ⇒ summary shows "all", not the partial/active marker.
    expect(html).not.toContain('cli-filter-active');
  });

  it('reflects a partial CLI selection (unchecked entries + active marker)', () => {
    const selected = new Set(CLI_FILTER_OPTIONS.filter(cli => cli !== 'codex'));
    const html = renderToStaticMarkup(createElement(CliFilterGroup, { selected, onToggle: () => {} }));
    expect(html).toContain('value="codex"');
    expect(html).toContain('cli-filter-active');
    // Exactly the deselected CLI is unchecked.
    expect((html.match(/checked=""/g) ?? []).length).toBe(CLI_FILTER_OPTIONS.length - 1);
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
    expect(html).toContain('class="session-signal"');
    expect(html).toContain('长时间无进展');
    // 重设计后：状态色条 + 「终端」文字按钮 + 「⋯」菜单（原 icon rail 已移除）
    expect(html).toContain('data-signal="needs-you"');
    expect(html).toContain('class="kanban-card-term"');
    expect(html).toContain('data-action="more"');
    expect(html).toContain('kanban-col-dot kanban-col-dot-');
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

  it('omits the terminal action when the embedding shell does not provide it', () => {
    const html = renderToStaticMarkup(createElement(SessionsKanbanView, {
      host: null,
      ...kanbanCallbacks,
      onOpenTerminal: undefined,
      onOpenWritableTerminal: undefined,
      rows: [{
        sessionId: 'embedded-session',
        status: 'working',
        cliId: 'codex',
        title: 'Embedded',
        botName: 'Bot A',
        lastMessageAt: 1000,
        webPort: 3001,
      }],
      groupBy: 'flow',
      teams: [],
      teamsLoaded: true,
      teamKey: '',
      teamBoardData: null,
      teamBoardKey: '',
    }));

    expect(html).not.toContain('data-action="terminal"');
    expect(html).not.toContain('data-action="write-link"');
  });

  it('renders separate read-only and writable terminal actions when both are available', () => {
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

    // 只读终端 = 底部「终端」文字按钮；可写终端收进「⋯」菜单（data-menu-items 静态标记）
    expect(html).toContain('data-action="terminal"');
    expect(html).toContain('data-menu-items="details,history,write-link,restart,lock,close"');
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
