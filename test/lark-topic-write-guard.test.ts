import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  config: { topicUnavailablePolicy: 'stop' as 'stop' | 'legacy', apiOnly: false },
  request: vi.fn(), create: vi.fn(), reply: vi.fn(), patch: vi.fn(), forward: vi.fn(),
  settings: vi.fn(), content: vi.fn(), element: vi.fn(), convert: vi.fn(), hook: vi.fn(),
  reaction: vi.fn(), removeReaction: vi.fn(), pin: vi.fn(), unpin: vi.fn(),
}));
vi.mock('../src/bot-registry.js', () => ({
  getBot: () => ({ config: mocks.config }), getAllBots: () => [], loadBotConfigs: () => [],
  formatLarkError: (value: unknown) => String(value),
  getBotClient: () => ({ request: mocks.request,
    im: { v1: { message: { create: mocks.create, reply: mocks.reply, patch: mocks.patch, forward: mocks.forward },
      messageReaction: { create: mocks.reaction, delete: mocks.removeReaction }, pin: { create: mocks.pin, delete: mocks.unpin } } },
    cardkit: { v1: { card: { settings: mocks.settings, idConvert: mocks.convert },
      cardElement: { content: mocks.content, patch: mocks.element } } },
  }),
}));
vi.mock('../src/services/hook-runner.js', () => ({ emitHookEvent: mocks.hook }));
import { sendMessage, replyMessage, updateMessage, forwardMessage, urgentMessage,
  updateCardStreamingSettings, updateCardStreamElementContent, patchCardStreamElement,
  resolveCardKitId, MessageWithdrawnError, addReaction, removeReaction, pinMessage, unpinMessage } from '../src/im/lark/client.js';
import { assertSendTopicsAvailable, TopicSendError, type TopicMessageLookup } from '../src/cli/topic-send-guard.js';
import { __testOnly_resetLarkGate } from '../src/im/lark/api-gate.js';

const operations = [
  ['reaction', () => addReaction('app', 'om_card', 'DONE'), () => mocks.reaction],
  ['reply', () => replyMessage('app', 'om_card', 'answer'), () => mocks.reply],
  ['whole card', () => updateMessage('app', 'om_card', '{}'), () => mocks.patch],
  ['forward', () => forwardMessage('app', 'om_card', 'oc_dest'), () => mocks.forward],
  ['CardKit conversion', () => resolveCardKitId('app', 'om_card'), () => mocks.convert],
  ['CardKit settings', () => updateCardStreamingSettings('app', 'card', { messageId: 'om_card', streamingMode: true, sequence: 1, uuid: 'one' }), () => mocks.settings],
  ['CardKit content', () => updateCardStreamElementContent('app', 'card', 'body', 'text', 1, 'one', 'om_card'), () => mocks.content],
  ['CardKit element', () => patchCardStreamElement('app', 'card', 'body', { content: 'text' }, 1, 'one', 'om_card'), () => mocks.element],
] as const;

let rootDeleted = false;
beforeEach(() => {
  __testOnly_resetLarkGate(); vi.clearAllMocks(); rootDeleted = false;
  mocks.config.topicUnavailablePolicy = 'stop';
  vi.stubEnv('BOTMUX_LARK_QPS', '100000'); vi.stubEnv('BOTMUX_LARK_GATE_RETRY_BASE_MS', '1');
  mocks.request.mockReset().mockImplementation(async ({ method, url }) => {
    if (method !== 'GET') return { code: 0 };
    const id = url.split('/').at(-1);
    return { code: 0, data: { items: [{ message_id: id, deleted: id === 'om_root' && rootDeleted,
      ...(id === 'om_card' ? { root_id: 'om_root' } : {}) }] } };
  });
  for (const mock of [mocks.create, mocks.reply, mocks.patch, mocks.forward, mocks.settings, mocks.content, mocks.element]) {
    mock.mockReset().mockResolvedValue({ code: 0, data: { message_id: 'om_sent' } });
  }
  mocks.convert.mockReset().mockResolvedValue({ code: 0, data: { card_id: 'card' } });
  mocks.reaction.mockReset().mockResolvedValue({ code: 0, data: { reaction_id: 'reaction' } });
  mocks.pin.mockReset().mockResolvedValue({ code: 0, data: { pin: { message_id: 'om_card' } } });
  mocks.removeReaction.mockReset().mockResolvedValue({ code: 0 });
  mocks.unpin.mockReset().mockResolvedValue({ code: 0 });
});
afterEach(() => { vi.unstubAllEnvs(); __testOnly_resetLarkGate(); });

