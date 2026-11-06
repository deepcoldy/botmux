import { describe, expect, it, vi } from 'vitest';

import type { LarkMessage } from '../src/types.js';
import type { CommandHandlerDeps } from '../src/core/command-handler.js';
import { handleDashboardCommand, type DashboardCommandDeps } from '../src/core/dashboard-command/index.js';
import { deliverDashboardAdminLink } from '../src/core/dashboard-command/link.js';

const ADMIN = 'ou_admin';
const CHAT = 'oc_group_chat';
const URL_TOKEN_PART = '?t=secret-token-123#/';

const LINK = Object.freeze({
  url: `http://10.20.30.40:7900/${URL_TOKEN_PART}`,
  host: '10.20.30.40',
  port: 7900,
  loopbackOnly: false,
  platformHosted: false,
});

function makeMessage(over: Partial<LarkMessage> = {}): LarkMessage {
  return {
    messageId: 'om_msg_1',
    rootId: 'om_msg_1',
    senderId: ADMIN,
    senderType: 'user',
    content: '/dashboard link',
    chatId: CHAT,
    chatType: 'group',
    msgType: 'text',
    ...over,
  } as LarkMessage;
}

function makeDeps(): CommandHandlerDeps {
  return {
    activeSessions: new Map() as any,
    sessionReply: vi.fn(async () => 'om_reply'),
    getActiveCount: () => 0,
    lastRepoScan: new Map() as any,
  };
}

function adminLookup(admins: ReadonlyArray<string> | undefined = [ADMIN]) {
  return { getDashboardAdminOpenIds: () => admins };
}

function linkSeams(link: typeof LINK = LINK, chatMode: 'group' | 'topic' = 'group'): DashboardCommandDeps['link'] {
  return {
    resolveLink: () => ({ ok: true, link: { ...link } }),
    sendUserMessage: vi.fn(async () => 'om_dm'),
    sendEphemeralCard: vi.fn(async () => 'om_eph'),
    getChatMode: vi.fn(async () => chatMode),
  };
}

