import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyExactChatGrant,
  applyExactChatGrantByLarkAppIds,
  MAX_EXACT_CHAT_GRANT_SUBJECTS,
  type ExactChatGrantDeps,
} from '../src/services/exact-chat-grant.js';
import {
  ChatMemberListTooLargeError,
  CURRENT_CHAT_USER_MEMBER_PAGE_CAP,
  scanChatMemberPages,
} from '../src/im/lark/client.js';

const PEOPLE_IN_CHAT = ['ou_person_in_chat', 'ou_owner'];

function makeDeps() {
  const grants = new Set<string>();
  const deps: ExactChatGrantDeps = {
    getOwnerOpenId: vi.fn(() => 'ou_owner'),
    getReceiverBotOpenId: vi.fn(() => 'ou_receiver'),
    listCurrentChatBotMembers: vi.fn(async () => [
      { openId: 'ou_receiver', displayName: 'Receiver' },
      { openId: 'ou_peer_a', displayName: 'Peer A' },
      { openId: 'ou_peer_b', displayName: 'Peer B' },
    ]),
    // Feishu's /members never lists bots; it is the people side of membership.
    findCurrentChatUserMembers: vi.fn(async (_appId: string, _chatId: string, openIds: string[]) =>
      openIds.filter(openId => PEOPLE_IN_CHAT.includes(openId))),
    resolveCurrentChatBotOpenIdsByLarkAppIds: vi.fn(async (_receiver, _chatId, subjectLarkAppIds) => ({
      ok: true as const,
      mappings: subjectLarkAppIds.map(larkAppId => ({
        larkAppId,
        subjectOpenId: larkAppId === 'cli_pm' ? 'ou_peer_a' : 'ou_peer_b',
      })),
    })),
    addChatGrant: vi.fn(async (_appId, _chatId, openId) => {
      const created = !grants.has(openId);
      grants.add(openId);
      return { ok: true as const, created };
    }),
    removeChatGrant: vi.fn(async (_appId, _chatId, openId) => {
      const removed = grants.delete(openId);
      return { ok: true as const, removed };
    }),
    listGrantedOpenIds: vi.fn(() => [...grants]),
  };
  return { deps, grants };
}

const base = {
  receiverLarkAppId: 'cli_receiver',
  chatId: 'oc_chat',
  subjectOpenIds: ['ou_peer_a'],
};

