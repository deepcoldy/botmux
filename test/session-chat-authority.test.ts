/**
 * Session chat tools × the bot's real talk/command policy: group creation needs
 * the human `/group` command's authority and talk in a chat that does not exist
 * yet; chat-scoped grants of the source chat carry neither. Only the Lark API
 * is stubbed; the decisions are the daemon's own evaluators.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let tempDir: string;

vi.mock('@larksuiteoapi/node-sdk', () => {
  class FakeClient { constructor(public opts: Record<string, unknown>) {} }
  return { Client: FakeClient };
});

vi.mock('../src/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/config.js')>();
  return {
    ...actual,
    config: { ...actual.config, session: { ...actual.config.session, get dataDir() { return tempDir; } } },
  };
});

import { registerBot, __testOnly_resetBotRegistry } from '../src/bot-registry.js';
import { sessionChatAuthority } from '../src/core/session-chat-authority.js';
import { handleSessionChatTool, type SessionChatContext, type SessionChatDeps } from '../src/core/session-chat-tools.js';
import { authorizeSandboxSendRoute } from '../src/core/sandbox-send-route.js';

const APP = 'cli_chat_authority';
const SOURCE = 'oc_source';
const CREATED = 'oc_created';
const OWNER = 'ou_owner';
const VISITOR = 'ou_visitor';

function restrictedBot() {
  const bot = registerBot({ larkAppId: APP, larkAppSecret: 's', cliId: 'claude-code', allowedUsers: [OWNER] });
  bot.resolvedAllowedUsers = [OWNER];
  bot.resolvedBlockedUsers = [];
  return bot;
}

function run(caller: string) {
  const writes: string[][] = [];
  const authority = sessionChatAuthority(APP, { chatId: SOURCE, chatType: 'group' });
  const deps: SessionChatDeps = {
    route: {
      lookupMessageChatId: async () => null,
      getChatInfo: async () => ({ external: false, mode: 'group' }),
      isBotInChat: async () => true,
      listMemberOpenIds: async () => [caller, 'ou_qa'],
      canTalk: authority.canTalk,
    },
    canCreateChat: authority.canCreateChat,
    canTalkInNewChat: authority.canTalkInNewChat,
    resolveMembers: async ids => new Map(ids.map(id => [id, 'ou_qa'])),
    listMembers: async () => [{ openId: 'ou_qa', name: 'QA' }],
    create: async input => { writes.push(input.userIds); return { chatId: CREATED, invalidUserIds: [] }; },
  };
  const ctx: SessionChatContext = {
    sessionId: 'session', larkAppId: APP, chatId: SOURCE, turnId: 'turn', callerOpenId: caller,
    humanCaller: true, enabled: true, isCurrent: () => true,
  };
  return {
    writes,
    create: () => handleSessionChatTool({ action: 'create', turnId: 'turn', name: 'QA', members: ['qa@example.com'], chatMode: 'group' }, ctx, deps),
    members: (chatId?: string) => handleSessionChatTool({ action: 'members', turnId: 'turn', ...(chatId ? { chatId } : {}) }, ctx, deps),
    sendToCreated: () => authorizeSandboxSendRoute({ sessionChatId: SOURCE, chatId: CREATED, turnCallerOpenId: caller }, deps.route),
  };
}

const CHAT_SCOPED: Record<string, (bot: ReturnType<typeof restrictedBot>) => void> = {
  chatGrant: bot => { bot.config.chatGrants = { [SOURCE]: [VISITOR] }; },
  oncall: bot => { bot.config.oncallChats = [{ chatId: SOURCE, workingDir: '/tmp' }]; },
  allowedChatGroup: bot => { bot.config.allowedChatGroups = [SOURCE]; },
};

describe('session chat creation authority', () => {
  beforeEach(() => {
    __testOnly_resetBotRegistry();
    tempDir = mkdtempSync(join(tmpdir(), 'session-chat-authority-'));
  });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it.each(Object.keys(CHAT_SCOPED))('a %s visitor may talk and list the source chat but not create a group', async leg => {
    CHAT_SCOPED[leg]!(restrictedBot());
    const visitor = run(VISITOR);
    expect((await visitor.members()).status).toBe(200);
    expect(await visitor.create()).toEqual({ status: 403, body: { ok: false, error: 'chat_create_not_authorized' } });
    expect(visitor.writes).toEqual([]);
  });

  it('lets the bot admin create, list and notify the new group', async () => {
    restrictedBot();
    const owner = run(OWNER);
    expect(await owner.create()).toMatchObject({ status: 200, body: { chatId: CREATED, complete: true } });
    expect(owner.writes).toEqual([[OWNER, 'ou_qa']]);
    expect((await owner.members(CREATED)).status).toBe(200);
    expect(await owner.sendToCreated()).toMatchObject({ ok: true, chatId: CREATED });
  });

  it.each(Object.keys(CHAT_SCOPED))('keeps refusing a %s visitor after /group is opened to talkers: the grant does not reach a new group', async leg => {
    const bot = restrictedBot();
    CHAT_SCOPED[leg]!(bot);
    bot.config.canTalkDaemonCommands = ['/group'];
    const visitor = run(VISITOR);
    expect(await visitor.create()).toEqual({ status: 403, body: { ok: false, error: 'new_chat_talk_not_authorized' } });
    expect(visitor.writes).toEqual([]);
  });

  it.each(['/group', '/g'])('lets a global-grant visitor create once %s is opened to talkers, and finish the flow', async command => {
    const bot = restrictedBot();
    bot.config.globalGrants = [VISITOR];
    const refused = run(VISITOR);
    expect((await refused.create()).body).toEqual({ ok: false, error: 'chat_create_not_authorized' });
    bot.config.canTalkDaemonCommands = [command];
    const visitor = run(VISITOR);
    expect((await visitor.create()).status).toBe(200);
    expect(visitor.writes).toEqual([[VISITOR, 'ou_qa']]);
    expect((await visitor.members(CREATED)).status).toBe(200);
    expect(await visitor.sendToCreated()).toMatchObject({ ok: true, chatId: CREATED });
  });

  it('honours restrictGrantCommands for granted visitors', async () => {
    const bot = restrictedBot();
    bot.config.globalGrants = [VISITOR];
    bot.config.canTalkDaemonCommands = ['/group'];
    bot.config.restrictGrantCommands = true;
    const visitor = run(VISITOR);
    expect((await visitor.create()).body).toEqual({ ok: false, error: 'chat_create_not_authorized' });
    expect(visitor.writes).toEqual([]);
  });

  it('lets anyone create on an open bot without an allowlist', async () => {
    registerBot({ larkAppId: APP, larkAppSecret: 's', cliId: 'claude-code' }).resolvedBlockedUsers = [];
    const visitor = run(VISITOR);
    expect((await visitor.create()).status).toBe(200);
    expect(await visitor.sendToCreated()).toMatchObject({ ok: true });
  });
});
