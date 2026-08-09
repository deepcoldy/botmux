import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/utils/user-token.js', () => ({
  resolveUserToken: vi.fn(async () => 'u-test'),
}));

import { resolveUserToken } from '../src/utils/user-token.js';
import { addChatToFeedGroup, createFeedGroup, FeedGroupApiError, listFeedGroups } from '../src/dashboard/feed-groups.js';

const bot = { larkAppId: 'cli_test', larkAppSecret: 'secret', brand: 'feishu' as const };

function response(data: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

describe('dashboard native Feishu feed groups', () => {
  beforeEach(() => vi.mocked(resolveUserToken).mockResolvedValue('u-test'));

  it('paginates and normalizes live labels', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ code: 0, data: { groups: [{ group_id: 'ofg_1', name: '工作', type: 'normal' }], has_more: true, page_token: 'next' } }))
      .mockResolvedValueOnce(response({ code: 0, data: { groups: [{ group_id: 'ofg_2', name: '学习', type: 'normal' }], has_more: false, page_token: '' } }));

    await expect(listFeedGroups(bot, fetcher)).resolves.toEqual([
      { groupId: 'ofg_1', name: '工作', type: 'normal' },
      { groupId: 'ofg_2', name: '学习', type: 'normal' },
    ]);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(String(fetcher.mock.calls[1][0])).toContain('page_token=next');
  });

  it('creates a normal label then adds a chat', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ code: 0, data: { group_id: 'ofg_new' } }))
      .mockResolvedValueOnce(response({ code: 0, data: { failed_items: [] } }));

    const id = await createFeedGroup(bot, '项目', fetcher);
    await addChatToFeedGroup(bot, id, 'oc_chat', fetcher);
    expect(id).toBe('ofg_new');
    expect(String(fetcher.mock.calls[1][0])).toContain('/groups/ofg_new/batch_add_item');
    expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({ items: [{ feed_id: 'oc_chat', feed_type: 'chat' }] });
  });

  it('reports login-required without making an API request', async () => {
    vi.mocked(resolveUserToken).mockResolvedValueOnce(null);
    const fetcher = vi.fn();
    await expect(listFeedGroups(bot, fetcher)).rejects.toMatchObject<Partial<FeedGroupApiError>>({ code: 'user_login_required', status: 401 });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('surfaces partial add failures', async () => {
    const fetcher = vi.fn().mockResolvedValue(response({
      code: 0,
      data: { failed_items: [{ error_code: 240001, error_message: 'feed_id is invalid' }] },
    }));
    await expect(addChatToFeedGroup(bot, 'ofg_1', 'oc_bad', fetcher)).rejects.toMatchObject({
      code: 'feed_group_add_failed',
      message: 'feed_id is invalid',
    });
  });
});