describe('exact chat grant service', () => {
  let fixture: ReturnType<typeof makeDeps>;

  beforeEach(() => {
    fixture = makeDeps();
  });

  it('validates the full batch before any grant mutation and fails closed on non-current bots', async () => {
    const result = await applyExactChatGrant({
      ...base,
      operation: 'grant',
      subjectOpenIds: ['ou_peer_a', 'ou_stale_observed'],
    }, fixture.deps);

    expect(result).toMatchObject({
      ok: false,
      status: 409,
      error: 'subject_not_current_chat_member',
      invalidSubjectOpenIds: ['ou_stale_observed'],
    });
    expect(fixture.deps.addChatGrant).not.toHaveBeenCalled();
  });

  it('fails closed when the live /members/bots lookup is unavailable', async () => {
    vi.mocked(fixture.deps.listCurrentChatBotMembers).mockRejectedValue(new Error('live API down'));
    const result = await applyExactChatGrant({ ...base, operation: 'grant' }, fixture.deps);

    expect(result).toMatchObject({ ok: false, status: 502, error: 'live_membership_unavailable' });
    expect(fixture.deps.addChatGrant).not.toHaveBeenCalled();
  });

  it('deduplicates repeated subjects and returns explicit talk-only grant effect', async () => {
    const result = await applyExactChatGrant({
      ...base,
      operation: 'grant',
      subjectOpenIds: ['ou_peer_a', 'ou_peer_a', 'ou_peer_b'],
    }, fixture.deps);

    expect(result).toEqual({
      ok: true,
      operation: 'grant',
      permissionSource: 'chatGrant',
      talkOnly: true,
      receiverLarkAppId: 'cli_receiver',
      chatId: 'oc_chat',
      grantsTalk: true,
      grantsOperate: false,
      subjects: [
        { subjectOpenId: 'ou_peer_a', chatGrantActive: true, changed: true, grantsTalk: true, grantsOperate: false },
        { subjectOpenId: 'ou_peer_b', chatGrantActive: true, changed: true, grantsTalk: true, grantsOperate: false },
      ],
    });
    expect(fixture.deps.addChatGrant).toHaveBeenCalledTimes(2);

    const again = await applyExactChatGrant({ ...base, operation: 'grant' }, fixture.deps);
    expect(again).toMatchObject({
      ok: true,
      subjects: [{ subjectOpenId: 'ou_peer_a', changed: false, chatGrantActive: true }],
    });
  });

  it('requires an owner and a known receiver open_id only for grant', async () => {
    vi.mocked(fixture.deps.getOwnerOpenId).mockReturnValue(undefined);
    expect(await applyExactChatGrant({ ...base, operation: 'grant' }, fixture.deps))
      .toMatchObject({ ok: false, error: 'receiver_owner_missing' });

    fixture.grants.add('ou_peer_a');
    vi.mocked(fixture.deps.getReceiverBotOpenId).mockReturnValue(undefined);
    const revoked = await applyExactChatGrant({ ...base, operation: 'revoke' }, fixture.deps);
    expect(revoked).toMatchObject({
      ok: true,
      operation: 'revoke',
      subjects: [{ subjectOpenId: 'ou_peer_a', chatGrantActive: false, changed: true }],
    });
    expect(fixture.deps.listCurrentChatBotMembers).not.toHaveBeenCalled();
  });

  it('rejects self-grant but permits readback/revoke of a historical self grant', async () => {
    const grantSelf = await applyExactChatGrant({
      ...base,
      operation: 'grant',
      subjectOpenIds: ['ou_receiver'],
    }, fixture.deps);
    expect(grantSelf).toMatchObject({ ok: false, error: 'receiver_cannot_be_subject' });

    fixture.grants.add('ou_receiver');
    const readback = await applyExactChatGrant({
      ...base,
      operation: 'readback',
      subjectOpenIds: ['ou_receiver'],
    }, fixture.deps);
    expect(readback).toMatchObject({
      ok: true,
      subjects: [{ subjectOpenId: 'ou_receiver', chatGrantActive: true }],
    });

    const revoke = await applyExactChatGrant({
      ...base,
      operation: 'revoke',
      subjectOpenIds: ['ou_receiver'],
    }, fixture.deps);
    expect(revoke).toMatchObject({
      ok: true,
      subjects: [{ subjectOpenId: 'ou_receiver', chatGrantActive: false }],
    });
  });

  it('readback requires explicit subjects and never enumerates the grant table', async () => {
    fixture.grants.add('ou_peer_a');
    fixture.grants.add('ou_secret_unrequested');

    const empty = await applyExactChatGrant({
      ...base,
      operation: 'readback',
      subjectOpenIds: [],
    }, fixture.deps);
    expect(empty).toMatchObject({ ok: false, error: 'subject_open_ids_required' });

    const result = await applyExactChatGrant({ ...base, operation: 'readback' }, fixture.deps);
    expect(result).toMatchObject({
      ok: true,
      subjects: [{ subjectOpenId: 'ou_peer_a', chatGrantActive: true, changed: false }],
    });
    expect(JSON.stringify(result)).not.toContain('ou_secret_unrequested');
  });

  it('enforces format and batch-size limits before side effects', async () => {
    expect(await applyExactChatGrant({ ...base, operation: 'grant', chatId: '../bad' }, fixture.deps))
      .toMatchObject({ ok: false, error: 'invalid_chat_id' });
    expect(await applyExactChatGrant({ ...base, operation: 'grant', subjectOpenIds: ['not-an-open-id'] }, fixture.deps))
      .toMatchObject({ ok: false, error: 'invalid_subject_open_id' });

    const tooMany = Array.from({ length: MAX_EXACT_CHAT_GRANT_SUBJECTS + 1 }, (_, i) => `ou_peer_${i}`);
    expect(await applyExactChatGrant({ ...base, operation: 'grant', subjectOpenIds: tooMany }, fixture.deps))
      .toMatchObject({ ok: false, error: 'too_many_subject_open_ids' });
    expect(fixture.deps.listCurrentChatBotMembers).not.toHaveBeenCalled();
    expect(fixture.deps.addChatGrant).not.toHaveBeenCalled();
  });

  it('returns a non-success result with partial progress if persistence fails mid-batch', async () => {
    vi.mocked(fixture.deps.addChatGrant)
      .mockResolvedValueOnce({ ok: true, created: true })
      .mockResolvedValueOnce({ ok: false, reason: 'disk_full' });

    const result = await applyExactChatGrant({
      ...base,
      operation: 'grant',
      subjectOpenIds: ['ou_peer_a', 'ou_peer_b'],
    }, fixture.deps);
    expect(result).toMatchObject({
      ok: false,
      status: 500,
      error: 'grant_write_failed',
      partial: [{ subjectOpenId: 'ou_peer_a', chatGrantActive: true }],
    });
  });

  it('resolves stable app ids to receiver-scoped open_ids and delegates to the exact talk-only grant', async () => {
    vi.mocked(fixture.deps.resolveCurrentChatBotOpenIdsByLarkAppIds).mockResolvedValue({
      ok: true,
      mappings: [{ larkAppId: 'cli_pm', subjectOpenId: 'ou_peer_a' }],
    });

    const result = await applyExactChatGrantByLarkAppIds({
      operation: 'grant',
      receiverLarkAppId: 'cli_receiver',
      chatId: 'oc_chat',
      subjectLarkAppIds: ['cli_pm'],
    }, fixture.deps);

    expect(fixture.deps.resolveCurrentChatBotOpenIdsByLarkAppIds).toHaveBeenCalledWith(
      'cli_receiver',
      'oc_chat',
      ['cli_pm'],
    );
    expect(fixture.deps.listCurrentChatBotMembers).toHaveBeenCalledWith('cli_receiver', 'oc_chat');
    expect(fixture.deps.addChatGrant).toHaveBeenCalledWith(
      'cli_receiver',
      'oc_chat',
      'ou_peer_a',
      undefined,
      undefined,
    );
    expect(fixture.deps.addChatGrant).not.toHaveBeenCalledWith(
      'cli_receiver',
      'oc_chat',
      'ou_pm_seen_by_pm',
    );
    expect(result).toMatchObject({
      ok: true,
      talkOnly: true,
      grantsOperate: false,
      subjectMappings: [{ larkAppId: 'cli_pm', subjectOpenId: 'ou_peer_a' }],
      subjects: [{ subjectOpenId: 'ou_peer_a', chatGrantActive: true }],
    });
  });

  it('fails closed on missing, ambiguous, or unavailable stable identity resolution', async () => {
    const failures = [
      {
        ok: false as const,
        error: 'subject_lark_app_not_in_chat' as const,
        message: 'not in chat',
        invalidSubjectLarkAppIds: ['cli_pm'],
        expectedStatus: 409,
      },
      {
        ok: false as const,
        error: 'subject_lark_app_ambiguous' as const,
        message: 'ambiguous',
        invalidSubjectLarkAppIds: ['cli_pm'],
        expectedStatus: 409,
      },
      {
        ok: false as const,
        error: 'live_membership_unavailable' as const,
        message: 'api down',
        invalidSubjectLarkAppIds: ['cli_pm'],
        expectedStatus: 502,
      },
    ];

    for (const { expectedStatus, ...resolution } of failures) {
      vi.mocked(fixture.deps.resolveCurrentChatBotOpenIdsByLarkAppIds).mockResolvedValueOnce(resolution);
      const result = await applyExactChatGrantByLarkAppIds({
        operation: 'grant',
        receiverLarkAppId: 'cli_receiver',
        chatId: 'oc_chat',
        subjectLarkAppIds: ['cli_pm'],
      }, fixture.deps);
      expect(result).toMatchObject({
        ok: false,
        status: expectedStatus,
        error: resolution.error,
        invalidSubjectLarkAppIds: ['cli_pm'],
      });
    }
    expect(fixture.deps.addChatGrant).not.toHaveBeenCalled();
  });

  it('resolve by stable app id: returns the open_id the receiver sees, writes nothing; revoke by app id stays refused', async () => {
    const result = await applyExactChatGrantByLarkAppIds({
      operation: 'resolve',
      receiverLarkAppId: 'cli_receiver',
      chatId: 'oc_chat',
      subjectLarkAppIds: ['cli_pm'],
    }, fixture.deps);
    expect(fixture.deps.resolveCurrentChatBotOpenIdsByLarkAppIds).toHaveBeenCalledWith('cli_receiver', 'oc_chat', ['cli_pm']);
    expect(result).toMatchObject({ ok: true, operation: 'resolve', grantsTalk: false, subjects: [], subjectMappings: [{ larkAppId: 'cli_pm', subjectOpenId: 'ou_peer_a' }] });
    expect(fixture.deps.addChatGrant).not.toHaveBeenCalled();
    expect(fixture.deps.removeChatGrant).not.toHaveBeenCalled();
    expect(await applyExactChatGrantByLarkAppIds({
      operation: 'revoke', receiverLarkAppId: 'cli_receiver', chatId: 'oc_chat', subjectLarkAppIds: ['cli_pm'],
    }, fixture.deps)).toMatchObject({ ok: false, error: 'subject_lark_app_ids_grant_only' });
  });

  it('allows stable app ids only for grants and validates them before resolution', async () => {
    expect(await applyExactChatGrantByLarkAppIds({
      operation: 'readback',
      receiverLarkAppId: 'cli_receiver',
      chatId: 'oc_chat',
      subjectLarkAppIds: ['cli_pm'],
    }, fixture.deps)).toMatchObject({ ok: false, error: 'subject_lark_app_ids_grant_only' });

    expect(await applyExactChatGrantByLarkAppIds({
      operation: 'grant',
      receiverLarkAppId: 'cli_receiver',
      chatId: 'oc_chat',
      subjectLarkAppIds: ['not-an-app-id'],
    }, fixture.deps)).toMatchObject({
      ok: false,
      error: 'invalid_subject_lark_app_id',
      invalidSubjectLarkAppIds: ['not-an-app-id'],
    });

    const tooMany = Array.from({ length: MAX_EXACT_CHAT_GRANT_SUBJECTS + 1 }, (_, i) => `cli_peer_${i}`);
    expect(await applyExactChatGrantByLarkAppIds({
      operation: 'grant',
      receiverLarkAppId: 'cli_receiver',
      chatId: 'oc_chat',
      subjectLarkAppIds: tooMany,
    }, fixture.deps)).toMatchObject({ ok: false, error: 'too_many_subject_lark_app_ids' });
    expect(fixture.deps.resolveCurrentChatBotOpenIdsByLarkAppIds).not.toHaveBeenCalled();
  });
});

