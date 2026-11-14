import { describe, it, expect, vi, beforeEach } from 'vitest';
import { withMessageReadContext } from '../src/im/lark/message-read-context.js';

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../src/bot-registry.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/bot-registry.js')>(),
  getBotClient: () => ({ request }),
}));
import { getMessageDetail } from '../src/im/lark/client.js';
import { resolveMergedCardContent } from '../src/im/lark/message-parser.js';
import { expandMergeForward } from '../src/im/lark/merge-forward.js';
import { readQuotedMessages } from '../src/cli/quoted-read.js';

describe('per-command message reads', () => {
  beforeEach(() => { request.mockReset(); });
  it('keys real Lark reads by app, representation and deadline, and bypasses cancelled-read caching', async () => {
    request.mockResolvedValue({ code: 0, data: { items: [] } });
    await withMessageReadContext(async () => {
      await getMessageDetail('app_one', 'om_same');
      await getMessageDetail('app_one', 'om_same', { userCardContent: true });
      await getMessageDetail('app_one', 'om_same', { userCardContent: false });
      await getMessageDetail('app_two', 'om_same');
      await getMessageDetail('app_one', 'om_same', { timeoutMs: 10 });
      await getMessageDetail('app_one', 'om_same', { userIdType: 'open_id' });
      const signal = new AbortController().signal;
      await getMessageDetail('app_one', 'om_same', { signal });
      await getMessageDetail('app_one', 'om_same', { signal });
    });
    expect(request).toHaveBeenCalledTimes(7);
  });
  it('the real quoted/card pipeline fetches each card representation once, then refreshes on the next invocation', async () => {
    let version = 1;
    request.mockImplementation(async options => ({ code: 0, data: { items: [{
      message_id: 'om_card', msg_type: 'interactive', create_time: '1700000000000',
      sender: { id: 'ou_sender', sender_type: 'user' },
      body: { content: JSON.stringify({ schema: '2.0', body: { elements: [{ tag: 'markdown', content: `version ${version}` }, ...(options.params.card_msg_content_type ? [{ tag: 'img', img_key: 'img_real' }] : [])] } }) },
    }] } }));
    const d = { getMessageDetail, resolveMergedCard: resolveMergedCardContent, expandMergeForward,
      downloadResources: vi.fn(async () => ({ attachments: [] })), decorate: async (message: unknown) => message };
    const options = { messageIds: ['om_card'], batch: false, raw: true, download: false };
    const first = await readQuotedMessages('app', options, d);
    expect(first.messages[0]).toMatchObject({ content: expect.stringContaining('version 1'), resources: [{ key: 'img_real' }] });
    expect(request).toHaveBeenCalledTimes(2);
    version = 2;
    const second = await readQuotedMessages('app', options, d);
    expect(second.messages[0]).toMatchObject({ content: expect.stringContaining('version 2') });
    expect(request).toHaveBeenCalledTimes(4);
    expect(d.downloadResources).not.toHaveBeenCalled();
  });
});
