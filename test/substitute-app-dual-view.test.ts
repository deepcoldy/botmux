import { beforeEach, describe, expect, it, vi } from 'vitest';
const getMessageDetail = vi.hoisted(() => vi.fn());
vi.mock('../src/im/lark/client.js', () => ({ getMessageDetail }));
import { resolveSubstituteAppMentions, substituteMentionIdentities } from '../src/im/lark/substitute-app-mentions.js';

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
    expect(substituteMentionIdentities(await resolveSubstituteAppMentions('cli_receiver', message))[0])
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
    expect(substituteMentionIdentities(result).some(mention => mention.appId)).toBe(false);
  });

  it('rejects a version mismatch when WS does carry its update time', async () => {
    stubViews(views());
    const result = await resolveSubstituteAppMentions('cli_receiver', { ...event(), update_time: '1000' });
    expect(substituteMentionIdentities(result).some(mention => mention.appId)).toBe(false);
  });

  it.each(['app', 'baseline'] as const)('rejects an edit between REST reads when the %s view is newer', async newer => {
    const pair = views();
    pair[newer].update_time = '2000';
    if (newer === 'app') pair.app.mentions[0].id = 'cli_replacement';
    else pair.baseline.mentions[0].id = 'ou_replacement';
    stubViews(pair);
    const result = await resolveSubstituteAppMentions('cli_receiver', event());
    expect(substituteMentionIdentities(result).some(mention => mention.appId)).toBe(false);
  });

  it('rejects REST views that disagree on the body at the same version', async () => {
    const pair = views();
    pair.baseline.body = { content: JSON.stringify({ text: '@_user_1 something else' }) };
    stubViews(pair);
    const result = await resolveSubstituteAppMentions('cli_receiver', event());
    expect(substituteMentionIdentities(result).some(mention => mention.appId)).toBe(false);
  });

  it('does not find @_user_1 inside @_user_10', async () => {
    const message = { ...event(), content: JSON.stringify({ text: '@_user_10 help' }) };
    stubViews(views(message));
    const result = await resolveSubstituteAppMentions('cli_receiver', message);
    expect(substituteMentionIdentities(result).some(mention => mention.appId)).toBe(false);
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

  // REST keeps @_user_N in at-nodes; WS carries the observer open_id there and
  // may wrap the body in a locale, reorder keys or drop style arrays.
  const restPost = (keys: string[]) => JSON.stringify({ title: '', content: [[
    ...keys.map(key => ({ tag: 'at', user_id: key, user_name: 'Target', style: [] })),
    { tag: 'text', text: ' help', style: [] },
  ]] });
  const wsPost = (openIds: string[], shape: 'locale' | 'flat' | 'reordered' = 'locale') => {
    const nodes = [...openIds.map(id => ({ tag: 'at', user_id: id, user_name: 'Target' })), { tag: 'text', text: ' help' }];
    if (shape === 'flat') return JSON.stringify({ content: [nodes] });
    if (shape === 'reordered') return JSON.stringify({ content: [nodes.map(node => Object.fromEntries(Object.entries(node).reverse()))], title: '' });
    return JSON.stringify({ zh_cn: { title: '', content: [nodes] } });
  };
  function postPair(content: string, rest: Array<{ key: string; app: string; open: string }>) {
    const common = { message_id: 'om_dual', chat_id: 'oc_dual', msg_type: 'post', create_time: '1000', update_time: '1001', body: { content } };
    return {
      app: { ...common, mentions: rest.map(m => ({ key: m.key, id: m.app, id_type: m.app.startsWith('cli_') ? 'app_id' : 'open_id' })) },
      baseline: { ...common, mentions: rest.map(m => ({ key: m.key, id: m.open, id_type: 'open_id' })) },
    };
  }
  const postEvent = (content: string, mentions?: any[]) => ({ ...event(), message_type: 'post', content, mentions });
  const appIds = (message: any) => substituteMentionIdentities(message).map(mention => mention.appId).filter(Boolean);

  it.each(['locale', 'flat', 'reordered'] as const)('verifies a rich-text @ whose event mentions[] is filled (%s body)', async shape => {
    stubViews(postPair(restPost(['@_user_1']), [{ key: '@_user_1', app: 'cli_original', open: 'ou_original' }]));
    const message = postEvent(wsPost(['ou_original'], shape), event().mentions);
    expect(appIds(await resolveSubstituteAppMentions('cli_receiver', message))).toEqual(['cli_original', 'cli_original']);
  });

  it.each([[[]], [undefined]])('verifies a rich-text @ whose event mentions[] is %j', async mentions => {
    stubViews(postPair(restPost(['@_user_1']), [{ key: '@_user_1', app: 'cli_original', open: 'ou_original' }]));
    const message = postEvent(wsPost(['ou_original']), mentions);
    const result = await resolveSubstituteAppMentions('cli_receiver', message);
    expect(substituteMentionIdentities(result)).toEqual([expect.objectContaining({ openId: 'ou_original', appId: 'cli_original' })]);
    expect(message.mentions).toBe(mentions);
  });

  it('pairs a repeated rich-text @ with one REST mention each', async () => {
    const message = postEvent(wsPost(['ou_original', 'ou_original']));
    stubViews(postPair(restPost(['@_user_1', '@_user_2']), [
      { key: '@_user_1', app: 'cli_original', open: 'ou_original' },
      { key: '@_user_2', app: 'cli_original', open: 'ou_original' },
    ]));
    expect(appIds(await resolveSubstituteAppMentions('cli_receiver', message))).toEqual(['cli_original', 'cli_original']);
    stubViews(postPair(restPost(['@_user_1', '@_user_1']), [{ key: '@_user_1', app: 'cli_original', open: 'ou_original' }]));
    expect(await resolveSubstituteAppMentions('cli_receiver', message)).toBe(message);
  });

  it('fails closed when a second rich-text @ only matches an already used REST mention', async () => {
    stubViews(postPair(restPost(['@_user_1', '@_user_2']), [
      { key: '@_user_1', app: 'cli_original', open: 'ou_original' },
      { key: '@_user_2', app: 'cli_original', open: 'ou_original' },
    ]));
    const message = postEvent(wsPost(['ou_original', 'ou_other']));
    expect(await resolveSubstituteAppMentions('cli_receiver', message)).toBe(message);
  });

  it.each([
    ['event key missing', { eventKey: undefined }],
    ['event key empty', { eventKey: '' }],
    ['REST key empty', { restKey: '' }],
    ['REST keys disagree', { baselineKey: '@_user_2' }],
  ])('fails closed when %s', async (_name, keys: { eventKey?: string; restKey?: string; baselineKey?: string }) => {
    const message = { ...event(), mentions: [{ ...('eventKey' in keys ? { key: keys.eventKey } : { key: '@_user_1' }), name: 'Target', id: { open_id: 'ou_original' } }] };
    const pair = views(message);
    if ('restKey' in keys) pair.app.mentions[0].key = pair.baseline.mentions[0].key = keys.restKey!;
    if (keys.baselineKey) pair.baseline.mentions[0].key = keys.baselineKey;
    stubViews(pair);
    expect(await resolveSubstituteAppMentions('cli_receiver', message)).toBe(message);
  });

  it.each([undefined, ''])('fails closed when a rich-text event mention has key %j', async key => {
    stubViews(postPair(restPost(['@_user_1']), [{ key: '@_user_1', app: 'cli_original', open: 'ou_original' }]));
    const message = postEvent(wsPost(['ou_original']), [{ key, name: 'Target', id: { open_id: 'ou_original' } }]);
    expect(await resolveSubstituteAppMentions('cli_receiver', message)).toBe(message);
  });

  it('ignores a rich-text REST mention whose placeholder is not in the body', async () => {
    stubViews(postPair(restPost(['@_user_2']), [{ key: '@_user_1', app: 'cli_original', open: 'ou_original' }]));
    const message = postEvent(wsPost(['ou_original']));
    expect(await resolveSubstituteAppMentions('cli_receiver', message)).toBe(message);
  });

  it.each([
    ['recipient replaced', (pair: any) => { pair.baseline.mentions[0].id = 'ou_replacement'; pair.app.mentions[0].id = 'cli_replacement'; }],
    ['event version older', (_pair: any, message: any) => { message.update_time = '1000'; }],
    ['text edited', (pair: any) => { pair.app.body.content = pair.baseline.body.content = restPost(['@_user_1']).replace(' help', ' edited'); }],
  ])('keeps the version and identity gates for rich text: %s', async (_name, patch: (pair: any, message: any) => void) => {
    const pair = postPair(restPost(['@_user_1']), [{ key: '@_user_1', app: 'cli_original', open: 'ou_original' }]);
    const message: any = postEvent(wsPost(['ou_original']));
    patch(pair, message);
    stubViews(pair);
    expect(appIds(await resolveSubstituteAppMentions('cli_receiver', message))).toEqual([]);
  });
});