describe('/dashboard link private delivery', () => {
  it('p2p: replies directly in the 1:1 chat and never uses group channels', async () => {
    const deps = makeDeps();
    const seams = linkSeams();
    const message = makeMessage({ chatType: 'p2p', chatId: 'ou_admin_p2p' });

    await handleDashboardCommand(message, 'link', message.messageId, message.chatId!, deps, 'cli_test', {
      ...adminLookup(),
      link: seams,
    });

    const replies = (deps.sessionReply as any).mock.calls;
    expect(replies).toHaveLength(1);
    expect(replies[0][1]).toContain(LINK.url);
    expect(seams.sendUserMessage).not.toHaveBeenCalled();
    expect(seams.sendEphemeralCard).not.toHaveBeenCalled();
  });

  it('flat group: delivers a requester-only ephemeral card carrying the token, with no public token reply', async () => {
    const deps = makeDeps();
    const seams = linkSeams();

    await handleDashboardCommand(makeMessage(), 'link', 'om_msg_1', CHAT, deps, 'cli_test', {
      ...adminLookup(),
      link: seams,
    });

    expect(seams.sendEphemeralCard).toHaveBeenCalledOnce();
    const [appId, chatId, openId, cardJson] = (seams.sendEphemeralCard as any).mock.calls[0];
    expect({ appId, chatId, openId }).toEqual({ appId: 'cli_test', chatId: CHAT, openId: ADMIN });
    expect(cardJson).toContain(LINK.url);
    expect(seams.sendUserMessage).not.toHaveBeenCalled();
    // Nothing token-bearing is posted to the group topic.
    for (const call of (deps.sessionReply as any).mock.calls) {
      expect(call[1]).not.toContain('secret-token-123');
    }
  });

  it('topic/thread reply: skips ephemeral (Feishu rejects it there) and DMs the link', async () => {
    const deps = makeDeps();
    const seams = linkSeams();
    const message = makeMessage({ rootId: 'om_topic_root', threadId: 'om_topic_thread' });

    const channel = await deliverDashboardAdminLink({
      larkAppId: 'cli_test',
      message,
      rootId: 'om_topic_root',
      adminOpenId: ADMIN,
      reply: (content: string, msgType?: 'text' | 'interactive') => deps.sessionReply('om_msg_1', content, msgType, 'cli_test'),
      seams,
    });

    expect(channel).toBe('dm');
    expect(seams.sendEphemeralCard).not.toHaveBeenCalled();
    expect(seams.sendUserMessage).toHaveBeenCalledOnce();
    const [, openId, content, msgType] = (seams.sendUserMessage as any).mock.calls[0];
    expect({ openId, msgType }).toEqual({ openId: ADMIN, msgType: 'text' });
    expect(content).toContain(LINK.url);
  });

  it('topic-mode group top-level: skips ephemeral entirely and DMs the link', async () => {
    const deps = makeDeps();
    const seams = linkSeams(LINK, 'topic');

    const channel = await deliverDashboardAdminLink({
      larkAppId: 'cli_test',
      message: makeMessage(),
      rootId: 'om_msg_1',
      adminOpenId: ADMIN,
      reply: (content: string) => deps.sessionReply('om_msg_1', content, undefined, 'cli_test'),
      seams,
    });

    expect(channel).toBe('dm');
    expect(seams.sendEphemeralCard).not.toHaveBeenCalled();
    expect(seams.sendUserMessage).toHaveBeenCalledOnce();
    expect((seams.sendUserMessage as any).mock.calls[0][2]).toContain(LINK.url);
  });

  it('flat group where ephemeral fails (18053): falls over to DM', async () => {
    const deps = makeDeps();
    const seams = linkSeams();
    (seams.sendEphemeralCard as any) = vi.fn(async () => {
      throw new Error('18053 chat can not be thread');
    });

    const channel = await deliverDashboardAdminLink({
      larkAppId: 'cli_test',
      message: makeMessage(),
      rootId: 'om_msg_1',
      adminOpenId: ADMIN,
      reply: (content: string, msgType?: 'text' | 'interactive') => deps.sessionReply('om_msg_1', content, msgType, 'cli_test'),
      seams,
    });

    expect(channel).toBe('dm');
    const dmContent = (seams.sendUserMessage as any).mock.calls[0][2];
    expect(dmContent).toContain(LINK.url);
  });

  it('when BOTH private channels fail, replies with a token-free error and never posts the link publicly', async () => {
    const deps = makeDeps();
    const seams: DashboardCommandDeps['link'] = {
      resolveLink: () => ({ ok: true, link: { ...LINK } }),
      sendUserMessage: vi.fn(async () => { throw new Error('dm disabled'); }),
      sendEphemeralCard: vi.fn(async () => { throw new Error('18053 chat can not be thread'); }),
      getChatMode: vi.fn(async () => 'group'),
    };

    const channel = await deliverDashboardAdminLink({
      larkAppId: 'cli_test',
      message: makeMessage(),
      rootId: 'om_msg_1',
      adminOpenId: ADMIN,
      reply: (content: string, msgType?: 'text' | 'interactive') => deps.sessionReply('om_msg_1', content, msgType, 'cli_test'),
      seams,
    });

    expect(channel).toBe('failed');
    const replies = (deps.sessionReply as any).mock.calls;
    expect(replies.length).toBeGreaterThan(0);
    for (const call of replies) {
      expect(call[1]).not.toContain('secret-token-123');
      expect(call[1]).not.toContain(LINK.url);
    }
  });

  it('appends a local-only warning when the dashboard binds loopback', async () => {
    const deps = makeDeps();
    const seams = linkSeams({ ...LINK, host: '127.0.0.1', loopbackOnly: true, url: 'http://127.0.0.1:7900/?t=secret-token-123#/' });

    const channel = await deliverDashboardAdminLink({
      larkAppId: 'cli_test',
      message: makeMessage({ chatType: 'p2p', chatId: 'ou_admin_p2p' }),
      rootId: 'om_msg_1',
      adminOpenId: ADMIN,
      reply: (content: string, msgType?: 'text' | 'interactive') => deps.sessionReply('om_msg_1', content, msgType, 'cli_test'),
      seams,
    });

    expect(channel).toBe('p2p');
    const body = (deps.sessionReply as any).mock.calls[0][1];
    expect(body).toContain('127.0.0.1:7900');
    expect(body).toMatch(/本机|this machine|localhost/i);
  });

  it('reports unavailable (token-free) when the link cannot be resolved', async () => {
    const deps = makeDeps();
    const seams: DashboardCommandDeps['link'] = {
      resolveLink: () => ({ ok: false, reason: 'token_unavailable' }),
      sendUserMessage: vi.fn(),
      sendEphemeralCard: vi.fn(),
      getChatMode: vi.fn(async () => 'group'),
    };

    const channel = await deliverDashboardAdminLink({
      larkAppId: 'cli_test',
      message: makeMessage(),
      rootId: 'om_msg_1',
      adminOpenId: ADMIN,
      reply: (content: string, msgType?: 'text' | 'interactive') => deps.sessionReply('om_msg_1', content, msgType, 'cli_test'),
      seams,
    });

    expect(channel).toBe('unavailable');
    expect(seams.sendUserMessage).not.toHaveBeenCalled();
    expect(seams.sendEphemeralCard).not.toHaveBeenCalled();
    for (const call of (deps.sessionReply as any).mock.calls) {
      expect(call[1]).not.toContain('secret-token');
    }
  });
});

describe('/dashboard link authorization', () => {
  it('denies a non-admin without resolving the link or touching any private channel', async () => {
    const deps = makeDeps();
    const seams = linkSeams();

    await handleDashboardCommand(makeMessage({ senderId: 'ou_stranger' }), 'link', 'om_msg_1', CHAT, deps, 'cli_test', {
      ...adminLookup([ADMIN]),
      link: seams,
    });

    expect(seams.sendUserMessage).not.toHaveBeenCalled();
    expect(seams.sendEphemeralCard).not.toHaveBeenCalled();
    const reply = (deps.sessionReply as any).mock.calls[0][1] as string;
    expect(reply).toMatch(/管理员|admin/i);
    expect(reply).not.toContain('secret-token');
  });

  it('fails closed when the bot has no resolved allowedUsers admins', async () => {
    const deps = makeDeps();
    const seams = linkSeams();

    await handleDashboardCommand(makeMessage(), 'link', 'om_msg_1', CHAT, deps, 'cli_test', {
      ...adminLookup([]),
      link: seams,
    });

    expect(seams.sendUserMessage).not.toHaveBeenCalled();
    expect(seams.sendEphemeralCard).not.toHaveBeenCalled();
  });
});

describe('/dashboard link argv parsing', () => {
  // /dash whitespace/lowercase pins live in command-router-dash.test.ts; here
  // only the subcommand split that reaches handleDashboardCommand is pinned.
  it('keeps the link subcommand visible regardless of internal spacing', async () => {
    const { parseSlashCommandInvocation } = await import('../src/core/command-router.js');
    expect(parseSlashCommandInvocation('/dashboard link')?.cmd).toBe('/dashboard');
    expect(parseSlashCommandInvocation('/dashboard    link')?.content).toBe('/dashboard    link');
  });
});
