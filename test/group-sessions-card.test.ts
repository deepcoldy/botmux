import { describe, expect, it, vi } from 'vitest';

import type { DaemonClient } from '../src/dashboard/daemon-internal-client.js';
import type { SessionRow } from '../src/core/dashboard-rows.js';
import { handleGroupSessionsCommand } from '../src/core/group-sessions-command.js';
import { matchesExpectedSessionLocateScope } from '../src/core/session-locate-guard.js';
import {
  buildGroupSessionsCard,
  filterGroupSessions,
  GROUP_SESSIONS_ACTION_LOCATE,
  GROUP_SESSIONS_ACTION_REFRESH,
  GROUP_SESSIONS_ACTION_RESUME,
  handleGroupSessionsCardAction,
} from '../src/im/lark/group-sessions-card.js';

const APP = 'cli_app';
const CHAT = 'oc_group';
const USER = 'ou_user';
const NOW = 2_000_000;

function row(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    sessionId: 'session-secret',
    larkAppId: APP,
    botName: 'Bot',
    cliId: 'codex',
    status: 'idle',
    adopt: false,
    spawnedAt: 1_000_000,
    lastMessageAt: 1_900_000,
    chatId: CHAT,
    rootMessageId: 'om_root',
    scope: 'thread',
    title: 'Topic title',
    webPort: null,
    feishuChatLink: 'https://applink.feishu.cn/client/chat/open?openChatId=oc_group',
    ...overrides,
  };
}

function clientWith(rows: SessionRow[]) {
  const request = vi.fn(async (opts: { method?: string; path: string; body?: unknown }) => {
    if (opts.method === 'POST') return { status: 200, body: { ok: true }, raw: '' };
    return { status: 200, body: { sessions: rows }, raw: '' };
  });
  return { request } as unknown as DaemonClient & { request: ReturnType<typeof vi.fn> };
}

function callback(action: Record<string, string>, operator = USER, messageId = 'om_card') {
  return {
    operator: { open_id: operator },
    context: { open_message_id: messageId },
    action: { value: action },
  };
}

