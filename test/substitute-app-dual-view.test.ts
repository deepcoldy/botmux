import { beforeEach, describe, expect, it, vi } from 'vitest';
const getMessageDetail = vi.hoisted(() => vi.fn());
vi.mock('../src/im/lark/client.js', () => ({ getMessageDetail }));
import { resolveSubstituteAppMentions } from '../src/im/lark/substitute-app-mentions.js';
import { extractMentionIdentities } from '../src/im/lark/message-parser.js';

const event = () => ({
  message_id: 'om_dual', chat_id: 'oc_dual', message_type: 'text',
  create_time: '1000', content: JSON.stringify({ text: '@_user_1 help' }),
  mentions: [{ key: '@_user_1', name: 'Target', id: { open_id: 'ou_original' } }],
});

function views(message = event()) {
  const common = { message_id: message.message_id, chat_id: message.chat_id,
    msg_type: message.message_type, create_time: '1000', update_time: '1001', body: { content: message.content } };
  return {
    app: { ...common, mentions: [{ key: '@_user_1', id: 'cli_original', id_type: 'app_id' }] },
    baseline: { ...common, mentions: [{ key: '@_user_1', id: 'ou_original', id_type: 'open_id' }] },
  };
}

function stubViews(pair: ReturnType<typeof views>) {
  getMessageDetail.mockImplementation(async (_app, _message, options) => ({
    items: [options.userIdType ? pair.app : pair.baseline],
  }));
}

beforeEach(() => { getMessageDetail.mockReset(); });

describe('App ID dual-view identity proof', () => {
  it('accepts an initial message whose REST update time exceeds create time and WS has no update time', async () => {
    const message = event();
    stubViews(views(message));
    expect(extractMentionIdentities(await resolveSubstituteAppMentions('cli_receiver', message))[0])
      .toMatchObject({ openId: 'ou_original', appId: 'cli_original' });
    expect(getMessageDetail).toHaveBeenCalledTimes(2);
    expect(getMessageDetail.mock.calls.map(call => call[2].userIdType)).toEqual(['open_id', undefined]);
  });

  it('rejects a same-body recipient replacement even when both REST views describe the newer version', async () => {
    const pair = views();
    pair.app.mentions[0].id = 'cli_replacement';
    pair.baseline.mentions[0].id = 'ou_replacement';
    pair.app.update_time = pair.baseline.update_time = '2000';
    stubViews(pair);
    const result = await resolveSubstituteAppMentions('cli_receiver', event());
    expect(extractMentionIdentities(result).some(mention => mention.appId)).toBe(false);
  });

  it('rejects a version mismatch when WS does carry its update time', async () => {
    stubViews(views());
    const result = await resolveSubstituteAppMentions('cli_receiver', { ...event(), update_time: '1000' });
    expect(extractMentionIdentities(result).some(mention => mention.appId)).toBe(false);
  });

  it.each(['app', 'baseline'] as const)('rejects an edit between REST reads when the %s view is newer', async newer => {
    const pair = views();
    pair[newer].update_time = '2000';
    if (newer === 'app') pair.app.mentions[0].id = 'cli_replacement';
    else pair.baseline.mentions[0].id = 'ou_replacement';
    stubViews(pair);
    const result = await resolveSubstituteAppMentions('cli_receiver', event());
    expect(extractMentionIdentities(result).some(mention => mention.appId)).toBe(false);
  });

  it.each(['app', 'baseline'] as const)('fails closed if the %s view fails', async failing => {
    const pair = views();
    getMessageDetail.mockImplementation(async (_app, _message, options) => {
      const view = options.userIdType ? 'app' : 'baseline';
      if (view === failing) throw new Error('unavailable');
      return { items: [pair[view]] };
    });
    expect(await resolveSubstituteAppMentions('cli_receiver', event())).toEqual(event());
  });

  it('associates rich-text event mentions through the same observer Open ID', async () => {
    const message = { ...event(), message_type: 'post', content: JSON.stringify({ zh_cn: { content: [[
      { tag: 'at', user_id: 'ou_original' }, { tag: 'text', text: 'help' },
    ]] } }) };
    stubViews(views(message));
    expect(extractMentionIdentities(await resolveSubstituteAppMentions('cli_receiver', message))
      .some(mention => mention.appId === 'cli_original')).toBe(true);
  });
});
