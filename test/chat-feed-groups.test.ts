/** Exact-chat feed-group replacement, incomplete directory and partial-write behavior. */
import { describe, expect, it, vi } from 'vitest';
import { replaceChatFeedGroups } from '../src/services/chat-feed-groups.js';

/** An offline API preserving all writes for target and ordering assertions. */
function api(rows: Array<{ group_id: string; name: string; type?: string }>) {
  return { request: vi.fn(async (path: string, body?: unknown): Promise<Record<string, unknown>> => {
    if (body === undefined) return { groups: rows };
    return path === '/open-apis/im/v1/groups' ? { group_id: 'new-label' } : {};
  }) };
}

describe('chat feed-group replacement', () => {
  it('joins the exact target before removing every other manageable association for this chat only', async () => {
    const client = api([{ group_id: 'uncategorized', name: '未分类事项' }, { group_id: 'p0-label', name: 'p0' }, { group_id: 'other', name: 'Other' }, { group_id: 'system', name: '全部', type: 'all' }]);
    await replaceChatFeedGroups(client, 'oc_current', 'p0');
    const writes = client.request.mock.calls.filter(call => call[1] !== undefined);
    expect(writes.map(call => call[0])).toEqual([
      '/open-apis/im/v1/groups/p0-label/batch_add_item',
      '/open-apis/im/v1/groups/uncategorized/batch_remove_item',
      '/open-apis/im/v1/groups/other/batch_remove_item',
    ]);
    for (const [, body] of writes) expect(body).toEqual({ items: [{ feed_id: 'oc_current', feed_type: 'chat' }] });
  });

  it('creates a missing label and clears all manageable labels on close without deleting labels', async () => {
    const client = api([{ group_id: 'old', name: 'pending' }]);
    await replaceChatFeedGroups(client, 'oc_current', 'watching');
    expect(client.request.mock.calls[1]).toEqual(['/open-apis/im/v1/groups', { feed_group_creator: { type: 'normal', name: 'watching' } }]);
    client.request.mockClear();
    await replaceChatFeedGroups(client, 'oc_current', null);
    expect(client.request.mock.calls).toHaveLength(2);
    expect(client.request.mock.calls[1][0]).toBe('/open-apis/im/v1/groups/old/batch_remove_item');
  });

  it('does not remove the original labels if joining the target fails', async () => {
    const client = api([{ group_id: 'old', name: 'pending' }, { group_id: 'target', name: 'p1' }]);
    client.request.mockImplementation(async (path, body) => {
      if (body === undefined) return { groups: [{ group_id: 'old', name: 'pending' }, { group_id: 'target', name: 'p1' }] };
      throw new Error('failed target add');
    });
    await expect(replaceChatFeedGroups(client, 'oc_current', 'p1')).rejects.toThrow('failed target add');
    expect(client.request.mock.calls.some(call => call[0].includes('remove'))).toBe(false);
  });

  it('refuses incomplete pagination and arbitrary labels before mutation', async () => {
    const request = vi.fn(async () => ({ groups: [], has_more: true, page_token: 'stuck' }));
    await expect(replaceChatFeedGroups({ request }, 'oc_current', 'p0')).rejects.toThrow('incomplete_feed_group_directory');
    expect(request.mock.calls).toHaveLength(2);
    await expect(replaceChatFeedGroups({ request }, 'oc_current', 'arbitrary')).rejects.toThrow('invalid_chat_label');
    expect(request.mock.calls).toHaveLength(2);
  });

  it('reports removal errors so callers cannot claim that all prior labels were cleared', async () => {
    const request = vi.fn(async (path: string, body?: unknown): Promise<Record<string, unknown>> => {
      if (body === undefined) return { groups: [{ group_id: 'old', name: 'pending' }] };
      throw new Error('permission denied');
    });
    await expect(replaceChatFeedGroups({ request }, 'oc_current', null)).rejects.toThrow('permission denied');
  });
});

// Generic scope is plugin-owned; unrelated personal groups must survive both switch and close.
describe('scoped plugin feed groups', () => {
  const scope = ['P0', 'P1', 'Backlog', 'LongRun'];
  it('accepts configured names and removes only the explicit scope after joining', async () => {
    const client = api([{ group_id: 'work', name: '工作' }, { group_id: 'p0', name: 'P0' }, { group_id: 'backlog', name: 'Backlog' }]);
    await replaceChatFeedGroups(client, 'oc_current', 'Backlog', scope);
    expect(client.request.mock.calls.filter(call => call[1] !== undefined).map(call => call[0])).toEqual([
      '/open-apis/im/v1/groups/backlog/batch_add_item', '/open-apis/im/v1/groups/p0/batch_remove_item',
    ]);
    client.request.mockClear();
    await replaceChatFeedGroups(client, 'oc_current', null, scope);
    expect(client.request.mock.calls.filter(call => call[1] !== undefined).map(call => call[0])).toEqual([
      '/open-apis/im/v1/groups/p0/batch_remove_item', '/open-apis/im/v1/groups/backlog/batch_remove_item',
    ]);
  });

  it('creates arbitrary configured names and supports additive mode with a one-name scope', async () => {
    const client = api([{ group_id: 'p0', name: 'P0' }]);
    await replaceChatFeedGroups(client, 'oc_current', '研发待办', ['研发待办']);
    expect(client.request.mock.calls.filter(call => call[1] !== undefined)).toEqual([
      ['/open-apis/im/v1/groups', { feed_group_creator: { type: 'normal', name: '研发待办' } }],
      ['/open-apis/im/v1/groups/new-label/batch_add_item', { items: [{ feed_id: 'oc_current', feed_type: 'chat' }] }],
    ]);
  });

  it.each([
    ['Unknown', ['P0']], ['P0', []], ['P0', ['P0', 'P0']],
    ['P0', ['P0', ' ']], ['P0', ['P0', 'invisible\u202ename']],
    ['P0', ['P0', 'a'.repeat(51)]], ['n0', Array.from({ length: 51 }, (_, i) => `n${i}`)],
  ])('rejects malformed or out-of-scope selection %s before reading or writing', async (target, names) => {
    const client = api([]);
    await expect(replaceChatFeedGroups(client, 'oc_current', target as string, names as string[])).rejects.toThrow('invalid_chat_label');
    expect(client.request).not.toHaveBeenCalled();
  });

  it('does no network access for an empty explicit cleanup scope', async () => {
    const client = api([]);
    await replaceChatFeedGroups(client, 'oc_current', null, []);
    expect(client.request).not.toHaveBeenCalled();
  });

  it('rejects ambiguous target names without mutations', async () => {
    const client = api([{ group_id: 'one', name: 'P0' }, { group_id: 'two', name: 'P0' }]);
    await expect(replaceChatFeedGroups(client, 'oc_current', 'P0', scope)).rejects.toThrow('ambiguous_feed_group');
    expect(client.request.mock.calls.every(call => call[1] === undefined)).toBe(true);
  });

  it('leaves all other associations untouched when scoped target add fails', async () => {
    const client = api([{ group_id: 'one', name: 'P0' }, { group_id: 'two', name: 'P1' }]);
    client.request.mockImplementation(async (_path, body) => {
      if (body === undefined) return { groups: [{ group_id: 'one', name: 'P0' }, { group_id: 'two', name: 'P1' }] };
      throw new Error('join failed');
    });
    await expect(replaceChatFeedGroups(client, 'oc_current', 'P1', scope)).rejects.toThrow('join failed');
    expect(client.request.mock.calls.some(call => call[0].includes('remove'))).toBe(false);
  });
});