describe('/sessions current-group card', () => {
  it('filters simultaneously by bot, chat, and thread scope while retaining closed rows', () => {
    const keep = row();
    const closed = row({ sessionId: 'closed', status: 'closed' });
    const rows = [
      keep,
      row({ sessionId: 'other-bot', larkAppId: 'cli_other' }),
      row({ sessionId: 'other-chat', chatId: 'oc_other' }),
      row({ sessionId: 'chat-scope', scope: 'chat' }),
      closed,
      row({ sessionId: 'legacy-ownerless', larkAppId: '' }),
    ];
    expect(filterGroupSessions(rows, { larkAppId: APP, chatId: CHAT })).toEqual([keep, closed]);
  });

  it('sorts active sessions before closed, hides sensitive fields, and uses direct topic links when present', () => {
    const card = JSON.parse(buildGroupSessionsCard([
      row({ sessionId: 'idle-secret', title: 'Idle', status: 'idle', lastMessageAt: NOW - 1_000, workingDir: '/secret/repo' }),
      row({ sessionId: 'working-secret', title: 'Working', status: 'working', lastMessageAt: NOW - 50_000, feishuThreadLink: 'https://applink/topic' }),
      row({ sessionId: 'closed-secret', title: 'Closed', status: 'closed', lastMessageAt: NOW }),
    ], { larkAppId: APP, chatId: CHAT, invokerOpenId: USER, locale: 'en', page: 1, timeZone: 'UTC' }, NOW));
    const encoded = JSON.stringify(card);
    expect(encoded.indexOf('**Working**')).toBeLessThan(encoded.indexOf('**Idle**'));
    expect(encoded.indexOf('**Idle**')).toBeLessThan(encoded.indexOf('**Closed**'));
    expect(encoded).not.toContain('/secret/repo');
    expect(encoded).not.toContain('working-secret');
    expect(encoded).toContain('https://applink/topic');
    const visible = card.elements
      .flatMap((element: any) => [element.text?.content, ...(element.actions ?? []).map((a: any) => a.text?.content)])
      .filter(Boolean)
      .join('\n');
    expect(visible).not.toContain('idle-secret');
    expect(visible).toContain('Active 2 · Closed 1');
    expect(encoded).toContain('Data as of');
  });

  it('shows resume only for an admin-generated card and keeps the session id hidden from visible text', () => {
    const closed = row({ status: 'closed', title: 'Old topic' });
    const ordinary = buildGroupSessionsCard(
      [closed],
      { larkAppId: APP, chatId: CHAT, invokerOpenId: USER, locale: 'en', page: 1, timeZone: 'UTC' },
      NOW,
    );
    const admin = JSON.parse(buildGroupSessionsCard(
      [closed],
      {
        larkAppId: APP, chatId: CHAT, invokerOpenId: USER, canResume: true,
        locale: 'en', page: 1, timeZone: 'UTC',
      },
      NOW,
    ));
    expect(ordinary).not.toContain(GROUP_SESSIONS_ACTION_RESUME);
    expect(JSON.stringify(admin)).toContain(GROUP_SESSIONS_ACTION_RESUME);
    const visible = admin.elements
      .flatMap((element: any) => [element.text?.content, ...(element.actions ?? []).map((a: any) => a.text?.content)])
      .filter(Boolean)
      .join('\n');
    expect(visible).toContain('Resume');
    expect(visible).not.toContain('session-secret');
  });

  it('uses a locked legacy locate callback without rendering the session id', () => {
    const card = JSON.parse(buildGroupSessionsCard(
      [row({ feishuThreadLink: undefined })],
      { larkAppId: APP, chatId: CHAT, invokerOpenId: USER, locale: 'en', page: 1 },
      NOW,
    ));
    const encoded = JSON.stringify(card);
    expect(encoded).toContain(GROUP_SESSIONS_ACTION_LOCATE);
    expect(encoded).toContain('session-secret'); // hidden action routing value
    const visible = card.elements
      .flatMap((element: any) => [element.text?.content, ...(element.actions ?? []).map((a: any) => a.text?.content)])
      .filter(Boolean)
      .join('\n');
    expect(visible).not.toContain('session-secret');
  });

  it('orders equal-status rows by recent activity and paginates at five rows', () => {
    const rows = Array.from({ length: 6 }, (_, index) => row({
      sessionId: `session-${index}`,
      title: `Topic ${index}`,
      lastMessageAt: NOW - index * 1_000,
      feishuThreadLink: `https://applink/topic-${index}`,
    }));
    const firstPage = JSON.parse(buildGroupSessionsCard(
      rows,
      { larkAppId: APP, chatId: CHAT, invokerOpenId: USER, locale: 'en', page: 1 },
      NOW,
    ));
    const encoded = JSON.stringify(firstPage);
    expect(encoded.indexOf('Topic 0')).toBeLessThan(encoded.indexOf('Topic 1'));
    expect(encoded).toContain('Topic 4');
    expect(encoded).not.toContain('Topic 5');
    expect(encoded).toContain('Page 1/2');
  });

  it('renders a clear empty state when the current group has no matching sessions', () => {
    const card = buildGroupSessionsCard(
      [row({ chatId: 'oc_other' }), row({ scope: 'chat' })],
      { larkAppId: APP, chatId: CHAT, invokerOpenId: USER, locale: 'en', page: 1 },
      NOW,
    );
    expect(card).toContain('There are no topic sessions for this bot in the current group.');
  });

  it('rejects a different operator before opening a Route B client', async () => {
    const createClient = vi.fn();
    const result = await handleGroupSessionsCardAction(callback({
      action: GROUP_SESSIONS_ACTION_REFRESH,
      invoker_open_id: USER,
      chat_id: CHAT,
    }, 'ou_other'), APP, { createClient, locale: 'en' });
    expect(result.toast?.type).toBe('info');
    expect(createClient).not.toHaveBeenCalled();
  });

  it('rejects a forwarded/tampered card whose real message chat differs', async () => {
    const createClient = vi.fn();
    const result = await handleGroupSessionsCardAction(callback({
      action: GROUP_SESSIONS_ACTION_REFRESH,
      invoker_open_id: USER,
      chat_id: CHAT,
    }), APP, {
      createClient,
      getMessageChatId: vi.fn(async () => 'oc_other'),
      locale: 'en',
    });
    expect(result.toast?.type).toBe('error');
    expect(createClient).not.toHaveBeenCalled();
  });

  it('freshly revalidates locate and sends an atomic daemon-side scope guard', async () => {
    const client = clientWith([row({ feishuThreadLink: undefined })]);
    const result = await handleGroupSessionsCardAction(callback({
      action: GROUP_SESSIONS_ACTION_LOCATE,
      invoker_open_id: USER,
      chat_id: CHAT,
      session_id: 'session-secret',
    }), APP, {
      createClient: () => client,
      getMessageChatId: vi.fn(async () => CHAT),
      locale: 'en',
    });
    expect(result.toast?.type).toBe('success');
    expect(client.request).toHaveBeenLastCalledWith(expect.objectContaining({
      method: 'POST',
      path: '/__daemon/sessions/session-secret/locate',
      body: {
        expectedLarkAppId: APP,
        expectedChatId: CHAT,
        expectedScope: 'thread',
        expectedOpen: true,
      },
    }));
  });

  it('locates a closed legacy row without requiring it to remain open', async () => {
    const client = clientWith([row({ status: 'closed', feishuThreadLink: undefined })]);
    const result = await handleGroupSessionsCardAction(callback({
      action: GROUP_SESSIONS_ACTION_LOCATE,
      invoker_open_id: USER,
      chat_id: CHAT,
      session_id: 'session-secret',
    }), APP, {
      createClient: () => client,
      getMessageChatId: vi.fn(async () => CHAT),
      locale: 'en',
    });
    expect(result.toast?.type).toBe('success');
    expect(client.request).toHaveBeenLastCalledWith(expect.objectContaining({
      body: expect.objectContaining({ expectedOpen: false }),
    }));
  });

  it('fails closed when the fresh row moved to another chat', async () => {
    const client = clientWith([row({ chatId: 'oc_other' })]);
    const result = await handleGroupSessionsCardAction(callback({
      action: GROUP_SESSIONS_ACTION_LOCATE,
      invoker_open_id: USER,
      chat_id: CHAT,
      session_id: 'session-secret',
    }), APP, {
      createClient: () => client,
      getMessageChatId: vi.fn(async () => CHAT),
      locale: 'en',
    });
    expect(result.toast?.type).toBe('error');
    expect(client.request).toHaveBeenCalledTimes(1);
  });

  it('rejects a forged resume action from a non-admin before opening Route B', async () => {
    const createClient = vi.fn();
    const result = await handleGroupSessionsCardAction(callback({
      action: GROUP_SESSIONS_ACTION_RESUME,
      invoker_open_id: USER,
      chat_id: CHAT,
      session_id: 'session-secret',
    }), APP, {
      createClient,
      getMessageChatId: vi.fn(async () => CHAT),
      getDashboardAdminOpenIds: () => [],
      locale: 'en',
    });
    expect(result.toast?.content).toContain('Only bot admins');
    expect(createClient).not.toHaveBeenCalled();
  });

  it('revalidates and resumes a closed row for an admin, then rebuilds page one', async () => {
    let resumed = false;
    const request = vi.fn(async (opts: { method?: string; path: string }) => {
      if (opts.method === 'POST') {
        resumed = true;
        return { status: 200, body: { ok: true }, raw: '' };
      }
      return {
        status: 200,
        body: { sessions: [row({ status: resumed ? 'idle' : 'closed', title: 'Restored topic' })] },
        raw: '',
      };
    });
    const client = { request } as unknown as DaemonClient;
    const result = await handleGroupSessionsCardAction(callback({
      action: GROUP_SESSIONS_ACTION_RESUME,
      invoker_open_id: USER,
      chat_id: CHAT,
      session_id: 'session-secret',
      page: '3',
    }), APP, {
      createClient: () => client,
      getMessageChatId: vi.fn(async () => CHAT),
      getDashboardAdminOpenIds: () => [USER],
      locale: 'en',
      nowMs: () => NOW,
    });
    expect(request).toHaveBeenCalledWith({
      method: 'POST',
      path: '/__daemon/sessions/session-secret/resume',
    });
    expect(result.card?.data).toEqual(expect.objectContaining({ elements: expect.any(Array) }));
    expect(JSON.stringify(result.card?.data)).toContain('Active 1 · Closed 0 · Page 1/1');
  });

  it('does not POST resume when the fresh row is no longer closed', async () => {
    const client = clientWith([row({ status: 'idle' })]);
    const result = await handleGroupSessionsCardAction(callback({
      action: GROUP_SESSIONS_ACTION_RESUME,
      invoker_open_id: USER,
      chat_id: CHAT,
      session_id: 'session-secret',
    }), APP, {
      createClient: () => client,
      getMessageChatId: vi.fn(async () => CHAT),
      getDashboardAdminOpenIds: () => [USER],
      locale: 'en',
    });
    expect(result.toast?.type).toBe('error');
    expect((client as any).request).toHaveBeenCalledTimes(1);
  });
});

