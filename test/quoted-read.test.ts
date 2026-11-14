import { describe, it, expect, vi } from 'vitest';
import { readQuotedMessages } from '../src/cli/quoted-read.js';

function deps() {
  return {
    getMessageDetail: vi.fn(async (_app: string, id: string) => ({ items: [{ message_id: id, msg_type: 'image', create_time: '1700000000000', chat_id: 'oc_current', sender: { id: 'ou_sender', sender_type: 'user' }, body: { content: '{"image_key":"image_key"}' } }] })),
    expandMergeForward: vi.fn(async () => ({ extraResources: [] })),
    resolveMergedCard: vi.fn(async () => null),
    downloadResources: vi.fn(async () => ({ attachments: [{ type: 'image' as const, path: '/attachments/img.jpg', name: 'img.jpg' }], needLogin: true })),
    decorate: vi.fn(async message => message),
  };
}

describe('quoted read execution', () => {
  it('retains normal single-message attachment downloads and raw body', async () => {
    const d = deps();
    const result = await readQuotedMessages('app', { messageIds: ['om_img'], batch: false, raw: true, download: true }, d);
    expect(result.messages[0]).toMatchObject({ messageId: 'om_img', attachments: [{ path: '/attachments/img.jpg' }], needLogin: true, rawContent: '{"image_key":"image_key"}' });
    expect(d.downloadResources).toHaveBeenCalledTimes(1);
  });
  it('reads resources without downloading any bytes when requested', async () => {
    const d = deps();
    const result = await readQuotedMessages('app', { messageIds: ['om_img'], batch: false, raw: false, download: false }, d);
    expect(result.messages[0]).toMatchObject({ resources: [{ key: 'image_key' }], attachmentDownloadSkipped: true });
    expect(result.messages[0]).not.toHaveProperty('attachments');
    expect(d.downloadResources).not.toHaveBeenCalled();
  });
  it('keeps successful batch messages and returns failures by requested id', async () => {
    const d = deps();
    d.getMessageDetail.mockImplementation(async (_app, id) => {
      if (id === 'om_missing') return { items: [] };
      if (id === 'om_denied') throw new Error('permission denied');
      return { items: [{ message_id: id, msg_type: 'text', create_time: '1700000000000', chat_id: 'oc_current', sender: { id: 'ou_sender', sender_type: 'user' }, body: { content: '{"text":"ok"}' } }] };
    });
    const result = await readQuotedMessages('app', { messageIds: ['om_ok', 'om_denied', 'om_missing'], batch: true, raw: false, download: false }, d);
    expect(result.messages).toHaveLength(1);
    expect(result.errors.map(error => error.messageId)).toEqual(['om_denied', 'om_missing']);
  });
  it('propagates single-message failures without converting them to empty success', async () => {
    const d = deps();
    d.getMessageDetail.mockRejectedValue(new Error('permission denied'));
    await expect(readQuotedMessages('app', { messageIds: ['om_denied'], batch: false, raw: false, download: false }, d)).rejects.toThrow('permission denied');
  });
  it('checks remote chat boundaries before rendering, downloading or decorating', async () => {
    const d = deps();
    await expect(readQuotedMessages('app', { messageIds: ['om_other'], batch: false, raw: true, download: true, currentChatId: 'oc_other' }, d)).rejects.toMatchObject({ exitCode: 2 });
    expect(d.downloadResources).not.toHaveBeenCalled();
    expect(d.decorate).not.toHaveBeenCalled();
  });
});
