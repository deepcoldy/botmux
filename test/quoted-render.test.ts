/**
 * Unit tests for the lookup and render pipeline `botmux quoted` runs
 * against a raw Lark message. Covers the four msg_type families spec calls
 * out (text, image, post, merge_forward) plus the post mixed-media case
 * exposed by the file-tag extraction added in ce5b096.
 *
 * Run:  bun run test -- test/quoted-render.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const getMessageDetailMock = vi.fn();
vi.mock('../src/im/lark/client.js', () => ({
  getMessageDetail: (...args: any[]) => getMessageDetailMock(...args),
}));

import { getQuotedMessageDetail, renderQuotedMessage } from '../src/cli/quoted-render.js';
import { expandMergeForward } from '../src/im/lark/merge-forward.js';
import { larkApiError } from '../src/im/lark/lark-errors.js';
import type { LarkMessage } from '../src/types.js';
import type { MessageResource } from '../src/im/lark/message-parser.js';

function rawMessage(msgType: string, body: unknown) {
  return {
    message_id: 'om_quoted',
    msg_type: msgType,
    create_time: '1700000000000',
    sender: { id: 'ou_sender', sender_type: 'user' },
    body: { content: typeof body === 'string' ? body : JSON.stringify(body) },
  };
}

/** No-op expandMergeForward stub for non-merge_forward cases. */
const noExpand = vi.fn(async () => ({ extraResources: [] as MessageResource[] }));