// Dashboard 群管理「成员权限」可以勾选真人：真人不在 /members/bots 里，必须按
// 群成员名单校验；不在群的人（真人或机器人）仍然一律不能被授权。
describe('exact chat grant membership: people and bots', () => {
  let fixture: ReturnType<typeof makeDeps>;

  beforeEach(() => {
    fixture = makeDeps();
  });

  it('grants a person who is in the chat per the live member list', async () => {
    const result = await applyExactChatGrant({
      ...base,
      operation: 'grant',
      subjectOpenIds: ['ou_person_in_chat', 'ou_peer_a'],
      quota: 3,
    }, fixture.deps);

    expect(result).toMatchObject({
      ok: true,
      operation: 'grant',
      talkOnly: true,
      grantsOperate: false,
      subjects: [
        { subjectOpenId: 'ou_person_in_chat', chatGrantActive: true, changed: true, grantsOperate: false },
        { subjectOpenId: 'ou_peer_a', chatGrantActive: true, changed: true, grantsOperate: false },
      ],
    });
    // Only the subjects the bot list did not confirm are looked up among people.
    expect(fixture.deps.findCurrentChatUserMembers).toHaveBeenCalledWith('cli_receiver', 'oc_chat', ['ou_person_in_chat']);
    expect(fixture.deps.addChatGrant).toHaveBeenCalledWith('cli_receiver', 'oc_chat', 'ou_person_in_chat', 3, undefined);
    expect([...fixture.grants]).toEqual(['ou_person_in_chat', 'ou_peer_a']);
  });

  it('rejects the whole batch when a person is not in the chat, naming only that person', async () => {
    const result = await applyExactChatGrant({
      ...base,
      operation: 'grant',
      subjectOpenIds: ['ou_person_in_chat', 'ou_person_left', 'ou_peer_a'],
    }, fixture.deps);

    expect(result).toMatchObject({
      ok: false,
      status: 409,
      error: 'subject_not_current_chat_member',
      invalidSubjectOpenIds: ['ou_person_left'],
    });
    expect(fixture.deps.addChatGrant).not.toHaveBeenCalled();
    expect(fixture.grants.size).toBe(0);
  });

  it('rejects the receiver bot itself before any membership lookup or write', async () => {
    const result = await applyExactChatGrant({
      ...base,
      operation: 'grant',
      subjectOpenIds: ['ou_person_in_chat', 'ou_receiver'],
    }, fixture.deps);

    expect(result).toMatchObject({
      ok: false,
      status: 400,
      error: 'receiver_cannot_be_subject',
      invalidSubjectOpenIds: ['ou_receiver'],
    });
    expect(fixture.deps.listCurrentChatBotMembers).not.toHaveBeenCalled();
    expect(fixture.deps.findCurrentChatUserMembers).not.toHaveBeenCalled();
    expect(fixture.deps.addChatGrant).not.toHaveBeenCalled();
  });

  it('keeps a bot-only batch independent of the human member list', async () => {
    vi.mocked(fixture.deps.findCurrentChatUserMembers).mockRejectedValue(new Error('no member scope'));
    const result = await applyExactChatGrant({
      ...base,
      operation: 'grant',
      subjectOpenIds: ['ou_peer_a', 'ou_peer_b'],
    }, fixture.deps);

    expect(result.ok).toBe(true);
    expect(fixture.deps.findCurrentChatUserMembers).not.toHaveBeenCalled();
  });

  it('fails closed when the member list is unavailable for a subject the bot list does not cover', async () => {
    vi.mocked(fixture.deps.findCurrentChatUserMembers).mockRejectedValue(new Error('member list truncated'));
    const result = await applyExactChatGrant({
      ...base,
      operation: 'grant',
      subjectOpenIds: ['ou_person_in_chat'],
    }, fixture.deps);

    expect(result).toMatchObject({ ok: false, status: 502, error: 'live_membership_unavailable', message: 'member list truncated' });
    expect(fixture.deps.addChatGrant).not.toHaveBeenCalled();
  });

  it('reports a member list too long to read to the end as its own error, not as "left" or "retry later"', async () => {
    vi.mocked(fixture.deps.findCurrentChatUserMembers).mockRejectedValue(new ChatMemberListTooLargeError('oc_chat'));
    const result = await applyExactChatGrant({
      ...base,
      operation: 'grant',
      subjectOpenIds: ['ou_person_in_chat'],
    }, fixture.deps);

    expect(result).toMatchObject({ ok: false, status: 422, error: 'live_membership_too_large' });
    expect(fixture.deps.addChatGrant).not.toHaveBeenCalled();
  });

  it('blames the failed bot lookup, not the chat size, when bots had to be looked for among people', async () => {
    vi.mocked(fixture.deps.listCurrentChatBotMembers).mockRejectedValue(new Error('members/bots down'));
    vi.mocked(fixture.deps.findCurrentChatUserMembers).mockRejectedValue(new ChatMemberListTooLargeError('oc_chat'));
    const result = await applyExactChatGrant({
      ...base,
      operation: 'grant',
      subjectOpenIds: ['ou_peer_a'],
    }, fixture.deps);

    expect(result).toMatchObject({ ok: false, status: 502, error: 'live_membership_unavailable', message: 'members/bots down' });
    expect(fixture.deps.addChatGrant).not.toHaveBeenCalled();
  });

  it('keeps the stable app-id (bot-to-bot) path on the bot list only, with its original answers', async () => {
    const byAppId = (input?: Partial<Parameters<typeof applyExactChatGrantByLarkAppIds>[0]>) => applyExactChatGrantByLarkAppIds({
      operation: 'grant',
      receiverLarkAppId: 'cli_receiver',
      chatId: 'oc_chat',
      subjectLarkAppIds: ['cli_pm'],
      ...input,
    }, fixture.deps);
    // Resolution saw the bot, but the second live bot read no longer lists it.
    vi.mocked(fixture.deps.resolveCurrentChatBotOpenIdsByLarkAppIds).mockResolvedValue({
      ok: true,
      mappings: [{ larkAppId: 'cli_pm', subjectOpenId: 'ou_peer_gone' }],
    });
    expect(await byAppId()).toMatchObject({
      ok: false,
      status: 409,
      error: 'subject_not_current_chat_bot',
      invalidSubjectOpenIds: ['ou_peer_gone'],
    });

    vi.mocked(fixture.deps.listCurrentChatBotMembers).mockRejectedValue(new Error('members/bots down'));
    expect(await byAppId()).toMatchObject({ ok: false, status: 502, error: 'live_membership_unavailable', message: 'members/bots down' });

    expect(fixture.deps.findCurrentChatUserMembers).not.toHaveBeenCalled();
    expect(fixture.deps.addChatGrant).not.toHaveBeenCalled();
  });

  it('when only the bot list is down: people confirmed by the member list pass, anyone else is unknown, not "left"', async () => {
    vi.mocked(fixture.deps.listCurrentChatBotMembers).mockRejectedValue(new Error('members/bots down'));

    const people = await applyExactChatGrant({
      ...base,
      operation: 'grant',
      subjectOpenIds: ['ou_person_in_chat'],
    }, fixture.deps);
    expect(people).toMatchObject({ ok: true, subjects: [{ subjectOpenId: 'ou_person_in_chat', chatGrantActive: true }] });

    vi.mocked(fixture.deps.addChatGrant).mockClear();
    const withBot = await applyExactChatGrant({
      ...base,
      operation: 'grant',
      subjectOpenIds: ['ou_person_in_chat', 'ou_peer_a'],
    }, fixture.deps);
    expect(withBot).toMatchObject({ ok: false, status: 502, error: 'live_membership_unavailable', message: 'members/bots down' });
    expect(fixture.deps.addChatGrant).not.toHaveBeenCalled();
  });
});

