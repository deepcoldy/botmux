/**
 * listChatMessagesUntil 的超时 / 取消透传：群消息监听轮询靠它给每页请求加 HTTP
 * 超时并在被取消后停止翻页；不传选项的老调用方（dashboard、/summary）请求形状不变。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const request = vi.fn();
vi.mock('../src/bot-registry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/bot-registry.js')>();
  return { ...actual, getBotClient: () => ({ request }) };
});

import { listChatMessagesUntil } from '../src/im/lark/client.js';

function page(ids: string[], pageToken?: string) {
  return { code: 0, data: { items: ids.map(id => ({ message_id: id })), ...(pageToken ? { page_token: pageToken } : {}) } };
}

describe('listChatMessagesUntil timeout / abort', () => {
  beforeEach(() => request.mockReset());

  it('passes timeoutMs and signal to every page request', async () => {
    request
      .mockResolvedValueOnce(page(['m2'], 'tok'))
      .mockResolvedValueOnce(page(['m1']));
    const controller = new AbortController();

    const out = await listChatMessagesUntil('app', 'oc_chat', { timeoutMs: 1234, signal: controller.signal });

    expect(out.map(m => m.message_id)).toEqual(['m1', 'm2']);
    expect(request).toHaveBeenCalledTimes(2);
    for (const [arg] of request.mock.calls) {
      expect(arg).toMatchObject({ method: 'GET', url: '/open-apis/im/v1/messages', timeout: 1234 });
      expect(arg.signal).toBe(controller.signal);
    }
  });

  it('keeps the legacy request shape when no deadline options are given', async () => {
    request.mockResolvedValueOnce(page(['m1']));

    await listChatMessagesUntil('app', 'oc_chat');

    const [arg] = request.mock.calls[0];
    expect(arg).not.toHaveProperty('timeout');
    expect(arg).not.toHaveProperty('signal');
  });

  it('stops paging once the signal is aborted mid-scan', async () => {
    const controller = new AbortController();
    request.mockImplementationOnce(async () => {
      controller.abort(new Error('poll deadline'));
      return page(['m2'], 'tok');
    });

    await expect(listChatMessagesUntil('app', 'oc_chat', { signal: controller.signal })).rejects.toThrow('poll deadline');
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('does not issue a request when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort(new Error('already gone'));

    await expect(listChatMessagesUntil('app', 'oc_chat', { signal: controller.signal })).rejects.toThrow('already gone');
    expect(request).not.toHaveBeenCalled();
  });
});
