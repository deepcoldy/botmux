/**
 * Unit tests for merge_forward expansion (src/im/lark/merge-forward.ts).
 *
 * Run:  pnpm vitest run test/merge-forward.test.ts
 *
 * Mocks `getMessageDetail` to feed a synthetic Lark tree (the API returns ALL
 * descendants in a flat `items` array, each with `upper_message_id` pointing
 * at its parent). The expander walks that flat list into a nested tree, so
 * these tests verify both the indexing logic and the integration with
 * renderForwardedXml.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const getMessageDetailMock = vi.fn();

vi.mock('../src/im/lark/client.js', () => ({
  getMessageDetail: (...args: any[]) => getMessageDetailMock(...args),
}));

import { expandMergeForward } from '../src/im/lark/merge-forward.js';
import type { LarkMessage } from '../src/types.js';

function fakeParsed(messageId = 'om_root'): LarkMessage {
  return {
    messageId,
    rootId: '',
    senderId: 'ou_outer',
    senderType: 'user',
    msgType: 'merge_forward',
    content: '[合并转发消息]',
    createTime: '0',
  };
}

describe('expandMergeForward: flat tree', () => {
  beforeEach(() => getMessageDetailMock.mockReset());

  it('renders two leaves with deduped participants', async () => {
    getMessageDetailMock.mockResolvedValueOnce({
      items: [
        { message_id: 'om_a', upper_message_id: 'om_root', msg_type: 'text',
          sender: { id: 'ou_alice', sender_type: 'user' },
          body: { content: JSON.stringify({ text: 'hi' }) } },
        { message_id: 'om_b', upper_message_id: 'om_root', msg_type: 'text',
          sender: { id: 'ou_alice', sender_type: 'user' },
          body: { content: JSON.stringify({ text: 'again' }) } },
      ],
    });

    const parsed = fakeParsed();
    const { extraResources } = await expandMergeForward('app_test', 'om_root', parsed);

    expect(parsed.msgType).toBe('merge_forward_expanded');
    expect(parsed.content).toContain('<forwarded_messages>');
    expect(parsed.content).toContain('<p id="A" open_id="ou_alice" type="user" />');
    expect(parsed.content).toContain('<msg from="A">hi</msg>');
    expect(parsed.content).toContain('<msg from="A">again</msg>');
    expect(extraResources).toEqual([]);
  });
});

describe('expandMergeForward: nested merge_forward', () => {
  beforeEach(() => getMessageDetailMock.mockReset());

  it('walks the upper_message_id chain into nested <msg type="merged_forward">', async () => {
    getMessageDetailMock.mockResolvedValueOnce({
      items: [
        // Outer level: alice text + a nested merge_forward wrapper
        { message_id: 'om_a', upper_message_id: 'om_root', msg_type: 'text',
          sender: { id: 'ou_alice', sender_type: 'user' },
          body: { content: JSON.stringify({ text: 'outer text' }) } },
        { message_id: 'om_inner', upper_message_id: 'om_root', msg_type: 'merge_forward',
          sender: { id: 'ou_bob', sender_type: 'user' },
          body: { content: '{}' } },
        // Inner level: child of the nested wrapper
        { message_id: 'om_c', upper_message_id: 'om_inner', msg_type: 'text',
          sender: { id: 'ou_carol', sender_type: 'user' },
          body: { content: JSON.stringify({ text: 'inner text' }) } },
      ],
    });

    const parsed = fakeParsed();
    await expandMergeForward('app_test', 'om_root', parsed);

    expect(parsed.content).toContain('<msg from="A">outer text</msg>');
    expect(parsed.content).toContain('<msg from="B" type="merged_forward">');
    expect(parsed.content).toContain('<msg from="C">inner text</msg>');
    // Participants alphabetized in first-seen order — alice (A), bob (B), carol (C)
    expect(parsed.content).toMatch(/<p id="A" open_id="ou_alice"/);
    expect(parsed.content).toMatch(/<p id="B" open_id="ou_bob"/);
    expect(parsed.content).toMatch(/<p id="C" open_id="ou_carol"/);
  });
});

describe('expandMergeForward: resources', () => {
  beforeEach(() => getMessageDetailMock.mockReset());

  it('collects image/file resources from sub-messages', async () => {
    getMessageDetailMock.mockResolvedValueOnce({
      items: [
        { message_id: 'om_img', upper_message_id: 'om_root', msg_type: 'image',
          sender: { id: 'ou_alice', sender_type: 'user' },
          body: { content: JSON.stringify({ image_key: 'img_xyz' }) } },
        { message_id: 'om_file', upper_message_id: 'om_root', msg_type: 'file',
          sender: { id: 'ou_alice', sender_type: 'user' },
          body: { content: JSON.stringify({ file_key: 'file_abc', file_name: 'report.pdf' }) } },
      ],
    });

    const parsed = fakeParsed();
    const { extraResources } = await expandMergeForward('app_test', 'om_root', parsed);

    expect(extraResources).toEqual([
      { type: 'image', key: 'img_xyz', name: 'img_xyz.jpg' },
      { type: 'file', key: 'file_abc', name: 'report.pdf' },
    ]);
    // Image and file counters are independent (matches formatAttachmentsHint's
    // per-type numbering — `<image n="1">` + `<file n="1">`).
    expect(parsed.content).toContain('[图片 1]');
    expect(parsed.content).toContain('[文件 1: report.pdf]');
  });
});

describe('expandMergeForward: interactive cards via parent userCardContent', () => {
  beforeEach(() => getMessageDetailMock.mockReset());

  // Lark's merge_forward + userCardContent:true now returns real v2 card
  // bodies for interactive children (this used to 500 — see fd0f688 — but
  // is now fixed). We try true first; on failure fall back to false so we
  // still get the simplified shape rather than dropping the whole tree.
  // Per-sub refetch is NOT used: forwarded cards from a foreign tenant
  // return 232010 on the single-message endpoint even when the parent is
  // readable.
  it('passes userCardContent:true on the parent call and surfaces real card bodies', async () => {
    getMessageDetailMock.mockResolvedValueOnce({
      items: [
        { message_id: 'om_card', upper_message_id: 'om_root', msg_type: 'interactive',
          sender: { id: 'ou_alice', sender_type: 'user' },
          body: { content: JSON.stringify({
            // Real v2 body — what userCardContent:true now returns.
            schema: '2.0',
            body: { elements: [{ tag: 'div', text: { content: '真实卡片内容' } }] },
          }) } },
      ],
    });

    const parsed = fakeParsed();
    await expandMergeForward('app_test', 'om_root', parsed);

    expect(parsed.content).toContain('真实卡片内容');
    expect(parsed.content).not.toContain('请升级至最新版本客户端');

    expect(getMessageDetailMock).toHaveBeenCalledTimes(1);
    expect(getMessageDetailMock).toHaveBeenCalledWith('app_test', 'om_root', { userCardContent: true });
  });

  it('falls back to userCardContent:false when the true call throws (e.g. legacy 500)', async () => {
    getMessageDetailMock.mockRejectedValueOnce(new Error('Request failed with status code 500'));
    getMessageDetailMock.mockResolvedValueOnce({
      items: [
        { message_id: 'om_card', upper_message_id: 'om_root', msg_type: 'interactive',
          sender: { id: 'ou_alice', sender_type: 'user' },
          body: { content: JSON.stringify({
            // Simplified fallback — what we get on the false path.
            title: null,
            elements: [[{ tag: 'text', text: '请升级至最新版本客户端，以查看内容' }]],
          }) } },
      ],
    });

    const parsed = fakeParsed();
    await expandMergeForward('app_test', 'om_root', parsed);

    expect(parsed.msgType).toBe('merge_forward_expanded');
    expect(parsed.content).toContain('请升级至最新版本客户端');

    expect(getMessageDetailMock).toHaveBeenCalledTimes(2);
    expect(getMessageDetailMock).toHaveBeenNthCalledWith(1, 'app_test', 'om_root', { userCardContent: true });
    expect(getMessageDetailMock).toHaveBeenNthCalledWith(2, 'app_test', 'om_root', { userCardContent: false });
  });
});

describe('expandMergeForward: failure paths', () => {
  beforeEach(() => getMessageDetailMock.mockReset());

  it('leaves parsed.content untouched when API throws on both userCardContent values', async () => {
    // Both the true-first attempt and the false-fallback throw → expandMergeForward
    // catches and bails without touching parsed.
    getMessageDetailMock.mockRejectedValueOnce(new Error('lark 230002 not in chat'));
    getMessageDetailMock.mockRejectedValueOnce(new Error('lark 230002 not in chat'));

    const parsed = fakeParsed();
    const { extraResources } = await expandMergeForward('app_test', 'om_root', parsed);

    expect(parsed.msgType).toBe('merge_forward'); // unchanged
    expect(parsed.content).toBe('[合并转发消息]');  // unchanged
    expect(extraResources).toEqual([]);
  });

  it('leaves parsed.content untouched when items array is empty', async () => {
    getMessageDetailMock.mockResolvedValueOnce({ items: [] });

    const parsed = fakeParsed();
    await expandMergeForward('app_test', 'om_root', parsed);

    expect(parsed.msgType).toBe('merge_forward');
    expect(parsed.content).toBe('[合并转发消息]');
  });
});
