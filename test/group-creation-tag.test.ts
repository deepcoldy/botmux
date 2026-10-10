import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ token: vi.fn(), fetch: vi.fn() }));
vi.mock('../src/bot-registry.js', () => ({
  getBot: () => ({ config: { larkAppId: 'cli_test', larkAppSecret: 'secret', brand: 'feishu' } }),
  getBotClient: vi.fn(), effectiveBotDisplayName: vi.fn(),
}));
vi.mock('../src/utils/user-token.js', () => ({
  resolveUserToken: h.token, resolveOwnerUserToken: vi.fn(), generateAuthUrl: vi.fn(), FEED_GROUP_OAUTH_SCOPES: [],
}));
import { addCreatedChatToFeedGroup } from '../src/services/feed-group-tagger.js';
const ok = (data: unknown) => new Response(JSON.stringify({ code: 0, data }), { status: 200 });
describe('explicit personal group tag', () => {
  beforeEach(() => { h.token.mockReset().mockResolvedValue('user-token'); h.fetch.mockReset(); vi.stubGlobal('fetch', h.fetch); });
  afterEach(() => vi.unstubAllGlobals());
  it('uses the exact sender token, reuses a name and verifies membership', async () => {
    h.fetch.mockResolvedValueOnce(ok({ groups: [{ name: 'Work', group_id: 'ofg_work' }] }))
      .mockResolvedValueOnce(ok({})).mockResolvedValueOnce(ok({ items: [{ feed_id: 'oc_chat', feed_type: 'chat' }] }));
    await addCreatedChatToFeedGroup('cli_test', 'oc_chat', 'ou_sender', 'Work');
    expect(h.token).toHaveBeenCalledWith('cli_test', 'secret', 'feishu', 'ou_sender', expect.any(AbortSignal));
    expect(h.fetch.mock.calls.map(c => String(c[0]))).toEqual([
      expect.stringContaining('/groups?'), expect.stringContaining('/ofg_work/batch_add_item'), expect.stringContaining('/ofg_work/batch_query_item'),
    ]);
  });
  it('bounds token refresh and all tag requests with one ten-second signal', async () => {
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    h.token.mockImplementationOnce((_app, _secret, _brand, _user, signal: AbortSignal) =>
      new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })));
    try {
      const result = addCreatedChatToFeedGroup('cli_test', 'oc_chat', 'ou_sender', 'Work');
      const rejected = expect(result).rejects.toThrow('budget expired');
      expect(timeout).toHaveBeenCalledWith(10_000);
      controller.abort(new Error('budget expired'));
      await rejected;
      expect(h.fetch).not.toHaveBeenCalled();
    } finally { timeout.mockRestore(); }
  });
  it('uses the same signal for token resolution and every feed-group request', async () => {
    h.fetch.mockResolvedValueOnce(ok({ groups: [{ name: 'Work', group_id: 'ofg_work' }] }))
      .mockResolvedValueOnce(ok({})).mockResolvedValueOnce(ok({ items: [{ feed_id: 'oc_chat' }] }));
    await addCreatedChatToFeedGroup('cli_test', 'oc_chat', 'ou_sender', 'Work');
    const signal = h.token.mock.calls[0][4];
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(h.fetch.mock.calls.every(c => c[1].signal === signal)).toBe(true);
  });
  it('does not use another token or mutate anything when the sender is unauthorized', async () => {
    h.token.mockResolvedValue(null);
    await expect(addCreatedChatToFeedGroup('cli_test', 'oc_chat', 'ou_other', 'Work')).rejects.toThrow('authorization');
    expect(h.fetch).not.toHaveBeenCalled();
  });
  it('does not create on lookup failure', async () => {
    h.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ code: 99991679, msg: 'forbidden' }), { status: 403 }));
    await expect(addCreatedChatToFeedGroup('cli_test', 'oc_chat', 'ou_sender', 'Work')).rejects.toThrow('lookup failed');
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });
  it('creates a missing name and rejects a false successful add', async () => {
    h.fetch.mockResolvedValueOnce(ok({ groups: [] })).mockResolvedValueOnce(ok({ group_id: 'ofg_new' }))
      .mockResolvedValueOnce(ok({})).mockResolvedValueOnce(ok({ items: [] }));
    await expect(addCreatedChatToFeedGroup('cli_test', 'oc_chat', 'ou_sender', 'New')).rejects.toThrow('verified');
    expect(JSON.parse(h.fetch.mock.calls[1][1].body)).toEqual({ feed_group_creator: { type: 'normal', name: 'New' } });
  });
  it('does not query after an item failure', async () => {
    h.fetch.mockResolvedValueOnce(ok({ groups: [{ name: 'Work', group_id: 'ofg_work' }] }))
      .mockResolvedValueOnce(ok({ failed_items: [{ feed_id: 'oc_chat' }] }));
    await expect(addCreatedChatToFeedGroup('cli_test', 'oc_chat', 'ou_sender', 'Work')).rejects.toThrow('insertion');
    expect(h.fetch).toHaveBeenCalledTimes(2);
  });
});