describe('/sessions command entry', () => {
  it('rejects p2p before fetching session rows', async () => {
    const createClient = vi.fn();
    const sessionReply = vi.fn(async () => 'om_reply');
    await handleGroupSessionsCommand({
      messageId: 'om_cmd', rootId: 'om_cmd', chatId: CHAT, senderId: USER,
      senderType: 'user', msgType: 'text', content: '/sessions', createTime: '0',
    }, 'om_cmd', CHAT, { sessionReply } as any, APP, {
      createClient,
      getChatModeStrict: vi.fn(async () => 'p2p'),
      locale: 'en',
    });
    expect(createClient).not.toHaveBeenCalled();
    expect(sessionReply).toHaveBeenCalledWith('om_cmd', expect.stringContaining('group chats only'), undefined, APP);
  });

  it('posts the compact card in the invoking group for an ordinary operator', async () => {
    const client = clientWith([row()]);
    const sessionReply = vi.fn(async () => 'om_reply');
    await handleGroupSessionsCommand({
      messageId: 'om_cmd', rootId: 'om_cmd', chatId: CHAT, senderId: USER,
      senderType: 'user', msgType: 'text', content: '/sessions', createTime: '0',
    }, 'om_cmd', CHAT, { sessionReply } as any, APP, {
      createClient: () => client,
      getChatModeStrict: vi.fn(async () => 'topic'),
      locale: 'en',
      nowMs: () => NOW,
    });
    expect(sessionReply).toHaveBeenCalledWith(
      'om_cmd', expect.stringContaining('Topics in this group'), 'interactive', APP,
    );
  });

  it('renders resume for a dashboard admin invoking the command', async () => {
    const client = clientWith([row({ status: 'closed' })]);
    const sessionReply = vi.fn(async () => 'om_reply');
    await handleGroupSessionsCommand({
      messageId: 'om_cmd', rootId: 'om_cmd', chatId: CHAT, senderId: USER,
      senderType: 'user', msgType: 'text', content: '/sessions', createTime: '0',
    }, 'om_cmd', CHAT, { sessionReply } as any, APP, {
      createClient: () => client,
      getChatModeStrict: vi.fn(async () => 'topic'),
      getDashboardAdminOpenIds: () => [USER],
      locale: 'en',
      nowMs: () => NOW,
    });
    expect(sessionReply).toHaveBeenCalledWith(
      'om_cmd', expect.stringContaining(GROUP_SESSIONS_ACTION_RESUME), 'interactive', APP,
    );
  });
});

describe('daemon locate compare-before-use guard', () => {
  const target = { larkAppId: APP, chatId: CHAT, scope: 'thread' as const, status: 'active' };

  it('keeps legacy dashboard {} requests compatible', () => {
    expect(matchesExpectedSessionLocateScope(target, {})).toBe(true);
  });

  it('rejects cross-bot, cross-chat, scope, and closed races', () => {
    expect(matchesExpectedSessionLocateScope(target, { expectedLarkAppId: 'cli_other' })).toBe(false);
    expect(matchesExpectedSessionLocateScope(target, { expectedChatId: 'oc_other' })).toBe(false);
    expect(matchesExpectedSessionLocateScope(target, { expectedScope: 'chat' })).toBe(false);
    expect(matchesExpectedSessionLocateScope({ ...target, status: 'closed' }, { expectedOpen: true })).toBe(false);
  });
});