describe('getQuotedMessageDetail', () => {
  beforeEach(() => { getMessageDetailMock.mockReset(); });

  it.each(['text', 'interactive'])('preserves the successful %s lookup without extra requests', async (msgType) => {
    const detail = { items: [rawMessage(msgType, { text: 'body' })] };
    getMessageDetailMock.mockResolvedValueOnce(detail);
    const out = await getQuotedMessageDetail('app_x', 'om_quoted', getMessageDetailMock);
    expect(out).toBe(detail);
    expect(getMessageDetailMock.mock.calls).toEqual([['app_x', 'om_quoted']]);
  });

  it.each([
    Object.assign(new Error('Request failed with status code 500'), {
      response: { status: 500, data: { code: 2200, msg: 'internal error' } },
    }),
    larkApiError('get message', { code: 2200, msg: 'internal error' }),
  ])('retries the card-content server error using the default representation', async (error) => {
    const detail = { items: [rawMessage('merge_forward', {})] };
    getMessageDetailMock.mockRejectedValueOnce(error).mockResolvedValueOnce(detail);
    const out = await getQuotedMessageDetail('app_x', 'om_quoted', getMessageDetailMock);
    expect(out).toBe(detail);
    expect(getMessageDetailMock.mock.calls).toEqual([
      ['app_x', 'om_quoted'],
      ['app_x', 'om_quoted', { userCardContent: false }],
    ]);
  });

  it.each([
    Object.assign(new Error('not in chat'), { response: { status: 403, data: { code: 230002 } } }),
    larkApiError('get message', { code: 230011, msg: 'withdrawn' }),
    Object.assign(new Error('rate limited'), { response: { status: 429, data: { code: 99991400 } } }),
    Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }),
    Object.assign(new Error('other server failure'), { response: { status: 500, data: { code: 2201 } } }),
    Object.assign(new Error('server failure without a business code'), { response: { status: 500 } }),
  ])('propagates unrelated lookup errors without a fallback request', async (error) => {
    getMessageDetailMock.mockRejectedValueOnce(error);
    await expect(getQuotedMessageDetail('app_x', 'om_quoted', getMessageDetailMock)).rejects.toBe(error);
    expect(getMessageDetailMock).toHaveBeenCalledTimes(1);
  });

  it('propagates a failed fallback without retrying again', async () => {
    const fallbackError = larkApiError('get message', { code: 230002, msg: 'not in chat' });
    getMessageDetailMock
      .mockRejectedValueOnce(larkApiError('get message', { code: 2200, msg: 'internal error' }))
      .mockRejectedValueOnce(fallbackError);
    await expect(getQuotedMessageDetail('app_x', 'om_quoted', getMessageDetailMock)).rejects.toBe(fallbackError);
    expect(getMessageDetailMock).toHaveBeenCalledTimes(2);
  });

  it('lets an unavailable message reach the CLI missing-message check', async () => {
    const detail = { items: [] };
    getMessageDetailMock.mockResolvedValueOnce(detail);
    expect(await getQuotedMessageDetail('app_x', 'om_quoted', getMessageDetailMock)).toBe(detail);
    expect(getMessageDetailMock).toHaveBeenCalledTimes(1);
  });

  it('reaches the real forwarded-tree renderer after the initial HTTP 500, including nested resources and card recovery', async () => {
    const root = rawMessage('merge_forward', {});
    const forwarded = [
      root,
      { ...rawMessage('merge_forward', {}), message_id: 'om_inner', upper_message_id: 'om_quoted' },
      { ...rawMessage('text', { text: 'nested text' }), message_id: 'om_text', upper_message_id: 'om_inner' },
      { ...rawMessage('image', { image_key: 'img_nested' }), message_id: 'om_image', upper_message_id: 'om_inner' },
      { ...rawMessage('file', { file_key: 'file_nested', file_name: 'report.pdf' }), message_id: 'om_file', upper_message_id: 'om_inner' },
      { ...rawMessage('interactive', {
        elements: [[{ tag: 'text', text: '请升级至最新版本客户端，以查看内容' }]],
      }), message_id: 'om_card', upper_message_id: 'om_quoted' },
    ];
    getMessageDetailMock.mockImplementation(async (_appId: string, messageId: string, options?: { userCardContent?: boolean }) => {
      if (messageId === 'om_card') {
        return { items: [rawMessage('interactive', {
          schema: '2.0',
          body: { elements: [{ tag: 'markdown', content: 'recovered card body' }] },
        })] };
      }
      if (options?.userCardContent !== false) {
        throw Object.assign(new Error('Request failed with status code 500'), {
          response: { status: 500, data: { code: 2200 } },
        });
      }
      // The expander mutates card bodies; each API response is a fresh object.
      return structuredClone({ items: forwarded });
    });

    const detail = await getQuotedMessageDetail('app_x', 'om_quoted', getMessageDetailMock);
    const out = await renderQuotedMessage('app_x', detail.items[0], expandMergeForward);
    expect(out.msgType).toBe('merge_forward_expanded');
    expect(out.content).toContain('<forwarded_messages>');
    expect(out.content).toContain('type="merged_forward"');
    expect(out.content).toContain('nested text');
    expect(out.content).toContain('recovered card body');
    expect(out.content).not.toContain('请升级至最新版本客户端');
    expect(out.content).toContain('[图片 1]');
    expect(out.content).toContain('[文件 1: report.pdf]');
    expect(out.resources).toEqual([
      { type: 'image', key: 'img_nested', name: 'img_nested.jpg' },
      { type: 'file', key: 'file_nested', name: 'report.pdf' },
    ]);
  });
});

describe('renderQuotedMessage: text', () => {
  it('renders a plain text message and returns no resources', async () => {
    const out = await renderQuotedMessage('app_x', rawMessage('text', { text: 'hello there' }), noExpand);
    expect(out.msgType).toBe('text');
    expect(out.content).toBe('hello there');
    expect(out.resources).toEqual([]);
    expect(noExpand).not.toHaveBeenCalled();
  });
});

describe('renderQuotedMessage: image', () => {
  it('renders [图片 1] and exposes the image_key in resources', async () => {
    const out = await renderQuotedMessage('app_x', rawMessage('image', { image_key: 'img_solo' }), noExpand);
    expect(out.msgType).toBe('image');
    expect(out.content).toBe('[图片 1]');
    expect(out.resources).toEqual([{ type: 'image', key: 'img_solo', name: 'img_solo.jpg' }]);
  });
});

