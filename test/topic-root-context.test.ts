/**
 * Unit tests for buildTopicThreadContext — the first-turn helper that replays
 * the full topic thread (root + prior replies) as a prompt-context block for
 * a 普通群 topic the bot otherwise wouldn't see.
 *
 * Covers: multi-message transcript, current-message exclusion, per-message
 * rendering (text / image / post / merge_forward / interactive), and the
 * degradation paths (empty thread → root-only fallback; list error →
 * root-only fallback; both fail → '').
 *
 * Run:  pnpm vitest run test/topic-root-context.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Network / side-effecting dependencies are mocked. message-parser stays real
// (parseApiMessage / extractResources / createImgNumberer / resolveMergedCardContent
// are pure or only call the mocked client fns).
vi.mock('../src/im/lark/client.js', () => ({
  getMessageDetail: vi.fn(),
  listThreadMessages: vi.fn(),
}));
vi.mock('../src/im/lark/merge-forward.js', () => ({
  expandMergeForward: vi.fn(),
}));
vi.mock('../src/core/session-manager.js', () => ({
  downloadResources: vi.fn(),
  // Deterministic formatter so assertions don't depend on the real i18n/XML
  // shape; the real formatAttachmentsHint has its own test coverage.
  formatAttachmentsHint: vi.fn((atts: any[]) =>
    Array.isArray(atts) && atts.length
      ? `<atts>${atts.map(a => a.name).join(',')}</atts>`
      : '',
  ),
}));

import { buildTopicThreadContext } from '../src/im/lark/topic-root-context.js';
import { getMessageDetail, listThreadMessages } from '../src/im/lark/client.js';
import { expandMergeForward } from '../src/im/lark/merge-forward.js';
import { downloadResources } from '../src/core/session-manager.js';
import type { LarkMessage } from '../src/types.js';
import type { MessageResource } from '../src/im/lark/message-parser.js';

function msg(messageId: string, msgType: string, body: unknown, senderName = '张三') {
  return {
    message_id: messageId,
    msg_type: msgType,
    create_time: '1700000000000',
    sender: { id: 'ou_' + messageId, sender_type: 'user', sender_name: senderName },
    body: { content: typeof body === 'string' ? body : JSON.stringify(body) },
  };
}

const CURRENT_ID = 'om_current';

const getMessageDetailMock = getMessageDetail as unknown as ReturnType<typeof vi.fn>;
const listThreadMessagesMock = listThreadMessages as unknown as ReturnType<typeof vi.fn>;
const expandMergeForwardMock = expandMergeForward as unknown as ReturnType<typeof vi.fn>;
const downloadResourcesMock = downloadResources as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  getMessageDetailMock.mockReset();
  listThreadMessagesMock.mockReset();
  expandMergeForwardMock.mockReset();
  downloadResourcesMock.mockReset();
});

describe('buildTopicThreadContext', () => {
  it('replays root + prior reply as a transcript and excludes the current @-reply', async () => {
    // Thread order (asc): root, one human reply, then the current @-reply.
    listThreadMessagesMock.mockResolvedValue([
      msg('om_root', 'text', { text: '请帮我分析这段代码' }, '张三'),
      msg('om_reply', 'text', { text: '对，特别是第二段' }, '李四'),
      msg(CURRENT_ID, 'text', { text: '@bot 继续' }, '王五'),
    ]);
    downloadResourcesMock.mockResolvedValue({ attachments: [], needLogin: false });

    const out = await buildTopicThreadContext('app_x', 'oc_chat', 'om_root', CURRENT_ID);
    expect(out).toContain('话题上下文');
    expect(out).toContain('共 2 条');
    expect(out).toContain('张三: 请帮我分析这段代码');
    expect(out).toContain('李四: 对，特别是第二段');
    // Current @-reply must NOT appear in the context block (it's the prompt).
    expect(out).not.toContain('继续');
    expect(expandMergeForwardMock).not.toHaveBeenCalled();
  });

  it('downloads image resources and surfaces the attachment block per message', async () => {
    listThreadMessagesMock.mockResolvedValue([
      msg('om_root', 'image', { image_key: 'img_root' }, '张三'),
      msg(CURRENT_ID, 'text', { text: '@bot' }, '李四'),
    ]);
    const attachments = [{ type: 'image', path: '/atts/app_x/om_root/img_root.jpg', name: 'img_root.jpg' }];
    downloadResourcesMock.mockResolvedValue({ attachments, needLogin: false });

    const out = await buildTopicThreadContext('app_x', 'oc_chat', 'om_root', CURRENT_ID);
    expect(out).toContain('[图片 1]');
    expect(out).toContain('<atts>img_root.jpg</atts>');
    expect(downloadResourcesMock).toHaveBeenCalledWith('app_x', 'om_root', expect.any(Array));
  });

  it('keeps image and file numbering independent per message (post root)', async () => {
    const post = {
      zh_cn: {
        title: '截图与文档',
        content: [
          [{ tag: 'text', text: '图：' }, { tag: 'img', image_key: 'img_aaa' }],
          [{ tag: 'text', text: '附件：' }, { tag: 'file', file_key: 'file_bbb', file_name: 'spec.pdf' }],
        ],
      },
    };
    listThreadMessagesMock.mockResolvedValue([
      msg('om_root', 'post', post, '张三'),
      msg(CURRENT_ID, 'text', { text: '@bot' }, '李四'),
    ]);
    downloadResourcesMock.mockResolvedValue({
      attachments: [
        { type: 'image', path: '/a/1.jpg', name: 'img_aaa.jpg' },
        { type: 'file', path: '/a/2.pdf', name: 'spec.pdf' },
      ],
      needLogin: false,
    });

    const out = await buildTopicThreadContext('app_x', 'oc_chat', 'om_root', CURRENT_ID);
    expect(out).toContain('[图片 1]');
    expect(out).toContain('[文件 1: spec.pdf]');
  });

  it('expands a merge_forward root into <forwarded_messages>', async () => {
    listThreadMessagesMock.mockResolvedValue([
      msg('om_root', 'merge_forward', {}, '张三'),
      msg(CURRENT_ID, 'text', { text: '@bot' }, '李四'),
    ]);
    expandMergeForwardMock.mockImplementation(async (_a: string, _m: string, parsed: LarkMessage) => {
      parsed.msgType = 'merge_forward_expanded';
      parsed.content = '<forwarded_messages><msg from="A">前情提要</msg></forwarded_messages>';
      return { extraResources: [{ type: 'image', key: 'img_xyz', name: 'img_xyz.jpg' }] satisfies MessageResource[] };
    });
    downloadResourcesMock.mockResolvedValue({ attachments: [{ type: 'image', path: '/a/x.jpg', name: 'img_xyz.jpg' }], needLogin: false });

    const out = await buildTopicThreadContext('app_x', 'oc_chat', 'om_root', CURRENT_ID);
    expect(out).toContain('<forwarded_messages>');
    expect(out).toContain('前情提要');
    expect(expandMergeForwardMock).toHaveBeenCalledTimes(1);
  });

  it('re-resolves an interactive card root to its real body instead of the upgrade fallback', async () => {
    const card = {
      user_dsl: JSON.stringify({
        header: { title: { tag: 'plain_text', content: '根消息卡片' } },
        body: { elements: [{ tag: 'markdown', content: 'card body here' }] },
      }),
    };
    listThreadMessagesMock.mockResolvedValue([
      msg('om_root', 'interactive', card, '张三'),
      msg(CURRENT_ID, 'text', { text: '@bot' }, '李四'),
    ]);
    downloadResourcesMock.mockResolvedValue({ attachments: [], needLogin: false });

    const out = await buildTopicThreadContext('app_x', 'oc_chat', 'om_root', CURRENT_ID);
    expect(out).toContain('card body here');
  });

  it('falls back to root-only when the thread list returns only the current message', async () => {
    getMessageDetailMock.mockResolvedValue({ items: [msg('om_root', 'text', { text: '孤立的根' }, '张三')] });
    downloadResourcesMock.mockResolvedValue({ attachments: [], needLogin: false });
    listThreadMessagesMock.mockResolvedValue([msg(CURRENT_ID, 'text', { text: '@bot' }, '王五')]);

    const out = await buildTopicThreadContext('app_x', 'oc_chat', 'om_root', CURRENT_ID);
    expect(out).toContain('共 1 条');
    expect(out).toContain('张三: 孤立的根');
  });

  it('falls back to root-only when listThreadMessages throws', async () => {
    listThreadMessagesMock.mockRejectedValue(new Error('Lark 230002: not in chat'));
    getMessageDetailMock.mockResolvedValue({ items: [msg('om_root', 'text', { text: '根内容' }, '张三')] });
    downloadResourcesMock.mockResolvedValue({ attachments: [], needLogin: false });

    const out = await buildTopicThreadContext('app_x', 'oc_chat', 'om_root', CURRENT_ID);
    expect(out).toContain('张三: 根内容');
  });

  it('returns "" (best-effort) when both list and root-only fail', async () => {
    listThreadMessagesMock.mockRejectedValue(new Error('list down'));
    getMessageDetailMock.mockRejectedValue(new Error('get down'));
    const out = await buildTopicThreadContext('app_x', 'oc_chat', 'om_root', CURRENT_ID);
    expect(out).toBe('');
  });

  it('returns "" for an empty rootId', async () => {
    const out = await buildTopicThreadContext('app_x', 'oc_chat', '', CURRENT_ID);
    expect(out).toBe('');
    expect(listThreadMessagesMock).not.toHaveBeenCalled();
  });
});