describe('stop policy at the actual Lark write boundary', () => {
  it.each(['reply', 'patch'] as const)('%s shares a lookup only within the current provider attempt', async operation => {
    const beforeWrite = vi.fn(async (lookup?: TopicMessageLookup) => {
      expect(lookup).toBeTypeOf('function');
      await assertSendTopicsAvailable('app', ['om_root'], lookup!, 'stop');
    });
    const run = () => operation === 'reply'
      ? replyMessage('app', 'om_root', 'answer', 'text', true, 'stable', undefined, { beforeWrite })
      : updateMessage('app', 'om_root', '{}', { beforeWrite });
    await run();
    expect(mocks.request).toHaveBeenCalledOnce();
    expect(beforeWrite).toHaveBeenCalledOnce();
    rootDeleted = true;
    await expect(run()).rejects.toMatchObject({ code: 'TOPIC_SEND_BLOCKED' });
    expect(mocks.request).toHaveBeenCalledTimes(2);
    expect(operation === 'reply' ? mocks.reply : mocks.patch).toHaveBeenCalledOnce();
  });
  it.each(['send', 'reply', 'patch'] as const)('%s refreshes its shared source lookup after rate limiting', async operation => {
    const beforeWrite = async (lookup?: TopicMessageLookup) => {
      await assertSendTopicsAvailable('app', ['om_root'], lookup!, 'stop');
    };
    const provider = operation === 'send' ? mocks.create : operation === 'reply' ? mocks.reply : mocks.patch;
    provider.mockImplementationOnce(async () => {
      rootDeleted = true;
      throw { isAxiosError: true, response: { status: 429 } };
    });
    const run = operation === 'send'
      ? sendMessage('app', 'oc_other', 'answer', 'text', 'stable', undefined, { beforeWrite })
      : operation === 'reply'
        ? replyMessage('app', 'om_root', 'answer', 'text', true, 'stable', undefined, { beforeWrite })
        : updateMessage('app', 'om_root', '{}', { beforeWrite });
    await expect(run).rejects.toMatchObject({ code: 'TOPIC_SEND_BLOCKED' });
    expect(mocks.request).toHaveBeenCalledTimes(2);
    expect(provider).toHaveBeenCalledOnce();
    expect(mocks.hook).not.toHaveBeenCalled();
  });

  it.each(['send', 'reply'] as const)('%s rechecks the source after a rate-limit retry without firing the hook', async operation => {
    const beforeWrite = vi.fn(() => assertSendTopicsAvailable('app', ['om_root'],
      async () => ({ items: [{ message_id: 'om_root', deleted: rootDeleted }] }), 'stop'));
    const provider = operation === 'send' ? mocks.create : mocks.reply;
    provider.mockImplementationOnce(async () => {
      rootDeleted = true;
      throw { isAxiosError: true, response: { status: 429 } };
    });
    const attempt = operation === 'send'
      ? sendMessage('app', 'oc_other', 'answer', 'text', 'stable', undefined, { beforeWrite })
      : replyMessage('app', 'om_other', 'answer', 'text', true, 'stable', undefined, { beforeWrite });
    await expect(attempt).rejects.toMatchObject({ code: 'TOPIC_SEND_BLOCKED' });
    expect(provider).toHaveBeenCalledOnce();
    expect(provider.mock.calls[0][0].data.uuid).toBe('stable');
    expect(beforeWrite).toHaveBeenCalledTimes(2);
    expect(mocks.hook).not.toHaveBeenCalled();
  });
  it('checks authority after the awaited destination lookup before writing a reply', async () => {
    let authorized = true;
    mocks.request.mockImplementationOnce(async ({ url }) => {
      authorized = false;
      return { code: 0, data: { items: [{ message_id: url.split('/').at(-1), deleted: false }] } };
    });
    const beforeWrite = () => { if (!authorized) throw new Error('origin revoked'); };
    await expect(replyMessage('app', 'om_other', 'answer', 'text', true, 'stable', undefined, { beforeWrite }))
      .rejects.toThrow('origin revoked');
    expect(mocks.reply).not.toHaveBeenCalled(); expect(mocks.hook).not.toHaveBeenCalled();
  });
  it('keeps the original UUID and emits a single hook when a permitted retry succeeds', async () => {
    const beforeWrite = vi.fn(async () => {});
    mocks.create.mockRejectedValueOnce({ isAxiosError: true, response: { status: 429 } });
    await expect(sendMessage('app', 'oc_other', 'answer', 'text', 'stable', undefined, { beforeWrite }))
      .resolves.toBe('om_sent');
    expect(beforeWrite).toHaveBeenCalledTimes(2);
    expect(mocks.create.mock.calls.map(([request]) => request.data.uuid)).toEqual(['stable', 'stable']);
    expect(mocks.hook).toHaveBeenCalledOnce();
  });
  it.each(operations)('%s checks the surviving card and its withdrawn root', async (_name, run, write) => {
    rootDeleted = true;
    await expect(run()).rejects.toMatchObject({ code: 'TOPIC_SEND_BLOCKED' });
    expect(write()).not.toHaveBeenCalled(); expect(mocks.hook).not.toHaveBeenCalled();
    expect(mocks.request.mock.calls.map(([value]) => value.url.split('/').at(-1))).toEqual(['om_card', 'om_root']);
  });
  it.each(operations)('%s leaves legacy behavior and API reads unchanged', async (_name, run, write) => {
    mocks.config.topicUnavailablePolicy = 'legacy';
    await run(); expect(write()).toHaveBeenCalledOnce(); expect(mocks.request).not.toHaveBeenCalled();
  });
  it('treats unknown, malformed and failed observations as paused, without writes', async () => {
    for (const value of [ { items: [] }, { items: [{ message_id: 'other', deleted: false }] },
      { items: [{ message_id: 'om_card' }] }, { items: [{ message_id: 'om_card', deleted: false, root_id: 42 }] },
      { items: [{ message_id: 'om_card', deleted: false }, { message_id: 'om_card', deleted: false }] } ]) {
      mocks.request.mockResolvedValue({ code: 0, data: value });
      await expect(updateMessage('app', 'om_card', '{}')).rejects.toMatchObject({ code: 'TOPIC_SEND_CHECK_FAILED' });
    }
    mocks.request.mockRejectedValue({ isAxiosError: true, response: { status: 429 } });
    await expect(updateMessage('app', 'om_card', '{}')).rejects.toMatchObject({ code: 'TOPIC_SEND_CHECK_FAILED' });
    expect(mocks.patch).not.toHaveBeenCalled();
  });
  it('requires a persisted message for every CardKit write under stop', async () => {
    for (const run of [
      () => updateCardStreamingSettings('app', 'card', { streamingMode: false, sequence: 3, uuid: 'u' }),
      () => updateCardStreamElementContent('app', 'card', 'body', 'text', 3, 'u'),
      () => patchCardStreamElement('app', 'card', 'body', {}, 3, 'u'),
    ]) await expect(run()).rejects.toMatchObject({ code: 'TOPIC_SEND_CHECK_FAILED' });
    expect(mocks.settings).not.toHaveBeenCalled(); expect(mocks.content).not.toHaveBeenCalled();
    expect(mocks.element).not.toHaveBeenCalled(); expect(mocks.request).not.toHaveBeenCalled();
  });
  it('checks again after a retryable provider error instead of reusing available evidence', async () => {
    mocks.content.mockImplementationOnce(async () => {
      rootDeleted = true; throw { isAxiosError: true, response: { status: 429 } };
    });
    await expect(updateCardStreamElementContent('app', 'card', 'body', 'text', 7, 'original', 'om_card'))
      .rejects.toMatchObject({ code: 'TOPIC_SEND_BLOCKED' });
    expect(mocks.content).toHaveBeenCalledOnce();
    expect(mocks.request).toHaveBeenCalledTimes(4);
    expect(mocks.content.mock.calls[0][0].data).toMatchObject({ sequence: 7, uuid: 'original' });
  });
  it('does not turn a withdrawn race into the legacy fallback or session-close signal', async () => {
    mocks.reply.mockResolvedValue({ code: 230011, msg: 'withdrawn' });
    const error = await replyMessage('app', 'om_card', 'answer').catch(value => value);
    expect(error).toBeInstanceOf(TopicSendError); expect(error).not.toBeInstanceOf(MessageWithdrawnError);
    expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.hook).not.toHaveBeenCalled();
  });
  it('does not pin a surviving card beneath an unavailable root', async () => {
    rootDeleted = true;
    await expect(pinMessage('app', 'om_card')).resolves.toBeNull();
    expect(mocks.pin).not.toHaveBeenCalled();
    mocks.request.mockResolvedValue({ code: 0, data: { items: [] } });
    await expect(pinMessage('app', 'om_card')).resolves.toBeNull();
    expect(mocks.pin).not.toHaveBeenCalled();
  });
  it('keeps a confirmed pin on an available topic and preserves legacy reads', async () => {
    await expect(pinMessage('app', 'om_card')).resolves.toMatchObject({ messageId: 'om_card' });
    expect(mocks.pin).toHaveBeenCalledOnce();
    mocks.request.mockClear(); mocks.pin.mockClear(); rootDeleted = true;
    mocks.config.topicUnavailablePolicy = 'legacy';
    await expect(pinMessage('app', 'om_card')).resolves.toMatchObject({ messageId: 'om_card' });
    expect(mocks.pin).toHaveBeenCalledOnce(); expect(mocks.request).not.toHaveBeenCalled();
  });
  it('keeps cleanup of existing pins and reactions available after root withdrawal', async () => {
    rootDeleted = true;
    await expect(unpinMessage('app', 'om_card')).resolves.toBe(true);
    await expect(removeReaction('app', 'om_card', 'reaction')).resolves.toBeUndefined();
    expect(mocks.unpin).toHaveBeenCalledOnce(); expect(mocks.removeReaction).toHaveBeenCalledOnce();
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it('rechecks a reaction after rate limiting before adding another provider effect', async () => {
    mocks.reaction.mockImplementationOnce(async () => {
      rootDeleted = true; throw { isAxiosError: true, response: { status: 429 } };
    });
    await expect(addReaction('app', 'om_card', 'DONE')).rejects.toMatchObject({ code: 'TOPIC_SEND_BLOCKED' });
    expect(mocks.reaction).toHaveBeenCalledOnce(); expect(mocks.request).toHaveBeenCalledTimes(4);
  });
  it('blocks a Buzz after the original topic becomes unavailable', async () => {
    rootDeleted = true;
    await expect(urgentMessage('app', 'om_card', ['ou_user'])).rejects.toMatchObject({ code: 'TOPIC_SEND_BLOCKED' });
    expect(mocks.request.mock.calls.every(([input]) => input.method === 'GET')).toBe(true);
  });
});
