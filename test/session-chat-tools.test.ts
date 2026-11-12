import { describe, expect, it, vi } from 'vitest';
import { handleSessionChatTool, type SessionChatContext, type SessionChatDeps } from '../src/core/session-chat-tools.js';
import { parseSessionChatArgs } from '../src/cli/session-chat.js';

function fixture() {
  const ctx: SessionChatContext = {
    sessionId: 'session-1', larkAppId: 'cli_self', chatId: 'oc_source', turnId: 'turn-1',
    callerOpenId: 'ou_caller', humanCaller: true, enabled: true, isCurrent: () => true,
  };
  const deps: SessionChatDeps = {
    route: {
      lookupMessageChatId: async () => null,
      getChatInfo: async () => ({ external: false, mode: 'group' }),
      isBotInChat: async () => true,
      listMemberOpenIds: async () => ['ou_caller', 'ou_qa'], canTalk: () => true,
    },
    resolveMembers: vi.fn(async ids => new Map(ids.map(id => [id, id.includes('@') ? 'ou_qa' : id]))),
    listMembers: vi.fn(async () => [{ openId: 'ou_qa', name: 'QA' }]),
    create: vi.fn(async () => ({ chatId: 'oc_new', invalidUserIds: [] })),
  };
  const input = parseSessionChatArgs(['create', '--name', 'Verification', '--member', 'qa@example.com']);
  if (input.action !== 'create') throw new Error('unexpected input');
  const body = { ...input, turnId: ctx.turnId };
  return { ctx, deps, body };
}

describe('session chat commands', () => {
  it('parses repeatable members and rejects unrelated or ambiguous routing flags', () => {
    expect(parseSessionChatArgs(['create', '--name=Verification', '--member', 'ou_qa', '--member=qa@example.com', '--chat-mode=topic']))
      .toEqual({ action: 'create', name: 'Verification', members: ['ou_qa', 'qa@example.com'], chatMode: 'topic' });
    expect(parseSessionChatArgs(['members', '--chat-id=oc_new'])).toEqual({ action: 'members', chatId: 'oc_new' });
    for (const argv of [
      ['create', '--name', 'x', '--bot', 'cli_other'], ['members', '--session-id', 'other'],
      ['members', '--chat-id', 'oc_a', '--chat-id', 'oc_b'], ['members', '--name', 'x'],
      ['create', '--name', 'x', '--member'], ['create', '--name', 'x', '--chat-mode', 'invalid'],
    ]) expect(() => parseSessionChatArgs(argv)).toThrow();
  });

  it('creates through the current app and includes the caller exactly once', async () => {
    const { ctx, deps, body } = fixture();
    body.members.push('ou_caller', 'qa@example.com');
    // Payload identity cannot select another app or creator.
    const result = await handleSessionChatTool({ ...body, larkAppId: 'cli_other', callerOpenId: 'ou_other' }, ctx, deps);
    expect(result).toEqual({ status: 200, body: { ok: true, larkAppId: 'cli_self', chatId: 'oc_new', complete: true, invalidUserIds: [] } });
    expect(deps.resolveMembers).toHaveBeenCalledWith(['qa@example.com', 'ou_caller']);
    expect(deps.create).toHaveBeenCalledExactlyOnceWith({ name: 'Verification', chatMode: 'group', userIds: ['ou_caller', 'ou_qa'] });
  });

  it.each(['stale', 'callerless', 'bot-caller', 'disabled', 'unauthorized', 'unresolved', 'invalid-member'])('refuses creation before a provider write: %s', async mode => {
    const { ctx, deps, body } = fixture();
    if (mode === 'stale') ctx.turnId = 'turn-2';
    if (mode === 'callerless') ctx.callerOpenId = undefined;
    if (mode === 'bot-caller') ctx.humanCaller = false;
    if (mode === 'disabled') ctx.enabled = false;
    if (mode === 'unauthorized') deps.route.canTalk = () => false;
    if (mode === 'unresolved') deps.resolveMembers = async () => new Map();
    if (mode === 'invalid-member') body.members = ['cli_other'];
    expect((await handleSessionChatTool(body, ctx, deps)).status).toBeGreaterThanOrEqual(400);
    expect(deps.create).not.toHaveBeenCalled();
  });

  it('rechecks turn and talk permission after contact resolution', async () => {
    for (const revoke of ['turn', 'permission']) {
      const { ctx, deps, body } = fixture();
      deps.resolveMembers = async () => {
        if (revoke === 'turn') ctx.isCurrent = () => false;
        else deps.route.canTalk = () => false;
        return new Map([['qa@example.com', 'ou_qa']]);
      };
      expect((await handleSessionChatTool(body, ctx, deps)).status).toBeGreaterThanOrEqual(400);
      expect(deps.create).not.toHaveBeenCalled();
    }
  });

  it('retains a committed chat and rejected invitees when the turn changes during creation', async () => {
    const { ctx, deps, body } = fixture();
    deps.create = vi.fn(async () => {
      ctx.isCurrent = () => false;
      return { chatId: 'oc_new', invalidUserIds: ['ou_qa'] };
    });
    expect((await handleSessionChatTool(body, ctx, deps)).body).toMatchObject({ ok: true, chatId: 'oc_new', complete: false, invalidUserIds: ['ou_qa'] });
    expect(deps.create).toHaveBeenCalledTimes(1);
  });

  it('returns app-scoped QA identities only for an authorized chat', async () => {
    const { ctx, deps } = fixture();
    const body = { action: 'members', turnId: ctx.turnId, chatId: 'oc_new' };
    expect((await handleSessionChatTool(body, ctx, deps)).body).toMatchObject({ larkAppId: 'cli_self', chatId: 'oc_new', members: [{ openId: 'ou_qa', name: 'QA' }] });
    expect(deps.listMembers).toHaveBeenCalledWith('oc_new');
  });

  it.each(['external', 'not-member', 'caller-not-member', 'lookup-error', 'stale'])('does not disclose the target member list: %s', async mode => {
    const { ctx, deps } = fixture();
    if (mode === 'external') deps.route.getChatInfo = async () => ({ external: true, mode: 'group' });
    if (mode === 'not-member') deps.route.isBotInChat = async () => false;
    if (mode === 'caller-not-member') deps.route.listMemberOpenIds = async () => ['ou_qa'];
    if (mode === 'lookup-error') deps.route.getChatInfo = async () => { throw new Error('unavailable'); };
    if (mode === 'stale') deps.route.getChatInfo = async () => {
      ctx.isCurrent = () => false;
      return { external: false, mode: 'group' };
    };
    const result = await handleSessionChatTool({ action: 'members', turnId: ctx.turnId, chatId: 'oc_new' }, ctx, deps);
    expect(result.status).toBeGreaterThanOrEqual(400);
    expect(deps.listMembers).not.toHaveBeenCalled();
    expect(result.body).not.toHaveProperty('members');
  });
});
