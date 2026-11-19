import { describe, expect, it, vi, afterEach } from 'vitest';
import { callOwnerFollowApi, listOwnerFollowChats } from '../src/services/owner-group-follow-runtime.js';
import { OwnerGroupFollowError } from '../src/services/owner-group-follow.js';

afterEach(() => vi.unstubAllGlobals());

describe('owner follow OpenAPI', () => {
  it('reads every page and excludes p2p and dissolved entries', async () => {
    const page = vi.fn(async (cursor?: string) => ({ code: 0, data: cursor
      ? { items: [{ chat_id: 'oc_new' }, { chat_id: 'oc_private', chat_type: 'p2p' }, { chat_id: 'oc_dissolved', chat_status: 'dissolved' }], has_more: false }
      : { items: [{ chat_id: 'oc_old' }, { chat_id: 'oc_retained', chat_status: 'dissolved_save' }], has_more: true, page_token: 'next' } }));
    expect(await listOwnerFollowChats(page)).toEqual(['oc_old', 'oc_new']);
    expect(page.mock.calls).toEqual([[undefined], ['next']]);
  });
  it('does not return partial data when later pages fail', async () => {
    const page = vi.fn().mockResolvedValueOnce({ code: 0, data: { items: [{ chat_id: 'oc_old' }], has_more: true, page_token: 'next' } })
      .mockResolvedValueOnce({ code: 99991672 });
    await expect(listOwnerFollowChats(page)).rejects.toMatchObject({ authorization: true });
  });
  it('rejects repeated cursors, malformed snapshots and pagination caps', async () => {
    const repeat = vi.fn(async () => ({ code: 0, data: { items: [], has_more: true, page_token: 'same' } }));
    await expect(listOwnerFollowChats(repeat)).rejects.toBeInstanceOf(OwnerGroupFollowError);
    await expect(listOwnerFollowChats(async () => ({ code: 0, data: { items: [], has_more: true } }))).rejects.toThrow();
    let cursor = 0;
    await expect(listOwnerFollowChats(async () => ({ code: 0, data: { items: [], has_more: true, page_token: String(++cursor) } }))).rejects.toThrow();
  });
  it('uses the supplied user token, keeps GET bodyless, and propagates cancellation', async () => {
    const request = vi.fn(async (_url: string, init: RequestInit) => {
      expect(init.headers).toMatchObject({ Authorization: 'Bearer owner-token' });
      expect(init.method).toBe('GET'); expect(init.body).toBeUndefined();
      return new Response(JSON.stringify({ code: 0, data: {} }));
    });
    vi.stubGlobal('fetch', request);
    const controller = new AbortController();
    await callOwnerFollowApi('https://open.feishu.cn', 'owner-token', '/open-apis/im/v1/chats', controller.signal);
    controller.abort(); expect(request.mock.calls[0][1].signal?.aborted).toBe(true);
  });
  it.each([[429, true], [503, true], [400, false], [403, true]])
    ('classifies HTTP failure %i without returning a successful JSON body', async (status, retryable) => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ code: 0 }), { status })));
      await expect(callOwnerFollowApi('https://open.feishu.cn', 'token', '/path', new AbortController().signal))
        .rejects.toMatchObject({ retryable });
    });
  it.each([[401, true], [403, true], [503, true], [400, false]])
    ('classifies HTTP failure %i with a non-JSON gateway body', async (status, retryable) => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response('gateway unavailable', { status })));
      await expect(callOwnerFollowApi('https://open.feishu.cn', 'token', '/path', new AbortController().signal))
        .rejects.toMatchObject({ retryable, authorization: status === 401 || status === 403 });
    });
  it('retries a documented simultaneous same-chat operation conflict', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ code: 232019 }))));
    await expect(callOwnerFollowApi('https://open.feishu.cn', 'token', '/path', new AbortController().signal))
      .rejects.toMatchObject({ retryable: true, authorization: false });
  });
});
