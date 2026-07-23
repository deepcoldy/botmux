import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SessionsKanbanView, type SessionsKanbanCallbacks, type SessionsKanbanState } from '../src/dashboard/web/sessions-kanban.js';
import {
  canRestartSession,
  CLI_FILTER_OPTIONS,
  SESSION_STATUS_OPTIONS,
  deriveSessionBoardColumn,
  groupSessionsByTopic,
  isUnknownChatSession,
  restartConfirmMessage,
  historySenderKey,
  sessionLocationText,
  sessionTopicKey,
  shouldOpenWritableTerminal,
} from '../src/dashboard/web/sessions.js';
import { CliFilterGroup, TopicGroupsView } from '../src/dashboard/web/sessions-page.js';

const kanbanCallbacks: SessionsKanbanCallbacks = {
  canRestartSession: row => row.status !== 'closed',
  getTeamChatIds: () => new Set<string>(),
  icons: {
    details: '<svg></svg>',
    feishu: '<svg></svg>',
    history: '<svg></svg>',
    lock: '<svg></svg>',
    restart: '<svg></svg>',
    terminal: '<svg></svg>',
    unlock: '<svg></svg>',
  },
  lockActionLabel: row => (row.locked ? 'unlock' : 'lock'),
  sessionStatusText: status => String(status ?? 'unknown'),
  onDetails: () => {},
  onHistory: () => {},
  onMoveRows: () => {},
  onNeedTeamBoard: () => {},
  onNeedTeams: () => {},
  onOpenTerminal: () => {},
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
  });

  it('formats session location labels for group chats and direct chats', () => {
    expect(sessionLocationText({ chatType: 'group', chatId: 'oc_group' })).toBe('群聊 · oc_group');
    expect(sessionLocationText({ chatType: 'p2p', chatId: 'oc_dm', chatDisplayName: '韩毅' })).toBe('单聊 · 韩毅');
    expect(sessionLocationText({ chatType: 'p2p', chatId: 'oc_dm' })).toBe('单聊 · oc_dm');
    expect(sessionLocationText({})).toBe('未知聊天');
  });

  it('treats sessions with chatId but no resolved chat title as unknown chats', () => {
    const row = { chatType: 'group', chatId: 'oc_stale' };
    const namedDirect = { chatType: 'p2p', chatId: 'oc_dm', chatDisplayName: '韩毅' };

    expect(isUnknownChatSession(row, () => null)).toBe(true);
    expect(isUnknownChatSession(row, () => 'SellerIM Agent 集中营')).toBe(false);
    expect(isUnknownChatSession(namedDirect)).toBe(false);
    expect(isUnknownChatSession({}, () => null)).toBe(false);
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
        { sessionId: 's-progress', status: 'working', cliId: 'codex', title: 'Working', botName: 'Bot A', lastMessageAt: 3000 },
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
    expect(html).toContain('class="card-act kanban-card-act"');
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
});
