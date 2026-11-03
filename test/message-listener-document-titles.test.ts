import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = { request: vi.fn() };
vi.mock('../src/bot-registry.js', () => ({
  getBot: vi.fn(() => ({ config: { brand: 'feishu' } })),
  getBotClient: vi.fn(() => ({ request: mocks.request })),
}));
import { extractListenerDocumentLinks, resolveListenerDocumentTitles } from '../src/services/message-listener-document-titles.js';

describe('listener document title resolution', () => {
  beforeEach(() => mocks.request.mockReset());
  it('accepts deduplicated trusted URLs through common trailing punctuation', () => {
    const docx = 'DocToken1234567890AbCd';
    const wiki = 'WikiToken1234567890AbCd';
    expect(extractListenerDocumentLinks(
      `（https://bytedance.feishu.cn/docx/${docx}）, https://bytedance.feishu.cn/docx/${docx}。 [wiki](https://foo.larkoffice.com/wiki/${wiki}) https://feishu.cn.evil.example/docx/EvilToken1234567890`,
      'feishu',
    )).toEqual([
      expect.objectContaining({ kind: 'docx', token: docx }),
      expect.objectContaining({ kind: 'wiki', token: wiki }),
    ]);
  });
  it('uses the bot tenant API for docx metadata, never a user token', async () => {
    mocks.request.mockResolvedValueOnce({ data: { metas: [{ title: '智能纪要：测试会议' }] } });
    await expect(resolveListenerDocumentTitles('cli_listener', 'https://bytedance.feishu.cn/docx/DocToken123')).resolves.toEqual(['智能纪要：测试会议']);
    expect(mocks.request).toHaveBeenCalledWith(expect.objectContaining({ method: 'POST', url: '/open-apis/drive/v1/metas/batch_query' }));
  });
  it('uses tenant-only node then file metadata for wiki', async () => {
    mocks.request.mockResolvedValueOnce({ data: { node: { obj_token: 'UnderlyingDoc', obj_type: 'docx' } } }).mockResolvedValueOnce({ data: { metas: [{ title: 'Wiki 智能纪要' }] } });
    await expect(resolveListenerDocumentTitles('cli_listener', 'https://foo.larkoffice.com/wiki/WikiToken456')).resolves.toEqual(['Wiki 智能纪要']);
    expect(mocks.request.mock.calls.map(([request]) => request.url)).toEqual(['/open-apis/wiki/v2/spaces/get_node', '/open-apis/drive/v1/metas/batch_query']);
  });
});