// 授权级的真人成员查询：找齐即停；只有把名单读到底才能判定「不在群」，
// 任何会让名单看起来比实际短的情况都必须抛错，而不是答「不在群」。
describe('chat member page scan for grants', () => {
  type Page = { code?: number; msg?: string; data?: any };
  function pages(...list: Page[]) {
    const tokens: Array<string | undefined> = [];
    const fetchPage = vi.fn(async (pageToken: string | undefined) => {
      tokens.push(pageToken);
      const page = list[tokens.length - 1];
      if (!page) throw new Error('read past the last page');
      return page;
    });
    return { fetchPage, tokens };
  }
  const row = (id: unknown) => ({ member_id: id, member_id_type: 'open_id', name: String(id) });

  it('stops paging once every wanted person is found', async () => {
    const src = pages(
      { code: 0, data: { items: [row('ou_a'), row('ou_x')], has_more: true, page_token: 'p2' } },
      { code: 0, data: { items: [row('ou_b')], has_more: true, page_token: 'p3' } },
    );
    await expect(scanChatMemberPages('oc_chat', ['ou_a', 'ou_b'], src.fetchPage)).resolves.toEqual(new Set(['ou_a', 'ou_b']));
    expect(src.tokens).toEqual([undefined, 'p2']);
  });

  it('rules someone out only after reading the list to the end', async () => {
    const src = pages(
      { code: 0, data: { items: [row('ou_a')], has_more: true, page_token: 'p2' } },
      { code: 0, data: { items: [row('ou_c'), row(42), row(''), {}], has_more: false } },
    );
    await expect(scanChatMemberPages('oc_chat', ['ou_a', 'ou_gone'], src.fetchPage)).resolves.toEqual(new Set(['ou_a']));
    expect(src.tokens).toEqual([undefined, 'p2']);
  });

  it('throws instead of answering from a list that may be cut short', async () => {
    const scan = (...list: Page[]) => scanChatMemberPages('oc_chat', ['ou_gone'], pages(...list).fetchPage);
    await expect(scan({ code: 99991672, msg: 'Access denied' })).rejects.toThrow('Access denied');
    await expect(scan({ msg: 'no code', data: { items: [row('ou_a')], has_more: false } })).rejects.toThrow('no code');
    await expect(scan({ code: 0 })).rejects.toThrow('no items array');
    await expect(scan({ code: 0, data: { items: null, has_more: false } })).rejects.toThrow('no items array');
    await expect(scan({ code: 0, data: { items: [row('ou_a')], has_more: true } })).rejects.toThrow('no page_token');
    for (const hasMore of ['true', 1, undefined, null]) {
      await expect(scan({ code: 0, data: { items: [row('ou_a')], has_more: hasMore, page_token: 'p2' } }))
        .rejects.toThrow('no boolean has_more');
    }
  });

  it('treats a page_token that comes back again as a broken list, not as a long one', async () => {
    const src = pages(
      { code: 0, data: { items: [row('ou_a')], has_more: true, page_token: 'same' } },
      { code: 0, data: { items: [row('ou_b')], has_more: true, page_token: 'same' } },
    );
    const err = await scanChatMemberPages('oc_chat', ['ou_gone'], src.fetchPage).catch(e => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(ChatMemberListTooLargeError);
    expect(String(err.message)).toContain('repeats an earlier page_token');
    expect(src.tokens).toEqual([undefined, 'same']);
  });

  it('gives up with ChatMemberListTooLargeError at the page cap while someone is unconfirmed', async () => {
    let n = 0;
    const fetchPage = vi.fn(async () => ({ code: 0, data: { items: [row(`ou_${n}`)], has_more: true, page_token: `p${++n}` } }));
    await expect(scanChatMemberPages('oc_chat', ['ou_gone'], fetchPage)).rejects.toBeInstanceOf(ChatMemberListTooLargeError);
    expect(fetchPage).toHaveBeenCalledTimes(CURRENT_CHAT_USER_MEMBER_PAGE_CAP);
  });

  it('reads nothing when nobody is asked about', async () => {
    const fetchPage = vi.fn();
    await expect(scanChatMemberPages('oc_chat', [], fetchPage)).resolves.toEqual(new Set());
    expect(fetchPage).not.toHaveBeenCalled();
  });
});

describe('exact chat grant quota/duration forwarding', () => {
  let fixture: ReturnType<typeof makeDeps>;

  beforeEach(() => {
    fixture = makeDeps();
  });

  it('forwards quota and converts relative durationMs to an absolute expiresAt (shared anchor)', async () => {
    const durationMs = 60_000;
    const before = Date.now();
    const result = await applyExactChatGrant({
      ...base,
      operation: 'grant',
      subjectOpenIds: ['ou_peer_a', 'ou_peer_b'],
      quota: 7,
      durationMs,
    }, fixture.deps);
    const after = Date.now();

    expect(result.ok).toBe(true);
    const add = vi.mocked(fixture.deps.addChatGrant);
    expect(add).toHaveBeenCalledTimes(2);
    const firstExpires = add.mock.calls[0]?.[4] as number;
    for (const call of add.mock.calls) {
      expect(call[0]).toBe('cli_receiver');
      expect(call[1]).toBe('oc_chat');
      expect(call[3]).toBe(7);
      // One anchor for the whole batch: both subjects see the same expiresAt.
      expect(call[4]).toBe(firstExpires);
      expect(call[4]).toBeGreaterThanOrEqual(before + durationMs - 2_000);
      expect(call[4]).toBeLessThanOrEqual(after + durationMs + 2_000);
    }
  });

  it('omits both extras when quota/durationMs are absent (CLI byte-identical shape)', async () => {
    const result = await applyExactChatGrant({ ...base, operation: 'grant' }, fixture.deps);
    expect(result.ok).toBe(true);
    const add = vi.mocked(fixture.deps.addChatGrant);
    expect(add).toHaveBeenCalledTimes(1);
    expect(add.mock.calls[0]?.[3]).toBeUndefined();
    expect(add.mock.calls[0]?.[4]).toBeUndefined();
  });

  it('treats non-finite/non-positive quota or duration as unlimited rather than throwing', async () => {
    const result = await applyExactChatGrant({
      ...base,
      operation: 'grant',
      quota: '5',
      durationMs: 0,
    }, fixture.deps);
    expect(result.ok).toBe(true);
    const add = vi.mocked(fixture.deps.addChatGrant);
    expect(add.mock.calls[0]?.[3]).toBeUndefined();
    expect(add.mock.calls[0]?.[4]).toBeUndefined();

    vi.clearAllMocks();
    const negative = await applyExactChatGrant({
      ...base,
      operation: 'grant',
      quota: -3,
      durationMs: Number.NaN,
    }, fixture.deps);
    expect(negative.ok).toBe(true);
    expect(vi.mocked(fixture.deps.addChatGrant).mock.calls[0]?.slice(3)).toEqual([undefined, undefined]);
  });

  it('floors a fractional quota', async () => {
    const result = await applyExactChatGrant({
      ...base,
      operation: 'grant',
      quota: 7.9,
    }, fixture.deps);
    expect(result.ok).toBe(true);
    expect(vi.mocked(fixture.deps.addChatGrant).mock.calls[0]?.[3]).toBe(7);
  });

  it('forwards quota/durationMs through the stable app-id entry point', async () => {
    const durationMs = 30_000;
    const before = Date.now();
    const result = await applyExactChatGrantByLarkAppIds({
      operation: 'grant',
      receiverLarkAppId: 'cli_receiver',
      chatId: 'oc_chat',
      subjectLarkAppIds: ['cli_pm'],
      quota: 9,
      durationMs,
    }, fixture.deps);
    const after = Date.now();

    expect(result.ok).toBe(true);
    const add = vi.mocked(fixture.deps.addChatGrant);
    expect(add).toHaveBeenCalledWith(
      'cli_receiver',
      'oc_chat',
      'ou_peer_a',
      9,
      expect.any(Number),
    );
    const expiresAt = add.mock.calls[0]?.[4] as number;
    expect(expiresAt).toBeGreaterThanOrEqual(before + durationMs - 2_000);
    expect(expiresAt).toBeLessThanOrEqual(after + durationMs + 2_000);
  });
});
