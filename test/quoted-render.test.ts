/**
 * Unit tests for renderQuotedMessage — the pure pipeline `botmux quoted` runs
 * against a raw Lark message. Covers the four msg_type families spec calls
 * out (text, image, post, merge_forward) plus the post mixed-media case
 * exposed by the file-tag extraction added in ce5b096.
 *
 * Run:  pnpm vitest run test/quoted-render.test.ts
 */
import { describe, it, expect, vi } from 'vitest';
import { renderQuotedMessage } from '../src/cli/quoted-render.js';
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
