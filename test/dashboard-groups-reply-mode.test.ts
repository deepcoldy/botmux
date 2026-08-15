import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchGroupReplyPolicy,
  fetchGroupsSnapshot,
  invalidateGroupsSnapshotCache,
  normalizeGroupReplyPolicy,
  primeGroupsSnapshotCache,
  setGroupReplyMode,
  withGroupReplyPolicy,
} from '../src/dashboard/web/groups-api.js';
import { replyPolicyShortSummary, replyPolicySummary } from '../src/dashboard/web/groups-page.js';
import { createDashboardTranslator } from '../src/dashboard/web/i18n.js';

const POLICY = {
  ok: true,
  chatId: 'oc/team',
  override: null,
  default: 'chat-topic',
  effective: 'chat-topic',
  inherited: true,
};

afterEach(() => {
  invalidateGroupsSnapshotCache();
  vi.unstubAllGlobals();
});

describe('dashboard group reply-mode API', () => {
  it('keeps the list pill summary short while retaining a full tooltip summary', () => {
    const tr = createDashboardTranslator('zh');
    expect(replyPolicyShortSummary(POLICY, tr)).toBe('继承 · chat-topic');
    expect(replyPolicySummary(POLICY, tr)).toBe(
      '当前：顶层平铺，原生话题独立（默认） · 继承默认 顶层平铺，原生话题独立（默认）',
    );
    const override = { ...POLICY, override: 'new-topic' as const, effective: 'new-topic' as const, inherited: false };
    expect(replyPolicyShortSummary(override, tr)).toBe('覆盖 · new-topic');
  });

  it('normalizes the public topic label to the internal shared mode', () => {
    expect(normalizeGroupReplyPolicy({
      chatId: 'oc_1',
      override: 'topic',
      default: 'chat',
      effective: 'topic',
      inherited: false,
    })).toEqual({
      chatId: 'oc_1',
      override: 'shared',
      default: 'chat',
      effective: 'shared',
      inherited: false,
    });
    expect(normalizeGroupReplyPolicy({ default: 'bad', effective: 'chat' })).toBeNull();
  });

  it('keeps the bot default separate from an explicit group override', () => {
    expect(normalizeGroupReplyPolicy({
      chatId: 'oc_a',
      override: 'new-topic',
      default: 'chat',
      effective: 'new-topic',
      inherited: false,
    })).toEqual({
      chatId: 'oc_a',
      override: 'new-topic',
      default: 'chat',
      effective: 'new-topic',
      inherited: false,
    });
    expect(normalizeGroupReplyPolicy({
      chatId: 'oc_b',
      override: null,
      default: 'chat',
      effective: 'chat',
      inherited: true,
    })).toMatchObject({ override: null, default: 'chat', effective: 'chat', inherited: true });
  });

  it('optimistically patches only the targeted chat and bot without mutation', () => {
    const original = {
      chats: [{
        chatId: 'oc_a',
        memberBots: [
          { larkAppId: 'app_1', inChat: true, replyPolicy: { ...POLICY, chatId: 'oc_a' } },
          { larkAppId: 'app_2', inChat: true },
        ],
      }],
      bots: [{ larkAppId: 'app_1' }, { larkAppId: 'app_2' }],
    };
    const nextPolicy = {
      chatId: 'oc_a',
      override: 'new-topic' as const,
      default: 'chat' as const,
      effective: 'new-topic' as const,
      inherited: false,
    };
    const next = withGroupReplyPolicy(original, 'oc_a', 'app_1', nextPolicy);

    expect(next).not.toBe(original);
    expect(next.chats[0].memberBots[0].replyPolicy).toEqual(nextPolicy);
    expect(next.chats[0].memberBots[1]).toBe(original.chats[0].memberBots[1]);
    expect(original.chats[0].memberBots[0].replyPolicy?.effective).toBe('chat-topic');
    expect(withGroupReplyPolicy(original, 'missing', 'app_1', nextPolicy)).toBe(original);
  });

  it('invalidates the browser Groups cache after a bot default changes', async () => {
    const stale = {
      chats: [{
        chatId: 'oc_inherited',
        memberBots: [{
          larkAppId: 'app_1',
          inChat: true,
          replyPolicy: {
            chatId: 'oc_inherited',
            override: null,
            default: 'chat' as const,
            effective: 'chat' as const,
            inherited: true,
          },
        }],
      }],
      bots: [{ larkAppId: 'app_1' }],
    };
    const fresh = {
      chats: [{
        chatId: 'oc_inherited',
        memberBots: [{
          larkAppId: 'app_1',
          inChat: true,
          replyPolicy: {
            chatId: 'oc_inherited',
            override: null,
            default: 'new-topic',
            effective: 'new-topic',
            inherited: true,
          },
        }],
      }],
      bots: [{ larkAppId: 'app_1' }],
    };
    primeGroupsSnapshotCache(stale);
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(fresh), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchGroupsSnapshot()).resolves.toBe(stale);
    expect(fetchMock).not.toHaveBeenCalled();

    invalidateGroupsSnapshotCache();
    await expect(fetchGroupsSnapshot()).resolves.toEqual(fresh);
    expect(fetchMock).toHaveBeenCalledWith('/api/groups');
  });

  it('reads the private per-(chat × bot) endpoint with encoded identifiers', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(POLICY), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchGroupReplyPolicy('oc/team', 'cli/app')).resolves.toMatchObject({
      chatId: 'oc/team',
      inherited: true,
      effective: 'chat-topic',
    });
    expect(fetchMock).toHaveBeenCalledWith('/api/groups/oc%2Fteam/reply-mode/cli%2Fapp');
  });

  it('maps topic to shared on PUT and uses DELETE for inherit', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const inherited = init?.method === 'DELETE';
      return new Response(JSON.stringify({
        ...POLICY,
        override: inherited ? null : 'shared',
        effective: inherited ? 'chat-topic' : 'shared',
        inherited,
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    await setGroupReplyMode('oc/team', 'cli/app', 'topic');
    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/groups/oc%2Fteam/reply-mode/cli%2Fapp', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'shared' }),
    });

    await setGroupReplyMode('oc/team', 'cli/app', 'inherit');
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/groups/oc%2Fteam/reply-mode/cli%2Fapp', { method: 'DELETE' });
  });

  it('surfaces daemon errors instead of accepting malformed state', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ ok: false, reason: 'topic_group_not_configurable' }),
      { status: 409, headers: { 'content-type': 'application/json' } },
    )));
    await expect(fetchGroupReplyPolicy('oc_1', 'app_1')).rejects.toThrow('topic_group_not_configurable');
  });
});
