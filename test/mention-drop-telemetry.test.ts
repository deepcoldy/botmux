/**
 * mention-drop-telemetry：哪些群消息算「在找本 bot」、丢弃时的 WARN 长什么样。
 * 接入各丢弃出口的行为在 test/event-dispatcher.test.ts 的 mention-drop 套件里。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), isDebug: vi.fn(() => false), warn: vi.fn(), error: vi.fn() },
}));

import { logger } from '../src/utils/logger.js';
import {
  classifyMentionEvidence,
  reportMentionDrop,
  _resetMentionDropCountsForTest,
} from '../src/im/lark/mention-drop-telemetry.js';

const APP = 'cli_app_self';
const BOT = 'ou_bot_self';

function text(body: string, mentions?: unknown[], extra: Record<string, unknown> = {}) {
  return { message_id: 'om_msg_000000000001', chat_id: 'oc_chat_00000000001', chat_type: 'group', content: JSON.stringify({ text: body }), mentions, ...extra };
}

function post(nodes: unknown[], mentions?: unknown[]) {
  return { message_id: 'om_msg_post', chat_id: 'oc_chat_post', chat_type: 'group', content: JSON.stringify({ zh_cn: { title: '', content: [nodes] } }), mentions };
}

const warnLines = () => vi.mocked(logger.warn).mock.calls.map(call => String(call[0]));

describe('classifyMentionEvidence', () => {
  it('recognises a resolved @ of this bot in WS and REST shapes, and by app_id', () => {
    expect(classifyMentionEvidence(text('@_user_1 hi', [{ key: '@_user_1', name: 'Bot', id: { open_id: BOT } }]), APP, BOT)).toBe('explicit');
    expect(classifyMentionEvidence(text('@_user_1 hi', [{ key: '@_user_1', name: 'Bot', id: BOT, id_type: 'open_id' }]), APP, BOT)).toBe('explicit');
    expect(classifyMentionEvidence(text('@_user_1 hi', [{ key: '@_user_1', name: 'Bot', id: APP, id_type: 'app_id' }]), APP, undefined)).toBe('explicit');
    expect(classifyMentionEvidence(post([{ tag: 'at', user_id: BOT }, { tag: 'text', text: ' hi' }]), APP, BOT)).toBe('explicit');
  });

  it('flags a placeholder whose mention has not been resolved to an identity yet', () => {
    // WS 快照先于 mention 落定：占位符在正文里，mentions 为空 / 缺失 / 条目没有 id。
    expect(classifyMentionEvidence(text('@_user_1 hi', []), APP, BOT)).toBe('unresolved');
    expect(classifyMentionEvidence(text('@_user_1 hi'), APP, BOT)).toBe('unresolved');
    expect(classifyMentionEvidence(text('@_user_1 hi', [{ key: '@_user_1', name: 'Bot', id: {} }]), APP, BOT)).toBe('unresolved');
    // 一个已解析成别人、另一个没解析：未解析的那个可能就是本 bot。
    expect(classifyMentionEvidence(
      text('@_user_1 @_user_2 hi', [{ key: '@_user_2', name: 'Zhang', id: { open_id: 'ou_zhang' } }]), APP, BOT,
    )).toBe('unresolved');
    // key 前缀不能串：@_user_1 已解析不代表 @_user_10 已解析。
    expect(classifyMentionEvidence(
      text('@_user_10 hi', [{ key: '@_user_1', name: 'Zhang', id: { open_id: 'ou_zhang' } }]), APP, BOT,
    )).toBe('unresolved');
    expect(classifyMentionEvidence(post([{ tag: 'at', user_id: '@_user_1' }, { tag: 'text', text: ' hi' }], []), APP, BOT)).toBe('unresolved');
  });

  it('ignores ordinary chatter and @s already resolved to other members', () => {
    expect(classifyMentionEvidence(text('下午开会'), APP, BOT)).toBeUndefined();
    expect(classifyMentionEvidence(text('@_user_1 你看下', [{ key: '@_user_1', name: 'Zhang', id: { open_id: 'ou_zhang' } }]), APP, BOT)).toBeUndefined();
    expect(classifyMentionEvidence(text('@_all 开会了', [{ key: '@_all', name: '所有人', id: {} }]), APP, BOT)).toBeUndefined();
    expect(classifyMentionEvidence(post([{ tag: 'at', user_id: 'ou_zhang' }, { tag: 'text', text: ' hi' }]), APP, BOT)).toBeUndefined();
    expect(classifyMentionEvidence({ message_type: 'image', content: '{"image_key":"img_x"}' }, APP, BOT)).toBeUndefined();
  });

  it('treats every @ as possibly ours while this bot\'s open_id is unknown', () => {
    expect(classifyMentionEvidence(text('@_user_1 hi', [{ key: '@_user_1', name: 'Zhang', id: { open_id: 'ou_zhang' } }]), APP, undefined)).toBe('open_id_unknown');
    expect(classifyMentionEvidence(post([{ tag: 'at', user_id: 'ou_zhang' }]), APP, undefined)).toBe('open_id_unknown');
    expect(classifyMentionEvidence(text('下午开会'), APP, undefined)).toBeUndefined();
  });
});

describe('reportMentionDrop', () => {
  beforeEach(() => {
    vi.mocked(logger.warn).mockClear();
    _resetMentionDropCountsForTest();
  });

  it('warns with the reason, ID prefixes and a per-reason count, never the message body', () => {
    const secret = '线上密码是 hunter2';
    const message = text(`@_user_1 ${secret}`, []);
    reportMentionDrop({ larkAppId: APP, botOpenId: BOT, message, reason: 'command_gate', senderOpenId: 'ou_sender_0000001' });
    reportMentionDrop({ larkAppId: APP, botOpenId: BOT, message, reason: 'command_gate', senderOpenId: 'ou_sender_0000001' });
    reportMentionDrop({ larkAppId: APP, botOpenId: BOT, message, reason: 'grant_no_admin', senderOpenId: 'ou_sender_0000001' });
    const lines = warnLines();
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain(`[mention-drop:${APP}]`);
    expect(lines[0]).toContain('reason=command_gate');
    expect(lines[0]).toContain('mention=unresolved');
    expect(lines[0]).toContain('chat=oc_chat_0000');
    expect(lines[0]).toContain('msg=om_msg_00000');
    expect(lines[0]).toContain('sender=ou_sender_00');
    expect(lines[0]).toContain('count=1');
    expect(lines[1]).toContain('count=2');
    expect(lines[2]).toContain('reason=grant_no_admin');
    expect(lines[2]).toContain('count=1');
    for (const line of lines) {
      expect(line).not.toContain('hunter2');
      expect(line).not.toContain('om_msg_000000000001');
    }
  });

  it('stays silent for messages that do not look addressed to this bot, and for p2p', () => {
    reportMentionDrop({ larkAppId: APP, botOpenId: BOT, message: text('下午开会'), reason: 'command_gate' });
    reportMentionDrop({
      larkAppId: APP, botOpenId: BOT, reason: 'grant_cards_off',
      message: text('@_user_1 hi', [{ key: '@_user_1', name: 'Bot', id: { open_id: BOT } }], { chat_type: 'p2p' }),
    });
    expect(warnLines()).toEqual([]);
  });

  it('reports an unknown open_id once at the entry and not again at downstream exits', () => {
    const message = text('@_user_1 hi', [{ key: '@_user_1', name: 'Zhang', id: { open_id: 'ou_zhang' } }]);
    reportMentionDrop({ larkAppId: APP, botOpenId: undefined, message, reason: 'open_id_unknown' });
    reportMentionDrop({ larkAppId: APP, botOpenId: undefined, message, reason: 'command_gate' });
    reportMentionDrop({ larkAppId: APP, botOpenId: BOT, message, reason: 'open_id_unknown' });
    const lines = warnLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('reason=open_id_unknown');
    expect(lines[0]).toContain('mention=open_id_unknown');
  });

  it('never throws into the message path on malformed input', () => {
    expect(() => reportMentionDrop({
      larkAppId: APP, botOpenId: BOT, reason: 'command_gate',
      message: { chat_type: 'group', content: '{not json', mentions: 'garbage' },
    })).not.toThrow();
    expect(() => reportMentionDrop({ larkAppId: APP, botOpenId: BOT, reason: 'command_gate', message: undefined })).not.toThrow();
  });
});
