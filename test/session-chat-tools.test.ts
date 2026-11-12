import { describe, expect, it, vi } from 'vitest';
import { buildSessionChatContext, handleSessionChatTool, type SessionChatContext, type SessionChatDeps, type SessionChatSessionView } from '../src/core/session-chat-tools.js';
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
    canCreateChat: () => true,
    canTalkInNewChat: () => true,
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
    for (const revoke of ['turn', 'permission', 'group-command', 'new-chat-talk']) {
      const { ctx, deps, body } = fixture();
      deps.resolveMembers = async () => {
        if (revoke === 'turn') ctx.isCurrent = () => false;
        else if (revoke === 'permission') deps.route.canTalk = () => false;
        else if (revoke === 'group-command') deps.canCreateChat = () => false;
        else deps.canTalkInNewChat = () => false;
        return new Map([['qa@example.com', 'ou_qa']]);
      };
      expect((await handleSessionChatTool(body, ctx, deps)).status).toBeGreaterThanOrEqual(400);
      expect(deps.create).not.toHaveBeenCalled();
    }
  });

  it.each([
    ['group-command', 'chat_create_not_authorized'],
    ['new-chat-talk', 'new_chat_talk_not_authorized'],
  ])('refuses creation without %s authority before any contact lookup', async (missing, error) => {
    const { ctx, deps, body } = fixture();
    if (missing === 'group-command') deps.canCreateChat = vi.fn(() => false);
    else deps.canTalkInNewChat = vi.fn(() => false);
    expect(await handleSessionChatTool(body, ctx, deps)).toEqual({ status: 403, body: { ok: false, error } });
    expect(missing === 'group-command' ? deps.canCreateChat : deps.canTalkInNewChat).toHaveBeenCalledWith('ou_caller');
    expect(deps.resolveMembers).not.toHaveBeenCalled();
    expect(deps.create).not.toHaveBeenCalled();
  });

  it('does not require creation authority to list members', async () => {
    const { ctx, deps } = fixture();
    deps.canCreateChat = () => false;
    deps.canTalkInNewChat = () => false;
    expect((await handleSessionChatTool({ action: 'members', turnId: ctx.turnId }, ctx, deps)).status).toBe(200);
  });

  it('invites at most 49 people besides the caller', async () => {
    const forty9 = Array.from({ length: 49 }, (_, i) => `ou_member${i}`);
    const ok = fixture();
    expect((await handleSessionChatTool({ ...ok.body, members: forty9 }, ok.ctx, ok.deps)).status).toBe(200);
    expect(vi.mocked(ok.deps.create).mock.calls[0]![0].userIds).toHaveLength(50);
    const over = fixture();
    expect((await handleSessionChatTool({ ...over.body, members: [...forty9, 'ou_member49'] }, over.ctx, over.deps)).body)
      .toEqual({ ok: false, error: 'invalid_chat_create' });
    expect(over.deps.resolveMembers).not.toHaveBeenCalled();
  });

  it.each(['cli_other', 'on_union_member', '+15550100', 'Display Name'])(
    'rejects member identifier %s before any contact lookup', async member => {
      const { ctx, deps, body } = fixture();
      const result = await handleSessionChatTool({ ...body, members: [member] }, ctx, deps);
      expect(result.status).toBe(400);
      expect(deps.resolveMembers).not.toHaveBeenCalled();
    });

  it('audits principal, created chat and invite counts, and marks an unknown creation outcome', async () => {
    const lines: string[] = [];
    const { ctx, deps, body } = fixture();
    deps.audit = line => { lines.push(line); };
    deps.create = vi.fn(async () => ({ chatId: 'oc_new', invalidUserIds: ['ou_qa'] }));
    await handleSessionChatTool(body, ctx, deps);
    expect(lines).toEqual(['session=session-1 turn=turn-1 action=create principal=ou_caller target=oc_new invited=2 invalid=1 status=200']);
    deps.create = vi.fn(async () => { throw new Error('socket hang up'); });
    await expect(handleSessionChatTool(body, ctx, deps)).rejects.toThrow('socket hang up');
    expect(lines[1]).toBe('session=session-1 turn=turn-1 action=create principal=ou_caller target=create-attempted invited=2 invalid=- status=502 error=socket hang up');
    deps.canCreateChat = () => false;
    await handleSessionChatTool(body, ctx, deps);
    expect(lines[2]).toBe('session=session-1 turn=turn-1 action=create principal=ou_caller target=- invited=- invalid=- status=403 error=chat_create_not_authorized');
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

describe('session chat context from daemon state', () => {
  function view(over: Partial<SessionChatSessionView> = {}, flags: Partial<ReturnType<SessionChatSessionView['availability']>> = {}) {
    let live: string | undefined = 'turn-1';
    const state = { vcMeetingReceiver: false, silentListener: false, larkTransport: true, ...flags };
    const v: SessionChatSessionView = {
      sessionId: 'session-1', larkAppId: 'cli_self', chatId: 'oc_source', turnId: 'turn-1',
      caller: { senderType: 'user', requestLarkAppId: 'cli_self', requestUserOpenId: 'ou_caller' },
      liveTurnId: () => live, availability: () => state, ...over,
    };
    return { v, state, rotate: (next?: string) => { live = next; } };
  }

  it('belongs only to this daemon app', () => {
    expect(buildSessionChatContext(view().v, 'cli_other')).toBeUndefined();
    expect(buildSessionChatContext(view().v, undefined)).toBeUndefined();
    expect(buildSessionChatContext(undefined, 'cli_self')).toBeUndefined();
    expect(buildSessionChatContext(view().v, 'cli_self')).toMatchObject({
      sessionId: 'session-1', larkAppId: 'cli_self', chatId: 'oc_source', turnId: 'turn-1', callerOpenId: 'ou_caller', humanCaller: true, enabled: true,
    });
  });

  it.each([
    ['scheduled run-as creator', { senderType: 'user', source: 'schedule_creator', requestLarkAppId: 'cli_self', requestUserOpenId: 'ou_caller' }],
    ['failed-turn recovery', { senderType: 'user', source: 'failed_turn_recovery', requestLarkAppId: 'cli_self', requestUserOpenId: 'ou_caller' }],
    ['bot sender', { senderType: 'bot', requestLarkAppId: 'cli_self', requestUserOpenId: 'ou_peer_bot' }],
    ['unknown sender type', { requestLarkAppId: 'cli_self', requestUserOpenId: 'ou_caller' }],
    ['another app', { senderType: 'user', requestLarkAppId: 'cli_other', requestUserOpenId: 'ou_caller' }],
    ['no caller record', undefined],
  ] as const)('is not a human caller for %s', (_label, caller) => {
    expect(buildSessionChatContext(view({ caller: caller as SessionChatSessionView['caller'] }).v, 'cli_self')!.humanCaller).toBe(false);
  });

  it.each([
    { vcMeetingReceiver: true }, { silentListener: true }, { larkTransport: false },
  ])('is disabled for %o', flags => {
    expect(buildSessionChatContext(view({}, flags).v, 'cli_self')!.enabled).toBe(false);
  });

  it('stays current only for the same live turn while the session can still talk', () => {
    const { v, state, rotate } = view();
    const ctx = buildSessionChatContext(v, 'cli_self')!;
    expect(ctx.isCurrent()).toBe(true);
    state.silentListener = true;
    expect(ctx.isCurrent()).toBe(false);
    state.silentListener = false;
    rotate('turn-2');
    expect(ctx.isCurrent()).toBe(false);
    rotate(undefined);
    expect(ctx.isCurrent()).toBe(false);
    expect(buildSessionChatContext(view({ turnId: undefined }).v, 'cli_self')!.isCurrent()).toBe(false);
  });
});