describe('renderQuotedMessage: post', () => {
  it('keeps image and file numbering independent (regression: [图片 1] + [文件 1])', async () => {
    const post = {
      zh_cn: {
        title: '截图与文档',
        content: [
          [{ tag: 'text', text: '图：' }, { tag: 'img', image_key: 'img_aaa' }],
          [{ tag: 'text', text: '附件：' }, { tag: 'file', file_key: 'file_bbb', file_name: 'spec.pdf' }],
        ],
      },
    };
    const out = await renderQuotedMessage('app_x', rawMessage('post', post), noExpand);
    expect(out.msgType).toBe('post');
    expect(out.content).toContain('[图片 1]');
    expect(out.content).toContain('[文件 1: spec.pdf]');
    expect(out.resources).toEqual([
      { type: 'image', key: 'img_aaa', name: 'img_aaa.jpg' },
      { type: 'file', key: 'file_bbb', name: 'spec.pdf' },
    ]);
  });

  it('exposes a rich-text upload carried by the post top-level files array', async () => {
    const post = {
      title: '',
      content: [[{ tag: 'text', text: '请看附件' }]],
      content_v2: [[{ tag: 'text', text: '请看附件' }]],
      files: [{
        file_key: 'file_v3_quoted',
        file_name: 'brief.md',
        is_folder: false,
      }],
    };
    const out = await renderQuotedMessage('app_x', rawMessage('post', post), noExpand);
    expect(out.content).toBe('请看附件');
    expect(out.resources).toEqual([{
      type: 'file',
      key: 'file_v3_quoted',
      name: 'brief.md',
    }]);
  });
});

describe('renderQuotedMessage: interactive', () => {
  it('parses user_dsl card content and keeps image placeholders aligned with resources', async () => {
    const out = await renderQuotedMessage('app_x', rawMessage('interactive', {
      user_dsl: JSON.stringify({
        header: { title: { tag: 'plain_text', content: 'Quoted Card' } },
        body: {
          elements: [
            { tag: 'markdown', content: 'card body' },
            { tag: 'img', img_key: 'img_card' },
          ],
        },
      }),
    }), noExpand);

    expect(out.msgType).toBe('interactive');
    expect(out.content).toContain('[卡片: Quoted Card]');
    expect(out.content).toContain('card body');
    expect(out.content).toContain('[图片 1]');
    expect(out.resources).toEqual([{ type: 'image', key: 'img_card', name: 'img_card.jpg' }]);
  });
});

describe('renderQuotedMessage: merge_forward', () => {
  it('appends sub-message extraResources after top-level resources and stamps msgType to merge_forward_expanded', async () => {
    // Stub expandMergeForward to mimic a forwarded subtree with one image
    // and one file. It mutates parsed.content + msgType the same way the
    // real impl does so the test asserts on real shape.
    const fakeExpand = vi.fn(async (_appId: string, _mid: string, parsed: LarkMessage) => {
      parsed.msgType = 'merge_forward_expanded';
      parsed.content = '<forwarded_messages><msg from="A">[图片 1] [文件 1: report.pdf]</msg></forwarded_messages>';
      return {
        extraResources: [
          { type: 'image', key: 'img_xyz', name: 'img_xyz.jpg' },
          { type: 'file', key: 'file_abc', name: 'report.pdf' },
        ] satisfies MessageResource[],
      };
    });

    const out = await renderQuotedMessage('app_x', rawMessage('merge_forward', {}), fakeExpand);
    expect(out.msgType).toBe('merge_forward_expanded');
    expect(out.content).toContain('<forwarded_messages>');
    expect(out.resources).toEqual([
      { type: 'image', key: 'img_xyz', name: 'img_xyz.jpg' },
      { type: 'file', key: 'file_abc', name: 'report.pdf' },
    ]);
    // The render layer passes a numberer through — verify the fake saw it
    // (the real expandMergeForward uses it for deep `[图片 N]` placement).
    expect(fakeExpand).toHaveBeenCalledTimes(1);
    expect(fakeExpand.mock.calls[0][3]).toBeDefined();
  });
});
