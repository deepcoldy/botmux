/** Host-entry regressions for idempotent removal, partial writes and queued requests. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/bot-registry.js', () => ({ getBot: () => ({ config: { larkAppSecret: 'test-only' } }) }));
vi.mock('../src/im/lark/event-dispatcher.js', () => ({ canOperate: () => true }));
vi.mock('../src/utils/user-token.js', () => ({ resolveUserToken: async () => 'test-only-token' }));
vi.mock('../src/im/lark/lark-hosts.js', () => ({ normalizeBrand: () => 'feishu', larkHosts: () => ({ openApi: 'https://example.test' }) }));
import { setChatFeedGroup } from '../src/services/chat-feed-groups.js';

const chatId = 'oc_current';
const item = { feed_id: chatId, feed_type: 'chat' };

/** Return the same envelope shape used by the external feed-group API. */
function result(data: Record<string, unknown>) { return Response.json({ code: 0, data }); }

/** Create a real-host fetch substitute with mutable external membership state. */
function externalGroups() {
  const membership = new Set(['first', 'second']);
  const calls: string[] = [];
  const request = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    calls.push(path);
    if (init?.method === 'GET') return result({ groups: [
      { group_id: 'first', name: 'pending' }, { group_id: 'second', name: 'p0' },
    ] });
    const group = path.split('/').at(-2)!;
    if (path.endsWith('batch_add_item')) { membership.add(group); return result({}); }
    if (!membership.delete(group)) return result({ failed_items: [{ error_code: 230005, item }] });
    return result({});
  });
  vi.stubGlobal('fetch', request);
  return { membership, calls, request };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('feed-group host idempotency', () => {
  it('continues after an externally removed membership and confirms the remaining cleanup', async () => {
    const external = externalGroups();
    external.membership.delete('first');
    await expect(setChatFeedGroup('cli_test', chatId, 'ou_operator', null))
      .resolves.toEqual({ ok: true, chatId, label: null });
    expect(external.membership.size).toBe(0);
    expect(external.calls.at(-1)).toBe('/open-apis/im/v1/groups/second/batch_remove_item');
  });

  it('reports partial failure and allows a new request to finish already-started cleanup', async () => {
    const external = externalGroups();
    const original = external.request.getMockImplementation()!;
    let rejectSecond = true;
    external.request.mockImplementation(async (input, init) => {
      if (String(input).endsWith('/second/batch_remove_item') && rejectSecond) {
        rejectSecond = false;
        return result({ failed_items: [{ error_code: 230004, item }] });
      }
      return original(input, init);
    });
    await expect(setChatFeedGroup('cli_test', chatId, 'ou_operator', null))
      .resolves.toEqual({ ok: false, error: 'feed_group_update_unconfirmed' });
    expect([...external.membership]).toEqual(['second']);
    await expect(setChatFeedGroup('cli_test', chatId, 'ou_operator', null))
      .resolves.toEqual({ ok: true, chatId, label: null });
    expect(external.membership.size).toBe(0);
  });

  it('serializes a newer selection behind delayed close cleanup and keeps its target membership', async () => {
    const external = externalGroups();
    const original = external.request.getMockImplementation()!;
    let delayed = false;
    external.request.mockImplementation(async (input, init) => {
      if (!delayed && String(input).endsWith('/first/batch_remove_item')) {
        delayed = true;
        await new Promise(resolve => setTimeout(resolve, 100));
        external.membership.delete('first');
      }
      return original(input, init);
    });
    const closing = setChatFeedGroup('cli_test', chatId, 'ou_operator', null);
    await vi.advanceTimersByTimeAsync(0);
    const selecting = setChatFeedGroup('cli_test', chatId, 'ou_operator', 'p0');
    await vi.advanceTimersByTimeAsync(99);
    expect(external.calls.filter(path => path === '/open-apis/im/v1/groups')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(closing).resolves.toEqual({ ok: true, chatId, label: null });
    await expect(selecting).resolves.toEqual({ ok: true, chatId, label: 'p0' });
    expect([...external.membership]).toEqual(['second']);
  });
});
