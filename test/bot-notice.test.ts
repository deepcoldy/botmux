import { describe, expect, it, vi } from 'vitest';
import { classifyNoticeCard, isNonExecutingBotNotice } from '../src/im/lark/bot-notice.js';

const card = (elements: unknown[]) => JSON.stringify({schema: '2.0', body: {elements}});
const marker = {tag:'hr', element_id:'botmux_notice_v1'};
const data = (content: string, sender = 'app') => ({
  sender: {sender_type: sender},
  message: {message_id:'om_notice', chat_id:'oc_test', message_type:'interactive', content},
});
const detail = (content: string, extra: object = {}) => ({items:[{
  message_id:'om_notice', chat_id:'oc_test', sender:{sender_type:'app'}, body:{content}, ...extra,
}]});

describe('non-executing bot notification contract', () => {
  it('recognizes only a top-level structural marker', () => {
    expect(classifyNoticeCard(card([marker]))).toBe('notice');
    expect(classifyNoticeCard(card([{tag:'markdown', content:'botmux_notice_v1'}]))).toBe('ordinary');
    expect(classifyNoticeCard(card([{tag:'collapsible_panel', elements:[marker]}]))).toBe('ordinary');
    expect(classifyNoticeCard(card([{...marker, tag:'markdown'}]))).toBe('ordinary');
  });
  it('does not suppress human messages or forwards even with a copied marker', async () => {
    const read = vi.fn();
    expect(await isNonExecutingBotNotice(data(card([marker]), 'user'), read)).toBe(false);
    expect(read).not.toHaveBeenCalled();
  });
  it.each(['app', 'bot'])('handles real-time schema-2 cards from %s without a read', async sender => {
    const read = vi.fn();
    expect(await isNonExecutingBotNotice(data(card([marker]), sender), read)).toBe(true);
    expect(read).not.toHaveBeenCalled();
  });
  it('resolves history/WS placeholders through the original message before routing', async () => {
    const read = vi.fn(async () => detail(card([marker])));
    expect(await isNonExecutingBotNotice(data('{"text":"请升级客户端"}'), read)).toBe(true);
    expect(read).toHaveBeenCalledWith('om_notice');
  });
  it('retains normal bot card instructions including a legacy card', async () => {
    expect(await isNonExecutingBotNotice(data(card([{tag:'markdown',content:'请开始审查'}])), vi.fn())).toBe(false);
    expect(await isNonExecutingBotNotice(data('{}'), async () => detail('{"elements":[{"tag":"div","text":{"content":"开始"}}]}'))).toBe(false);
  });
  it.each([{message_id:'om_other'}, {chat_id:'oc_other'}, {deleted:true}, {sender:{sender_type:'user'}}])(
    'refuses mismatched or withdrawn readbacks %j', async extra => {
      await expect(isNonExecutingBotNotice(data('{}'), async () => detail(card([marker]), extra))).rejects.toThrow('readback_unproven');
    });
  it('does not silently turn a read failure or incomplete card into a new task', async () => {
    await expect(isNonExecutingBotNotice(data('{}'), async () => {throw Error('offline');})).rejects.toThrow('offline');
    await expect(isNonExecutingBotNotice(data('{}'), async () => detail('{}'))).rejects.toThrow('card_content_unavailable');
  });
});
