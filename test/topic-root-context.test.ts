/**
 * Unit tests for buildTopicThreadContext — the first-turn helper that injects a
 * lightweight *hint* (not the full transcript) for a 普通群 topic the bot
 * otherwise wouldn't know exists. The hint points the CLI at `botmux history`
 * for on-demand retrieval, mirroring the quote-hint pattern.
 *
 * Covers: count derivation (current @-reply excluded), the hint wording (points
 * at `botmux history`, carries the count, contains NO transcript/sender/body),
 * the no-eager-fetch guarantee (no attachment download / merge_forward /
 * card re-resolve), and the degradation paths (probe throws → countless hint
 * still emitted; empty thread → count 0 → countless hint; empty rootId → '').
 *
 * Run:  pnpm vitest run test/topic-root-context.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Only the metadata list is needed now. The old transcript path pulled in
// getMessageDetail / expandMergeForward / resolveMergedCardContent /
// downloadResources — we mock them too, purely to ASSERT they are never called
// (the hint approach must not eagerly fetch or download anything).
vi.mock('../src/im/lark/client.js', () => ({
  getMessageDetail: vi.fn(),
  listThreadMessages: vi.fn(),
}));
vi.mock('../src/im/lark/merge-forward.js', () => ({
  expandMergeForward: vi.fn(),
}));
vi.mock('../src/core/session-manager.js', () => ({
  downloadResources: vi.fn(),
  formatAttachmentsHint: vi.fn(() => ''),
}));

import { buildTopicThreadContext } from '../src/im/lark/topic-root-context.js';
import { getMessageDetail, listThreadMessages } from '../src/im/lark/client.js';
import { expandMergeForward } from '../src/im/lark/merge-forward.js';
import { downloadResources } from '../src/core/session-manager.js';

function msg(messageId: string, msgType = 'text', body: unknown = { text: 'hi' }, senderName = '张三') {
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

describe('buildTopicThreadContext (hint mode)', () => {
  it('emits a hint carrying the prior-message count, excluding the current @-reply', async () => {
    // Thread (asc): root, one prior reply, then the current @-reply → 2 prior.
    listThreadMessagesMock.mockResolvedValue([
      msg('om_root', 'text', { text: '请帮我分析这段代码' }, '张三'),
      msg('om_reply', 'text', { text: '对，特别是第二段' }, '李四'),
      msg(CURRENT_ID, 'text', { text: '@bot 继续' }, '王五'),
    ]);

    const out = await buildTopicThreadContext('app_x', 'oc_chat', 'om_root', CURRENT_ID);
    expect(out).toContain('话题');
    expect(out).toContain('2 条');
    expect(out).toContain('botmux history');
  });

  it('is a HINT, not a transcript: no message bodies/senders are inlined', async () => {
    listThreadMessagesMock.mockResolvedValue([
      msg('om_root', 'text', { text: '机密的话题正文内容' }, '张三'),
      msg('om_reply', 'text', { text: '另一条前情回复' }, '李四'),
      msg(CURRENT_ID, 'text', { text: '@bot' }, '王五'),
    ]);

    const out = await buildTopicThreadContext('app_x', 'oc_chat', 'om_root', CURRENT_ID);
    // The transcript content must NOT be replayed into the prompt.
    expect(out).not.toContain('机密的话题正文内容');
    expect(out).not.toContain('另一条前情回复');
    expect(out).not.toContain('张三:');
    expect(out).not.toContain('李四:');
  });

  it('never eagerly fetches: no attachment download / merge_forward / card re-resolve / root detail', async () => {
    listThreadMessagesMock.mockResolvedValue([
      msg('om_root', 'merge_forward', {}, '张三'),
      msg('om_img', 'image', { image_key: 'img_x' }, '李四'),
      msg('om_card', 'interactive', { user_dsl: '{}' }, '王五'),
      msg(CURRENT_ID, 'text', { text: '@bot' }, '赵六'),
    ]);

    const out = await buildTopicThreadContext('app_x', 'oc_chat', 'om_root', CURRENT_ID);
    expect(out).toContain('3 条');
    // The whole point of the hint approach: no eager fetch/download work.
    expect(downloadResourcesMock).not.toHaveBeenCalled();
    expect(expandMergeForwardMock).not.toHaveBeenCalled();
    expect(getMessageDetailMock).not.toHaveBeenCalled();
  });

  it('runs a single metadata probe with the right args (no per-message fan-out)', async () => {
    listThreadMessagesMock.mockResolvedValue([
      msg('om_root'), msg('om_r1'), msg('om_r2'), msg(CURRENT_ID),
    ]);
    const out = await buildTopicThreadContext('app_x', 'oc_chat', 'om_root', CURRENT_ID);
    expect(listThreadMessagesMock).toHaveBeenCalledTimes(1);
    expect(listThreadMessagesMock).toHaveBeenCalledWith('app_x', 'oc_chat', 'om_root');
    expect(out).toContain('3 条');
  });

  it('falls back to the countless hint when the list has only the current @-reply', async () => {
    listThreadMessagesMock.mockResolvedValue([msg(CURRENT_ID, 'text', { text: '@bot' }, '王五')]);
    const out = await buildTopicThreadContext('app_x', 'oc_chat', 'om_root', CURRENT_ID);
    // count === 0 → countless variant, but the signal + tool pointer remain.
    expect(out).toContain('botmux history');
    expect(out).not.toContain('0 条');
  });

  it('still emits the countless hint when listThreadMessages throws (signal never dropped)', async () => {
    listThreadMessagesMock.mockRejectedValue(new Error('Lark 230002: not in chat'));
    const out = await buildTopicThreadContext('app_x', 'oc_chat', 'om_root', CURRENT_ID);
    expect(out).toContain('话题');
    expect(out).toContain('botmux history');
    expect(getMessageDetailMock).not.toHaveBeenCalled();
  });

  it('returns "" for an empty rootId (gate off — nothing to hint about)', async () => {
    const out = await buildTopicThreadContext('app_x', 'oc_chat', '', CURRENT_ID);
    expect(out).toBe('');
    expect(listThreadMessagesMock).not.toHaveBeenCalled();
  });
});
