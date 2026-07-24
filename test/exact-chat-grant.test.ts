import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyExactChatGrant,
  applyExactChatGrantByLarkAppIds,
  MAX_EXACT_CHAT_GRANT_SUBJECTS,
  type ExactChatGrantDeps,
} from '../src/services/exact-chat-grant.js';

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
      error: 'subject_not_current_chat_bot',
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
    expect(fixture.deps.addChatGrant).toHaveBeenCalledWith('cli_receiver', 'oc_chat', 'ou_peer_a');
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
